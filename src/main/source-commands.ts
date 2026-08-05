import { broadcastDataChanged } from './data-changed.ts';
import { createCommandEnvelope, type CommandActorV1, type CommandReceiptV1 } from './command-dispatcher.ts';
import { getSource, upsertSource, type SourceInput, type SourceRecord } from './sources.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';

export const SOURCE_UPSERT_BATCH_COMMAND = 'sources.upsert_batch';

export type SourceUpsertBatchResult = Readonly<{
  items: ReadonlyArray<Readonly<{ id: string; created: boolean; revision: number }>>;
  sources: ReadonlyArray<SourceRecord>;
}>;

export function dispatchSourceUpsertBatch(
  runtime: ActiveWorkspaceRuntime,
  input: {
    requestId: string;
    actor: CommandActorV1;
    items: SourceInput[];
    taskId?: string;
    workerLeaseId?: string;
    grantId?: string;
    causation?: Readonly<Record<string, unknown>>;
  }
): Promise<CommandReceiptV1<SourceUpsertBatchResult>> {
  const envelope = createCommandEnvelope({
    workspaceId: runtime.identity.workspaceId,
    runtimeEpoch: runtime.identity.runtimeEpoch,
    command: SOURCE_UPSERT_BATCH_COMMAND,
    requestId: input.requestId,
    input: { items: input.items },
    boundIdentity: { entityType: 'source_item' },
    actor: input.actor,
    taskId: input.taskId,
    workerLeaseId: input.workerLeaseId,
    grantId: input.grantId,
    causation: input.causation
  });
  return runtime.dispatchCommand(envelope, () => {
    const saved = envelope.input.items.map((item) => upsertSource(runtime.database, item, false));
    const sources = saved.map((item) => getSource(runtime.database, item.id)).filter((item): item is SourceRecord => item !== null);
    return {
      data: { items: saved, sources },
      entityType: 'source_item',
      entityId: saved.length === 1 ? saved[0].id : undefined,
      beforeRevision: saved.length === 1 ? envelope.input.items[0].expectedRevision : undefined,
      afterRevision: saved.length === 1 ? saved[0].revision : undefined,
      readback: sources
    };
  }).then((receipt) => {
    if (receipt.ok) broadcastDataChanged({ scopes: ['sources', 'library', 'today'], reason: 'source.upsert' });
    return receipt;
  });
}
