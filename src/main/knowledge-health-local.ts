// extracted from src/main/knowledge-health.ts (structural split)
import type { DatabaseSync } from 'node:sqlite';
import { assertScopeAllowed } from './knowledge-flywheel.ts';
import { broadcastDataChanged } from './data-changed.ts';
import {
  DEFAULT_MAX_AFFECTED_OBJECTS,
  DEFAULT_MAX_ISSUES_PER_RUN,
  KNOWLEDGE_HEALTH_LINT_CHANNEL_REASON,
  lintError,
  normalizeDetectors,
  uniqueRefs,
  validateRequestId,
  validateScope,
  validateWorkspace,
} from './knowledge-health-types.ts';
import type {
  HealthLintCounts,
  KnowledgeHealthLintInput,
  KnowledgeHealthLintResult,
} from './knowledge-health-types.ts';
import type { DetectorContext } from './knowledge-health-detectors.ts';
import {
  applyLintChangeSet,
  buildLintChangeSetInput,
  buildRunOps,
  collectClearsForObjects,
  detectForObject,
  lintMeta,
  readBackIssues,
} from './knowledge-health-operations.ts';

/** 局部 Lint 的稳定幂等键（调用方可自定义，此为推荐约定）。 */
export function localLintRequestId(trigger: string, objectType: string, objectId: string): string {
  return `lint:local:${trigger}:${objectType}:${objectId}`;
}

export function runLocalLint(database: DatabaseSync, rawInput: KnowledgeHealthLintInput): KnowledgeHealthLintResult {
  const requestId = validateRequestId(rawInput.requestId);
  const workspaceId = validateWorkspace(rawInput.workspaceId);
  const scope = validateScope(rawInput.scope ?? 'global');
  // lane 注册门（与 store 写面同源）：未注册 lane 在运行开始即拒绝，零写
  assertScopeAllowed(database, scope);
  const createdBy = rawInput.createdBy ?? 'background_agent';
  const reason = (rawInput.reason ?? `知识健康局部 Lint（${requestId}）`).trim();
  const detectors = normalizeDetectors(rawInput.detectors);
  const maxAffectedObjects = Math.min(Math.max(rawInput.maxAffectedObjects ?? DEFAULT_MAX_AFFECTED_OBJECTS, 1), 1000);
  const maxIssuesPerRun = Math.min(Math.max(rawInput.maxIssuesPerRun ?? DEFAULT_MAX_ISSUES_PER_RUN, 1), 500);
  const refs = uniqueRefs(rawInput.affectedObjects);
  if (refs.length > maxAffectedObjects) {
    lintError('HEALTH_LINT_SCOPE_EXCEEDED', `局部 Lint 受影响对象 ${refs.length} 超过上限 ${maxAffectedObjects}，零写。`, {
      affectedObjects: refs.length,
      maxAffectedObjects
    });
  }

  const ctx: DetectorContext = Object.freeze({ database, workspaceId, scope, detectors });

  // 1. 检测（纯读）
  const plans: import('./knowledge-health-types.ts').HealthLintIssuePlan[] = [];
  for (const ref of refs) plans.push(...detectForObject(ctx, ref));
  // 2. 受影响对象上的条件消除自动解决（纯读）
  const clears = collectClearsForObjects(database, ctx, refs);
  // 3. 装配（去重/修复/解决；上限检查；零写直至 apply）
  const built = buildRunOps(database, ctx, plans, clears, maxIssuesPerRun);
  const counts: HealthLintCounts = Object.freeze({ ...built.counts, scannedObjects: refs.length });

  if (!built.relationOps.length && !built.healthIssueOps.length) {
    return Object.freeze({
      ok: true,
      replay: false,
      changeSetId: null,
      requestId,
      counts,
      issues: Object.freeze([]),
      receipt: null
    });
  }

  const summary =
    `知识健康 Lint：扫描 ${counts.scannedObjects} 个对象，新建 Issue ${counts.issuesCreated}、去重 ${counts.issuesDeduplicated}、` +
    `自动解决 ${counts.issuesAutoResolved}、确定性修复 ${counts.repairsApplied}。`;
  const input = buildLintChangeSetInput(built, requestId, summary, counts, { lint: { scope, detectors: [...detectors].sort() } });
  const result = applyLintChangeSet(database, lintMeta(workspaceId, requestId, reason, createdBy), input);
  broadcastDataChanged({
    scopes: ['knowledge', 'topics', 'canvas', 'health', 'receipt', 'library'],
    reason: KNOWLEDGE_HEALTH_LINT_CHANNEL_REASON
  });
  const issues = readBackIssues(database, built.touchedIssueIds);
  return Object.freeze({
    ok: true,
    replay: result.replay,
    changeSetId: result.changeSetId,
    requestId,
    counts,
    issues,
    receipt: result.receipt
  });
}
