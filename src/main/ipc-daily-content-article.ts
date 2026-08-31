import { ipcMain } from 'electron';
import { dispatchBusinessCommand } from './business-command.ts';
import { freshRequestId, ownerUiActor, readWorkspaceDatabase, requireBusinessRuntime, type BusinessIpcDependencies } from './ipc-business-context.ts';
import {
  ensureTargetArticleLinkInternal,
  finalizeTargetArticleInternal,
  getTargetArticleProjection,
  saveTargetArticleDraftInternal,
} from './daily-content-article.ts';

export function registerDailyContentArticleIpc(dependencies: BusinessIpcDependencies): void {
  ipcMain.handle('daily-target:ensure-article', async (_event, input: { targetId: string; requestId?: string }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const requestId = typeof input?.requestId === 'string' && input.requestId.trim() ? input.requestId : freshRequestId();
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'daily_content_target.ensure_article',
      requestId,
      actor: ownerUiActor,
      input,
      boundIdentity: {},
      entityType: 'daily_content_target',
      execute: (database, normalizedInput) => {
        const typed = normalizedInput as { targetId: string };
        const data = ensureTargetArticleLinkInternal(database, typed.targetId);
        return { data, entityId: typed.targetId, readback: data };
      },
    });
    return receipt;
  });

  ipcMain.handle('daily-target:save-article', async (_event, input: { targetId: string; body: string; title?: string; expectedRevision: number; author?: 'user' | 'ai'; requestId?: string }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const requestId = typeof input?.requestId === 'string' && input.requestId.trim() ? input.requestId : freshRequestId();
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'daily_content_article.save_draft',
      requestId,
      actor: ownerUiActor,
      input,
      boundIdentity: {},
      entityType: 'daily_content_target',
      execute: (database, normalizedInput) => {
        const typed = normalizedInput as { targetId: string; body: string; title?: string; expectedRevision: number; author?: 'user' | 'ai' };
        const data = saveTargetArticleDraftInternal(database, typed);
        return { data, entityId: typed.targetId, readback: data };
      },
    });
    return receipt;
  });

  ipcMain.handle('daily-target:finalize-article', async (_event, input: { targetId: string; expectedRevision: number; requestId?: string }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const requestId = typeof input?.requestId === 'string' && input.requestId.trim() ? input.requestId : freshRequestId();
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'daily_content_article.finalize',
      requestId,
      actor: ownerUiActor,
      input,
      boundIdentity: {},
      entityType: 'daily_content_target',
      execute: (database, normalizedInput) => {
        const typed = normalizedInput as { targetId: string; expectedRevision: number };
        const data = finalizeTargetArticleInternal(database, typed);
        return { data, entityId: typed.targetId, readback: data };
      },
    });
    return receipt;
  });

  ipcMain.handle('daily-target:get-article', async (_event, targetId: string) =>
    readWorkspaceDatabase(dependencies, () => null, (database) => getTargetArticleProjection(database, targetId))
  );
}
