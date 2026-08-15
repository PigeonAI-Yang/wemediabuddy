// WMB-5246: 创作媒体建议 IPC（MediaRecommendations 所有）。
// 复用现有 business-command 派发 + operation evidence + dataChanged 广播约定；
// 读走 readWorkspaceDatabase，写走 dispatchBusinessCommand 事务。
// 接受/拒绝只是审计状态决定；Content/Platform Binding 写入仍走独立的 Studio 保存命令（设计 §12.3）。

import { ipcMain } from 'electron';
import { broadcastDataChanged } from './data-changed.ts';
import { dispatchBusinessCommand, receiptAsCommandResult } from './business-command.ts';
import { freshRequestId, ownerUiActor, readWorkspaceDatabase, requireBusinessRuntime, type BusinessIpcDependencies } from './ipc-business-context.ts';
import {
  MEDIA_RECOMMENDATIONS_DECIDE_IPC_CHANNEL,
  MEDIA_RECOMMENDATIONS_GENERATE_IPC_CHANNEL,
  MEDIA_RECOMMENDATIONS_LIST_IPC_CHANNEL,
  type MediaRecommendation,
  type MediaRecommendationsReadModel
} from '../shared/media-recommendations.ts';
import {
  decideMediaRecommendation,
  generateMediaRecommendations,
  proposeMediaRecommendations,
  readMediaRecommendations,
  supersedeProposedRecommendations,
  type GenerateMediaRecommendationsInput
} from './media-recommendations.ts';

export function registerMediaRecommendationsIpc(dependencies: BusinessIpcDependencies): void {
  ipcMain.handle(MEDIA_RECOMMENDATIONS_LIST_IPC_CHANNEL, (_event, input: { contentVersionId: string; projectId?: string }) =>
    readWorkspaceDatabase(dependencies, (): MediaRecommendationsReadModel => ({ contentVersionId: String(input?.contentVersionId ?? ''), projectId: String(input?.projectId ?? ''), claims: [], counts: { proposed: 0, accepted: 0, rejected: 0, superseded: 0 } }),
      (database) => readMediaRecommendations(database, {
        contentVersionId: String(input?.contentVersionId ?? ''),
        projectId: input?.projectId ? String(input.projectId) : undefined
      })));

  ipcMain.handle(MEDIA_RECOMMENDATIONS_GENERATE_IPC_CHANNEL, async (_event, input: GenerateMediaRecommendationsInput & { requestId?: string }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const requestId = input.requestId?.trim() || freshRequestId();
    const commandInput = { ...input, requestId };
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'media.recommendations_generate', requestId, actor: ownerUiActor, input: commandInput,
      boundIdentity: { entityType: 'content_version', contentVersionId: input?.contentVersionId, projectId: input?.projectId },
      entityType: 'media_recommendation',
      execute: (database, value) => {
        const drafts = generateMediaRecommendations(database, value);
        const superseded = supersedeProposedRecommendations(database, { contentVersionId: value.contentVersionId, requestId: value.requestId });
        const proposed = proposeMediaRecommendations(database, { contentVersionId: value.contentVersionId, projectId: value.projectId, requestId: value.requestId, drafts });
        const data = { proposed, superseded, draftCount: drafts.length };
        return { data, entityId: value.contentVersionId, afterRevision: proposed.length ? Math.max(...proposed.map((item) => item.revision)) : undefined, readback: readMediaRecommendations(database, { contentVersionId: value.contentVersionId, projectId: value.projectId }) };
      }
    });
    if (receipt.ok) broadcastDataChanged({ scopes: ['studio'], reason: 'media.recommendations_generate' });
    return receiptAsCommandResult(receipt);
  });

  ipcMain.handle(MEDIA_RECOMMENDATIONS_DECIDE_IPC_CHANNEL, async (_event, input: { id: string; expectedRevision: number; decision: 'accept' | 'reject'; confirmedByOwner?: boolean }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'media.recommendations_decide', requestId: freshRequestId(), actor: ownerUiActor, input,
      boundIdentity: { entityType: 'media_recommendation', id: input?.id, expectedRevision: input?.expectedRevision },
      entityType: 'media_recommendation',
      execute: (database, value) => {
        const data = decideMediaRecommendation(database, value);
        return { data, entityId: data.id, beforeRevision: value.expectedRevision, afterRevision: data.revision, readback: data };
      }
    });
    if (receipt.ok) broadcastDataChanged({ scopes: ['studio'], reason: `media.recommendations_decide.${input?.decision}` });
    return receiptAsCommandResult(receipt);
  });
}

export type { MediaRecommendation };
