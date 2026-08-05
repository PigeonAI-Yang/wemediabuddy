import { DatabaseSync } from 'node:sqlite';
import {
  CommandDispatchError,
  createCommandEnvelope,
  type CommandActorV1,
  type CommandErrorV1,
  type CommandReceiptV1
} from './command-dispatcher.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';

type DomainCommandResult<T> = Readonly<{
  ok: boolean;
  data: T | null;
  error: CommandErrorV1 | null;
}>;

type BusinessCommandExecution<TData> = Readonly<{
  data: TData;
  entityId?: string;
  beforeRevision?: number;
  afterRevision?: number;
  readback?: unknown;
  sideEffectState?: string;
}>;

type BusinessCommandSpec<TInput, TData> = Readonly<{
  command: string;
  requestId: string;
  actor: CommandActorV1;
  input: TInput;
  boundIdentity: Readonly<Record<string, unknown>>;
  taskId?: string;
  workerLeaseId?: string;
  grantId?: string;
  executionGrantId?: string;
  causation?: Readonly<Record<string, unknown>>;
  entityType: string;
  execute: (database: DatabaseSync, normalizedInput: TInput) => BusinessCommandExecution<TData>;
}>;

export function dispatchBusinessCommand<TInput, TData>(
  runtime: ActiveWorkspaceRuntime,
  spec: BusinessCommandSpec<TInput, TData>
): Promise<CommandReceiptV1<TData>> {
  const envelope = createCommandEnvelope({
    workspaceId: runtime.identity.workspaceId,
    runtimeEpoch: runtime.identity.runtimeEpoch,
    command: spec.command,
    requestId: spec.requestId,
    actor: spec.actor,
    input: spec.input,
    boundIdentity: spec.boundIdentity,
    taskId: spec.taskId,
    workerLeaseId: spec.workerLeaseId,
    grantId: spec.grantId,
    executionGrantId: spec.executionGrantId,
    causation: spec.causation
  });
  return runtime.dispatchCommand(envelope, () => ({
    ...spec.execute(runtime.database, envelope.input),
    entityType: spec.entityType
  }));
}

export function requireReceiptData<T>(receipt: CommandReceiptV1<T>): T {
  if (receipt.ok) return receipt.data as T;
  const error = receipt.error ?? { code: 'COMMAND_FAILED', message: 'Command failed.' };
  throw Object.assign(new Error(error.message), { code: error.code, details: error.details });
}

export function requireCommandResultData<T>(result: DomainCommandResult<T>): T {
  if (result.ok) return result.data as T;
  const error = result.error ?? { code: 'COMMAND_FAILED', message: 'Command failed.' };
  throw new CommandDispatchError(error.code, error.message, error.details);
}

export function receiptAsCommandResult<T>(receipt: CommandReceiptV1<T>): DomainCommandResult<T> {
  return receipt.ok
    ? { ok: true, data: receipt.data as T, error: null }
    : { ok: false, data: null, error: receipt.error };
}
