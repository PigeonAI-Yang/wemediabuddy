/**
 * WMB-5215 M6：创作知识调用血缘——正式保存链的 usage 接入（本 worker：IntegrateCreationUsage）。
 * Design: docs/spark/2026-08-12-wmb-creation-knowledge-usage-protocol-design.md §4/§6/§10
 *
 * 职责：把不可变 Knowledge Usage Package/Record 与真实保存链（选题→简报→核心版本→平台版本
 * →复盘）接入同一事务；consulted 不冒充 used；Usage 写失败整体回滚（内容零提交）；平台适配
 * 继承核心血缘且换基事实版本时拒绝保存。
 *
 * 本文件只做「解析 + 组装 + 调用」，schema/事务真源在 src/main/knowledge-usage.ts（UsageStore
 * worker owner，v57）。全部调用传 transaction=false：调用方（dispatcher BEGIN IMMEDIATE 或业务
 * 函数显式事务）负责原子性，Usage 抛错即整体回滚。
 *
 * 血缘约定（不新增第二套关系）：
 * - 每个业务对象的固定包 requestId 稳定命名 `usage:{stage}:{业务对象 id}`；
 * - core_draft 包以 contentVersionId 命名，platform_adaptation 包经 platform_versions.
 *   content_version_id 反查其核心包，继承同一批固定 wiki/note 版本（协议 §4.5）；
 * - used 由 usageKind 派生：quoted/paraphrased/reasoning_basis/structure_pattern/
 *   avoided_due_to_risk/rejected_by_user = used；consulted = 仅读取未证影响（§4.4/§6）。
 *
 * 零知识语义（WMB-5232 显式契约：如实空血缘，禁止伪造）：
 * - 业务对象真实存在但无 Topic / Topic 无已编译 Wiki / 无采纳 Note / 无证据时，
 *   仍按稳定 requestId 生成 Usage 包，血缘字段（wiki/note/evidence）如实为空、
 *   零 Usage Record（不冒充 used/consulted）——包存在 = 审计面完整（“本次未使用知识”），
 *   空血缘 = 未声称任何知识被调用；绝不回填后续编译知识（不可变血缘）。
 * - 只有业务对象本身不存在/无工作空间身份时才跳过（readBoundWorkspaceId 守卫），
 *   与 WMB-5215/WMB-5216 的“无归属不造血缘”一致。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { KnowledgeScope } from './knowledge-flywheel.ts';
import {
  createKnowledgeUsage,
  getKnowledgeUsagePackageByRequest,
  type KnowledgeUsageInput,
  type KnowledgeUsageMeta,
  type KnowledgeUsagePackageRecord,
  type KnowledgeUsageRecordWrite,
  type KnowledgeUsageRiskKind,
  type KnowledgeUsageStage
} from './knowledge-usage.ts';

/** 创建知识使用包/记录时的 compiler/schema 版本（协议 §2 要求快照携带）。 */
export const USAGE_COMPILER_SCHEMA_VERSION = 'flywheel-v1' as const;

/** 稳定 requestId 约定：`usage:{stage}:{业务对象 id}`（UsageStore 契约：同 requestId+同 input 重放零写）。 */
export function usageRequestId(stage: KnowledgeUsageStage, objectId: string): string {
  return `usage:${stage}:${objectId}`;
}

/** 发布时固定血缘投影（platform 包 + 其核心包 + 复盘包）。 */
export interface PublicationTimeUsage {
  platformPackage: KnowledgeUsagePackageRecord | null;
  corePackage: KnowledgeUsagePackageRecord | null;
  reviewPackages: Array<{ requestId: string; package: KnowledgeUsagePackageRecord }>;
}

function readBoundWorkspaceId(database: DatabaseSync): string | null {
  try {
    const row = database.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get() as { value?: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/** 解析 Topic 当前固定 Wiki 版本及其采纳的 Note 版本（无编译结果时返回空）。 */
function resolveTopicKnowledge(
  database: DatabaseSync,
  topicId: string | null
): { wikiPageVersionIds: string[]; noteVersionIds: string[] } {
  if (!topicId) return { wikiPageVersionIds: [], noteVersionIds: [] };
  try {
    const page = database.prepare(
      `SELECT current_version_id AS currentVersionId
       FROM knowledge_wiki_pages
       WHERE subject_type='topic' AND subject_id=? AND lifecycle='active'
       ORDER BY updated_at DESC LIMIT 1`
    ).get(topicId) as { currentVersionId: string | null } | undefined;
    if (!page) return { wikiPageVersionIds: [], noteVersionIds: [] };
    let versionId = page.currentVersionId;
    if (!versionId) {
      const latest = database.prepare(
        `SELECT pv.id AS id FROM knowledge_wiki_pages p
         JOIN knowledge_wiki_page_versions pv ON pv.page_id=p.id
         WHERE p.subject_type='topic' AND p.subject_id=? AND p.lifecycle='active'
         ORDER BY pv.version_number DESC LIMIT 1`
      ).get(topicId) as { id?: string } | undefined;
      versionId = latest?.id ?? null;
    }
    if (!versionId) return { wikiPageVersionIds: [], noteVersionIds: [] };
    const version = database.prepare(
      `SELECT adopted_note_version_ids_json AS adopted FROM knowledge_wiki_page_versions WHERE id=?`
    ).get(versionId) as { adopted?: string } | undefined;
    const adopted = version?.adopted ? JSON.parse(version.adopted) as unknown : [];
    return {
      wikiPageVersionIds: [versionId],
      noteVersionIds: Array.isArray(adopted) ? adopted.map(String).filter(Boolean) : []
    };
  } catch {
    // 精简 fixture 缺表（未跑 v56）→ 无可解析版本
    return { wikiPageVersionIds: [], noteVersionIds: [] };
  }
}

/** 从 Note 版本结论推导风险标记（协议 §7：disputed/stale/inference/…）。 */
function riskFlagsForNoteVersions(database: DatabaseSync, noteVersionIds: readonly string[]): Array<{ kind: KnowledgeUsageRiskKind; versionKind: 'note'; versionId: string }> {
  if (!noteVersionIds.length) return [];
  const flags: Array<{ kind: KnowledgeUsageRiskKind; versionKind: 'note'; versionId: string }> = [];
  try {
    const rows = database.prepare(
      `SELECT id, conclusion_status AS status FROM knowledge_note_versions WHERE id IN (${noteVersionIds.map(() => '?').join(',')})`
    ).all(...noteVersionIds) as Array<{ id: string; status: string }>;
    const statusToRisk: Record<string, KnowledgeUsageRiskKind> = {
      disputed: 'disputed', contradicted: 'contradicted', superseded: 'stale',
      inference: 'inference', unverified: 'unverified'
    };
    for (const row of rows) {
      const kind = statusToRisk[row.status];
      if (kind) flags.push({ kind, versionKind: 'note', versionId: row.id });
    }
  } catch {
    // 缺表 → 无风险标记
  }
  return flags;
}

/** 解析固定版本的 EvidenceLink 入口（采纳 Note 版本 + 项目来源的 evidence 链接）。 */
function resolveEvidenceIds(database: DatabaseSync, noteVersionIds: readonly string[], sourceIds: readonly string[]): string[] {
  try {
    const clauses: string[] = [];
    const args: string[] = [];
    if (noteVersionIds.length) {
      clauses.push(`knowledge_note_version_id IN (${noteVersionIds.map(() => '?').join(',')})`);
      args.push(...noteVersionIds);
    }
    if (sourceIds.length) {
      clauses.push(`(evidence_object_type = 'source' AND evidence_object_id IN (${sourceIds.map(() => '?').join(',')}))`);
      args.push(...sourceIds);
    }
    if (!clauses.length) return [];
    return (database.prepare(`SELECT id FROM knowledge_evidence_links WHERE ${clauses.join(' OR ')}`).all(...args) as Array<{ id: string }>).map((row) => row.id);
  } catch {
    return [];
  }
}

/** 项目级血缘解析：topic + 项目来源 + Topic 固定 Wiki 版本（供 core/platform/review 阶段复用）。 */
export function resolveProjectUsageContext(
  database: DatabaseSync,
  input: { projectId: string; topicId?: string | null }
): {
  scope: KnowledgeScope;
  topicId: string | null;
  sourceIds: string[];
  wikiPageVersionIds: string[];
  noteVersionIds: string[];
  evidenceIds: string[];
} {
  let topicId = input.topicId ?? null;
  if (topicId === null || topicId === undefined) {
    try {
      const row = database.prepare('SELECT topic_id AS topicId FROM content_projects WHERE id=?').get(input.projectId) as { topicId?: string | null } | undefined;
      topicId = row?.topicId ?? null;
    } catch {
      topicId = null;
    }
  }
  let sourceIds: string[] = [];
  try {
    sourceIds = (database.prepare('SELECT source_id AS id FROM content_project_sources WHERE project_id=?').all(input.projectId) as Array<{ id: string }>).map((row) => row.id);
  } catch {
    sourceIds = [];
  }
  const knowledge = resolveTopicKnowledge(database, topicId);
  let scope: KnowledgeScope = 'global';
  if (topicId) {
    try {
      const row = database.prepare(
        `SELECT scope FROM knowledge_wiki_pages WHERE subject_type='topic' AND subject_id=? AND lifecycle='active' LIMIT 1`
      ).get(topicId) as { scope?: string } | undefined;
      if (row?.scope === 'global' || (typeof row?.scope === 'string' && row.scope.startsWith('lane:'))) scope = row.scope as KnowledgeScope;
    } catch {
      scope = 'global';
    }
  }
  return {
    scope,
    topicId,
    sourceIds,
    wikiPageVersionIds: knowledge.wikiPageVersionIds,
    noteVersionIds: knowledge.noteVersionIds,
    evidenceIds: resolveEvidenceIds(database, knowledge.noteVersionIds, sourceIds)
  };
}

function usageMeta(database: DatabaseSync, requestId: string, reason: string, createdBy: KnowledgeUsageMeta['createdBy']): KnowledgeUsageMeta {
  return { workspaceId: readBoundWorkspaceId(database) ?? '', requestId, reason, createdBy };
}

function baseRecords(
  outputObjectType: KnowledgeUsageRecordWrite['outputObjectType'],
  outputObjectId: string,
  context: { wikiPageVersionIds: readonly string[]; noteVersionIds: readonly string[] },
  usedKind: KnowledgeUsageRecordWrite['usageKind'],
  actor: string
): KnowledgeUsageRecordWrite[] {
  const records: KnowledgeUsageRecordWrite[] = [];
  for (const wikiVersionId of context.wikiPageVersionIds) {
    records.push({ outputObjectType, outputObjectId, versionKind: 'wiki_page', versionId: wikiVersionId, usageKind: usedKind, actor });
  }
  for (const noteVersionId of context.noteVersionIds) {
    records.push({ outputObjectType, outputObjectId, versionKind: 'note', versionId: noteVersionId, usageKind: 'consulted', actor });
  }
  return records;
}

/** 从 UsageStore 返回的包记录安全读取血缘字段（记录为顶层字段，读时容错）。 */
function lineageFieldsOf(pkg: KnowledgeUsagePackageRecord | null): Partial<KnowledgeUsagePackageRecord> {
  if (!pkg) return {};
  return {
    scope: pkg.scope,
    topicId: pkg.topicId,
    sourceIds: pkg.sourceIds,
    wikiPageVersionIds: pkg.wikiPageVersionIds,
    noteVersionIds: pkg.noteVersionIds,
    evidenceIds: pkg.evidenceIds
  };
}

// ============================================================
// 阶段接入（全部 transaction=false：调用方事务内执行）
// ============================================================

/** 选题呈报：Topic 整理提案冻结时记录其固定 Wiki 版本（consulted，不冒充 used）。 */
export function recordTopicProposalUsage(
  database: DatabaseSync,
  input: { proposalId: string; topicIds: string[]; reason: string }
): void {
  const workspaceId = readBoundWorkspaceId(database);
  if (!workspaceId) return; // 无工作空间身份（精简 fixture）→ 不造无归属血缘
  const wikiPageVersionIds: string[] = [];
  const noteVersionIds: string[] = [];
  let scope: KnowledgeScope = 'global';
  for (const topicId of input.topicIds) {
    const knowledge = resolveTopicKnowledge(database, topicId);
    wikiPageVersionIds.push(...knowledge.wikiPageVersionIds);
    noteVersionIds.push(...knowledge.noteVersionIds);
    try {
      const row = database.prepare(
        `SELECT scope FROM knowledge_wiki_pages WHERE subject_type='topic' AND subject_id=? AND lifecycle='active' LIMIT 1`
      ).get(topicId) as { scope?: string } | undefined;
      if (row?.scope === 'global' || (typeof row?.scope === 'string' && row.scope.startsWith('lane:'))) scope = row.scope as KnowledgeScope;
    } catch { /* 缺表 */ }
  }
  const requestId = usageRequestId('topic_proposal', input.proposalId);
  const usage: KnowledgeUsageInput = {
    package: {
      scope,
      stage: 'topic_proposal',
      topicId: input.topicIds[0] ?? undefined,
      wikiPageVersionIds,
      noteVersionIds,
      evidenceIds: resolveEvidenceIds(database, noteVersionIds, []),
      selectionReasons: [input.reason],
      compilerSchemaVersion: USAGE_COMPILER_SCHEMA_VERSION
    },
    records: baseRecords('topic_proposal', input.proposalId, { wikiPageVersionIds, noteVersionIds }, 'consulted', 'librarian')
  };
  createKnowledgeUsage(database, usageMeta(database, requestId, input.reason, 'background_agent'), usage, false);
}

/** 核心正文版本：记录本版本固定血缘（Topic Wiki = reasoning_basis，采纳 Note = consulted）。 */
export function recordCoreDraftUsage(
  database: DatabaseSync,
  input: { contentVersionId: string; projectId: string; planItemId?: string | null; author?: 'user' | 'ai'; reason?: string }
): void {
  const workspaceId = readBoundWorkspaceId(database);
  if (!workspaceId) return;
  const context = resolveProjectUsageContext(database, { projectId: input.projectId });
  const requestId = usageRequestId('core_draft', input.contentVersionId);
  const actor = input.author === 'user' ? 'user' : 'ai';
  const usage: KnowledgeUsageInput = {
    package: {
      scope: context.scope,
      stage: 'core_draft',
      topicId: context.topicId ?? undefined,
      sourceIds: context.sourceIds,
      planItemId: input.planItemId ?? undefined,
      projectId: input.projectId,
      wikiPageVersionIds: context.wikiPageVersionIds,
      noteVersionIds: context.noteVersionIds,
      evidenceIds: context.evidenceIds,
      riskFlags: riskFlagsForNoteVersions(database, context.noteVersionIds),
      selectionReasons: [input.reason ?? 'core_draft_save'],
      compilerSchemaVersion: USAGE_COMPILER_SCHEMA_VERSION
    },
    records: baseRecords('content_version', input.contentVersionId, context, 'reasoning_basis', actor)
  };
  createKnowledgeUsage(database, usageMeta(database, requestId, input.reason ?? '核心正文版本保存', input.author === 'user' ? 'user' : 'background_agent'), usage, false);
}

/**
 * 平台版本：继承所引用核心版本的固定血缘（协议 §4.5）；换基核心版本（事实变化）拒绝保存。
 * - 新建：创建 platform_adaptation 包，知识版本与 core_draft 包一致；
 * - 更新且换基：已存在包（requestId 稳定）配不同输入 → 明确拒绝（协议 §10：要求核心新版本）；
 * - 更新未换基：跳过（血缘已在创建时固定，不重复写）。
 */
export function recordPlatformUsage(
  database: DatabaseSync,
  input: { platformVersionId: string; projectId: string; contentVersionId: string; platform: string; format?: string; existingContentVersionId?: string | null; reason?: string }
): void {
  const workspaceId = readBoundWorkspaceId(database);
  if (!workspaceId) return;
  const requestId = usageRequestId('platform_adaptation', input.platformVersionId);
  if (input.existingContentVersionId !== undefined) {
    const existing = getKnowledgeUsagePackageByRequest(database, workspaceId, requestId);
    if (existing) {
      if (input.existingContentVersionId !== input.contentVersionId) {
        const error = new Error('平台适配更换了基础核心版本（事实变化）：拒绝保存，请先保存新的核心版本再重新适配。');
        (error as Error & { code: string }).code = 'REQUEST_REPLAY_CONFLICT';
        throw error;
      }
      return; // 未换基：血缘已固定
    }
  }
  // 优先继承所引用核心版本的血缘；旧内容无 core 包时退回项目当前解析（此时为本次保存的固定版本）。
  const corePackage = getKnowledgeUsagePackageByRequest(database, workspaceId, usageRequestId('core_draft', input.contentVersionId));
  const fallback = resolveProjectUsageContext(database, { projectId: input.projectId });
  const inherited = lineageFieldsOf(corePackage);
  const context = {
    scope: (inherited.scope as KnowledgeScope | undefined) ?? fallback.scope,
    topicId: inherited.topicId ?? fallback.topicId,
    sourceIds: inherited.sourceIds ?? fallback.sourceIds,
    wikiPageVersionIds: inherited.wikiPageVersionIds ?? fallback.wikiPageVersionIds,
    noteVersionIds: inherited.noteVersionIds ?? fallback.noteVersionIds,
    evidenceIds: inherited.evidenceIds ?? fallback.evidenceIds
  };
  const usage: KnowledgeUsageInput = {
    package: {
      scope: context.scope,
      stage: 'platform_adaptation',
      topicId: context.topicId ?? undefined,
      sourceIds: context.sourceIds,
      projectId: input.projectId,
      platform: input.platform,
      format: input.format,
      wikiPageVersionIds: context.wikiPageVersionIds,
      noteVersionIds: context.noteVersionIds,
      evidenceIds: context.evidenceIds,
      riskFlags: riskFlagsForNoteVersions(database, context.noteVersionIds),
      selectionReasons: [input.reason ?? 'platform_adaptation_save'],
      compilerSchemaVersion: USAGE_COMPILER_SCHEMA_VERSION
    },
    records: baseRecords('platform_version', input.platformVersionId, context, 'structure_pattern', 'user')
  };
  createKnowledgeUsage(database, usageMeta(database, requestId, input.reason ?? '平台版本保存', 'user'), usage, false);
}

/** 复盘：记录发布时固定版本（协议 §4.6 / §10——不读取未来知识改写历史）。 */
export function recordReviewUsage(
  database: DatabaseSync,
  input: { reviewId: string; publicationId: string; contentVersionId: string; reason?: string }
): void {
  const workspaceId = readBoundWorkspaceId(database);
  if (!workspaceId) return;
  const requestId = usageRequestId('review', input.reviewId);
  if (getKnowledgeUsagePackageByRequest(database, workspaceId, requestId)) return; // 血缘已固定（draft→final 不重写）
  let projectId: string | null = null;
  try {
    const row = database.prepare(
      `SELECT pv.project_id AS projectId FROM publications p
       JOIN platform_versions pv ON pv.id=p.platform_version_id WHERE p.id=?`
    ).get(input.publicationId) as { projectId?: string } | undefined;
    projectId = row?.projectId ?? null;
  } catch {
    projectId = null;
  }
  if (!projectId) return;
  const corePackage = getKnowledgeUsagePackageByRequest(database, workspaceId, usageRequestId('core_draft', input.contentVersionId));
  const fallback = resolveProjectUsageContext(database, { projectId });
  const inherited = lineageFieldsOf(corePackage);
  const context = {
    scope: (inherited.scope as KnowledgeScope | undefined) ?? fallback.scope,
    topicId: inherited.topicId ?? fallback.topicId,
    sourceIds: inherited.sourceIds ?? fallback.sourceIds,
    wikiPageVersionIds: inherited.wikiPageVersionIds ?? fallback.wikiPageVersionIds,
    noteVersionIds: inherited.noteVersionIds ?? fallback.noteVersionIds,
    evidenceIds: inherited.evidenceIds ?? fallback.evidenceIds
  };
  const usage: KnowledgeUsageInput = {
    package: {
      scope: context.scope,
      stage: 'review',
      topicId: context.topicId ?? undefined,
      sourceIds: context.sourceIds,
      projectId,
      wikiPageVersionIds: context.wikiPageVersionIds,
      noteVersionIds: context.noteVersionIds,
      evidenceIds: context.evidenceIds,
      riskFlags: riskFlagsForNoteVersions(database, context.noteVersionIds),
      selectionReasons: [input.reason ?? 'review_save'],
      compilerSchemaVersion: USAGE_COMPILER_SCHEMA_VERSION
    },
    records: baseRecords('review', input.reviewId, context, 'reasoning_basis', 'user')
  };
  createKnowledgeUsage(database, usageMeta(database, requestId, input.reason ?? '复盘保存', 'user'), usage, false);
}

/** 创作简报：记录简报上下文固定的知识版本（Wiki = reasoning_basis，采纳 Note = consulted）。 */
export function recordCreativeBriefUsage(
  database: DatabaseSync,
  input: { briefId: string; contextNodeIds: string[]; reason?: string }
): void {
  const workspaceId = readBoundWorkspaceId(database);
  if (!workspaceId) return;
  const requestId = usageRequestId('creative_brief', input.briefId);
  if (getKnowledgeUsagePackageByRequest(database, workspaceId, requestId)) return;
  let nodeRefs: Array<{ objectType: string; objectId: string | null }> = [];
  try {
    if (input.contextNodeIds.length) {
      nodeRefs = database.prepare(
        `SELECT object_type AS objectType, object_id AS objectId FROM knowledge_canvas_nodes
         WHERE id IN (${input.contextNodeIds.map(() => '?').join(',')})`
      ).all(...input.contextNodeIds) as Array<{ objectType: string; objectId: string | null }>;
    }
  } catch {
    nodeRefs = [];
  }
  const topicId = nodeRefs.find((ref) => ref.objectType === 'topic' && ref.objectId)?.objectId ?? null;
  const sourceIds = nodeRefs.filter((ref) => ref.objectType === 'source' && ref.objectId).map((ref) => ref.objectId!);
  const knowledge = resolveTopicKnowledge(database, topicId);
  let scope: KnowledgeScope = 'global';
  if (topicId) {
    try {
      const row = database.prepare(
        `SELECT scope FROM knowledge_wiki_pages WHERE subject_type='topic' AND subject_id=? AND lifecycle='active' LIMIT 1`
      ).get(topicId) as { scope?: string } | undefined;
      if (row?.scope === 'global' || (typeof row?.scope === 'string' && row.scope.startsWith('lane:'))) scope = row.scope as KnowledgeScope;
    } catch {
      scope = 'global';
    }
  }
  const usage: KnowledgeUsageInput = {
    package: {
      scope,
      stage: 'creative_brief',
      topicId: topicId ?? undefined,
      sourceIds,
      wikiPageVersionIds: knowledge.wikiPageVersionIds,
      noteVersionIds: knowledge.noteVersionIds,
      evidenceIds: resolveEvidenceIds(database, knowledge.noteVersionIds, sourceIds),
      riskFlags: riskFlagsForNoteVersions(database, knowledge.noteVersionIds),
      selectionReasons: [input.reason ?? 'creative_brief_context'],
      compilerSchemaVersion: USAGE_COMPILER_SCHEMA_VERSION
    },
    records: baseRecords('creative_brief', input.briefId, knowledge, 'reasoning_basis', 'user')
  };
  createKnowledgeUsage(database, usageMeta(database, requestId, input.reason ?? '创作简报保存', 'user'), usage, false);
}

// ============================================================
// 读取（复盘/前端使用面板：只读固定包，不读当前知识）
// ============================================================

/** 历史复盘读取发布时固定血缘：按发布时 platform/core 包反查，绝不回读当前 Wiki。 */
export function readPublicationTimeUsage(database: DatabaseSync, input: { publicationId: string }): PublicationTimeUsage | null {
  const workspaceId = readBoundWorkspaceId(database);
  if (!workspaceId) return null;
  try {
    const row = database.prepare(
      `SELECT pv.id AS platformVersionId, pv.content_version_id AS contentVersionId
       FROM publications p JOIN platform_versions pv ON pv.id=p.platform_version_id WHERE p.id=?`
    ).get(input.publicationId) as { platformVersionId: string; contentVersionId: string } | undefined;
    if (!row) return null;
    const platformPackage = getKnowledgeUsagePackageByRequest(database, workspaceId, usageRequestId('platform_adaptation', row.platformVersionId));
    const corePackage = getKnowledgeUsagePackageByRequest(database, workspaceId, usageRequestId('core_draft', row.contentVersionId));
    const reviewPackages = (database.prepare(
      `SELECT id FROM reviews WHERE publication_id=? ORDER BY created_at,id`
    ).all(input.publicationId) as Array<{ id: string }>)
      .map((review) => ({ requestId: usageRequestId('review', review.id), package: getKnowledgeUsagePackageByRequest(database, workspaceId, usageRequestId('review', review.id)) }))
      .filter((entry) => entry.package !== null) as Array<{ requestId: string; package: KnowledgeUsagePackageRecord }>;
    return { platformPackage, corePackage, reviewPackages };
  } catch {
    return null;
  }
}
