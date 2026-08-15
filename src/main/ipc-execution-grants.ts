import { randomUUID } from 'node:crypto';
import type { IpcMain } from 'electron';
import {
  dispatchIssueExecutionGrant,
  dispatchRevokeExecutionGrant,
  getExecutionGrant,
  listExecutionGrants,
  type IssueExecutionGrantInput,
  type PreciseExecutionGrant
} from './execution-grants.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';

export function registerExecutionGrantIpc(ipcMain: IpcMain, getRuntime: () => ActiveWorkspaceRuntime | null): void {
  ipcMain.handle('execution-grants:issue', async (_event, input: Omit<IssueExecutionGrantInput, 'requestId'> & { requestId?: string }) => {
    const runtime = requireRuntime(getRuntime());
    return dispatchIssueExecutionGrant(runtime, { ...input, requestId: input.requestId ?? randomUUID() });
  });
  ipcMain.handle('execution-grants:revoke', async (_event, input: {
    requestId?: string;
    executionGrantId: string;
    expectedRevision: number;
  }) => {
    const runtime = requireRuntime(getRuntime());
    return dispatchRevokeExecutionGrant(runtime, { ...input, requestId: input.requestId ?? randomUUID() });
  });
  ipcMain.handle('execution-grants:get', (_event, executionGrantId: string) => {
    const runtime = requireRuntime(getRuntime());
    return getExecutionGrant(runtime.database, executionGrantId, new Date(), runtime.identity);
  });
  ipcMain.handle('execution-grants:list', (_event, filters?: {
    taskId?: string | null;
    status?: PreciseExecutionGrant['status'];
  }) => {
    const runtime = requireRuntime(getRuntime());
    return listExecutionGrants(runtime.database, filters ?? {}, new Date(), runtime.identity);
  });
}

function requireRuntime(runtime: ActiveWorkspaceRuntime | null): ActiveWorkspaceRuntime {
  if (!runtime?.isActive) throw new Error('当前工作空间运行时尚未就绪。');
  return runtime;
}
