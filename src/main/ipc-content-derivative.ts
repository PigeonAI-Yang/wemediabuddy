import { ipcMain } from 'electron';
import { dispatchBusinessCommand } from './business-command.ts';
import { freshRequestId, ownerUiActor, readWorkspaceDatabase, requireBusinessRuntime, type BusinessIpcDependencies } from './ipc-business-context.ts';
import { ensureContentDerivativeInternal, finalizeDerivativeVersionInternal, getDerivativeProjectionInternal, getStudioDualProjectionInternal, saveDerivativeVersionInternal } from './content-derivative.ts';

export function registerContentDerivativeIpc(dependencies: BusinessIpcDependencies): void {
  ipcMain.handle('content-derivative:ensure', async (_event, input: { projectId: string; requestId?: string }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const requestId = typeof input?.requestId === 'string' && input.requestId.trim() ? input.requestId : freshRequestId();
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'content_derivative.ensure',
      requestId,
      actor: ownerUiActor,
      input,
      boundIdentity: {},
      entityType: 'content_derivative',
      execute: (database, normalizedInput) => {
        const typed = normalizedInput as { projectId: string };
        const data = ensureContentDerivativeInternal(database, typed.projectId);
        return { data, entityId: typed.projectId, readback: data };
      },
    });
    return receipt;
  });
  ipcMain.handle('content-derivative:save-version', async (_event, input: { projectId: string; sourceContentVersionId: string; title: string; body: string; formatDecisionJson?: string; author?: string; requestId?: string }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const requestId = typeof input?.requestId === 'string' && input.requestId.trim() ? input.requestId : freshRequestId();
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'content_derivative.save_version',
      requestId,
      actor: ownerUiActor,
      input,
      boundIdentity: {},
      entityType: 'content_derivative',
      execute: (database, normalizedInput) => {
        const typed = normalizedInput as { projectId: string; sourceContentVersionId: string; title: string; body: string; formatDecisionJson?: string; author?: string };
        const data = saveDerivativeVersionInternal(database, typed);
        return { data, entityId: typed.projectId, readback: data };
      },
    });
    return receipt;
  });
  ipcMain.handle('content-derivative:finalize-version', async (_event, input: { projectId: string; expectedLatestVersionNumber?: number | null; requestId?: string }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const requestId = typeof input?.requestId === 'string' && input.requestId.trim() ? input.requestId : freshRequestId();
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'content_derivative.finalize_version',
      requestId,
      actor: ownerUiActor,
      input,
      boundIdentity: {},
      entityType: 'content_derivative',
      execute: (database, normalizedInput) => {
        const typed = normalizedInput as { projectId: string; expectedLatestVersionNumber?: number | null };
        const data = finalizeDerivativeVersionInternal(database, typed);
        return { data, entityId: typed.projectId, readback: data };
      },
    });
    return receipt;
  });
  ipcMain.handle('studio:dual-projection', async (_event, projectId: string) =>
    readWorkspaceDatabase(dependencies, () => null, (database) => getStudioDualProjectionInternal(database, projectId))
  );
  ipcMain.handle('studio:derivative-projection', async (_event, projectId: string) =>
    readWorkspaceDatabase(dependencies, () => null, (database) => getDerivativeProjectionInternal(database, projectId))
  );
}
