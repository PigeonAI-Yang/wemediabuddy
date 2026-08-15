// WMB-5246：非破坏派生（标注 / ≤60s 视频片段）服务与血缘（Data agent 所有）。
// 契约：
// - 原 Asset 字节永不修改/覆盖；派生 Asset 走现有 sha256 内容寻址（stageAssetBytes +
//   registerStagedAsset），相同派生字节自动复用（reused=true），asset_provenance
//   的 UNIQUE(kind, source_asset_id, derived_asset_id) 保证血缘行幂等不重复。
// - 视频 Clip：优先无损容器 copy（stream copy）；copy 在关键帧边界不准确（偏差 >
//   CLIP_COPY_DEVIATION_TOLERANCE_MS）、输出超 60 秒或无视频轨时，回退固定参数
//   H.264/AAC 转码（libx264 crf23 veryfast / aac 128k，单线程 + bitexact，确定性字节）。
//   两种模式都写 derived_clip 血缘（transform {startMs,endMs,codec,copyOrTranscode}），
//   转码额外写 derived_transcode 血缘（transform {codec,bitrate,container}），
//   并记录运行时身份（runtime_name/runtime_version）。
// - 所有校验（来源存在、mime、时间范围 0<=start<end<=durationMs、<=60s）在任何
//   Asset/血缘/文件写入之前完成：非法输入零写入。
// - 文件工作（ffmpeg/ffprobe、staging）与 DB 写分离：IPC 路径在命令事务外执行文件
//   工作，DB 写在 dispatch 事务内（commitClipDerivation）；服务路径（materializeClipAsset/
//   materializeAnnotationAsset）自动管理事务，支持嵌套（调用方已有事务时不重复 BEGIN）。
// - 运行时缺失抛 MEDIA_RUNTIME_MISSING（media-runtime.ts），绝不回退 PATH。

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getAsset, registerStagedAsset, stageAssetBytes, type StagedAsset } from './assets.ts';
import {
  createMediaExecutor, mediaRuntimeVersion, resolveMediaRuntime, type MediaExecutor, type MediaRuntimeInfo
} from './media-runtime.ts';

// ---------------------------------------------------------------------------
// 常量与纯校验（无副作用）
// ---------------------------------------------------------------------------

/** 用户物化 Clip 的最长时长（毫秒，设计 §8：最长 60 秒）。 */
export const CLIP_MAX_MS = 60_000;
/** 无损 copy 允许的起始时间偏差（毫秒）：超过则视为关键帧边界不准确，回退转码。 */
export const CLIP_COPY_DEVIATION_TOLERANCE_MS = 1_000;
/** 转码回退固定参数（设计 §10.9：固定 H.264/AAC 参数）。 */
export const CLIP_TRANSCODE_CODEC = 'h264';
export const CLIP_TRANSCODE_AUDIO = 'aac';
export const CLIP_TRANSCODE_BITRATE = '128k';
export const CLIP_TRANSCODE_CONTAINER = 'mp4';

export type CopyOrTranscode = 'copy' | 'transcode';

/** 标注规格：renderer 导出标注 PNG 时携带的变换身份（transform_json 形状与之一致）。 */
export type AnnotationSpec = {
  annotationType: string;
  elements: readonly unknown[];
  width: number;
  height: number;
};

/** 正整数窄化（Number.isInteger 自身不窄化 unknown；显式 typeof + isInteger + >0 后参与比较）。 */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function isAnnotationSpecValid(spec: unknown): spec is AnnotationSpec {
  if (!spec || typeof spec !== 'object') return false;
  const { annotationType, elements, width, height } = spec as Record<string, unknown>;
  if (typeof annotationType !== 'string' || !annotationType.trim()) return false;
  if (!Array.isArray(elements)) return false;
  if (!isPositiveInteger(width) || !isPositiveInteger(height)) return false;
  return true;
}

/** 校验 Clip 时间范围；返回错误消息或 null（合法）。durationMs 为 null 表示未知（调用方先探测）。 */
export function validateClipRange(startMs: number, endMs: number, durationMs: number | null): string | null {
  if (!Number.isInteger(startMs) || !Number.isInteger(endMs)) return 'clip 时间范围必须是整数毫秒。';
  if (startMs < 0) return 'clip 起始时间不能为负。';
  if (endMs <= startMs) return 'clip 结束时间必须大于起始时间。';
  if (endMs - startMs > CLIP_MAX_MS) return `clip 时长不能超过 ${CLIP_MAX_MS / 1000} 秒。`;
  if (durationMs !== null && endMs > durationMs) return 'clip 结束时间超出原视频时长。';
  return null;
}

// ---------------------------------------------------------------------------
// ffmpeg/ffprobe 命令与解析（纯函数，测试可逐参断言）
// ---------------------------------------------------------------------------

export type ClipCommandInput = { sourcePath: string; startMs: number; durationMs: number; outputPath: string };

/** 无损容器 copy 命令：输入前 seek（关键帧边界），bitexact + 剥离容器元数据保证确定性字节。 */
export function buildClipCopyArgs(input: ClipCommandInput): string[] {
  return [
    '-hide_banner', '-nostdin', '-y',
    '-fflags', '+bitexact', '-flags', '+bitexact', '-map_metadata', '-1',
    '-ss', `${input.startMs / 1000}`,
    '-i', input.sourcePath,
    '-t', `${input.durationMs / 1000}`,
    '-map', '0:v:0', '-map', '0:a?',
    '-c', 'copy',
    '-avoid_negative_ts', 'make_zero',
    '-movflags', '+faststart',
    input.outputPath
  ];
}

/** 固定 H.264/AAC 转码命令：输入后 seek（帧精确），单线程 + bitexact 保证确定性字节。 */
export function buildClipTranscodeArgs(input: ClipCommandInput): string[] {
  return [
    '-hide_banner', '-nostdin', '-y',
    '-fflags', '+bitexact', '-flags', '+bitexact', '-map_metadata', '-1',
    '-i', input.sourcePath,
    '-ss', `${input.startMs / 1000}`,
    '-t', `${input.durationMs / 1000}`,
    '-map', '0:v:0', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', CLIP_TRANSCODE_AUDIO, '-b:a', CLIP_TRANSCODE_BITRATE, '-ac', '2', '-ar', '44100',
    '-threads', '1',
    '-movflags', '+faststart',
    input.outputPath
  ];
}

/** 媒体探测命令（时长 + 起始时间 + 视频轨信息，统一毫秒口径）。 */
export function buildProbeArgs(inputPath: string): string[] {
  return [
    '-v', 'error',
    '-show_entries', 'format=duration,start_time:stream=index,codec_type,codec_name,start_time',
    '-of', 'json',
    inputPath
  ];
}

export type ProbeResult = {
  durationMs: number | null;
  startMs: number | null;
  videoStreams: ReadonlyArray<{ codecName: string }>;
};

/** 解析 ffprobe JSON；缺字段/非法 JSON 均返回 null 字段（fail-closed，不抛）。 */
export function parseProbeJson(stdout: string): ProbeResult {
  let parsed: { format?: { duration?: unknown; start_time?: unknown }; streams?: unknown };
  try {
    parsed = JSON.parse(stdout) as ProbeResultJson;
  } catch {
    return { durationMs: null, startMs: null, videoStreams: [] };
  }
  const format = parsed?.format;
  const durationMs = format && typeof format.duration === 'string' && Number.isFinite(Number(format.duration))
    ? Math.round(Number(format.duration) * 1000)
    : null;
  const startMs = format && format.start_time !== undefined && format.start_time !== null && format.start_time !== ''
    ? Math.round(Number(String(format.start_time)) * 1000)
    : null;
  const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
  const videoStreams = streams
    .filter((stream) => stream && typeof stream === 'object' && (stream as { codec_type?: unknown }).codec_type === 'video')
    .map((stream) => ({ codecName: String((stream as { codec_name?: unknown }).codec_name ?? 'unknown') }));
  return { durationMs, startMs, videoStreams };
}

type ProbeResultJson = {
  format?: { duration?: unknown; start_time?: unknown };
  streams?: unknown;
};

/** 探测媒体时长（毫秒）；失败或不可解析返回 null。 */
export async function probeMediaDurationMs(executor: MediaExecutor, mediaPath: string): Promise<number | null> {
  const result = await executor.ffprobe(buildProbeArgs(mediaPath));
  if (result.code !== 0) return null;
  return parseProbeJson(result.stdout).durationMs;
}

// ---------------------------------------------------------------------------
// 血缘写入（幂等；必须在调用方事务内执行）
// ---------------------------------------------------------------------------

export type DerivedProvenanceKind = 'derived_annotation' | 'derived_keyframe' | 'derived_clip' | 'derived_transcode';

/** 幂等写入派生血缘行：UNIQUE(kind, source_asset_id, derived_asset_id) 已存在则跳过。 */
export function insertDerivedProvenance(
  database: DatabaseSync,
  input: {
    kind: DerivedProvenanceKind;
    sourceAssetId: string;
    derivedAssetId: string;
    transformJson: Record<string, unknown>;
    origin: string;
    requestId?: string | null;
    runtimeName?: string | null;
    runtimeVersion?: string | null;
  }
): void {
  const existing = database.prepare(`SELECT id FROM asset_provenance
    WHERE kind = ? AND source_asset_id = ? AND derived_asset_id = ?`)
    .get(input.kind, input.sourceAssetId, input.derivedAssetId);
  if (existing) return;
  database.prepare(`INSERT INTO asset_provenance
    (id, asset_id, kind, origin, source_asset_id, derived_asset_id, transform_json, request_id, runtime_name, runtime_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      randomUUID(),
      input.derivedAssetId,
      input.kind,
      input.origin,
      input.sourceAssetId,
      input.derivedAssetId,
      JSON.stringify(input.transformJson),
      input.requestId ?? null,
      input.runtimeName ?? null,
      input.runtimeVersion ?? null,
      new Date().toISOString()
    );
}

// ---------------------------------------------------------------------------
// Clip 派生：文件工作（staging）与 DB 提交分离
// ---------------------------------------------------------------------------

export type PreparedClip = {
  bytes: Buffer;
  mode: CopyOrTranscode;
  codec: string;
  durationMs: number;
};

/** 已 staging 的 Clip 派生：DB 写在调用方事务内（registerStagedAsset + commitClipDerivation）。 */
export type StagedClip = {
  staged: StagedAsset;
  codec: string;
  copyOrTranscode: CopyOrTranscode;
  durationMs: number;
  runtimeName: string | null;
  runtimeVersion: string | null;
};

function trimStderr(stderr: string): string {
  return stderr.trim().split('\n').filter(Boolean).slice(-3).join(' ');
}

/**
 * 物化 Clip 字节（纯文件工作，无 DB 写）：
 * 1) stream copy 到 staging；
 * 2) ffprobe 校验输出起始偏差 <= 1s、时长 <= 60s、含视频轨；不满足则删除 staging；
 * 3) 回退固定 H.264/AAC 转码（帧精确）。
 * staging 文件无论成败最终清理。
 */
export async function prepareClipDerivation(dataRoot: string, input: {
  sourcePath: string;
  startMs: number;
  endMs: number;
  executor: MediaExecutor;
}): Promise<PreparedClip> {
  const durationMs = input.endMs - input.startMs;
  const stagingDir = path.join(dataRoot, 'staging');
  const outputPath = path.join(stagingDir, `${randomUUID()}.mp4`);
  await mkdir(stagingDir, { recursive: true });
  try {
    const copy = await input.executor.ffmpeg(buildClipCopyArgs({ sourcePath: input.sourcePath, startMs: input.startMs, durationMs, outputPath }));
    if (copy.code === 0) {
      const probe = parseProbeJson((await input.executor.ffprobe(buildProbeArgs(outputPath))).stdout);
      const deviation = probe.startMs === null ? Number.POSITIVE_INFINITY : Math.abs(probe.startMs - input.startMs);
      const exceedsLimit = probe.durationMs !== null && probe.durationMs > CLIP_MAX_MS;
      if (deviation <= CLIP_COPY_DEVIATION_TOLERANCE_MS && !exceedsLimit && probe.videoStreams.length > 0) {
        return { bytes: await readFile(outputPath), mode: 'copy', codec: 'copy', durationMs };
      }
      await rm(outputPath, { force: true });
    }
    const transcode = await input.executor.ffmpeg(buildClipTranscodeArgs({ sourcePath: input.sourcePath, startMs: input.startMs, durationMs, outputPath }));
    if (transcode.code !== 0) {
      throw new Error(`ffmpeg 物化 clip 失败（copy 与转码均失败）。${trimStderr(transcode.stderr)}`);
    }
    return { bytes: await readFile(outputPath), mode: 'transcode', codec: CLIP_TRANSCODE_CODEC, durationMs };
  } finally {
    await rm(outputPath, { force: true });
  }
}

/**
 * 预事务 staging：校验（源为视频、时间范围合法）+ 运行时解析 + ffmpeg 物化 + 字节入 staging。
 * 无任何 DB 写；返回的 staged 供调用方在同一版本事务内 registerStagedAsset + commitClipDerivation。
 * 校验失败 / 运行时缺失在任何文件写入之前抛出（MEDIA_RUNTIME_MISSING 见 media-runtime.ts）。
 */
export async function stageClipAsset(
  database: DatabaseSync,
  dataRoot: string,
  input: { sourceAssetId: string; startMs: number; endMs: number; origin: string },
  options: { executor?: MediaExecutor; runtime?: MediaRuntimeInfo } = {}
): Promise<StagedClip> {
  const source = getAsset(database, input.sourceAssetId);
  if (!source) throw new Error(`源素材不存在: ${input.sourceAssetId}。`);
  if (!source.mimeType.startsWith('video/')) throw new Error(`源素材不是视频（mime ${source.mimeType}）。`);
  const runtime = options.runtime ?? await resolveMediaRuntime();
  const executor = options.executor ?? createMediaExecutor(runtime);
  const sourcePath = path.join(dataRoot, ...source.relativePath.split('/'));
  let durationMs = source.durationMs;
  if (durationMs == null) {
    durationMs = await probeMediaDurationMs(executor, sourcePath);
    if (durationMs == null) throw new Error('无法读取原视频时长（ffprobe 无结果）。');
  }
  const validationError = validateClipRange(input.startMs, input.endMs, durationMs);
  if (validationError) throw Object.assign(new Error(validationError), { code: 'CLIP_RANGE_INVALID' });
  const prepared = await prepareClipDerivation(dataRoot, {
    sourcePath,
    startMs: input.startMs,
    endMs: input.endMs,
    executor
  });
  const staged = await stageAssetBytes(dataRoot, {
    bytes: prepared.bytes,
    fileName: 'clip.mp4',
    mimeType: 'video/mp4',
    origin: input.origin,
    durationMs: prepared.durationMs
  });
  return {
    staged,
    codec: prepared.codec,
    copyOrTranscode: prepared.mode,
    durationMs: prepared.durationMs,
    runtimeName: runtime.manifest ? 'media-runtime' : null,
    runtimeVersion: mediaRuntimeVersion(runtime.manifest) ?? null
  };
}

export type ClipDerivationMeta = {
  sourceAssetId: string;
  startMs: number;
  endMs: number;
  origin: string;
  requestId?: string | null;
  mode: CopyOrTranscode;
  codec: string;
  runtimeName?: string | null;
  runtimeVersion?: string | null;
};

export type ClipDerivationResult = {
  assetId: string;
  reused: boolean;
  sha256: string;
  durationMs: number;
  codec: string;
  copyOrTranscode: CopyOrTranscode;
};

/**
 * 提交 Clip 派生（DB 写，必须在调用方事务内）：注册派生 Asset + derived_clip 血缘；
 * 转码模式追加 derived_transcode 血缘。同字节复用（reused=true）时血缘行不重复。
 */
export function commitClipDerivation(database: DatabaseSync, staged: StagedAsset, meta: ClipDerivationMeta): ClipDerivationResult {
  const registered = registerStagedAsset(database, staged);
  // 空变换守卫：派生字节与源素材字节相同时（如 copy 模式覆盖全片且容器重写字节不变），
  // 内容寻址命中源 Asset 自身；此时写血缘会形成 derived_asset_id == source_asset_id 自环，
  // 必须跳过（与 materializeAnnotationAsset 一致）。
  if (registered.id !== meta.sourceAssetId) {
    insertDerivedProvenance(database, {
      kind: 'derived_clip',
      sourceAssetId: meta.sourceAssetId,
      derivedAssetId: registered.id,
      transformJson: {
        startMs: meta.startMs,
        endMs: meta.endMs,
        codec: meta.codec,
        copyOrTranscode: meta.mode
      },
      origin: meta.origin,
      requestId: meta.requestId ?? null,
      runtimeName: meta.runtimeName ?? null,
      runtimeVersion: meta.runtimeVersion ?? null
    });
    if (meta.mode === 'transcode') {
      insertDerivedProvenance(database, {
        kind: 'derived_transcode',
        sourceAssetId: meta.sourceAssetId,
        derivedAssetId: registered.id,
        transformJson: {
          codec: CLIP_TRANSCODE_CODEC,
          bitrate: CLIP_TRANSCODE_BITRATE,
          container: CLIP_TRANSCODE_CONTAINER
        },
        origin: meta.origin,
        requestId: meta.requestId ?? null,
        runtimeName: meta.runtimeName ?? null,
        runtimeVersion: meta.runtimeVersion ?? null
      });
    }
  }
  return {
    assetId: registered.id,
    reused: registered.reused,
    sha256: staged.sha256,
    durationMs: meta.endMs - meta.startMs,
    codec: meta.codec,
    copyOrTranscode: meta.mode
  };
}

// ---------------------------------------------------------------------------
// 服务入口（自动管理事务；调用方已有事务时嵌套复用）
// ---------------------------------------------------------------------------

type DerivationServiceOptions = {
  /** false 时调用方负责事务（IPC 在 command dispatch 事务内调用 commit*）。 */
  transaction?: boolean;
};

/**
 * 物化派生标注 Asset（renderer 导出标注 PNG 字节 → sha256 去重 + derived_annotation 血缘）。
 * 校验（源为图片、annotationSpec 合法、PNG 字节有效、大小上限）全部在任何写入之前。
 */
export async function materializeAnnotationAsset(
  database: DatabaseSync,
  dataRoot: string,
  input: {
    sourceAssetId: string;
    annotationSpec: AnnotationSpec;
    bytes: Buffer;
    fileName?: string;
    mimeType?: string;
    origin: string;
    requestId?: string | null;
    width?: number | null;
    height?: number | null;
  },
  options: DerivationServiceOptions = {}
): Promise<{ assetId: string; reused: boolean; sha256: string; width: number | null; height: number | null }> {
  const source = getAsset(database, input.sourceAssetId);
  if (!source) throw new Error(`源素材不存在: ${input.sourceAssetId}。`);
  if (!source.mimeType.startsWith('image/')) throw new Error(`源素材不是图片（mime ${source.mimeType}）。`);
  if (!isAnnotationSpecValid(input.annotationSpec)) {
    throw new Error('annotationSpec 无效（须 annotationType 字符串、elements 数组、正整数 width/height）。');
  }
  const staged = await stageAssetBytes(dataRoot, {
    bytes: input.bytes,
    fileName: input.fileName ?? 'annotation.png',
    mimeType: input.mimeType ?? 'image/png',
    origin: input.origin,
    width: input.width ?? null,
    height: input.height ?? null
  });
  const commit = (): { assetId: string; reused: boolean; sha256: string; width: number | null; height: number | null } => {
    const registered = registerStagedAsset(database, staged);
    // 空变换守卫：派生字节与源素材字节完全相同（如 renderer 导出未发生变化的标注）时，
    // sha256 内容寻址会命中源 Asset 自身。此时写 derived_annotation 会形成
    // derived_asset_id == source_asset_id 的自环血缘（血缘图损坏），必须跳过；
    // 返回源 Asset（reused=true）即可，重放同样幂等。
    if (registered.id !== input.sourceAssetId) {
      insertDerivedProvenance(database, {
        kind: 'derived_annotation',
        sourceAssetId: input.sourceAssetId,
        derivedAssetId: registered.id,
        transformJson: {
          annotationType: input.annotationSpec.annotationType,
          elements: input.annotationSpec.elements,
          width: staged.width ?? input.annotationSpec.width,
          height: staged.height ?? input.annotationSpec.height
        },
        origin: input.origin,
        requestId: input.requestId ?? null
      });
    }
    return { assetId: registered.id, reused: registered.reused, sha256: staged.sha256, width: staged.width, height: staged.height };
  };
  return runInTransaction(database, commit, options.transaction);
}

/**
 * 物化 ≤60s 派生 Clip Asset（stream copy 优先，固定 H.264/AAC 转码回退）。
 * 校验（源为视频、时间范围合法）在任何 ffmpeg/Asset/血缘写入之前完成。
 * 原子性：staging（文件）在事务外完成，Asset + 血缘在同一事务提交（runInTransaction）。
 */
export async function materializeClipAsset(
  database: DatabaseSync,
  dataRoot: string,
  input: {
    sourceAssetId: string;
    startMs: number;
    endMs: number;
    origin: string;
    requestId?: string | null;
  },
  options: DerivationServiceOptions & { executor?: MediaExecutor; runtime?: MediaRuntimeInfo } = {}
): Promise<ClipDerivationResult> {
  const stagedClip = await stageClipAsset(database, dataRoot, input, options);
  const meta: ClipDerivationMeta = {
    sourceAssetId: input.sourceAssetId,
    startMs: input.startMs,
    endMs: input.endMs,
    origin: input.origin,
    requestId: input.requestId ?? null,
    mode: stagedClip.copyOrTranscode,
    codec: stagedClip.codec,
    runtimeName: stagedClip.runtimeName,
    runtimeVersion: stagedClip.runtimeVersion
  };
  return runInTransaction(database, () => commitClipDerivation(database, stagedClip.staged, meta), options.transaction);
}

/** 事务包装：已有事务则直接执行（调用方负责提交/回滚）；否则自管 BEGIN/COMMIT/ROLLBACK。 */
function runInTransaction<T>(database: DatabaseSync, run: () => T, transaction: boolean | undefined): T {
  if (transaction === false) return run();
  if (database.isTransaction) return run();
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = run();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/** Clip 派生幂等键（source + 时间范围；同键 + 同运行时重放 → 同派生字节复用）。 */
export const clipKey = (sourceAssetId: string, startMs: number, endMs: number): string => `${sourceAssetId}|${startMs}-${endMs}`;

/** 标注派生幂等键（source + 标注变换；同键重放 → 同派生字节复用）。 */
export const annotationKey = (sourceAssetId: string, spec: AnnotationSpec): string =>
  `${sourceAssetId}|${spec.annotationType}|${spec.width}x${spec.height}|${createHash('sha256').update(JSON.stringify(spec.elements)).digest('hex')}`;

// re-export 运行时错误码与辅助，供调用方（IPC/accept 命令）统一处理。
export { mediaRuntimeVersion, MEDIA_RUNTIME_MISSING } from './media-runtime.ts';
export type { MediaExecutor, MediaRuntimeInfo } from './media-runtime.ts';
