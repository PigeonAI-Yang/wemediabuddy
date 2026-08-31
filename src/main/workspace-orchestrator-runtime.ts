import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  createWorkspaceOrchestratorActorStore,
  hashV1,
  readStartupReconcileGate,
  type ActorFence,
  type ProducerAttestationInput,
  type StartupReconcileGate,
  type WorkspaceOrchestratorActor,
  type WorkspaceOrchestratorActorStore,
  type WorkspaceOrchestratorReceipt,
  type WorkspaceIntentInput
} from './workspace-orchestrator-actor.ts';
import {
  freezeWorkspaceOrchestratorProducerManifest,
  type FrozenProducerRegistryEntry,
  type FrozenProducerRegistryManifest
} from './workspace-orchestrator-stage0.ts';
import { reconcileWorkspaceOrchestratorStartup } from './workspace-orchestrator-recovery.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import { stopWorkspaceOrchestratorExecutor, wakeWorkspaceOrchestratorExecutor } from './workspace-orchestrator-executor.ts';

/** The sole production submission boundary for workspace orchestration. */
export type SubmitWorkspaceOrchestratorIntentInput = {
  producerId: string;
  businessDate: string;
  requestId: string;
  action?: 'full' | 'scan' | 'judge' | 'stage_d' | 'approve_candidates' | 'repair_invalid_candidate' | 'cancel_root' | 'start_new_intent';
  logicalInput?: unknown;
  payload?: unknown;
  channelPolicy?: unknown;
  profileRevision?: number;
  rootMode?: 'owner' | 'scheduler';
  predecessorIntentId?: string | null;
};

export type WorkspaceOrchestratorBuildManifest = Readonly<{
  buildId: string;
  sourceCommit: string;
  packageHash: string;
  appAsarHash: string;
  schemaEpoch: number;
  cutoverEpoch: number;
  readSchemaMin: number;
  readSchemaMax: number;
  writeSchemaEpoch: number;
  manifestHash: string;
  resourcesPath: string;
  createdAt: string;
}>;

export type WorkspaceMigrationState = Readonly<{
  workspaceId: string;
  migrationEpoch: number;
  status: string;
  manifestHash: string;
  schemaEpoch: number;
  cutoverEpoch: number;
  ownerRuntimeEpoch: number;
  writeFence: string;
}>;

export type WorkspaceOrchestratorRuntimeState = Readonly<{
  runtime: ActiveWorkspaceRuntime;
  actor: WorkspaceOrchestratorActor;
  fence: ActorFence;
  gate: StartupReconcileGate;
  buildManifest: WorkspaceOrchestratorBuildManifest;
  manifest: WorkspaceOrchestratorBuildManifest;
  producerRegistry: FrozenProducerRegistryManifest;
  registry: FrozenProducerRegistryManifest;
  migration: WorkspaceMigrationState;
}>;

type MutableRuntimeState = {
  runtime: ActiveWorkspaceRuntime;
  actor: WorkspaceOrchestratorActor;
  fence: ActorFence;
  gate: StartupReconcileGate;
  buildManifest: WorkspaceOrchestratorBuildManifest;
  producerRegistry: FrozenProducerRegistryManifest;
  migration: WorkspaceMigrationState;
  actorStore: WorkspaceOrchestratorActorStore;
};

const SCHEMA_EPOCH = 80;
const CUTOVER_EPOCH = 0;
const DEFAULT_AUTHORIZER_REVISION = 'dispatcher-v1';
const runtimeStates = new WeakMap<ActiveWorkspaceRuntime, MutableRuntimeState>();
const processStartMs = Math.max(0, Math.floor(Date.now() - process.uptime() * 1000));
const processStartUtc = new Date(processStartMs).toISOString();
const processStartMono = processStartMs;

function envValue(name: string, fallback: string): string {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function rowNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function rowString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function nowUtc(): string {
  return new Date().toISOString();
}

type PackagedBuildIdentity = Readonly<{ sourceCommit: string; packageHash: string; appAsarHash: string }>;

function sha256File(filePath: string): string {
  const previousNoAsar = process.noAsar;
  process.noAsar = true;
  try {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex');
  } finally {
    process.noAsar = previousNoAsar;
  }
}

function readPackagedBuildIdentity(): PackagedBuildIdentity | null {
  const manifestPath = process.env.WMB_BUILD_MANIFEST_PATH?.trim()
    || path.join(process.resourcesPath || process.cwd(), 'wmb-build-manifest.json');
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const sourceCommit = String(manifest.sourceCommit ?? '').trim();
  const packageHash = String(manifest.packageHash ?? '').trim();
  const appAsarHash = String(manifest.appAsarHash ?? '').trim();
  if (!sourceCommit || !/^[a-f0-9]{64}$/.test(packageHash) || !/^[a-f0-9]{64}$/.test(appAsarHash))
    throw Object.assign(new Error('打包 build manifest 非法。'), { code: 'CUTOVER_REQUIRED' });
  const appAsarPath = path.join(path.dirname(manifestPath), String(manifest.appAsar ?? 'app.asar'));
  if (!existsSync(appAsarPath) || sha256File(appAsarPath) !== appAsarHash)
    throw Object.assign(new Error('当前 app.asar 与打包 build manifest 不一致。'), { code: 'CUTOVER_REQUIRED' });
  return Object.freeze({ sourceCommit, packageHash, appAsarHash });
}

function readCurrentBuild(database: DatabaseSync, buildId: string): WorkspaceOrchestratorBuildManifest | null {
  if (!tableExists(database, 'build_manifests')) return null;
  const row = database.prepare('SELECT * FROM build_manifests WHERE build_id=? AND schema_epoch=? AND write_schema_epoch=?').get(buildId, SCHEMA_EPOCH, SCHEMA_EPOCH) as Record<string, unknown> | undefined;
  if (!row) return null;
  return Object.freeze({
    buildId: String(row.build_id),
    sourceCommit: rowString(row.source_commit, 'unknown-source'),
    packageHash: rowString(row.package_hash, 'unknown-package'),
    appAsarHash: rowString(row.app_asar_hash, 'unknown-asar'),
    schemaEpoch: rowNumber(row.schema_epoch, SCHEMA_EPOCH),
    cutoverEpoch: rowNumber(row.cutover_epoch, CUTOVER_EPOCH),
    readSchemaMin: rowNumber(row.read_schema_min, SCHEMA_EPOCH),
    readSchemaMax: rowNumber(row.read_schema_max, SCHEMA_EPOCH),
    writeSchemaEpoch: rowNumber(row.write_schema_epoch, SCHEMA_EPOCH),
    manifestHash: rowString(row.manifest_hash, hashV1(row)),
    resourcesPath: rowString(row.resources_path, process.resourcesPath || process.cwd()),
    createdAt: rowString(row.created_at, nowUtc())
  });
}

function makeBuildManifest(database: DatabaseSync): WorkspaceOrchestratorBuildManifest {
  const packaged = readPackagedBuildIdentity();
  const sourceCommit = envValue('WMB_SOURCE_COMMIT', packaged?.sourceCommit ?? 'working-tree');
  const packageHash = envValue('WMB_PACKAGE_HASH', packaged?.packageHash ?? hashV1({ r: 'package/v1', package: 'wemedia-buddy', version: '0.3.0' }));
  const appAsarHash = envValue('WMB_APP_ASAR_HASH', packaged?.appAsarHash ?? hashV1({ r: 'app-asar/v1', executable: process.execPath }));
  const resourcesPath = envValue('WMB_RESOURCES_PATH', process.resourcesPath || process.cwd());
  const defaultBuildId = packaged ? `wmb-runtime-${SCHEMA_EPOCH}-${packageHash.slice(0, 12)}` : `wmb-runtime-${SCHEMA_EPOCH}`;
  const configuredBuildId = envValue('WMB_BUILD_ID', defaultBuildId);
  const configured = database.prepare('SELECT schema_epoch,write_schema_epoch FROM build_manifests WHERE build_id=?').get(configuredBuildId) as Record<string, unknown> | undefined;
  const buildId = configured && (rowNumber(configured.schema_epoch, 0) !== SCHEMA_EPOCH || rowNumber(configured.write_schema_epoch, 0) !== SCHEMA_EPOCH)
    ? `${configuredBuildId}-schema-${SCHEMA_EPOCH}` : configuredBuildId;
  const existing = readCurrentBuild(database, buildId);
  if (existing) return existing;
  const manifestHash = hashV1({
    r: 'build-manifest/v1', buildId, sourceCommit, packageHash, appAsarHash,
    schemaEpoch: SCHEMA_EPOCH, cutoverEpoch: CUTOVER_EPOCH,
    readSchemaMin: SCHEMA_EPOCH, readSchemaMax: SCHEMA_EPOCH,
    writeSchemaEpoch: SCHEMA_EPOCH, resourcesPath
  });
  const createdAt = nowUtc();
  database.prepare(`INSERT OR IGNORE INTO build_manifests (
    build_id, source_commit, package_hash, app_asar_hash, schema_epoch, cutover_epoch,
    read_schema_min, read_schema_max, write_schema_epoch, manifest_hash, resources_path, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    buildId, sourceCommit, packageHash, appAsarHash, SCHEMA_EPOCH, CUTOVER_EPOCH,
    SCHEMA_EPOCH, SCHEMA_EPOCH, SCHEMA_EPOCH, manifestHash, resourcesPath, createdAt
  );
  return readCurrentBuild(database, buildId) ?? Object.freeze({
    buildId, sourceCommit, packageHash, appAsarHash,
    schemaEpoch: SCHEMA_EPOCH, cutoverEpoch: CUTOVER_EPOCH,
    readSchemaMin: SCHEMA_EPOCH, readSchemaMax: SCHEMA_EPOCH,
    writeSchemaEpoch: SCHEMA_EPOCH, manifestHash, resourcesPath, createdAt
  });
}

function readMigration(database: DatabaseSync, workspaceId: string, migrationEpoch: number): WorkspaceMigrationState | null {
  const row = database.prepare('SELECT * FROM workspace_migration_state WHERE workspace_id=? AND migration_epoch=?').get(workspaceId, migrationEpoch) as Record<string, unknown> | undefined;
  if (!row) return null;
  return Object.freeze({
    workspaceId: String(row.workspace_id),
    migrationEpoch: rowNumber(row.migration_epoch, migrationEpoch),
    status: String(row.status),
    manifestHash: String(row.manifest_hash),
    schemaEpoch: rowNumber(row.schema_epoch, SCHEMA_EPOCH),
    cutoverEpoch: rowNumber(row.cutover_epoch, CUTOVER_EPOCH),
    ownerRuntimeEpoch: rowNumber(row.owner_runtime_epoch, 1),
    writeFence: String(row.write_fence)
  });
}
function readLatestMigration(database: DatabaseSync, workspaceId: string): WorkspaceMigrationState | null {
  const row = database.prepare('SELECT * FROM workspace_migration_state WHERE workspace_id=? ORDER BY migration_epoch DESC LIMIT 1').get(workspaceId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return Object.freeze({
    workspaceId: String(row.workspace_id),
    migrationEpoch: rowNumber(row.migration_epoch, 1),
    status: String(row.status),
    manifestHash: String(row.manifest_hash),
    schemaEpoch: rowNumber(row.schema_epoch, SCHEMA_EPOCH),
    cutoverEpoch: rowNumber(row.cutover_epoch, CUTOVER_EPOCH),
    ownerRuntimeEpoch: rowNumber(row.owner_runtime_epoch, 1),
    writeFence: String(row.write_fence)
  });
}


function persistMigration(database: DatabaseSync, workspaceId: string, actor: WorkspaceOrchestratorActor, build: WorkspaceOrchestratorBuildManifest): WorkspaceMigrationState {
  const current = readMigration(database, workspaceId, actor.migrationEpoch);
  if (current && current.status !== 'complete') {
    throw Object.assign(new Error(`workspace migration 未完成: ${current.status}`), { code: current.status === 'running' || current.status === 'pending' ? 'MIGRATION_IN_PROGRESS' : 'CUTOVER_REQUIRED' });
  }
  if (current && current.status === 'complete') {
    if (current.manifestHash === build.manifestHash && current.schemaEpoch === build.schemaEpoch && current.cutoverEpoch === build.cutoverEpoch && current.writeFence === 'allow') return current;
    throw Object.assign(new Error('terminal workspace migration 不可原位更新。'), { code: 'CUTOVER_REQUIRED' });
  }
  const utc = nowUtc();
  const mono = Date.now();
  const beforeHash = hashV1({ r: 'migration-before/v1', workspaceId, migrationEpoch: actor.migrationEpoch, manifestHash: build.manifestHash });
  const fenceTokenHash = hashV1({ r: 'actor-fence/v1', workspaceId, runtimeEpoch: actor.runtimeEpoch, ownerEpoch: actor.ownerEpoch, leaseToken: actor.leaseToken });
  if (!current) {
    database.prepare(`INSERT INTO workspace_migration_state (
      workspace_id, migration_epoch, status, manifest_hash, schema_epoch, cutover_epoch,
      owner_runtime_epoch, fence_token_hash, write_fence, checkpoint_seq, before_hash,
      after_hash, started_at_utc, started_at_mono, finished_at_utc, finished_at_mono, failure_reason
    ) VALUES (?, ?, 'complete', ?, ?, ?, ?, ?, 'allow', ?, ?, ?, ?, ?, ?, ?, NULL)`).run(
      workspaceId, actor.migrationEpoch, build.manifestHash, build.schemaEpoch, build.cutoverEpoch,
      actor.runtimeEpoch, fenceTokenHash, actor.checkpointRevision, beforeHash, beforeHash,
      utc, mono, utc, mono
    );
  } else {
    database.prepare(`UPDATE workspace_migration_state SET manifest_hash=?, schema_epoch=?, cutover_epoch=?,
      owner_runtime_epoch=?, fence_token_hash=?, write_fence='allow', checkpoint_seq=?, after_hash=?,
      finished_at_utc=COALESCE(finished_at_utc, ?), finished_at_mono=COALESCE(finished_at_mono, ?)
      WHERE workspace_id=? AND migration_epoch=?`).run(
      build.manifestHash, build.schemaEpoch, build.cutoverEpoch, actor.runtimeEpoch, fenceTokenHash,
      actor.checkpointRevision, beforeHash, utc, mono, workspaceId, actor.migrationEpoch
    );
  }
  return readMigration(database, workspaceId, actor.migrationEpoch)!;
}

function profileRevision(database: DatabaseSync): number {
  if (!tableExists(database, 'workspace_profiles')) return 1;
  const row = database.prepare("SELECT revision FROM workspace_profiles WHERE id='effective'").get() as { revision?: unknown } | undefined;
  return Math.max(1, Math.trunc(rowNumber(row?.revision, 1)));
}

function enabledCount(database: DatabaseSync, table: string): number {
  if (!tableExists(database, table)) return 0;
  try {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM "${table}" WHERE enabled=1`).get() as { count?: unknown } | undefined;
    return Math.max(0, Math.trunc(rowNumber(row?.count, 0)));
  } catch {
    return 0;
  }
}

function authorizedChannelPolicy(database: DatabaseSync): readonly Record<string, string | null>[] {
  const channels: Array<Record<string, string | null>> = [];
  if (enabledCount(database, 'website_sources') > 0) channels.push({ channelId: 'official_web', requiredness: 'required', module: 'official_web' });
  if (enabledCount(database, 'x_list_bindings') > 0) channels.push({ channelId: 'x_lists', requiredness: 'optional', module: 'x_lists' });
  return Object.freeze(channels);
}

function persistProducerRegistry(database: DatabaseSync, workspaceId: string, migrationEpoch: number, manifest: FrozenProducerRegistryManifest): void {
  for (const entry of manifest.entries) {
    database.prepare(`INSERT INTO producer_registry (
      workspace_id, producer_id, build_id, migration_epoch, source_location, trigger, trigger_id,
      allowed_intent_kind, owner, replacement_route, write_tables, write_principal,
      authorizer_revision, process_image_path, resources_path, registry_entry_hash, enabled,
      census_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, producer_id, build_id) DO UPDATE SET
      migration_epoch=excluded.migration_epoch, source_location=excluded.source_location,
      trigger=excluded.trigger, trigger_id=excluded.trigger_id, allowed_intent_kind=excluded.allowed_intent_kind,
      owner=excluded.owner, replacement_route=excluded.replacement_route, write_tables=excluded.write_tables,
      write_principal=excluded.write_principal, authorizer_revision=excluded.authorizer_revision,
      process_image_path=excluded.process_image_path, resources_path=excluded.resources_path,
      registry_entry_hash=excluded.registry_entry_hash, enabled=excluded.enabled,
      census_hash=excluded.census_hash`).run(
      workspaceId, entry.producerId, entry.buildId, migrationEpoch, entry.sourceLocation, entry.trigger,
      entry.triggerId, entry.allowedIntentKind, entry.owner, entry.replacementRoute,
      JSON.stringify(entry.writeTables), entry.writePrincipal, entry.authorizerRevision,
      entry.processImagePath, entry.resourcesPath, entry.registryEntryHash, entry.enabled ? 1 : 0,
      entry.censusHash, nowUtc()
    );
  }
}

function migrationEpoch(database: DatabaseSync, workspaceId: string): number {
  if (!tableExists(database, 'workspace_migration_state')) return 1;
  const row = database.prepare('SELECT MAX(migration_epoch) AS epoch FROM workspace_migration_state WHERE workspace_id=?').get(workspaceId) as { epoch?: unknown } | undefined;
  return Math.max(1, Math.trunc(rowNumber(row?.epoch, 1)));
}

function actorFence(actor: WorkspaceOrchestratorActor): ActorFence {
  if (!actor.leaseToken) throw Object.assign(new Error('当前 Actor 没有 lease fence。'), { code: 'EXECUTION_AUTHORIZATION_INVALID' });
  return Object.freeze({
    workspaceId: actor.workspaceId,
    runtimeEpoch: actor.runtimeEpoch,
    ownerEpoch: actor.ownerEpoch,
    authorityRevision: actor.authorityRevision,
    leaseToken: actor.leaseToken,
    checkpointRevision: actor.checkpointRevision
  });
}

function expectedActions(producerId: string, entry: FrozenProducerRegistryEntry): readonly SubmitWorkspaceOrchestratorIntentInput['action'][] {
  switch (producerId) {
    case 'today.agent-start-daily-intelligence': return ['full'];
    case 'today.daily-orchestration':
    case 'today.daily-cycle-ensure':
    case 'ui.jobs-spawn':
    case 'proposal.plan-item-advance':
    case 'mcp.jobs-spawn':
    case 'mcp.daily-orchestrate':
    case 'scheduler.daily-0900':
    case 'scheduler.rolling-official-web':
    case 'scheduler.rolling-x-lists':
    case 'scheduler.rolling-auto-judge':
    case 'startup.daily-resume':
    case 'startup.refresh-runtime-daily-handoff':
    case 'reconcile.daily-handoff-sweeper':
    case 'reconcile.agent-tasks-recover':
    case 'reconcile.research-successor-scheduler':
    case 'content-cycle.successor':
    case 'maintenance.topic-reproposal':
      return [entry.intendedAction === 'reconcile' ? 'stage_d' : entry.intendedAction as SubmitWorkspaceOrchestratorIntentInput['action']];
    case 'proposal.candidate-decision': return ['judge', 'approve_candidates', 'repair_invalid_candidate'];
    case 'proposal.plan-item-request-planning': return ['judge'];
    case 'mcp.daily-continue-after-scan': return ['judge'];
    case 'mcp.daily-run-stage': return ['scan', 'judge', 'full'];
    default: return [];
  }
}

function expectedRootMode(source: FrozenProducerRegistryEntry['intendedSource']): 'owner' | 'scheduler' {
  return source === 'scheduler_0900' || source === 'rolling_scan' || source === 'content_cycle' || source === 'orphan_reconcile' ? 'scheduler' : 'owner';
}

function attestationFor(state: MutableRuntimeState, producerId: string, invalidate = false): ProducerAttestationInput {
  const entry = state.producerRegistry.entries.find((candidate) => candidate.producerId === producerId) ?? state.producerRegistry.entries[0];
  if (!entry) throw new Error('producer registry 为空。');
  return Object.freeze({
    producerId,
    registryEntryHash: entry.registryEntryHash,
    censusHash: entry.censusHash,
    triggerId: invalidate ? `${entry.triggerId}:rejected` : entry.triggerId,
    processId: String(process.pid),
    processStartTimeUtc: processStartUtc,
    processStartTimeMono: processStartMono,
    processImagePath: entry.processImagePath,
    resourcesPath: entry.resourcesPath,
    buildId: entry.buildId,
    sourceCommit: entry.sourceCommit,
    packageHash: entry.packageHash,
    appAsarHash: entry.appAsarHash,
    schemaEpoch: entry.schemaEpoch,
    cutoverEpoch: entry.cutoverEpoch,
    runtimeEpoch: state.actor.runtimeEpoch,
    writePrincipal: entry.writePrincipal,
    authorizerRevision: entry.authorizerRevision
  });
}

function fallbackReceipt(state: MutableRuntimeState, input: SubmitWorkspaceOrchestratorIntentInput, code: string, message: string): WorkspaceOrchestratorReceipt {
  const action = input.action ?? 'start_new_intent';
  const source = 'mcp';
  const rootMode = input.rootMode ?? 'owner';
  const policy = input.channelPolicy ?? [];
  const profile = input.profileRevision ?? 1;
  const logicalInput = input.logicalInput ?? input.payload ?? null;
  const payload = input.payload ?? input.logicalInput ?? null;
  const logicalInputHash = hashV1({ r: 'logical-input/v1', workspaceId: state.actor.workspaceId, businessDate: input.businessDate, source, rootMode, requestedAction: action, normalizedPolicyHash: hashV1({ r: 'normalized-policy/v1', workspaceId: state.actor.workspaceId, profileRevision: profile, policy }), logicalInput, acceptance: null, predecessorIntentId: input.predecessorIntentId ?? null, predecessorRootId: null });
  const payloadHash = hashV1(payload);
  const commandReplayKey = hashV1({ r: 'command-replay/v1', workspaceId: state.actor.workspaceId, producer: input.producerId, requestId: input.requestId });
  const createdAt = nowUtc();
  const receiptId = hashV1({ r: 'command-receipt/v1', workspaceId: state.actor.workspaceId, requestId: input.requestId, commandReplayKey });
  return Object.freeze({
    version: 'WorkspaceOrchestratorReceiptV1', receiptId, ok: false, status: 'rejected', code, reasonCode: code, message,
    workspaceId: state.actor.workspaceId, runtimeEpoch: state.actor.runtimeEpoch, ownerEpoch: state.actor.ownerEpoch,
    authorityRevision: state.actor.authorityRevision, requestId: input.requestId, command: 'workspace_orchestrator.intent.accept',
    commandReplayKey, logicalInputHash, payloadHash, producerAttestationHash: null,
    intentId: null, invocationId: null, mailboxSequence: null, checkpointRevision: state.actor.checkpointRevision,
    readback: Object.freeze({ workspaceId: state.actor.workspaceId, runtimeEpoch: state.actor.runtimeEpoch, ownerEpoch: state.actor.ownerEpoch, authorityRevision: state.actor.authorityRevision, checkpointRevision: state.actor.checkpointRevision, root: null, rootCreated: false, error: { code, message } }),
    createdAt
  });
}

function actorResultReceipt(result: unknown, state: MutableRuntimeState, input: SubmitWorkspaceOrchestratorIntentInput, code = 'ORCHESTRATOR_CONTRACT_ERROR', message = 'Actor intent submission failed.'): WorkspaceOrchestratorReceipt {
  if (result && typeof result === 'object' && 'receipt' in result) return (result as { receipt: WorkspaceOrchestratorReceipt }).receipt;
  const failure = result as { code?: string; message?: string } | undefined;
  return fallbackReceipt(state, input, failure?.code ?? code, failure?.message ?? message);
}

function refreshStateActor(state: MutableRuntimeState): void {
  const actor = state.actorStore.readActor(state.runtime.identity.workspaceId);
  if (!actor) throw Object.assign(new Error('workspace Actor 不存在。'), { code: 'WORKSPACE_STALE' });
  state.actor = actor;
  state.fence = actorFence(actor);
}
function actorAuthorityExpired(actor: WorkspaceOrchestratorActor, nowMono = Date.now()): boolean {
  return actor.actorStatus !== 'active'
    || !actor.leaseToken
    || actor.leaseExpiresAtMono === null
    || actor.controlStallDeadlineMono === null
    || nowMono >= actor.leaseExpiresAtMono
    || nowMono >= actor.controlStallDeadlineMono;
}

function rebindExpiredAuthority(state: MutableRuntimeState): void {
  refreshStateActor(state);
  if (!actorAuthorityExpired(state.actor)) return;
  const acquired = state.actorStore.acquireActor({
    workspaceId: state.actor.workspaceId,
    currentBuildId: state.buildManifest.buildId,
    ownerId: 'workspace-orchestrator',
    runtimeId: state.runtime.identity.runtimeEpoch,
    migrationEpoch: state.actor.migrationEpoch,
    writeFence: 'allow',
  });
  if (!acquired.ok) throw Object.assign(new Error(acquired.message), { code: acquired.code, details: acquired.readback });
  const gate = acquired.gate ?? state.actorStore.createStartupReconcileGate({ workspaceId: state.actor.workspaceId, fence: acquired.fence }).gate;
  if (!gate) throw Object.assign(new Error('startup gate 创建失败。'), { code: 'ORCHESTRATOR_CONTRACT_ERROR' });
  const reconciled = runStartupRecovery(state.runtime.database, state.actorStore, state.actor.workspaceId, acquired.fence, gate);
  state.actor = reconciled.actor;
  state.fence = reconciled.fence;
  state.gate = reconciled.gate;
}

function freezeRuntimeState(state: MutableRuntimeState): WorkspaceOrchestratorRuntimeState {
  return Object.freeze({
    runtime: state.runtime,
    actor: state.actor,
    fence: state.fence,
    gate: state.gate,
    buildManifest: state.buildManifest,
    manifest: state.buildManifest,
    producerRegistry: state.producerRegistry,
    registry: state.producerRegistry,
    migration: state.migration
  });
}

function runStartupRecovery(
  database: DatabaseSync,
  actorStore: WorkspaceOrchestratorActorStore,
  workspaceId: string,
  initialFence: ActorFence,
  initialGate: StartupReconcileGate
): { actor: WorkspaceOrchestratorActor; fence: ActorFence; gate: StartupReconcileGate } {
  let fence = initialFence;
  let gate = initialGate;
  if (gate.status === 'pending') {
    const started = actorStore.advanceStartupReconcileGate({ workspaceId, fence, status: 'running' });
    if (!started.ok || !started.gate) throw Object.assign(new Error(started.message ?? 'startup gate 启动失败。'), { code: started.code ?? 'ORCHESTRATOR_CONTRACT_ERROR' });
    gate = started.gate;
  }
  if (gate.status === 'running') {
    const recovery = reconcileWorkspaceOrchestratorStartup(database, { workspaceId, fence });
    if (recovery.fence && typeof recovery.fence === 'object') fence = recovery.fence as ActorFence;
    const target = recovery.status === 'complete' ? 'complete' : recovery.status === 'maintenance' ? 'maintenance' : 'failed';
    const advanced = actorStore.advanceStartupReconcileGate({
      workspaceId,
      fence,
      status: target,
      reason: typeof recovery.message === 'string' ? recovery.message : null
    });
    if (!advanced.ok || !advanced.gate) throw Object.assign(new Error(advanced.message ?? 'startup gate reconcile transition 失败。'), { code: advanced.code ?? 'ORCHESTRATOR_CONTRACT_ERROR' });
    gate = advanced.gate;
  }
  const actor = actorStore.readActor(workspaceId);
  if (!actor) throw Object.assign(new Error('workspace Actor 不存在。'), { code: 'WORKSPACE_STALE' });
  return { actor, fence: actorFence(actor), gate };
}

/** Install build, migration, producer registry, Actor authority, and startup gate for a runtime. */
export async function initializeWorkspaceOrchestratorRuntime(runtime: ActiveWorkspaceRuntime): Promise<WorkspaceOrchestratorRuntimeState> {
  const cached = runtimeStates.get(runtime);
  if (cached) return freezeRuntimeState(cached);
  const state = await runtime.runActorControlPlane(async () => {
    const database = runtime.database;
    const buildManifest = makeBuildManifest(database);
    const processImagePath = process.execPath;
    const resourcesPath = buildManifest.resourcesPath;
    const enabledProducerIds = process.env.WMB_ENABLED_PRODUCERS?.split(',').map((value) => value.trim()).filter(Boolean);
    const producerRegistry = freezeWorkspaceOrchestratorProducerManifest({
      buildId: buildManifest.buildId,
      sourceCommit: buildManifest.sourceCommit,
      packageHash: buildManifest.packageHash,
      appAsarHash: buildManifest.appAsarHash,
      schemaEpoch: buildManifest.schemaEpoch,
      cutoverEpoch: buildManifest.cutoverEpoch,
      authorizerRevision: envValue('WMB_AUTHORIZER_REVISION', DEFAULT_AUTHORIZER_REVISION),
      processImagePath,
      resourcesPath,
      ...(enabledProducerIds?.length ? { enabledProducerIds } : {})
    });
    const actorStore = createWorkspaceOrchestratorActorStore(database);
    const existingActor = actorStore.readActor(runtime.identity.workspaceId);
    const existingMigration = readLatestMigration(database, runtime.identity.workspaceId);
    const firstInstall = !existingActor && !existingMigration;
    let actor: WorkspaceOrchestratorActor;
    let fence: ActorFence;
    let migration: WorkspaceMigrationState;
    let gate: StartupReconcileGate;
    const workspaceId = runtime.identity.workspaceId;
    if (firstInstall) {
      const acquired = actorStore.acquireActor({
        workspaceId,
        currentBuildId: buildManifest.buildId,
        ownerId: 'workspace-orchestrator',
        runtimeId: runtime.identity.runtimeEpoch,
        migrationEpoch: Math.max(1, migrationEpoch(database, workspaceId)),
        writeFence: 'allow'
      });
      if (!acquired.ok) throw Object.assign(new Error(acquired.message), { code: acquired.code, details: acquired.readback });
      actor = acquired.actor;
      fence = acquired.fence;
      migration = persistMigration(database, workspaceId, actor, buildManifest);
      persistProducerRegistry(database, workspaceId, actor.migrationEpoch, producerRegistry);
      const created = acquired.gate ?? actorStore.createStartupReconcileGate({ workspaceId, fence }).gate;
      if (!created) throw Object.assign(new Error('startup gate 创建失败。'), { code: 'ORCHESTRATOR_CONTRACT_ERROR' });
      gate = created;
    } else {
      if (!existingActor) throw Object.assign(new Error('workspace migration 存在但 Actor 缺失。'), { code: 'CUTOVER_REQUIRED' });
      const exactMigration = readMigration(database, workspaceId, existingActor.migrationEpoch);
      const manifestTakeover = existingActor.currentBuildId !== buildManifest.buildId || !exactMigration || exactMigration.status !== 'complete' || exactMigration.schemaEpoch !== buildManifest.schemaEpoch || exactMigration.manifestHash !== buildManifest.manifestHash || exactMigration.writeFence !== 'allow';
      const authorityTakeover = actorAuthorityExpired(existingActor);
      if (manifestTakeover || authorityTakeover) {
        const acquired = actorStore.acquireActor({
          workspaceId,
          currentBuildId: buildManifest.buildId,
          ownerId: 'workspace-orchestrator',
          runtimeId: runtime.identity.runtimeEpoch,
          migrationEpoch: manifestTakeover ? Math.max(existingActor.migrationEpoch + 1, migrationEpoch(database, workspaceId) + 1) : existingActor.migrationEpoch,
          writeFence: 'allow'
        });
        if (!acquired.ok) throw Object.assign(new Error(acquired.message), { code: acquired.code, details: acquired.readback });
        actor = acquired.actor;
        fence = acquired.fence;
        if (manifestTakeover) {
          migration = persistMigration(database, workspaceId, actor, buildManifest);
          persistProducerRegistry(database, workspaceId, actor.migrationEpoch, producerRegistry);
        } else {
          migration = exactMigration!;
        }
        gate = acquired.gate ?? (() => {
          const created = actorStore.createStartupReconcileGate({ workspaceId, fence });
          if (!created.ok || !created.gate) throw Object.assign(new Error(created.message ?? 'startup gate 创建失败。'), { code: created.code ?? 'ORCHESTRATOR_CONTRACT_ERROR' });
          return created.gate;
        })();
      } else {
        actor = existingActor;
        fence = actorFence(actor);
        migration = exactMigration!;
        const existingGate = readStartupReconcileGate(database, actor.workspaceId, actor.runtimeEpoch);
        if (existingGate) gate = existingGate;
        else {
          const gateResult = actorStore.createStartupReconcileGate({ workspaceId: actor.workspaceId, fence });
          if (!gateResult.ok || !gateResult.gate) throw Object.assign(new Error(gateResult.message ?? 'startup gate 创建失败。'), { code: gateResult.code ?? 'ORCHESTRATOR_CONTRACT_ERROR' });
          gate = gateResult.gate;
        }
      }
    }
    const reconciled = runStartupRecovery(database, actorStore, workspaceId, fence, gate);
    actor = reconciled.actor;
    fence = reconciled.fence;
    gate = reconciled.gate;
    migration = readMigration(database, workspaceId, actor.migrationEpoch) ?? migration;
    const next: MutableRuntimeState = {
      runtime, actor, fence, gate,
      buildManifest, producerRegistry, migration, actorStore
    };
    runtimeStates.set(runtime, next);
    return next;
  });
  runtime.registerShutdownResource({
    stop: async () => {
      await stopWorkspaceOrchestratorExecutor(runtime);
      runtimeStates.delete(runtime);
    },
  });
  return freezeRuntimeState(state);
}

/** Validate a typed producer contract and submit one intent through the durable Actor mailbox. */
export async function submitWorkspaceOrchestratorIntent(runtime: ActiveWorkspaceRuntime, input: SubmitWorkspaceOrchestratorIntentInput): Promise<WorkspaceOrchestratorReceipt> {
  let state = runtimeStates.get(runtime);
  if (!state) {
    await initializeWorkspaceOrchestratorRuntime(runtime);
    state = runtimeStates.get(runtime);
  }
  if (!state) throw Object.assign(new Error('当前 workspace Actor runtime 不可用。'), { code: 'WORKSPACE_STALE' });
  return runtime.runActorControlPlane(async () => {
    rebindExpiredAuthority(state!);
    const actor = state!.actor;
    const migrationRow = runtime.database.prepare('SELECT status, write_fence, migration_epoch, manifest_hash FROM workspace_migration_state WHERE workspace_id=? ORDER BY migration_epoch DESC LIMIT 1').get(runtime.identity.workspaceId) as Record<string, unknown> | undefined;
    if (actor.writeFence !== 'allow') return fallbackReceipt(state!, input, 'EXECUTION_AUTHORIZATION_INVALID', 'workspace Actor write fence 未授权。');
    const migrationStatus = String(migrationRow?.status ?? 'missing');
    if (migrationStatus !== 'complete') {
      const code = migrationStatus === 'pending' || migrationStatus === 'running' ? 'MIGRATION_IN_PROGRESS' : 'CUTOVER_REQUIRED';
      return fallbackReceipt(state!, input, code, `workspace migration 尚未完成: ${migrationStatus}`);
    }
    if (String(migrationRow?.write_fence ?? 'deny') !== 'allow') return fallbackReceipt(state!, input, 'CUTOVER_REQUIRED', 'workspace migration write fence 未授权。');
    const producerId = String(input.producerId ?? '').trim();
    const entry = state!.producerRegistry.entries.find((candidate) => candidate.producerId === producerId);
    const requestedActions = entry ? expectedActions(producerId, entry) : [];
    const action = input.action ?? requestedActions[0] ?? 'start_new_intent';
    const rootMode = input.rootMode ?? (entry ? expectedRootMode(entry.intendedSource) : 'owner');
    const businessDate = String(input.businessDate ?? '').trim();
    const requestId = String(input.requestId ?? '').trim();
    const currentProfileRevision = profileRevision(runtime.database);
    const authorizedPolicy = authorizedChannelPolicy(runtime.database);
    const requestedPolicy = input.channelPolicy === undefined ? authorizedPolicy : input.channelPolicy;
    const logicalInput = input.logicalInput !== undefined ? input.logicalInput : input.payload;
    const payload = input.payload !== undefined ? input.payload : input.logicalInput;
    const identityRecord = logicalInput && typeof logicalInput === 'object' ? logicalInput as Record<string, unknown> : {};
    const payloadRecord = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const predecessorIntentId = input.predecessorIntentId ?? (typeof identityRecord.predecessorIntentId === 'string' ? identityRecord.predecessorIntentId : null);
    const rootRequestId = typeof identityRecord.rootRequestId === 'string' ? identityRecord.rootRequestId : typeof payloadRecord.rootRequestId === 'string' ? payloadRecord.rootRequestId : null;
    const predecessorIdentityComplete = producerId !== 'mcp.daily-continue-after-scan' || Boolean(predecessorIntentId && rootRequestId);
    const invalid = !entry
      || !entry.enabled
      || !requestedActions.includes(action)
      || rootMode !== expectedRootMode(entry?.intendedSource ?? 'mcp')
      || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)
      || !requestId
      || (input.profileRevision !== undefined && Math.trunc(Number(input.profileRevision)) !== currentProfileRevision)
      || !predecessorIdentityComplete;
    if (invalid) {
      const code = !entry || !entry.enabled ? 'CUTOVER_REQUIRED' : !predecessorIdentityComplete ? 'ORCHESTRATOR_CONTRACT_ERROR' : 'ORCHESTRATOR_CONTRACT_ERROR';
      const message = !entry || !entry.enabled ? `producer 未注册或已停用: ${producerId}` : !predecessorIdentityComplete ? 'daily continuation 需要 predecessorIntentId 与 rootRequestId。' : 'typed producer contract 不兼容当前请求。';
      return fallbackReceipt(state!, input, code, message);
    }
    const attestation = attestationFor(state!, producerId);
    const actorInput: WorkspaceIntentInput = {
      workspaceId: runtime.identity.workspaceId,
      businessDate,
      source: entry.intendedSource,
      rootMode,
      requestedAction: action,
      requestId,
      producerId,
      producerAttestation: attestation,
      logicalInput: input.logicalInput,
      payload: input.payload,
      channelPolicy: requestedPolicy,
      authorizedChannelPolicy: authorizedPolicy,
      profileRevision: currentProfileRevision,
      predecessorIntentId,
      predecessorRootId: rootRequestId,
      fence: state!.fence
    };
    const result = state!.actorStore.acceptIntent(actorInput);
    const receipt = actorResultReceipt(result, state!, input);
    refreshStateActor(state!);
    if (receipt.ok && runtime.getMcp()) wakeWorkspaceOrchestratorExecutor(runtime);
    return receipt;
  });
}

export function readWorkspaceOrchestratorRuntimeState(runtime: ActiveWorkspaceRuntime): WorkspaceOrchestratorRuntimeState | null {
  const state = runtimeStates.get(runtime);
  return state ? freezeRuntimeState(state) : null;
}


export type { ActorFence, StartupReconcileGate, WorkspaceOrchestratorActor, WorkspaceOrchestratorReceipt } from './workspace-orchestrator-actor.ts';
