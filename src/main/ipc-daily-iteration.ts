import { ipcMain } from 'electron';
import { dispatchBusinessCommand } from './business-command.ts';
import { freshRequestId, ownerUiActor, readWorkspaceDatabase, requireBusinessRuntime, type BusinessIpcDependencies } from './ipc-business-context.ts';
import {
  ensureDraftRevisionTargetInternal,
  ensurePublishedRevisionTargetInternal,
  createIterationContentVersionInternal,
  getYesterdayIterationProjection,
} from './daily-iteration.ts';

export function registerDailyIterationIpc(dependencies: BusinessIpcDependencies): void {
  ipcMain.handle('daily-iteration:draft-ensure', async (_event, input: { businessDate: string; projectId: string; predecessorContentVersionId: string; predecessorTargetId?: string | null; requestId?: string }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const requestId = typeof input?.requestId === 'string' && input.requestId.trim() ? input.requestId : freshRequestId();
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'daily_iteration.draft_ensure',
      requestId,
      actor: ownerUiActor,
      input,
      boundIdentity: { businessDate: input.businessDate, projectId: input.projectId, predecessorContentVersionId: input.predecessorContentVersionId },
      entityType: 'daily_content_target',
      execute: (database, normalized) => {
        const data = ensureDraftRevisionTargetInternal(database, normalized as never) as Record<string, unknown>;
        return { data, entityId: String(data.id), afterRevision: Number(data.revision), readback: data };
      },
    });
    return receipt;
  });

  ipcMain.handle('daily-iteration:published-ensure', async (_event, input: { businessDate: string; projectId: string; predecessorPublicationId: string; predecessorContentVersionId: string; requestId?: string }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const requestId = typeof input?.requestId === 'string' && input.requestId.trim() ? input.requestId : freshRequestId();
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'daily_iteration.published_ensure',
      requestId,
      actor: ownerUiActor,
      input,
      boundIdentity: { businessDate: input.businessDate, projectId: input.projectId, predecessorPublicationId: input.predecessorPublicationId },
      entityType: 'daily_content_target',
      execute: (database, normalized) => {
        const data = ensurePublishedRevisionTargetInternal(database, normalized as never) as Record<string, unknown>;
        return { data, entityId: String((data as { id: unknown }).id), afterRevision: Number((data as { revision: unknown }).revision), readback: data };
      },
    });
    return receipt;
  });

  ipcMain.handle('daily-iteration:version-create', async (_event, input: { projectId: string; predecessorContentVersionId: string; body?: string; requestId?: string }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const requestId = typeof input?.requestId === 'string' && input.requestId.trim() ? input.requestId : freshRequestId();
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'daily_iteration.version_create',
      requestId,
      actor: ownerUiActor,
      input,
      boundIdentity: { projectId: input.projectId, predecessorContentVersionId: input.predecessorContentVersionId },
      entityType: 'content_version',
      execute: (database, normalized) => {
        const data = createIterationContentVersionInternal(database, normalized as never) as Record<string, unknown>;
        return { data, entityId: String((data as { id: unknown }).id), readback: data };
      },
    });
    return receipt;
  });

  ipcMain.handle('daily-iteration:projection', async (_event, businessDate: string) =>
    readWorkspaceDatabase(dependencies, () => null, database => getYesterdayIterationProjection(database, businessDate))
  );
}
