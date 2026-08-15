/**
 * WMB-5244：视频时长探测（固定运行时，绝不回退用户 PATH）。
 * Design §8/§10.2：媒体解析固定为静态 CPU 版 FFmpeg/ffprobe（仓库内 .r/media-runtime）；
 * lock 落地（WMB-5245）前，本模块提供确定性内置解析器兜底：
 *   - MP4：流式扫描 moov → mvhd（version 0/1），timescale/duration 均整数毫秒；
 *   - WebM：EBML 顶层解析 Segment → Info → TimecodeScale/Duration。
 * 两个路径都返回 runtimeName/runtimeVersion 记入 attempt，绝不从 PATH 取全局可执行文件。
 */
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { MediaDurationProbeResult } from './media-archive-fetch.ts';

/** 准备运行时根目录（lock 落地后的固定位置；env 覆盖仅测试/本地调试用）。 */
export function mediaRuntimeRoot(): string {
  return process.env.WMB_MEDIA_RUNTIME_ROOT
    ?? path.resolve(process.cwd(), '.r', 'media-runtime');
}

function ffprobeBinary(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'bin', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
}

let cachedVersion: string | null | undefined;

/** 执行 ffprobe 并解析时长（毫秒）。失败返回 null（由内置解析器兜底）。 */
async function probeWithFfprobe(filePath: string, runtimeRoot: string): Promise<MediaDurationProbeResult | null> {
  const binary = ffprobeBinary(runtimeRoot);
  try {
    await stat(binary);
  } catch {
    return null;
  }
  if (cachedVersion === undefined) {
    cachedVersion = await new Promise<string | null>((resolve) => {
      const child = spawn(binary, ['-version'], { windowsHide: true });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
      child.on('error', () => resolve(null));
      child.on('close', () => {
        const first = out.split(/\r?\n/, 1)[0] ?? '';
        resolve(first || null);
      });
    });
  }
  const version = cachedVersion ?? 'ffprobe';
  const durationSeconds = await new Promise<string | null>((resolve) => {
    const child = spawn(binary, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ], { windowsHide: true });
    let out = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0 || !out.trim()) { resolve(null); return; }
      resolve(out.trim().split(/\r?\n/, 1)[0] ?? null);
    });
  });
  if (durationSeconds === null) return null;
  const seconds = Number(durationSeconds);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return { durationMs: Math.round(seconds * 1000), runtimeName: 'ffprobe', runtimeVersion: version };
}

// ============================================================
// MP4 内置解析（moov → mvhd）
// ============================================================

/** 流式扫描定位第一个合法 'moov' box 的 {boxStart, boxSize}。 */
export async function findMp4MoovBox(filePath: string, fileSize: number): Promise<{ boxStart: number; boxSize: number } | null> {
  const chunkSize = 1024 * 1024;
  const overlap = 8;
  let offset = 0;
  let previousTail: Buffer = Buffer.alloc(0);
  const stream = createReadStream(filePath, { start: 0 });
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      const data = offset === 0 ? chunk : Buffer.concat([previousTail, chunk]);
      for (let index = 0; index + 4 <= data.length - 4; index += 1) {
        if (data.toString('latin1', index, index + 4) !== 'moov') continue;
        const boxStart = offset + index - 4;
        if (boxStart < 0) continue;
        // 校验 size 字段（boxStart 处的大端 uint32）。
        if (index < 4) continue; // size 需在 data 内
        const size = data.readUInt32BE(index - 4);
        if (size >= 8 && boxStart + size <= fileSize) {
          return { boxStart, boxSize: size };
        }
      }
      previousTail = data.subarray(Math.max(0, data.length - overlap));
      offset += data.length;
    }
  } finally {
    stream.destroy();
  }
  return null;
}

/** 从 moov box 内容解析 mvhd 时长（毫秒）。输入为 moov box 的完整字节（含自身 header）。 */
export function parseMvhdDurationMs(moovBytes: Buffer): number | null {
  // 若输入以 moov 容器自身开头，先跳过其 8 字节 header，从第一个子 box（通常 mvhd）开始。
  let offset = 0;
  if (moovBytes.length >= 8 && moovBytes.toString('latin1', 4, 8) === 'moov') {
    const containerSize = moovBytes.readUInt32BE(0);
    if (containerSize >= 8 && containerSize <= moovBytes.length) offset = 8;
  }
  while (offset + 8 <= moovBytes.length) {
    const size = moovBytes.readUInt32BE(offset);
    const type = moovBytes.toString('latin1', offset + 4, offset + 8);
    if (size < 8 || offset + size > moovBytes.length) break; // 损坏/不完整
    if (type === 'mvhd') {
      if (size < 32) return null;
      const version = moovBytes[offset + 8];
      if (version === 0) {
        const timescale = moovBytes.readUInt32BE(offset + 20);
        const duration = moovBytes.readUInt32BE(offset + 24);
        if (timescale === 0) return null;
        return Math.round((duration / timescale) * 1000);
      }
      if (version === 1) {
        if (size < 40) return null;
        const timescale = moovBytes.readUInt32BE(offset + 28);
        const durationHi = moovBytes.readUInt32BE(offset + 32);
        const durationLo = moovBytes.readUInt32BE(offset + 36);
        const duration = durationHi * 2 ** 32 + durationLo;
        if (timescale === 0) return null;
        return Math.round((duration / timescale) * 1000);
      }
      return null;
    }
    offset += size;
  }
  return null;
}

async function probeMp4DurationMs(filePath: string): Promise<number | null> {
  const { open } = await import('node:fs/promises');
  const handle = await open(filePath, 'r');
  try {
    const info = await handle.stat();
    const moov = await findMp4MoovBox(filePath, info.size);
    if (!moov) return null;
    const readSize = Math.min(moov.boxSize, 128 * 1024 * 1024);
    const bytes = Buffer.alloc(readSize);
    const { bytesRead } = await handle.read(bytes, 0, readSize, moov.boxStart);
    return parseMvhdDurationMs(bytes.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

// ============================================================
// WebM 内置解析（EBML → Segment → Info）
// ============================================================

function readVint(data: Buffer, offset: number): { value: number; length: number } | null {
  if (offset >= data.length) return null;
  const first = data[offset];
  if (first === 0) return null;
  let length = 1;
  let mask = 0x80;
  while (mask > 0 && (first & mask) === 0) {
    length += 1;
    mask >>= 1;
  }
  if (mask === 0 || length > 8 || offset + length > data.length) return null;
  let value = first & (mask - 1);
  for (let index = 1; index < length; index += 1) {
    value = value * 256 + data[offset + index];
  }
  return { value, length };
}

/** 从 EBML 头部区域解析 Segment → Info → TimecodeScale/Duration → 毫秒。 */
export function parseWebmDurationMs(data: Buffer): number | null {
  // EBML 头 ID（原始字节 0x1A45DFA3；ID 比较一律用原始字节，不做 vint 值解码）
  if (data.length < 4 || data.readUInt32BE(0) !== 0x1a45dfa3) return null;
  let offset = 0;
  // EBML 头
  const headerId = readVint(data, offset);
  if (!headerId) return null;
  offset += headerId.length;
  const headerSize = readVint(data, offset);
  if (!headerSize) return null;
  offset += headerSize.length + headerSize.value;
  if (offset >= data.length) return null;
  // Segment ID（原始字节 0x18538067）
  const segmentId = readVint(data, offset);
  if (!segmentId || segmentId.length !== 4 || data.subarray(offset, offset + 4).toString('hex') !== '18538067') return null;
  offset += segmentId.length;
  const segmentSize = readVint(data, offset);
  if (!segmentSize) return null;
  offset += segmentSize.length;
  const segmentEnd = segmentSize.value === 0xffffffffffffffff
    ? data.length
    : Math.min(offset + segmentSize.value, data.length);
  let timecodeScale = 1_000_000; // 默认 1ms/tick
  let duration: number | null = null;
  while (offset + 2 <= segmentEnd) {
    const id = readVint(data, offset);
    if (!id) break;
    const idHex = data.subarray(offset, offset + id.length).toString('hex');
    offset += id.length;
    const size = readVint(data, offset);
    if (!size) break;
    offset += size.length;
    if (idHex === '1549a966') {
      // Info 元素：解析其子元素（TimecodeScale 0x2AD7B1 / Duration 0x4489）。
      const infoEnd = Math.min(offset + size.value, data.length);
      let infoOffset = offset;
      while (infoOffset + 2 <= infoEnd) {
        const childId = readVint(data, infoOffset);
        if (!childId) break;
        const childIdHex = data.subarray(infoOffset, infoOffset + childId.length).toString('hex');
        infoOffset += childId.length;
        const childSize = readVint(data, infoOffset);
        if (!childSize) break;
        infoOffset += childSize.length;
        if (childSize.value > infoEnd - infoOffset) break;
        if (childIdHex === '2ad7b1') {
          // TimecodeScale（uint）
          if (childSize.value <= 8) {
            let scale = 0;
            for (let index = 0; index < childSize.value; index += 1) {
              scale = scale * 256 + data[infoOffset + index];
            }
            if (scale > 0) timecodeScale = scale;
          }
        } else if (childIdHex === '4489') {
          // Duration（float：4 字节 float / 8 字节 double）
          if (childSize.value === 4) {
            duration = data.readFloatBE(infoOffset);
          } else if (childSize.value === 8) {
            duration = data.readDoubleBE(infoOffset);
          }
        }
        infoOffset += childSize.value;
      }
      break; // Info 通常唯一且靠前
    }
    offset += size.value;
  }
  if (duration === null || !Number.isFinite(duration) || duration < 0) return null;
  return Math.round((duration * timecodeScale) / 1_000_000);
}

async function probeWebmDurationMs(filePath: string): Promise<number | null> {
  // Info 在 Segment 头部附近；读取前 8MB 足够。
  const { open } = await import('node:fs/promises');
  const handle = await open(filePath, 'r');
  try {
    const headSize = 8 * 1024 * 1024;
    const bytes = Buffer.alloc(headSize);
    const { bytesRead } = await handle.read(bytes, 0, headSize, 0);
    return parseWebmDurationMs(bytes.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

// ============================================================
// 统一入口
// ============================================================

/**
 * 探测视频时长（毫秒）。优先仓库内固定 ffprobe；缺失/失败 → 内置确定性解析器；
 * 仍失败 → 抛错（调用方落 needs_user PROBE_FAILED，绝不登记未校验时长 Asset）。
 */
export async function probeMediaDurationMs(
  filePath: string,
  mimeType: string,
  runtimeRoot: string = mediaRuntimeRoot()
): Promise<MediaDurationProbeResult> {
  if (mimeType === 'video/mp4') {
    const viaFfprobe = await probeWithFfprobe(filePath, runtimeRoot);
    if (viaFfprobe) return viaFfprobe;
    const durationMs = await probeMp4DurationMs(filePath);
    if (durationMs !== null) {
      return { durationMs, runtimeName: 'wmb-mp4-mvhd', runtimeVersion: '1' };
    }
    throw new Error('MP4 时长探测失败（无 ffprobe 且 mvhd 不可解析）。');
  }
  if (mimeType === 'video/webm') {
    const viaFfprobe = await probeWithFfprobe(filePath, runtimeRoot);
    if (viaFfprobe) return viaFfprobe;
    const durationMs = await probeWebmDurationMs(filePath);
    if (durationMs !== null) {
      return { durationMs, runtimeName: 'wmb-webm-ebml', runtimeVersion: '1' };
    }
    throw new Error('WebM 时长探测失败（无 ffprobe 且 EBML Info 不可解析）。');
  }
  throw new Error(`不支持的视频 MIME：${mimeType}`);
}
