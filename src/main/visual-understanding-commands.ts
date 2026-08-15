// WMB-5245：图片理解命令面（理解入队 / 理解重试 / 自动入队）。
// 设计 §13：新写命令纳入既有 Capability/dispatcher（CommandReceiptV1 + dataChanged + operation evidence）。
// 本模块只做信封/校验/广播；业务原语在 visual-source-lineage.ts（纯 DB，无 runtime 依赖）。

import { CommandDispatchError, type CommandActorV1 } from './command-dispatcher.ts';
import { dispatchBusinessCommand } from './business-command.ts';
import { broadcastDataChanged } from './data-changed.ts';
import {
  autoEnqueuePreservedSourceImages,
  enqueueVisualRun,
  retryVisualRun,
  VISUAL_AUTO_ENQUEUE_LIMIT,
  type EnqueueVisualRunInput,
  type VisualRunRecord
} from './visual-source-lineage.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';

const ownerActor = Object.freeze({ type: 'owner_ui' as const, id: 'renderer', label: 'Owner UI' });

function assertActive(runtime: ActiveWorkspaceRuntime): void {
  if (!runtime.isActive) throw new CommandDispatchError('WORKSPACE_STALE', '工作空间或运行时身份已失效。');
}

function broadcastVisualRunChanged(reason: string): void {
  broadcastDataChanged({ scopes: ['sources', 'knowledge', 'receipt'], reason });
}

/** 理解入队（含手动区域入队）；幂等键 = sourceId/sourceRevisionKey/assetId/schemaVersion。 */
export function dispatchEnqueueVisualRun(
  runtime: ActiveWorkspaceRuntime,
  requestId: string,
  input: EnqueueVisualRunInput,
  actor: CommandActorV1 = ownerActor
) {
  assertActive(runtime);
  return dispatchBusinessCommand(runtime, {
    command: 'visual.enqueue', requestId, actor, input,
    boundIdentity: { sourceId: input.sourceId, sourceRevisionId: input.sourceRevisionId, assetId: input.assetId },
    entityType: 'visual_run',
    execute: (database, normalized) => {
      const result = enqueueVisualRun(database, normalized);
      const data: VisualRunRecord = result.run;
      return { data, entityId: result.run.id, readback: result };
    }
  }).then((receipt) => {
    if (receipt.ok) broadcastVisualRunChanged('visual.enqueue');
    return receipt;
  });
}

/** 理解重试：失败 run → 新 attempt 行（旧行保留审计）；completed → 幂等返回现有行。 */
export function dispatchRetryVisualRun(
  runtime: ActiveWorkspaceRuntime,
  requestId: string,
  runId: string,
  actor: CommandActorV1 = ownerActor
) {
  assertActive(runtime);
  return dispatchBusinessCommand(runtime, {
    command: 'visual.retry', requestId, actor, input: { runId },
    boundIdentity: { runId }, entityType: 'visual_run',
    execute: (database) => {
      const result = retryVisualRun(database, runId);
      const data: VisualRunRecord = result.run;
      return { data, entityId: result.run.id, readback: result };
    }
  }).then((receipt) => {
    if (receipt.ok) broadcastVisualRunChanged('visual.retry');
    return receipt;
  });
}

/** 自动入队（≤12/Source revision）：读取 preserved 图片 binding 补齐缺失 run；幂等。 */
export function dispatchAutoEnqueuePreservedImages(
  runtime: ActiveWorkspaceRuntime,
  requestId: string,
  input: { sourceId: string; sourceRevisionKey: string; limit?: number },
  actor: CommandActorV1 = ownerActor
) {
  assertActive(runtime);
  return dispatchBusinessCommand(runtime, {
    command: 'visual.auto_enqueue', requestId, actor, input,
    boundIdentity: { sourceId: input.sourceId, sourceRevisionKey: input.sourceRevisionKey },
    entityType: 'visual_run',
    execute: (database, normalized) => {
      const result = autoEnqueuePreservedSourceImages(database, {
        sourceId: normalized.sourceId,
        sourceRevisionKey: normalized.sourceRevisionKey,
        limit: normalized.limit ?? VISUAL_AUTO_ENQUEUE_LIMIT
      });
      return { data: result, entityId: input.sourceId, readback: result };
    }
  }).then((receipt) => {
    if (receipt.ok) broadcastVisualRunChanged('visual.auto_enqueue');
    return receipt;
  });
}
