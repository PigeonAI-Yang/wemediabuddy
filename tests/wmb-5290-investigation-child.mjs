// WMB-5290 项目专项调查域合同测试（child，由 wmb-5290-investigation.test.mjs 派生执行）。
//
// 覆盖共享合同（docs/spark/2026-08-16-project-investigation-writing-workflow-design.md）：
// 1. 每个项目最多一个当前调查；重复 initialize 不产生第二行；
// 2. 提纲/方向版本化不可变：旧版本行不因新版本写入而改变；
// 3. 每次成功变更（含终态事件）revision 递增；expectedRevision 过期 → 拒绝；
// 4. 第一次 Owner 审批门：approve 必须携带 reporterJobId；reject → outline_rejected，
//    新提纲版本回到待批；批准前不存在记者工单引用；
// 5. 记者工单绑定精确项目 + 精确提纲版本：buildInvestigationReporterRequest 的
//    outlineVersion 与已批准版本一致，requiredClaims 派生自已批准提纲问题（q1..qn，
//    type=fact），父角色 desk、父工单/父任务为合成稳定 investigation 引用、预算=默认预算；
// 6. 终态事件持久化 EvidencePack（精确保留）+ sourceIds 关联进 content_project_sources，
//    包内不复制来源正文；job.finished/partial→research_review、failed→failed、
//    needs_user/cancelled→needs_user；
// 7. 调查记者终态绝不生成 research_successor 续派（desk 父 → investigation_parent），
//    非 desk 父仍正常续派（对照）；
// 8. 第二次审批门：方向批准前不可 startInvestigationWriter（research_review/未初始化均拒绝）；
//    JobSpawner.spawn 对 writer + 未就绪调查项目同步抛 JOB_INVESTIGATION_NOT_READY；
//    无调查的遗留项目与 ready_to_write 项目照常放行；
// 9. 显式写手启动：startInvestigationWriter 记录 writerJobId → writing（writing 中拒绝重复）；
//    writer 终态 job.finished → completed；
// 10. defer 分支：主管资料不足必须持久化 needs_user，原包不再是待验收；Owner 可
//     supplement，记者新包重新进入 research_review，再次 defer 后重启仍保持 needs_user；
// 11. supplement/expand/stop 分支：supplement→needs_more_research→retry（同提纲版本、
//     round+1）；needs_user 终态可 retry；expand→新提纲版本回 Owner 审批；
//     stop→abandoned；direction supplement→保持 direction_pending_approval 等待修订；
// 12. 重启持久化：新连接读回完整调查档案（状态、版本、包、工单引用）。

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { createContentProjectWithVersion, getContentProject, saveCoreVersion } from '../src/main/content.ts';
import { upsertSource } from '../src/main/sources.ts';
import {
  readProjectInvestigation,
  initializeProjectInvestigation,
  saveInvestigationOutline,
  decideInvestigationOutline,
  reviewInvestigationResearch,
  decideInvestigationDirection,
  startInvestigationWriter,
  retryInvestigationReporter,
  recordInvestigationReporterTerminal,
  recordInvestigationWriterTerminal,
  buildInvestigationReporterRequest
} from '../src/main/project-investigation.ts';
import { buildResearchEvidencePack } from '../src/main/research-task-state.ts';
import { RESEARCH_DEFAULT_BUDGET } from '../src/main/research-job-runner.ts';
import { enqueueResearchSuccessor, researchSuccessorDedupeKey } from '../src/main/research-successor.ts';
import { buildJobContextRefs } from '../src/main/job-object-boundary.ts';
import { getAgentTask } from '../src/main/agent-tasks.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { JobSpawner } from '../src/main/job-spawner.ts';
import * as investigationShared from '../src/shared/project-investigation.ts';
import { investigationGapId, investigationParentId } from '../src/shared/project-investigation.ts';

const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

const expectOk = (result, label) => {
  if (!result || result.ok !== true) {
    throw new Error(`${label} 应成功：${JSON.stringify(result)}`);
  }
  return result.data;
};

const expectRejected = (result, label) => {
  if (!result || result.ok !== false) {
    throw new Error(`${label} 应被拒绝：${JSON.stringify(result)}`);
  }
  return result;
};

/** 生产域函数守卫类错误（revision/state）收口为 CommandResult 失败（ok:false + 稳定 error.code）。 */
const expectRejectedCode = (result, code, label) => {
  if (!result || result.ok !== false || result.error?.code !== code) {
    throw new Error(`${label} 应以 ${code} 拒绝：${JSON.stringify(result)}`);
  }
  return result;
};

const outlineA = Object.freeze({
  scope: '调查对象：E2E 平台机制',
  exclusions: ['不调查发布环节'],
  known: ['已知事实一'],
  hypotheses: ['假设一'],
  questions: ['问题一：该机制由谁主导？', '问题二：成本结构如何？'],
  dimensions: ['背景', '机制'],
  materialRequirements: ['一手文件'],
  truthRisks: ['口径歧义'],
  disconfirmingConditions: ['发现反向证据即收窄'],
  completionCriteria: ['问题一、问题二均有来源支撑']
});

const outlineB = Object.freeze({
  ...outlineA,
  scope: '调查对象：E2E 平台机制（扩展版）',
  questions: ['问题一：该机制由谁主导？', '问题二：成本结构如何？', '问题三：历史沿革？']
});

const outlineC = Object.freeze({
  ...outlineB,
  hypotheses: ['假设一（修订）', '假设二']
});

const directionA = Object.freeze({
  keyFacts: ['事实一：来源A 确认机制存在'],
  upheld: ['原角度核心判断成立'],
  changed: ['成本口径需收窄'],
  discoveries: ['新发现：第三方参与者'],
  unknowns: ['未知：历史沿革待核'],
  recommendation: 'continue',
  coreQuestion: '核心问题：机制如何影响创作者',
  audienceValue: '受众价值：可执行判断',
  scope: '文章范围：仅机制现状',
  constraints: ['不写历史沿革', '不承诺收益']
});


const buildPack = (jobId, round, sourceIds, terminalReason = 'claims_resolved') =>
  buildResearchEvidencePack({
    jobId,
    round,
    claims: sourceIds.map((sourceId, index) => ({
      id: `claim-${round}-${index}`,
      key: `q${index + 1}`,
      status: 'supported',
      verdictReason: null,
      evidenceSourceIds: [sourceId],
      needsTimeExcerpt: false
    })),
    sourceIds: [...sourceIds],
    validSourceCount: sourceIds.length,
    candidateCount: sourceIds.length + 2,
    timeSpentMinutes: 3,
    terminalReason,
    unresolvedRequiredClaims: []
  });

const countRows = (db, sql, ...params) => Number(db.prepare(sql).get(...params).c);

const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-5290-investigation-'));
let db = null;
let runtime = null;
try {
  const dbPath = path.join(directory, 'wmb.db');
  db = migrateDatabase(dbPath);
  const now = new Date().toISOString();
  db.prepare("INSERT OR REPLACE INTO app_meta(key, value, created_at, updated_at, revision) VALUES(?, ?, ?, ?, 1)")
    .run('workspace_id', 'ws-wmb-5290', now, now);

  // 共享模块合同：渲染层 API 名（window.wmb.investigation*）与 IPC 通道映射唯一真源。
  const ipcConstants = investigationShared.INVESTIGATION_IPC;
  expect(ipcConstants && typeof ipcConstants === 'object', 'src/shared/project-investigation.ts 应导出 INVESTIGATION_IPC 常量');
  const ipcValues = Object.values(ipcConstants);
  expect(ipcValues.length === 9, `INVESTIGATION_IPC 应覆盖 9 个渲染层 API: ${ipcValues.length}`);
  expect(new Set(ipcValues).size === ipcValues.length, 'investigation IPC 通道不得重复');
  expect(ipcValues.every((value) => typeof value === 'string' && value.startsWith('investigation:') && value.length > 10),
    'investigation IPC 通道格式异常');
  expect(ipcConstants.get === 'investigation:get' && ipcConstants.startWriter === 'investigation:start-writer',
    'INVESTIGATION_IPC 必须与渲染层 API 名一一对应');

  const sourceA = upsertSource(db, { originalUrl: 'https://example.com/a', title: '调查来源A', summary: '来源A专属摘要-5290' });
  const sourceB = upsertSource(db, { originalUrl: 'https://example.com/b', title: '调查来源B', summary: '来源B专属摘要-5290' });
  const projectA = createContentProjectWithVersion(db, { title: '调查项目A', body: '初稿正文', sourceIds: [sourceA.id] }).id;
  const projectB = createContentProjectWithVersion(db, { title: '调查项目B', body: 'B 正文', sourceIds: [sourceA.id] }).id;
  const projectC = createContentProjectWithVersion(db, { title: '调查项目C', body: 'C 正文', sourceIds: [] }).id;
  const projectD = createContentProjectWithVersion(db, { title: '调查项目D', body: 'D 正文', sourceIds: [] }).id;
  const projectE = createContentProjectWithVersion(db, { title: '调查项目E（写手门）', body: 'E 正文', sourceIds: [] }).id;
  const projectF = createContentProjectWithVersion(db, { title: '遗留项目F（无调查）', body: 'F 正文', sourceIds: [] }).id;
  const projectG = createContentProjectWithVersion(db, { title: '调查项目G（方向补查）', body: 'G 正文', sourceIds: [] }).id;
  const projectH = createContentProjectWithVersion(db, { title: '调查项目H（验收暂缓）', body: 'H 正文', sourceIds: [] }).id;

  const read = (projectId) => {
    const value = readProjectInvestigation(db, projectId);
    expect(value, `readProjectInvestigation(${projectId}) 应有调查`);
    return value;
  };
  const nextRevision = (projectId) => read(projectId).revision;

  // ---------- 项目 A：完整主链（驳回重开、版本不可变、两次审批、写手显式启动、重启读回） ----------
  // 未调查项目：read 模型与项目详情均为 null（遗留项目语义）。
  expect(readProjectInvestigation(db, projectA) === null, '未初始化前 readProjectInvestigation 应为 null');
  expect(getContentProject(db, projectA).investigation === null, '未初始化前 ContentProjectDetail.investigation 应为 null');

  const initializedA = expectOk(initializeProjectInvestigation(db, projectA), 'A 初始化');
  expect(initializedA.status === 'outline_pending_approval' && initializedA.revision === 1,
    `A 初始状态: ${JSON.stringify(initializedA)}`);
  expect(read(projectA).outline === null && read(projectA).outlineVersion === null, 'A 初始化后不应有提纲');
  expect(getContentProject(db, projectA).investigation.status === 'outline_pending_approval', '项目详情应投影同一调查');
  // 一个项目最多一个当前调查：重复初始化不得产生第二行。
  try { initializeProjectInvestigation(db, projectA); } catch { /* 已存在时抛错同样可接受 */ }
  expect(countRows(db, 'SELECT COUNT(*) AS c FROM project_investigations WHERE project_id = ?', projectA) === 1,
    '重复初始化不得产生第二行调查');

  // 提纲保存 + 版本化不可变 + revision 冲突拒绝。
  const savedA1 = expectOk(saveInvestigationOutline(db, { projectId: projectA, expectedRevision: nextRevision(projectA), outline: outlineA }), 'A 保存提纲 v1');
  expect(savedA1.outlineVersion === 1 && savedA1.outlineStatus === 'draft' && savedA1.outline.scope === outlineA.scope,
    `A 提纲 v1: ${JSON.stringify(savedA1)}`);
  expectRejectedCode(saveInvestigationOutline(db, { projectId: projectA, expectedRevision: 1, outline: outlineA }), 'REVISION_CONFLICT', 'A 过期 revision 保存提纲');
  const savedA2 = expectOk(saveInvestigationOutline(db, { projectId: projectA, expectedRevision: nextRevision(projectA), outline: outlineB }), 'A 保存提纲 v2');
  expect(savedA2.outlineVersion === 2, `A 提纲 v2: ${JSON.stringify(savedA2)}`);
  const storedV1 = JSON.parse(db.prepare('SELECT outline_json AS o FROM investigation_outline_versions WHERE project_id = ? AND version = 1').get(projectA).o);
  expect(JSON.stringify(storedV1) === JSON.stringify(outlineA), '提纲 v1 行必须不可变保留');

  // 第一次审批：reject → outline_rejected；新提纲版本 → 重新待批。
  const rejectedA = expectOk(decideInvestigationOutline(db, {
    projectId: projectA, expectedRevision: nextRevision(projectA), decision: 'reject', reporterJobId: null
  }), 'A 驳回提纲');
  expect(rejectedA.status === 'outline_rejected' && rejectedA.outlineStatus === 'rejected', `A 驳回状态: ${JSON.stringify(rejectedA)}`);
  const savedA3 = expectOk(saveInvestigationOutline(db, { projectId: projectA, expectedRevision: nextRevision(projectA), outline: outlineC }), 'A 驳回后新提纲 v3');
  expect(savedA3.status === 'outline_pending_approval' && savedA3.outlineVersion === 3, `A 驳回后重新待批: ${JSON.stringify(savedA3)}`);
  // 审批门：approve 必须携带 reporterJobId；过期 revision 拒绝。
  expectRejected(decideInvestigationOutline(db, {
    projectId: projectA, expectedRevision: nextRevision(projectA), decision: 'approve', reporterJobId: null
  }), 'A approve 缺少 reporterJobId');
  expectRejectedCode(decideInvestigationOutline(db, {
    projectId: projectA, expectedRevision: 1, decision: 'approve', reporterJobId: 'job-a-rep-1'
  }), 'REVISION_CONFLICT', 'A approve 过期 revision');

  // 第一次批准：进入 researching，记录精确项目 + 提纲版本 + 记者工单引用。
  const approvedA = expectOk(decideInvestigationOutline(db, {
    projectId: projectA, expectedRevision: nextRevision(projectA), decision: 'approve', reporterJobId: 'job-a-rep-1'
  }), 'A 批准提纲');
  expect(approvedA.status === 'researching' && approvedA.outlineStatus === 'approved', `A 批准后状态: ${JSON.stringify(approvedA)}`);
  expect(approvedA.reporter?.jobId === 'job-a-rep-1' && approvedA.reporter?.outlineVersion === 3 && approvedA.reporter?.round === 1,
    `A 记者引用: ${JSON.stringify(approvedA.reporter)}`);

  // 记者工单输入：精确项目 + 精确提纲版本 + 问题派生 claims + desk 合成父引用 + 默认预算。
  const reporterRequestA = buildInvestigationReporterRequest(db, projectA, 1);
  expect(reporterRequestA.outlineVersion === 3, `A 记者工单提纲版本: ${JSON.stringify(reporterRequestA)}`);
  const requestA = reporterRequestA.request;
  expect(requestA.roleId === 'reporter' && requestA.projectId === projectA, `A 记者工单角色/项目: ${JSON.stringify(requestA)}`);
  const gapA = requestA.research;
  expect(gapA.parentRoleId === 'desk', `A 记者父角色: ${JSON.stringify(gapA)}`);
  expect(gapA.parentJobId === investigationParentId(projectA) && gapA.parentTaskId === investigationParentId(projectA),
    `A 记者父工单/父任务应为合成稳定 investigation 引用: ${JSON.stringify(gapA)}`);
  expect(gapA.gapId === investigationGapId(projectA, 3, 1), `A 记者 gapId 应稳定派生自项目+提纲版本+轮次: ${gapA.gapId}`);
  expect(gapA.requiredClaims.length === outlineC.questions.length, 'A requiredClaims 必须覆盖已批准提纲全部问题');
  gapA.requiredClaims.forEach((claim, index) => {
    expect(claim.key === `q${index + 1}` && claim.text === outlineC.questions[index] && claim.type === 'fact',
      `A requiredClaims[${index}] 必须派生自已批准提纲问题: ${JSON.stringify(claim)}`);
  });
  expect(JSON.stringify(gapA.budget) === JSON.stringify(RESEARCH_DEFAULT_BUDGET), 'A 记者预算应为默认研究预算');
  expect(Array.isArray(gapA.channels) && gapA.channels.length > 0, 'A 记者渠道不得为空');

  // 终态：EvidencePack 精确保留 + 来源关联 + 无 research_successor + 不复制来源正文。
  const packA1 = buildPack('job-a-rep-1', 1, [sourceB.id]);
  const terminalA = expectOk(recordInvestigationReporterTerminal(db, {
    projectId: projectA, jobId: 'job-a-rep-1', type: 'job.finished', pack: packA1
  }), 'A 记者终态');
  expect(terminalA.status === 'research_review', `A 终态状态: ${JSON.stringify(terminalA)}`);
  expect(JSON.stringify(terminalA.package?.pack) === JSON.stringify(packA1), 'A 资料包必须精确保留 EvidencePack');
  expect(JSON.stringify(terminalA.package?.sourceIds) === JSON.stringify([sourceB.id]), `A 包来源: ${JSON.stringify(terminalA.package)}`);
  expect(terminalA.package?.review === null, `A 验收前 review 应为 null: ${JSON.stringify(terminalA.package?.review)}`);
  expect(terminalA.reporter?.finishedAt != null && typeof terminalA.reporter?.status === 'string' && terminalA.reporter?.status.length > 0,
    `A 记者终态时间/状态: ${JSON.stringify(terminalA.reporter)}`);
  expect(countRows(db, 'SELECT COUNT(*) AS c FROM content_project_sources WHERE project_id = ? AND source_id = ?', projectA, sourceB.id) === 1,
    'A 终态来源必须关联进 content_project_sources');
  const packJson = JSON.stringify({ pack: terminalA.package.pack, sourceIds: terminalA.package.sourceIds });
  expect(!packJson.includes('来源A专属摘要-5290') && !packJson.includes('来源B专属摘要-5290'), 'A 资料包不得复制来源正文');
  expect(countRows(db, "SELECT COUNT(*) AS c FROM jobs WHERE kind = 'research_successor'") === 0, 'A 记者终态不得产生 research_successor');

  // 调查资料包验收前不可启动写手；验收通过后方向直接冻结并进入 ready_to_write。
  expectRejectedCode(startInvestigationWriter(db, {
    projectId: projectA, expectedRevision: nextRevision(projectA), writerJobId: 'job-w-early'
  }), 'INVALID_STATE', 'A research_review 验收前不得启动写手');
  expectRejected(reviewInvestigationResearch(db, {
    projectId: projectA, expectedRevision: nextRevision(projectA), decision: 'accept'
  }), 'A accept 缺少方向');
  const acceptedA = expectOk(reviewInvestigationResearch(db, {
    projectId: projectA, expectedRevision: nextRevision(projectA), decision: 'accept', direction: directionA
  }), 'A 验收并冻结方向');
  expect(acceptedA.status === 'ready_to_write', `A 验收后状态: ${JSON.stringify(acceptedA)}`);
  expect(acceptedA.directionVersion === 1 && JSON.stringify(acceptedA.direction) === JSON.stringify(directionA) && acceptedA.directionStatus === 'approved',
    `A 冻结方向 v1: ${JSON.stringify(acceptedA)}`);
  expect(acceptedA.package?.review?.decision === 'accept' && acceptedA.package?.review?.decidedAt != null,
    `A 验收记录: ${JSON.stringify(acceptedA.package?.review)}`);
  const storedDirV1 = JSON.parse(db.prepare('SELECT direction_json AS d FROM investigation_direction_versions WHERE project_id = ? AND version = 1').get(projectA).d);
  expect(JSON.stringify(storedDirV1) === JSON.stringify(directionA), '方向 v1 行必须不可变保留');
  expectRejectedCode(decideInvestigationDirection(db, { projectId: projectA, expectedRevision: nextRevision(projectA), decision: 'approve' }), 'INVALID_STATE', 'A 不再存在重复方向审批');

  // 写手完成必须带 exact task 的正文版本成功回执；缺失时 fail-closed 回可写，不伪装完成。
  const writingA = expectOk(startInvestigationWriter(db, {
    projectId: projectA, expectedRevision: nextRevision(projectA), writerJobId: 'job-a-w-1'
  }), 'A 启动写手');
  expect(writingA.status === 'writing' && writingA.writer?.jobId === 'job-a-w-1', `A 写作状态: ${JSON.stringify(writingA)}`);
  expectRejectedCode(startInvestigationWriter(db, {
    projectId: projectA, expectedRevision: nextRevision(projectA), writerJobId: 'job-a-w-2'
  }), 'INVALID_STATE', 'A writing 中重复启动写手');
  const missingReadback = expectOk(recordInvestigationWriterTerminal(db, {
    projectId: projectA, jobId: 'job-a-w-1', type: 'job.finished'
  }), 'A 缺回执写手终态');
  expect(missingReadback.status === 'ready_to_write' && missingReadback.writer?.status === 'failed', `A 缺回执必须回可写: ${JSON.stringify(missingReadback)}`);

  const writingRetry = expectOk(startInvestigationWriter(db, {
    projectId: projectA, expectedRevision: nextRevision(projectA), writerJobId: 'job-a-w-2'
  }), 'A 重派写手');
  const writerTaskId = 'task-a-w-2';
  const writerNow = new Date().toISOString();
  db.prepare(`INSERT INTO agent_tasks (id, intent, business_date, status, phase, pi_session_id, context_refs_json, result_refs_json,
    progress_json, checkpoint_json, events_json, error_code, error_message, created_at, updated_at, finished_at)
    VALUES (?, 'studio_draft', '2026-08-16', 'succeeded', 'done', NULL, ?, '{}', '{}', '{}', '[]', NULL, NULL, ?, ?, ?)`)
    .run(writerTaskId, JSON.stringify({ jobId: writingRetry.writer.jobId, projectId: projectA }), writerNow, writerNow, writerNow);
  const projectRevision = db.prepare('SELECT revision FROM content_projects WHERE id=?').get(projectA).revision;
  const savedVersion = expectOk(saveCoreVersion(db, { projectId: projectA, body: 'A 写手真实交付正文', expectedRevision: projectRevision, author: 'ai' }), 'A 保存正文版本');
  db.prepare(`INSERT INTO command_receipts (id, workspace_id, runtime_epoch, request_id, command, input_hash, actor_type, actor_id, task_id, envelope_json, receipt_json, status, result_json, readback_json, side_effect_state, created_at)
    VALUES ('receipt-a-w-2', 'ws-5290', 'epoch-5290', 'job-a-w-2:content', 'content.save_version', 'hash-a-w-2', 'external_agent', 'writer', ?, '{}', ?, 'ok', ?, ?, 'committed', ?)`)
    .run(writerTaskId, JSON.stringify({ data: { id: savedVersion.id } }), JSON.stringify({ id: savedVersion.id }), JSON.stringify({ id: savedVersion.id }), writerNow);
  const completedA = expectOk(recordInvestigationWriterTerminal(db, {
    projectId: projectA, jobId: 'job-a-w-2', type: 'job.finished'
  }), 'A 写手终态');
  expect(completedA.status === 'completed', `A 完成状态: ${JSON.stringify(completedA)}`);
  expect(getContentProject(db, projectA)?.status === 'review', 'A 写手真实交付后项目必须进入待审');

  // 无调查项目不得经调查协议启动写手（遗留项目放行仅限通用 writer 派工，见 JobSpawner 门测试）。
  expectRejectedCode(startInvestigationWriter(db, { projectId: projectB, expectedRevision: 1, writerJobId: 'job-w-bad' }),
    'INVALID_STATE', 'B 无调查时经调查协议启动写手应失败');

  // 历史事件随每次成功变更递增，末条事件为写手终态。
  const historyA = read(projectA).history;
  expect(Array.isArray(historyA) && historyA.length >= 12, `A 历史应随变更记录: ${historyA.length}`);
  expect(historyA[historyA.length - 1]?.kind === 'writer_terminal', `A 末条历史应为写手终态: ${JSON.stringify(historyA[historyA.length - 1])}`);
  const finalRevisionA = read(projectA).revision;

  // ---------- 项目 B：补查 + 重试（同提纲版本、round+1）+ needs_user 终态 ----------
  expectOk(initializeProjectInvestigation(db, projectB), 'B 初始化');
  expectOk(saveInvestigationOutline(db, { projectId: projectB, expectedRevision: nextRevision(projectB), outline: outlineA }), 'B 保存提纲');
  expectOk(decideInvestigationOutline(db, {
    projectId: projectB, expectedRevision: nextRevision(projectB), decision: 'approve', reporterJobId: 'job-b-rep-1'
  }), 'B 批准提纲');
  const packB1 = buildPack('job-b-rep-1', 1, [sourceA.id]);
  expectOk(recordInvestigationReporterTerminal(db, {
    projectId: projectB, jobId: 'job-b-rep-1', type: 'job.partial', pack: packB1
  }), 'B 记者 partial 终态');
  expect(read(projectB).status === 'research_review', `B partial 终态应 research_review: ${read(projectB).status}`);
  // 补查：同一提纲生成下一轮 reporterJobId；该工单由编排层直接派出，不再重复 retry。
  const supplementedB = expectOk(reviewInvestigationResearch(db, {
    projectId: projectB, expectedRevision: nextRevision(projectB), decision: 'supplement', reporterJobId: 'job-b-rep-2'
  }), 'B 补查');
  expect(supplementedB.status === 'needs_more_research' && supplementedB.reporter?.jobId === 'job-b-rep-2' && supplementedB.reporter?.round === 2,
    `B 补查状态: ${JSON.stringify(supplementedB.reporter)}`);
  const packB2 = buildPack('job-b-rep-2', 2, [sourceA.id, sourceB.id]);
  expectOk(recordInvestigationReporterTerminal(db, {
    projectId: projectB, jobId: 'job-b-rep-2', type: 'job.finished', pack: packB2
  }), 'B 第二轮终态');
  // needs_user 终态分支（无包；失败类终态不要求交付物）。
  expectOk(recordInvestigationReporterTerminal(db, {
    projectId: projectB, jobId: 'job-b-rep-2', type: 'job.needs_user'
  }), 'B needs_user 终态');
  expect(read(projectB).status === 'needs_user', `B needs_user 状态: ${read(projectB).status}`);
  expectOk(retryInvestigationReporter(db, {
    projectId: projectB, expectedRevision: nextRevision(projectB), reporterJobId: 'job-b-rep-3'
  }), 'B needs_user 后重试');
  expect(read(projectB).status === 'researching' && read(projectB).reporter?.round === 3, `B 第三轮: ${JSON.stringify(read(projectB).reporter)}`);
  const packB3 = buildPack('job-b-rep-3', 3, [sourceA.id, sourceB.id]);
  expectOk(recordInvestigationReporterTerminal(db, {
    projectId: projectB, jobId: 'job-b-rep-3', type: 'job.finished', pack: packB3
  }), 'B 第三轮终态');
  const acceptedB = expectOk(reviewInvestigationResearch(db, {
    projectId: projectB, expectedRevision: nextRevision(projectB), decision: 'accept', direction: directionA
  }), 'B 验收通过');
  expect(acceptedB.status === 'ready_to_write' && acceptedB.directionStatus === 'approved', `B 验收后应直接就绪: ${acceptedB.status}`);

  // ---------- 项目 C：expand 分支 → 新提纲版本回 Owner 审批 ----------
  expectOk(initializeProjectInvestigation(db, projectC), 'C 初始化');
  expectOk(saveInvestigationOutline(db, { projectId: projectC, expectedRevision: nextRevision(projectC), outline: outlineA }), 'C 保存提纲');
  expectOk(decideInvestigationOutline(db, {
    projectId: projectC, expectedRevision: nextRevision(projectC), decision: 'approve', reporterJobId: 'job-c-rep-1'
  }), 'C 批准提纲');
  const packC1 = buildPack('job-c-rep-1', 1, [sourceA.id]);
  expectOk(recordInvestigationReporterTerminal(db, {
    projectId: projectC, jobId: 'job-c-rep-1', type: 'job.finished', pack: packC1
  }), 'C 记者终态');
  const expandedC = expectOk(reviewInvestigationResearch(db, { projectId: projectC, expectedRevision: nextRevision(projectC), decision: 'expand' }), 'C 扩展范围');
  expect(expandedC.status === 'outline_pending_approval', `C 扩展后应回 Owner 审批: ${expandedC.status}`);
  // 扩展后主管保存扩展版提纲（新版本），重新呈报 Owner 审批。
  const expandedOutlineC = expectOk(saveInvestigationOutline(db, {
    projectId: projectC, expectedRevision: nextRevision(projectC), outline: outlineB
  }), 'C 保存扩展版提纲');
  expect(expandedOutlineC.status === 'outline_pending_approval' && expandedOutlineC.outlineVersion === 2 && expandedOutlineC.outlineStatus === 'draft',
    `C 扩展应产生新提纲版本并回到待批: ${JSON.stringify(expandedOutlineC)}`);

  // ---------- 项目 D：stop 分支 → abandoned ----------
  expectOk(initializeProjectInvestigation(db, projectD), 'D 初始化');
  expectOk(saveInvestigationOutline(db, { projectId: projectD, expectedRevision: nextRevision(projectD), outline: outlineA }), 'D 保存提纲');
  expectOk(decideInvestigationOutline(db, {
    projectId: projectD, expectedRevision: nextRevision(projectD), decision: 'approve', reporterJobId: 'job-d-rep-1'
  }), 'D 批准提纲');
  const packD1 = buildPack('job-d-rep-1', 1, []);
  expectOk(recordInvestigationReporterTerminal(db, {
    projectId: projectD, jobId: 'job-d-rep-1', type: 'job.finished', pack: packD1
  }), 'D 记者终态');
  const stoppedD = expectOk(reviewInvestigationResearch(db, { projectId: projectD, expectedRevision: nextRevision(projectD), decision: 'stop' }), 'D 停止调查');
  expect(stoppedD.status === 'abandoned', `D 停止后状态: ${stoppedD.status}`);

  // ---------- 项目 G：正常验收后不再暴露第二次方向审批 ----------
  expectOk(initializeProjectInvestigation(db, projectG), 'G 初始化');
  expectOk(saveInvestigationOutline(db, { projectId: projectG, expectedRevision: nextRevision(projectG), outline: outlineA }), 'G 保存提纲');
  expectOk(decideInvestigationOutline(db, {
    projectId: projectG, expectedRevision: nextRevision(projectG), decision: 'approve', reporterJobId: 'job-g-rep-1'
  }), 'G 批准提纲');
  const packG1 = buildPack('job-g-rep-1', 1, [sourceA.id]);
  expectOk(recordInvestigationReporterTerminal(db, {
    projectId: projectG, jobId: 'job-g-rep-1', type: 'job.finished', pack: packG1
  }), 'G 记者终态');
  const acceptedG = expectOk(reviewInvestigationResearch(db, {
    projectId: projectG, expectedRevision: nextRevision(projectG), decision: 'accept', direction: directionA
  }), 'G 验收通过');
  expect(acceptedG.status === 'ready_to_write' && acceptedG.directionStatus === 'approved', `G 正常链路直接就绪: ${JSON.stringify(acceptedG)}`);
  expectRejectedCode(decideInvestigationDirection(db, {
    projectId: projectG, expectedRevision: nextRevision(projectG), decision: 'supplement'
  }), 'INVALID_STATE', 'G 冻结方向后不再进入重复审批');


  // ---------- 项目 H：资料不足持久化 defer；同包不重派；新包仍可重新验收 ----------
  expectOk(initializeProjectInvestigation(db, projectH), 'H 初始化');
  expectOk(saveInvestigationOutline(db, { projectId: projectH, expectedRevision: nextRevision(projectH), outline: outlineA }), 'H 保存提纲');
  expectOk(decideInvestigationOutline(db, {
    projectId: projectH, expectedRevision: nextRevision(projectH), decision: 'approve', reporterJobId: 'job-h-rep-1'
  }), 'H 批准提纲');
  const packH1 = buildPack('job-h-rep-1', 1, [sourceA.id], 'candidates_exhausted');
  expectOk(recordInvestigationReporterTerminal(db, {
    projectId: projectH, jobId: 'job-h-rep-1', type: 'job.partial', pack: packH1
  }), 'H 首轮资料包');
  const deferredH1 = expectOk(reviewInvestigationResearch(db, {
    projectId: projectH,
    expectedRevision: nextRevision(projectH),
    decision: 'defer',
    summary: '有效来源不足，等待 Owner 选择补查、扩展范围或停止。'
  }), 'H 主管暂缓验收');
  expect(deferredH1.status === 'needs_user' && deferredH1.package?.review?.decision === 'defer',
    `H 暂缓后必须持久化 needs_user/review: ${JSON.stringify(deferredH1)}`);
  expect(countRows(db, "SELECT COUNT(*) AS c FROM project_investigations WHERE project_id = ? AND status = 'research_review'", projectH) === 0,
    'H 同一资料包暂缓后不得继续被恢复扫描识别为待主管验收');
  expectRejectedCode(reviewInvestigationResearch(db, {
    projectId: projectH, expectedRevision: nextRevision(projectH), decision: 'defer', summary: '重复验收'
  }), 'INVALID_STATE', 'H 同一资料包不得重复 defer');

  const supplementedH = expectOk(reviewInvestigationResearch(db, {
    projectId: projectH,
    expectedRevision: nextRevision(projectH),
    decision: 'supplement',
    reporterJobId: 'job-h-rep-2'
  }), 'H Owner 选择补查');
  expect(supplementedH.status === 'needs_more_research' && supplementedH.reporter?.round === 2,
    `H 补查后应进入新记者轮次: ${JSON.stringify(supplementedH)}`);
  const packH2 = buildPack('job-h-rep-2', 2, [sourceA.id, sourceB.id]);
  const receivedH2 = expectOk(recordInvestigationReporterTerminal(db, {
    projectId: projectH, jobId: 'job-h-rep-2', type: 'job.finished', pack: packH2
  }), 'H 新资料包');
  expect(receivedH2.status === 'research_review' && receivedH2.package?.pack.round === 2 && receivedH2.package?.review === null,
    `H 新资料包必须重新进入一次主管验收: ${JSON.stringify(receivedH2)}`);
  const deferredH2 = expectOk(reviewInvestigationResearch(db, {
    projectId: projectH, expectedRevision: nextRevision(projectH), decision: 'defer', summary: '新资料包仍需 Owner 决策。'
  }), 'H 新资料包暂缓');
  const finalRevisionH = deferredH2.revision;
  expect(deferredH2.status === 'needs_user' && deferredH2.package?.pack.round === 2,
    `H 新包暂缓后状态异常: ${JSON.stringify(deferredH2)}`);
  // ---------- 项目 E/F/B/A：JobSpawner 服务端写手门 ----------
  // E：调查存在但未就绪（outline_pending_approval）→ 同步抛 JOB_INVESTIGATION_NOT_READY。
  expectOk(initializeProjectInvestigation(db, projectE), 'E 初始化');
  expectOk(saveInvestigationOutline(db, { projectId: projectE, expectedRevision: nextRevision(projectE), outline: outlineA }), 'E 保存提纲');
  // ---------- research_successor 抑制：desk 父不续派；非 desk 父照常续派（对照） ----------
  const successorTaskId = `task-succ-${randomUUID()}`;
  const currentRoundB = readProjectInvestigation(db, projectB)?.reporter?.round ?? 1;
  const deskRequest = buildInvestigationReporterRequest(db, projectB, currentRoundB).request;
  expect(deskRequest.research?.parentRoleId === 'desk', 'desk 记者请求应带 desk 父角色');
  const deskRefs = buildJobContextRefs({
    jobId: 'job-succ-desk',
    request: deskRequest,
    boundary: { businessDate: '2026-08-16', projectId: projectB, sourceIds: [], feedIds: [], scope: null }
  });
  db.prepare(`INSERT INTO agent_tasks (id, intent, business_date, status, phase, pi_session_id, context_refs_json, result_refs_json,
    progress_json, checkpoint_json, events_json, error_code, error_message, created_at, updated_at, finished_at)
    VALUES (?, 'research', '2026-08-16', 'succeeded', 'done', NULL, ?, '{}', '{}', '{}', '[]', NULL, NULL, ?, ?, ?)`)
    .run(successorTaskId, JSON.stringify(deskRefs), now, now, now);
  const deskTask = getAgentTask(db, successorTaskId);
  expect(deskTask?.contextRefs?.research?.parentRoleId === 'desk' && deskTask.contextRefs.projectId === projectB,
    'desk 任务 refs 应可重建且绑定项目');
  const deskResult = enqueueResearchSuccessor(db, { researchTaskId: successorTaskId });
  expect(deskResult.enqueued === false && deskResult.reason === 'investigation_parent',
    `desk 父 research_successor 必须被抑制: ${JSON.stringify(deskResult)}`);

  const controlTaskId = `task-succ-control-${randomUUID()}`;
  const controlGap = {
    gapId: 'gap-control',
    parentJobId: 'job-parent-control',
    parentTaskId: 'task-parent-control',
    parentRoleId: 'writer',
    requiredClaims: [{ key: 'q1', text: '控制声明', type: 'fact' }],
    budget: { ...RESEARCH_DEFAULT_BUDGET },
    channels: ['web']
  };
  const controlRefs = buildJobContextRefs({
    jobId: 'job-control',
    request: { roleId: 'reporter', brief: '控制续派任务', businessDate: '2026-08-16', projectId: projectF, research: controlGap },
    boundary: { businessDate: '2026-08-16', projectId: projectF, sourceIds: [], feedIds: [], scope: null }
  });
  const controlPack = buildPack('job-control', 1, [sourceA.id]);
  db.prepare(`INSERT INTO agent_tasks (id, intent, business_date, status, phase, pi_session_id, context_refs_json, result_refs_json,
    progress_json, checkpoint_json, events_json, error_code, error_message, created_at, updated_at, finished_at)
    VALUES (?, 'research', '2026-08-16', 'succeeded', 'done', NULL, ?, ?, '{}', '{}', '[]', NULL, NULL, ?, ?, ?)`)
    .run(controlTaskId, JSON.stringify(controlRefs), JSON.stringify(controlPack), now, now, now);
  const controlResult = enqueueResearchSuccessor(db, { researchTaskId: controlTaskId });
  expect(controlResult.enqueued === true && controlResult.reason === 'inserted',
    `非 desk 父应正常续派: ${JSON.stringify(controlResult)}`);
  db.close();
  db = null;

  runtime = ActiveWorkspaceRuntime.open(directory);
  db = runtime.database;
  const spawner = new JobSpawner(runtime, {
    maxWorkers: 2,
    execute: async () => ({ status: 'succeeded', code: 'OK', message: null, readback: null })
  });
  const expectSpawnRejected = (projectId, label) => {
    let thrown = null;
    try {
      spawner.spawn({ roleId: 'writer', brief: '写手门测试', projectId, businessDate: '2026-08-16' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown && thrown.code === 'JOB_INVESTIGATION_NOT_READY',
      `${label} 应同步拒绝 writer（JOB_INVESTIGATION_NOT_READY）：${thrown?.message ?? '未拒绝'}`);
    expect(!spawner.list().some((job) => job.projectId === projectId), `${label} 拒绝时不得创建工单`);
  };
  expectSpawnRejected(projectE, 'E（outline_pending_approval）');
  expectSpawnRejected(projectA, 'A（completed）');
  expectSpawnRejected(projectC, 'C（扩展后 outline_pending_approval）');
  // F：遗留项目（无调查行）照常放行；B：ready_to_write 放行。
  const legacyWriter = spawner.spawn({ roleId: 'writer', brief: '遗留项目写稿', projectId: projectF, businessDate: '2026-08-16' });
  expect(Boolean(legacyWriter?.id), 'F 遗留项目 writer 应放行');
  const readyWriter = spawner.spawn({ roleId: 'writer', brief: '就绪项目写稿', projectId: projectB, businessDate: '2026-08-16' });
  expect(Boolean(readyWriter?.id), 'B ready_to_write writer 应放行');

  expect(countRows(db, 'SELECT COUNT(*) AS c FROM jobs WHERE kind = ? AND dedupe_key = ?',
    'research_successor', researchSuccessorDedupeKey('job-parent-control')) === 1, '对照续派行应存在');
  expect(countRows(db, "SELECT COUNT(*) AS c FROM jobs WHERE kind = 'research_successor' AND payload_json LIKE '%job-succ-desk%'") === 0,
    'desk 父不得产生任何续派行');

  // ---------- 重启持久化：新连接完整读回 ----------
  db.close();
  db = null;
  await runtime.stop({ drain: false }).catch(() => {});
  runtime = null;
  const reopened = migrateDatabase(dbPath);
  const revivedA = readProjectInvestigation(reopened, projectA);
  expect(revivedA.status === 'completed' && revivedA.revision === finalRevisionA, `重启后 A 状态/版本应完整: ${JSON.stringify(revivedA)}`);
  expect(revivedA.outlineVersion === 3 && JSON.stringify(revivedA.outline) === JSON.stringify(outlineC), '重启后 A 提纲应为 v3');
  const revivedV1 = JSON.parse(reopened.prepare('SELECT outline_json AS o FROM investigation_outline_versions WHERE project_id = ? AND version = 1').get(projectA).o);
  expect(JSON.stringify(revivedV1) === JSON.stringify(outlineA), '重启后 A 提纲 v1 仍不可变');
  expect(revivedA.directionVersion === 1 && JSON.stringify(revivedA.direction) === JSON.stringify(directionA), '重启后 A 冻结方向应为 v1');
  expect(JSON.stringify(revivedA.package?.pack) === JSON.stringify(packA1), '重启后 A 资料包应精确保留');
  expect(JSON.stringify(revivedA.package?.sourceIds) === JSON.stringify([sourceB.id]), '重启后 A 包来源应保留');
  expect(revivedA.reporter?.jobId === 'job-a-rep-1' && revivedA.writer?.jobId === 'job-a-w-2', '重启后 A 工单引用应保留最终成功轮次');
  const revivedB = readProjectInvestigation(reopened, projectB);
  expect(revivedB.status === 'ready_to_write' && revivedB.reporter?.round === 3,
    `重启后 B 应就绪且 round=3: ${revivedB.status}/${revivedB.reporter?.round}`);
  expect(readProjectInvestigation(reopened, projectF) === null, '重启后遗留项目 F 仍无调查');
  const revivedH = readProjectInvestigation(reopened, projectH);
  expect(revivedH.status === 'needs_user' && revivedH.revision === finalRevisionH && revivedH.package?.pack.round === 2
    && revivedH.package?.review?.decision === 'defer',
    `重启后 H 必须保持已验收待 Owner 决策，不得回到 research_review: ${JSON.stringify(revivedH)}`);
  const revivedDetail = getContentProject(reopened, projectA);
  expect(revivedDetail.investigation?.status === 'completed' && revivedDetail.investigation?.revision === revivedA.revision,
    '重启后项目详情应投影同一调查');
  reopened.close();

  console.log(JSON.stringify({
    projectA: { status: revivedA.status, outlineVersion: revivedA.outlineVersion, directionVersion: revivedA.directionVersion, revision: revivedA.revision },
    projectB: { status: revivedB.status, round: revivedB.reporter?.round },
    projectC: { status: 'outline_pending_approval', outlineVersion: 2 },
    projectD: { status: 'abandoned' },
    projectG: { status: 'ready_to_write', directionStatus: 'approved' },
    projectH: { status: revivedH.status, round: revivedH.package?.pack.round, review: revivedH.package?.review?.decision },
    writerGate: { rejected: ['outline_pending_approval', 'completed', 'expanded-outline-pending'], allowed: ['legacy', 'ready_to_write'] },
    successorSuppressed: deskResult.reason,
    successorControl: controlResult.reason,
    ipcConstants
  }));
} finally {
  if (runtime) await runtime.stop({ drain: false }).catch(() => {});
  if (db) { try { db.close(); } catch { /* 已关闭 */ } }
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
