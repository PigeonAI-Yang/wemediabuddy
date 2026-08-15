// WMB-5207: Studio 正文批注 IPC 注册（Data agent 所有）。
// 复用现有 business-command 派发 + 审计（operation_log）+ dataChanged 广播约定；
// 读走 readWorkspaceDatabase，写走 dispatchBusinessCommand 事务。

import { ipcMain } from 'electron';
import { broadcastDataChanged } from './data-changed.ts';
import { dispatchBusinessCommand, receiptAsCommandResult, requireCommandResultData } from './business-command.ts';
import { freshRequestId, ownerUiActor, readWorkspaceDatabase, requireBusinessRuntime, type BusinessIpcDependencies } from './ipc-business-context.ts';
import {
  createStudioAnnotation,
  listStudioAnnotations,
  reconcileStudioAnnotations,
  reopenStudioAnnotation,
  resolveStudioAnnotation,
  updateStudioAnnotation
} from './studio-annotations.ts';
import type { StudioDocumentScope, StudioReconcileMode, StudioAnnotationResolveReason } from '../shared/studio-annotations.ts';

export function registerStudioAnnotationIpc(dependencies: BusinessIpcDependencies): void {
  ipcMain.handle('studio-annotations:list', (_event, input: StudioDocumentScope & { includeResolved?: boolean }) =>
    readWorkspaceDatabase(dependencies, () => [], database => listStudioAnnotations(database, input)));

  ipcMain.handle('studio-annotations:create', async (_event, input: StudioDocumentScope & { body: string; startOffset: number; endOffset: number; note?: string | null }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'studio_annotations.create', requestId: freshRequestId(), actor: ownerUiActor, input,
      boundIdentity: { entityType: 'studio_annotation', projectId: input?.projectId }, entityType: 'studio_annotation',
      execute: (database, value) => {
        const data = requireCommandResultData(createStudioAnnotation(database, value));
        return { data, entityId: data.id, afterRevision: data.revision, readback: data };
      }
    });
    if (receipt.ok) broadcastDataChanged({ scopes: ['studio'], reason: 'studio_annotations.create' });
    return receiptAsCommandResult(receipt);
  });

  ipcMain.handle('studio-annotations:update', async (_event, input: { id: string; expectedRevision: number; note: string | null }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'studio_annotations.update', requestId: freshRequestId(), actor: ownerUiActor, input,
      boundIdentity: { entityType: 'studio_annotation', entityId: input?.id }, entityType: 'studio_annotation',
      execute: (database, value) => {
        const data = requireCommandResultData(updateStudioAnnotation(database, value));
        return { data, entityId: data.id, beforeRevision: value.expectedRevision, afterRevision: data.revision, readback: data };
      }
    });
    if (receipt.ok) broadcastDataChanged({ scopes: ['studio'], reason: 'studio_annotations.update' });
    return receiptAsCommandResult(receipt);
  });

  ipcMain.handle('studio-annotations:resolve', async (_event, input: { id: string; expectedRevision: number; reason: StudioAnnotationResolveReason }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'studio_annotations.resolve', requestId: freshRequestId(), actor: ownerUiActor, input,
      boundIdentity: { entityType: 'studio_annotation', entityId: input?.id }, entityType: 'studio_annotation',
      execute: (database, value) => {
        const data = requireCommandResultData(resolveStudioAnnotation(database, value));
        return { data, entityId: data.id, beforeRevision: value.expectedRevision, afterRevision: data.revision, readback: data };
      }
    });
    if (receipt.ok) broadcastDataChanged({ scopes: ['studio'], reason: 'studio_annotations.resolve' });
    return receiptAsCommandResult(receipt);
  });

  ipcMain.handle('studio-annotations:reopen', async (_event, input: { id: string; expectedRevision: number; body: string }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'studio_annotations.reopen', requestId: freshRequestId(), actor: ownerUiActor, input,
      boundIdentity: { entityType: 'studio_annotation', entityId: input?.id }, entityType: 'studio_annotation',
      execute: (database, value) => {
        const data = requireCommandResultData(reopenStudioAnnotation(database, value));
        return { data, entityId: data.id, beforeRevision: value.expectedRevision, afterRevision: data.revision, readback: data };
      }
    });
    if (receipt.ok) broadcastDataChanged({ scopes: ['studio'], reason: 'studio_annotations.reopen' });
    return receiptAsCommandResult(receipt);
  });

  ipcMain.handle('studio-annotations:reconcile', async (_event, input: StudioDocumentScope & { previousBody: string; nextBody: string; mode: StudioReconcileMode }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'studio_annotations.reconcile', requestId: freshRequestId(), actor: ownerUiActor, input,
      boundIdentity: { entityType: 'studio_annotation', projectId: input?.projectId, documentKind: input?.documentKind, documentId: input?.documentId ?? null },
      entityType: 'studio_annotation',
      execute: (database, value) => {
        const data = requireCommandResultData(reconcileStudioAnnotations(database, value));
        return { data, readback: data };
      }
    });
    if (receipt.ok) broadcastDataChanged({ scopes: ['studio'], reason: 'studio_annotations.reconcile' });
    return receiptAsCommandResult(receipt);
  });
}
