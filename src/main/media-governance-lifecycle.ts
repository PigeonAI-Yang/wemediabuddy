// WMB-5247：媒体治理自动调度（有界、单飞、不阻塞关机）。
// - 启动即跑一轮：staging/.tmp 清理 + 30 天无引用派生缓存 GC（DB 删除经 dispatcher 授权命令，
//   scheduler actor 免 grant——非 pi/external_agent 门；写守卫在 dispatch 事务内放行）。
// - 之后每 MEDIA_GOVERNANCE_INTERVAL_MS（6h）一轮；单飞（上一轮未完成则跳过本轮）。
// - stop() 清 interval 并 unref，绝不阻塞 app quit；与 research-successor 调度器同生命周期范式。
import { rm } from 'node:fs/promises';
import { dispatchBusinessCommand, requireReceiptData } from './business-command.ts';
import {
  executeDerivedCacheGc,
  planDerivedCacheGc,
  resolveAssetFileWithinDataRoot,
  runStagingCleanup,
  type DerivedGcCandidate,
  type MediaGcPlan
} from './media-governance.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';

export const MEDIA_GOVERNANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type MediaGcCommandData = Readonly<{
  plan: MediaGcPlan;
  dryRun: boolean;
  collected: DerivedGcCandidate[];
  errors: ReadonlyArray<Readonly<{ assetId: string; message: string }>>;
  removedBytes: number;
}>;

/** 经 dispatcher 授权事务执行派生缓存 GC 的 DB 部分，回执后删除物理文件（IPC 与调度同路径）。 */
export async function runMediaGcCommand(
  runtime: ActiveWorkspaceRuntime,
  input: { dryRun?: boolean; retentionDays?: number; requestId?: string } = {}
): Promise<MediaGcCommandData> {
  const dataRoot = runtime.identity.rootPath;
  const requestId = input.requestId ?? `media-gc:${new Date().toISOString()}`;
  const receipt = await dispatchBusinessCommand(runtime, {
    command: 'media.gc',
    requestId,
    actor: { type: 'scheduler', id: 'media-governance', label: 'media-governance' },
    input: { dryRun: input.dryRun === true, retentionDays: input.retentionDays ?? null },
    boundIdentity: { entityType: 'asset' },
    entityType: 'media_gc',
    execute: (database, value) => {
      const dryRun = value.dryRun === true;
      const plan = planDerivedCacheGc(database, dataRoot, {
        retentionDays: typeof value.retentionDays === 'number' ? value.retentionDays : undefined
      });
      if (dryRun || plan.candidates.length === 0) {
        return { data: { plan, dryRun, collected: [], errors: [], removedBytes: 0 }, entityType: 'media_gc' };
      }
      const { deleted, errors } = executeDerivedCacheGc(database, plan, requestId);
      return { data: { plan, dryRun: false, collected: deleted, errors, removedBytes: 0 }, entityType: 'media_gc' };
    }
  });
  const data = requireReceiptData<MediaGcCommandData>(receipt);
  if (data.dryRun || data.collected.length === 0) return data;
  let removedBytes = 0;
  const fileErrors: Array<{ assetId: string; message: string }> = [];
  for (const candidate of data.collected) {
    const filePath = resolveAssetFileWithinDataRoot(dataRoot, candidate.relativePath);
    if (!filePath) {
      fileErrors.push({ assetId: candidate.assetId, message: 'relative_path 越界，文件未删除' });
      continue;
    }
    try {
      await rm(filePath, { force: true });
      removedBytes += candidate.byteCount;
    } catch (error) {
      fileErrors.push({ assetId: candidate.assetId, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ...data, removedBytes, errors: [...data.errors, ...fileErrors] };
}

/** 一轮完整治理（有界）：staging/.tmp 清理 + 派生缓存 GC。失败只记录日志，绝不阻断启动/退出。 */
export async function runMediaGovernanceCycle(
  runtime: ActiveWorkspaceRuntime
): Promise<{ staging: Awaited<ReturnType<typeof runStagingCleanup>>; gc: MediaGcCommandData }> {
  const staging = await runStagingCleanup(runtime.identity.rootPath);
  const gc = await runMediaGcCommand(runtime);
  return { staging, gc };
}

type SchedulerState = { timer: ReturnType<typeof setInterval> | null; running: boolean };
const schedulerState: SchedulerState = { timer: null, running: false };

/**
 * 启动治理调度器：立即有界跑一轮（fire-and-forget），之后每 MEDIA_GOVERNANCE_INTERVAL_MS 一轮（单飞）。
 * 返回 stop()：清 interval 并 unref，不阻塞关机。重复 start 先停旧 timer。
 */
export function startMediaGovernanceScheduler(runtime: ActiveWorkspaceRuntime): () => void {
  const runOnce = () => {
    if (schedulerState.running) return;
    schedulerState.running = true;
    void runMediaGovernanceCycle(runtime)
      .catch((error) => {
        console.error('[media-governance] cycle failed', error);
      })
      .finally(() => {
        schedulerState.running = false;
      });
  };
  runOnce();
  if (schedulerState.timer) clearInterval(schedulerState.timer);
  schedulerState.timer = setInterval(runOnce, MEDIA_GOVERNANCE_INTERVAL_MS);
  schedulerState.timer.unref?.();
  return () => {
    if (schedulerState.timer) {
      clearInterval(schedulerState.timer);
      schedulerState.timer = null;
    }
  };
}