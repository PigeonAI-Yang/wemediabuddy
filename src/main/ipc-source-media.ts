// WMB-5244: Source 媒体 IPC 接线（UI 读模型投影 + 用户动作命令）。
// - 通道名（renderer 消费同一常量）：src/shared/source-media.ts。
// - 读：source:media-overview → MediaSchema store（listMediaCandidatesForRevision /
//   listSourceMediaBindings）+ assets 查询 + 本模块纯投影。
// - 写：source:media-retry / source:media-archive-pause → 业务命令
//   media_archive.retry_candidate / media_archive.set_paused（ArchiveWorker 领域实现，
//   CommandReceipt/dataChanged/grant 既有约定）。
// - 查看原件：source:media-open-original → 解析本地绑定 Asset 绝对路径并以系统默认程序打开
//   （只读，不写库；远程 URL 永不作为「原件」打开）。
// 依赖：src/main/media-archive-worker.ts（ArchiveWorker 本批次落地）。

import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ipcMain, shell } from 'electron';
import {
  SOURCE_MEDIA_OVERVIEW_IPC_CHANNEL,
  SOURCE_MEDIA_RETRY_IPC_CHANNEL,
  SOURCE_MEDIA_ARCHIVE_PAUSE_IPC_CHANNEL,
  SOURCE_MEDIA_OPEN_ORIGINAL_IPC_CHANNEL,
  type SourceMediaArchivePauseInput,
  type SourceMediaOpenOriginalInput,
  type SourceMediaOverview,
  type SourceMediaOverviewInput,
  type SourceMediaRetryInput
} from '../shared/source-media.ts';
import { sourceRevisionKey } from '../shared/media-candidates.ts';
import { composeSourceMediaOverview } from './source-media.ts';
import {
  listMediaCandidatesForRevision,
  listSourceMediaBindings
} from './db/media-archive-store.ts';
import {
  isMediaArchivePaused,
  MEDIA_ARCHIVE_RETRY_COMMAND,
  MEDIA_ARCHIVE_SET_PAUSED_COMMAND,
  retryMediaArchiveCandidate,
  setMediaArchivePaused
} from './media-archive-worker.ts';
import { dispatchBusinessCommand, requireReceiptData } from './business-command.ts';
import { broadcastDataChanged } from './data-changed.ts';
import {
  freshRequestId,
  ownerUiActor,
  readWorkspaceDatabase,
  requireBusinessRuntime,
  type BusinessIpcDependencies
} from './ipc-business-context.ts';

function readOverview(database: DatabaseSync, sourceId: string): SourceMediaOverview {
  const sourceRow = database.prepare('SELECT revision FROM source_items WHERE id = ?').get(sourceId) as
    | { revision: number }
    | undefined;
  const revision = sourceRow ? Number(sourceRow.revision) : 0;
  const revisionKey = sourceRevisionKey(sourceId, revision);
  const empty = (): SourceMediaOverview =>
    Object.freeze({
      sourceId,
      revision,
      revisionKey,
      counts: { total: 0, preserved: 0, processing: 0, failed: 0, needsUser: 0, skippedLimit: 0, unsupported: 0 },
      items: [],
      globalPaused: isMediaArchivePaused(database)
    });
  if (!sourceRow) return empty();
  try {
    const candidates = listMediaCandidatesForRevision(database, revisionKey);
    const bindings = listSourceMediaBindings(database, revisionKey);
    const assetIds = [...new Set(bindings.filter((binding) => binding.archivedAt == null).map((binding) => binding.assetId))];
    const assetsById = new Map<string, { id: string; mimeType: string; byteCount: number; width: number | null; height: number | null; durationMs: number | null }>();
    if (assetIds.length) {
      const placeholders = assetIds.map(() => '?').join(',');
      const rows = database.prepare(
        `SELECT id, mime_type AS mimeType, byte_count AS byteCount, width, height, duration_ms AS durationMs
         FROM assets WHERE id IN (${placeholders})`
      ).all(...assetIds) as Array<{ id: string; mimeType: string; byteCount: number; width: number | null; height: number | null; durationMs: number | null }>;
      for (const row of rows) {
        assetsById.set(String(row.id), {
          id: String(row.id),
          mimeType: String(row.mimeType),
          byteCount: Number(row.byteCount ?? 0),
          width: row.width == null ? null : Number(row.width),
          height: row.height == null ? null : Number(row.height),
          durationMs: row.durationMs == null ? null : Number(row.durationMs)
        });
      }
    }
    return composeSourceMediaOverview({
      sourceId,
      revision,
      revisionKey,
      candidates,
      bindings,
      assetsById,
      globalPaused: isMediaArchivePaused(database)
    });
  } catch (error) {
    // 媒体表尚未迁移（精简 fixture / 旧库）：该 Source 无媒体候选是真实状态，降级为空聚合，不伪造。
    if (error instanceof Error && /no such table/i.test(error.message)) return empty();
    throw error;
  }
}

export function registerSourceMediaIpc(dependencies: BusinessIpcDependencies): void {
  ipcMain.handle(SOURCE_MEDIA_OVERVIEW_IPC_CHANNEL, (_event, rawInput: SourceMediaOverviewInput) =>
    readWorkspaceDatabase(dependencies, () => {
      const sourceId = String(rawInput?.sourceId ?? '');
      return Object.freeze({
        sourceId,
        revision: 0,
        revisionKey: '',
        counts: { total: 0, preserved: 0, processing: 0, failed: 0, needsUser: 0, skippedLimit: 0, unsupported: 0 },
        items: [],
        globalPaused: false
      }) as SourceMediaOverview;
    }, (database) => readOverview(database, String(rawInput?.sourceId ?? ''))));

  ipcMain.handle(SOURCE_MEDIA_RETRY_IPC_CHANNEL, async (_event, rawInput: SourceMediaRetryInput) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const candidateId = String(rawInput?.candidateId ?? '').trim();
    if (!candidateId) throw new Error('缺少媒体候选。');
    const receipt = await dispatchBusinessCommand(runtime, {
      command: MEDIA_ARCHIVE_RETRY_COMMAND,
      requestId: freshRequestId(),
      actor: ownerUiActor,
      input: { candidateId },
      boundIdentity: { entityType: 'source_media_candidate', entityId: candidateId },
      entityType: 'source_media_candidate',
      execute: (database, value) => {
        const data = retryMediaArchiveCandidate(database, value.candidateId);
        if (!data.ok) throw Object.assign(new Error(data.message), { code: data.code });
        return { data, entityId: value.candidateId, readback: data };
      }
    });
    const data = requireReceiptData(receipt);
    broadcastDataChanged({ scopes: ['sources', 'media'], reason: 'source.media.retry' });
    return data;
  });

  ipcMain.handle(SOURCE_MEDIA_ARCHIVE_PAUSE_IPC_CHANNEL, async (_event, rawInput: SourceMediaArchivePauseInput) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const paused = Boolean(rawInput?.paused);
    const receipt = await dispatchBusinessCommand(runtime, {
      command: MEDIA_ARCHIVE_SET_PAUSED_COMMAND,
      requestId: freshRequestId(),
      actor: ownerUiActor,
      input: { paused },
      boundIdentity: { entityType: 'media_archive_worker' },
      entityType: 'media_archive_worker',
      execute: (database, value) => {
        setMediaArchivePaused(database, value.paused);
        const data = { paused: value.paused };
        return { data, readback: data };
      }
    });
    const data = requireReceiptData(receipt);
    broadcastDataChanged({ scopes: ['sources', 'media'], reason: 'source.media.pause' });
    return data;
  });

  ipcMain.handle(SOURCE_MEDIA_OPEN_ORIGINAL_IPC_CHANNEL, async (_event, rawInput: SourceMediaOpenOriginalInput) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const candidateId = String(rawInput?.candidateId ?? '').trim();
    if (!candidateId) throw new Error('缺少媒体候选。');
    const row = runtime.database.prepare(
      `SELECT a.relative_path AS relativePath FROM source_media_bindings b
       JOIN assets a ON a.id = b.asset_id
       WHERE b.candidate_id = ? AND b.archived_at IS NULL`
    ).get(candidateId) as { relativePath: string } | undefined;
    if (!row) throw new Error('该媒体尚未保存到本地，无法查看原件。');
    const openError = await shell.openPath(path.join(runtime.identity.rootPath, row.relativePath));
    if (openError) throw new Error(openError);
    return { ok: true };
  });
}
