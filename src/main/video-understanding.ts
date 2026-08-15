/**
 * WMB-5245：视频理解确定性主路径执行模块（设计 §10）。
 *
 * 管线固定为（绝不默认把整段视频交给多模态模型）：
 *   Probe（ffprobe 媒体解析）
 *     → 原生字幕优先 / 无字幕有音轨则 ASR / 无音轨或无文本则 OCR 兜底
 *     → 镜头检测（阈值 0.4）+ 10 秒间隔兜底边界
 *     → 关键帧抽帧（≤48，感知哈希去重，最大宽 1280，JPEG q85）
 *     → 必要时关键帧硬字幕 OCR（底部 35% 区域 + 整帧 PPT/表格/标题卡）
 *     → 字幕/ASR/OCR/关键帧按毫秒时间轴确定性对齐（≤64 Segment）
 *     → 单次有界摘要调用（≤64 Segment 批量输入；每段摘要 ≤200 字）
 *
 * 消费契约（MediaSchema 最终版，Main 确认）：
 * - store：src/main/db/video-understanding-store.ts
 *   （createVideoRun/startVideoRun/checkpointVideoStage/completeVideoRun/failVideoRun/
 *    getVideoRun/getVideoRunForIdentity/getLatestVideoRunForIdentity/listVideoRunsForRevision/
 *    parseProbeJson/parseKeyframesJson/parseSegmentsJson/parseTranscriptJson；
 *    completed 行 DB 触发器 + store 双保险不可变）。
 * - shared：src/shared/media-candidates.ts（VideoTranscriptSegment、VIDEO_TRANSCRIPT_SOURCES、
 *   videoEvidenceLocator；transcript source = native|asr|ocr|none）。
 * - runtime：src/main/media-runtime.ts（MediaRuntime 最终版：MEDIA_RUNTIME_CODES、
 *   MediaRuntimeError/mediaRuntimeErrorCode、runMediaRuntimeCommand、mediaRuntimeBinPaths、
 *   tesseractEnv、mediaRuntimeManifestHash；运行时缺失抛稳定 code，绝不回退 PATH）。
 * - 派生血缘：本模块自带 insertDerivedKeyframeProvenance（kind='derived_keyframe'，
 *   transform {timeMs,width,height}，source=原视频 Asset；与 media-derivations 同款
 *   UNIQUE(kind, source_asset_id, derived_asset_id) 幂等语义，避免跨切片运行时导入耦合）。
 *
 * 阶段恢复（设计 §10.3）：重试创建新 attempt；前一 attempt 已完成 stage 输出
 * （probe/transcript/keyframes/segments JSON）在 runtime 身份一致时按哈希校验复用，
 * 从失败 stage 继续，不重复下载/ASR/抽帧。无音轨/无字幕不是失败 → transcriptSource='none'。
 */
import { createHash, randomUUID } from 'node:crypto';
import { access, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getAsset, registerStagedAsset, stageAssetBytes } from './assets.ts';
import { getSource } from './sources.ts';
import {
  checkpointVideoStage,
  completeVideoRun,
  createVideoRun,
  failVideoRun,
  getLatestVideoRunForIdentity,
  getVideoRun,
  getVideoRunForIdentity,
  listVideoRunsForRevision,
  parseKeyframesJson,
  parseProbeJson,
  parseSegmentsJson,
  parseTranscriptJson,
  startVideoRun,
  type VideoKeyframeRecord,
  type VideoProbeInfo,
  type VideoRunIdentity,
  type VideoRunStage,
  type VideoSegmentRecord,
  type VideoTranscriptPayload,
  type VideoUnderstandingRunRecord
} from './db/video-understanding-store.ts';
import {
  MEDIA_RUNTIME_CODES,
  mediaRuntimeErrorCode,
  mediaRuntimeManifestHash,
  mediaRuntimeBinPaths,
  runMediaRuntimeCommand,
  tesseractEnv,
  type MediaRuntimeBinPaths
} from './media-runtime.ts';
import { MEDIA_LIMITS_DEFAULT } from '../shared/media-limits.ts';
import {
  VIDEO_TRANSCRIPT_SOURCES,
  type VideoTranscriptSegment,
  type VideoTranscriptSource
} from '../shared/media-candidates.ts';

// ============================================================
// 常量与固定矩阵（设计 §8/§10.2/§10.5/§10.6/§10.7；改动必须同步设计文档）
// ============================================================

/** 视频理解 schema 版本（参与身份键；同身份重放零新 run）。 */
export const VIDEO_SCHEMA_VERSION = 1;

/** 当前 prompt 模板版本（记录在 run 上，不参与身份键）。 */
export const VIDEO_PROMPT_VERSION = 1;

/** 默认 provider（与 index.ts 的 wmb-api provider 一致）。 */
export const VIDEO_DEFAULT_PROVIDER = 'wmb-api' as const;

/** 场景检测阈值（FFmpeg select scene，设计 §10.6）。 */
export const SCENE_THRESHOLD = 0.4;
/** 小于该时长的相邻镜头合并（毫秒，设计 §10.6）。 */
export const SCENE_MERGE_MS = 2_000;
/** 任意该时长窗口内无镜头切换 → 在窗口末尾追加兜底边界（毫秒，设计 §10.6）。 */
export const FALLBACK_WINDOW_MS = 10_000;
/** 关键帧最大宽度（保持比例；设计 §10.6）。 */
export const KEYFRAME_MAX_WIDTH = 1_280;
/** 关键帧 JPEG 质量（设计 §10.6）。 */
export const KEYFRAME_JPEG_QUALITY = 85;
/** OCR 置信度下限（<60% 丢弃；设计 §10.5）。 */
export const OCR_MIN_CONFIDENCE = 0.6;
/** OCR 底部区域比例（关键帧底部 35%；设计 §10.5）。 */
export const OCR_BOTTOM_RATIO = 0.35;
/** 少于该时长的 Segment 若无独立文本/关键帧变化则并入前段（设计 §10.7）。 */
export const SEGMENT_MIN_MS = 2_000;
/** 字幕长空档边界阈值：相邻字幕段间隔超过该值时创建边界（毫秒，设计 §10.7）。 */
export const TRANSCRIPT_LONG_GAP_MS = 5_000;
/** 每段摘要最大字符数（设计 §10.7：每段摘要最多 200 字）。 */
export const SUMMARY_MAX_CHARS = 200;

/** 单视频关键帧上限（设计 §8/§10.6）。 */
export const MAX_KEYFRAMES = MEDIA_LIMITS_DEFAULT.maxKeyframesPerVideo;
/** 单视频 Segment 上限（设计 §8/§10.7）。 */
export const MAX_SEGMENTS = MEDIA_LIMITS_DEFAULT.maxSegmentsPerVideo;

const STAGE_ORDER: readonly VideoRunStage[] = Object.freeze(['probe', 'transcript', 'keyframes', 'ocr', 'align', 'summarize']);

/** 模块错误：带稳定 code。 */
export class VideoUnderstandingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'VideoUnderstandingError';
    this.code = code;
  }
}

function runError(code: string, message: string): VideoUnderstandingError {
  return new VideoUnderstandingError(code, message);
}

// ============================================================
// 媒体运行时适配器（可注入；测试用假适配器，生产用默认实现）
// ============================================================

/** OCR 行（tesseract TSV 规范化结果；region 为相对 0..1 坐标）。 */
export type VideoOcrLine = Readonly<{
  text: string;
  confidence: number;
  x: number;
  y: number;
  width: number;
  height: number;
}>;

/** 关键帧抽帧结果（字节 + 像素尺寸 + 感知哈希）。 */
export type VideoKeyframeExtraction = Readonly<{
  bytes: Buffer;
  width: number;
  height: number;
  phash: string;
}>;

/** 视频理解运行时适配器：全部二进制操作收敛于此，测试可整体注入假实现。 */
export type VideoRuntimeAdapter = Readonly<{
  /** 运行时身份键（lock marker sha256；参与 stage 复用哈希校验）。 */
  identity: string;
  /** ffprobe 媒体解析 → 统一毫秒口径（probe_json 形状）。 */
  probe(localPath: string): Promise<VideoProbeInfo>;
  /** 原生字幕提取（已选轨）→ 规范化为 transcript 段（source='native'）；无/空 → []。 */
  extractSubtitles(localPath: string, trackIndex: number): Promise<VideoTranscriptSegment[]>;
  /** whisper.cpp ASR → 段（source='asr'）；崩溃/OOM 抛 ASR_FAILED。 */
  runAsr(localPath: string): Promise<VideoTranscriptSegment[]>;
  /** 镜头检测 → 镜头边界毫秒（升序，不含 0/durationMs；设计 §10.6 阈值 0.4）。 */
  detectScenes(localPath: string): Promise<number[]>;
  /** 指定时间抽帧：`timeMs` 处第一张稳定帧；最大宽 1280、JPEG q85。 */
  extractKeyframe(localPath: string, timeMs: number): Promise<VideoKeyframeExtraction>;
  /** 关键帧硬字幕 OCR：整帧（region=null）或相对区域；置信度 0..1。 */
  runOcr(imagePath: string, region: { x: number; y: number; width: number; height: number } | null): Promise<VideoOcrLine[]>;
}>;

// ---------------------------------------------------------------------------
// 派生血缘（本模块自带，避免跨切片导入耦合；语义与 media-derivations 一致）
// ---------------------------------------------------------------------------

/** 幂等写入 derived_keyframe 血缘行：UNIQUE(kind, source_asset_id, derived_asset_id) 已存在则跳过。 */
export function insertDerivedKeyframeProvenance(
  database: DatabaseSync,
  input: {
    sourceAssetId: string;
    derivedAssetId: string;
    timeMs: number;
    width: number;
    height: number;
    origin: string;
    requestId?: string | null;
    runtimeName?: string | null;
  }
): void {
  const existing = database.prepare(`SELECT id FROM asset_provenance
    WHERE kind = 'derived_keyframe' AND source_asset_id = ? AND derived_asset_id = ?`)
    .get(input.sourceAssetId, input.derivedAssetId);
  if (existing) return;
  database.prepare(`INSERT INTO asset_provenance
    (id, asset_id, kind, origin, source_asset_id, derived_asset_id, transform_json, request_id, runtime_name, created_at)
    VALUES (?, ?, 'derived_keyframe', ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      randomUUID(),
      input.derivedAssetId,
      input.origin,
      input.sourceAssetId,
      input.derivedAssetId,
      JSON.stringify({ timeMs: input.timeMs, width: input.width, height: input.height }),
      input.requestId ?? null,
      input.runtimeName ?? null,
      new Date().toISOString()
    );
}

// ---------------------------------------------------------------------------
// 默认适配器：消费 media-runtime.ts 最终版 API（受管根目录；绝不回退 PATH）
// ---------------------------------------------------------------------------

function parseFloatSafe(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function trimStderr(text: string): string {
  return text.trim().split('\n').filter(Boolean).slice(-3).join(' ');
}

function parseAvgFrameRate(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const parts = value.split('/');
  if (parts.length !== 2) return null;
  const numerator = Number.parseFloat(parts[0]);
  const denominator = Number.parseFloat(parts[1]);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

function isRuntimeMissing(error: unknown): boolean {
  return mediaRuntimeErrorCode(error) === MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_MISSING
    || mediaRuntimeErrorCode(error) === MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_LOCK_MISSING
    || mediaRuntimeErrorCode(error) === MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_LOCK_MISMATCH
    || mediaRuntimeErrorCode(error) === MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_HASH_MISMATCH
    || mediaRuntimeErrorCode(error) === MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_PLATFORM_MISMATCH;
}

/** 从 ffprobe JSON 输出解析 VideoProbeInfo（统一整数毫秒口径）。 */
function parseProbeInfoFromJson(stdout: string, runtimeManifestHash: string): VideoProbeInfo {
  const parsed = JSON.parse(stdout) as {
    format?: { format_name?: string; duration?: string };
    streams?: Array<Record<string, unknown>>;
  };
  const durationMs = Math.round((parseFloatSafe(parsed.format?.duration) ?? 0) * 1000);
  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const subtitleTracks = streams
    .map((stream, index) => ({
      index,
      language: (stream.tags as { language?: string } | undefined)?.language ?? null,
      forced: (stream.tags as { forced?: string } | undefined)?.forced === '1' || (stream.tags as { forced?: string } | undefined)?.forced === 'true',
      default: (stream.tags as { default?: string } | undefined)?.default === '1' || (stream.tags as { default?: string } | undefined)?.default === 'true'
    }))
    .filter((_, index) => streams[index]?.codec_type === 'subtitle');
  const frameRate = parseAvgFrameRate(video?.['avg_frame_rate']);
  return Object.freeze({
    container: parsed.format?.format_name ?? 'unknown',
    durationMs,
    width: Number.isFinite(Number(video?.width)) ? Number(video?.width) : null,
    height: Number.isFinite(Number(video?.height)) ? Number(video?.height) : null,
    frameRate,
    rotation: null,
    videoCodec: typeof video?.codec_name === 'string' ? video.codec_name : null,
    audioCodec: typeof audio?.codec_name === 'string' ? audio.codec_name : null,
    hasAudio: Boolean(audio),
    subtitleTracks,
    chapters: Object.freeze([]),
    runtimeManifestHash
  });
}

/** 从 whisper-cli JSON 输出解析 ASR 段（source='asr'）。 */
function parseWhisperSegments(stdout: string): VideoTranscriptSegment[] {
  const parsed = JSON.parse(stdout) as {
    segments?: Array<{ start?: number; end?: number; text?: string }>;
  };
  const segments = parsed.segments ?? [];
  return segments
    .map((segment) => ({
      startMs: Math.round((segment.start ?? 0) * 1000),
      endMs: Math.round((segment.end ?? 0) * 1000),
      text: (segment.text ?? '').trim(),
      source: 'asr' as const
    }))
    .filter((segment) => segment.endMs > segment.startMs && segment.text.length > 0);
}

/** 从 ffmpeg scene showinfo 输出解析镜头边界（毫秒）。 */
function parseSceneShowinfo(stderr: string): number[] {
  const boundaries: number[] = [];
  const pattern = /pts_time:([0-9.]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stderr)) !== null) {
    const seconds = parseFloatSafe(match[1]);
    if (seconds !== null && seconds > 0) boundaries.push(Math.round(seconds * 1000));
  }
  return boundaries.sort((left, right) => left - right);
}

/** 从 tesseract TSV 输出解析 OCR 行（相对 0..1 区域 + 0..1 置信度）。 */
function parseTesseractTsv(stdout: string, pageWidth: number, pageHeight: number): VideoOcrLine[] {
  const lines = stdout.split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split('\t');
  const column = (name: string): number => header.indexOf(name);
  const colLevel = column('level');
  const colText = column('text');
  const colConf = column('conf');
  const colLeft = column('left');
  const colTop = column('top');
  const colWidth = column('width');
  const colHeight = column('height');
  if ([colLevel, colText, colConf, colLeft, colTop, colWidth, colHeight].some((index) => index < 0)) return [];
  const rows: VideoOcrLine[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cells = line.split('\t');
    const level = Number(cells[colLevel]);
    const text = (cells[colText] ?? '').trim();
    if (level !== 5 || !text) continue; // level 5 = word 级
    const confidence = Number(cells[colConf]) / 100;
    const left = Number(cells[colLeft]);
    const top = Number(cells[colTop]);
    const width = Number(cells[colWidth]);
    const height = Number(cells[colHeight]);
    if (!Number.isFinite(confidence) || !Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(width) || !Number.isFinite(height)) continue;
    if (pageWidth <= 0 || pageHeight <= 0) continue;
    rows.push(Object.freeze({
      text,
      confidence,
      x: Math.min(1, Math.max(0, left / pageWidth)),
      y: Math.min(1, Math.max(0, top / pageHeight)),
      width: Math.min(1, Math.max(0, width / pageWidth)),
      height: Math.min(1, Math.max(0, height / pageHeight))
    }));
  }
  return rows;
}

/** 二进制输出命令（ffmpeg/ffprobe 输出到 stdout 的原生 Buffer，runner 的字符串通道不适合）。 */
function runBinaryCommand(
  executable: string,
  args: readonly string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<{ stdout: Buffer; stderr: string; status: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env }
    });
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`命令超时: ${path.basename(executable)}`));
    }, options.timeoutMs ?? 120_000);
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(chunks), stderr, status: status ?? -1 });
    });
  });
}

async function requireBinPaths(): Promise<MediaRuntimeBinPaths> {
  const binPaths = await mediaRuntimeBinPaths();
  if (!binPaths) {
    const error = new Error('媒体运行时未准备（.r/media-runtime 缺失或 lock 未落地）');
    (error as { code?: string }).code = MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_MISSING;
    throw error;
  }
  return binPaths;
}

/** 8x8 灰度 rawvideo 感知哈希：scaled 像素字节 sha256（确定性；非 JPEG 字节比较）。 */
async function computePerceptionHash(binPaths: MediaRuntimeBinPaths, localPath: string, timeMs: number): Promise<string> {
  const result = await runBinaryCommand(binPaths.ffmpeg, [
    '-hide_banner', '-nostdin',
    '-ss', `${timeMs / 1000}`,
    '-i', localPath,
    '-frames:v', '1',
    '-vf', 'scale=8:8,format=gray',
    '-f', 'rawvideo',
    '-'
  ]);
  if (result.status !== 0) throw new Error(`关键帧感知哈希失败: ${trimStderr(result.stderr)}`);
  return createHash('sha256').update(result.stdout).digest('hex');
}

/**
 * 由受管运行时构造默认适配器。惰性解析：创建时绝不抛错（运行时缺失时应用仍可启动，
 * 图片链不受影响）；只有真正执行二进制操作时才抛 MEDIA_RUNTIME_MISSING 等稳定 code。
 * identity = 受管 lock marker sha256（stage 复用哈希校验用）；lock 未落地时用稳定占位，
 * 但任何二进制操作都会以 MEDIA_RUNTIME_MISSING 失败，绝不回退 PATH。
 */
export async function createDefaultVideoRuntimeAdapter(options: { runtimeDir?: string } = {}): Promise<VideoRuntimeAdapter> {
  const identity = (await mediaRuntimeManifestHash(options.runtimeDir)) ?? 'media-runtime-unprepared';
  void options;

  const probeArgs = (localPath: string): string[] => [
    '-v', 'error',
    '-show_entries', 'format=format_name,duration:stream=index,codec_type,codec_name,width,height,avg_frame_rate:stream_tags=language,forced,default',
    '-of', 'json',
    localPath
  ];

  return Object.freeze({
    identity,
    probe: async (localPath) => {
      const binPaths = await requireBinPaths();
      void binPaths;
      const result = await runMediaRuntimeCommand('ffprobe', probeArgs(localPath));
      return parseProbeInfoFromJson(result.stdout, identity);
    },
    extractSubtitles: async (localPath, trackIndex) => {
      await requireBinPaths();
      try {
        const result = await runMediaRuntimeCommand('ffmpeg', [
          '-hide_banner', '-nostdin', '-i', localPath,
          '-map', `0:s:${trackIndex}`, '-f', 'srt', '-'
        ]);
        return parseSrtToSegments(result.stdout, 'native');
      } catch (error) {
        if (isRuntimeMissing(error)) throw error;
        return []; // 无该轨/提取失败 → 空（降级，不是失败）
      }
    },
    runAsr: async (localPath) => {
      const binPaths = await requireBinPaths();
      await access(binPaths.whisperCli).catch(() => {
        const error = new Error(`whisper-cli 不可用（受管目录缺失 ${binPaths.whisperCli}，不回退 PATH）。`);
        (error as { code?: string }).code = MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_MISSING;
        throw error;
      });
      await access(binPaths.whisperModel).catch(() => {
        const error = new Error(`whisper 模型不可用（受管目录缺失 ${binPaths.whisperModel}）。`);
        (error as { code?: string }).code = MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_MISSING;
        throw error;
      });
      try {
        const result = await runMediaRuntimeCommand('whisperCli', [
          '-m', binPaths.whisperModel,
          '-f', localPath,
          '-oj', '-of', '-'
        ]);
        return parseWhisperSegments(result.stdout);
      } catch (error) {
        if (isRuntimeMissing(error)) throw error;
        const asrError = new Error(`ASR_FAILED: whisper-cli 执行失败${error instanceof Error ? `: ${error.message}` : ''}`);
        (asrError as { code?: string }).code = 'ASR_FAILED';
        throw asrError;
      }
    },
    detectScenes: async (localPath) => {
      await requireBinPaths();
      try {
        const result = await runMediaRuntimeCommand('ffmpeg', [
          '-hide_banner', '-nostdin', '-i', localPath,
          '-filter_complex', `select='gt(scene,${SCENE_THRESHOLD})',showinfo`,
          '-f', 'null', '-'
        ]);
        return parseSceneShowinfo(result.stderr);
      } catch (error) {
        if (isRuntimeMissing(error)) throw error;
        return []; // 镜头检测异常 → 纯 10s 兜底，不是失败
      }
    },
    extractKeyframe: async (localPath, timeMs) => {
      const binPaths = await requireBinPaths();
      const result = await runBinaryCommand(binPaths.ffmpeg, [
        '-hide_banner', '-nostdin',
        '-ss', `${timeMs / 1000}`,
        '-i', localPath,
        '-frames:v', '1',
        '-vf', `scale='min(${KEYFRAME_MAX_WIDTH},iw)':-2`,
        '-q:v', `${KEYFRAME_JPEG_QUALITY}`,
        '-f', 'mjpeg', '-'
      ]);
      if (result.status !== 0 || !result.stdout.length) throw new Error(`关键帧抽帧失败: ${trimStderr(result.stderr)}`);
      const phash = await computePerceptionHash(binPaths, localPath, timeMs);
      const size = await probeImageSize(binPaths, result.stdout);
      return { bytes: result.stdout, width: size.width, height: size.height, phash };
    },
    runOcr: async (imagePath, region) => {
      const binPaths = await requireBinPaths();
      await access(binPaths.tesseract).catch(() => {
        const error = new Error(`tesseract 不可用（受管目录缺失 ${binPaths.tesseract}，不回退 PATH）。`);
        (error as { code?: string }).code = MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_MISSING;
        throw error;
      });
      let targetPath = imagePath;
      if (region) {
        const page = await probeImageSize(binPaths, await readFileBytes(imagePath));
        if (page.width > 0 && page.height > 0) {
          const cropWidth = Math.max(1, Math.round(region.width * page.width));
          const cropHeight = Math.max(1, Math.round(region.height * page.height));
          const cropX = Math.round(region.x * page.width);
          const cropY = Math.round(region.y * page.height);
          targetPath = path.join(path.dirname(imagePath), `ocr-crop-${randomUUID()}.png`);
          const cropResult = await runBinaryCommand(binPaths.ffmpeg, [
            '-hide_banner', '-nostdin', '-i', imagePath,
            '-vf', `crop=${cropWidth}:${cropHeight}:${cropX}:${cropY}`,
            '-frames:v', '1', '-y', targetPath
          ]);
          if (cropResult.status !== 0) {
            await rm(targetPath, { force: true });
            throw new Error(`OCR 裁剪失败: ${trimStderr(cropResult.stderr)}`);
          }
        }
      }
      try {
        const env = await tesseractEnv();
        const tsv = await runMediaRuntimeCommand('tesseract', [targetPath, 'stdout', '-l', 'chi_sim+eng', '--psm', '6', 'tsv'], { env });
        const page = await probeImageSize(binPaths, await readFileBytes(imagePath));
        return parseTesseractTsv(tsv.stdout, page.width, page.height);
      } finally {
        if (region && targetPath !== imagePath) await rm(targetPath, { force: true });
      }
    }
  });
}

async function readFileBytes(filePath: string): Promise<Buffer> {
  const { readFile } = await import('node:fs/promises');
  return readFile(filePath);
}

async function probeImageSize(binPaths: MediaRuntimeBinPaths, bytes: Buffer): Promise<{ width: number; height: number }> {
  const tmp = path.join(process.env.TEMP || '/tmp', `wmb-kf-${randomUUID()}.jpg`);
  await writeFile(tmp, bytes);
  try {
    const result = await runBinaryCommand(binPaths.ffprobe, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'json', tmp
    ]);
    if (result.status !== 0) return { width: 0, height: 0 };
    const parsed = JSON.parse(result.stdout.toString('utf8')) as { streams?: Array<{ width?: number; height?: number }> };
    const stream = parsed.streams?.[0];
    return { width: Number(stream?.width) || 0, height: Number(stream?.height) || 0 };
  } catch {
    return { width: 0, height: 0 };
  } finally {
    await rm(tmp, { force: true });
  }
}

// ============================================================
// 纯确定性算法（无副作用；同输入 → 同输出）
// ============================================================

/** SRT/WebVTT 文本 → transcript 段（source 注入；时间戳毫秒规范化）。 */
export function parseSrtToSegments(srtText: string, source: VideoTranscriptSource): VideoTranscriptSegment[] {
  const segments: VideoTranscriptSegment[] = [];
  const blocks = srtText.split(/\r?\n\r?\n+/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length < 2) continue;
    const timeLineIndex = lines.findIndex((line) => line.includes('-->'));
    if (timeLineIndex < 0) continue;
    const timeRange = parseTimeRangeLine(lines[timeLineIndex]);
    if (!timeRange || timeRange.endMs <= timeRange.startMs) continue;
    const text = lines.slice(timeLineIndex + 1).join(' ').trim();
    if (!text) continue;
    segments.push(Object.freeze({ startMs: timeRange.startMs, endMs: timeRange.endMs, text, source }));
  }
  return segments;
}

function parseTimeRangeLine(line: string): { startMs: number; endMs: number } | null {
  const match = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(line);
  if (!match) return null;
  const toMs = (h: string, m: string, s: string, f: string): number =>
    (Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000 + Number(f.padEnd(3, '0').slice(0, 3));
  const startMs = toMs(match[1], match[2], match[3], match[4]);
  const endMs = toMs(match[5], match[6], match[7], match[8]);
  return { startMs, endMs };
}

/** 字幕轨选择（设计 §10.5）：优先 forced/default → 匹配 Source 语言 → 第一条。返回轨 index 或 null。 */
export function pickSubtitleTrack(
  probe: Pick<VideoProbeInfo, 'subtitleTracks'>,
  sourceLanguage: string | null
): number | null {
  const tracks = probe.subtitleTracks;
  if (!tracks.length) return null;
  const forcedOrDefault = tracks.find((track) => track.forced || track.default);
  if (forcedOrDefault) return forcedOrDefault.index;
  if (sourceLanguage) {
    const lang = sourceLanguage.toLowerCase();
    const matched = tracks.find((track) => track.language?.toLowerCase() === lang || track.language?.toLowerCase().startsWith(lang));
    if (matched) return matched.index;
  }
  return tracks[0].index;
}

/** 镜头边界规范化：小于 2 秒的相邻镜头合并（设计 §10.6）。 */
export function mergeSceneBoundaries(sceneBoundariesMs: readonly number[], mergeMs: number = SCENE_MERGE_MS): number[] {
  const sorted = [...sceneBoundariesMs].sort((left, right) => left - right);
  if (!sorted.length) return [];
  const merged: number[] = [sorted[0]];
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = merged[merged.length - 1];
    if (sorted[index] - previous < mergeMs) {
      continue; // 相邻短镜头合并（保留首个边界）
    }
    merged.push(sorted[index]);
  }
  return merged;
}

/** 10 秒兜底边界：任意 FALLBACK_WINDOW_MS 窗口内无镜头切换 → 在窗口末尾追加边界（设计 §10.6）。 */
export function computeFallbackBoundaries(
  sceneBoundariesMs: readonly number[],
  durationMs: number,
  fallbackWindowMs: number = FALLBACK_WINDOW_MS
): number[] {
  const boundaries = new Set(sceneBoundariesMs);
  const fallback: number[] = [];
  for (let windowEnd = fallbackWindowMs; windowEnd < durationMs; windowEnd += fallbackWindowMs) {
    const windowStart = windowEnd - fallbackWindowMs;
    const hasCut = sceneBoundariesMs.some((cut) => cut > windowStart && cut <= windowEnd);
    if (!hasCut && !boundaries.has(windowEnd)) {
      boundaries.add(windowEnd);
      fallback.push(windowEnd);
    }
  }
  return fallback;
}

/** 关键帧时间点选择：边界并集；超过上限时保留首尾 + 文本数字/专有名词点，其余均匀下采样（设计 §10.6）。 */
export function selectKeyframeTimes(
  boundariesMs: readonly number[],
  transcript: readonly VideoTranscriptSegment[],
  durationMs: number,
  maxFrames: number = MAX_KEYFRAMES
): number[] {
  const unique = [...new Set([0, ...boundariesMs, durationMs])].sort((left, right) => left - right);
  // 抽帧点 = 每个 Segment 起点（边界），排除 0 与 durationMs 本身。
  let candidates = unique.filter((time) => time > 0 && time < durationMs);
  // 任意正时长视频至少保留首帧代表帧（Segment 起点 0 之后第一张稳定帧），
  // 保证短静态视频（≤10s、无镜头/兜底边界）也能抽帧、OCR 与关键帧回看（设计 §10.6）。
  if (candidates.length === 0 && durationMs > 0) candidates = [0];
  if (candidates.length <= maxFrames) return candidates;
  const textPoints = new Set<number>();
  const digitPattern = /\d/;
  const properNounPattern = /[A-Z]{2,}|[\u4e00-\u9fff]+/;
  for (const segment of transcript) {
    if (digitPattern.test(segment.text) || properNounPattern.test(segment.text)) {
      textPoints.add(segment.startMs);
      textPoints.add(segment.endMs);
    }
  }
  const first = candidates[0];
  const last = candidates[candidates.length - 1];
  const kept: number[] = [first];
  for (const time of candidates) {
    if (time === first || time === last) continue;
    if (textPoints.has(time)) kept.push(time);
  }
  kept.push(last);
  if (kept.length <= maxFrames) return [...new Set(kept)].sort((left, right) => left - right);
  // 仍超限：均匀下采样（保留首尾）。
  const result = [first];
  const remaining = candidates.filter((time) => !kept.includes(time) && time !== first && time !== last);
  const slots = Math.max(0, maxFrames - 2);
  for (let slot = 1; slot <= slots; slot += 1) {
    const index = Math.round((remaining.length * slot) / (slots + 1));
    if (index > 0 && index <= remaining.length) result.push(remaining[index - 1]);
  }
  result.push(last);
  return [...new Set(result)].sort((left, right) => left - right).slice(0, maxFrames);
}

/** 相邻关键帧感知哈希去重（设计 §10.6：比较哈希，不比较 JPEG 字节）。 */
export function dedupeKeyframesByPhash(frames: readonly VideoKeyframeRecord[]): VideoKeyframeRecord[] {
  const result: VideoKeyframeRecord[] = [];
  for (const frame of frames) {
    const previous = result[result.length - 1];
    if (previous && frame.perceptionHash && previous.perceptionHash === frame.perceptionHash) continue;
    result.push(frame);
  }
  return result;
}

/** 单条 OCR 行按关键帧时间窗口归属（逐帧调用；供管线在 ocr stage 使用）。 */
export function ocrLineToSegment(
  line: VideoOcrLine,
  startMs: number,
  endMs: number
): VideoTranscriptSegment {
  return Object.freeze({ startMs, endMs, text: line.text, source: 'ocr' as const, confidence: line.confidence });
}

/** 字幕长空档边界：相邻字幕段间隔 ≥ TRANSCRIPT_LONG_GAP_MS → 在间隔中点创建边界（设计 §10.7）。 */
export function transcriptGapBoundaries(
  transcript: readonly VideoTranscriptSegment[],
  longGapMs: number = TRANSCRIPT_LONG_GAP_MS
): number[] {
  const boundaries: number[] = [];
  for (let index = 1; index < transcript.length; index += 1) {
    const previous = transcript[index - 1];
    const current = transcript[index];
    const gap = current.startMs - previous.endMs;
    if (gap >= longGapMs) {
      boundaries.push(previous.endMs + Math.round(gap / 2));
    }
  }
  return boundaries;
}

/**
 * 确定性 Segment 对齐（设计 §10.7）：
 * 1) 初始边界 = 关键帧起点 ∪ 字幕长空档边界并集（镜头/兜底边界已物化为关键帧起点）；
 * 2) 小于 2 秒且无独立文本/关键帧变化的段并入前段；
 * 3) Transcript 段按最大时间重叠归属；无重叠按中点归属；
 * 4) Segment 内保留原始 Transcript 段时间戳，不改写文本；
 * 5) 无文本 Segment 保留关键帧并标 transcriptSource='none'；
 * 6) 超过 64 段时优先合并连续静态、无文本变化的相邻段（有数字/OCR/字幕变化的段绝不丢失）。
 */
export function alignVideoSegments(input: {
  durationMs: number;
  keyframes: readonly VideoKeyframeRecord[];
  transcript: readonly VideoTranscriptSegment[];
  maxSegments?: number;
  minSegmentMs?: number;
}): VideoSegmentRecord[] {
  const durationMs = input.durationMs;
  const maxSegments = input.maxSegments ?? MAX_SEGMENTS;
  const minSegmentMs = input.minSegmentMs ?? SEGMENT_MIN_MS;
  const keyframeStartTimes = new Set(input.keyframes.map((frame) => frame.timeMs));
  const initialBoundaries = [...new Set([
    0,
    ...input.keyframes.map((frame) => frame.timeMs),
    ...transcriptGapBoundaries(input.transcript),
    durationMs
  ])].sort((left, right) => left - right);

  // 初始段。
  let segments: Array<{ startMs: number; endMs: number }> = [];
  for (let index = 1; index < initialBoundaries.length; index += 1) {
    const startMs = initialBoundaries[index - 1];
    const endMs = initialBoundaries[index];
    if (endMs > startMs) segments.push({ startMs, endMs });
  }

  // 2) 小段并入前段：<2s 且无独立文本（段内无字幕/OCR 文本）且无独立关键帧起点。
  const merged: Array<{ startMs: number; endMs: number }> = [];
  for (const segment of segments) {
    const duration = segment.endMs - segment.startMs;
    const hasOwnKeyframe = keyframeStartTimes.has(segment.startMs);
    const hasOwnText = input.transcript.some((item) => item.startMs >= segment.startMs && item.startMs < segment.endMs);
    if (merged.length && duration < minSegmentMs && !hasOwnKeyframe && !hasOwnText) {
      merged[merged.length - 1].endMs = segment.endMs;
    } else {
      merged.push({ startMs: segment.startMs, endMs: segment.endMs });
    }
  }
  segments = merged;

  // 3) Transcript 归属：最大时间重叠；无重叠按中点归属。
  const baseSegments = segments.map((segment, index) => Object.freeze({
    index,
    startMs: segment.startMs,
    endMs: segment.endMs,
    transcript: Object.freeze([] as readonly VideoTranscriptSegment[]),
    transcriptSource: 'none' as const,
    ocrRegions: Object.freeze([]),
    summary: null as string | null,
    quoteRange: null as { startMs: number; endMs: number } | null,
    confidence: null as number | null,
    warnings: Object.freeze([] as readonly string[])
  }));

  const transcriptBySegment = new Map<number, VideoTranscriptSegment[]>();
  for (const item of input.transcript) {
    let bestIndex = -1;
    let bestOverlap = 0;
    for (let index = 0; index < baseSegments.length; index += 1) {
      const overlap = Math.min(item.endMs, baseSegments[index].endMs) - Math.max(item.startMs, baseSegments[index].startMs);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) {
      const midpoint = (item.startMs + item.endMs) / 2;
      bestIndex = baseSegments.findIndex((segment) => midpoint >= segment.startMs && midpoint < segment.endMs);
      if (bestIndex < 0) bestIndex = baseSegments.length - 1;
    }
    const bucket = transcriptBySegment.get(bestIndex) ?? [];
    bucket.push(item);
    transcriptBySegment.set(bestIndex, bucket);
  }

  // 4) 保留原始时间戳；5) 无文本段 transcriptSource='none'；关键帧按起点就近归属。
  const owned = baseSegments.map((segment) => {
    const items = (transcriptBySegment.get(segment.index) ?? []).slice()
      .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
    const textItems = items.filter((item) => item.text.trim().length > 0);
    const transcriptSource: VideoTranscriptSource = textItems.length ? textItems[0].source : 'none';
    const keyframe = input.keyframes.find((frame) => frame.timeMs >= segment.startMs && frame.timeMs < segment.endMs)
      ?? input.keyframes.filter((frame) => frame.timeMs < segment.startMs).at(-1)
      ?? input.keyframes[0]
      ?? null;
    const confidence = textItems.length
      ? Math.round((textItems.reduce((sum, item) => sum + (item.confidence ?? 0), 0) / textItems.length) * 100) / 100
      : null;
    const quoteRange = textItems.length
      ? Object.freeze({ startMs: Math.min(...textItems.map((item) => item.startMs)), endMs: Math.max(...textItems.map((item) => item.endMs)) })
      : null;
    return Object.freeze({
      index: segment.index,
      startMs: segment.startMs,
      endMs: segment.endMs,
      keyframeAssetId: keyframe?.assetId ?? null,
      transcript: Object.freeze(items),
      transcriptSource,
      ocrRegions: Object.freeze([]),
      summary: null,
      quoteRange,
      confidence,
      warnings: Object.freeze([] as readonly string[])
    });
  });

  // 6) 超限合并：优先合并连续静态、无文本变化相邻段；绝不丢数字/OCR/字幕变化段。
  let aligned = owned;
  let guard = 0;
  while (aligned.length > maxSegments && guard < 200) {
    guard += 1;
    let mergeIndex = -1;
    for (let index = 0; index + 1 < aligned.length; index += 1) {
      const left = aligned[index];
      const right = aligned[index + 1];
      const leftProtected = left.transcriptSource !== 'none' || left.transcript.some((item) => /\d/.test(item.text));
      const rightProtected = right.transcriptSource !== 'none' || right.transcript.some((item) => /\d/.test(item.text));
      if (!leftProtected && !rightProtected) {
        mergeIndex = index;
        break;
      }
    }
    if (mergeIndex < 0) {
      // 全部受保护仍须收敛：合并相邻段中最短的一对（保首尾关键段）。
      let best = -1;
      let bestLength = Infinity;
      for (let index = 0; index + 1 < aligned.length; index += 1) {
        const length = (aligned[index].endMs - aligned[index].startMs) + (aligned[index + 1].endMs - aligned[index + 1].startMs);
        if (length < bestLength) { bestLength = length; best = index; }
      }
      mergeIndex = best;
    }
    if (mergeIndex < 0) break;
    const left = aligned[mergeIndex];
    const right = aligned[mergeIndex + 1];
    const mergedSegment = Object.freeze({
      index: left.index,
      startMs: left.startMs,
      endMs: right.endMs,
      keyframeAssetId: left.keyframeAssetId ?? right.keyframeAssetId,
      transcript: Object.freeze([...left.transcript, ...right.transcript]),
      transcriptSource: left.transcriptSource !== 'none' ? left.transcriptSource : right.transcriptSource,
      ocrRegions: Object.freeze([]),
      summary: null,
      quoteRange: left.quoteRange ?? right.quoteRange,
      confidence: left.confidence ?? right.confidence,
      warnings: Object.freeze([...left.warnings, ...right.warnings])
    });
    aligned = [...aligned.slice(0, mergeIndex), mergedSegment, ...aligned.slice(mergeIndex + 2)];
  }
  return aligned.map((segment, index) => Object.freeze({ ...segment, index }));
}

/** 摘要长度有界（≤200 字；超长截断并记 warning，设计 §10.7）。 */
export function boundSummary(text: string): { summary: string; truncated: boolean } {
  const trimmed = (text ?? '').trim();
  if (trimmed.length <= SUMMARY_MAX_CHARS) return { summary: trimmed, truncated: false };
  return { summary: trimmed.slice(0, SUMMARY_MAX_CHARS), truncated: true };
}

// ============================================================
// 入队 / 重试（幂等；复用 store 原语）
// ============================================================

export type EnqueueVideoRunInput = Readonly<{
  sourceId: string;
  sourceRevisionKey: string;
  assetId: string;
  schemaVersion?: number;
  /** true：最新 attempt 为 failed 时创建新 attempt（旧行保留审计）；非 failed 幂等返回现有行。 */
  retry?: boolean;
}>;

export function enqueueVideoRun(database: DatabaseSync, input: EnqueueVideoRunInput): { run: VideoUnderstandingRunRecord; created: boolean } {
  const sourceId = input.sourceId?.trim();
  const sourceRevisionKeyValue = input.sourceRevisionKey?.trim();
  const assetId = input.assetId?.trim();
  if (!sourceId) throw runError('INPUT_INVALID', 'sourceId 不能为空。');
  if (!sourceRevisionKeyValue) throw runError('INPUT_INVALID', 'sourceRevisionKey 不能为空。');
  if (!assetId) throw runError('INPUT_INVALID', 'assetId 不能为空。');
  const schemaVersion = input.schemaVersion ?? VIDEO_SCHEMA_VERSION;
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) throw runError('INPUT_INVALID', 'schemaVersion 必须为正整数。');
  if (!getSource(database, sourceId)) throw runError('SOURCE_NOT_FOUND', `Source ${sourceId} 不存在。`);
  if (!getAsset(database, assetId)) throw runError('ASSET_NOT_FOUND', `Asset ${assetId} 不存在。`);

  const latest = getLatestVideoRunForIdentity(database, { sourceId, sourceRevisionKey: sourceRevisionKeyValue, assetId, schemaVersion });
  if (latest) {
    if (latest.status === 'failed' && input.retry) {
      const attempt = latest.attempt + 1;
      return { run: createVideoRun(database, { sourceId, sourceRevisionKey: sourceRevisionKeyValue, assetId, schemaVersion, attempt }), created: true };
    }
    return { run: latest, created: false };
  }
  return { run: createVideoRun(database, { sourceId, sourceRevisionKey: sourceRevisionKeyValue, assetId, schemaVersion, attempt: 1 }), created: true };
}

/** 重试指定 run 对应的（身份 + schemaVersion）：最新 failed → 新 attempt；completed → 幂等返回。 */
export function retryVideoRun(database: DatabaseSync, runId: string): { run: VideoUnderstandingRunRecord; created: boolean } {
  const existing = getVideoRun(database, runId);
  if (!existing) throw runError('VIDEO_RUN_NOT_FOUND', `视频理解 run ${runId} 不存在。`);
  return enqueueVideoRun(database, {
    sourceId: existing.sourceId,
    sourceRevisionKey: existing.sourceRevisionKey,
    assetId: existing.assetId,
    schemaVersion: existing.schemaVersion,
    retry: true
  });
}

// ============================================================
// 执行（阶段管线 + checkpoint + stage 复用；失败保留错误，绝不伪造）
// ============================================================

export type VideoSummaryCall = (input: {
  segments: readonly VideoSegmentRecord[];
  promptVersion: number;
  model: string | null;
  provider: string | null;
}) => Promise<ReadonlyArray<{ index: number; summary: string; confidence?: number | null }>>;

export type VideoUnderstandingExecutionDeps = Readonly<{
  /** dataRoot：asset.relativePath 据此解析为本地绝对路径。 */
  dataRoot: string;
  runtime: VideoRuntimeAdapter;
  /** 单次有界摘要调用（每 attempt 最多一次；失败只记 warning，不抹掉机械结果）。 */
  summaryCall: VideoSummaryCall;
  model?: string;
  provider?: string;
  promptVersion?: number;
  /** Source 语言（字幕轨选择：forced/default → 匹配语言 → 第一条）。 */
  sourceLanguage?: string | null;
}>;

function stageIndex(stage: VideoRunStage): number {
  const index = STAGE_ORDER.indexOf(stage);
  return index < 0 ? 0 : index;
}

/** 复用判定：前一 attempt 的 stage 输出是否可复用（runtime 身份一致才复用，设计 §10.3 哈希校验）。 */
function reusablePrior(prior: VideoUnderstandingRunRecord | null, runtimeIdentity: string): VideoUnderstandingRunRecord | null {
  if (!prior) return null;
  if (prior.status !== 'failed') return null;
  if (prior.runtimeManifestHash && prior.runtimeManifestHash !== runtimeIdentity) return null;
  return prior;
}

async function requireVideoAssetPath(database: DatabaseSync, dataRoot: string, assetId: string): Promise<string> {
  const asset = getAsset(database, assetId);
  if (!asset) throw runError('ASSET_NOT_FOUND', `执行时 asset ${assetId} 不存在。`);
  return path.join(dataRoot, ...asset.relativePath.split('/'));
}

/**
 * 执行视频理解 run：probe → transcript → keyframes → ocr → align → summarize。
 * 每个 stage 完成后立即提交 checkpoint（增量持久化，失败从已提交 stage 恢复）；
 * 失败 → failed 保留错误；重试新 attempt 复用前一 attempt 已完成 stage 输出。
 */
export async function executeVideoRun(
  database: DatabaseSync,
  runId: string,
  deps: VideoUnderstandingExecutionDeps
): Promise<VideoUnderstandingRunRecord> {
  const run = getVideoRun(database, runId);
  if (!run) throw runError('VIDEO_RUN_NOT_FOUND', `视频理解 run ${runId} 不存在。`);
  if (run.status === 'completed') return run;
  if (run.status !== 'queued') {
    throw runError('VIDEO_RUN_STATUS_INVALID', `run ${runId} 状态为 ${run.status}，只能执行 queued run。`);
  }
  const sourcePath = await requireVideoAssetPath(database, deps.dataRoot, run.assetId);
  const promptVersion = deps.promptVersion ?? run.promptVersion ?? VIDEO_PROMPT_VERSION;

  // 前一 attempt（同一身份，attempt-1）已完成 stage 输出复用（runtime 身份一致才复用）。
  // 注意：getLatestVideoRunForIdentity 会返回当前 run（最新 attempt）本身，必须显式取
  // 前一 attempt 行，否则 checkpoint 恢复永远读不到前一 attempt 的输出。
  const prior = run.attempt > 1
    ? reusablePrior(
        getVideoRunForIdentity(database, {
          sourceId: run.sourceId,
          sourceRevisionKey: run.sourceRevisionKey,
          assetId: run.assetId,
          schemaVersion: run.schemaVersion,
          attempt: run.attempt - 1
        }),
        deps.runtime.identity
      )
    : null;
  // 复用判定以「已持久化且可解析的输出」为准（failVideoRun 的 stage 标签可能指向未
  // checkpoint 成功的 stage，不能作为恢复依据）；resume 从缺失输出的首个 stage 开始。
  let probeJson: string | null = prior?.probeJson ?? null;
  let transcriptJson: string | null = prior?.transcriptJson ?? null;
  let keyframesJson: string | null = prior?.keyframesJson ?? null;
  let segmentsJson: string | null = prior?.segmentsJson ?? null;

  let probe: VideoProbeInfo | null = probeJson ? parseProbeJson({ probeJson }) : null;
  let transcript: VideoTranscriptPayload | null = transcriptJson ? parseTranscriptJson({ transcriptJson }) : null;
  let keyframes: VideoKeyframeRecord[] | null = keyframesJson ? parseKeyframesJson({ keyframesJson }) : null;
  let segments: VideoSegmentRecord[] | null = segmentsJson ? parseSegmentsJson({ segmentsJson }) : null;

  // 只认可解析的输出：解析失败视为未完成（fail-closed），resume 从该 stage 重做。
  const presentIndexes: number[] = [];
  if (probe) presentIndexes.push(stageIndex('probe'));
  if (transcript) presentIndexes.push(stageIndex('transcript'));
  if (keyframes) presentIndexes.push(stageIndex('keyframes'));
  if (segments) presentIndexes.push(stageIndex('align'));
  const resumeFromIndex = presentIndexes.length ? Math.max(...presentIndexes) + 1 : 0;
  // 复用值必须与 resume 语义一致：只复用已解析输出。
  probeJson = probe ? probeJson : null;
  transcriptJson = transcript ? transcriptJson : null;
  keyframesJson = keyframes ? keyframesJson : null;
  segmentsJson = segments ? segmentsJson : null;

  startVideoRun(database, runId, {
    model: deps.model ?? run.model ?? undefined,
    provider: deps.provider ?? run.provider ?? undefined,
    promptVersion,
    runtimeManifestHash: deps.runtime.identity
  });

  // ---- probe（复用或新执行；成功后立即 checkpoint）----
  if (probe === null && stageIndex('probe') >= resumeFromIndex) {
    try {
      probe = await deps.runtime.probe(sourcePath);
      probeJson = JSON.stringify(probe);
      checkpointVideoStage(database, { runId, stage: 'probe', probeJson });
    } catch (error) {
      return failVideoRun(database, runId, {
        stage: 'probe',
        errorCode: errorCodeOf(error, 'PROBE_FAILED'),
        errorMessage: errorMessageOf(error)
      });
    }
  }
  if (!probe) {
    return failVideoRun(database, runId, { stage: 'probe', errorCode: 'PROBE_FAILED', errorMessage: 'probe 数据不可用。' });
  }

  // ---- transcript（原生字幕优先 → ASR 兜底；source=native|asr|none；成功后立即 checkpoint）----
  if (transcript === null && stageIndex('transcript') >= resumeFromIndex) {
    const trackIndex = pickSubtitleTrack(probe, deps.sourceLanguage ?? null);
    if (trackIndex !== null) {
      let native: VideoTranscriptSegment[] = [];
      try {
        native = await deps.runtime.extractSubtitles(sourcePath, trackIndex);
      } catch (error) {
        if (isRuntimeMissing(error)) {
          return failVideoRun(database, runId, { stage: 'transcript', errorCode: 'MEDIA_RUNTIME_MISSING', errorMessage: errorMessageOf(error) });
        }
        native = []; // 字幕提取异常 → 降级（不是失败）
      }
      if (native.length) {
        transcript = Object.freeze({ source: 'native', segments: Object.freeze(native) });
      } else if (probe.hasAudio) {
        try {
          const asrSegments = await deps.runtime.runAsr(sourcePath);
          transcript = Object.freeze({ source: 'asr', segments: Object.freeze(asrSegments) });
        } catch (error) {
          const code = errorCodeOf(error);
          if (code === 'ASR_FAILED' || isRuntimeMissing(error)) {
            return failVideoRun(database, runId, { stage: 'transcript', errorCode: code, errorMessage: errorMessageOf(error) });
          }
          transcript = Object.freeze({ source: 'none', segments: Object.freeze([]) });
        }
      } else {
        transcript = Object.freeze({ source: 'none', segments: Object.freeze([]) });
      }
    } else if (probe.hasAudio) {
      try {
        const asrSegments = await deps.runtime.runAsr(sourcePath);
        transcript = Object.freeze({ source: 'asr', segments: Object.freeze(asrSegments) });
      } catch (error) {
        const code = errorCodeOf(error);
        if (code === 'ASR_FAILED' || isRuntimeMissing(error)) {
          return failVideoRun(database, runId, { stage: 'transcript', errorCode: code, errorMessage: errorMessageOf(error) });
        }
        transcript = Object.freeze({ source: 'none', segments: Object.freeze([]) });
      }
    } else {
      transcript = Object.freeze({ source: 'none', segments: Object.freeze([]) });
    }
    transcriptJson = JSON.stringify(transcript);
    checkpointVideoStage(database, { runId, stage: 'transcript', transcriptJson });
  }
  if (!transcript) transcript = transcriptJson ? parseTranscriptJson({ transcriptJson }) : null;
  if (!transcript) transcript = Object.freeze({ source: 'none', segments: Object.freeze([]) });

  // ---- keyframes（镜头检测 + 10s 兜底 → 抽帧 → 去重 → 上限 48；注册 derived_keyframe；成功后立即 checkpoint）----
  if (keyframes === null && stageIndex('keyframes') >= resumeFromIndex) {
    try {
      let sceneBoundaries: number[] = [];
      try {
        sceneBoundaries = await deps.runtime.detectScenes(sourcePath);
      } catch (error) {
        if (isRuntimeMissing(error)) {
          return failVideoRun(database, runId, { stage: 'keyframes', errorCode: 'MEDIA_RUNTIME_MISSING', errorMessage: errorMessageOf(error) });
        }
        sceneBoundaries = []; // 镜头检测异常 → 纯 10s 兜底，不是失败
      }
      const mergedScenes = mergeSceneBoundaries(sceneBoundaries);
      const fallback = computeFallbackBoundaries(mergedScenes, probe.durationMs);
      const boundaries = [...new Set([...mergedScenes, ...fallback])].sort((left, right) => left - right);
      const times = selectKeyframeTimes(boundaries, transcript.segments, probe.durationMs);

      const frames: VideoKeyframeRecord[] = [];
      for (const timeMs of times) {
        const extraction = await deps.runtime.extractKeyframe(sourcePath, timeMs);
        const staged = await stageAssetBytes(deps.dataRoot, {
          bytes: extraction.bytes,
          fileName: `keyframe-${timeMs}.jpg`,
          mimeType: 'image/jpeg',
          origin: `video-run:${run.id}`,
          width: extraction.width,
          height: extraction.height
        });
        const registered = registerStagedAsset(database, staged);
        insertDerivedKeyframeProvenance(database, {
          sourceAssetId: run.assetId,
          derivedAssetId: registered.id,
          timeMs,
          width: extraction.width,
          height: extraction.height,
          origin: `video-run:${run.id}`,
          requestId: run.id,
          runtimeName: deps.runtime.identity
        });
        frames.push(Object.freeze({
          timeMs,
          width: extraction.width,
          height: extraction.height,
          assetId: registered.id,
          perceptionHash: extraction.phash
        }));
      }
      keyframes = dedupeKeyframesByPhash(frames).slice(0, MAX_KEYFRAMES);
      keyframesJson = JSON.stringify(keyframes);
      checkpointVideoStage(database, { runId, stage: 'keyframes', keyframesJson });
    } catch (error) {
      return failVideoRun(database, runId, {
        stage: 'keyframes',
        errorCode: errorCodeOf(error, 'KEYFRAME_EXTRACTION_FAILED'),
        errorMessage: errorMessageOf(error)
      });
    }
  }
  if (!keyframes) keyframes = keyframesJson ? parseKeyframesJson({ keyframesJson }) : null;
  if (!keyframes) keyframes = [];

  // ---- ocr（transcript 无文本且有关键帧时兜底；OCR 引擎错误只降级为 none，不是失败）----
  if (stageIndex('ocr') >= resumeFromIndex) {
    const hasText = transcript.segments.some((segment) => segment.text.trim().length > 0);
    if (!hasText && keyframes.length) {
      try {
        const ocrSegments: VideoTranscriptSegment[] = [];
        const keyframeTimes = [...keyframes].sort((left, right) => left.timeMs - right.timeMs);
        for (let index = 0; index < keyframeTimes.length; index += 1) {
          const frame = keyframeTimes[index];
          const frameStart = frame.timeMs;
          const frameEnd = index + 1 < keyframeTimes.length ? keyframeTimes[index + 1].timeMs : probe.durationMs;
          const asset = getAsset(database, frame.assetId);
          if (!asset) continue;
          const imagePath = path.join(deps.dataRoot, ...asset.relativePath.split('/'));
          const region = { x: 0, y: 1 - OCR_BOTTOM_RATIO, width: 1, height: OCR_BOTTOM_RATIO };
          let lines: VideoOcrLine[] = [];
          try {
            lines = await deps.runtime.runOcr(imagePath, region);
          } catch {
            lines = []; // OCR 引擎执行错误 → warning 语义，降级继续
          }
          if (!lines.length) {
            try {
              lines = await deps.runtime.runOcr(imagePath, null);
            } catch {
              lines = [];
            }
          }
          for (const line of lines) {
            if (line.confidence < OCR_MIN_CONFIDENCE || !line.text.trim()) continue;
            ocrSegments.push(ocrLineToSegment(line, frameStart, frameEnd));
          }
        }
        if (ocrSegments.length) {
          transcript = Object.freeze({ source: 'ocr', segments: Object.freeze(ocrSegments) });
          transcriptJson = JSON.stringify(transcript);
        }
      } catch {
        // OCR 阶段异常不失败 run：降级为 none（设计 §10.5 OCR 引擎错误只产生 warning）。
        transcript = Object.freeze({ source: 'none', segments: Object.freeze([]) });
        transcriptJson = JSON.stringify(transcript);
      }
    }
    checkpointVideoStage(database, { runId, stage: 'ocr', transcriptJson: transcriptJson ?? JSON.stringify(transcript) });
  }

  // ---- align（确定性对齐；≤64 段；成功后立即 checkpoint）----
  if (segments === null && stageIndex('align') >= resumeFromIndex) {
    segments = alignVideoSegments({
      durationMs: probe.durationMs,
      keyframes,
      transcript: transcript.segments
    });
    segmentsJson = JSON.stringify(segments);
    checkpointVideoStage(database, { runId, stage: 'align', segmentsJson });
  }
  if (!segments) segments = segmentsJson ? parseSegmentsJson({ segmentsJson }) : [];
  if (!segments) segments = [];

  // ---- summarize（单次有界调用；失败只记 warning，不抹掉机械结果；随后 completed）----
  if (stageIndex('summarize') >= resumeFromIndex) {
    let summaryFailed = false;
    let summarized = segments;
    try {
      const results = await deps.summaryCall({
        segments,
        promptVersion,
        model: deps.model ?? run.model ?? null,
        provider: deps.provider ?? run.provider ?? null
      });
      const byIndex = new Map(results.map((result) => [result.index, result]));
      summarized = segments.map((segment) => {
        const result = byIndex.get(segment.index);
        if (!result) return segment;
        const bounded = boundSummary(result.summary);
        return Object.freeze({
          ...segment,
          summary: bounded.summary,
          confidence: result.confidence ?? segment.confidence,
          warnings: bounded.truncated
            ? Object.freeze([...segment.warnings, 'summary_truncated'])
            : segment.warnings
        });
      });
    } catch {
      summaryFailed = true;
      summarized = segments.map((segment) => Object.freeze({
        ...segment,
        warnings: Object.freeze([...segment.warnings, 'summary_failed'])
      }));
    }
    segmentsJson = JSON.stringify(summarized);
    checkpointVideoStage(database, { runId, stage: 'summarize', segmentsJson });
    return completeVideoRun(database, runId, {
      model: deps.model ?? run.model ?? undefined,
      provider: deps.provider ?? run.provider ?? undefined,
      promptVersion,
      runtimeManifestHash: deps.runtime.identity
    });
  }

  // 理论上不可达：resume 语义保证 summarize 总是最后执行；兜底直接完成。
  return completeVideoRun(database, runId, {
    model: deps.model ?? run.model ?? undefined,
    provider: deps.provider ?? run.provider ?? undefined,
    promptVersion,
    runtimeManifestHash: deps.runtime.identity
  });
}

function errorCodeOf(error: unknown, fallback = 'VIDEO_RUN_FAILED'): string {
  const candidate = error as { code?: unknown };
  if (candidate?.code && typeof candidate.code === 'string') return candidate.code;
  return fallback;
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ============================================================
// 只读模型 / locator（复用 store 与 shared；视频 locator 严格解析）
// ============================================================

export { getVideoRun, getVideoRunForIdentity, getLatestVideoRunForIdentity, listVideoRunsForRevision };
export { parseProbeJson, parseTranscriptJson, parseKeyframesJson, parseSegmentsJson };
export type { VideoUnderstandingRunRecord, VideoRunIdentity, VideoProbeInfo, VideoKeyframeRecord, VideoSegmentRecord };
export { VIDEO_TRANSCRIPT_SOURCES };
export type { VideoTranscriptSource, VideoTranscriptSegment };

/**
 * 严格解析视频证据 locator：`asset:<assetId>|sourceRevision:<sourceRevisionKey>|timeRange:<startMs>-<endMs>`。
 * 约束：必须满足 0 ≤ start < end；提供 durationMs 时 end ≤ durationMs（设计 §10.8 严格时间 locator）。
 * 旧图片 locator（asset|sourceRevision 两段）逐字兼容 → 返回 timeRange=null。
 * 非法格式 / region 变体 → null（严格，绝不猜测）。
 */
export function parseVideoEvidenceLocator(
  locator: string,
  durationMs?: number | null
): { assetId: string; sourceRevisionKey: string; timeRange: { startMs: number; endMs: number } | null } | null {
  if (!locator) return null;
  const parts = locator.split('|');
  if (parts.length !== 2 && parts.length !== 3) return null;
  const [left, middle, timePart] = parts;
  const leftColon = left.indexOf(':');
  const middleColon = middle.indexOf(':');
  if (leftColon < 1 || middleColon < 1) return null;
  if (left.slice(0, leftColon) !== 'asset') return null;
  if (middle.slice(0, middleColon) !== 'sourceRevision') return null;
  const assetId = left.slice(leftColon + 1);
  const sourceRevisionKeyValue = middle.slice(middleColon + 1);
  if (!assetId || !sourceRevisionKeyValue) return null;
  if (parts.length === 2) return { assetId, sourceRevisionKey: sourceRevisionKeyValue, timeRange: null };

  const timeColon = timePart.indexOf(':');
  if (timeColon < 1) return null;
  if (timePart.slice(0, timeColon) !== 'timeRange') return null;
  const range = timePart.slice(timeColon + 1);
  const dashIndex = range.indexOf('-');
  if (dashIndex <= 0 || dashIndex >= range.length - 1) return null;
  const startMs = Number(range.slice(0, dashIndex));
  const endMs = Number(range.slice(dashIndex + 1));
  if (!Number.isInteger(startMs) || !Number.isInteger(endMs)) return null;
  if (startMs < 0 || endMs <= startMs) return null;
  if (durationMs !== null && durationMs !== undefined && endMs > durationMs) return null;
  return { assetId, sourceRevisionKey: sourceRevisionKeyValue, timeRange: Object.freeze({ startMs, endMs }) };
}

/** 构造视频证据 locator（严格校验时间范围；与 shared videoEvidenceLocator 同格式）。 */
export function buildVideoEvidenceLocator(
  assetId: string,
  sourceRevisionKeyValue: string,
  startMs: number,
  endMs: number
): string {
  if (!assetId || assetId.includes('|')) throw runError('LOCATOR_INVALID', 'assetId 不能为空且不得包含 "|"。');
  if (!sourceRevisionKeyValue || sourceRevisionKeyValue.includes('|')) {
    throw runError('LOCATOR_INVALID', 'sourceRevisionKey 不能为空且不得包含 "|"。');
  }
  if (!Number.isInteger(startMs) || !Number.isInteger(endMs) || startMs < 0 || endMs <= startMs) {
    throw runError('LOCATOR_INVALID', 'timeRange 必须是整数毫秒且满足 0 ≤ start < end。');
  }
  return `asset:${assetId}|sourceRevision:${sourceRevisionKeyValue}|timeRange:${startMs}-${endMs}`;
}

// 与 shared 的 videoEvidenceLocator 命名兼容（MediaRecommendations/Studio 可用任一）。
export { videoEvidenceLocator } from '../shared/media-candidates.ts';
