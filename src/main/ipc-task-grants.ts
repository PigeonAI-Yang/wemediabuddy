import { randomUUID } from 'node:crypto';
import type { IpcMain } from 'electron';
import { dispatchIssueTaskGrant, dispatchRevokeTaskGrant, getTaskGrant, listTaskGrants, type TaskGrantWorker } from './task-grants.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';

export function registerTaskGrantIpc(ipcMain: IpcMain, getRuntime: () => ActiveWorkspaceRuntime | null): void {
  ipcMain.handle('task-grants:issue', async (_event, input: {
    requestId?: string;
    taskId: string;
    ownerGoal: string;
    allowedCommands: string[];
    workers: TaskGrantWorker[];
    relevantContext?: Record<string, unknown>;
    expiresAt: string;
  }) => {
    const runtime = requireRuntime(getRuntime());
    return dispatchIssueTaskGrant(runtime, { ...input, requestId: input.requestId ?? randomUUID() });
  });
  ipcMain.handle('task-grants:revoke', async (_event, input: { requestId?: string; grantId: string; expectedRevision: number }) => {
    const runtime = requireRuntime(getRuntime());
    return dispatchRevokeTaskGrant(runtime, { ...input, requestId: input.requestId ?? randomUUID() });
  });
  ipcMain.handle('task-grants:get', (_event, grantId: string) => {
    const runtime = requireRuntime(getRuntime());
    return getTaskGrant(runtime.database, grantId, new Date(), runtime.identity);
  });
  ipcMain.handle('task-grants:list', (_event, taskId: string) => {
    const runtime = requireRuntime(getRuntime());
    return listTaskGrants(runtime.database, taskId, new Date(), runtime.identity);
  });
}

function requireRuntime(runtime: ActiveWorkspaceRuntime | null): ActiveWorkspaceRuntime {
  if (!runtime?.isActive) throw new Error('当前工作空间运行时尚未就绪。');
  return runtime;
}
