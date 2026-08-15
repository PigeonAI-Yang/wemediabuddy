import { broadcastDataChanged } from './data-changed.ts';
import { createCommandEnvelope, type CommandActorV1, type CommandReceiptV1 } from './command-dispatcher.ts';
import { scheduleSourceKnowledgeCompile } from './knowledge-compile-trigger.ts';
import { applyLaneGateBatch, restoreFilteredSource, type LaneGateBatchResult, type LaneJudgmentRecord, type LaneReasonCode, type LaneRestoreResult } from './lane-gate.ts';
import { getSource, upsertSource, type SourceInput, type SourceRecord } from './sources.ts';
import {
  deriveCandidateChannel,
  persistSourceMediaCandidates,
  scheduleSourceMediaDiscovery,
  validateMediaCandidates,
  type SaveSourceMediaCandidate
} from './source-media-candidates.ts';
import { sourceRevisionKey } from '../shared/media-candidates.ts';
import { scheduleSourceBodyArchive } from './source-body-archive.ts';
import type { SourceBodyCandidate } from '../shared/source-body-archive.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';

export const SOURCE_UPSERT_BATCH_COMMAND = 'sources.upsert_batch';
export const SOURCE_LANE_GATE_COMMAND = 'sources.lane_gate';
export const SOURCE_LANE_RESTORE_COMMAND = 'sources.lane_restore';

/** WMB-5244：单条 Source 保存的媒体结果摘要（同一保存事务内落库的候选/Job 计数）。 */
export type SourceMediaSaveResult = Readonly<{
  sourceRevisionKey: string;
  candidateCount: number;
  archiveJobCount: number;
  discoveryScheduled: boolean;
}>;

export type SourceUpsertBatchResult = Readonly<{
  items: ReadonlyArray<Readonly<{ id: string; created: boolean; revision: number; media?: SourceMediaSaveResult | null }>>;
  sources: ReadonlyArray<SourceRecord>;
}>;

export type SourceUpsertItemInput = SourceInput & { mediaCandidates?: SaveSourceMediaCandidate[]; bodyCandidate?: SourceBodyCandidate };

export function dispatchSourceUpsertBatch(
  runtime: ActiveWorkspaceRuntime,
  input: {
    requestId: string;
    actor: CommandActorV1;
    items: SourceUpsertItemInput[];
    taskId?: string;
    workerLeaseId?: string;
    grantId?: string;
    causation?: Readonly<Record<string, unknown>>;
  }
): Promise<CommandReceiptV1<SourceUpsertBatchResult>> {
  const envelope = createCommandEnvelope({
    workspaceId: runtime.identity.workspaceId,
    runtimeEpoch: runtime.identity.runtimeEpoch,
    command: SOURCE_UPSERT_BATCH_COMMAND,
    requestId: input.requestId,
    input: { items: input.items },
    boundIdentity: { entityType: 'source_item' },
    actor: input.actor,
    taskId: input.taskId,
    workerLeaseId: input.workerLeaseId,
    grantId: input.grantId,
    causation: input.causation
  });
  return runtime.dispatchCommand(envelope, () => {
    // WMB-5244 §7.4：先整体校验媒体候选（fail before writes）——任一候选非法，整批零写回滚。
    const validated = envelope.input.items.map((item) => ({
      item,
      candidates: validateMediaCandidates(item.mediaCandidates)
    }));
    const saved = validated.map(({ item, candidates }) => {
      const source = upsertSource(runtime.database, item, false);
      const revisionKey = sourceRevisionKey(source.id, source.revision);
      // WMB-5269：同一保存事务内登记正文归档任务（结构化完整文本立即固化；URL-only 排队异步抓取）。
      // 正文失败不回滚 Source 保存（任务登记与 Source 同事务；抓取在网络侧异步执行）。
      scheduleSourceBodyArchive(runtime.database, {
        sourceId: source.id,
        sourceRevision: source.revision,
        url: item.originalUrl ?? null,
        structuredText: item.bodyCandidate?.text ?? null,
        contentType: item.bodyCandidate?.contentType ?? null,
        origin: item.bodyCandidate?.origin ?? null,
        channel: deriveCandidateChannel(runtime.database, item)
      });
      let media: SourceMediaSaveResult | null = null;
      if (candidates.length > 0) {
        // 结构化候选：候选行 + 首个 Attempt + media_archive Job 与 Source 同事务落库（提交后异步归档）。
        const persisted = persistSourceMediaCandidates(runtime.database, {
          sourceId: source.id,
          sourceRevisionKey: revisionKey,
          channel: deriveCandidateChannel(runtime.database, item),
          candidates,
          requestId: envelope.requestId
        });
        media = {
          sourceRevisionKey: revisionKey,
          candidateCount: persisted.candidateIds.length,
          archiveJobCount: persisted.inserted.length,
          discoveryScheduled: false
        };
      } else if (item.originalUrl) {
        // 无结构化候选：调度有界重发现（重抓固定原 URL；按 source revision 幂等，抓取失败不影响已保存 Source）。
        const discovery = scheduleSourceMediaDiscovery(runtime.database, {
          sourceId: source.id,
          sourceRevisionKey: revisionKey,
          originalUrl: item.originalUrl
        });
        media = {
          sourceRevisionKey: revisionKey,
          candidateCount: 0,
          archiveJobCount: 0,
          discoveryScheduled: discovery.scheduled
        };
      }
      return media ? { ...source, media } : source;
    });
    const sources = saved.map((item) => getSource(runtime.database, item.id)).filter((item): item is SourceRecord => item !== null);
    return {
      data: { items: saved, sources },
      entityType: 'source_item',
      entityId: saved.length === 1 ? saved[0].id : undefined,
      beforeRevision: saved.length === 1 ? envelope.input.items[0].expectedRevision : undefined,
      afterRevision: saved.length === 1 ? saved[0].revision : undefined,
      readback: sources
    };
  }).then((receipt) => {
    if (receipt.ok) {
      broadcastDataChanged({ scopes: ['sources', 'library', 'today'], reason: 'source.upsert' });
      // WMB-5229：保存事务已提交 → 异步有界编译（不阻断/不回滚保存；同 revision 并发去重）。
      for (const item of receipt.data?.items ?? []) {
        scheduleSourceKnowledgeCompile({ sourceId: item.id, revision: item.revision });
      }
    }
    return receipt;
  });
}

export type LaneGateJudgmentInput = Readonly<{
  sourceId: string;
  decision: 'relevant' | 'irrelevant';
  reasonCode: LaneReasonCode;
  reason?: string;
  expectedRevision: number;
  confidence?: number;
}>;

export type LaneGateResult = Readonly<{
  written: ReadonlyArray<Readonly<{ sourceId: string; judgmentId: string; decision: 'relevant' | 'irrelevant' }>>;
  archived: ReadonlyArray<Readonly<{ sourceId: string; revision: number }>>;
  skipped: ReadonlyArray<Readonly<{ sourceId: string; reason: string }>>;
  judgments: ReadonlyArray<LaneJudgmentRecord>;
}>;

export function dispatchLaneGate(
  runtime: ActiveWorkspaceRuntime,
  input: {
    requestId: string;
    actor: CommandActorV1;
    workspaceLane: string;
    judgedBy: 'system' | 'agent';
    judgedAt?: string;
    judgments: LaneGateJudgmentInput[];
    taskId?: string;
    workerLeaseId?: string;
    grantId?: string;
    causation?: Readonly<Record<string, unknown>>;
  }
): Promise<CommandReceiptV1<LaneGateResult>> {
  const envelope = createCommandEnvelope({
    workspaceId: runtime.identity.workspaceId,
    runtimeEpoch: runtime.identity.runtimeEpoch,
    command: SOURCE_LANE_GATE_COMMAND,
    requestId: input.requestId,
    input: {
      workspaceLane: input.workspaceLane,
      judgedBy: input.judgedBy,
      judgedAt: input.judgedAt ?? null,
      judgments: input.judgments
    },
    boundIdentity: { entityType: 'lane_judgment', workspaceLane: input.workspaceLane },
    actor: input.actor,
    taskId: input.taskId,
    workerLeaseId: input.workerLeaseId,
    grantId: input.grantId,
    causation: input.causation
  });
  return runtime.dispatchCommand(envelope, () => {
    // 归档 + 判定行同一事务（dispatcher BEGIN IMMEDIATE 包裹 execute）；任一判定失败整批零写回滚。
    const result = applyLaneGateBatch(runtime.database, {
      workspaceLane: envelope.input.workspaceLane,
      judgedBy: envelope.input.judgedBy,
      judgedAt: envelope.input.judgedAt ?? undefined,
      judgments: envelope.input.judgments
    }, { transaction: false });
    return {
      data: result,
      entityType: 'lane_judgment',
      entityId: result.written.length === 1 ? result.written[0].judgmentId : undefined
    };
  });
}

export function dispatchLaneRestore(
  runtime: ActiveWorkspaceRuntime,
  input: {
    requestId: string;
    actor: CommandActorV1;
    sourceId: string;
    workspaceLane: string;
    expectedRevision: number;
    reason?: string;
    judgedAt?: string;
    taskId?: string;
    workerLeaseId?: string;
    grantId?: string;
    causation?: Readonly<Record<string, unknown>>;
  }
): Promise<CommandReceiptV1<LaneRestoreResult>> {
  const envelope = createCommandEnvelope({
    workspaceId: runtime.identity.workspaceId,
    runtimeEpoch: runtime.identity.runtimeEpoch,
    command: SOURCE_LANE_RESTORE_COMMAND,
    requestId: input.requestId,
    input: {
      sourceId: input.sourceId,
      workspaceLane: input.workspaceLane,
      expectedRevision: input.expectedRevision,
      reason: input.reason ?? null,
      judgedAt: input.judgedAt ?? null
    },
    boundIdentity: { entityType: 'source_item', sourceId: input.sourceId, expectedRevision: input.expectedRevision },
    actor: input.actor,
    taskId: input.taskId,
    workerLeaseId: input.workerLeaseId,
    grantId: input.grantId,
    causation: input.causation
  });
  return runtime.dispatchCommand(envelope, () => {
    const result = restoreFilteredSource(runtime.database, {
      sourceId: envelope.input.sourceId,
      workspaceLane: envelope.input.workspaceLane,
      expectedRevision: envelope.input.expectedRevision,
      reason: envelope.input.reason ?? undefined,
      judgedAt: envelope.input.judgedAt ?? undefined
    });
    return {
      data: result,
      entityType: 'source_item',
      entityId: result.source.id,
      beforeRevision: envelope.input.expectedRevision,
      afterRevision: result.source.revision,
      readback: result.source
    };
  }).then((receipt) => {
    if (receipt.ok && receipt.data?.restored) {
      broadcastDataChanged({ scopes: ['sources', 'library', 'today'], reason: 'source.lane_restore' });
    }
    return receipt;
  });
}
