/**
 * WMB-5290 项目专项调查领域（设计 docs/spark/2026-08-16-project-investigation-writing-workflow-design.md）。
 *
 * - 每个创作项目至多一个活动调查轮次（project_investigations.project_id 主键）。
 * - 提纲/方向按版本不可变（investigation_*_versions），审批快照只追加；资料包按轮不可变
 *   （investigation_packages，pack 为精确 ResearchEvidencePack + 项目 sourceIds + 主管验收）。
 * - 本模块是纯 DB 领域函数（database 直读直写，写守卫由调用方命令派发授权）；
 *   记者派单/写手派单的 spawn 由 IPC/事件层负责（本模块只记录 job 引用与状态转换）。
 * - 记者工单引用 projectId + 精确提纲版本（ResearchGap.parentRoleId='desk' + 合成稳定父身份
 *   investigation:<projectId>）；desk 父在 research-successor 硬跳过 → 绝无 reporter 自动续派链。
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { failure, success, type CommandResult } from './result.ts';
import { shanghaiDate } from './ferment.ts';
import { RESEARCH_DEFAULT_BUDGET } from './research-job-runner.ts';
import { parseResearchEvidencePack, type ResearchEvidencePack } from './research-task-state.ts';
import type { ResearchRequiredClaim, RoleJobRequest } from './role-job-registry.ts';
import {
  investigationGapId,
  investigationParentId,
  type InvestigationDirection,
  type InvestigationHistoryEvent,
  type InvestigationOutline,
  type InvestigationPackage,
  type InvestigationPackageReview,
  type InvestigationReporterJob,
  type InvestigationWriterJob,
  type ProjectInvestigation,
  type ProjectInvestigationStatus
} from '../shared/project-investigation.ts';
// WMB-5290：领域模块对外暴露规范类型（渲染层/内容投影/测试统一从本模块导入）。
export type {
  InvestigationDirection,
  InvestigationHistoryEvent,
  InvestigationOutline,
  InvestigationPackage,
  InvestigationPackageReview,
  InvestigationReporterJob,
  InvestigationWriterJob,
  ProjectInvestigation,
  ProjectInvestigationStatus
} from '../shared/project-investigation.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import { dispatchBusinessCommand } from './business-command.ts';
import { broadcastDataChanged } from './data-changed.ts';

// ---------------------------------------------------------------------------
// 值对象校验（fail-closed：非法形状一律拒绝写入，绝不静默降级）
// ---------------------------------------------------------------------------

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && Boolean(item.trim()));
}

function normalizeStringArray(value: unknown, label: string): readonly string[] {
  if (!isStringArray(value)) {
    throw Object.assign(new Error(`VALIDATION_ERROR: ${label} 必须是字符串数组。`), { code: 'VALIDATION_ERROR' });
  }
  return Object.freeze(value.map((item) => item.trim()));
}

export function validateInvestigationOutline(value: unknown): InvestigationOutline {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('VALIDATION_ERROR: 调查提纲必须是对象。'), { code: 'VALIDATION_ERROR' });
  }
  const record = value as Record<string, unknown>;
  const scope = typeof record.scope === 'string' && record.scope.trim() ? record.scope.trim() : null;
  if (!scope) throw Object.assign(new Error('VALIDATION_ERROR: 调查提纲缺少调查对象与边界（scope）。'), { code: 'VALIDATION_ERROR' });
  const questions = normalizeStringArray(record.questions, 'questions');
  // 设计 §5：核心调查问题按问题组织（非文章章节）；空问题无法派生 requiredClaims，fail-closed。
  if (questions.length === 0) {
    throw Object.assign(new Error('VALIDATION_ERROR: 调查提纲必须包含至少一个核心调查问题（questions）。'), { code: 'VALIDATION_ERROR' });
  }
  return Object.freeze({
    scope,
    exclusions: normalizeStringArray(record.exclusions, 'exclusions'),
    known: normalizeStringArray(record.known, 'known'),
    hypotheses: normalizeStringArray(record.hypotheses, 'hypotheses'),
    questions,
    dimensions: normalizeStringArray(record.dimensions, 'dimensions'),
    materialRequirements: normalizeStringArray(record.materialRequirements, 'materialRequirements'),
    truthRisks: normalizeStringArray(record.truthRisks, 'truthRisks'),
    disconfirmingConditions: normalizeStringArray(record.disconfirmingConditions, 'disconfirmingConditions'),
    completionCriteria: normalizeStringArray(record.completionCriteria, 'completionCriteria')
  });
}

export function validateInvestigationDirection(value: unknown): InvestigationDirection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('VALIDATION_ERROR: 写作方向必须是对象。'), { code: 'VALIDATION_ERROR' });
  }
  const record = value as Record<string, unknown>;
  const recommendation = record.recommendation;
  if (recommendation !== 'continue' && recommendation !== 'adjust' && recommendation !== 'redirect' && recommendation !== 'stop') {
    throw Object.assign(new Error('VALIDATION_ERROR: 写作方向 recommendation 只允许 continue/adjust/redirect/stop。'), { code: 'VALIDATION_ERROR' });
  }
  const coreQuestion = typeof record.coreQuestion === 'string' && record.coreQuestion.trim() ? record.coreQuestion.trim() : null;
  if (!coreQuestion) throw Object.assign(new Error('VALIDATION_ERROR: 写作方向缺少 coreQuestion。'), { code: 'VALIDATION_ERROR' });
  const audienceValue = typeof record.audienceValue === 'string' && record.audienceValue.trim() ? record.audienceValue.trim() : null;
  if (!audienceValue) throw Object.assign(new Error('VALIDATION_ERROR: 写作方向缺少 audienceValue。'), { code: 'VALIDATION_ERROR' });
  const scope = typeof record.scope === 'string' && record.scope.trim() ? record.scope.trim() : null;
  if (!scope) throw Object.assign(new Error('VALIDATION_ERROR: 写作方向缺少 scope。'), { code: 'VALIDATION_ERROR' });
  return Object.freeze({
    keyFacts: normalizeStringArray(record.keyFacts, 'keyFacts'),
    upheld: normalizeStringArray(record.upheld, 'upheld'),
    changed: normalizeStringArray(record.changed, 'changed'),
    discoveries: normalizeStringArray(record.discoveries, 'discoveries'),
    unknowns: normalizeStringArray(record.unknowns, 'unknowns'),
    recommendation,
    coreQuestion,
    audienceValue,
    scope,
    constraints: normalizeStringArray(record.constraints, 'constraints')
  });
}

// ---------------------------------------------------------------------------
// 读模型
// ---------------------------------------------------------------------------

type InvestigationRow = {
  project_id: string;
  status: ProjectInvestigationStatus;
  outline_version: number | null;
  direction_version: number | null;
  reporter_job_id: string | null;
  reporter_task_id: string | null;
  reporter_round: number;
  reporter_status: string | null;
  reporter_error_message: string | null;
  reporter_started_at: string | null;
  reporter_finished_at: string | null;
  writer_job_id: string | null;
  writer_status: string | null;
  writer_started_at: string | null;
  writer_finished_at: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

type OutlineVersionRow = {
  version: number;
  outline_json: string;
  status: 'draft' | 'approved' | 'rejected';
  decided_at: string | null;
};

type DirectionVersionRow = {
  version: number;
  direction_json: string;
  status: 'draft' | 'approved' | 'supplemented';
  decided_at: string | null;
};

type PackageRow = {
  round: number;
  reporter_job_id: string;
  outline_version: number;
  pack_json: string;
  source_ids_json: string;
  review_json: string | null;
  created_at: string;
  reviewed_at: string | null;
};

function selectInvestigationRow(database: DatabaseSync, projectId: string): InvestigationRow | undefined {
  return database.prepare(
    `SELECT project_id, status, outline_version, direction_version,
       reporter_job_id, reporter_task_id, reporter_round, reporter_status, reporter_error_message,
       reporter_started_at, reporter_finished_at,
       writer_job_id, writer_status, writer_started_at, writer_finished_at,
       revision, created_at, updated_at, finished_at
     FROM project_investigations WHERE project_id = ?`
  ).get(projectId) as InvestigationRow | undefined;
}

function selectLatestOutline(database: DatabaseSync, projectId: string): OutlineVersionRow | undefined {
  return database.prepare(
    `SELECT version, outline_json, status, decided_at FROM investigation_outline_versions
     WHERE project_id = ? ORDER BY version DESC LIMIT 1`
  ).get(projectId) as OutlineVersionRow | undefined;
}

function selectLatestApprovedOutline(database: DatabaseSync, projectId: string): OutlineVersionRow | undefined {
  return database.prepare(
    `SELECT version, outline_json, status, decided_at FROM investigation_outline_versions
     WHERE project_id = ? AND status = 'approved' ORDER BY version DESC LIMIT 1`
  ).get(projectId) as OutlineVersionRow | undefined;
}

function selectLatestDirection(database: DatabaseSync, projectId: string): DirectionVersionRow | undefined {
  return database.prepare(
    `SELECT version, direction_json, status, decided_at FROM investigation_direction_versions
     WHERE project_id = ? ORDER BY version DESC LIMIT 1`
  ).get(projectId) as DirectionVersionRow | undefined;
}

function selectLatestPackage(database: DatabaseSync, projectId: string): PackageRow | undefined {
  return database.prepare(
    `SELECT round, reporter_job_id, outline_version, pack_json, source_ids_json, review_json, created_at, reviewed_at
     FROM investigation_packages WHERE project_id = ? ORDER BY round DESC LIMIT 1`
  ).get(projectId) as PackageRow | undefined;
}

function parseOutline(row: OutlineVersionRow): InvestigationOutline {
  return JSON.parse(row.outline_json) as InvestigationOutline;
}

function parseDirection(row: DirectionVersionRow): InvestigationDirection {
  return JSON.parse(row.direction_json) as InvestigationDirection;
}

function parseReview(value: string | null): InvestigationPackageReview | null {
  if (!value) return null;
  const parsed = JSON.parse(value) as InvestigationPackageReview;
  return Object.freeze({
    decision: parsed.decision,
    summary: parsed.summary,
    decidedAt: parsed.decidedAt,
    decidedBy: parsed.decidedBy
  });
}

function packageFromRow(row: PackageRow): InvestigationPackage | null {
  let raw: unknown = null;
  try {
    raw = JSON.parse(row.pack_json);
  } catch {
    return null; // 损坏资料包 fail-closed：不展示伪造数据（正常路径只写入已校验 pack）。
  }
  const pack = parseResearchEvidencePack(raw);
  if (!pack) return null;
  const sourceIds = JSON.parse(row.source_ids_json) as string[];
  return Object.freeze({
    pack,
    sourceIds: Object.freeze([...sourceIds]),
    review: parseReview(row.review_json),
    createdAt: row.created_at
  });
}

/** 项目调查读模型（每项目至多一行；outline/package/direction 取最新版本投影）。 */
export function readProjectInvestigation(database: DatabaseSync, projectId: string): ProjectInvestigation | null {
  const row = selectInvestigationRow(database, projectId);
  if (!row) return null;
  const outlineRow = selectLatestOutline(database, projectId);
  const packageRow = selectLatestPackage(database, projectId);
  const directionRow = selectLatestDirection(database, projectId);  const historyRows = database.prepare(
    `SELECT kind, created_at AS at, note, version FROM investigation_events
     WHERE project_id = ? ORDER BY rowid ASC`
  ).all(projectId) as Array<{ kind: string; at: string; note: string | null; version: number | null }>;
  const reporter: InvestigationReporterJob | null = row.reporter_job_id ? Object.freeze({
    jobId: row.reporter_job_id,
    taskId: row.reporter_task_id,
    outlineVersion: outlineRow ? outlineRow.version : 0,
    round: row.reporter_round,
    status: row.reporter_status,
    errorMessage: row.reporter_error_message,
    startedAt: row.reporter_started_at,
    finishedAt: row.reporter_finished_at
  }) : null;
  const writer: InvestigationWriterJob | null = row.writer_job_id ? Object.freeze({
    jobId: row.writer_job_id,
    status: row.writer_status,
    startedAt: row.writer_started_at,
    finishedAt: row.writer_finished_at
  }) : null;
  return Object.freeze({
    projectId: row.project_id,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    outlineVersion: outlineRow ? outlineRow.version : null,
    outline: outlineRow ? parseOutline(outlineRow) : null,
    outlineStatus: outlineRow ? outlineRow.status : null,
    reporter,
    package: packageRow ? packageFromRow(packageRow) : null,
    directionVersion: directionRow ? directionRow.version : null,
    direction: directionRow ? parseDirection(directionRow) : null,
    directionStatus: directionRow ? directionRow.status : null,
    writer,
    history: Object.freeze(historyRows.map((item) => Object.freeze({ kind: item.kind, at: item.at, note: item.note, version: item.version })) as InvestigationHistoryEvent[])
  });
}

// ---------------------------------------------------------------------------
// 内部助手
// ---------------------------------------------------------------------------

function validationError(message: string): Error {
  return Object.assign(new Error(`VALIDATION_ERROR: ${message}`), { code: 'VALIDATION_ERROR' });
}

/** 领域抛错 → CommandResult 失败（错误码保持稳定；供公共变更函数 catch 收口）。 */
function failureFrom(error: unknown): CommandResult<never> {
  const candidate = error as { code?: unknown };
  const code = typeof candidate?.code === 'string' ? candidate.code : 'INVALID_STATE';
  const message = error instanceof Error ? error.message : String(error);
  return failure(code as never, message, {});
}

function invalidState(message: string): Error {
  return Object.assign(new Error(`INVALID_STATE: ${message}`), { code: 'INVALID_STATE' });
}

function requireProject(database: DatabaseSync, projectId: string): void {
  const exists = database.prepare('SELECT id FROM content_projects WHERE id = ?').get(projectId);
  if (!exists) throw Object.assign(new Error(`NOT_FOUND: 内容项目不存在：${projectId}`), { code: 'NOT_FOUND' });
}

function requireRow(database: DatabaseSync, projectId: string): InvestigationRow {
  const row = selectInvestigationRow(database, projectId);
  if (!row) throw invalidState('该项目尚未开展专项调查（请先初始化调查）。');
  return row;
}

function requireState(row: InvestigationRow, allowed: readonly ProjectInvestigationStatus[]): void {
  if (!allowed.includes(row.status)) {
    throw invalidState(`当前调查状态（${row.status}）不允许该操作（允许：${allowed.join('/')}）。`);
  }
}

function requireRevision(row: InvestigationRow, expectedRevision: number): void {
  if (row.revision !== expectedRevision) {
    throw Object.assign(new Error(`REVISION_CONFLICT: 调查已更新，请重新加载。`), { code: 'REVISION_CONFLICT' });
  }
}

function recordEvent(database: DatabaseSync, projectId: string, kind: string, note: string | null, version: number | null): void {
  database.prepare(
    `INSERT INTO investigation_events (id, project_id, kind, note, version, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), projectId, kind, note, version, new Date().toISOString());
}

function bumpRevision(database: DatabaseSync, projectId: string, row: InvestigationRow, now: string): number {
  const revision = row.revision + 1;
  database.prepare('UPDATE project_investigations SET revision = ?, updated_at = ? WHERE project_id = ?')
    .run(revision, now, projectId);
  return revision;
}

/** 更新行字段（仅更新传入键；revision 与 updated_at 由 bumpRevision 负责）。 */
function updateRow(database: DatabaseSync, projectId: string, fields: Partial<Record<keyof InvestigationRow, unknown>>): void {
  const keys = Object.keys(fields) as Array<keyof InvestigationRow>;
  if (!keys.length) return;
  const setSql = keys.map((key) => `${key} = ?`).join(', ');
  const values = keys.map((key) => {
    const value = fields[key];
    return (value === undefined || value === null) ? null : String(value);
  });
  database.prepare(`UPDATE project_investigations SET ${setSql} WHERE project_id = ?`)
    .run(...values, projectId);
}

/** 资料包来源关联：只写入既有资料库来源（content_project_sources 关系，INSERT OR IGNORE 幂等）。 */
function linkPackageSourceIds(database: DatabaseSync, projectId: string, sourceIds: readonly string[]): number {
  let linked = 0;
  for (const sourceId of sourceIds) {
    const exists = database.prepare('SELECT id FROM source_items WHERE id = ?').get(sourceId);
    if (!exists) continue;
    const result = database.prepare('INSERT OR IGNORE INTO content_project_sources (project_id, source_id) VALUES (?, ?)').run(projectId, sourceId);
    linked += Number(result.changes);
  }
  return linked;
}

/** 最近一次 approved 提纲版本（调查范围真源；无则抛错——调查必须经 Owner 确认范围）。 */
function requireApprovedOutline(database: DatabaseSync, projectId: string): OutlineVersionRow {
  const outline = selectLatestApprovedOutline(database, projectId);
  if (!outline) throw invalidState('缺少已确认的调查提纲版本（调查范围必须经 Owner 确认）。');
  return outline;
}

/** requiredClaims 派生：经确认提纲的核心调查问题 → q1..qn（fact 维度；调查问题即核查声明）。 */
function claimsFromOutline(outline: InvestigationOutline): readonly ResearchRequiredClaim[] {
  return Object.freeze(
    outline.questions.map((question, index) => Object.freeze({
      key: `q${index + 1}`,
      text: question,
      type: 'fact' as const
    }))
  );
}

function buildInvestigationBrief(projectId: string, outline: InvestigationOutline, outlineVersion: number): string {
  const lines = [
    '项目专项调查工单（主管派记者 / desk）：',
    `项目 ${projectId} 的调查提纲（版本 ${outlineVersion}）已获 Owner 确认，现按提纲开展专项调查。`,
    '【已确认提纲】',
    `调查对象与边界：${outline.scope}`,
    outline.exclusions.length ? `暂不调查：${outline.exclusions.join('；')}` : '',
    outline.known.length ? `当前已知：${outline.known.join('；')}` : '',
    outline.hypotheses.length ? `当前假设（待证实）：${outline.hypotheses.join('；')}` : '',
    `核心调查问题：\n${outline.questions.map((question, index) => `${index + 1}. ${question}`).join('\n')}`,
    outline.dimensions.length ? `事实维度：${outline.dimensions.join('；')}` : '',
    outline.materialRequirements.length ? `材料要求：${outline.materialRequirements.join('；')}` : '',
    outline.truthRisks.length ? `真实性风险：${outline.truthRisks.join('；')}` : '',
    outline.disconfirmingConditions.length ? `推翻条件：${outline.disconfirmingConditions.join('；')}` : '',
    `完成标准：${outline.completionCriteria.length ? outline.completionCriteria.join('；') : '（未列出）'}`,
    '【研究纪律】只经白名单只读工具（web/x/xhs）；预算机器硬执行（深度档）；优先一手来源并保留原始出处；',
    '如实标记未知、冲突与无法确认项；主动寻找能推翻当前理解的材料；不得编造无出处数字或来源 URL；',
    '不得为支持原角度而挑选材料；调查前角度只是假设，事实优先。'
  ];
  return lines.filter(Boolean).join('\n');
}

/** 构建记者研究工单请求（合成稳定 desk 父身份 + 精确提纲版本 + 问题派生声明）。 */
export function buildInvestigationReporterRequest(
  database: DatabaseSync,
  projectId: string,
  round: number
): { request: RoleJobRequest; outlineVersion: number } | null {
  const row = selectInvestigationRow(database, projectId);
  if (!row) return null;
  const outline = selectLatestApprovedOutline(database, projectId);
  if (!outline) return null;
  const outlineValue = parseOutline(outline);
  const gap = Object.freeze({
    gapId: investigationGapId(projectId, outline.version, round),
    parentJobId: investigationParentId(projectId),
    parentTaskId: investigationParentId(projectId),
    parentRoleId: 'desk' as const,
    requiredClaims: claimsFromOutline(outlineValue),
    budget: RESEARCH_DEFAULT_BUDGET,
    channels: Object.freeze(['web', 'x', 'xhs'] as const)
  });
  return Object.freeze({
    request: Object.freeze({
      roleId: 'reporter' as const,
      brief: buildInvestigationBrief(projectId, outlineValue, outline.version),
      businessDate: shanghaiDate(),
      projectId,
      research: gap
    }),
    outlineVersion: outline.version
  });
}

// ---------------------------------------------------------------------------
// 领域变更（纯 DB；写守卫由调用方命令派发授权）
// ---------------------------------------------------------------------------

/** 初始化项目专项调查（幂等：已存在返回当前读模型）。 */
export function initializeProjectInvestigation(database: DatabaseSync, projectId: string): CommandResult<ProjectInvestigation> {
  try {

  requireProject(database, projectId);
  const existing = selectInvestigationRow(database, projectId);
  if (existing) return success(readProjectInvestigation(database, projectId)!);
  const now = new Date().toISOString();
  database.prepare(
    `INSERT INTO project_investigations (
       project_id, status, outline_version, direction_version, reporter_round, revision, created_at, updated_at, finished_at
     ) VALUES (?, 'outline_pending_approval', NULL, NULL, 0, 1, ?, ?, NULL)`
  ).run(projectId, now, now);
  recordEvent(database, projectId, 'initialize', '开始专项调查：等待主管拟定调查提纲并呈报 Owner 确认。', null);
  return success(readProjectInvestigation(database, projectId)!);

  } catch (error) {
    return failureFrom(error);
  }
}

/** 保存调查提纲草稿（每次保存形成新版本；outline_rejected 后重新提交回到待确认）。 */
export function saveInvestigationOutline(
  database: DatabaseSync,
  input: { projectId: string; expectedRevision: number; outline: unknown }
): CommandResult<ProjectInvestigation> {
  try {

  const row = requireRow(database, input.projectId);
  requireRevision(row, input.expectedRevision);
  requireState(row, ['outline_pending_approval', 'outline_rejected']);
  const outline = validateInvestigationOutline(input.outline);
  const now = new Date().toISOString();
  const nextVersion = Number((database.prepare(
    'SELECT COALESCE(MAX(version), 0) + 1 AS version FROM investigation_outline_versions WHERE project_id = ?'
  ).get(input.projectId) as { version: number }).version);
  database.prepare(
    `INSERT INTO investigation_outline_versions (id, project_id, version, outline_json, status, decided_at, created_at)
     VALUES (?, ?, ?, ?, 'draft', NULL, ?)`
  ).run(randomUUID(), input.projectId, nextVersion, JSON.stringify(outline), now);
  updateRow(database, input.projectId, {
    outline_version: nextVersion,
    // 驳回后的新草稿 = 重新呈报（回到待确认）；待确认态保持不变。
    status: row.status === 'outline_rejected' ? 'outline_pending_approval' : row.status
  });
  bumpRevision(database, input.projectId, row, now);
  recordEvent(database, input.projectId, 'outline_saved', '主管保存调查提纲新版本，等待 Owner 确认。', nextVersion);
  return success(readProjectInvestigation(database, input.projectId)!);

  } catch (error) {
    return failureFrom(error);
  }
}

/**
 * Owner 确认/驳回调查提纲（Owner-only UI IPC；approve 前由调用方预生成 reporterJobId——
 * 本函数只记录工单引用与状态转换，不执行 spawn；spawn 失败由 revertInvestigationReporterDispatch 补偿）。
 */
export function decideInvestigationOutline(
  database: DatabaseSync,
  input: { projectId: string; expectedRevision: number; decision: 'approve' | 'reject'; reporterJobId?: string | null; decidedBy?: string }
): CommandResult<ProjectInvestigation> {
  try {

  const row = requireRow(database, input.projectId);
  requireRevision(row, input.expectedRevision);
  requireState(row, ['outline_pending_approval']);
  const outline = selectLatestOutline(database, input.projectId);
  if (!outline || outline.status !== 'draft') {
    return failure('INVALID_STATE', '当前提纲版本已审批；修改需保存新提纲版本后重新确认。', {});
  }
  const now = new Date().toISOString();
  const decidedBy = input.decidedBy?.trim() || 'owner';
  if (input.decision === 'reject') {
    database.prepare(`UPDATE investigation_outline_versions SET status = 'rejected', decided_at = ? WHERE project_id = ? AND version = ?`)
      .run(now, input.projectId, outline.version);
    updateRow(database, input.projectId, { status: 'outline_rejected' });
    bumpRevision(database, input.projectId, row, now);
    recordEvent(database, input.projectId, 'outline_rejected', `Owner 驳回调查提纲（版本 ${outline.version}），等待主管修订。`, outline.version);
    return success(readProjectInvestigation(database, input.projectId)!);
  }
  const reporterJobId = typeof input.reporterJobId === 'string' && input.reporterJobId.trim() ? input.reporterJobId.trim() : '';
  if (!reporterJobId) {
    return failure('VALIDATION_ERROR', '确认调查范围必须同时提供记者工单 ID。', {});
  }
  database.prepare(`UPDATE investigation_outline_versions SET status = 'approved', decided_at = ? WHERE project_id = ? AND version = ?`)
    .run(now, input.projectId, outline.version);
  const round = row.reporter_round + 1;
  updateRow(database, input.projectId, {
    status: 'researching',
    reporter_job_id: reporterJobId,
    reporter_task_id: null,
    reporter_round: round,
    reporter_status: 'queued',
    reporter_error_message: null,
    reporter_started_at: null,
    reporter_finished_at: null
  });
  bumpRevision(database, input.projectId, row, now);
  recordEvent(database, input.projectId, 'outline_approved', `Owner 确认调查范围（提纲版本 ${outline.version}），派记者开展专项调查。`, outline.version);
  recordEvent(database, input.projectId, 'reporter_dispatched', `记者专项调查第 ${round} 轮（${decidedBy} 派单）。`, outline.version);
  return success(readProjectInvestigation(database, input.projectId)!);

  } catch (error) {
    return failureFrom(error);
  }
}

/** 派单失败补偿：恢复派单前状态并清空记者工单引用（审批快照保持不可变，事件说明原因）。 */
export function revertInvestigationReporterDispatch(
  database: DatabaseSync,
  input: { projectId: string; previousStatus: ProjectInvestigationStatus; note: string }
): CommandResult<ProjectInvestigation> {
  try {

  const row = requireRow(database, input.projectId);
  updateRow(database, input.projectId, {
    status: input.previousStatus,
    reporter_job_id: null,
    reporter_task_id: null,
    reporter_status: null,
    reporter_error_message: null,
    reporter_started_at: null,
    reporter_finished_at: null
  });
  bumpRevision(database, input.projectId, row, new Date().toISOString());
  recordEvent(database, input.projectId, 'reporter_dispatch_reverted', input.note, null);
  return success(readProjectInvestigation(database, input.projectId)!);

  } catch (error) {
    return failureFrom(error);
  }
}

/**
 * - accept：必须携带调查后写作方向 → 保存为方向草稿，进入 direction_pending_approval（第二次 Owner 审批）。
 * - defer：资料不足或主管无法自行决定 → 持久化验收结论并进入 needs_user，等待 Owner 选择。
 * - supplement：按已确认范围补查 → needs_more_research + 记录下一轮记者工单引用（调用方随后 spawn）。
 * - expand：形成新提纲版本 → 回到 outline_pending_approval（主管保存扩展版提纲后重新呈报）。
 * - stop：调查表明不值得继续 / Owner 停止 → abandoned。
 */
export function reviewInvestigationResearch(
  database: DatabaseSync,
  input: {
    projectId: string;
    expectedRevision: number;
    decision: 'accept' | 'defer' | 'supplement' | 'expand' | 'stop';
    direction?: unknown;
    summary?: string | null;
    reporterJobId?: string | null;
    decidedBy?: string;
  }
): CommandResult<ProjectInvestigation> {
  try {

  const row = requireRow(database, input.projectId);
  requireRevision(row, input.expectedRevision);
  requireState(row, input.decision === 'defer' ? ['research_review'] : ['research_review', 'needs_user']);
  const packageRow = selectLatestPackage(database, input.projectId);
  if (!packageRow) return failure('INVALID_STATE', '缺少调查资料包，无法验收。', {});
  const now = new Date().toISOString();
  const decidedBy = input.decidedBy?.trim() || 'desk';
  const setReview = (decision: 'accept' | 'defer' | 'supplement' | 'expand' | 'stop', summary: string | null) => {
    database.prepare(`UPDATE investigation_packages SET review_json = ?, reviewed_at = ? WHERE project_id = ? AND round = ?`)
      .run(JSON.stringify({ decision, summary, decidedAt: now, decidedBy }), now, input.projectId, packageRow.round);
  };

  if (input.decision === 'defer') {
    const summary = typeof input.summary === 'string' && input.summary.trim()
      ? input.summary.trim()
      : '主管验收未形成可执行决策，资料不足或存在关键未知，等待 Owner 决定下一步。';
    setReview('defer', summary);
    updateRow(database, input.projectId, { status: 'needs_user' });
    bumpRevision(database, input.projectId, row, now);
    recordEvent(database, input.projectId, 'research_review_deferred', summary, packageRow.round);
    return success(readProjectInvestigation(database, input.projectId)!);
  }

  if (input.decision === 'accept') {
    if (input.direction === undefined) {
      return failure('VALIDATION_ERROR', '验收通过必须提供调查后写作方向（direction）。', {});
    }
    const direction = validateInvestigationDirection(input.direction);
    const nextVersion = Number((database.prepare(
      'SELECT COALESCE(MAX(version), 0) + 1 AS version FROM investigation_direction_versions WHERE project_id = ?'
    ).get(input.projectId) as { version: number }).version);
    database.prepare(
      `INSERT INTO investigation_direction_versions (id, project_id, version, direction_json, status, decided_at, created_at)
       VALUES (?, ?, ?, ?, 'draft', NULL, ?)`
    ).run(randomUUID(), input.projectId, nextVersion, JSON.stringify(direction), now);
    setReview('accept', null);
    updateRow(database, input.projectId, { status: 'direction_pending_approval', direction_version: nextVersion });
    bumpRevision(database, input.projectId, row, now);
    recordEvent(database, input.projectId, 'research_reviewed', `主管验收资料包（第 ${packageRow.round} 轮）通过，形成调查后写作方向（版本 ${nextVersion}），呈报 Owner 确认。`, nextVersion);
    return success(readProjectInvestigation(database, input.projectId)!);
  }

  if (input.decision === 'supplement') {
    const reporterJobId = typeof input.reporterJobId === 'string' && input.reporterJobId.trim() ? input.reporterJobId.trim() : '';
    if (!reporterJobId) return failure('VALIDATION_ERROR', '补查必须同时提供记者工单 ID。', {});
    const approvedOutline = requireApprovedOutline(database, input.projectId);
    const round = row.reporter_round + 1;
    setReview('supplement', null);
    updateRow(database, input.projectId, {
      status: 'needs_more_research',
      reporter_job_id: reporterJobId,
      reporter_task_id: null,
      reporter_round: round,
      reporter_status: 'queued',
      reporter_error_message: null,
      reporter_started_at: null,
      reporter_finished_at: null
    });
    bumpRevision(database, input.projectId, row, now);
    recordEvent(database, input.projectId, 'research_reviewed', `主管验收：需按已确认范围补查（提纲版本 ${approvedOutline.version} 不变，无需 Owner 重批）。`, packageRow.round);
    recordEvent(database, input.projectId, 'reporter_dispatched', `记者补查第 ${round} 轮。`, approvedOutline.version);
    return success(readProjectInvestigation(database, input.projectId)!);
  }

  if (input.decision === 'expand') {
    setReview('expand', null);
    updateRow(database, input.projectId, { status: 'outline_pending_approval' });
    bumpRevision(database, input.projectId, row, now);
    recordEvent(database, input.projectId, 'outline_expand_required', '主管验收：需扩展调查范围；形成提纲新版本并回到 Owner 审批。', packageRow.round);
    return success(readProjectInvestigation(database, input.projectId)!);
  }

  setReview('stop', null);
  updateRow(database, input.projectId, { status: 'abandoned', finished_at: now });
  bumpRevision(database, input.projectId, row, now);
  recordEvent(database, input.projectId, 'abandoned', '主管验收：调查表明不值得继续（材料不足/阻塞），停止项目。', packageRow.round);
  return success(readProjectInvestigation(database, input.projectId)!);

  } catch (error) {
    return failureFrom(error);
  }
}

/** 保存调查后写作方向草稿（每次保存形成新版本；direction_pending_approval 阶段可反复修订）。 */
export function saveInvestigationDirection(
  database: DatabaseSync,
  input: { projectId: string; expectedRevision: number; direction: unknown }
): CommandResult<ProjectInvestigation> {
  try {

  const row = requireRow(database, input.projectId);
  requireRevision(row, input.expectedRevision);
  requireState(row, ['direction_pending_approval']);
  const direction = validateInvestigationDirection(input.direction);
  const now = new Date().toISOString();
  const nextVersion = Number((database.prepare(
    'SELECT COALESCE(MAX(version), 0) + 1 AS version FROM investigation_direction_versions WHERE project_id = ?'
  ).get(input.projectId) as { version: number }).version);
  database.prepare(
    `INSERT INTO investigation_direction_versions (id, project_id, version, direction_json, status, decided_at, created_at)
     VALUES (?, ?, ?, ?, 'draft', NULL, ?)`
  ).run(randomUUID(), input.projectId, nextVersion, JSON.stringify(direction), now);
  updateRow(database, input.projectId, { direction_version: nextVersion });
  bumpRevision(database, input.projectId, row, now);
  recordEvent(database, input.projectId, 'direction_saved', '主管保存调查后写作方向新版本，等待 Owner 确认。', nextVersion);
  return success(readProjectInvestigation(database, input.projectId)!);

  } catch (error) {
    return failureFrom(error);
  }
}

/**
 * Owner 确认/要求修改/停止（第二次审批；Owner-only UI IPC）。
 * approve → ready_to_write（之后才能派写手）；supplement → 保持 direction_pending_approval 等待修订；
 * stop → abandoned。
 */
export function decideInvestigationDirection(
  database: DatabaseSync,
  input: { projectId: string; expectedRevision: number; decision: 'approve' | 'supplement' | 'stop'; decidedBy?: string }
): CommandResult<ProjectInvestigation> {
  try {

  const row = requireRow(database, input.projectId);
  requireRevision(row, input.expectedRevision);
  requireState(row, ['direction_pending_approval']);
  const direction = selectLatestDirection(database, input.projectId);
  if (!direction || direction.status !== 'draft') {
    return failure('INVALID_STATE', '当前写作方向版本已决策；修订需保存新版本后重新呈报。', {});
  }
  const now = new Date().toISOString();
  const decidedBy = input.decidedBy?.trim() || 'owner';
  if (input.decision === 'approve') {
    database.prepare(`UPDATE investigation_direction_versions SET status = 'approved', decided_at = ? WHERE project_id = ? AND version = ?`)
      .run(now, input.projectId, direction.version);
    updateRow(database, input.projectId, { status: 'ready_to_write' });
    bumpRevision(database, input.projectId, row, now);
    recordEvent(database, input.projectId, 'direction_approved', `Owner 确认调查后写作方向（版本 ${direction.version}），项目进入可写状态。`, direction.version);
    return success(readProjectInvestigation(database, input.projectId)!);
  }
  if (input.decision === 'supplement') {
    database.prepare(`UPDATE investigation_direction_versions SET status = 'supplemented', decided_at = ? WHERE project_id = ? AND version = ?`)
      .run(now, input.projectId, direction.version);
    updateRow(database, input.projectId, { status: 'direction_pending_approval' });
    bumpRevision(database, input.projectId, row, now);
    recordEvent(database, input.projectId, 'direction_supplemented', `Owner 要求修改写作方向（版本 ${direction.version}），等待主管修订。`, direction.version);
    return success(readProjectInvestigation(database, input.projectId)!);
  }
  updateRow(database, input.projectId, { status: 'abandoned', finished_at: now });
  bumpRevision(database, input.projectId, row, now);
  recordEvent(database, input.projectId, 'abandoned', `Owner 停止项目（写作方向版本 ${direction.version}）。`, direction.version);
  return success(readProjectInvestigation(database, input.projectId)!);

  } catch (error) {
    return failureFrom(error);
  }
}

/**
 * 派写手（仅 ready_to_write 可派；方向经 Owner 确认后才进入该状态）。
 * 本函数记录写手工单引用 + 状态 → writing（不执行 spawn；spawn 由 IPC 层完成，
 * 失败时调用方应恢复为 ready_to_write——见 startInvestigationWriterViaRuntime 流程）。
 */
export function startInvestigationWriter(
  database: DatabaseSync,
  input: { projectId: string; expectedRevision: number; writerJobId: string; decidedBy?: string }
): CommandResult<ProjectInvestigation> {
  try {

  const row = requireRow(database, input.projectId);
  requireRevision(row, input.expectedRevision);
  requireState(row, ['ready_to_write']);
  const direction = selectLatestDirection(database, input.projectId);
  if (!direction || direction.status !== 'approved') {
    return failure('INVALID_STATE', '写作方向未获 Owner 确认，不能派写手。', {});
  }
  const writerJobId = input.writerJobId.trim();
  if (!writerJobId) return failure('VALIDATION_ERROR', '派写手必须提供工单 ID。', {});
  const now = new Date().toISOString();
  updateRow(database, input.projectId, {
    status: 'writing',
    writer_job_id: writerJobId,
    writer_status: 'queued',
    writer_started_at: null,
    writer_finished_at: null
  });
  bumpRevision(database, input.projectId, row, now);
  recordEvent(database, input.projectId, 'writer_dispatched', `写手启动（方向版本 ${direction.version}，${input.decidedBy?.trim() || 'owner'} 批准后派单）。`, direction.version);
  return success(readProjectInvestigation(database, input.projectId)!);

  } catch (error) {
    return failureFrom(error);
  }
}

/** 写手派单失败补偿：恢复 ready_to_write（方向仍经确认，可再次派单）。 */
export function revertInvestigationWriterDispatch(
  database: DatabaseSync,
  input: { projectId: string; note: string }
): CommandResult<ProjectInvestigation> {
  try {

  const row = requireRow(database, input.projectId);
  updateRow(database, input.projectId, {
    status: 'ready_to_write',
    writer_job_id: null,
    writer_status: null,
    writer_started_at: null,
    writer_finished_at: null
  });
  bumpRevision(database, input.projectId, row, new Date().toISOString());
  recordEvent(database, input.projectId, 'writer_dispatch_reverted', input.note, null);
  return success(readProjectInvestigation(database, input.projectId)!);

  } catch (error) {
    return failureFrom(error);
  }
}

/** 重试/补派记者（failed / needs_user / needs_more_research；同一已确认提纲版本，轮次 +1）。 */
export function retryInvestigationReporter(
  database: DatabaseSync,
  input: { projectId: string; expectedRevision: number; reporterJobId: string; decidedBy?: string }
): CommandResult<ProjectInvestigation> {
  try {

  const row = requireRow(database, input.projectId);
  requireRevision(row, input.expectedRevision);
  requireState(row, ['failed', 'needs_user', 'needs_more_research']);
  const reporterJobId = input.reporterJobId.trim();
  if (!reporterJobId) return failure('VALIDATION_ERROR', '重试必须提供记者工单 ID。', {});
  const approvedOutline = requireApprovedOutline(database, input.projectId);
  const now = new Date().toISOString();
  const round = row.reporter_round + 1;
  updateRow(database, input.projectId, {
    status: 'researching',
    reporter_job_id: reporterJobId,
    reporter_task_id: null,
    reporter_round: round,
    reporter_status: 'queued',
    reporter_error_message: null,
    reporter_started_at: null,
    reporter_finished_at: null
  });
  bumpRevision(database, input.projectId, row, now);
  recordEvent(database, input.projectId, 'reporter_dispatched', `记者专项调查重试第 ${round} 轮（${input.decidedBy?.trim() || 'desk'} 派单，提纲版本 ${approvedOutline.version}）。`, approvedOutline.version);
  return success(readProjectInvestigation(database, input.projectId)!);

  } catch (error) {
    return failureFrom(error);
  }
}

/**
 * 记者工单终态事件（job.finished/job.partial → 落资料包 + 来源关联 + research_review；
 * job.failed → failed；job.needs_user/job.cancelled → needs_user）。pack 缺省时从任务
 * result_refs_json 读回（EvidencePack 由研究执行器在终态前落盘；transcript 删除不影响）。
 */
export function recordInvestigationReporterTerminal(
  database: DatabaseSync,
  input: { projectId: string; jobId: string; type: string; pack?: ResearchEvidencePack; error?: unknown }
): CommandResult<ProjectInvestigation> {
  try {

  const row = requireRow(database, input.projectId);
  if (row.reporter_job_id !== input.jobId) {
    // 过期/已被补偿清除的工单事件：忽略（不产生状态跳变）。
    return failure('NOT_FOUND', '该记者工单不属于当前调查轮次（可能已被重试/补偿替换）。', {});
  }
  const now = new Date().toISOString();
  const errorMessage = typeof input.error === 'string' && input.error.trim() ? input.error.trim() : null;
  const task = database.prepare(
    `SELECT id, result_refs_json AS resultRefsJson FROM agent_tasks
     WHERE intent = 'research' AND json_extract(context_refs_json, '$.jobId') = ?
     ORDER BY updated_at DESC LIMIT 1`
  ).get(input.jobId) as { id: string; resultRefsJson: string } | undefined;
  const taskId = task?.id ?? null;

  if (input.type === 'job.failed') {
    updateRow(database, input.projectId, {
      status: 'failed',
      reporter_task_id: taskId,
      reporter_status: 'failed',
      reporter_error_message: errorMessage ?? '记者专项调查执行失败。',
      reporter_finished_at: now
    });
    bumpRevision(database, input.projectId, row, now);
    recordEvent(database, input.projectId, 'reporter_failed', `记者专项调查第 ${row.reporter_round} 轮失败：${errorMessage ?? '未知原因'}。`, null);
    return success(readProjectInvestigation(database, input.projectId)!);
  }
  if (input.type === 'job.needs_user' || input.type === 'job.cancelled') {
    updateRow(database, input.projectId, {
      status: 'needs_user',
      reporter_task_id: taskId,
      reporter_status: input.type === 'job.needs_user' ? 'needs_user' : 'cancelled',
      reporter_error_message: errorMessage ?? (input.type === 'job.cancelled' ? '记者工单被取消，需主管决策下一步。' : '记者需要主管介入。'),
      reporter_finished_at: now
    });
    bumpRevision(database, input.projectId, row, now);
    recordEvent(database, input.projectId, 'reporter_needs_user', input.type === 'job.cancelled'
      ? `记者专项调查第 ${row.reporter_round} 轮被取消，需主管决策（重试/修订提纲/停止）。`
      : `记者专项调查第 ${row.reporter_round} 轮需要主管介入。`, null);
    return success(readProjectInvestigation(database, input.projectId)!);
  }
  if (input.type !== 'job.finished' && input.type !== 'job.partial') {
    return failure('INVALID_STATE', `未知记者工单终态事件：${input.type}。`, {});
  }
  let persistedPack: ResearchEvidencePack | null = null;
  if (!input.pack && task?.resultRefsJson) {
    try {
      persistedPack = parseResearchEvidencePack(JSON.parse(task.resultRefsJson));
    } catch {
      persistedPack = null;
    }
  }
  const pack = input.pack ?? persistedPack;
  if (!pack) {
    // 机器不变量：EvidencePack 仅在 succeeded/partial 终态产出；缺失 = 执行失败（fail-closed，不伪装成功）。
    updateRow(database, input.projectId, {
      status: 'failed',
      reporter_task_id: taskId,
      reporter_status: 'failed',
      reporter_error_message: '记者终态缺少 EvidencePack（研究执行失败且无可用交付）。',
      reporter_finished_at: now
    });
    bumpRevision(database, input.projectId, row, now);
    recordEvent(database, input.projectId, 'reporter_failed', `记者专项调查第 ${row.reporter_round} 轮终态缺少资料包。`, null);
    return success(readProjectInvestigation(database, input.projectId)!);
  }
  const linked = linkPackageSourceIds(database, input.projectId, pack.sourceIds);
  database.prepare(
    `INSERT INTO investigation_packages (
       id, project_id, round, reporter_job_id, outline_version, pack_json, source_ids_json, review_json, created_at, reviewed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`
  ).run(randomUUID(), input.projectId, row.reporter_round, input.jobId,
    row.outline_version ?? 0, JSON.stringify(pack), JSON.stringify(pack.sourceIds), now);
  updateRow(database, input.projectId, {
    status: 'research_review',
    reporter_task_id: taskId,
    reporter_status: input.type === 'job.finished' ? 'succeeded' : 'partial',
    reporter_error_message: null,
    reporter_finished_at: now
  });
  bumpRevision(database, input.projectId, row, now);
  recordEvent(database, input.projectId, 'research_received',
    `记者交付调查资料包（第 ${row.reporter_round} 轮；${pack.terminalReason}；有效来源 ${pack.validSourceCount}；未解决声明 ${pack.unresolvedRequiredClaims.length} 项；项目关联来源 ${linked} 条），等待主管验收。`,
    null);
  return success(readProjectInvestigation(database, input.projectId)!);

  } catch (error) {
    return failureFrom(error);
  }
}

/**
 * 写手工单终态事件：succeeded → completed；partial/failed/cancelled/needs_user → ready_to_write
 * （方向仍经确认；写手可重新派单或主管另行决策，绝不伪造成功）。
 */
export function recordInvestigationWriterTerminal(
  database: DatabaseSync,
  input: { projectId: string; jobId: string; type: string; error?: unknown }
): CommandResult<ProjectInvestigation> {
  try {

  const row = requireRow(database, input.projectId);
  if (row.writer_job_id !== input.jobId) {
    return failure('NOT_FOUND', '该写手工单不属于当前调查（可能已被替换）。', {});
  }
  const now = new Date().toISOString();
  const errorMessage = typeof input.error === 'string' && input.error.trim() ? input.error.trim() : null;
  if (input.type === 'job.finished') {
    updateRow(database, input.projectId, {
      status: 'completed',
      writer_status: 'succeeded',
      writer_finished_at: now,
      finished_at: now
    });
    bumpRevision(database, input.projectId, row, now);
    recordEvent(database, input.projectId, 'writer_terminal', '写手交付正文，专项调查流程完成。', null);
    return success(readProjectInvestigation(database, input.projectId)!);
  }
  if (input.type !== 'job.partial' && input.type !== 'job.failed' && input.type !== 'job.cancelled' && input.type !== 'job.needs_user') {
    return failure('INVALID_STATE', `未知写手工单终态事件：${input.type}。`, {});
  }
  updateRow(database, input.projectId, {
    status: 'ready_to_write',
    writer_status: input.type === 'job.partial' ? 'partial' : input.type === 'job.failed' ? 'failed' : input.type === 'job.cancelled' ? 'cancelled' : 'needs_user',
    writer_finished_at: now
  });
  bumpRevision(database, input.projectId, row, now);
  recordEvent(database, input.projectId, 'writer_terminal',
    `写手工单${input.type === 'job.partial' ? '部分交付' : input.type === 'job.failed' ? '失败' : input.type === 'job.cancelled' ? '被取消' : '需主管介入'}：${errorMessage ?? '项目回到可写状态，可重新派单或另行决策。'}`, null);
  return success(readProjectInvestigation(database, input.projectId)!);

  } catch (error) {
    return failureFrom(error);
  }
}

// ---------------------------------------------------------------------------
// 运行时封装（写守卫）：终态事件处理器
// ---------------------------------------------------------------------------

function investigationActor() {
  return { type: 'scheduler' as const, id: 'project-investigation', label: 'project-investigation' };
}

async function runInvestigationWrite<T>(
  runtime: ActiveWorkspaceRuntime,
  command: string,
  projectId: string,
  work: (database: DatabaseSync) => T
): Promise<T> {
  const receipt = await dispatchBusinessCommand(runtime, {
    command,
    requestId: `${command}:${projectId}:${randomUUID()}`,
    actor: investigationActor(),
    input: { projectId },
    boundIdentity: { entityType: 'content_project', entityId: projectId },
    entityType: 'project_investigation',
    execute: (database) => {
      const data = work(database);
      return { data, entityId: projectId, readback: data };
    }
  });
  if (!receipt.ok) {
    throw Object.assign(new Error(receipt.error?.message ?? 'INVESTIGATION_WRITE_FAILED'), {
      code: receipt.error?.code ?? 'INVESTIGATION_WRITE_FAILED',
      details: receipt.error?.details
    });
  }
  return receipt.data as T;
}
export function buildInvestigationSupervisorReviewPrompt(projectId: string): string {
  return [
    `请立即验收创作项目 ${projectId} 的专项调查资料包。`,
    `先调用 wmb_get_investigation({ project_id: "${projectId}" }) 读取最新 revision、已确认提纲、资料包、来源引用和未解决声明。`,
    '逐项核对来源是否支持关键事实，区分成立判断、需收窄或推翻的判断、新发现与仍未知边界；不得把来源标题、摘要或 reporter 自述当成已核实事实。',
    '资料包足以形成可信写作方向时，必须调用 wmb_review_investigation_research，携带当前 expected_revision、decision="accept" 和完整 direction；成功后必须读回 direction_pending_approval，再向 Owner 汇报待第二次审批。',
    '资料不足或存在无法由主管自行决定的关键未知时，不得伪造方向、不得自行验收通过或派写手；必须调用 wmb_review_investigation_research，携带当前 expected_revision、decision="defer" 和具体 summary，将结论持久化为 needs_user，再向 Owner 说明以下有效选择：按观点稿继续（强观点与未来判断可保留为作者判断，数字、引语、具体案例、归因等外部可验证事实仍须落在证据内）、需要补查、扩展范围或停止调查。',
    '无论通过或暂缓，本回合都必须持久化一次验收结果；不得把项目留在 research_review。成功后读回最新调查状态。这是主管验收回合，不派写手、不代替 Owner 选择「按观点稿继续」、不修改 Owner 审批，不要 sleep 或轮询。'
  ].join('\n');
}


/**
 * 工单终态事件入口（记者/写手；由 spawner onEvent 接线）。
 * 只处理本项目调查引用的工单；过期/无关事件静默忽略（幂等，可重放）。
 * 返回命中的工单角色，供通知桥避免再开一个通用主管回合。
 */
export async function handleInvestigationJobEvent(
  runtime: ActiveWorkspaceRuntime,
  event: Record<string, unknown>
): Promise<{ role: 'reporter_review' | 'reporter' | 'writer'; projectId: string; dispatchSupervisor?: boolean } | null> {
  const jobId = typeof event.jobId === 'string' ? event.jobId : '';
  const type = String(event.type ?? '');
  if (!jobId || !['job.finished', 'job.partial', 'job.failed', 'job.cancelled', 'job.needs_user'].includes(type)) return null;
  const row = runtime.database.prepare(
    `SELECT project_id, status, reporter_job_id, writer_job_id FROM project_investigations
     WHERE reporter_job_id = ? OR writer_job_id = ?`
  ).get(jobId, jobId) as { project_id: string; status: ProjectInvestigationStatus; reporter_job_id: string | null; writer_job_id: string | null } | undefined;
  if (!row) return null;
  try {
    if (row.reporter_job_id === jobId) {
      const result = await runInvestigationWrite(runtime, 'investigation.reporter_terminal', row.project_id, (database) =>
        recordInvestigationReporterTerminal(database, { projectId: row.project_id, jobId, type, error: event.error }));
      broadcastDataChanged({ scopes: ['studio', 'agent'], reason: `investigation.reporter_terminal:${type}` });
      if (result.ok && result.data.status === 'research_review') {
        return { role: 'reporter_review', projectId: row.project_id, dispatchSupervisor: row.status !== 'research_review' };
      }
      return { role: 'reporter', projectId: row.project_id };
    }
    if (row.writer_job_id === jobId) {
      await runInvestigationWrite(runtime, 'investigation.writer_terminal', row.project_id, (database) =>
        recordInvestigationWriterTerminal(database, { projectId: row.project_id, jobId, type, error: event.error }));
      broadcastDataChanged({ scopes: ['studio', 'agent'], reason: `investigation.writer_terminal:${type}` });
      return { role: 'writer', projectId: row.project_id };
    }
  } catch (error) {
    console.error('[project-investigation-event]', error);
  }
  return null;
}
