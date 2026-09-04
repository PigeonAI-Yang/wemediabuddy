import { ipcMain } from 'electron';
import { dispatchBusinessCommand } from './business-command.ts';
import { freshRequestId, ownerUiActor, readWorkspaceDatabase, requireBusinessRuntime, type BusinessIpcDependencies } from './ipc-business-context.ts';
import {
  pauseDailyCycleInternal,
  resumeDailyCycleInternal,
  skipTargetInternal,
  replaceTargetInternal,
  carryTargetInternal,
  transitionTargetInternal,
  getDailyCycleProjection,
  readDailyCycleForToday,
} from './daily-content-cycle.ts';
import { getDailyOrchestrationSchedule, setDailyOrchestrationSchedule } from './daily-orchestration.ts';

type DailyOrchestrationIpcDependencies = BusinessIpcDependencies;

export function registerDailyContentCycleIpc(dependencies: DailyOrchestrationIpcDependencies): void {

  ipcMain.handle('daily-cycle:pause', async (_event, input: { businessDate: string; expectedRevision: number; requestId?: string }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const requestId = typeof input?.requestId === 'string' && input.requestId.trim() ? input.requestId : freshRequestId();
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'daily_content_cycle.pause',
      requestId,
      actor: ownerUiActor,
      input,
      boundIdentity: {},
      entityType: 'daily_content_cycle',
      execute: (database, normalizedInput) => {
        const typed = normalizedInput as { businessDate: string; expectedRevision: number };
        const data = pauseDailyCycleInternal(database, typed.businessDate, typed.expectedRevision);
        const afterRevision = (data.cycle as { revision?: number } | null)?.revision;
        return { data, entityId: typed.businessDate, beforeRevision: typed.expectedRevision, afterRevision: afterRevision ? Number(afterRevision) : undefined, readback: data };
      },
    });
    return receipt;
  });

  ipcMain.handle('daily-cycle:resume', async (_event, input: { businessDate: string; expectedRevision: number; requestId?: string }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const requestId = typeof input?.requestId === 'string' && input.requestId.trim() ? input.requestId : freshRequestId();
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'daily_content_cycle.resume',
      requestId,
      actor: ownerUiActor,
      input,
      boundIdentity: {},
      entityType: 'daily_content_cycle',
      execute: (database, normalizedInput) => {
        const typed = normalizedInput as { businessDate: string; expectedRevision: number };
        const data = resumeDailyCycleInternal(database, typed.businessDate, typed.expectedRevision);
        const afterRevision = (data.cycle as { revision?: number } | null)?.revision;
        return { data, entityId: typed.businessDate, beforeRevision: typed.expectedRevision, afterRevision: afterRevision ? Number(afterRevision) : undefined, readback: data };
      },
    });
    return receipt;
  });

  ipcMain.handle('daily-cycle:get', async (_event, businessDate: string) =>
    readWorkspaceDatabase(dependencies, () => null, database => readDailyCycleForToday(database, businessDate))
  );
  ipcMain.handle('daily-orchestration:get-schedule', async () =>
    readWorkspaceDatabase(dependencies, () => ({ time: '09:00', autoEnabled: true }), database => getDailyOrchestrationSchedule(database))
  );
  ipcMain.handle('daily-orchestration:set-schedule', async (_event, input: { time?: string; autoEnabled?: boolean; requestId?: string }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const requestId = typeof input?.requestId === 'string' && input.requestId.trim() ? input.requestId : freshRequestId();
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'daily_orchestration.set_schedule',
      requestId,
      actor: ownerUiActor,
      input: { time: input.time, autoEnabled: input.autoEnabled },
      boundIdentity: {},
      entityType: 'daily_orchestration',
      execute: (database, normalizedInput) => {
        const typed = normalizedInput as { time?: string; autoEnabled?: boolean };
        const data = setDailyOrchestrationSchedule(database, typed);
        return { data: data as unknown as Record<string, unknown>, entityId: 'schedule', readback: data };
      },
    });
    return receipt;
  });

  ipcMain.handle('daily-target:transition', async (_event, input: { targetId: string; expectedRevision: number; toStatus: string; blockedReasonCode?: string | null; requestId?: string }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const requestId = typeof input?.requestId === 'string' && input.requestId.trim() ? input.requestId : freshRequestId();
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'daily_content_target.transition',
      requestId,
      actor: ownerUiActor,
      input,
      boundIdentity: {},
      entityType: 'daily_content_target',
      execute: (database, normalizedInput) => {
        const typed = normalizedInput as { targetId: string; expectedRevision: number; toStatus: string; blockedReasonCode?: string | null };
        const data = transitionTargetInternal(database, { targetId: typed.targetId, expectedRevision: typed.expectedRevision, toStatus: typed.toStatus as never, blockedReasonCode: typed.blockedReasonCode ?? null });
        return { data, entityId: typed.targetId, beforeRevision: typed.expectedRevision, afterRevision: (data as { revision: number }).revision ? Number((data as { revision: number }).revision) : undefined, readback: data };
      },
    });
    return receipt;
  });

  ipcMain.handle('daily-target:skip', async (_event, input: { targetId: string; expectedRevision: number; reasonCode?: string | null; requestId?: string }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const requestId = typeof input?.requestId === 'string' && input.requestId.trim() ? input.requestId : freshRequestId();
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'daily_content_target.skip',
      requestId,
      actor: ownerUiActor,
      input,
      boundIdentity: {},
      entityType: 'daily_content_target',
      execute: (database, normalizedInput) => {
        const typed = normalizedInput as { targetId: string; expectedRevision: number; reasonCode?: string | null };
        const data = skipTargetInternal(database, { targetId: typed.targetId, expectedRevision: typed.expectedRevision, reasonCode: typed.reasonCode ?? null });
        return { data, entityId: typed.targetId, beforeRevision: typed.expectedRevision, afterRevision: (data as { revision: number }).revision ? Number((data as { revision: number }).revision) : undefined, readback: data };
      },
    });
    return receipt;
  });

  ipcMain.handle('daily-target:replace', async (_event, input: { targetId: string; expectedRevision: number; replacementSourceItemId: string; requestId?: string }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const requestId = typeof input?.requestId === 'string' && input.requestId.trim() ? input.requestId : freshRequestId();
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'daily_content_target.replace',
      requestId,
      actor: ownerUiActor,
      input,
      boundIdentity: {},
      entityType: 'daily_content_target',
      execute: (database, normalizedInput) => {
        const typed = normalizedInput as { targetId: string; expectedRevision: number; replacementSourceItemId: string };
        const data = replaceTargetInternal(database, { targetId: typed.targetId, expectedRevision: typed.expectedRevision, replacementSourceItemId: typed.replacementSourceItemId });
        return { data: data as unknown as Record<string, unknown>, entityId: typed.targetId, beforeRevision: typed.expectedRevision, afterRevision: (data.created as { revision: number }).revision ? Number((data.created as { revision: number }).revision) : undefined, readback: data };
      },
    });
    return receipt;
  });

  ipcMain.handle('daily-target:carry', async (_event, input: { targetId: string; expectedRevision: number; nextBusinessDate: string; requestId?: string }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const requestId = typeof input?.requestId === 'string' && input.requestId.trim() ? input.requestId : freshRequestId();
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'daily_content_target.carry',
      requestId,
      actor: ownerUiActor,
      input,
      boundIdentity: {},
      entityType: 'daily_content_target',
      execute: (database, normalizedInput) => {
        const typed = normalizedInput as { targetId: string; expectedRevision: number; nextBusinessDate: string };
        const data = carryTargetInternal(database, { targetId: typed.targetId, expectedRevision: typed.expectedRevision, nextBusinessDate: typed.nextBusinessDate });
        return { data: data as unknown as Record<string, unknown>, entityId: typed.targetId, beforeRevision: typed.expectedRevision, afterRevision: (data.carriedTo as { revision: number }).revision ? Number((data.carriedTo as { revision: number }).revision) : undefined, readback: data };
      },
    });
    return receipt;
  });

  void getDailyCycleProjection;
}
