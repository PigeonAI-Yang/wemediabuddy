// WMB-5245：视频理解运行同步存储原语（设计 §10.3 持久运行与阶段恢复、§10.7 Segment 契约）。
// 只做 DB 读写原语；阶段管线（Probe→字幕/ASR→抽帧→OCR→对齐→摘要）在授权事务内调用。
// 不变量：
// - 同一身份 (source_id, source_revision_key, asset_id, schema_version, attempt) 唯一；
// - completed 行禁止任何 UPDATE（DB 触发器 + store 双保险，VIDEO_RUN_COMPLETED_IMMUTABLE）；
// - 重试创建新 attempt 行，旧行保留审计；前一 attempt 已完成 stage 输出由管线复用（本模块提供读取）。

import type { DatabaseSync } from 'node:sqlite';
import { VIDEO_TRANSCRIPT_SOURCES, type VideoTranscriptSegment, type VideoTranscriptSource } from '../../shared/media-candidates.ts';

export const VIDEO_RUN_STATUSES = ['queued', 'running', 'completed', 'failed'] as const;
export type VideoRunStatus = (typeof VIDEO_RUN_STATUSES)[number];

export const VIDEO_RUN_STAGES = ['probe', 'transcript', 'keyframes', 'ocr', 'align', 'summarize'] as const;
export type VideoRunStage = (typeof VIDEO_RUN_STAGES)[number];

export type VideoRunIdentity = Readonly<{
  sourceId: string;
  sourceRevisionKey: string;
  assetId: string;
  schemaVersion: number;
  attempt: number;
}>;

/** 视频运行记录（迁移 66 DDL 逐列对应）。 */
export type VideoUnderstandingRunRecord = Readonly<{
  id: string;
  sourceId: string;
  sourceRevisionKey: string;
  assetId: string;
  schemaVersion: number;
  attempt: number;
  status: VideoRunStatus;
  stage: VideoRunStage;
  probeJson: string | null;
  transcriptJson: string | null;
  keyframesJson: string | null;
  segmentsJson: string | null;
  model: string | null;
  provider: string | null;
  promptVersion: number | null;
  runtimeManifestHash: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}>;

// ---------------------------------------------------------------------------
// 结构化载荷类型（设计 §10.4/10.5/10.7）
// ---------------------------------------------------------------------------

export type VideoProbeInfo = Readonly<{
  container: string;
  durationMs: number;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  rotation: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean;
  subtitleTracks: ReadonlyArray<{ index: number; language: string | null; forced: boolean; default: boolean }>;
  chapters: ReadonlyArray<{ startMs: number; endMs: number; title: string | null }>;
  runtimeManifestHash: string;
}>;

/** 关键帧记录（derived_keyframe Asset 血缘 transform {timeMs,width,height}；设计 §10.6）。 */
export type VideoKeyframeRecord = Readonly<{
  timeMs: number;
  width: number;
  height: number;
  assetId: string;
  perceptionHash: string | null;
}>;

/** 对齐后 Segment（设计 §10.7 契约；最多 64 段）。 */
export type VideoSegmentRecord = Readonly<{
  index: number;
  startMs: number;
  endMs: number;
  keyframeAssetId: string | null;
  transcript: ReadonlyArray<{
    startMs: number;
    endMs: number;
    text: string;
    source: VideoTranscriptSource;
    confidence?: number;
  }>;
  transcriptSource: VideoTranscriptSource;
  ocrRegions: ReadonlyArray<unknown>;
  summary: string | null;
  quoteRange: { startMs: number; endMs: number } | null;
  confidence: number | null;
  warnings: readonly string[];
}>;

// ---------------------------------------------------------------------------
// 身份与行映射
// ---------------------------------------------------------------------------

export function videoRunIdFor(identity: Pick<VideoRunIdentity, 'sourceRevisionKey' | 'assetId' | 'schemaVersion' | 'attempt'>): string {
  return `vur:${identity.sourceRevisionKey}:${identity.assetId}:${identity.schemaVersion}:${identity.attempt}`;
}

const RUN_COLUMNS = `id, source_id AS sourceId, source_revision_key AS sourceRevisionKey, asset_id AS assetId,
  schema_version AS schemaVersion, attempt, status, stage, probe_json AS probeJson, transcript_json AS transcriptJson,
  keyframes_json AS keyframesJson, segments_json AS segmentsJson, model, provider, prompt_version AS promptVersion,
  runtime_manifest_hash AS runtimeManifestHash, error_code AS errorCode, error_message AS errorMessage,
  created_at AS createdAt, started_at AS startedAt, completed_at AS completedAt`;

function mapRunRow(row: Record<string, unknown>): VideoUnderstandingRunRecord {
  return {
    id: String(row.id),
    sourceId: String(row.sourceId),
    sourceRevisionKey: String(row.sourceRevisionKey),
    assetId: String(row.assetId),
    schemaVersion: Number(row.schemaVersion),
    attempt: Number(row.attempt),
    status: row.status as VideoRunStatus,
    stage: row.stage as VideoRunStage,
    probeJson: (row.probeJson as string | null) ?? null,
    transcriptJson: (row.transcriptJson as string | null) ?? null,
    keyframesJson: (row.keyframesJson as string | null) ?? null,
    segmentsJson: (row.segmentsJson as string | null) ?? null,
    model: (row.model as string | null) ?? null,
    provider: (row.provider as string | null) ?? null,
    promptVersion: (row.promptVersion as number | null) ?? null,
    runtimeManifestHash: (row.runtimeManifestHash as string | null) ?? null,
    errorCode: (row.errorCode as string | null) ?? null,
    errorMessage: (row.errorMessage as string | null) ?? null,
    createdAt: String(row.createdAt),
    startedAt: (row.startedAt as string | null) ?? null,
    completedAt: (row.completedAt as string | null) ?? null
  };
}

function assertMutable(run: VideoUnderstandingRunRecord): void {
  if (run.status === 'completed') throw new Error('VIDEO_RUN_COMPLETED_IMMUTABLE');
}

function requireRun(database: DatabaseSync, runId: string): VideoUnderstandingRunRecord {
  const run = getVideoRun(database, runId);
  if (!run) throw new Error(`视频理解运行不存在: ${runId}`);
  return run;
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

export type CreateVideoRunInput = Pick<
  VideoRunIdentity,
  'sourceId' | 'sourceRevisionKey' | 'assetId' | 'schemaVersion' | 'attempt'
> & { createdAt?: string };

const INSERT_RUN_SQL = `INSERT INTO video_understanding_runs (
  id, source_id, source_revision_key, asset_id, schema_version, attempt, status, stage, created_at
) VALUES (?, ?, ?, ?, ?, ?, 'queued', 'probe', ?)
ON CONFLICT (source_id, source_revision_key, asset_id, schema_version, attempt) DO NOTHING`;

/**
 * 创建 queued 运行行（幂等：同一身份已存在则返回既有行，不重复）。
 * attempt 由管线递增；管线复用前一 attempt 已完成 stage 输出时调用 getLatestVideoRunForIdentity。
 */
export function createVideoRun(database: DatabaseSync, input: CreateVideoRunInput): VideoUnderstandingRunRecord {
  const id = videoRunIdFor(input);
  database
    .prepare(INSERT_RUN_SQL)
    .run(id, input.sourceId, input.sourceRevisionKey, input.assetId, input.schemaVersion, input.attempt, input.createdAt ?? new Date().toISOString());
  return requireRun(database, id);
}

/** queued → running（记录 started_at 与运行时身份）。 */
export function startVideoRun(
  database: DatabaseSync,
  runId: string,
  options: { model?: string | null; provider?: string | null; promptVersion?: number | null; runtimeManifestHash?: string | null; startedAt?: string } = {}
): VideoUnderstandingRunRecord {
  const before = requireRun(database, runId);
  assertMutable(before);
  if (before.status !== 'queued' && before.status !== 'failed') throw new Error(`视频运行状态不允许启动: ${before.status}`);
  database
    .prepare(
      `UPDATE video_understanding_runs SET status = 'running', started_at = COALESCE(started_at, ?),
        model = COALESCE(?, model), provider = COALESCE(?, provider), prompt_version = COALESCE(?, prompt_version),
        runtime_manifest_hash = COALESCE(?, runtime_manifest_hash),
        error_code = NULL, error_message = NULL
       WHERE id = ?`
    )
    .run(options.startedAt ?? new Date().toISOString(), options.model ?? null, options.provider ?? null, options.promptVersion ?? null, options.runtimeManifestHash ?? null, runId);
  return requireRun(database, runId);
}

export type VideoStageCheckpointInput = Readonly<{
  runId: string;
  stage: VideoRunStage;
  probeJson?: string | null;
  transcriptJson?: string | null;
  keyframesJson?: string | null;
  segmentsJson?: string | null;
}>;

/**
 * 提交阶段 checkpoint（每 stage 写入；重试可从失败 stage 继续，允许回写同一 stage）。
 * completed 行拒绝写入。不会把 run 置 completed——由管线在 summarize 完成后显式 complete。
 */
export function checkpointVideoStage(database: DatabaseSync, input: VideoStageCheckpointInput): VideoUnderstandingRunRecord {
  const before = requireRun(database, input.runId);
  assertMutable(before);
  database
    .prepare(
      `UPDATE video_understanding_runs SET stage = ?,
        probe_json = COALESCE(?, probe_json),
        transcript_json = COALESCE(?, transcript_json),
        keyframes_json = COALESCE(?, keyframes_json),
        segments_json = COALESCE(?, segments_json)
       WHERE id = ?`
    )
    .run(input.stage, input.probeJson ?? null, input.transcriptJson ?? null, input.keyframesJson ?? null, input.segmentsJson ?? null, input.runId);
  return requireRun(database, input.runId);
}

/** completed（终态；此后任何 UPDATE 被 DB 触发器与 store 双保险拒绝）。 */
export function completeVideoRun(
  database: DatabaseSync,
  runId: string,
  options: { model?: string | null; provider?: string | null; promptVersion?: number | null; runtimeManifestHash?: string | null; completedAt?: string } = {}
): VideoUnderstandingRunRecord {
  const before = requireRun(database, runId);
  assertMutable(before);
  database
    .prepare(
      `UPDATE video_understanding_runs SET status = 'completed', completed_at = ?,
        model = COALESCE(?, model), provider = COALESCE(?, provider), prompt_version = COALESCE(?, prompt_version),
        runtime_manifest_hash = COALESCE(?, runtime_manifest_hash)
       WHERE id = ?`
    )
    .run(options.completedAt ?? new Date().toISOString(), options.model ?? null, options.provider ?? null, options.promptVersion ?? null, options.runtimeManifestHash ?? null, runId);
  return requireRun(database, runId);
}

/** failed（可新 attempt 重试；旧行保留；failed ≠ completed，不写 completed_at）。 */
export function failVideoRun(
  database: DatabaseSync,
  runId: string,
  input: { stage?: VideoRunStage; errorCode: string; errorMessage?: string | null }
): VideoUnderstandingRunRecord {
  const before = requireRun(database, runId);
  assertMutable(before);
  database
    .prepare(
      `UPDATE video_understanding_runs SET status = 'failed', stage = COALESCE(?, stage),
        error_code = ?, error_message = ?
       WHERE id = ?`
    )
    .run(input.stage ?? null, input.errorCode, input.errorMessage ?? null, runId);
  return requireRun(database, runId);
}

// ---------------------------------------------------------------------------
// 只读模型
// ---------------------------------------------------------------------------

export function getVideoRun(database: DatabaseSync, runId: string): VideoUnderstandingRunRecord | null {
  const row = database.prepare(`SELECT ${RUN_COLUMNS} FROM video_understanding_runs WHERE id = ?`).get(runId);
  return row ? mapRunRow(row as Record<string, unknown>) : null;
}

export function getVideoRunForIdentity(database: DatabaseSync, identity: VideoRunIdentity): VideoUnderstandingRunRecord | null {
  const row = database
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM video_understanding_runs
       WHERE source_id = ? AND source_revision_key = ? AND asset_id = ? AND schema_version = ? AND attempt = ?`
    )
    .get(identity.sourceId, identity.sourceRevisionKey, identity.assetId, identity.schemaVersion, identity.attempt);
  return row ? mapRunRow(row as Record<string, unknown>) : null;
}

/**
 * 身份（不含 attempt）的最新 run：重试时复用前一 attempt 已完成 stage 输出（不重复下载/ASR）。
 * 无行返回 null。
 */
export function getLatestVideoRunForIdentity(
  database: DatabaseSync,
  identity: Omit<VideoRunIdentity, 'attempt'>
): VideoUnderstandingRunRecord | null {
  const row = database
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM video_understanding_runs
       WHERE source_id = ? AND source_revision_key = ? AND asset_id = ? AND schema_version = ?
       ORDER BY attempt DESC LIMIT 1`
    )
    .get(identity.sourceId, identity.sourceRevisionKey, identity.assetId, identity.schemaVersion);
  return row ? mapRunRow(row as Record<string, unknown>) : null;
}

/** 某 Source revision 的全部视频运行（按 created_at DESC；读模型/Studio 媒体区用）。 */
export function listVideoRunsForRevision(database: DatabaseSync, sourceRevisionKeyValue: string): VideoUnderstandingRunRecord[] {
  const rows = database
    .prepare(`SELECT ${RUN_COLUMNS} FROM video_understanding_runs WHERE source_revision_key = ? ORDER BY created_at DESC`)
    .all(sourceRevisionKeyValue) as Array<Record<string, unknown>>;
  return rows.map(mapRunRow);
}

/** 解析结构化载荷；JSON 非法返回 null（fail-closed，不猜测）。 */
/** transcript_json 形状（设计 §10.5）：`{source, segments}`；source ∈ native/asr/ocr/none。 */
export type VideoTranscriptPayload = Readonly<{
  source: VideoTranscriptSource;
  segments: readonly VideoTranscriptSegment[];
}>;

export function parseTranscriptJson(run: Pick<VideoUnderstandingRunRecord, 'transcriptJson'>): VideoTranscriptPayload | null {
  if (!run.transcriptJson) return null;
  try {
    const value = JSON.parse(run.transcriptJson) as VideoTranscriptPayload;
    if (!value || typeof value !== 'object' || !Array.isArray(value.segments)) return null;
    if (!(VIDEO_TRANSCRIPT_SOURCES as readonly string[]).includes(value.source)) return null;
    return value;
  } catch {
    return null;
  }
}

export function parseProbeJson(run: Pick<VideoUnderstandingRunRecord, 'probeJson'>): VideoProbeInfo | null {
  if (!run.probeJson) return null;
  try {
    const value = JSON.parse(run.probeJson) as VideoProbeInfo;
    if (typeof value.durationMs !== 'number' || value.durationMs < 0) return null;
    return value;
  } catch {
    return null;
  }
}

export function parseKeyframesJson(run: Pick<VideoUnderstandingRunRecord, 'keyframesJson'>): VideoKeyframeRecord[] | null {
  if (!run.keyframesJson) return null;
  try {
    const value = JSON.parse(run.keyframesJson) as VideoKeyframeRecord[];
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function parseSegmentsJson(run: Pick<VideoUnderstandingRunRecord, 'segmentsJson'>): VideoSegmentRecord[] | null {
  if (!run.segmentsJson) return null;
  try {
    const value = JSON.parse(run.segmentsJson) as VideoSegmentRecord[];
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** transcript source 白名单（与 shared 常量同源）。 */
export const VIDEO_TRANSCRIPT_SOURCES_WHITELIST: readonly VideoTranscriptSource[] = VIDEO_TRANSCRIPT_SOURCES;
