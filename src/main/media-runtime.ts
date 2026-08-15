/**
 * src/main/media-runtime.ts
 *
 * Frozen Windows x64 CPU media runtime locator / assertion (WMB-5245).
 *
 * The runtime is prepared from `media-runtime.lock.json` (repo-root machine
 * SSOT: immutable URLs, versions, SHA-256, sizes, licenses) by
 * `scripts/prepare-media-runtime.mjs` into `.r/media-runtime/` (dev) or
 * `resources/.r/media-runtime/` (packaged). This module:
 *
 *  - resolves the runtime root WITHOUT any PATH fallback (only the prepared
 *    root is ever consulted; bare binary names are never used),
 *  - verifies the prepared lock marker and every locked file's SHA-256,
 *  - asserts availability with stable codes (`MEDIA_RUNTIME_MISSING`,
 *    `MEDIA_RUNTIME_HASH_MISMATCH`, ...) so the video pipeline can fail a run
 *    deterministically while the image-only app stays launchable,
 *  - spawns the frozen executables through one narrow command runner.
 *
 * Image-only flows never import/consult this module — the runtime is only
 * touched by media-understanding code paths.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';

/** Stable machine codes — same strings as scripts/prepare-media-runtime.mjs. */
export const MEDIA_RUNTIME_CODES = {
  MEDIA_RUNTIME_LOCK_MISSING: 'MEDIA_RUNTIME_LOCK_MISSING',
  MEDIA_RUNTIME_LOCK_MISMATCH: 'MEDIA_RUNTIME_LOCK_MISMATCH',
  MEDIA_RUNTIME_MISSING: 'MEDIA_RUNTIME_MISSING',
  MEDIA_RUNTIME_HASH_MISMATCH: 'MEDIA_RUNTIME_HASH_MISMATCH',
  MEDIA_RUNTIME_PLATFORM_MISMATCH: 'MEDIA_RUNTIME_PLATFORM_MISMATCH'
} as const;
export type MediaRuntimeCode = (typeof MEDIA_RUNTIME_CODES)[keyof typeof MEDIA_RUNTIME_CODES];

export class MediaRuntimeError extends Error {
  readonly code: MediaRuntimeCode;
  constructor(code: MediaRuntimeCode, message: string) {
    super(message);
    this.name = 'MediaRuntimeError';
    this.code = code;
  }
}

export function isMediaRuntimeError(error: unknown): error is MediaRuntimeError {
  return error instanceof MediaRuntimeError;
}

export function mediaRuntimeErrorCode(error: unknown): MediaRuntimeCode | null {
  return isMediaRuntimeError(error) ? error.code : null;
}

/** Paths of every frozen runtime file under the root (executables + data). */
export type MediaRuntimeBinPaths = {
  ffmpeg: string;
  ffprobe: string;
  whisperCli: string;
  whisperModel: string;
  tesseract: string;
  tessdata: string;
};

/** Executable bins the command runner may spawn. */
export type MediaRuntimeExecutable = 'ffmpeg' | 'ffprobe' | 'whisperCli' | 'tesseract';

type MediaRuntimeLockFile = { to: string; sha256: string };
type MediaRuntimeLockComponent = { id: string; kind: string; version: string; files: MediaRuntimeLockFile[] };
type MediaRuntimeLock = {
  schemaVersion: number;
  platform: string;
  components: MediaRuntimeLockComponent[];
};

export type MediaRuntimeProbe = {
  available: boolean;
  /** Stable code when not available, else null. */
  code: MediaRuntimeCode | null;
  root: string;
  lockSha256: string | null;
  /** Relative (locked `to`) paths that are missing. */
  missing: string[];
  /** Relative (locked `to`) paths whose bytes mismatch the lock. */
  hashMismatch: string[];
  /** Component id → version from the lock. */
  versions: Record<string, string>;
  /** Version probe output (only when options.versions is true). */
  probeOutput: Record<string, string | null> | null;
};

export type AssertedMediaRuntime = {
  root: string;
  lockSha256: string;
  versions: Record<string, string>;
  binPaths: MediaRuntimeBinPaths;
};

export type MediaRuntimeCommandResult = {
  stdout: string;
  stderr: string;
  status: number | null;
};

function sha256Buffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    // No encoding is configured on the read stream, so chunks are Buffers and
    // hashing is byte-exact; the string branch stays explicit so a future
    // encoding cannot silently change the digest.
    stream.on('data', (chunk: string | Buffer) => {
      if (typeof chunk === 'string') hash.update(chunk, 'utf8');
      else hash.update(chunk);
    });
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Runtime root resolution. Packaged: resources/.r/media-runtime (Forge
 * extraResource copies `.r` verbatim). Dev: <cwd>/.r/media-runtime. Tests may
 * override with WMB_MEDIA_RUNTIME_ROOT. Never falls back to PATH.
 */
export function resolveMediaRuntimeRoot(): string {
  const override = process.env.WMB_MEDIA_RUNTIME_ROOT;
  if (override) return path.resolve(override);
  try {
    const electron = createRequire(import.meta.url)('electron') as { app?: { isPackaged?: boolean } };
    if (electron.app?.isPackaged) return path.join(process.resourcesPath, '.r', 'media-runtime');
  } catch {
    // Not running inside Electron (tests / scripts) — dev layout below.
  }
  return path.join(process.cwd(), '.r', 'media-runtime');
}

export async function readMediaRuntimeLock(root = resolveMediaRuntimeRoot()): Promise<MediaRuntimeLock | null> {
  try {
    return JSON.parse(await readFile(path.join(root, 'lock.json'), 'utf8')) as MediaRuntimeLock;
  } catch {
    return null;
  }
}

export function lockSha256Of(lock: MediaRuntimeLock): string {
  // Canonical form shared with scripts/prepare-media-runtime.mjs — the
  // prepared-lock marker (lock.sha256) is this hash, so the runtime module
  // must reproduce it byte-for-byte.
  return sha256Buffer(Buffer.from(JSON.stringify(lock, null, 2) + '\n', 'utf8'));
}

async function readMarker(root: string): Promise<string | null> {
  try {
    return (await readFile(path.join(root, 'lock.sha256'), 'utf8')).trim();
  } catch {
    return null;
  }
}

/**
 * Absolute paths of every frozen bin under the root, or null when the runtime
 * is not prepared (lock absent). Resolution is root-only; PATH is never read.
 * Slot lookup matches the frozen exe name (`ffmpeg.exe` …) or a test fixture
 * `.cmd` twin, whichever the lock pins.
 */
export async function mediaRuntimeBinPaths(root = resolveMediaRuntimeRoot()): Promise<MediaRuntimeBinPaths | null> {
  const lock = await readMediaRuntimeLock(root);
  if (!lock) return null;
  const slotFile = (componentId: string, name: string): string | null => {
    const component = lock.components.find((c) => c.id === componentId);
    if (!component) return null;
    const file = component.files.find((f) => path.basename(f.to).replace(/\.[^.]+$/, '').toLowerCase() === name.toLowerCase());
    return file ? path.join(root, file.to) : null;
  };
  const ffmpeg = slotFile('ffmpeg', 'ffmpeg');
  const ffprobe = slotFile('ffmpeg', 'ffprobe');
  const whisperCli = slotFile('whisper-cli', 'whisper-cli');
  const whisperModel = slotFile('whisper-small-model', 'ggml-small');
  const tesseract = slotFile('tesseract', 'tesseract');
  const tessdataEng = lock.components.find((c) => c.id === 'tessdata-eng')?.files[0];
  const tessdata = tessdataEng ? path.join(root, path.dirname(tessdataEng.to)) : null;
  if (!ffmpeg || !ffprobe || !whisperCli || !whisperModel || !tesseract || !tessdata) return null;
  return { ffmpeg, ffprobe, whisperCli, whisperModel, tesseract, tessdata };
}

/**
 * Full integrity probe: lock marker + every locked file's SHA-256. Optional
 * live version execution (ffprobe -version / whisper-cli --help /
 * tesseract --version) — used by packaging gates and diagnostics.
 */
export async function probeMediaRuntime(
  options: { versions?: boolean; timeoutMs?: number; probeShell?: boolean } = {}
): Promise<MediaRuntimeProbe> {
  const root = resolveMediaRuntimeRoot();
  const lock = await readMediaRuntimeLock(root);
  if (!lock) {
    return {
      available: false,
      code: existsSync(root) ? MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_LOCK_MISMATCH : MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_MISSING,
      root,
      lockSha256: null,
      missing: [],
      hashMismatch: [],
      versions: {},
      probeOutput: null
    };
  }
  const lockSha256 = lockSha256Of(lock);
  const marker = await readMarker(root);
  if (!marker || marker !== lockSha256) {
    return {
      available: false,
      code: MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_LOCK_MISMATCH,
      root,
      lockSha256,
      missing: [],
      hashMismatch: [],
      versions: componentVersions(lock),
      probeOutput: null
    };
  }
  const missing: string[] = [];
  const hashMismatch: string[] = [];
  for (const component of lock.components) {
    for (const file of component.files) {
      const target = path.join(root, file.to);
      if (!existsSync(target)) { missing.push(file.to); continue; }
      let actual: string;
      try {
        actual = await sha256File(target);
      } catch {
        missing.push(file.to);
        continue;
      }
      if (actual !== file.sha256) hashMismatch.push(file.to);
    }
  }
  const available = missing.length === 0 && hashMismatch.length === 0;
  let probeOutput: Record<string, string | null> | null = null;
  if (options.versions && available) {
    probeOutput = await probeVersions(lock, root, options.timeoutMs ?? 30_000, options.probeShell === true);
  }
  return {
    available,
    code: available ? null : missing.length > 0 ? MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_MISSING : MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_HASH_MISMATCH,
    root,
    lockSha256,
    missing,
    hashMismatch,
    versions: componentVersions(lock),
    probeOutput
  };
}

function componentVersions(lock: MediaRuntimeLock): Record<string, string> {
  return Object.fromEntries(lock.components.map((c) => [c.id, c.version]));
}

async function probeVersions(lock: MediaRuntimeLock, root: string, timeoutMs: number, shell: boolean): Promise<Record<string, string | null>> {
  const probes: Array<{ id: string; rel: string; args: string[]; env?: NodeJS.ProcessEnv }> = [
    { id: 'ffprobe', rel: 'ffmpeg/bin/ffprobe.exe', args: ['-version'] },
    { id: 'whisper-cli', rel: 'whisper/bin/whisper-cli.exe', args: ['--help'] },
    { id: 'tesseract', rel: 'tesseract/bin/tesseract.exe', args: ['--version'], env: { TESSDATA_PREFIX: path.join(root, 'tesseract', 'tessdata') } }
  ];
  const result: Record<string, string | null> = {};
  const bins = await mediaRuntimeBinPaths(root);
  const slotOf = (id: string): string | null => (id === 'ffprobe' ? bins?.ffprobe : id === 'whisper-cli' ? bins?.whisperCli : bins?.tesseract) ?? null;
  for (const probe of probes) {
    const slot = slotOf(probe.id);
    if (!slot) { result[probe.id] = null; continue; }
    try {
      const run = await runAbsoluteExecutable(slot, probe.args, {
        timeoutMs,
        env: probe.env,
        capture: true,
        shell
      });
      result[probe.id] = run.status === 0 ? `${run.stdout}${run.stderr}`.split(/\r?\n/)[0]?.slice(0, 200) ?? '' : null;
    } catch {
      result[probe.id] = null;
    }
  }
  return result;
}

/** Spawns an absolute executable (optionally via shell for .cmd test fixtures), capturing output. */
export function runAbsoluteExecutable(
  executable: string,
  args: string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv; capture?: boolean; shell?: boolean } = {}
): Promise<MediaRuntimeCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      shell: options.shell ?? false,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      env: { ...process.env, ...options.env }
    });
    let stdout = '';
    let stderr = '';
    if (options.capture) {
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    }
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`命令超时: ${path.basename(executable)} ${args.join(' ')}`));
    }, options.timeoutMs ?? 120_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, status });
    });
  });
}

/**
 * Assert the frozen runtime is fully present and byte-identical to the lock.
 * Throws MediaRuntimeError with a stable code otherwise. Never touches PATH.
 */
export async function assertMediaRuntime(options: { versions?: boolean } = {}): Promise<AssertedMediaRuntime> {
  const probe = await probeMediaRuntime(options);
  if (!probe.available) {
    throw new MediaRuntimeError(probe.code ?? MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_MISSING, `媒体运行时不可用: ${probe.code}`);
  }
  const binPaths = await mediaRuntimeBinPaths(probe.root);
  if (!binPaths) {
    throw new MediaRuntimeError(MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_MISSING, '媒体运行时二进制缺失');
  }
  return {
    root: probe.root,
    lockSha256: probe.lockSha256 ?? '',
    versions: probe.versions,
    binPaths
  };
}

/**
 * Narrow command runner for the frozen executables. Resolves the binary from
 * the prepared root only and spawns without a shell, so a missing runtime or a
 * corrupted install fails with stable codes and never falls back to a global
 * PATH binary. `shell: true` is reserved for test fixtures (.cmd fakes) and
 * must not be used in production call sites.
 */
export async function runMediaRuntimeCommand(
  bin: MediaRuntimeExecutable,
  args: string[],
  options: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv; shell?: boolean; input?: string } = {}
): Promise<MediaRuntimeCommandResult> {
  const binPaths = await mediaRuntimeBinPaths();
  if (!binPaths) {
    throw new MediaRuntimeError(MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_MISSING, '媒体运行时未准备（.r/media-runtime 缺失）');
  }
  const executable = binPaths[bin];
  if (!existsSync(executable)) {
    throw new MediaRuntimeError(MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_MISSING, `媒体运行时缺少 ${path.basename(executable)}`);
  }
  const result = await runAbsoluteExecutable(executable, args, {
    timeoutMs: options.timeoutMs,
    env: options.env,
    capture: true,
    shell: options.shell
  });
  if (result.status !== 0) {
    const detail = `${result.stderr}${result.stdout}`.trim().slice(0, 800);
    throw new Error(`${path.basename(executable)} ${args.join(' ')} 退出码 ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

/**
 * Environment block for spawning tesseract with the frozen tessdata dir, so
 * OCR never consults an installed/registry tessdata.
 */
export async function tesseractEnv(): Promise<NodeJS.ProcessEnv> {
  const binPaths = await mediaRuntimeBinPaths();
  if (!binPaths) throw new MediaRuntimeError(MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_MISSING, '媒体运行时未准备');
  return { ...process.env, TESSDATA_PREFIX: binPaths.tessdata };
}

/**
 * Component version lookup for provenance records (runtime_name/runtime_version
 * columns). Returns null when the runtime is not prepared.
 */
export async function mediaRuntimeComponentVersion(componentId: string, root = resolveMediaRuntimeRoot()): Promise<string | null> {
  const lock = await readMediaRuntimeLock(root);
  return lock?.components.find((c) => c.id === componentId)?.version ?? null;
}

/**
 * Stable hash for video run `runtime_manifest_hash` records: sha256 of the
 * prepared lock bytes, or null when the runtime is not prepared.
 */
export async function mediaRuntimeManifestHash(root = resolveMediaRuntimeRoot()): Promise<string | null> {
  const lock = await readMediaRuntimeLock(root);
  if (!lock) return null;
  const marker = await readMarker(root);
  if (!marker) return null;
  return marker;
}

// ===========================================================================
// WMB-5246：派生物化执行面（Data agent 所有；复用上面的定位/门禁原语）。
// Clip/标注派生需要拿到非零退出结果做 copy→转码回退决策，因此经 runAbsoluteExecutable
// 原始结果路径（不走 runMediaRuntimeCommand 的抛错语义）；二进制仍只来自受管根目录，
// 绝不回退 PATH。resolveMediaRuntime 缺失时抛 MEDIA_RUNTIME_MISSING。
// ===========================================================================

export const MEDIA_RUNTIME_MISSING: MediaRuntimeCode = MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_MISSING;

/** lock 的宽松只读视图（派生血缘所需字段；真实形状见私有 MediaRuntimeLock）。 */
export type MediaRuntimeManifest = {
  schemaVersion?: number;
  platform?: string;
  components?: ReadonlyArray<{ id: string; version: string; kind?: string; files?: unknown }>;
};

export type MediaRuntimeInfo = {
  rootDir: string;
  ffmpegPath: string;
  ffprobePath: string;
  manifest: MediaRuntimeManifest | null;
  /** 运行时身份键：lock ffmpeg 组件版本优先，缺失时目录名兜底（仍只来自受管目录）。 */
  identity: string;
};

export type MediaCommandResult = { code: number; stdout: string; stderr: string };

export type MediaExecutor = {
  ffprobe(args: readonly string[]): Promise<MediaCommandResult>;
  ffmpeg(args: readonly string[]): Promise<MediaCommandResult>;
};

/** lock 中 ffmpeg 组件版本（派生血缘 runtime_version 用）；无 lock/无组件返回 null。 */
export function mediaRuntimeVersion(manifest: MediaRuntimeManifest | null): string | null {
  return manifest?.components?.find((component) => component.id === 'ffmpeg')?.version ?? null;
}

/** 解析受管运行时（仅 .r/media-runtime 定位 + lock 完整性门禁；缺失抛 MEDIA_RUNTIME_MISSING）。 */
export async function resolveMediaRuntime(options: { runtimeDir?: string } = {}): Promise<MediaRuntimeInfo> {
  const rootDir = options.runtimeDir ? path.resolve(options.runtimeDir) : resolveMediaRuntimeRoot();
  const binPaths = await mediaRuntimeBinPaths(rootDir);
  if (!binPaths) {
    throw new MediaRuntimeError(MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_MISSING, '媒体运行时不可用（.r/media-runtime 未就绪，且不回退系统 PATH）。');
  }
  const lock = await readMediaRuntimeLock(rootDir);
  const manifest = lock as MediaRuntimeManifest | null;
  return {
    rootDir,
    ffmpegPath: binPaths.ffmpeg,
    ffprobePath: binPaths.ffprobe,
    manifest,
    identity: mediaRuntimeVersion(manifest) ?? path.basename(rootDir)
  };
}

/** 由已解析运行时构造执行器（非零退出不抛错，返回 code 供调用方做 copy→转码回退）。 */
export function createMediaExecutor(runtime: MediaRuntimeInfo): MediaExecutor {
  const run = (executable: string, args: readonly string[], timeoutMs: number): Promise<MediaCommandResult> =>
    runAbsoluteExecutable(executable, [...args], { capture: true, timeoutMs }).then(
      (result) => ({ code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }),
      (error: unknown) => {
        throw new MediaRuntimeError(MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_MISSING, `媒体运行时执行失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    );
  return {
    ffprobe: (args) => run(runtime.ffprobePath, args, 60_000),
    ffmpeg: (args) => run(runtime.ffmpegPath, args, 15 * 60_000)
  };
}
