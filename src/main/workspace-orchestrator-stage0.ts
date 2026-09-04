import { createHash } from 'node:crypto';
import path from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export const WORKSPACE_ORCHESTRATOR_DESIGN = Object.freeze({
  path: 'docs/spark/2026-08-29-workspace-orchestrator-design.md',
  approvedDate: '2026-08-29',
  sha256: 'fb61cd119233f933a743a8a8bee0f63887f10f62755216535d53777bc1a880c6',
  registryVersion: 1,
  eventSchemaVersion: 1,
  defaultBudget: Object.freeze({
    maxSourcesPerRoot: 80,
    reporterConcurrency: 5,
    judgeConcurrency: 1,
    maxEvidenceSuccessors: 2,
    maxStageAttempts: 2,
    rootWallClockMs: 20 * 60_000,
    waitingResourceMs: 90_000
  })
});

export const ORCHESTRATOR_IDENTITY_REGISTRY = Object.freeze([
  'command-replay/v1',
  'invocation/v1',
  'logical-input/v1',
  'root-invocation/v1',
  'orchestration/v1',
  'stage/v1',
  'operation/v1',
  'effect/v2',
  'child/v1',
  'preflight/v1',
  'preflight-snapshot/v1',
  'execution-envelope/v2',
  'producer-attestation/v1',
  'sink-token/v2',
  'mailbox-envelope/v1',
  'source-snapshot/v1',
  'repair-snapshot-id/v1',
  'repair-binding-child/v1',
  'repair-snapshot/v2',
  'repair-binding/v2',
  'plan-scope/v1',
  'projection/v2',
  'eligible-ids/v1',
  'target-set/v1',
  'effect-set/v1',
  'settlement/v1'
] as const);

export type OrchestratorIntentSource =
  | 'today_ui'
  | 'proposal_ui'
  | 'mcp'
  | 'scheduler_0900'
  | 'rolling_scan'
  | 'content_cycle'
  | 'orphan_reconcile';

export type StageZeroProducer = Readonly<{
  producerId: string;
  sourceLocation: string;
  trigger: string;
  intendedSource: OrchestratorIntentSource;
  intendedAction: 'full' | 'scan' | 'judge' | 'stage_d' | 'reconcile';
  currentDirectAction: string;
  replacementRoute: string;
  writeTables: readonly string[];
  processOrSession: string | null;
  legacyDirect: boolean;
}>;

export const WORKSPACE_ORCHESTRATOR_PRODUCER_CENSUS: readonly StageZeroProducer[] = Object.freeze([
  {
    producerId: 'today.agent-start-daily-intelligence', sourceLocation: "src/main/index.ts:ipcMain.handle('agent:start-daily-intelligence')",
    trigger: 'Owner Today intelligence action', intendedSource: 'today_ui', intendedAction: 'full',
    currentDirectAction: 'Typed full intent submission through the workspace Actor gateway',
    replacementRoute: 'submitWorkspaceOrchestratorIntent(today_ui, full) → Actor mailbox',
    writeTables: ['agent_tasks', 'task_grants', 'manager_tasks', 'source_scan_receipts', 'source_items', 'plans', 'plan_items'],
    processOrSession: 'Actor-managed Manager plus Reporter or Planner PiRpcSupervisor child', legacyDirect: false
  },
  {
    producerId: 'today.daily-orchestration', sourceLocation: "src/main/ipc-daily-content-cycle.ts:ipcMain.handle('daily-orchestration:orchestrate')",
    trigger: 'Owner runs daily content orchestration', intendedSource: 'today_ui', intendedAction: 'stage_d', currentDirectAction: 'Typed stage_d intent submission through the workspace Actor gateway',
    replacementRoute: 'submitWorkspaceOrchestratorIntent(today_ui, stage_d) → Actor mailbox',
    writeTables: ['daily_content_cycles', 'daily_content_targets', 'agent_tasks', 'jobs', 'content_versions', 'content_derivative_versions'],
    processOrSession: 'Actor-managed Reporter/Planner/Writer jobs', legacyDirect: false
  },
  {
    producerId: 'today.daily-cycle-ensure', sourceLocation: "src/main/ipc-daily-content-cycle.ts:ipcMain.handle('daily-cycle:ensure')",
    trigger: 'Exposed preload daily-cycle ensure command', intendedSource: 'today_ui', intendedAction: 'stage_d', currentDirectAction: 'Typed cycle stage_d intent submission through the workspace Actor gateway',
    replacementRoute: 'submitWorkspaceOrchestratorIntent(today_ui, stage_d, cycle identity) → Actor mailbox',
    writeTables: ['daily_content_cycles', 'daily_content_targets', 'jobs', 'content_versions', 'content_derivative_versions'],
    processOrSession: 'Actor-managed employee jobs', legacyDirect: false
  },
  {
    producerId: 'ui.jobs-spawn', sourceLocation: "src/main/ipc-jobs.ts:ipcMain.handle('jobs:spawn')",
    trigger: 'Renderer jobsSpawn command', intendedSource: 'today_ui', intendedAction: 'stage_d', currentDirectAction: 'Typed role/action intent submission through the workspace Actor gateway',
    replacementRoute: 'submitWorkspaceOrchestratorIntent(today_ui or proposal_ui, typed role/action) → Actor mailbox',
    writeTables: ['jobs', 'agent_tasks', 'task_grants', 'source_items', 'plans', 'plan_items', 'research_claims', 'content_versions'],
    processOrSession: 'Actor-managed role job with optional PiRpcSupervisor and BrowserProfile CDP', legacyDirect: false
  },
  {
    producerId: 'proposal.candidate-decision', sourceLocation: 'src/main/ipc-today-studio-business.ts and src/main/mcp-business-commands.ts candidate decision handlers',
    trigger: 'Owner or MCP approves, rejects, or repairs a candidate', intendedSource: 'proposal_ui', intendedAction: 'judge',
    currentDirectAction: 'Typed candidate decision intent submission through the workspace Actor gateway',
    replacementRoute: 'submitWorkspaceOrchestratorIntent(proposal_ui, approve_candidates or repair_invalid_candidate) → Actor mailbox',
    writeTables: ['plan_items', 'plans', 'daily_content_targets'], processOrSession: null, legacyDirect: false
  },
  {
    producerId: 'mcp.jobs-spawn', sourceLocation: "src/main/mcp-job-tools.ts:server.registerTool('jobs.spawn')",
    trigger: 'Manager Pi invokes role job spawn', intendedSource: 'mcp', intendedAction: 'stage_d', currentDirectAction: 'Typed role/action intent submission through the workspace Actor gateway',
    replacementRoute: 'submitWorkspaceOrchestratorIntent(mcp, typed role/action) → Actor mailbox',
    writeTables: ['jobs', 'agent_tasks', 'task_grants', 'source_items', 'plans', 'plan_items', 'research_claims', 'content_versions'],
    processOrSession: 'Actor-managed role job with optional PiRpcSupervisor and BrowserProfile CDP', legacyDirect: false
  },
  {
    producerId: 'mcp.daily-run-stage', sourceLocation: "src/main/mcp.ts:server.registerTool('daily.run_stage')",
    trigger: 'MCP explicit scan or full command', intendedSource: 'mcp', intendedAction: 'full',
    currentDirectAction: 'Typed scan or full intent submission through the workspace Actor gateway',
    replacementRoute: 'submitWorkspaceOrchestratorIntent(mcp, requested typed scan or full action) → Actor mailbox',
    writeTables: ['agent_tasks', 'manager_tasks', 'source_scan_receipts', 'source_items', 'plans', 'plan_items'],
    processOrSession: 'Actor-managed Reporter and optional Planner PiRpcSupervisor child', legacyDirect: false
  },
  {
    producerId: 'mcp.daily-orchestrate', sourceLocation: "src/main/mcp.ts:server.registerTool('daily.orchestrate')",
    trigger: 'MCP explicit A-E orchestration command', intendedSource: 'mcp', intendedAction: 'stage_d', currentDirectAction: 'Typed stage_d intent submission through the workspace Actor gateway',
    replacementRoute: 'submitWorkspaceOrchestratorIntent(mcp, stage_d) → Actor mailbox',
    writeTables: ['daily_content_cycles', 'daily_content_targets', 'jobs', 'content_versions', 'content_derivative_versions'], processOrSession: 'Actor-managed employee jobs', legacyDirect: false
  },
  {
    producerId: 'scheduler.daily-0900', sourceLocation: 'src/main/daily-orchestration-scheduler.ts:DailyOrchestrationScheduler.tick',
    trigger: 'Persisted Asia/Shanghai daily timer', intendedSource: 'scheduler_0900', intendedAction: 'stage_d', currentDirectAction: 'Typed scheduled stage_d intent submission through the workspace Actor gateway',
    replacementRoute: 'submitWorkspaceOrchestratorIntent(scheduler_0900, stage_d) → Actor mailbox',
    writeTables: ['daily_content_cycles', 'daily_content_targets', 'jobs', 'content_versions', 'content_derivative_versions'],
    processOrSession: 'Node timeout producing a stable Actor intent identity', legacyDirect: false
  },
  {
    producerId: 'scheduler.rolling-official-web', sourceLocation: 'src/main/index.ts:DailyScanScheduler.run(official_web)',
    trigger: 'Rolling official-web timer', intendedSource: 'rolling_scan', intendedAction: 'scan', currentDirectAction: 'Typed rolling scan intent submission for official_web',
    replacementRoute: 'submitWorkspaceOrchestratorIntent(rolling_scan, scan, official_web) → Actor mailbox',
    writeTables: ['agent_tasks', 'source_scan_receipts', 'source_items'], processOrSession: 'Actor-managed Reporter PiRpcSupervisor child', legacyDirect: false
  },
  {
    producerId: 'scheduler.rolling-x-lists', sourceLocation: 'src/main/index.ts:DailyScanScheduler.run(x_lists)',
    trigger: 'Rolling X Lists timer', intendedSource: 'rolling_scan', intendedAction: 'scan', currentDirectAction: 'Typed rolling scan intent submission for x_lists',
    replacementRoute: 'submitWorkspaceOrchestratorIntent(rolling_scan, scan, x_lists) → Actor mailbox',
    writeTables: ['agent_tasks', 'source_scan_receipts', 'source_items'], processOrSession: 'Actor-managed Reporter PiRpcSupervisor child and BrowserProfile CDP session', legacyDirect: false
  },
  {
    producerId: 'startup.daily-resume', sourceLocation: 'src/main/index.ts:app.whenReady typed daily resume handoff',
    trigger: 'Startup sees a persisted resume or channel-scanned root', intendedSource: 'orphan_reconcile', intendedAction: 'reconcile',
    currentDirectAction: 'Typed startup reconcile intent using original root/stage identity',
    replacementRoute: 'submitWorkspaceOrchestratorIntent(orphan_reconcile, reconcile, original root/stage identity)',
    writeTables: ['agent_tasks', 'source_scan_receipts', 'plans', 'plan_items'], processOrSession: 'Actor-managed Reporter or Planner PiRpcSupervisor child', legacyDirect: false
  },
  {
    producerId: 'startup.refresh-runtime-daily-handoff', sourceLocation: 'src/main/index.ts:refreshRuntime typed daily handoff',
    trigger: 'Runtime refresh finds a channel-scanned or starting/scanning root', intendedSource: 'orphan_reconcile', intendedAction: 'reconcile',
    currentDirectAction: 'Typed startup reconcile intent using original root/stage identity',
    replacementRoute: 'submitWorkspaceOrchestratorIntent(orphan_reconcile, reconcile, original root/stage identity)',
    writeTables: ['agent_tasks', 'source_scan_receipts', 'source_items', 'plans', 'plan_items'], processOrSession: 'Actor-managed Reporter or Planner PiRpcSupervisor child', legacyDirect: false
  },
  {
    producerId: 'reconcile.daily-handoff-sweeper', sourceLocation: 'src/main/index.ts:refreshRuntime and 60-second typed orphan sweep',
    trigger: 'Runtime refresh and 60-second orphan sweep', intendedSource: 'orphan_reconcile', intendedAction: 'reconcile',
    currentDirectAction: 'Typed reconcile intent using original root/stage identity',
    replacementRoute: 'submitWorkspaceOrchestratorIntent(orphan_reconcile, reconcile, original root/stage identity)',
    writeTables: ['agent_tasks', 'source_scan_receipts', 'source_items', 'plans', 'plan_items'], processOrSession: 'Actor-managed Reporter or Planner PiRpcSupervisor child', legacyDirect: false
  },
  {
    producerId: 'reconcile.agent-tasks-recover', sourceLocation: 'src/main/index.ts:refreshRuntime typed agent-task reconcile',
    trigger: 'Each runtime refresh/startup', intendedSource: 'orphan_reconcile', intendedAction: 'reconcile',
    currentDirectAction: 'Typed agent-task reconcile intent under the durable root identity',
    replacementRoute: 'submitWorkspaceOrchestratorIntent(orphan_reconcile, reconcile, original root/stage identity)',
    writeTables: ['agent_tasks'], processOrSession: null, legacyDirect: false
  },
  {
    producerId: 'reconcile.research-successor-scheduler', sourceLocation: 'src/main/research-successor.ts:research successor scheduler',
    trigger: 'Startup plus 10-second pending/stale successor loop', intendedSource: 'orphan_reconcile', intendedAction: 'reconcile',
    currentDirectAction: 'Typed evidence-successor reconcile intent under the original root identity',
    replacementRoute: 'submitWorkspaceOrchestratorIntent(orphan_reconcile, reconcile, original root identity)',
    writeTables: ['research_successor_runs', 'jobs', 'agent_tasks', 'task_grants', 'research_claims', 'content_versions'],
    processOrSession: 'Actor-managed role child', legacyDirect: false
  },
  {
    producerId: 'maintenance.topic-reproposal', sourceLocation: 'src/main/topic-maintenance-reproposal.ts:topic reproposal scheduler',
    trigger: '10-second Topic reproposal maintenance timer', intendedSource: 'content_cycle', intendedAction: 'stage_d',
    currentDirectAction: 'Typed maintenance intent submission through the workspace Actor gateway',
    replacementRoute: 'submitWorkspaceOrchestratorIntent(content_cycle, stage_d, explicitly scoped maintenance identity)',
    writeTables: ['jobs', 'agent_tasks', 'task_grants', 'knowledge_topics', 'plan_items'], processOrSession: 'Actor-managed Librarian role job', legacyDirect: false
  }
]);
export type FrozenProducerRegistryEntry = StageZeroProducer & Readonly<{
  buildId: string;
  triggerId: string;
  allowedIntentKind: string;
  owner: 'workspace_orchestrator';
  writePrincipal: string;
  authorizerRevision: string;
  processImagePath: string;
  resourcesPath: string;
  sourceCommit: string;
  packageHash: string;
  appAsarHash: string;
  schemaEpoch: number;
  cutoverEpoch: number;
  registryEntryHash: string;
  enabled: boolean;
  censusHash: string;
}>;

export type FrozenProducerRegistryManifest = Readonly<{
  buildId: string;
  sourceCommit: string;
  packageHash: string;
  appAsarHash: string;
  schemaEpoch: number;
  cutoverEpoch: number;
  censusHash: string;
  entries: readonly FrozenProducerRegistryEntry[];
}>;

export function freezeWorkspaceOrchestratorProducerManifest(input: {
  buildId: string;
  sourceCommit: string;
  packageHash: string;
  appAsarHash: string;
  schemaEpoch: number;
  cutoverEpoch: number;
  authorizerRevision: string;
  processImagePath: string;
  resourcesPath: string;
  enabledProducerIds?: readonly string[];
}): FrozenProducerRegistryManifest {
  const enabled = new Set(input.enabledProducerIds ?? WORKSPACE_ORCHESTRATOR_PRODUCER_CENSUS.map(({ producerId }) => producerId));
  for (const producerId of enabled) {
    if (!WORKSPACE_ORCHESTRATOR_PRODUCER_CENSUS.some((producer) => producer.producerId === producerId)) {
      throw new WorkspaceOrchestratorCutoverError(producerId, 'enabled producer is not registered');
    }
  }
  const unhashedEntries = WORKSPACE_ORCHESTRATOR_PRODUCER_CENSUS.map((producer) => ({
    ...producer,
    buildId: input.buildId,
    triggerId: hashJson({ producerId: producer.producerId, trigger: producer.trigger, sourceLocation: producer.sourceLocation }),
    allowedIntentKind: `${producer.intendedSource}:${producer.intendedAction}`,
    owner: 'workspace_orchestrator' as const,
    writePrincipal: 'wmb_actor_store',
    authorizerRevision: input.authorizerRevision,
    processImagePath: input.processImagePath,
    resourcesPath: input.resourcesPath,
    sourceCommit: input.sourceCommit,
    packageHash: input.packageHash,
    appAsarHash: input.appAsarHash,
    schemaEpoch: input.schemaEpoch,
    cutoverEpoch: input.cutoverEpoch,
    registryEntryHash: '',
    enabled: enabled.has(producer.producerId),
    censusHash: ''
  }));
  const entriesWithHashes = unhashedEntries.map((entry) => ({ ...entry, registryEntryHash: hashJson({ ...entry, registryEntryHash: undefined, censusHash: undefined }) }));
  const censusHash = hashJson(entriesWithHashes.map(({ censusHash: _censusHash, ...entry }) => entry));
  const entries = entriesWithHashes.map((entry) => Object.freeze({ ...entry, censusHash }));
  return Object.freeze({
    buildId: input.buildId,
    sourceCommit: input.sourceCommit,
    packageHash: input.packageHash,
    appAsarHash: input.appAsarHash,
    schemaEpoch: input.schemaEpoch,
    cutoverEpoch: input.cutoverEpoch,
    censusHash,
    entries: Object.freeze(entries)
  });
}

export class WorkspaceOrchestratorCutoverError extends Error {
  readonly code = 'CUTOVER_REQUIRED';
  readonly producerId: string;

  constructor(producerId: string, detail: string) {
    super(`CUTOVER_REQUIRED:${producerId}:${detail}`);
    this.name = 'WorkspaceOrchestratorCutoverError';
    this.producerId = producerId;
  }
}

export function requireRegisteredOrchestratorProducer(producerId: string, sourceLocation: string): StageZeroProducer {
  const producer = WORKSPACE_ORCHESTRATOR_PRODUCER_CENSUS.find((candidate) => candidate.producerId === producerId);
  if (!producer) throw new WorkspaceOrchestratorCutoverError(producerId, 'producer is not registered');
  if (producer.sourceLocation !== sourceLocation) {
    throw new WorkspaceOrchestratorCutoverError(producerId, `source drift: expected ${producer.sourceLocation}`);
  }
  return producer;
}

export type StageZeroRuntimeInventory = Readonly<{
  inventoryId: string;
  sourceLocation: string;
  kind: 'memory-owner' | 'timer' | 'process' | 'session' | 'store-writer';
  resource: string;
  durabilityRisk: string;
}>;

export const WORKSPACE_ORCHESTRATOR_RUNTIME_CENSUS: readonly StageZeroRuntimeInventory[] = Object.freeze([
  { inventoryId: 'memory.daily-runs', sourceLocation: 'src/main/index.ts:dailyRuns', kind: 'memory-owner', resource: 'Map<rootPath+businessDate, Promise>', durabilityRisk: 'Date-scoped in-memory ownership is lost on restart.' },
  { inventoryId: 'memory.daily-control-inflight', sourceLocation: 'src/main/index.ts:dailyControlInflight', kind: 'memory-owner', resource: 'Map<taskId:action, Promise>', durabilityRisk: 'Process-local command dedupe cannot prove replay or ownership.' },
  { inventoryId: 'memory.daily-stage-lock', sourceLocation: 'src/main/daily-stage-lock.ts:locks', kind: 'memory-owner', resource: 'Map<businessDate+stage, owner>', durabilityRisk: 'Date-scoped lock disappears on crash and cannot fence late writers.' },
  { inventoryId: 'memory.daily-orchestration-inflight', sourceLocation: 'src/main/daily-orchestration.ts:inFlight', kind: 'memory-owner', resource: 'Map<workspace+date, Promise>', durabilityRisk: 'Promise singleton is not a durable root or replay receipt.' },
  { inventoryId: 'timer.rolling-scan', sourceLocation: 'src/main/daily-scan-scheduler.ts:DailyScanScheduler', kind: 'timer', resource: 'timers[], inFlight Set<module>, judgeRunning and judgeQueued', durabilityRisk: 'Timers, in-flight modules and queued Judge state reset on restart.' },
  { inventoryId: 'timer.daily-0900', sourceLocation: 'src/main/daily-orchestration-scheduler.ts:DailyOrchestrationScheduler', kind: 'timer', resource: 'Asia/Shanghai timeout', durabilityRisk: 'Timer directly starts production orchestration.' },
  { inventoryId: 'timer.orphan-sweep', sourceLocation: 'src/main/index.ts:orphanSweepTimer', kind: 'timer', resource: '60-second interval', durabilityRisk: 'Date/latest-task recovery can restart the wrong lineage.' },
  { inventoryId: 'memory.job-pool', sourceLocation: 'src/main/job-pool.ts:JobPool', kind: 'memory-owner', resource: 'queue[], parked[], running/terminal/locks Maps, slotListeners Set and submit sequence Maps', durabilityRisk: 'Restart loses queue order, locks, running ownership and terminal replay records.' },
  { inventoryId: 'memory.job-spawner', sourceLocation: 'src/main/job-spawner.ts:JobSpawner', kind: 'memory-owner', resource: 'handles/messages/jobRequests Maps, starting Set and watchdog interval', durabilityRisk: 'Restart loses handles, result messages and starting state; watchdog has no Actor reservation fence.' },
  { inventoryId: 'memory.pi-rpc', sourceLocation: 'src/main/pi-runtime.ts:PiRpcSupervisor', kind: 'memory-owner', resource: 'pending request Map, settle waiters, held settles and buffered emissions', durabilityRisk: 'Child exit clears process-local requests and emissions without durable replay identity.' },
  { inventoryId: 'timer.job-spawner-watchdog', sourceLocation: 'src/main/job-spawner.ts:JobSpawner.watchdog', kind: 'timer', resource: '60-second JobPool rescan interval', durabilityRisk: 'Rescan lacks Actor reservation and launchAttempt fencing.' },
  { inventoryId: 'process.daily-pi-child', sourceLocation: 'src/main/pi-runtime.ts:PiRpcSupervisor.start; src/main/agent-runner.ts:startDailyIntelligence', kind: 'process', resource: 'spawned Pi executable with PID, daily session JSONL and wmb-daily-* cwd', durabilityRisk: 'Spawn identity has no durable launchAttempt, process inventory or adopt-or-kill proof.' },
  { inventoryId: 'process.role-pi-child', sourceLocation: 'src/main/role-job-policies.ts targeted planner/librarian policies; src/main/pi-runtime.ts:PiRpcSupervisor.start', kind: 'process', resource: 'optional downstream Pi child with role session JSONL and wmb-planner-targeted-* or wmb-library-* cwd', durabilityRisk: 'Logical JobPool completion is not durably bound to the downstream process/session identity.' },
  { inventoryId: 'session.mcp-http', sourceLocation: 'src/main/mcp.ts:startMcp', kind: 'session', resource: 'Workspace MCP HTTP server', durabilityRisk: 'MCP routes can directly produce work outside a durable mailbox.' },
  { inventoryId: 'session.browser-cdp', sourceLocation: 'src/main/browser.ts:managedRuntimes/BrowserRuntime', kind: 'session', resource: 'Map<cdpUrl, BrowserRuntime> with executablePath, profilePath, PID, 127.0.0.1 CDP URL, mode and stop callback', durabilityRisk: 'Process-local attach/dedupe has no durable root, launchAttempt or session inventory binding.' },
  { inventoryId: 'store.runtime-command-dispatch', sourceLocation: 'src/main/workspace-runtime.ts:ActiveWorkspaceRuntime.dispatchCommand', kind: 'store-writer', resource: 'CommandDispatcher-authorized business mutations', durabilityRisk: 'Current write guard proves dispatcher scope, not Actor/cutover/producer attestation.' },
  { inventoryId: 'store.direct-migrated-db', sourceLocation: 'src/main/agent-runner.ts:mutationDependency', kind: 'store-writer', resource: 'Fallback migrateDatabase connection when ActiveWorkspaceRuntime is absent', durabilityRisk: 'Can write without the future sole Actor authority.' },
  { inventoryId: 'store.daily-orchestration', sourceLocation: 'src/main/daily-orchestration.ts:runOrchestration/saveSettlement', kind: 'store-writer', resource: 'Daily cycle/target/job/content settlement writes', durabilityRisk: 'Stage writes are not a single fenced T1-T8 transaction chain.' }
]);

export type OrchestratorReasonContract = Readonly<{
  reasonCode: string;
  terminal: string;
  ownerDecision: 'none' | 'repair_required_channel' | 'candidate_decision';
  actorAction: string;
}>;

export const WORKSPACE_ORCHESTRATOR_ERROR_MATRIX: readonly OrchestratorReasonContract[] = Object.freeze([
  ['CHANNEL_CONFIGURATION_REQUIRED', 'needs_user; no root', 'repair_required_channel', 'Create a new preflight after required configuration repair.'],
  ['CHANNEL_LOGIN_REQUIRED', 'needs_user; no root', 'repair_required_channel', 'Create a new preflight after required login repair.'],
  ['CHANNEL_PREFLIGHT_FAILED', 'failed; no root', 'none', 'Fail closed without bypass.'],
  ['OPTIONAL_CHANNEL_EXCLUDED', 'running or partial', 'none', 'Exclude optional channel and expose coverage gap.'],
  ['CHANNELS_ALL_FAILED', 'partial; no worker', 'none', 'Terminate intent and require a new explicit intent.'],
  ['NO_CONTINUATION_MATERIAL', 'partial', 'none', 'Create no Judge or Reporter continuation.'],
  ['SOURCE_SNAPSHOT_STALE', 'partial', 'none', 'Discard Judge attempt without rescanning old root.'],
  ['SCAN_HANDOFF_EXPIRED', 'partial', 'none', 'Terminate predecessor and forbid another handoff.'],
  ['SCORING_INCOMPLETE', 'partial or bounded successor', 'none', 'Run at most two evidence successors with strict progress.'],
  ['SCORING_INCOMPLETE_AND_INVALID', 'partial', 'none', 'Run bounded successor or stop.'],
  ['CHANNEL_POLICY_INVALID', 'failed receipt; no root', 'none', 'Reject non-monotonic policy with zero business writes.'],
  ['NO_CHANNEL_SELECTED', 'partial; no root', 'none', 'Expose select_channel or start_new_intent.'],
  ['PRECHECK_DEADLINE', 'needs_user or failed; no root', 'none', 'Terminate probe lease; resume same preflight at most once.'],
  ['PRECHECK_INTERRUPTED', 'needs_user or failed; no root', 'none', 'Terminate probe lease; resume same preflight at most once.'],
  ['CHANNEL_RUNTIME_AUTH_FAILED', 'needs_user or partial', 'repair_required_channel', 'Required repair or optional exclusion with coverage gap.'],
  ['SOURCE_PROVENANCE_MISMATCH', 'failed; scope/Judge zero write', 'none', 'Reject untrusted source and receipt.'],
  ['EFFECT_OUTCOME_UNKNOWN', 'consumption unknown', 'none', 'Query outcome or execute declared compensation before settlement.'],
  ['STATE_CONFLICT', 'failed receipt; original unchanged', 'none', 'Read current row; never create second authority.'],
  ['AUTHORITY_BUSY', 'failed receipt; original unchanged', 'none', 'Bounded wait on current Actor authority.'],
  ['OWNER_APPROVAL_STALE', 'failed receipt; zero decision write', 'candidate_decision', 'Return current index and projection fence.'],
  ['CANDIDATE_REPAIR_REJECTED', 'partial; old scope unchanged', 'candidate_decision', 'Keep invalid reason and repair action.'],
  ['MAILBOX_BACKPRESSURE', 'failed receipt; not enqueued', 'none', 'Return stable retryAfter/action without dropping queued work.'],
  ['MAILBOX_EXPIRED', 'partial or failed; no root', 'none', 'Terminate expired envelope with receipt and event.'],
  ['JUDGE_INTERACTIVE_BLOCKED', 'partial or maintenance', 'none', 'Watchdog or safe stop; never create second Judge.'],
  ['NO_BUSINESS_PROGRESS', 'partial; no successor', 'none', 'Persist before/after measure and stop churn.'],
  ['SOURCE_BUDGET_EXHAUSTED', 'partial only when no trusted snapshot', 'none', 'Stop collection; frozen 80-source snapshot may hand off once.'],
  ['MIGRATION_IN_PROGRESS', 'failed receipt; zero business write', 'none', 'Wait for migration terminal state.'],
  ['CUTOVER_REQUIRED', 'failed receipt; zero business write', 'none', 'Accept only current build and store fence.'],
  ['INVALID_NEEDS_REPAIR', 'partial', 'candidate_decision', 'Keep invalid candidate out of approval.'],
  ['CANDIDATE_ADMISSION_GAP', 'failed; scope rollback', 'none', 'Rollback partial candidate admission.'],
  ['RESOURCE_WAIT_TIMEOUT', 'partial with trusted result, else failed', 'none', 'Release lease and stop dispatch.'],
  ['MANAGER_STAGE_TIMEOUT', 'partial with trusted result, else failed', 'none', 'Fenced settlement; heartbeat cannot extend deadline.'],
  ['MANAGER_WALL_CLOCK', 'failed or partial', 'none', 'Enforce 20-minute root deadline.'],
  ['MANAGER_STALL', 'failed or partial', 'none', 'Settle from last business progress.'],
  ['PI_UNAVAILABLE', 'needs_user', 'none', 'Do not spawn; require a new intent after environment repair.'],
  ['MANAGER_ENTRY_FAILED', 'failed control receipt; no root', 'none', 'Do not fallback.'],
  ['MANAGER_CONTRACT_ERROR', 'failed or partial after accept', 'none', 'Persist failedStage and lastCommittedBoundary; revoke lease.'],
  ['REQUEST_REPLAY_CONFLICT', 'failed receipt; original unchanged', 'none', 'Return original attempt or stable conflict.'],
  ['MANAGER_OWNERSHIP_REQUIRED', 'failed receipt; original unchanged', 'none', 'Zero write and open bound task.'],
  ['MANAGER_ORCHESTRATION_MISMATCH', 'failed receipt; original unchanged', 'none', 'Reject cross-orchestration binding.'],
  ['WORKSPACE_STALE', 'execution rejected', 'none', 'Audit only and wait for current epoch.'],
  ['EXECUTION_AUTHORIZATION_INVALID', 'execution rejected', 'none', 'Audit only and wait for current epoch.'],
  ['PLAN_SCOPE_MISMATCH', 'failed receipt; old scope unchanged', 'none', 'Zero write and read frozen scope.'],
  ['TARGET_SNAPSHOT_STALE', 'Stage D failed', 'none', 'Terminate claim; require a new target attempt.'],
  ['EFFECT_REUSE_MISMATCH', 'Stage D failed', 'none', 'Terminate claim; require a new effect attempt.'],
  ['NO_CURRENT_TARGETS', 'Stage D skipped; scheduler root succeeded', 'none', 'No action.'],
  ['NO_ELIGIBLE_OPPORTUNITY', 'succeeded; emptyQualified', 'none', 'No action or CTA.'],
  ['CANCELLED_BY_AUTHORIZED_SYSTEM', 'cancelled', 'none', 'Cascade stop; old root never resumes.'],
  ['ORCHESTRATOR_CONTRACT_ERROR', 'failed', 'none', 'Fail closed for any unregistered error.']
].map(([reasonCode, terminal, ownerDecision, actorAction]) => ({ reasonCode, terminal, ownerDecision, actorAction })) as OrchestratorReasonContract[]);

function scalar(database: DatabaseSync, sql: string, ...params: SQLInputValue[]): number {
  const row = database.prepare(sql).get(...params) as { value?: number } | undefined;
  return Number(row?.value ?? 0);
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function countIfPresent(database: DatabaseSync, table: string, where = '', params: SQLInputValue[] = []): number {
  if (!tableExists(database, table)) return 0;
  return scalar(database, `SELECT COUNT(*) AS value FROM \"${table}\"${where ? ` WHERE ${where}` : ''}`, ...params);
}

export type WorkspaceOrchestratorBaseline = Readonly<{
  contract: typeof WORKSPACE_ORCHESTRATOR_DESIGN;
  capturedAt: string;
  workspaceId: string | null;
  dataRootPath: string;
  dataRootFingerprint: string;
  build: Readonly<{ buildId: string | null; packageHash: string | null; appAsarHash: string | null }>;
  schema: Readonly<{ appliedCount: number; maxVersion: number }>;
  active: Readonly<{ dailyTasks: number; managerTasks: number; dailyClaims: number; jobsPending: number; jobsRunning: number }>;
  totals: Readonly<{ sources: number; sourceReceipts: number; plans: number; planItems: number; contentVersions: number }>;
  knownPhantoms: Readonly<{ dailyRunningWithoutFinishedAt: number; jobsRunningWithoutFinishedAt: number }>;
  producerCensusHash: string;
  runtimeCensusHash: string;
}>;

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function collectWorkspaceOrchestratorBaseline(
  database: DatabaseSync,
  input: { dataRootPath: string; capturedAt?: string; buildId?: string | null; packageHash?: string | null; appAsarHash?: string | null }
): WorkspaceOrchestratorBaseline {
  const rootPath = path.resolve(input.dataRootPath);
  const workspaceRow = tableExists(database, 'app_meta')
    ? database.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get() as { value?: string } | undefined
    : undefined;
  const maxVersion = tableExists(database, 'schema_migrations')
    ? scalar(database, 'SELECT COALESCE(MAX(version), 0) AS value FROM schema_migrations')
    : 0;
  const appliedCount = countIfPresent(database, 'schema_migrations');
  const dailyIntentWhere = "intent IN ('daily_intelligence','daily_scan','daily_judge') AND status='running'";

  return Object.freeze({
    contract: WORKSPACE_ORCHESTRATOR_DESIGN,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    workspaceId: workspaceRow?.value?.trim() || null,
    dataRootPath: rootPath,
    dataRootFingerprint: createHash('sha256').update(rootPath).digest('hex'),
    build: Object.freeze({ buildId: input.buildId ?? null, packageHash: input.packageHash ?? null, appAsarHash: input.appAsarHash ?? null }),
    schema: Object.freeze({ appliedCount, maxVersion }),
    active: Object.freeze({
      dailyTasks: countIfPresent(database, 'agent_tasks', dailyIntentWhere),
      managerTasks: countIfPresent(database, 'manager_tasks', "status='running'"),
      dailyClaims: countIfPresent(database, 'daily_stage_claims', 'is_active=1'),
      jobsPending: countIfPresent(database, 'jobs', "status='pending'"),
      jobsRunning: countIfPresent(database, 'jobs', "status='running'")
    }),
    totals: Object.freeze({
      sources: countIfPresent(database, 'source_items'),
      sourceReceipts: countIfPresent(database, 'source_scan_receipts'),
      plans: countIfPresent(database, 'plans'),
      planItems: countIfPresent(database, 'plan_items'),
      contentVersions: countIfPresent(database, 'content_versions')
    }),
    knownPhantoms: Object.freeze({
      dailyRunningWithoutFinishedAt: countIfPresent(database, 'agent_tasks', `${dailyIntentWhere} AND finished_at IS NULL`),
      jobsRunningWithoutFinishedAt: countIfPresent(database, 'jobs', "status='running' AND finished_at IS NULL")
    }),
    producerCensusHash: hashJson(WORKSPACE_ORCHESTRATOR_PRODUCER_CENSUS),
    runtimeCensusHash: hashJson(WORKSPACE_ORCHESTRATOR_RUNTIME_CENSUS)
  });
}
