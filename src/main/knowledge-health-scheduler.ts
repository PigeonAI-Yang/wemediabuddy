// extracted from src/main/knowledge-health.ts (structural split)
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { dispatchBusinessCommand, requireReceiptData } from './business-command.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import {
  setKnowledgeChangeSetLintTrigger,
  type KnowledgeChangeSetInput,
  type KnowledgeChangeSetMeta,
  type KnowledgeScope,
} from './knowledge-flywheel.ts';
import {
  KNOWLEDGE_HEALTH_HOOK_MAX_OBJECTS_PER_SCOPE,
  uniqueRefs,
  validateScope,
  now,
} from './knowledge-health-types.ts';
import type { HealthLintObjectRef } from './knowledge-health-types.ts';
import {
  beginPeriodicLint,
  getPeriodicLintCheckpoint,
  runPeriodicLintStep,
} from './knowledge-health-periodic.ts';
import { runLocalLint } from './knowledge-health-local.ts';

// ============================================================
// 统一 ChangeSet 提交后局部 Lint 触发（生产接线：Ingest/Query/Review/恢复/合并/晋升）
// ============================================================

function noteIdByKey(database: DatabaseSync, scope: KnowledgeScope, canonicalKey: string): string | null {
  if (!canonicalKey?.trim()) return null;
  const row = database.prepare('SELECT id FROM knowledge_notes WHERE scope = ? AND canonical_key = ? LIMIT 1')
    .get(scope, canonicalKey.trim().toLowerCase()) as { id: string } | undefined;
  return row?.id ?? null;
}

function pageIdByKey(database: DatabaseSync, scope: KnowledgeScope, canonicalKey: string): string | null {
  if (!canonicalKey?.trim()) return null;
  const row = database.prepare('SELECT id FROM knowledge_wiki_pages WHERE scope = ? AND canonical_key = ? LIMIT 1')
    .get(scope, canonicalKey.trim().toLowerCase()) as { id: string } | undefined;
  return row?.id ?? null;
}

function noteIdByVersion(database: DatabaseSync, versionId: string): string | null {
  if (!versionId) return null;
  const row = database.prepare('SELECT note_id AS noteId FROM knowledge_note_versions WHERE id = ?').get(versionId) as
    | { noteId: string }
    | undefined;
  return row?.noteId ?? null;
}

/** 从 ChangeSet 输入派生有界受影响对象（按 scope 分组；含 requestId 约定的 Review 回流对象）。 */
function affectedObjectsFromChangeSet(
  database: DatabaseSync,
  meta: KnowledgeChangeSetMeta,
  input: KnowledgeChangeSetInput
): Map<KnowledgeScope, HealthLintObjectRef[]> {
  const byScope = new Map<KnowledgeScope, HealthLintObjectRef[]>();
  const push = (scope: string, objectType: string, objectId: string | null | undefined) => {
    if (!objectId) return;
    const s = validateScope(scope);
    const list = byScope.get(s) ?? [];
    list.push({ objectType, objectId });
    byScope.set(s, list);
  };
  for (const note of input.notes ?? []) {
    if (note.id) push(note.scope, 'knowledge_note', note.id);
    else push(note.scope, 'knowledge_note', noteIdByKey(database, note.scope, note.canonicalKey));
  }
  for (const freeNote of input.freeNotes ?? []) {
    push(freeNote.scope, 'knowledge_free_note', freeNote.id);
  }
  for (const page of input.wikiPages ?? []) {
    if (page.id) push(page.scope, 'wiki_page', page.id);
    else push(page.scope, 'wiki_page', pageIdByKey(database, page.scope, page.canonicalKey));
  }
  for (const rel of input.relations ?? []) {
    if (rel.op === 'create') push(rel.scope, 'knowledge_relation', rel.id);
  }
  for (const evidence of input.evidenceLinks ?? []) {
    push('global', 'knowledge_note', noteIdByVersion(database, evidence.knowledgeNoteVersionId));
  }
  // Review 回流 ChangeSet（requestId 约定 outcome:review:{reviewId}）→ 对 Review 对象局部 Lint
  const reviewRequestIdPrefix = 'outcome:review:';
  if (typeof meta.requestId === 'string' && meta.requestId.startsWith(reviewRequestIdPrefix)) {
    const reviewId = meta.requestId.slice(reviewRequestIdPrefix.length);
    if (reviewId) push('global', 'review', reviewId);
  }
  for (const [scope, refs] of byScope) {
    byScope.set(scope, uniqueRefs(refs).slice(0, KNOWLEDGE_HEALTH_HOOK_MAX_OBJECTS_PER_SCOPE));
  }
  return byScope;
}

/**
 * 注册统一的知识变更后局部 Lint 触发（幂等；应在应用启动时调用一次）。
 * 每个成功提交的业务 ChangeSet（非 lint 自身、非重放）后，对受影响的有限对象
 * （按 scope 分组、有界）运行 runLocalLint；lint 失败被 store 侧捕获，绝不回滚业务 ChangeSet。
 */
export function registerKnowledgeChangeSetLintTrigger(): void {
  setKnowledgeChangeSetLintTrigger((ctx) => {
    const byScope = affectedObjectsFromChangeSet(ctx.database, ctx.meta, ctx.input);
    for (const [scope, refs] of byScope) {
      if (!refs.length) continue;
      runLocalLint(ctx.database, {
        requestId: `lint:local:postcommit:${ctx.result.changeSetId}`,
        workspaceId: ctx.meta.workspaceId,
        reason: `知识变更后局部 Lint（ChangeSet ${ctx.result.changeSetId}）`,
        scope,
        affectedObjects: refs
      });
    }
  });
}

// ============================================================
// 周期 Lint 生产接线：复用既有 jobs 表（kind='knowledge_lint'），不新建调度系统
// ============================================================

export const KNOWLEDGE_LINT_JOB_KIND = 'knowledge_lint' as const;
/** 计划窗：每轮 job 的步数预算。 */
export const PERIODIC_LINT_STEP_BUDGET = 20 as const;
/** 一轮预算耗尽后滚动到下一轮的计划窗（可用 WMB_LINT_INTERVAL_MS 覆盖）。 */
export const PERIODIC_LINT_INTERVAL_MS = (() => {
  const raw = Number(process.env.WMB_LINT_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? Math.floor(raw) : 12 * 3_600_000;
})();
/** 应用启动后首轮延迟（可用 WMB_LINT_FIRST_DELAY_MS 覆盖）。 */
export const PERIODIC_LINT_FIRST_DELAY_MS = (() => {
  const raw = Number(process.env.WMB_LINT_FIRST_DELAY_MS);
  return Number.isFinite(raw) && raw >= 5_000 ? Math.floor(raw) : 5 * 60_000;
})();
/** 失败 job 的重试窗口。 */
export const PERIODIC_LINT_RETRY_AFTER_MS = 30 * 60_000;

function lintJobDedupeKey(scope: KnowledgeScope): string {
  return `lint:periodic:${scope}:rolling`;
}

function lintJobPayload(scope: KnowledgeScope): string {
  return JSON.stringify({ scope });
}

/** 计划（或重置）一轮周期 Lint job（幂等：pending/running 不重复入队；终态行重置续排）。 */
export function schedulePeriodicLintJob(database: DatabaseSync, input: { scope?: KnowledgeScope; delayMs?: number } = {}): { scheduled: boolean; dueAt: string } {
  const scope = validateScope(input.scope ?? 'global');
  const dedupeKey = lintJobDedupeKey(scope);
  const nowIso = now();
  const dueAt = new Date(Date.now() + Math.max(input.delayMs ?? PERIODIC_LINT_FIRST_DELAY_MS, 0)).toISOString();
  const existing = database.prepare('SELECT id, status FROM jobs WHERE dedupe_key = ?').get(dedupeKey) as
    | { id: string; status: string }
    | undefined;
  if (existing) {
    if (existing.status === 'pending' || existing.status === 'running') return { scheduled: false, dueAt };
    database.prepare(
      `UPDATE jobs SET status = 'pending', due_at = ?, attempts = 0, last_error = NULL, started_at = NULL, finished_at = NULL, updated_at = ? WHERE id = ?`
    ).run(dueAt, nowIso, existing.id);
    return { scheduled: true, dueAt };
  }
  database.prepare(
    `INSERT INTO jobs (id, kind, status, due_at, attempts, dedupe_key, payload_json, last_error, created_at, updated_at, started_at, finished_at)
     VALUES (?, ?, 'pending', ?, 0, ?, ?, NULL, ?, ?, NULL, NULL)`
  ).run(randomUUID(), KNOWLEDGE_LINT_JOB_KIND, dueAt, dedupeKey, lintJobPayload(scope), nowIso, nowIso);
  return { scheduled: true, dueAt };
}

/** 崩溃恢复（running → pending）与失败重试（终态超过重试窗口 → pending）。 */
export function recoverOrRetryPeriodicLintJobs(database: DatabaseSync, input: { retryAfterMs?: number } = {}): { recovered: number } {
  const nowIso = now();
  const retryAfterMs = input.retryAfterMs ?? PERIODIC_LINT_RETRY_AFTER_MS;
  const recovered = database.prepare(
    `UPDATE jobs SET status = 'pending', started_at = NULL, updated_at = ? WHERE kind = ? AND status = 'running'`
  ).run(nowIso, KNOWLEDGE_LINT_JOB_KIND).changes ?? 0;
  const retried = database.prepare(
    `UPDATE jobs SET status = 'pending', attempts = 0, last_error = NULL, started_at = NULL, finished_at = NULL, updated_at = ?
     WHERE kind = ? AND status = 'failed' AND finished_at IS NOT NULL AND finished_at <= ?`
  ).run(nowIso, KNOWLEDGE_LINT_JOB_KIND, new Date(Date.now() - retryAfterMs).toISOString()).changes ?? 0;
  return { recovered: Number(recovered) + Number(retried) };
}

type LintJobRow = Readonly<{
  id: string;
  status: string;
  dueAt: string;
  attempts: number;
  scope: KnowledgeScope;
}>;

function listDueLintJobs(database: DatabaseSync, limit: number): LintJobRow[] {
  const rows = database.prepare(
    `SELECT id, status, due_at AS dueAt, attempts, payload_json AS payloadJson
     FROM jobs WHERE kind = ? AND status = 'pending' AND due_at <= ? ORDER BY due_at LIMIT ?`
  ).all(KNOWLEDGE_LINT_JOB_KIND, now(), limit) as Array<Record<string, unknown>>;
  return rows.map((row) => Object.freeze({
    id: String(row.id),
    status: String(row.status),
    dueAt: String(row.dueAt),
    attempts: Number(row.attempts),
    scope: (((JSON.parse(String(row.payloadJson ?? '{}')) as Record<string, unknown>)?.scope as string) ?? 'global') as KnowledgeScope
  }));
}

/** 单个 job 轮次：claim → 确保 checkpoint → 有界步数 → finish（+ 未完成则滚动下一轮）。 */
function runOneLintJob(database: DatabaseSync, job: LintJobRow, budgetSteps: number, workspaceId: string): { skipped: boolean; steps: number; done: boolean; status: string; error: string | null } {
  const claim = database.prepare(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND attempts = ?`
  ).run(now(), now(), job.id, job.attempts);
  if (Number(claim.changes ?? 0) !== 1) return { skipped: true, steps: 0, done: false, status: 'skipped', error: null };

  const checkpoint = getPeriodicLintCheckpoint(database);
  if (!checkpoint || checkpoint.status === 'completed') {
    beginPeriodicLint(database, { workspaceId, scope: job.scope, resume: false });
  }

  let steps = 0;
  let done = false;
  let failed = false;
  let errorMessage: string | null = null;
  while (steps < budgetSteps && !done) {
    try {
      const step = runPeriodicLintStep(database);
      steps += 1;
      done = step.done;
    } catch (error) {
      failed = true;
      errorMessage = `${(error as { code?: string })?.code ?? 'LINT_STEP_FAILED'}: ${(error as Error)?.message ?? String(error)}`;
      break;
    }
  }

  const finishStatus = failed ? 'failed' : 'succeeded';
  database.prepare(`UPDATE jobs SET status = ?, last_error = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'`)
    .run(finishStatus, errorMessage, now(), now(), job.id);
  if (!done && !failed) {
    // 预算耗尽但未完成 → 滚动到下一计划窗（checkpoint 保留，续跑不重复 Issue）
    schedulePeriodicLintJob(database, { scope: job.scope, delayMs: PERIODIC_LINT_INTERVAL_MS });
  }
  return { skipped: false, steps, done, status: finishStatus, error: errorMessage };
}

/**
 * 处理到期的周期 Lint jobs（复用既有 jobs 表；依赖联合模式与 x-observation 一致）：
 * - DatabaseSync：测试/直连模式，同步执行（无 dispatcher/授权层）；
 * - ActiveWorkspaceRuntime：生产模式，claim/finish/步进经 dispatchBusinessCommand 授权执行。
 */
export async function runDuePeriodicLintJobs(
  dependency: ActiveWorkspaceRuntime | DatabaseSync,
  input: { isCurrent?: () => boolean; budgetSteps?: number; dueLimit?: number } = {}
): Promise<{ processed: number; stepsRun: number }> {
  const database = 'database' in dependency ? dependency.database : dependency;
  const budgetSteps = Math.min(Math.max(input.budgetSteps ?? PERIODIC_LINT_STEP_BUDGET, 1), 100);
  // 确保滚动 job 存在（幂等；无 pending/running 行才创建）——调度器首个 tick 即完成初始计划
  const rollingExists = database.prepare('SELECT id FROM jobs WHERE kind = ? AND dedupe_key = ?')
    .get(KNOWLEDGE_LINT_JOB_KIND, lintJobDedupeKey('global'));
  if (!rollingExists) {
    if (!('database' in dependency)) {
      schedulePeriodicLintJob(database, { scope: 'global' });
    } else {
      await dispatchBusinessCommand(dependency, {
        command: 'knowledge_lint.schedule',
        requestId: `knowledge-lint:schedule:${Date.now()}`,
        actor: lintSchedulerActor,
        input: { scope: 'global' },
        boundIdentity: dependency.identity,
        entityType: 'knowledge_lint_job',
        execute: (runtimeDatabase) => ({ data: schedulePeriodicLintJob(runtimeDatabase, { scope: 'global' }) })
      }).catch((error) => console.error('[knowledge-lint] initial schedule failed', error));
    }
  }
  const due = listDueLintJobs(database, input.dueLimit ?? 2);
  let processed = 0;
  let stepsRun = 0;
  for (const job of due) {
    if (input.isCurrent && !input.isCurrent()) break;
    if (!('database' in dependency)) {
      // 直连模式（测试）：同步执行，无 dispatcher/授权层
      const result = runOneLintJob(database, job, budgetSteps, boundWorkspaceId(database));
      if (!result.skipped) {
        processed += 1;
        stepsRun += result.steps;
      }
      continue;
    }
    // 生产模式：claim/finish/步进经 dispatchBusinessCommand 授权执行
    const runtime = dependency;
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'knowledge_lint.run_job',
      requestId: `knowledge-lint:${job.id}:${job.attempts}`,
      actor: lintSchedulerActor,
      input: { jobId: job.id, expectedAttempts: job.attempts, scope: job.scope, budgetSteps, workspaceId: runtime.identity.workspaceId },
      boundIdentity: runtime.identity,
      entityType: 'knowledge_lint_job',
      execute: (runtimeDatabase) => {
        const result = runOneLintJob(runtimeDatabase, job, budgetSteps, runtime.identity.workspaceId);
        return { data: result, entityId: job.id };
      }
    });
    const data = requireReceiptData(receipt);
    if (!data.skipped) {
      processed += 1;
      stepsRun += data.steps;
    }
  }
  return { processed, stepsRun };
}

function boundWorkspaceId(database: DatabaseSync): string {
  try {
    const row = database.prepare("SELECT value AS workspaceId FROM app_meta WHERE key='workspace_id'").get() as { workspaceId?: string } | undefined;
    return row?.workspaceId ?? '';
  } catch {
    return '';
  }
}

const lintSchedulerActor = Object.freeze({ type: 'scheduler', id: 'knowledge-lint', label: 'knowledge-lint' }) as {
  type: 'scheduler';
  id: string;
  label: string;
};

export class KnowledgeLintScheduler {
  private stopped = true;
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<void> | null = null;
  private rerun = false;
  private generation = 0;
  private recovered = false;
  private readonly options: { runtime: ActiveWorkspaceRuntime; isCurrent?: () => boolean; intervalMs?: number };

  constructor(options: { runtime: ActiveWorkspaceRuntime; isCurrent?: () => boolean; intervalMs?: number }) {
    this.options = options;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.generation += 1;
    this.recovered = false;
    this.wake();
  }

  wake(): void {
    if (this.stopped) return;
    if (this.current) {
      this.rerun = true;
      return;
    }
    clearTimeout(this.timer ?? undefined);
    this.timer = setTimeout(() => void this.tick(), 0);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation += 1;
    this.rerun = false;
    clearTimeout(this.timer ?? undefined);
    this.timer = null;
    await this.current?.catch(() => {});
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.current) return;
    this.timer = null;
    const generation = this.generation;
    const runtime = this.options.runtime;
    const intervalMs = this.options.intervalMs ?? PERIODIC_LINT_INTERVAL_MS;
    this.current = (async () => {
      if (this.stopped || generation !== this.generation || !runtime.isActive || (this.options.isCurrent && !this.options.isCurrent())) return;
      if (!this.recovered) {
        recoverOrRetryPeriodicLintJobs(runtime.database, {});
        this.recovered = true;
      }
      await runDuePeriodicLintJobs(runtime, { isCurrent: () => !this.stopped && generation === this.generation && runtime.isActive && (!this.options.isCurrent || this.options.isCurrent()) });
    })().catch((error) => {
      console.error('[knowledge-lint] periodic scheduler tick failed', error);
    });
    await this.current;
    this.current = null;
    if (this.stopped || (this.options.isCurrent && !this.options.isCurrent())) return;
    if (this.rerun) {
      this.rerun = false;
      this.wake();
      return;
    }
    this.timer = setTimeout(() => void this.tick(), intervalMs);
    this.timer.unref();
  }
}
