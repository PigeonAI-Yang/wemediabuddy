// WMB-5247：情报媒体治理 IPC（owner UI 显式动作；无 Agent grant，不进 TASK_INTERNAL_COMMANDS）。
// - media:rights-override：restricted 显式所有者确认 → media.rights_override 命令 + 证据落库。
// - media:gc-run：30 天无引用派生缓存 GC（DB 删除在命令事务内，物理文件删除在回执后异步）。
// - media:staging-cleanup：M1 staging/.tmp 清理（纯文件操作，无 DB 写）。
// - media:delete-gate：Source 删除前的只读引用摘要（预删除检查）。
import { ipcMain } from 'electron';
import { dispatchBusinessCommand, requireReceiptData } from './business-command.ts';
import { runStagingCleanup, sourceAssetReferenceSummary } from './media-governance.ts';
import { runMediaGcCommand } from './media-governance-lifecycle.ts';
import { recordRestrictedOverride, RESTRICTED_OVERRIDE_COMMAND, type RestrictedOverrideRecord } from './media-rights.ts';
import {
  freshRequestId,
  ownerUiActor,
  readWorkspaceDatabase,
  requireBusinessRuntime,
  type BusinessIpcDependencies
} from './ipc-business-context.ts';

export function registerMediaGovernanceIpc(dependencies: BusinessIpcDependencies): void {
  // restricted 显式所有者确认证据（owner UI 专属；重放幂等由 dispatcher requestId 保证）。
  ipcMain.handle('media:rights-override', async (_event, input: { bindingId: string; reason: string }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    if (!input?.bindingId) throw new Error('缺少 bindingId。');
    const requestId = freshRequestId();
    const receipt = await dispatchBusinessCommand(runtime, {
      command: RESTRICTED_OVERRIDE_COMMAND,
      requestId,
      actor: ownerUiActor,
      input: { bindingId: input.bindingId, reason: input.reason },
      boundIdentity: { entityType: 'source_media_binding', entityId: input.bindingId },
      entityType: 'source_media_binding',
      execute: (database, value) => {
        const data = recordRestrictedOverride(database, {
          bindingId: value.bindingId,
          reason: value.reason,
          confirmedBy: 'owner-ui',
          requestId
        });
        return { data, entityId: value.bindingId, readback: data };
      }
    });
    return requireReceiptData<RestrictedOverrideRecord>(receipt);
  });

  // 引用感知派生缓存 GC（与自动调度共用 runMediaGcCommand：DB 删除在命令事务内，物理文件在回执后删除）。
  ipcMain.handle('media:gc-run', async (_event, input: { dryRun?: boolean; retentionDays?: number } = {}) => {
    const runtime = await requireBusinessRuntime(dependencies);
    return runMediaGcCommand(runtime, {
      dryRun: input?.dryRun === true,
      retentionDays: input?.retentionDays,
      requestId: freshRequestId()
    });
  });

  // M1 staging/.tmp 清理（纯文件操作：只删指定目录内超窗口的 .part/.tmp，无 DB 写）。
  ipcMain.handle('media:staging-cleanup', async (_event, input: { dryRun?: boolean; maxStaleMs?: number } = {}) => {
    const runtime = await requireBusinessRuntime(dependencies);
    return runStagingCleanup(runtime.identity.rootPath, {
      dryRun: input?.dryRun === true,
      maxStaleMs: input?.maxStaleMs
    });
  });

  // Source 删除前的只读引用摘要（预删除检查；不触发任何写）。
  ipcMain.handle('media:delete-gate', (_event, input: { sourceId: string }) =>
    readWorkspaceDatabase(dependencies, () => null, (database) => sourceAssetReferenceSummary(database, input.sourceId))
  );
}