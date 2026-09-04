import type { DatabaseSync } from 'node:sqlite';
import { ensureAutomaticTaskGrant } from './task-grants.ts';
import { readDailyReceiptAggregation, type AgentTask } from './agent-tasks.ts';
import { startWorkspaceDailyIntelligence } from './workspace-intelligence.ts';
import {
  createWorkspaceOrchestratorActorStore,
  hashV1,
  readWorkspaceOrchestratorActor,
  type ActorFence,
} from './workspace-orchestrator-actor.ts';
import { createWorkspaceOrchestratorRootStageStore } from './workspace-orchestrator-root-stage.ts';
import { createWorkspaceOrchestratorSnapshotStore } from './workspace-orchestrator-snapshots.ts';
import { createWorkspaceOrchestratorResourceAdmissionStore } from './workspace-orchestrator-resource-admission.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';

type Row = Record<string, unknown>;
type RuntimeMcp = { url: string; close: () => Promise<void> | void };
type RuntimeXhs = { getUrl: () => string; stop: () => Promise<void> | void };
type ExecutorState = { running: boolean; queued: boolean; stopped: boolean; promise: Promise<void> | null };
type PlanCandidateRows = { planIds: string[]; eligible: string[]; pending: string[]; invalid: string[] };

const states = new WeakMap<ActiveWorkspaceRuntime, ExecutorState>();
const SUPPORTED_ACTIONS: Record<string, true> = { full: true, scan: true, stage_d: true };

function jsonArray(value: unknown): Row[] {
  if (Array.isArray(value)) return value.filter((item): item is Row => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
  if (typeof value !== 'string' || !value.trim()) return [];
  try { return jsonArray(JSON.parse(value)); } catch { return []; }
}

function currentFence(database: DatabaseSync, workspaceId: string): ActorFence {
  const actor = readWorkspaceOrchestratorActor(database, workspaceId);
  if (!actor?.leaseToken) throw Object.assign(new Error('workspace Actor fence 不可用。'), { code: 'EXECUTION_AUTHORIZATION_INVALID' });
  return Object.freeze({
    workspaceId,
    runtimeEpoch: actor.runtimeEpoch,
    ownerEpoch: actor.ownerEpoch,
    authorityRevision: actor.authorityRevision,
    leaseToken: actor.leaseToken,
    checkpointRevision: actor.checkpointRevision,
  });
}

function tableCount(database: DatabaseSync, table: string): number {
  try { return Number((database.prepare(`SELECT COUNT(*) AS count FROM "${table}" WHERE enabled=1`).get() as { count?: unknown } | undefined)?.count ?? 0); }
  catch { return 0; }
}

function nextIntent(database: DatabaseSync, workspaceId: string): Row | null {
  const rows = database.prepare(`SELECT i.*, m.mailbox_sequence, m.state AS mailbox_state
    FROM orchestrator_mailbox m
    JOIN orchestrator_intents i ON i.workspace_id=m.workspace_id AND i.intent_id=m.intent_id
    WHERE m.workspace_id=? AND m.state='enqueued' AND i.status IN ('received','preflight_pending','preflight_running')
    ORDER BY m.priority DESC, m.mailbox_sequence ASC LIMIT 16`).all(workspaceId) as Row[];
  return rows.find((row) => SUPPORTED_ACTIONS[String(row.requested_action)] === true) ?? null;
}

function preflightResults(database: DatabaseSync, intent: Row): Row[] {
  const policy = jsonArray(intent.channel_policy_json);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60_000);
  return policy.map((entry) => {
    const channelId = String(entry.channelId ?? entry.channel_id ?? entry.module ?? '').trim();
    const requiredness = String(entry.requiredness ?? 'optional') === 'required' ? 'required' : 'optional';
    const configured = channelId === 'official_web'
      ? tableCount(database, 'website_sources') > 0
      : channelId === 'x_lists'
        ? tableCount(database, 'x_list_bindings') > 0
        : false;
    return configured ? {
      channelId,
      requiredness,
      status: 'ready',
      capability: { ok: true, channelId },
      configRevision: 1,
      authRevision: 1,
      capabilityRevision: 1,
      capabilityLeaseId: `runtime:${channelId}:${String(intent.intent_id)}`,
      checkedAtUtc: now.toISOString(),
      expiresAtUtc: expiresAt.toISOString(),
      expiresAtMono: Date.now() + 10 * 60_000,
      probeRequestId: `preflight:${String(intent.intent_id)}:${channelId}`,
      probeReceiptHash: hashV1({ channelId, configured: true, intentId: intent.intent_id }),
    } : {
      channelId,
      requiredness,
      status: 'not_configured',
      reasonCode: 'CHANNEL_NOT_CONFIGURED',
      reason: `${channelId} 未配置启用来源。`,
      checkedAtUtc: now.toISOString(),
      expiresAtUtc: expiresAt.toISOString(),
      expiresAtMono: Date.now() + 10 * 60_000,
      probeRequestId: `preflight:${String(intent.intent_id)}:${channelId}`,
      probeReceiptHash: hashV1({ channelId, configured: false, intentId: intent.intent_id }),
    };
  });
}

async function withWorker<T>(runtime: ActiveWorkspaceRuntime, roleId: 'reporter' | 'planner', work: (hooks: {
  workerLeaseId: string;
  onTaskReady: (taskId: string) => Promise<string>;
  onRuntime: (worker: { stop: () => Promise<void> | void }) => void;
}) => Promise<T>): Promise<T> {
  const lease = runtime.acquireWorkerLease(null, roleId, 'employee');
  let worker: { stop: () => Promise<void> | void } | null = null;
  runtime.bindWorker(lease, { stop: async () => { await worker?.stop(); } });
  try {
    return await work({
      workerLeaseId: lease.leaseId,
      onTaskReady: async (taskId) => {
        runtime.bindWorkerTask(lease, taskId);
        return ensureAutomaticTaskGrant(runtime, taskId, new Date(), roleId);
      },
      onRuntime: (value) => { worker = value; },
    });
  } finally {
    runtime.releaseWorker(lease);
  }
}

function settleDispatch(runtime: ActiveWorkspaceRuntime, stageRequestId: string, task: Pick<AgentTask, 'id' | 'status' | 'phase'>, roleId: 'reporter' | 'judge'): void {
  const database = runtime.database;
  const store = createWorkspaceOrchestratorResourceAdmissionStore(database);
  const dispatch = store.listDispatches(runtime.identity.workspaceId, roleId).find((entry) => entry.stageRequestId === stageRequestId);
  if (!dispatch || ['terminal', 'cancelled', 'orphaned'].includes(dispatch.state)) return;
  const terminalStatus = task.status === 'succeeded' ? 'succeeded' : task.status === 'cancelled' ? 'cancelled' : task.status === 'needs_user' ? 'needs_user' : 'partial';
  const result = store.settleTerminal({
    workspaceId: runtime.identity.workspaceId,
    jobId: dispatch.jobId,
    childIdentityKey: dispatch.childIdentityKey,
    operationRequestId: dispatch.operationRequestId,
    parentStageRequestId: dispatch.parentStageRequestId,
    expectedParentClaimRevision: dispatch.expectedParentClaimRevision,
    launchAttemptId: dispatch.launchAttemptId,
    launchTokenHash: dispatch.launchTokenHash,
    argvHash: dispatch.argvHash,
    cwdFingerprint: dispatch.cwdFingerprint,
    sessionKey: dispatch.sessionKey,
    terminalStatus,
    result: { taskId: task.id, taskStatus: task.status, phase: task.phase },
    fence: currentFence(database, runtime.identity.workspaceId),
    nowUtc: new Date().toISOString(),
    nowMono: Date.now(),
  });
  if (!result.ok) throw Object.assign(new Error(result.message), { code: result.code });
}

function channelFence(preflightResult: Row, profileRevision: number, policyHash: string): Row {
  return {
    ...preflightResult,
    channelId: String(preflightResult.channelId),
    profileRevision,
    policyHash,
    status: 'ready',
    ready: true,
    revoked: false,
    authStatus: 'ready',
    configStatus: 'ready',
  };
}

function planRows(database: DatabaseSync, businessDate: string): PlanCandidateRows {
  const rows = database.prepare(`SELECT p.id AS plan_id, pi.id, pi.planning_status
    FROM plans p JOIN plan_items pi ON pi.plan_id=p.id
    WHERE p.plan_date=? AND p.is_current=1 AND pi.planning_status!='approved'
    ORDER BY pi.id`).all(businessDate) as Array<{ plan_id: string; id: string; planning_status: string }>;
  const planIds = [...new Set(rows.map((row) => String(row.plan_id)))].sort();
  const eligible = rows.filter((row) => row.planning_status === 'ready_for_review').map((row) => String(row.id)).sort();
  const pending = rows.filter((row) => row.planning_status === 'draft').map((row) => String(row.id)).sort();
  const invalid = rows.filter((row) => row.planning_status === 'rejected').map((row) => String(row.id)).sort();
  return { planIds, eligible, pending, invalid };
}

async function withActorHeartbeat<T>(runtime: ActiveWorkspaceRuntime, work: () => Promise<T>): Promise<T> {
  let stopped = false;
  let heartbeatError: unknown = null;
  let inflight: Promise<void> | null = null;
  const beat = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inflight) return inflight;
    inflight = runtime.runActorControlPlane(() => {
      const store = createWorkspaceOrchestratorActorStore(runtime.database);
      store.renewActorLease({
        workspaceId: runtime.identity.workspaceId,
        fence: currentFence(runtime.database, runtime.identity.workspaceId),
      });
    }).catch((error) => {
      heartbeatError ??= error;
    }).finally(() => {
      inflight = null;
    });
    return inflight;
  };
  await beat();
  if (heartbeatError) throw heartbeatError;
  const timer = setInterval(() => void beat(), 10_000);
  timer.unref?.();
  try {
    const result = await work();
    await beat();
    if (heartbeatError) throw heartbeatError;
    return result;
  } finally {
    stopped = true;
    clearInterval(timer);
    if (inflight) await inflight;
  }
}

async function processIntent(runtime: ActiveWorkspaceRuntime, intent: Row): Promise<void> {
  const database = runtime.database;
  const workspaceId = runtime.identity.workspaceId;
  const actorStore = createWorkspaceOrchestratorActorStore(database);
  const rootStore = createWorkspaceOrchestratorRootStageStore(database);
  const snapshotStore = createWorkspaceOrchestratorSnapshotStore(database);
  const results = preflightResults(database, intent);
  const closed = await runtime.runActorControlPlane(() => actorStore.closePreflight({
    workspaceId,
    intentId: String(intent.intent_id),
    requestId: String(intent.request_id),
    profileRevision: Number(intent.profile_revision ?? 1),
    channelResults: results,
    fence: currentFence(database, workspaceId),
  }));
  if (!closed.ok) throw Object.assign(new Error(closed.message), { code: closed.code });
  if (closed.status !== 'admitted') return;

  const admitted = await runtime.runActorControlPlane(() => rootStore.admitRoot({
    workspaceId,
    intentId: String(intent.intent_id),
    requestId: String(intent.request_id),
    fence: currentFence(database, workspaceId),
    envelope: { executable: process.execPath, argv: ['workspace-orchestrator-executor'], cwd: runtime.identity.rootPath },
  }));
  if (!admitted.ok) throw Object.assign(new Error(admitted.message), { code: admitted.code });
  if (!admitted.root) throw new Error('root admission returned no root');
  const rootRequestId = String(admitted.root.root_request_id);
  const initialBundle = rootStore.readRoot(workspaceId, rootRequestId);
  const initialClaim = initialBundle.claims.find((claim) => String(claim.attempt_stage) !== 'judge');
  if (!initialClaim) throw new Error('initial claim missing');
  if (String(intent.requested_action) === 'stage_d') {
    throw Object.assign(new Error('stage_d no longer owns content production'), { code: 'UNSUPPORTED_ACTION' });
  }
  const scanClaim = initialClaim;
  const selectedChannels = jsonArray(intent.channel_policy_json).map((entry) => String(entry.channelId ?? entry.channel_id ?? entry.module));
  const modules = selectedChannels.filter((value): value is 'official_web' | 'x_lists' => value === 'official_web' || value === 'x_lists');
  const mcp = runtime.getMcp<RuntimeMcp>();
  if (!mcp?.url) throw Object.assign(new Error('WMB MCP 尚未就绪。'), { code: 'WORKSPACE_BUSY' });

  const scan = await withWorker(runtime, 'reporter', (hooks) => startWorkspaceDailyIntelligence({
    dataRootPath: runtime.identity.rootPath,
    businessDate: String(intent.business_date),
    mcpUrl: mcp.url,
    xhsMcpUrl: runtime.getXhs<RuntimeXhs>()?.getUrl() ?? '',
    modules,
    scanOnly: true,
    activeRuntime: runtime,
    ...hooks,
  }));
  await runtime.runActorControlPlane(() => settleDispatch(runtime, String(scanClaim.stage_request_id), scan.task, 'reporter'));

  const aggregation = readDailyReceiptAggregation(database, scan.task);
  const receipts = aggregation.receipts;
  const preflight = database.prepare('SELECT * FROM channel_preflight_snapshots WHERE workspace_id=? AND preflight_id=?').get(workspaceId, closed.preflightId) as Row;
  const preflightRows = jsonArray(preflight.results_json);
  const representative = new Map<string, typeof receipts[number]>();
  for (const receipt of receipts) if (receipt.status === 'succeeded' && !representative.has(receipt.module)) representative.set(receipt.module, receipt);
  const successfulChannels: Array<Row & { channelId: string; requiredness: 'required' | 'optional'; receiptId: string; receiptRevision: number; receiptPayloadHash: string; resultHash: string }> = selectedChannels.flatMap((channelId) => {
    const receipt = representative.get(channelId);
    if (!receipt) return [];
    const base = preflightRows.find((entry) => String(entry.channelId ?? entry.channel_id) === channelId) ?? {};
    const requiredness: 'required' | 'optional' = channelId === 'official_web' ? 'required' : 'optional';
    return [{ ...channelFence(base, Number(preflight.profile_revision), String(preflight.policy_hash)), channelId, requiredness, receiptId: receipt.id, receiptRevision: receipt.revision, receiptPayloadHash: hashV1(receipt), resultHash: hashV1({ status: receipt.status, savedCount: receipt.savedCount }) }];
  });
  const failedChannels: Array<{ channelId: string; requiredness: 'required' | 'optional'; reasonCode: string }> = selectedChannels.filter((channelId) => !representative.has(channelId)).map((channelId) => ({ channelId, requiredness: channelId === 'official_web' ? 'required' : 'optional', reasonCode: receipts.find((receipt) => receipt.module === channelId)?.errorCode ?? 'CHANNEL_SCAN_EMPTY' }));
  const receiptBindings = receipts.map((receipt) => ({ receiptId: receipt.id, receiptRevision: receipt.revision, receiptPayloadHash: hashV1(receipt) }));
  const sourceBindings = receipts.map((receipt) => ({ sourceId: receipt.sourceFeedId, sourceRevision: receipt.revision, sourceContentHash: hashV1(receipt) }));
  const currentChannelFences = selectedChannels.map((channelId) => {
    const base = preflightRows.find((entry) => String(entry.channelId ?? entry.channel_id) === channelId) ?? {};
    const fence = channelFence(base, Number(preflight.profile_revision), String(preflight.policy_hash));
    return { ...fence, channelId, expiresAtMono: Number(fence.expiresAtMono ?? Date.now() + 10 * 60_000) };
  });
  const frozen = await runtime.runActorControlPlane(() => snapshotStore.freezeSourceSnapshot({
    workspaceId,
    rootRequestId,
    rootGeneration: Number(admitted.root!.root_generation),
    rootInputHash: String(admitted.root!.root_input_hash),
    stageRequestId: String(scanClaim.stage_request_id),
    sourceTaskId: scan.task.id,
    scanAttemptId: String(scanClaim.stage_request_id),
    preflightId: closed.preflightId,
    policyHash: String(preflight.policy_hash),
    profileRevision: Number(preflight.profile_revision),
    selectedChannelIds: selectedChannels,
    successfulChannels,
    failedChannels,
    unresolvedChannels: [],
    sourceBindings,
    sourceIds: sourceBindings.map((entry) => entry.sourceId),
    receiptIds: receiptBindings.map((entry) => entry.receiptId),
    receiptBindings,
    currentChannelFences,
    watermarkUtc: new Date().toISOString(),
    watermarkMono: Date.now(),
    capturedAtUtc: new Date().toISOString(),
    fence: currentFence(database, workspaceId),
  }));
  if (!frozen.ok) throw Object.assign(new Error(frozen.message), { code: frozen.code });

  const trustedReceiptIds = successfulChannels.map((entry) => String(entry.receiptId)).sort();
  const freezeProjection = async (stageRequestId: string, candidateRows: PlanCandidateRows, emptyQualified?: boolean) => {
    const candidate = [...candidateRows.eligible, ...candidateRows.pending, ...candidateRows.invalid].sort();
    const entries = candidate.map((planItemId) => ({ planItemId, classification: candidateRows.eligible.includes(planItemId) ? 'eligible' : candidateRows.pending.includes(planItemId) ? 'pending' : 'invalid', sourceReceiptIds: trustedReceiptIds }));
    const result = await runtime.runActorControlPlane(() => snapshotStore.freezePlanScopeProjection({
      workspaceId,
      rootRequestId,
      rootGeneration: Number(admitted.root!.root_generation),
      rootInputHash: String(admitted.root!.root_input_hash),
      stageRequestId,
      sourceSnapshotHash: frozen.value.snapshotHash,
      managerTaskId: String(admitted.root!.manager_task_id),
      orchestrationId: String(admitted.root!.orchestration_id),
      allowedPlanIds: candidateRows.planIds,
      allowedPlanItemIds: candidate,
      trustedReceiptIds,
      scope: { sourceTaskId: scan.task.id },
      projection: { planIds: candidateRows.planIds, asOf: { utc: new Date().toISOString(), mono: Date.now() }, entries, candidatePlanItemIds: candidate, eligiblePlanItemIds: candidateRows.eligible, pendingPlanItemIds: candidateRows.pending, invalidPlanItemIds: candidateRows.invalid },
      candidateInputCount: candidate.length,
      classifiedCount: candidate.length,
      coverageGap: failedChannels,
      ...(emptyQualified === undefined ? {} : { emptyQualified }),
      fence: currentFence(database, workspaceId),
    }));
    if (!result.ok) throw Object.assign(new Error(result.message), { code: result.code });
  };

  if (String(intent.requested_action) === 'scan' || Number(scan.savedCount ?? 0) === 0 || scan.task.status !== 'running') {
    await freezeProjection(String(scanClaim.stage_request_id), { planIds: [], eligible: [], pending: [], invalid: [] }, failedChannels.length === 0);
    return;
  }

  const handoff = await runtime.runActorControlPlane(() => rootStore.handoffToJudge({
    workspaceId,
    rootRequestId,
    stageRequestId: String(scanClaim.stage_request_id),
    sourceSnapshotHash: frozen.value.snapshotHash,
    currentChannelFences,
    fence: currentFence(database, workspaceId),
    envelope: { executable: process.execPath, argv: ['workspace-orchestrator-judge'], cwd: runtime.identity.rootPath },
  }));
  if (!handoff.ok) throw Object.assign(new Error(handoff.message), { code: handoff.code });
  const judgeClaim = handoff.claim;
  if (!judgeClaim) throw new Error('judge claim missing');
  const judge = await withWorker(runtime, 'planner', (hooks) => startWorkspaceDailyIntelligence({
    dataRootPath: runtime.identity.rootPath,
    businessDate: String(intent.business_date),
    mcpUrl: mcp.url,
    xhsMcpUrl: runtime.getXhs<RuntimeXhs>()?.getUrl() ?? '',
    modules,
    judgeOnly: true,
    activeRuntime: runtime,
    ...hooks,
  }));
  await runtime.runActorControlPlane(() => settleDispatch(runtime, String(judgeClaim.stage_request_id), judge.task, 'judge'));
  await freezeProjection(String(judgeClaim.stage_request_id), planRows(database, String(intent.business_date)));
}

function executionErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return 'EXECUTOR_FAILED';
}

async function drain(runtime: ActiveWorkspaceRuntime, state: ExecutorState): Promise<void> {
  if (state.running || state.stopped || !runtime.isActive) return;
  state.running = true;
  try {
    while (!state.stopped && runtime.isActive) {
      state.queued = false;
      const intent = nextIntent(runtime.database, runtime.identity.workspaceId);
      if (!intent) break;
      try {
        await withActorHeartbeat(runtime, () => processIntent(runtime, intent));
      } catch (error) {
        const code = executionErrorCode(error);
        const reason = error instanceof Error ? error.message : String(error);
        const root = runtime.database.prepare("SELECT root_request_id FROM daily_orchestration_roots WHERE workspace_id=? AND intent_id=? AND status IN ('created','running','waiting_owner')").get(runtime.identity.workspaceId, String(intent.intent_id)) as { root_request_id?: string } | undefined;
        if (root?.root_request_id) {
          const rootStore = createWorkspaceOrchestratorRootStageStore(runtime.database);
          await runtime.runActorControlPlane(() => rootStore.cancelRoot({ workspaceId: runtime.identity.workspaceId, rootRequestId: root.root_request_id!, reasonCode: code, reason, fence: currentFence(runtime.database, runtime.identity.workspaceId) }));
        } else {
          const actorStore = createWorkspaceOrchestratorActorStore(runtime.database);
          await runtime.runActorControlPlane(() => actorStore.closePreflight({ workspaceId: runtime.identity.workspaceId, intentId: String(intent.intent_id), requestId: String(intent.request_id), profileRevision: Number(intent.profile_revision ?? 1), channelResults: [{ channelId: 'executor', status: 'failed', requiredness: 'required', reasonCode: code, reason }], fence: currentFence(runtime.database, runtime.identity.workspaceId) }));
        }
      }
    }
  } finally {
    state.running = false;
  }
}

function schedule(runtime: ActiveWorkspaceRuntime, state: ExecutorState): void {
  if (state.promise || state.stopped || !runtime.isActive) return;
  const attempt = drain(runtime, state);
  state.promise = attempt;
  void attempt.then(
    () => {
      state.promise = null;
      if (state.queued && !state.stopped && runtime.isActive) schedule(runtime, state);
    },
    () => { state.promise = null; },
  );
}

export function wakeWorkspaceOrchestratorExecutor(runtime: ActiveWorkspaceRuntime): void {
  let state = states.get(runtime);
  if (!state) {
    state = { running: false, queued: false, stopped: false, promise: null };
    states.set(runtime, state);
  }
  state.queued = true;
  queueMicrotask(() => schedule(runtime, state!));
}

export async function stopWorkspaceOrchestratorExecutor(runtime: ActiveWorkspaceRuntime): Promise<void> {
  const state = states.get(runtime);
  if (!state) return;
  state.stopped = true;
  await state.promise;
  states.delete(runtime);
}
