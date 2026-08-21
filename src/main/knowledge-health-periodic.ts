// extracted from src/main/knowledge-health.ts (structural split)
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { assertScopeAllowed } from './knowledge-flywheel.ts';
import type { CreatorNature, KnowledgeScope, KnowledgeUpdateReceiptRecord } from './knowledge-flywheel.ts';
import { broadcastDataChanged } from './data-changed.ts';
import {
  CHECKPOINT_META_KEY,
  DEFAULT_PAGE_SIZE,
  KNOWLEDGE_HEALTH_LINT_CHANNEL_REASON,
  MAX_PAGE_SIZE,
  PHASE_ORDER,
  ZERO_COUNTS,
  dataGapCutoffIso,
  lintError,
  normalizeDetectors,
  now,
  validateScope,
  validateWorkspace,
} from './knowledge-health-types.ts';
import type {
  BeginPeriodicLintInput,
  HealthLintCounts,
  HealthLintIssuePlan,
  HealthLintPhase,
  KnowledgeHealthCheckpoint,
  KnowledgeHealthPeriodicStepResult,
} from './knowledge-health-types.ts';
import {
  brokenEvidencePlan,
  brokenRelationPlan,
  crossReferencePlan,
  dataGapPlan,
  duplicateEntityPlan,
  duplicateKnowledgePlan,
  listActiveRelationRows,
  listEvidenceLinkRows,
  missingEntityPagePlan,
  missingTopicPagePlan,
  orphanKnowledgePlan,
  staleClaimPlan,
  staleWikiPagePlan,
  unreturnedReviewPlan,
  unsupportedClaimPlan,
  unresolvedContradictionPlan,
} from './knowledge-health-detectors.ts';
import type { DetectorContext } from './knowledge-health-detectors.ts';
import {
  applyLintChangeSet,
  buildLintChangeSetInput,
  buildRunOps,
  collectClearSweep,
  lintMeta,
  readBackIssues,
} from './knowledge-health-operations.ts';

function readCheckpoint(database: DatabaseSync): KnowledgeHealthCheckpoint | null {
  let row: { value: string } | undefined;
  try {
    row = database.prepare('SELECT value FROM app_meta WHERE key = ?').get(CHECKPOINT_META_KEY) as { value: string } | undefined;
  } catch {
    return null;
  }
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as KnowledgeHealthCheckpoint;
    if (!parsed || parsed.schemaVersion !== 1 || !parsed.runId) return null;
    return Object.freeze(parsed);
  } catch {
    return null;
  }
}

function saveCheckpoint(database: DatabaseSync, checkpoint: KnowledgeHealthCheckpoint): void {
  const value = JSON.stringify(checkpoint);
  const nowIso = now();
  const existing = database.prepare('SELECT revision FROM app_meta WHERE key = ?').get(CHECKPOINT_META_KEY) as
    | { revision: number }
    | undefined;
  if (existing) {
    database.prepare('UPDATE app_meta SET value = ?, updated_at = ?, revision = revision + 1 WHERE key = ?')
      .run(value, nowIso, CHECKPOINT_META_KEY);
  } else {
    database.prepare('INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)')
      .run(CHECKPOINT_META_KEY, value, nowIso, nowIso);
  }
}

export function getPeriodicLintCheckpoint(database: DatabaseSync): KnowledgeHealthCheckpoint | null {
  return readCheckpoint(database);
}

export function beginPeriodicLint(database: DatabaseSync, rawInput: BeginPeriodicLintInput): { checkpoint: KnowledgeHealthCheckpoint; resumed: boolean } {
  const workspaceId = validateWorkspace(rawInput.workspaceId);
  const scope = validateScope(rawInput.scope ?? 'global');
  assertScopeAllowed(database, scope);
  const createdBy: CreatorNature = rawInput.createdBy ?? 'background_agent';
  const detectors = normalizeDetectors(rawInput.detectors);
  const pageSize = Math.min(Math.max(rawInput.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const resume = rawInput.resume !== false;

  const existing = readCheckpoint(database);
  if (existing && resume && existing.status === 'running') {
    if (existing.workspaceId !== workspaceId) {
      lintError('HEALTH_LINT_WORKSPACE_MISMATCH', `周期 Lint checkpoint 属于工作空间 ${existing.workspaceId}，与当前 ${workspaceId} 不一致。`, {
        checkpointWorkspaceId: existing.workspaceId,
        workspaceId
      });
    }
    return { checkpoint: existing, resumed: true };
  }

  const checkpoint: KnowledgeHealthCheckpoint = Object.freeze({
    schemaVersion: 1,
    runId: `lint-${Date.now()}-${randomUUID().slice(0, 8)}`,
    workspaceId,
    scope,
    detectors,
    createdBy,
    status: 'running',
    phase: PHASE_ORDER[0]!,
    cursor: '',
    clearCursor: '',
    step: 0,
    pageSize,
    counts: ZERO_COUNTS,
    startedAt: now(),
    updatedAt: now(),
    completedAt: null
  });
  saveCheckpoint(database, checkpoint);
  return { checkpoint, resumed: false };
}

export function cancelPeriodicLint(database: DatabaseSync): boolean {
  const existing = readCheckpoint(database);
  if (!existing) return false;
  database.prepare('DELETE FROM app_meta WHERE key = ?').run(CHECKPOINT_META_KEY);
  return true;
}

function nextPhase(phase: HealthLintPhase): HealthLintPhase | null {
  const index = PHASE_ORDER.indexOf(phase);
  return index < 0 || index + 1 >= PHASE_ORDER.length ? null : PHASE_ORDER[index + 1]!;
}

function scanPhasePage(
  database: DatabaseSync,
  ctx: DetectorContext,
  cp: KnowledgeHealthCheckpoint
): { scanned: number; plans: HealthLintIssuePlan[]; lastId: string } {
  const limit = cp.pageSize;
  const plans: HealthLintIssuePlan[] = [];
  switch (cp.phase) {
    case 'relations': {
      const rows = listActiveRelationRows(database, ctx.scope, cp.cursor, limit);
      for (const row of rows) {
        const plan = brokenRelationPlan(ctx, row);
        if (plan) plans.push(plan);
      }
      return { scanned: rows.length, plans, lastId: rows.length ? String(rows[rows.length - 1]!.id) : '' };
    }
    case 'evidence_links': {
      const rows = listEvidenceLinkRows(database, ctx.scope, cp.cursor, limit);
      for (const row of rows) {
        const plan = brokenEvidencePlan(ctx, row);
        if (plan) plans.push(plan);
      }
      return { scanned: rows.length, plans, lastId: rows.length ? String(rows[rows.length - 1]!.id) : '' };
    }
    case 'reviews': {
      if (ctx.scope !== 'global') return { scanned: 0, plans, lastId: '' };
      const rows = database.prepare('SELECT id, status FROM reviews WHERE status = ? AND id > ? ORDER BY id LIMIT ?')
        .all('final', cp.cursor, limit) as Array<{ id: string; status: string }>;
      for (const row of rows) {
        const plan = unreturnedReviewPlan(ctx, row.id, row.status);
        if (plan) plans.push(plan);
      }
      return { scanned: rows.length, plans, lastId: rows.length ? String(rows[rows.length - 1]!.id) : '' };
    }
    case 'notes': {
      const rows = database.prepare(
        `SELECT n.id FROM knowledge_notes n
         JOIN knowledge_note_versions v ON v.id = n.current_version_id
         WHERE n.scope = ? AND n.lifecycle = 'active' AND v.conclusion_status = 'disputed' AND n.id > ?
         ORDER BY n.id LIMIT ?`
      ).all(ctx.scope, cp.cursor, limit) as Array<{ id: string }>;
      for (const row of rows) {
        const plan = unresolvedContradictionPlan(ctx, row.id);
        if (plan) plans.push(plan);
      }
      return { scanned: rows.length, plans, lastId: rows.length ? String(rows[rows.length - 1]!.id) : '' };
    }
    case 'wiki_pages': {
      const rows = database.prepare(
        `SELECT id FROM knowledge_wiki_pages
         WHERE scope = ? AND lifecycle = 'active' AND compile_status = 'stale' AND id > ?
         ORDER BY id LIMIT ?`
      ).all(ctx.scope, cp.cursor, limit) as Array<{ id: string }>;
      for (const row of rows) {
        const plan = staleWikiPagePlan(ctx, row.id);
        if (plan) plans.push(plan);
      }
      return { scanned: rows.length, plans, lastId: rows.length ? String(rows[rows.length - 1]!.id) : '' };
    }
    case 'missing_entity_pages': {
      if (!ctx.detectors.includes('missing_wiki_page')) return { scanned: 0, plans, lastId: '' };
      const rows = database.prepare(
        `SELECT e.id FROM knowledge_entities e
         WHERE e.scope = ? AND e.lifecycle = 'active' AND e.id > ?
           AND NOT EXISTS (
             SELECT 1 FROM knowledge_wiki_pages p
             WHERE p.scope = e.scope AND p.subject_type = 'entity' AND p.subject_id = e.id AND p.lifecycle = 'active')
           AND (EXISTS (
                  SELECT 1 FROM knowledge_note_versions v JOIN knowledge_notes n ON n.id = v.note_id
                  WHERE n.scope = e.scope AND v.adopted_entity_ids_json LIKE '%"' || e.id || '"%')
                OR EXISTS (
                  SELECT 1 FROM knowledge_formal_relations r
                  WHERE r.scope = e.scope AND r.ended_change_set_id IS NULL
                    AND r.to_object_type = 'knowledge_entity' AND r.to_object_id = e.id))
         ORDER BY e.id LIMIT ?`
      ).all(ctx.scope, cp.cursor, limit) as Array<{ id: string }>;
      for (const row of rows) {
        const plan = missingEntityPagePlan(ctx, row.id);
        if (plan) plans.push(plan);
      }
      return { scanned: rows.length, plans, lastId: rows.length ? String(rows[rows.length - 1]!.id) : '' };
    }
    case 'missing_topic_pages': {
      if (!ctx.detectors.includes('missing_wiki_page')) return { scanned: 0, plans, lastId: '' };
      const rows = database.prepare(
        `SELECT t.id FROM topics t
         WHERE t.id > ?
           AND NOT EXISTS (
             SELECT 1 FROM knowledge_wiki_pages p
             WHERE p.scope = ? AND p.subject_type = 'topic' AND p.subject_id = t.id AND p.lifecycle = 'active')
           AND (EXISTS (
                  SELECT 1 FROM knowledge_note_versions v JOIN knowledge_notes n ON n.id = v.note_id
                  WHERE n.scope = ? AND v.adopted_topic_ids_json LIKE '%"' || t.id || '"%')
                OR EXISTS (
                  SELECT 1 FROM knowledge_formal_relations r
                  WHERE r.scope = ? AND r.ended_change_set_id IS NULL
                    AND r.to_object_type = 'topic' AND r.to_object_id = t.id))
         ORDER BY t.id LIMIT ?`
      ).all(cp.cursor, ctx.scope, ctx.scope, ctx.scope, limit) as Array<{ id: string }>;
      for (const row of rows) {
        const plan = missingTopicPagePlan(ctx, row.id);
        if (plan) plans.push(plan);
      }
      return { scanned: rows.length, plans, lastId: rows.length ? String(rows[rows.length - 1]!.id) : '' };
    }
    case 'orphan_notes': {
      if (!ctx.detectors.includes('orphan_knowledge')) return { scanned: 0, plans, lastId: '' };
      const rows = database.prepare(
        `SELECT n.id FROM knowledge_notes n
         WHERE n.scope = ? AND n.lifecycle = 'active' AND n.kind != 'question' AND n.id > ?
           AND NOT EXISTS (
             SELECT 1 FROM knowledge_evidence_links e
             JOIN knowledge_note_versions v ON v.id = e.knowledge_note_version_id
             WHERE v.note_id = n.id)
           AND NOT EXISTS (
             SELECT 1 FROM knowledge_formal_relations r
             WHERE r.scope = n.scope AND r.ended_change_set_id IS NULL
               AND (r.from_object_id = n.id OR r.to_object_id = n.id))
         ORDER BY n.id LIMIT ?`
      ).all(ctx.scope, cp.cursor, limit) as Array<{ id: string }>;
      for (const row of rows) {
        const plan = orphanKnowledgePlan(ctx, row.id);
        if (plan) plans.push(plan);
      }
      return { scanned: rows.length, plans, lastId: rows.length ? String(rows[rows.length - 1]!.id) : '' };
    }
    case 'unsupported_claims': {
      if (!ctx.detectors.includes('unsupported_claim')) return { scanned: 0, plans, lastId: '' };
      const rows = database.prepare(
        `SELECT n.id FROM knowledge_notes n
         JOIN knowledge_note_versions v ON v.id = n.current_version_id
         WHERE n.scope = ? AND n.lifecycle = 'active'
           AND v.conclusion_status IN ('supported','contradicted')
           AND NOT EXISTS (SELECT 1 FROM knowledge_evidence_links e WHERE e.knowledge_note_version_id = v.id)
           AND n.id > ?
         ORDER BY n.id LIMIT ?`
      ).all(ctx.scope, cp.cursor, limit) as Array<{ id: string }>;
      for (const row of rows) {
        const plan = unsupportedClaimPlan(ctx, row.id);
        if (plan) plans.push(plan);
      }
      return { scanned: rows.length, plans, lastId: rows.length ? String(rows[rows.length - 1]!.id) : '' };
    }
    case 'stale_claims': {
      if (!ctx.detectors.includes('stale_claim')) return { scanned: 0, plans, lastId: '' };
      const nowIso = now();
      const rows = database.prepare(
        `SELECT n.id FROM knowledge_notes n
         JOIN knowledge_note_versions v ON v.id = n.current_version_id
         WHERE n.scope = ? AND n.lifecycle = 'active' AND v.valid_until IS NOT NULL AND v.valid_until < ?
           AND n.id > ?
         ORDER BY n.id LIMIT ?`
      ).all(ctx.scope, nowIso, cp.cursor, limit) as Array<{ id: string }>;
      for (const row of rows) {
        const plan = staleClaimPlan(ctx, row.id, nowIso);
        if (plan) plans.push(plan);
      }
      return { scanned: rows.length, plans, lastId: rows.length ? String(rows[rows.length - 1]!.id) : '' };
    }
    case 'duplicate_notes': {
      if (!ctx.detectors.includes('duplicate_knowledge')) return { scanned: 0, plans, lastId: '' };
      const rows = database.prepare(
        `SELECT n.id FROM knowledge_notes n
         JOIN knowledge_note_versions v ON v.id = n.current_version_id
         WHERE n.scope = ? AND n.lifecycle = 'active' AND n.id > ?
           AND EXISTS (
             SELECT 1 FROM knowledge_notes n2
             JOIN knowledge_note_versions v2 ON v2.id = n2.current_version_id
             WHERE n2.scope = n.scope AND n2.lifecycle = 'active' AND n2.id != n.id
               AND n2.kind = n.kind AND trim(lower(v2.statement)) = trim(lower(v.statement)))
         ORDER BY n.id LIMIT ?`
      ).all(ctx.scope, cp.cursor, limit) as Array<{ id: string }>;
      for (const row of rows) {
        const plan = duplicateKnowledgePlan(ctx, row.id);
        if (plan) plans.push(plan);
      }
      return { scanned: rows.length, plans, lastId: rows.length ? String(rows[rows.length - 1]!.id) : '' };
    }
    case 'duplicate_entities': {
      if (!ctx.detectors.includes('duplicate_entity')) return { scanned: 0, plans, lastId: '' };
      const rows = database.prepare(
        `SELECT e.id FROM knowledge_entities e
         WHERE e.scope = ? AND e.lifecycle = 'active' AND e.external_identity_json != '{}' AND e.id > ?
           AND EXISTS (
             SELECT 1 FROM knowledge_entities e2
             WHERE e2.scope = e.scope AND e2.lifecycle = 'active' AND e2.id != e.id
               AND e2.external_identity_json = e.external_identity_json)
         ORDER BY e.id LIMIT ?`
      ).all(ctx.scope, cp.cursor, limit) as Array<{ id: string }>;
      for (const row of rows) {
        const plan = duplicateEntityPlan(ctx, row.id);
        if (plan) plans.push(plan);
      }
      return { scanned: rows.length, plans, lastId: rows.length ? String(rows[rows.length - 1]!.id) : '' };
    }
    case 'cross_references': {
      if (!ctx.detectors.includes('cross_reference')) return { scanned: 0, plans, lastId: '' };
      const rows = database.prepare(
        `SELECT id FROM knowledge_wiki_pages
         WHERE scope = ? AND lifecycle = 'active' AND id > ?
         ORDER BY id LIMIT ?`
      ).all(ctx.scope, cp.cursor, limit) as Array<{ id: string }>;
      for (const row of rows) {
        const plan = crossReferencePlan(ctx, row.id);
        if (plan) plans.push(plan);
      }
      return { scanned: rows.length, plans, lastId: rows.length ? String(rows[rows.length - 1]!.id) : '' };
    }
    case 'data_gaps': {
      if (!ctx.detectors.includes('data_gap')) return { scanned: 0, plans, lastId: '' };
      const cutoffIso = dataGapCutoffIso();
      const rows = database.prepare(
        `SELECT id FROM knowledge_free_notes
         WHERE scope = ? AND processing_state = 'captured' AND created_at < ? AND id > ?
         ORDER BY id LIMIT ?`
      ).all(ctx.scope, cutoffIso, cp.cursor, limit) as Array<{ id: string }>;
      for (const row of rows) {
        const plan = dataGapPlan(ctx, row.id, cutoffIso);
        if (plan) plans.push(plan);
      }
      return { scanned: rows.length, plans, lastId: rows.length ? String(rows[rows.length - 1]!.id) : '' };
    }
  }
}

function advanceCheckpoint(
  database: DatabaseSync,
  cp: KnowledgeHealthCheckpoint,
  scanned: number,
  lastId: string,
  nextClearCursor: string,
  delta: HealthLintCounts
): KnowledgeHealthCheckpoint {
  const pageExhausted = scanned < cp.pageSize;
  let phase = cp.phase;
  let cursor = cp.cursor;
  let status: 'running' | 'completed' = 'running';
  let completedAt: string | null = null;

  if (pageExhausted) {
    // 本页未满 → 当前 phase 已扫完，前进到下一 phase（或完成）
    const next = nextPhase(phase);
    if (!next) {
      status = 'completed';
      completedAt = now();
    } else {
      phase = next;
      cursor = '';
    }
  } else {
    // 本页扫满 → 停在当前 phase，cursor 推进到本页最后一个对象 id
    cursor = lastId;
  }

  const next: KnowledgeHealthCheckpoint = Object.freeze({
    ...cp,
    status,
    phase,
    cursor,
    clearCursor: nextClearCursor,
    step: cp.step + 1,
    counts: Object.freeze({
      scannedObjects: cp.counts.scannedObjects + delta.scannedObjects,
      issuesCreated: cp.counts.issuesCreated + delta.issuesCreated,
      issuesDeduplicated: cp.counts.issuesDeduplicated + delta.issuesDeduplicated,
      issuesAutoResolved: cp.counts.issuesAutoResolved + delta.issuesAutoResolved,
      repairsApplied: cp.counts.repairsApplied + delta.repairsApplied
    }),
    updatedAt: now(),
    completedAt
  });
  saveCheckpoint(database, next);
  return next;
}

export function runPeriodicLintStep(database: DatabaseSync): KnowledgeHealthPeriodicStepResult {
  const cp = readCheckpoint(database);
  if (!cp) {
    lintError('HEALTH_LINT_NO_CHECKPOINT', '没有周期 Lint checkpoint；请先 beginPeriodicLint。');
  }
  if (cp!.status === 'completed') {
    return Object.freeze({
      ok: true,
      replay: false,
      changeSetId: null,
      requestId: `lint:periodic:${cp!.runId}:step:${cp!.step}`,
      counts: cp!.counts,
      issues: Object.freeze([]),
      receipt: null,
      done: true,
      checkpoint: cp!
    });
  }

  const ctx: DetectorContext = Object.freeze({
    database,
    workspaceId: cp!.workspaceId,
    scope: cp!.scope,
    detectors: cp!.detectors
  });
  const pageSize = cp!.pageSize;
  const maxIssuesPerRun = Math.min(Math.max(pageSize * 4, 1), MAX_PAGE_SIZE * 4);

  // 1. 本 phase 分页扫描（纯读）
  const { scanned, plans, lastId } = scanPhasePage(database, ctx, cp!);
  // 2. 有界自动解决扫描（按 clearCursor 翻页；扫完一轮清零循环）
  const { clears, nextCursor } = collectClearSweep(database, ctx, cp!.clearCursor, pageSize);
  // 3. 装配
  const built = buildRunOps(database, ctx, plans, clears, maxIssuesPerRun);
  const stepCounts: HealthLintCounts = Object.freeze({ ...built.counts, scannedObjects: scanned });
  const requestId = `lint:periodic:${cp!.runId}:step:${cp!.step}`;
  const countsAfter: HealthLintCounts = Object.freeze({
    scannedObjects: cp!.counts.scannedObjects + stepCounts.scannedObjects,
    issuesCreated: cp!.counts.issuesCreated + stepCounts.issuesCreated,
    issuesDeduplicated: cp!.counts.issuesDeduplicated + stepCounts.issuesDeduplicated,
    issuesAutoResolved: cp!.counts.issuesAutoResolved + stepCounts.issuesAutoResolved,
    repairsApplied: cp!.counts.repairsApplied + stepCounts.repairsApplied
  });

  let resultChangeSetId: string | null = null;
  let replay = false;
  let receipt: KnowledgeUpdateReceiptRecord | null = null;
  if (built.relationOps.length || built.healthIssueOps.length) {
    const summary =
      `周期 Lint 步 ${cp!.step}（${cp!.phase}）：扫描 ${stepCounts.scannedObjects} 个对象，` +
      `新建 Issue ${stepCounts.issuesCreated}、去重 ${stepCounts.issuesDeduplicated}、` +
      `自动解决 ${stepCounts.issuesAutoResolved}、确定性修复 ${stepCounts.repairsApplied}。`;
    const input = buildLintChangeSetInput(built, requestId, summary, stepCounts, {
      lint: { scope: cp!.scope, detectors: [...cp!.detectors].sort(), runId: cp!.runId, step: cp!.step }
    });
    const result = applyLintChangeSet(database, lintMeta(cp!.workspaceId, requestId, cp!.phase, cp!.createdBy), input);
    broadcastDataChanged({
      scopes: ['knowledge', 'topics', 'canvas', 'health', 'receipt', 'library'],
      reason: KNOWLEDGE_HEALTH_LINT_CHANNEL_REASON
    });
    resultChangeSetId = result.changeSetId;
    replay = result.replay;
    receipt = result.receipt;
  }

  // 4. 推进 checkpoint（ChangeSet 提交成功后才推进；崩溃后重试原样重放或零写）
  const next = advanceCheckpoint(database, cp!, scanned, lastId, nextCursor, stepCounts);
  const issues = readBackIssues(database, built.touchedIssueIds);

  return Object.freeze({
    ok: true,
    replay,
    changeSetId: resultChangeSetId,
    requestId,
    counts: countsAfter,
    issues,
    receipt,
    done: next.status === 'completed',
    checkpoint: next
  });
}
