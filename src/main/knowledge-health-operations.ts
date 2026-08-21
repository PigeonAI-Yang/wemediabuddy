// extracted from src/main/knowledge-health.ts (structural split)
import type { DatabaseSync } from 'node:sqlite';
import { applyKnowledgeChangeSet, assertScopeAllowed, getHealthIssue } from './knowledge-flywheel.ts';
import type {
  ApplyChangeSetResult,
  CreatorNature,
  HealthIssueType,
  HealthIssueWrite,
  KnowledgeChangeSetInput,
  KnowledgeChangeSetMeta,
  KnowledgeHealthIssueRecord,
  KnowledgeScope,
  KnowledgeUpdateReceiptRecord,
  RelationWrite,
} from './knowledge-flywheel.ts';
import { broadcastDataChanged } from './data-changed.ts';
import {
  dataGapCutoffIso,
  AUTO_REPAIR_ALLOWLIST,
  EVIDENCE_OBJECT_TABLES,
  KNOWLEDGE_HEALTH_DETECTOR_VERSION,
  KNOWLEDGE_HEALTH_DETECTORS,
  KNOWLEDGE_HEALTH_LINT_CHANNEL_REASON,
  MAX_PAGE_SIZE,
  buildEvidence,
  findIssuesForPlan,
  issueFingerprint,
  lintError,
  nextIssueId,
  normalizeDetectors,
  now,
  objectExists,
  uniqueRefs,
  validateRequestId,
  validateScope,
  validateWorkspace,
} from './knowledge-health-types.ts';
import type {
  BuiltOps,
  HealthLintCounts,
  HealthLintIssuePlan,
  HealthLintObjectRef,
} from './knowledge-health-types.ts';
import {
  brokenEvidencePlan,
  brokenRelationPlan,
  crossReferencePlan,
  dataGapPlan,
  duplicateEntityPlan,
  duplicateKnowledgePlan,
  missingEntityPagePlan,
  missingTopicPagePlan,
  orphanKnowledgePlan,
  staleClaimPlan,
  staleWikiPagePlan,
  unreturnedReviewPlan,
  unsupportedClaimPlan,
  unresolvedContradictionPlan,
  dataGapCondition,
  duplicateEntityPartner,
  duplicateKnowledgePartner,
  entityMissingPageCondition,
  noteStaleCondition,
  noteUnsupportedCondition,
  orphanNoteCondition,
  pageCurrentBrokenRefs,
  relationGhostEndpoints,
  reviewFlowbackExists,
  topicMissingPageCondition,
} from './knowledge-health-detectors.ts';
import type { DetectorContext } from './knowledge-health-detectors.ts';

// ============================================================
// 条件复查（自动解决判定；只读）
// ============================================================

export type OpenIssueRow = Readonly<{
  id: string;
  revision: number;
  issueType: HealthIssueType;
  affectedObjectType: string;
  affectedObjectId: string;
  evidence: Readonly<Record<string, unknown>>;
}>;

export function verdictForIssue(ctx: DetectorContext, issue: OpenIssueRow): 'problem' | 'cleared' {
  const database = ctx.database;
  switch (issue.issueType) {
    case 'broken_reference': {
      if (issue.affectedObjectType === 'knowledge_relation') {
        const row = database.prepare(
          `SELECT id, from_object_type AS fromObjectType, from_object_id AS fromObjectId,
             to_object_type AS toObjectType, to_object_id AS toObjectId
           FROM knowledge_formal_relations WHERE id = ? AND ended_change_set_id IS NULL AND scope = ?`
        ).get(issue.affectedObjectId, ctx.scope) as Record<string, unknown> | undefined;
        if (!row) return 'cleared'; // 已终结
        return relationGhostEndpoints(database, row).length ? 'problem' : 'cleared';
      }
      // WMB-5237 cross-reference：Wiki 页面当前版本仍含不可解析正式引用 → problem；重新编译干净 → cleared
      if (issue.affectedObjectType === 'wiki_page') {
        return pageCurrentBrokenRefs(ctx, issue.affectedObjectId).length ? 'problem' : 'cleared';
      }
      // 证据链接坏引用：Note 版本仍存在任意坏证据 → problem
      const links = database.prepare(
        `SELECT id, evidence_object_type AS evidenceObjectType, evidence_object_id AS evidenceObjectId
         FROM knowledge_evidence_links WHERE knowledge_note_version_id = ?`
      ).all(issue.affectedObjectId) as Array<Record<string, unknown>>;
      for (const link of links) {
        const table = EVIDENCE_OBJECT_TABLES[String(link.evidenceObjectType)];
        if (table && !objectExists(database, table, String(link.evidenceObjectId))) return 'problem';
      }
      return 'cleared';
    }
    case 'unreturned_review': {
      const review = database.prepare('SELECT status FROM reviews WHERE id = ?').get(issue.affectedObjectId) as
        | { status: string }
        | undefined;
      if (!review || review.status !== 'final') return 'cleared';
      return reviewFlowbackExists(database, ctx.workspaceId, issue.affectedObjectId) ? 'cleared' : 'problem';
    }
    case 'unresolved_contradiction': {
      const row = database.prepare(
        `SELECT n.lifecycle AS lifecycle, v.conclusion_status AS conclusionStatus
         FROM knowledge_notes n
         JOIN knowledge_note_versions v ON v.id = n.current_version_id
         WHERE n.id = ? AND n.scope = ?`
      ).get(issue.affectedObjectId, ctx.scope) as Record<string, unknown> | undefined;
      if (!row || String(row.lifecycle) !== 'active' || String(row.conclusionStatus) !== 'disputed') return 'cleared';
      return 'problem';
    }
    case 'stale_wiki_page': {
      const row = database.prepare(
        `SELECT lifecycle, compile_status AS compileStatus FROM knowledge_wiki_pages WHERE id = ? AND scope = ?`
      ).get(issue.affectedObjectId, ctx.scope) as Record<string, unknown> | undefined;
      if (!row || String(row.lifecycle) !== 'active' || String(row.compileStatus) !== 'stale') return 'cleared';
      return 'problem';
    }
    case 'orphan_knowledge':
      return orphanNoteCondition(ctx, issue.affectedObjectId) ? 'problem' : 'cleared';
    case 'missing_wiki_page':
      return (issue.affectedObjectType === 'knowledge_entity'
        ? entityMissingPageCondition(ctx, issue.affectedObjectId)
        : topicMissingPageCondition(ctx, issue.affectedObjectId)) ? 'problem' : 'cleared';
    case 'unsupported_claim':
      return noteUnsupportedCondition(ctx, issue.affectedObjectId) ? 'problem' : 'cleared';
    case 'stale_claim':
      return noteStaleCondition(ctx, issue.affectedObjectId, now()) ? 'problem' : 'cleared';
    case 'duplicate_knowledge':
      return duplicateKnowledgePartner(ctx, issue.affectedObjectId) !== null ? 'problem' : 'cleared';
    case 'duplicate_entity':
      return duplicateEntityPartner(ctx, issue.affectedObjectId) !== null ? 'problem' : 'cleared';
    case 'data_gap':
      return dataGapCondition(ctx, issue.affectedObjectId, dataGapCutoffIso()) ? 'problem' : 'cleared';
    default:
      // 未知类型保守保持 open（不自动裁决）
      return 'problem';
  }
}

export function listOpenIssuesForDetectors(
  database: DatabaseSync,
  ctx: DetectorContext,
  extraWhere: string,
  extraArgs: readonly string[],
  limit: number
): OpenIssueRow[] {
  const issueTypes = ctx.detectors.map((d) => KNOWLEDGE_HEALTH_DETECTORS[d]);
  const placeholders = issueTypes.map(() => '?').join(',');
  const scopeValue: string = ctx.scope;
  const rows = database.prepare(
    `SELECT id, revision, issue_type AS issueType, affected_object_type AS affectedObjectType,
       affected_object_id AS affectedObjectId, evidence_json AS evidenceJson
     FROM knowledge_health_issues
     WHERE status IN ('open','repairing') AND scope = ? AND issue_type IN (${placeholders}) ${extraWhere}
     ORDER BY id LIMIT ?`
  ).all(scopeValue, ...issueTypes, ...extraArgs, limit) as Array<Record<string, unknown>>;
  return rows.map((row) => Object.freeze({
    id: String(row.id), revision: Number(row.revision),
    issueType: String(row.issueType) as HealthIssueType,
    affectedObjectType: String(row.affectedObjectType),
    affectedObjectId: String(row.affectedObjectId),
    evidence: (() => {
      try {
        const parsed = JSON.parse(String((row as Record<string, unknown>).evidenceJson ?? '{}')) as Record<string, unknown>;
        return parsed ?? {};
      } catch {
        return {};
      }
    })()
  }));
}

/** 周期 lint 每步的有界自动解决扫描（按 id cursor 翻页；扫完一轮后清零循环）。 */
export function collectClearSweep(
  database: DatabaseSync,
  ctx: DetectorContext,
  cursor: string,
  limit: number
): { clears: Array<{ issue: OpenIssueRow; note: string }>; nextCursor: string } {
  const issues = listOpenIssuesForDetectors(database, ctx, 'AND id > ?', [cursor], limit);
  const clears: Array<{ issue: OpenIssueRow; note: string }> = [];
  for (const issue of issues) {
    if (verdictForIssue(ctx, issue) !== 'cleared') continue;
    clears.push({ issue, note: `条件已消除：${issue.issueType}（${issue.affectedObjectType}:${issue.affectedObjectId}）不再成立。` });
  }
  const nextCursor = issues.length < limit ? '' : issues[issues.length - 1]!.id;
  return { clears, nextCursor };
}

/** 局部 lint 的自动解决：只复查指定受影响对象上的 open Issue。 */
export function collectClearsForObjects(
  database: DatabaseSync,
  ctx: DetectorContext,
  refs: readonly HealthLintObjectRef[]
): Array<{ issue: OpenIssueRow; note: string }> {
  const ids = [...new Set(refs.map((ref) => ref.objectId))];
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const issues = listOpenIssuesForDetectors(database, ctx, `AND affected_object_id IN (${placeholders})`, ids, MAX_PAGE_SIZE * 4);
  const clears: Array<{ issue: OpenIssueRow; note: string }> = [];
  for (const issue of issues) {
    if (verdictForIssue(ctx, issue) !== 'cleared') continue;
    clears.push({ issue, note: `条件已消除：${issue.issueType}（${issue.affectedObjectType}:${issue.affectedObjectId}）不再成立。` });
  }
  return clears;
}

// ============================================================
// 局部 Lint 检测入口（有界对象）
// ============================================================

function detectBrokenEvidenceForNote(ctx: DetectorContext, noteId: string): HealthLintIssuePlan[] {
  const rows = ctx.database.prepare(
    `SELECT e.id, e.knowledge_note_version_id AS noteVersionId, e.evidence_object_type AS evidenceObjectType,
       e.evidence_object_id AS evidenceObjectId
     FROM knowledge_evidence_links e
     JOIN knowledge_note_versions v ON v.id = e.knowledge_note_version_id
     JOIN knowledge_notes n ON n.id = v.note_id
     WHERE n.id = ? AND n.scope = ?`
  ).all(noteId, ctx.scope) as Array<Record<string, unknown>>;
  const plans: HealthLintIssuePlan[] = [];
  for (const row of rows) {
    const plan = brokenEvidencePlan(ctx, row);
    if (plan) plans.push(plan);
  }
  return plans;
}

function detectBrokenEvidenceForSource(ctx: DetectorContext, sourceId: string): HealthLintIssuePlan[] {
  if (ctx.scope !== 'global') return [];
  const table = EVIDENCE_OBJECT_TABLES.source!;
  if (objectExists(ctx.database, table, sourceId)) return []; // 源仍存在 → 无坏引用
  const rows = ctx.database.prepare(
    `SELECT e.id, e.knowledge_note_version_id AS noteVersionId, e.evidence_object_type AS evidenceObjectType,
       e.evidence_object_id AS evidenceObjectId
     FROM knowledge_evidence_links e
     WHERE e.evidence_object_type = 'source' AND e.evidence_object_id = ?`
  ).all(sourceId) as Array<Record<string, unknown>>;
  const plans: HealthLintIssuePlan[] = [];
  for (const row of rows) {
    const plan = brokenEvidencePlan(ctx, row);
    if (plan) plans.push(plan);
  }
  return plans;
}

/** 对单个受影响对象运行适用检测器（scope 内）。 */
export function detectForObject(ctx: DetectorContext, ref: HealthLintObjectRef): HealthLintIssuePlan[] {
  const plans: HealthLintIssuePlan[] = [];
  switch (ref.objectType) {
    case 'knowledge_relation': {
      if (!ctx.detectors.includes('broken_reference')) return plans;
      const row = ctx.database.prepare(
        `SELECT id, scope, relation_key AS relationKey, from_object_type AS fromObjectType,
           from_object_id AS fromObjectId, to_object_type AS toObjectType, to_object_id AS toObjectId
         FROM knowledge_formal_relations
         WHERE id = ? AND ended_change_set_id IS NULL`
      ).get(ref.objectId) as Record<string, unknown> | undefined;
      const plan = row ? brokenRelationPlan(ctx, row) : null;
      if (plan) plans.push(plan);
      return plans;
    }
    case 'knowledge_note': {
      if (ctx.detectors.includes('unresolved_contradiction')) {
        const plan = unresolvedContradictionPlan(ctx, ref.objectId);
        if (plan) plans.push(plan);
      }
      if (ctx.detectors.includes('broken_reference')) plans.push(...detectBrokenEvidenceForNote(ctx, ref.objectId));
      if (ctx.detectors.includes('unsupported_claim')) {
        const plan = unsupportedClaimPlan(ctx, ref.objectId);
        if (plan) plans.push(plan);
      }
      if (ctx.detectors.includes('stale_claim')) {
        const plan = staleClaimPlan(ctx, ref.objectId, now());
        if (plan) plans.push(plan);
      }
      if (ctx.detectors.includes('orphan_knowledge')) {
        const plan = orphanKnowledgePlan(ctx, ref.objectId);
        if (plan) plans.push(plan);
      }
      if (ctx.detectors.includes('duplicate_knowledge')) {
        const plan = duplicateKnowledgePlan(ctx, ref.objectId);
        if (plan) plans.push(plan);
      }
      return plans;
    }
    case 'wiki_page': {
      if (ctx.detectors.includes('stale_wiki_page')) {
        const plan = staleWikiPagePlan(ctx, ref.objectId);
        if (plan) plans.push(plan);
      }
      if (ctx.detectors.includes('cross_reference')) {
        const plan = crossReferencePlan(ctx, ref.objectId);
        if (plan) plans.push(plan);
      }
      return plans;
    }
    case 'topic': {
      if (ctx.detectors.includes('stale_wiki_page')) {
        const page = ctx.database.prepare(
          `SELECT id FROM knowledge_wiki_pages
           WHERE subject_type = 'topic' AND subject_id = ? AND lifecycle = 'active' AND scope = ? LIMIT 1`
        ).get(ref.objectId, ctx.scope) as { id: string } | undefined;
        const plan = page ? staleWikiPagePlan(ctx, page.id) : null;
        if (plan) plans.push(plan);
      }
      if (ctx.detectors.includes('missing_wiki_page')) {
        const plan = missingTopicPagePlan(ctx, ref.objectId);
        if (plan) plans.push(plan);
      }
      return plans;
    }
    case 'knowledge_entity': {
      if (ctx.detectors.includes('duplicate_entity')) {
        const plan = duplicateEntityPlan(ctx, ref.objectId);
        if (plan) plans.push(plan);
      }
      if (ctx.detectors.includes('missing_wiki_page')) {
        const plan = missingEntityPagePlan(ctx, ref.objectId);
        if (plan) plans.push(plan);
      }
      return plans;
    }
    case 'knowledge_free_note': {
      if (ctx.detectors.includes('data_gap')) {
        const cutoff = dataGapCutoffIso();
        const plan = dataGapPlan(ctx, ref.objectId, cutoff);
        if (plan) plans.push(plan);
      }
      return plans;
    }
    case 'source': {
      if (ctx.detectors.includes('broken_reference')) plans.push(...detectBrokenEvidenceForSource(ctx, ref.objectId));
      return plans;
    }
    case 'review': {
      if (ctx.detectors.includes('unreturned_review')) {
        const review = ctx.database.prepare('SELECT status FROM reviews WHERE id = ?').get(ref.objectId) as
          | { status: string }
          | undefined;
        const plan = review ? unreturnedReviewPlan(ctx, ref.objectId, review.status) : null;
        if (plan) plans.push(plan);
      }
      return plans;
    }
    default:
      return plans;
  }
}

// ============================================================
// 运行装配：计划 → ChangeSet 段（含去重 / 自动修复 / 自动解决）
// ============================================================

export function buildRunOps(
  database: DatabaseSync,
  ctx: DetectorContext,
  plans: readonly HealthLintIssuePlan[],
  clears: ReadonlyArray<{ issue: OpenIssueRow; note: string }>,
  maxIssuesPerRun: number
): BuiltOps {
  const relationOps: RelationWrite[] = [];
  const healthIssueOps: HealthIssueWrite[] = [];
  const touchedIssueIds: string[] = [];
  let issuesCreated = 0;
  let issuesDeduplicated = 0;
  let issuesAutoResolved = 0;
  let repairsApplied = 0;

  for (const plan of plans) {
    const existing = findIssuesForPlan(database, ctx.scope, plan);
    const fingerprint = issueFingerprint(ctx.scope, plan);

    if (plan.autoRepair) {
      if (!AUTO_REPAIR_ALLOWLIST[plan.issueType]) {
        lintError('HEALTH_LINT_REPAIR_NOT_ALLOWED', `issueType=${plan.issueType} 不允许自动修复。`, { issueType: plan.issueType });
      }
      const open = existing.find((e) => e.status === 'open' || e.status === 'repairing');
      const issueId = open ? open.id : nextIssueId(existing.length, fingerprint);
      const beforeRevision = open ? open.revision : 1;
      if (!open) {
        issuesCreated += 1;
        healthIssueOps.push(Object.freeze({
          op: 'create',
          id: issueId,
          scope: ctx.scope,
          issueType: plan.issueType,
          affectedObjectType: plan.affectedObjectType,
          affectedObjectId: plan.affectedObjectId,
          severity: plan.severity,
          evidence: buildEvidence(ctx.scope, plan, ctx.detectors),
          suggestedAction: plan.suggestedAction
        }));
      } else {
        issuesDeduplicated += 1;
      }
      repairsApplied += 1;
      relationOps.push(Object.freeze({ op: 'end', id: plan.autoRepair.relationId, reason: 'lint:broken_reference:auto-repair' }));
      healthIssueOps.push(Object.freeze({
        op: 'update',
        id: issueId,
        beforeRevision,
        status: 'resolved',
        resolutionNote: `确定性修复：${plan.detail} 已自动终止关系。`
      }));
      touchedIssueIds.push(issueId);
      if (issuesCreated + repairsApplied > maxIssuesPerRun) {
        lintError('HEALTH_LINT_SCOPE_EXCEEDED', `本轮 Lint 新建/修复 Issue 超过上限 ${maxIssuesPerRun}，零写。`, { maxIssuesPerRun });
      }
      continue;
    }

    if (existing.some((e) => e.status === 'open' || e.status === 'repairing')) {
      issuesDeduplicated += 1; // 重复扫描不重复 Issue
      continue;
    }
    if (
      existing.some(
        (e) => e.status === 'false_positive' && (e.evidence as Record<string, unknown>).detectorVersion === KNOWLEDGE_HEALTH_DETECTOR_VERSION
      )
    ) {
      issuesDeduplicated += 1; // 同检测器版本的 false_positive 不重复报警
      continue;
    }
    issuesCreated += 1;
    if (issuesCreated > maxIssuesPerRun) {
      lintError('HEALTH_LINT_SCOPE_EXCEEDED', `本轮 Lint 新建 Issue 超过上限 ${maxIssuesPerRun}，零写。`, { maxIssuesPerRun });
    }
    const issueId = nextIssueId(existing.length, fingerprint);
    healthIssueOps.push(Object.freeze({
      op: 'create',
      id: issueId,
      scope: ctx.scope,
      issueType: plan.issueType,
      affectedObjectType: plan.affectedObjectType,
      affectedObjectId: plan.affectedObjectId,
      severity: plan.severity,
      evidence: buildEvidence(ctx.scope, plan, ctx.detectors),
      suggestedAction: plan.suggestedAction
    }));
    touchedIssueIds.push(issueId);
  }

  for (const clear of clears) {
    issuesAutoResolved += 1;
    healthIssueOps.push(Object.freeze({
      op: 'update',
      id: clear.issue.id,
      beforeRevision: clear.issue.revision,
      status: 'resolved',
      resolutionNote: clear.note
    }));
    touchedIssueIds.push(clear.issue.id);
  }

  return Object.freeze({
    relationOps,
    healthIssueOps,
    counts: Object.freeze({ scannedObjects: 0, issuesCreated, issuesDeduplicated, issuesAutoResolved, repairsApplied }),
    touchedIssueIds
  });
}

export function buildLintChangeSetInput(
  built: BuiltOps,
  requestId: string,
  summary: string,
  counts: HealthLintCounts,
  impact: Readonly<Record<string, unknown>>
): KnowledgeChangeSetInput {
  return Object.freeze({
    relations: built.relationOps,
    healthIssues: built.healthIssueOps,
    receipts: [Object.freeze({
      triggerType: 'lint' as const,
      requestId,
      summary,
      counts,
      impact
    })]
  });
}

export function lintMeta(
  workspaceId: string,
  requestId: string,
  reason: string,
  createdBy: CreatorNature
): KnowledgeChangeSetMeta {
  return Object.freeze({
    workspaceId,
    requestId,
    reason,
    triggerSource: 'lint' as const,
    resolutionMode: 'none' as const,
    createdBy
  });
}

/**
 * Lint 自己的原子提交：SAVEPOINT + transaction=false 适用于两种上下文——
 * 顶层（SAVEPOINT 自动开启事务，RELEASE 提交）与既有事务内（嵌套；失败 ROLLBACK TO
 * 只回滚 lint 自己的写，绝不回滚已成功的业务 ChangeSet）。
 */
export function applyLintChangeSet(database: DatabaseSync, meta: KnowledgeChangeSetMeta, input: KnowledgeChangeSetInput): ApplyChangeSetResult {
  database.exec('SAVEPOINT wmb_knowledge_lint');
  try {
    const result = applyKnowledgeChangeSet(database, meta, input, false);
    database.exec('RELEASE wmb_knowledge_lint');
    return result;
  } catch (error) {
    try {
      database.exec('ROLLBACK TO wmb_knowledge_lint');
      database.exec('RELEASE wmb_knowledge_lint');
    } catch {
      // 嵌套回滚失败不掩盖原始错误
    }
    throw error;
  }
}

export function readBackIssues(database: DatabaseSync, ids: readonly string[]): KnowledgeHealthIssueRecord[] {
  const out: KnowledgeHealthIssueRecord[] = [];
  for (const id of ids) {
    const issue = getHealthIssue(database, id);
    if (issue) out.push(issue);
  }
  return out;
}
