import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ensureDailyCycleInternal, getDailyCycleProjection } from './daily-content-cycle.ts';
import { ensureDraftRevisionTargetInternal, ensurePublishedRevisionTargetInternal, getYesterdayIterationProjection } from './daily-iteration.ts';
import { readZhihuHotViaBrowser, commitZhihuHotScan, zhihuHotReadiness } from './zhihu-hot-channel.ts';
import { getScoringSettings } from './zhihu-hot-scoring.ts';
import { ensureTargetArticleLinkInternal, advanceApprovedPlanItem } from './daily-content-article.ts';
import { ensureContentDerivativeInternal } from './content-derivative.ts';

export type DailyOrchestrationSource = 'scheduler' | 'today' | 'mcp';
export type StageKey = 'A' | 'B' | 'C' | 'D' | 'E';

export type StageResult = {
  stage: StageKey;
  name: string;
  status: 'completed' | 'partial' | 'needs_user' | 'failed' | 'skipped' | 'paused';
  count?: number;
  gap?: number;
  blocked?: number;
  skipped?: number;
  carried?: number;
  errorCode?: string | null;
  detail?: string;
};

export type DailySettlement = {
  businessDate: string;
  workspaceId: string;
  source: DailyOrchestrationSource;
  status: 'paused' | 'needs_user' | 'partial' | 'completed' | 'failed';
  stages: StageResult[];
  counts: {
    targetCount: number;
    completed: number;
    gap: number;
    skipped: number;
    carried: number;
    blocked: number;
    autoSelected: number;
    ownerSelected: number;
  };
  readable: string;
  createdAt: string;
  updatedAt: string;
};

export type OrchestrationContext = Readonly<{ workspaceId: string; source: DailyOrchestrationSource }>;
export type StageHandler = (database: DatabaseSync, businessDate: string, context?: OrchestrationContext) => Promise<StageResult> | StageResult;

export type OrchestrationMutationSpec<T> = Readonly<{
  command: string;
  entityType: string;
  entityId: string;
  execute: () => T;
}>;
export type OrchestrationMutationExecutor = <T>(spec: OrchestrationMutationSpec<T>, context: OrchestrationContext) => Promise<T>;

export type DailyOrchestrationDeps = {
  stageA?: StageHandler;
  stageB?: StageHandler;
  stageC?: StageHandler;
  stageD?: StageHandler;
  stageE?: StageHandler;
  persistSettlement?: (database: DatabaseSync, settlement: DailySettlement, context: OrchestrationContext) => Promise<void>;
};

export type ProductionOrchestrationOverrides = {
  readZhihuHotViaBrowser?: typeof readZhihuHotViaBrowser;
  commitZhihuHotScan?: typeof commitZhihuHotScan;
  zhihuHotReadiness?: typeof zhihuHotReadiness;
  ensureDailyCycleInternal?: typeof ensureDailyCycleInternal;
  getDailyCycleProjection?: typeof getDailyCycleProjection;
  getYesterdayIterationProjection?: typeof getYesterdayIterationProjection;
  ensureDraftRevisionTargetInternal?: typeof ensureDraftRevisionTargetInternal;
  ensurePublishedRevisionTargetInternal?: typeof ensurePublishedRevisionTargetInternal;
  ensureTargetArticleLinkInternal?: typeof ensureTargetArticleLinkInternal;
  advanceApprovedPlanItem?: typeof advanceApprovedPlanItem;
  ensureContentDerivativeInternal?: typeof ensureContentDerivativeInternal;
  runMutation?: OrchestrationMutationExecutor;
};

export type DailyOrchestrationActorIntent = Readonly<{
  kind: 'submitWorkspaceOrchestratorIntent';
  producerId: 'today.daily-orchestration' | 'mcp.daily-orchestrate' | 'scheduler.daily-0900';
  action: 'stage_d';
  businessDate: string;
  requestId: string;
  rootMode: 'owner' | 'scheduler';
  logicalInput: Readonly<Record<string, unknown>>;
  payload: Readonly<Record<string, unknown>>;
}>;


// schedule persisted in app_meta
const SCHEDULE_TIME_KEY = 'daily_orchestration.schedule_time';
const AUTO_ENABLED_KEY = 'daily_orchestration.auto_enabled';

function nowIso(): string { return new Date().toISOString(); }

async function runMutation<T>(overrides: ProductionOrchestrationOverrides, context: OrchestrationContext | undefined, spec: OrchestrationMutationSpec<T>): Promise<T> {
  if (overrides.runMutation && context) return overrides.runMutation(spec, context);
  return spec.execute();
}

function isValidTime(v: string): boolean { return /^\d{2}:\d{2}$/.test(v) && Number(v.slice(0,2)) >=0 && Number(v.slice(0,2))<24 && Number(v.slice(3,5))<60; }

export function getDailyOrchestrationSchedule(database: DatabaseSync): { time: string; autoEnabled: boolean } {
  let time = '09:00';
  let autoEnabled = true;
  try {
    const row = database.prepare("SELECT value FROM app_meta WHERE key=?").get(SCHEDULE_TIME_KEY) as { value: string } | undefined;
    if (row?.value && isValidTime(row.value)) time = row.value;
  } catch {}
  try {
    const row = database.prepare("SELECT value FROM app_meta WHERE key=?").get(AUTO_ENABLED_KEY) as { value: string } | undefined;
    if (row?.value !== undefined) autoEnabled = row.value === '1' || row.value === 'true';
  } catch {}
  return { time, autoEnabled };
}

export function setDailyOrchestrationSchedule(database: DatabaseSync, input: { time?: string; autoEnabled?: boolean }): { time: string; autoEnabled: boolean } {
  const current = getDailyOrchestrationSchedule(database);
  const nextTime = input.time !== undefined ? String(input.time).trim() : current.time;
  const nextEnabled = input.autoEnabled !== undefined ? Boolean(input.autoEnabled) : current.autoEnabled;
  if (input.time !== undefined && !isValidTime(nextTime)) throw Object.assign(new Error('time 必须为 HH:mm'), { code: 'VALIDATION_ERROR' });
  const ts = nowIso();
  try {
    const exists = database.prepare('SELECT revision FROM app_meta WHERE key=?').get(SCHEDULE_TIME_KEY) as { revision: number } | undefined;
    if (exists) database.prepare('UPDATE app_meta SET value=?, updated_at=?, revision=revision+1 WHERE key=?').run(nextTime, ts, SCHEDULE_TIME_KEY);
    else database.prepare('INSERT INTO app_meta (key,value,created_at,updated_at,revision) VALUES (?,?,?,?,1)').run(SCHEDULE_TIME_KEY, nextTime, ts, ts);
  } catch {}
  try {
    const val = nextEnabled ? '1' : '0';
    const exists = database.prepare('SELECT revision FROM app_meta WHERE key=?').get(AUTO_ENABLED_KEY) as { revision: number } | undefined;
    if (exists) database.prepare('UPDATE app_meta SET value=?, updated_at=?, revision=revision+1 WHERE key=?').run(val, ts, AUTO_ENABLED_KEY);
    else database.prepare('INSERT INTO app_meta (key,value,created_at,updated_at,revision) VALUES (?,?,?,?,1)').run(AUTO_ENABLED_KEY, val, ts, ts);
  } catch {}
  return { time: nextTime, autoEnabled: nextEnabled };
}

export function deterministicOrchestrationId(workspaceId: string, businessDate: string, stage: string): string {
  return createHash('sha256').update(`${workspaceId}:${businessDate}:${stage}`).digest('hex').slice(0, 16);
}

export function deterministicJobId(workspaceId: string, businessDate: string, stage: StageKey): string {
  return `daily-${businessDate}-${stage}-${deterministicOrchestrationId(workspaceId, businessDate, stage)}`;
}
export function buildDailyOrchestrationActorIntent(input: { businessDate: string; workspaceId: string; source: DailyOrchestrationSource; requestId?: string }): DailyOrchestrationActorIntent {
  const producerBySource: Record<DailyOrchestrationSource, DailyOrchestrationActorIntent['producerId']> = {
    today: 'today.daily-orchestration',
    mcp: 'mcp.daily-orchestrate',
    scheduler: 'scheduler.daily-0900',
  };
  const rootMode = input.source === 'scheduler' ? 'scheduler' : 'owner';
  const producerId = producerBySource[input.source];
  const requestId = input.requestId?.trim() || `legacy:${producerId}:${input.workspaceId}:${input.businessDate}`;
  const logicalInput = Object.freeze({
    workspaceId: input.workspaceId,
    businessDate: input.businessDate,
    source: input.source,
    stage: 'stage_d',
  });
  return Object.freeze({
    kind: 'submitWorkspaceOrchestratorIntent',
    producerId,
    action: 'stage_d',
    businessDate: input.businessDate,
    requestId,
    rootMode,
    logicalInput,
    payload: logicalInput,
  });
}

function buildReadable(businessDate: string, status: string, stages: StageResult[], counts: DailySettlement['counts']): string {
  const stageLines = stages.map(s => `${s.stage}:${s.name}=${s.status}${s.detail ? `(${s.detail})` : ''}${s.count !== undefined ? ` 计数${s.count}` : ''}${s.gap !== undefined && s.gap>0 ? ` 缺口${s.gap}` : ''}${s.blocked ? ` 阻塞${s.blocked}` : ''}${s.skipped ? ` 跳过${s.skipped}` : ''}${s.carried ? ` 顺延${s.carried}` : ''}`).join('；');
  return `【${businessDate}】${status} · 目标${counts.targetCount} 完成${counts.completed} 缺口${counts.gap} 跳过${counts.skipped} 阻塞${counts.blocked} 顺延${counts.carried} · ${stageLines}`;
}

// ---- Production stage handlers (real primitives) ----

function createProductionStageA(overrides: ProductionOrchestrationOverrides): StageHandler {
  return async (database: DatabaseSync, businessDate: string, context?: OrchestrationContext): Promise<StageResult> => {
    const getProj = overrides.getYesterdayIterationProjection ?? getYesterdayIterationProjection;
    const ensureDraft = overrides.ensureDraftRevisionTargetInternal ?? ensureDraftRevisionTargetInternal;
    const ensurePub = overrides.ensurePublishedRevisionTargetInternal ?? ensurePublishedRevisionTargetInternal;
    try {
      let created = 0;
      let reused = 0;
      const todayStart = Date.parse(`${businessDate}T00:00:00+08:00`);
      const yesterdayStart = new Date(todayStart - 86_400_000).toISOString();
      const yesterdayEnd = new Date(todayStart).toISOString();
      const draftRows = database.prepare(`
        SELECT p.id as projectId, cv.id as cvId FROM content_projects p
        JOIN content_versions cv ON cv.project_id = p.id
        WHERE p.status IN ('idea','drafting','review')
        AND cv.created_at >= ? AND cv.created_at < ?
        AND cv.version_number = (SELECT MAX(version_number) FROM content_versions WHERE project_id = p.id)
        LIMIT 20
      `).all(yesterdayStart, yesterdayEnd) as Array<{ projectId: string; cvId: string }>;
      for (const r of draftRows) {
        const before = database.prepare("SELECT id FROM daily_content_targets WHERE predecessor_content_version_id=? AND target_kind='draft_revision' AND cycle_id=(SELECT id FROM daily_content_cycles WHERE business_date=?)").get(r.cvId, businessDate) as { id: string } | undefined;
        if (before) { reused++; continue; }
        await runMutation(overrides, context, {
          command: 'daily_content_target.ensure_draft_revision', entityType: 'daily_content_target', entityId: r.cvId,
          execute: () => ensureDraft(database, { businessDate, projectId: r.projectId, predecessorContentVersionId: r.cvId })
        });
        created++;
      }
      const pubRows = database.prepare(`
        SELECT pub.id as pubId, pv.content_version_id as cvId, pv.project_id as projectId
        FROM publications pub JOIN platform_versions pv ON pv.id=pub.platform_version_id
        WHERE pub.status='published' AND pub.published_at >= ? AND pub.published_at < ?
        ORDER BY pub.published_at DESC LIMIT 10
      `).all(yesterdayStart, yesterdayEnd) as Array<{ pubId: string; cvId: string; projectId: string }>;
      for (const r of pubRows) {
        const before = database.prepare("SELECT id FROM daily_content_targets WHERE predecessor_publication_id=? AND target_kind='published_revision' AND cycle_id=(SELECT id FROM daily_content_cycles WHERE business_date=?)").get(r.pubId, businessDate) as { id: string } | undefined;
        if (before) { reused++; continue; }
        await runMutation(overrides, context, {
          command: 'daily_content_target.ensure_published_revision', entityType: 'daily_content_target', entityId: r.pubId,
          execute: () => ensurePub(database, { businessDate, projectId: r.projectId, predecessorPublicationId: r.pubId, predecessorContentVersionId: r.cvId })
        });
        created++;
      }
      const proj = getProj(database, businessDate);
      const total = (proj.draftIterations?.length ?? 0) + (proj.publishedIterations?.length ?? 0);
      const blocked = [...(proj.draftIterations as unknown as Array<{status:string}> ?? []), ...(proj.publishedIterations as unknown as Array<{status:string}> ?? [])].filter(r => r.status === 'blocked').length;
      const detail = created || reused ? `迭代创建${created} 复用${reused} 队列${total}` : (total ? `迭代队列 ${total} 条` : '暂无迭代任务');
      return { stage: 'A', name: '昨日迭代', status: blocked ? 'partial' : 'completed', count: total, blocked, detail };
    } catch (e) {
      return { stage: 'A', name: '昨日迭代', status: 'failed', errorCode: (e as {code?:string})?.code ?? 'STAGE_A_FAILED', detail: e instanceof Error ? e.message : String(e) };
    }
  };
}

function createProductionStageB(overrides: ProductionOrchestrationOverrides): StageHandler {
  return async (database: DatabaseSync, businessDate: string, context?: OrchestrationContext): Promise<StageResult> => {
    const readinessFn = overrides.zhihuHotReadiness ?? zhihuHotReadiness;
    const readFn = overrides.readZhihuHotViaBrowser ?? readZhihuHotViaBrowser;
    const commitFn = overrides.commitZhihuHotScan ?? commitZhihuHotScan;
    try {
      const readiness = readinessFn(database);
      if (readiness.state === 'needs_user') return { stage: 'B', name: '热榜扫描', status: 'needs_user', errorCode: readiness.code, detail: readiness.message ?? '需要登录/验证' , blocked: 1 };
      if (readiness.state === 'unavailable') return { stage: 'B', name: '热榜扫描', status: 'failed', count: 0, detail: '热榜不可用', errorCode: readiness.code };
      let read: Awaited<ReturnType<typeof readZhihuHotViaBrowser>>;
      try {
        read = await readFn(database);
      } catch (scanErr) {
        const code = (scanErr as { code?: string })?.code ?? null;
        if (code && String(code).includes('NEEDS') || String(code).includes('needs_user') || String((scanErr as Error).message).includes('登录') || String((scanErr as Error).message).includes('验证')) {
          return { stage: 'B', name: '热榜扫描', status: 'needs_user', errorCode: code ?? 'ZHIHU_NEEDS_LOGIN', detail: scanErr instanceof Error ? scanErr.message : String(scanErr), blocked: 1 };
        }
        if (code === 'ZHIHU_HOT_DOM_DRIFT') return { stage: 'B', name: '热榜扫描', status: 'failed', errorCode: code, detail: scanErr instanceof Error ? scanErr.message : String(scanErr) };
        return { stage: 'B', name: '热榜扫描', status: 'failed', errorCode: code, detail: scanErr instanceof Error ? scanErr.message : String(scanErr) };
      }
      const workspaceId = resolveWorkspaceId(database);
      const taskId = deterministicJobId(workspaceId, businessDate, 'B');
      try {
        const persisted = await runMutation(overrides, context, {
          command: 'zhihu_hot.scan_commit', entityType: 'source_scan_receipt', entityId: taskId,
          execute: () => commitFn(database, { taskId, workspaceId, businessDate }, read)
        });
        return { stage: 'B', name: '热榜扫描', status: 'completed', count: (persisted as { savedCount: number }).savedCount, detail: `观测 ${(persisted as { savedCount: number }).savedCount} 条` };
      } catch (persistErr) {
        const code = (persistErr as { code?: string })?.code ?? null;
        if (code && String(code).includes('NEEDS')) return { stage: 'B', name: '热榜扫描', status: 'needs_user', errorCode: code, detail: persistErr instanceof Error ? persistErr.message : String(persistErr), blocked: 1 };
        return { stage: 'B', name: '热榜扫描', status: 'failed', errorCode: code, detail: persistErr instanceof Error ? persistErr.message : String(persistErr) };
      }
    } catch (e) {
      const code = (e as {code?:string})?.code ?? null;
      if (code && String(code).includes('needs_user')) return { stage: 'B', name: '热榜扫描', status: 'needs_user', errorCode: code, detail: e instanceof Error ? e.message : String(e), blocked: 1 };
      return { stage: 'B', name: '热榜扫描', status: 'failed', errorCode: code, detail: e instanceof Error ? e.message : String(e) };
    }
  };
}

function createProductionStageC(overrides: ProductionOrchestrationOverrides): StageHandler {
  return async (database: DatabaseSync, businessDate: string, context?: OrchestrationContext): Promise<StageResult> => {
    const ensureCycle = overrides.ensureDailyCycleInternal ?? ensureDailyCycleInternal;
    const getProj = overrides.getDailyCycleProjection ?? getDailyCycleProjection;
    try {
      // ensure cycle exists via persisted scoring/quota (targetCount from app_meta)
      try {
        await runMutation(overrides, context, {
          command: 'daily_content_cycle.ensure', entityType: 'daily_content_cycle', entityId: businessDate,
          execute: () => ensureCycle(database, businessDate)
        });
      } catch (e) {
        const code = (e as {code?:string})?.code;
        if (code === 'NEEDS_USER') return { stage: 'C', name: '评分选题', status: 'needs_user', errorCode: code as string, detail: e instanceof Error ? e.message : String(e), blocked: 1 };
        throw e;
      }
      const after = getProj(database, businessDate);
      const gap = after.shortage.remainingGap;
      const targetCount = after.shortage.targetCount;
      const selected = after.shortage.selectedCount;
      const status = gap > 0 ? 'partial' as const : 'completed' as const;
      return { stage: 'C', name: '评分选题', status, count: selected, gap, detail: gap ? `已选 ${selected}/${targetCount} 缺口 ${gap}` : `已配齐 ${selected}/${targetCount}` };
    } catch (e) {
      const code = (e as {code?:string})?.code ?? null;
      if (code === 'NEEDS_USER' || String(code).includes('NEEDS_USER')) return { stage: 'C', name: '评分选题', status: 'needs_user', errorCode: code, detail: e instanceof Error ? e.message : String(e), blocked: 1 };
      return { stage: 'C', name: '评分选题', status: 'failed', errorCode: code, detail: e instanceof Error ? e.message : String(e) };
    }
  };
}

function createProductionStageD(overrides: ProductionOrchestrationOverrides): StageHandler {
  return async (database: DatabaseSync, businessDate: string, context?: OrchestrationContext): Promise<StageResult> => {
    const getProj = overrides.getDailyCycleProjection ?? getDailyCycleProjection;
    const advancer = overrides.advanceApprovedPlanItem ?? advanceApprovedPlanItem;
    try {
      // Only the current day's explicitly Owner-approved plan may enter production.
      // Legacy migrations and historical system approvals are not construction permission.
      const approvedRows = database.prepare(`
        SELECT pi.id
        FROM plan_items pi
        JOIN plans p ON p.id = pi.plan_id
        WHERE p.plan_date = ?
          AND p.is_current = 1
          AND EXISTS (
            SELECT 1
            FROM json_each(pi.planning_provenance_json, '$.transitions') transition
            WHERE json_extract(transition.value, '$.to') = 'approved'
              AND json_extract(transition.value, '$.by') = 'owner_ui'
          )
        ORDER BY pi.updated_at DESC
      `).all(businessDate) as Array<{ id:string }>;
      if (!approvedRows.length) {
        return { stage: 'D', name: '研究与文章', status: 'skipped', detail: '今日无 Owner 已批准策划' };
      }
      let enqueued = 0; let reused = 0; let reporter = 0; let writer = 0;
      for (const row of approvedRows) {
        try {
          // Use runMutation to keep command envelope audit if overrides provide executor
          const res = await runMutation(overrides, context, {
            command: 'plan_item.advance',
            entityType: 'plan_item',
            entityId: row.id,
            execute: () => advancer(database, row.id) as unknown as Record<string, unknown>
          }) as { role?: string; reusedJob?: boolean; reusedProject?: boolean };
          if (res.role === 'reporter') reporter++;
          if (res.role === 'writer') writer++;
          if (res.reusedJob) reused++; else enqueued++;
        } catch (e) {
          // If advance fails due to not approved etc., skip
          if ((e as { code?: string })?.code === 'conflict') continue;
          throw e;
        }
      }
      if (enqueued===0 && reused>0) return { stage: 'D', name: '研究与文章', status: 'completed', count: reused, detail: `复用 ${reused} 推进 (${reporter}研究/${writer}写作)` };
      return { stage: 'D', name: '研究与文章', status: 'completed', count: enqueued+reused, detail: `推进 ${enqueued+reused} (${reporter}研究/${writer}写作)` };
    } catch (e) {
      return { stage: 'D', name: '研究与文章', status: 'failed', errorCode: (e as {code?:string})?.code ?? null, detail: e instanceof Error ? e.message : String(e) };
    }
  };
}

function createProductionStageE(_overrides: ProductionOrchestrationOverrides): StageHandler {
  return async (_database: DatabaseSync, _businessDate: string, _context?: OrchestrationContext): Promise<StageResult> => {
    return {
      stage: 'E',
      name: '视频文案',
      status: 'skipped',
      errorCode: 'CUTOVER_REQUIRED',
      detail: 'legacy video producer disabled; submit a typed Actor intent through submitWorkspaceOrchestratorIntent',
    };
  };
}

export function createProductionDailyHandlers(overrides: ProductionOrchestrationOverrides = {}): DailyOrchestrationDeps {
  return {
    stageA: createProductionStageA(overrides),
    stageB: createProductionStageB(overrides),
    stageC: createProductionStageC(overrides),
    stageD: createProductionStageD(overrides),
    stageE: createProductionStageE(overrides),
    persistSettlement: async (database, settlement, context) => {
      await runMutation(overrides, context, {
        command: 'daily_orchestration.settle', entityType: 'daily_orchestration', entityId: settlement.businessDate,
        execute: () => { saveSettlement(database, settlement); return settlement; }
      });
    },
  };
}

// keep a singleton for production wiring verification (shared instance check)
let _productionDepsSingleton: DailyOrchestrationDeps | null = null;
export function getProductionDailyHandlersSingleton(overrides: ProductionOrchestrationOverrides = {}): DailyOrchestrationDeps {
  if (!_productionDepsSingleton && Object.keys(overrides).length === 0) {
    _productionDepsSingleton = createProductionDailyHandlers();
  }
  if (Object.keys(overrides).length === 0) return _productionDepsSingleton!;
  return createProductionDailyHandlers(overrides);
}
export function _resetProductionSingletonForTest(): void { _productionDepsSingleton = null; }


function resolveWorkspaceId(database: DatabaseSync): string {
  try {
    const row = database.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get() as { value: string } | undefined;
    if (row?.value) return row.value;
  } catch {}
  return 'default';
}

export function orchestrateDailyContent(input: { database: DatabaseSync; businessDate: string; workspaceId?: string; source: DailyOrchestrationSource; requestId?: string }, _deps: DailyOrchestrationDeps = {}): Promise<DailySettlement> {
  const businessDate = typeof input?.businessDate === 'string' ? input.businessDate.trim() : '';
  const source: DailyOrchestrationSource = input?.source === 'scheduler' || input?.source === 'mcp' || input?.source === 'today' ? input.source : 'today';
  const suppliedWorkspaceId = typeof input?.workspaceId === 'string' ? input.workspaceId.trim() : '';
  const workspaceId = suppliedWorkspaceId || (input?.database ? resolveWorkspaceId(input.database) : 'default');
  const nextAction = buildDailyOrchestrationActorIntent({ businessDate, workspaceId, source, requestId: input?.requestId });
  return Promise.reject(Object.assign(
    new Error('CUTOVER_REQUIRED: orchestrateDailyContent retired; submit the typed intent through the workspace Actor gateway.'),
    {
      code: 'CUTOVER_REQUIRED' as const,
      nextAction,
      details: Object.freeze({ replacement: 'submitWorkspaceOrchestratorIntent', nextAction }),
    },
  ));
}
function saveSettlement(database: DatabaseSync, settlement: DailySettlement): void {
  const key = `daily_orchestration.settlement:${settlement.workspaceId}:${settlement.businessDate}`;
  const existing = database.prepare('SELECT revision FROM app_meta WHERE key=?').get(key) as { revision: number } | undefined;
  const val = JSON.stringify(settlement);
  if (existing) database.prepare('UPDATE app_meta SET value=?, updated_at=?, revision=revision+1 WHERE key=?').run(val, settlement.updatedAt, key);
  else database.prepare('INSERT INTO app_meta (key,value,created_at,updated_at,revision) VALUES (?,?,?,?,1)').run(key, val, settlement.createdAt, settlement.updatedAt);
}


async function runOrchestration(input: { database: DatabaseSync; businessDate: string; workspaceId: string; source: DailyOrchestrationSource }, deps: DailyOrchestrationDeps): Promise<DailySettlement> {
  const { database, businessDate, workspaceId, source } = input;
  const handlers: Record<StageKey, StageHandler> = {
    A: deps.stageA ?? createProductionStageA({}),
    B: deps.stageB ?? createProductionStageB({}),
    C: deps.stageC ?? createProductionStageC({}),
    D: deps.stageD ?? createProductionStageD({}),
    E: deps.stageE ?? createProductionStageE({}),
  };
  const stages: StageResult[] = [];
  for (const key of ['A','B','C','D','E'] as StageKey[]) {
    try {
      const r = await handlers[key](database, businessDate, { workspaceId, source });
      stages.push(r);
    } catch (e) {
      stages.push({ stage: key, name: key, status: 'failed', errorCode: (e as {code?:string})?.code ?? 'STAGE_FAILED', detail: e instanceof Error ? e.message : String(e) });
    }
  }
  let targetCount = 2;
  try { targetCount = getScoringSettings(database).targetCount; } catch {}
  let completed = 0; let skipped = 0; let carried = 0; let blocked = 0; let gap = 0; let autoSelected = 0; let ownerSelected = 0;
  try {
    const proj = getDailyCycleProjection(database, businessDate);
    const cycle = proj.cycle as { target_count: number; status: string } | null;
    if (cycle) targetCount = Number(cycle.target_count) || targetCount;
    const targets = (proj.targets ?? []) as Array<Record<string, unknown>>;
    for (const t of targets) {
      const st = String((t as { status: string }).status);
      const sel = String((t as { selection_mode: string }).selection_mode ?? '');
      if (sel === 'automatic') autoSelected++;
      else if (sel === 'owner_approved') ownerSelected++;
      if (st === 'completed') completed++;
      if (st === 'skipped') skipped++;
      if (st === 'carried') carried++;
      if (st === 'blocked') blocked++;
    }
    const newContentTargets = targets.filter(t => (t as {target_kind:string}).target_kind === 'new_content' && (t as {counts_toward_goal:number}).counts_toward_goal===1 && !['skipped','carried'].includes(String((t as {status:string}).status))).length;
    gap = Math.max(0, targetCount - newContentTargets);
    if (!targets.length) gap = proj.shortage.remainingGap;
  } catch {}
  for (const s of stages) if (s.blocked) blocked = Math.max(blocked, s.blocked);
  for (const s of stages) if (s.skipped) skipped = Math.max(skipped, s.skipped ?? 0);
  for (const s of stages) if (s.carried) carried = Math.max(carried, s.carried ?? 0);
  // paused > needs_user > partial/failed > completed
  let status: DailySettlement['status'] = 'completed';
  try {
    const cyc = database.prepare('SELECT status FROM daily_content_cycles WHERE business_date=?').get(businessDate) as { status: string } | undefined;
    if (cyc?.status === 'paused' || stages.some(s => s.status === 'paused')) status = 'paused';
    else if (stages.some(s => s.status === 'needs_user')) status = 'needs_user';
    else if (stages.some(s => s.status === 'partial') || gap > 0 || blocked > 0) status = 'partial';
    else if (stages.some(s => s.status === 'failed')) {
      const allFailed = stages.every(s => s.status === 'failed' || s.status === 'skipped');
      status = allFailed ? 'failed' : 'partial';
    }
    else status = 'completed';
  } catch {
    if (stages.some(s => s.status === 'needs_user')) status = 'needs_user';
    else if (stages.some(s => s.status === 'paused')) status = 'paused';
    else if (stages.some(s => s.status === 'partial' || s.status === 'failed') || gap>0) status = 'partial';
  }
  const readable = buildReadable(businessDate, status, stages, { targetCount, completed, gap, skipped, carried, blocked, autoSelected, ownerSelected });
  const ts = nowIso();
  const settlement: DailySettlement = {
    businessDate, workspaceId, source, status, stages,
    counts: { targetCount, completed, gap, skipped, carried, blocked, autoSelected, ownerSelected },
    readable, createdAt: ts, updatedAt: ts,
  };
  if (deps.persistSettlement) {
    await deps.persistSettlement(database, settlement, { workspaceId, source });
  } else {
    try { saveSettlement(database, settlement); } catch {}
  }
  return settlement;
}

export function getPersistedSettlement(database: DatabaseSync, workspaceId: string, businessDate: string): DailySettlement | null {
  try {
    const key = `daily_orchestration.settlement:${workspaceId}:${businessDate}`;
    const row = database.prepare('SELECT value FROM app_meta WHERE key=?').get(key) as { value: string } | undefined;
    if (!row?.value) return null;
    return JSON.parse(row.value) as DailySettlement;
  } catch { return null; }
}
