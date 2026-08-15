import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { recordOperation } from './operations.ts';

export type CommandActorV1 = Readonly<{
  type: 'owner_ui' | 'pi' | 'external_agent' | 'scheduler' | 'browser_adapter';
  id: string;
  label?: string;
}>;

export type CommandEnvelopeV1<T = unknown> = Readonly<{
  version: 'CommandEnvelopeV1';
  workspaceId: string;
  runtimeEpoch: string;
  command: string;
  requestId: string;
  inputHash: string;
  input: T;
  boundIdentity: Readonly<Record<string, unknown>>;
  actor: CommandActorV1;
  taskId?: string;
  workerLeaseId?: string;
  grantId?: string;
  executionGrantId?: string;
  causation?: Readonly<Record<string, unknown>>;
}>;

export type CommandErrorV1 = Readonly<{
  code: string;
  message: string;
  details?: Readonly<Record<string, unknown>>;
}>;

export type CommandReceiptV1<T = unknown> = Readonly<{
  version: 'CommandReceiptV1';
  receiptId: string;
  ok: boolean;
  workspaceId: string;
  runtimeEpoch: string;
  command: string;
  requestId: string;
  inputHash: string;
  actor: CommandActorV1;
  taskId: string | null;
  workerLeaseId: string | null;
  grantId: string | null;
  executionGrantId: string | null;
  causation: Readonly<Record<string, unknown>> | null;
  data: T | null;
  error: CommandErrorV1 | null;
  revisions: Readonly<{ before: number | null; after: number | null }>;
  readback: unknown;
  sideEffectState: string;
  createdAt: string;
}>;

export type CommandHandlerResult<T> = Readonly<{
  data: T;
  entityType: string;
  entityId?: string;
  beforeRevision?: number;
  afterRevision?: number;
  readback?: unknown;
  sideEffectState?: string;
}>;

type RuntimeIdentity = Readonly<{ workspaceId: string; rootPath: string; runtimeEpoch: string }>;

export class CommandDispatchError extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'CommandDispatchError';
    this.code = code;
    this.details = details;
  }
}

export class CommandDispatcher {
  private readonly database: DatabaseSync;
  private readonly identity: RuntimeIdentity;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly validateEnvelope: (envelope: CommandEnvelopeV1) => void;

  constructor(
    database: DatabaseSync,
    identity: RuntimeIdentity,
    now: () => Date = () => new Date(),
    createId: () => string = randomUUID,
    validateEnvelope: (envelope: CommandEnvelopeV1) => void = () => {}
  ) {
    this.database = database;
    this.identity = identity;
    this.now = now;
    this.createId = createId;
    this.validateEnvelope = validateEnvelope;
  }

  dispatch<T>(envelope: CommandEnvelopeV1, handler: () => CommandHandlerResult<T>): CommandReceiptV1<T> {
    this.assertEnvelope(envelope);
    const prior = this.findReceipt<T>(envelope.workspaceId, envelope.requestId);
    if (prior) return this.resolveReplay(prior, envelope);

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const raced = this.findReceipt<T>(envelope.workspaceId, envelope.requestId);
      if (raced) {
        const replay = this.resolveReplay(raced, envelope);
        this.database.exec('ROLLBACK');
        return replay;
      }
      this.validateEnvelope(envelope);
      const result = handler();
      const receipt = this.createReceipt(envelope, {
        ok: true,
        data: result.data,
        error: null,
        beforeRevision: result.beforeRevision ?? null,
        afterRevision: result.afterRevision ?? null,
        readback: result.readback ?? result.data,
        sideEffectState: result.sideEffectState ?? 'committed'
      });
      this.insertReceipt(receipt, envelope);
      recordOperation(this.database, {
        actorType: operationActor(envelope.actor.type),
        clientLabel: envelope.actor.label ?? envelope.actor.id,
        command: envelope.command,
        entityType: result.entityType,
        entityId: result.entityId,
        beforeRevision: result.beforeRevision,
        afterRevision: result.afterRevision,
        result: 'ok'
      });
      this.database.exec('COMMIT');
      return receipt;
    } catch (error) {
      this.database.exec('ROLLBACK');
      if (error instanceof CommandDispatchError && error.code === 'REQUEST_REPLAY_CONFLICT') throw error;
      return this.persistError(envelope, normalizeError(error));
    }
  }

  private persistError<T>(envelope: CommandEnvelopeV1, error: CommandErrorV1): CommandReceiptV1<T> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.findReceipt<T>(envelope.workspaceId, envelope.requestId);
      if (prior) {
        this.database.exec('ROLLBACK');
        return this.resolveReplay(prior, envelope);
      }
      const receipt = this.createReceipt<T>(envelope, {
        ok: false,
        data: null,
        error,
        beforeRevision: null,
        afterRevision: null,
        readback: null,
        sideEffectState: 'not_started'
      });
      this.insertReceipt(receipt, envelope);
      recordOperation(this.database, {
        actorType: operationActor(envelope.actor.type),
        clientLabel: envelope.actor.label ?? envelope.actor.id,
        command: envelope.command,
        entityType: 'command',
        result: 'error',
        errorCode: error.code
      });
      this.database.exec('COMMIT');
      return receipt;
    } catch (persistError) {
      this.database.exec('ROLLBACK');
      throw persistError;
    }
  }

  private assertEnvelope(envelope: CommandEnvelopeV1): void {
    if (envelope.version !== 'CommandEnvelopeV1') throw new CommandDispatchError('COMMAND_ENVELOPE_INVALID', '只接受 CommandEnvelopeV1。');
    if (envelope.workspaceId !== this.identity.workspaceId || envelope.runtimeEpoch !== this.identity.runtimeEpoch) {
      throw new CommandDispatchError('WORKSPACE_STALE', '工作空间或运行时身份已失效。');
    }
    const expectedHash = commandInputHash(envelope);
    if (envelope.inputHash !== expectedHash) throw new CommandDispatchError('COMMAND_INPUT_HASH_MISMATCH', '命令输入指纹不匹配。');
  }

  private resolveReplay<T>(prior: CommandReceiptV1<T>, envelope: CommandEnvelopeV1): CommandReceiptV1<T> {
    if (prior.command !== envelope.command || prior.inputHash !== envelope.inputHash) {
      throw new CommandDispatchError('REQUEST_REPLAY_CONFLICT', '同一 requestId 已绑定不同命令或输入。');
    }
    return prior;
  }

  private findReceipt<T>(workspaceId: string, requestId: string): CommandReceiptV1<T> | null {
    const row = this.database.prepare('SELECT receipt_json AS receiptJson, execution_grant_id AS executionGrantId FROM command_receipts WHERE workspace_id=? AND request_id=?')
      .get(workspaceId, requestId) as { receiptJson: string; executionGrantId: string | null } | undefined;
    if (!row) return null;
    const receipt = JSON.parse(row.receiptJson) as CommandReceiptV1<T>;
    return Object.freeze({ ...receipt, executionGrantId: row.executionGrantId ?? receipt.executionGrantId ?? null });
  }

  private createReceipt<T>(
    envelope: CommandEnvelopeV1,
    result: {
      ok: boolean;
      data: T | null;
      error: CommandErrorV1 | null;
      beforeRevision: number | null;
      afterRevision: number | null;
      readback: unknown;
      sideEffectState: string;
    }
  ): CommandReceiptV1<T> {
    return Object.freeze({
      version: 'CommandReceiptV1' as const,
      receiptId: this.createId(),
      ok: result.ok,
      workspaceId: envelope.workspaceId,
      runtimeEpoch: envelope.runtimeEpoch,
      command: envelope.command,
      requestId: envelope.requestId,
      inputHash: envelope.inputHash,
      actor: envelope.actor,
      taskId: envelope.taskId ?? null,
      workerLeaseId: envelope.workerLeaseId ?? null,
      grantId: envelope.grantId ?? null,
      executionGrantId: envelope.executionGrantId ?? null,
      causation: envelope.causation ?? null,
      data: result.data,
      error: result.error,
      revisions: Object.freeze({ before: result.beforeRevision, after: result.afterRevision }),
      readback: result.readback,
      sideEffectState: result.sideEffectState,
      createdAt: this.now().toISOString()
    });
  }

  private insertReceipt(receipt: CommandReceiptV1, envelope: CommandEnvelopeV1): void {
    this.database.prepare(`INSERT INTO command_receipts (
      id, workspace_id, runtime_epoch, request_id, command, input_hash, actor_type, actor_id,
      task_id, worker_lease_id, grant_id, execution_grant_id, envelope_json, receipt_json, status, result_json,
      error_json, readback_json, before_revision, after_revision, side_effect_state, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      receipt.receiptId, receipt.workspaceId, receipt.runtimeEpoch, receipt.requestId, receipt.command,
      receipt.inputHash, receipt.actor.type, receipt.actor.id, receipt.taskId, receipt.workerLeaseId,
      receipt.grantId, receipt.executionGrantId, JSON.stringify(envelope), JSON.stringify(receipt), receipt.ok ? 'ok' : 'error',
      receipt.data === null ? null : JSON.stringify(receipt.data), receipt.error === null ? null : JSON.stringify(receipt.error),
      receipt.readback === null ? null : JSON.stringify(receipt.readback), receipt.revisions.before,
      receipt.revisions.after, receipt.sideEffectState, receipt.createdAt
    );
  }
}

export function createCommandEnvelope<T>(input: Omit<CommandEnvelopeV1<T>, 'version' | 'inputHash'>): CommandEnvelopeV1<T> {
  const envelope = {
    ...input,
    input: normalizeJson(input.input) as T,
    boundIdentity: normalizeJson(input.boundIdentity) as Readonly<Record<string, unknown>>,
    version: 'CommandEnvelopeV1' as const,
    inputHash: ''
  };
  return Object.freeze({ ...envelope, inputHash: commandInputHash(envelope) });
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .map(([key, entry]) => [key, normalizeJson(entry)]));
}

export function commandInputHash(envelope: Omit<CommandEnvelopeV1, 'inputHash'> | CommandEnvelopeV1): string {
  return createHash('sha256').update(stableJson({
    command: envelope.command,
    input: envelope.input,
    workspaceId: envelope.workspaceId,
    runtimeEpoch: envelope.runtimeEpoch,
    actor: envelope.actor,
    taskId: envelope.taskId ?? null,
    workerLeaseId: envelope.workerLeaseId ?? null,
    grantId: envelope.grantId ?? null,
    boundIdentity: envelope.boundIdentity
  })).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function normalizeError(error: unknown): CommandErrorV1 {
  if (error instanceof CommandDispatchError) return { code: error.code, message: error.message, details: error.details };
  const candidate = error as { code?: unknown; message?: unknown };
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof candidate?.code === 'string' ? candidate.code : /^[A-Z][A-Z0-9_]+$/.test(message) ? message : 'COMMAND_FAILED';
  return { code, message };
}

function operationActor(actor: CommandActorV1['type']): 'ui' | 'mcp' | 'scheduler' {
  if (actor === 'owner_ui') return 'ui';
  if (actor === 'pi' || actor === 'external_agent') return 'mcp';
  return 'scheduler';
}
