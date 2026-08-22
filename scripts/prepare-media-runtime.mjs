#!/usr/bin/env node
/**
 * scripts/prepare-media-runtime.mjs
 *
 * Immutable lock-driven media runtime preparation (WMB-5245).
 *
 * Reads `media-runtime.lock.json` (repo-root machine SSOT: exact immutable URLs,
 * versions, SHA-256, sizes, licenses) and prepares a frozen Windows x64 CPU
 * media runtime into `.r/media-runtime/` (override with --root or
 * WMB_MEDIA_RUNTIME_ROOT):
 *
 *   .r/media-runtime/
 *     lock.json       byte-exact copy of the lock (packaged with the app)
 *     lock.sha256     SHA-256 of lock.json bytes (prepared-lock marker)
 *     manifest.json   preparedAt + per-component versions + file counts
 *     ffmpeg/bin/ffmpeg.exe, ffprobe.exe
 *     whisper/bin/whisper-cli.exe + ggml-*.dll
 *     whisper/models/ggml-small.bin
 *     tesseract/bin/tesseract.exe + *.dll
 *     tesseract/tessdata/eng.traineddata, chi_sim.traineddata
 *
 * Contract:
 *  - No mutable `latest` URLs: every URL is version/commit pinned in the lock.
 *  - No PATH fallback: the app never searches PATH for these binaries.
 *  - Missing or hash-wrong runtime fails the build with a stable exit code.
 *  - Large binaries are never committed to git; preparation downloads and
 *    verifies frozen artifacts (file:// mirrors are supported for air-gapped
 *    builds and tests).
 *
 * Stable exit codes (see MEDIA_RUNTIME_EXIT):
 *   0 OK, 2 LOCK_MISSING, 3 LOCK_INVALID, 4 HASH_MISMATCH,
 *   5 DOWNLOAD_FAILED, 6 INSTALL_FAILED, 7 INCOMPLETE, 8 PLATFORM_MISMATCH,
 *   9 USAGE.
 *
 * Usage:
 *   node scripts/prepare-media-runtime.mjs [--lock <path>] [--root <dir>]
 *       [--mirror-dir <dir>] [--verify-only] [--quiet]
 *
 * Offline / weak-network builds:
 *   --mirror-dir <dir>（或 WMB_MEDIA_RUNTIME_MIRROR）：目录内与 lock 工件同名且
 *   SHA-256 一致的文件直接复用，否则按 lock URL 下载。lock 对象不变，
 *   lock.sha256 marker 始终为 canonical 值。
 *   下载走系统代理：设置 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY 即自动生效。
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MEDIA_RUNTIME_EXIT = Object.freeze({
  OK: 0,
  MISSING: 1,
  LOCK_MISSING: 2,
  LOCK_INVALID: 3,
  HASH_MISMATCH: 4,
  DOWNLOAD_FAILED: 5,
  INSTALL_FAILED: 6,
  INCOMPLETE: 7,
  PLATFORM_MISMATCH: 8,
  USAGE: 9,
  LOCK_MISMATCH: 10
});

/** Stable machine codes — the same strings are the app-side contract in src/main/media-runtime.ts. */
export const MEDIA_RUNTIME_CODES = Object.freeze({
  MEDIA_RUNTIME_LOCK_MISSING: 'MEDIA_RUNTIME_LOCK_MISSING',
  MEDIA_RUNTIME_LOCK_INVALID: 'MEDIA_RUNTIME_LOCK_INVALID',
  MEDIA_RUNTIME_LOCK_MISMATCH: 'MEDIA_RUNTIME_LOCK_MISMATCH',
  MEDIA_RUNTIME_PLATFORM_MISMATCH: 'MEDIA_RUNTIME_PLATFORM_MISMATCH',
  MEDIA_RUNTIME_HASH_MISMATCH: 'MEDIA_RUNTIME_HASH_MISMATCH',
  MEDIA_RUNTIME_DOWNLOAD_FAILED: 'MEDIA_RUNTIME_DOWNLOAD_FAILED',
  MEDIA_RUNTIME_INSTALL_FAILED: 'MEDIA_RUNTIME_INSTALL_FAILED',
  MEDIA_RUNTIME_INCOMPLETE: 'MEDIA_RUNTIME_INCOMPLETE',
  MEDIA_RUNTIME_MISSING: 'MEDIA_RUNTIME_MISSING'
});

export const MEDIA_RUNTIME_KINDS = Object.freeze(['file', 'zip', 'nsis']);

export class MediaRuntimePrepareError extends Error {
  /** @type {string} stable code from MEDIA_RUNTIME_CODES */
  code;
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'MediaRuntimePrepareError';
    this.code = code;
  }
}

const noop = () => {};

export function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Canonical lock serialization shared by prepare, the packaging gate and the
 * app-side module: JSON.stringify(lock, null, 2) + "\n". The repo lock file
 * MUST be written in exactly this form so the marker hash is reproducible.
 * @param {unknown} lock
 * @returns {string}
 */
export function canonicalLockBytes(lock) {
  return JSON.stringify(lock, null, 2) + '\n';
}

/**
 * SHA-256 of the canonical lock serialization — the prepared-lock marker and
 * runtime_manifest_hash contract.
 * @param {unknown} lock
 * @returns {string}
 */
export function lockSha256Of(lock) {
  return sha256Text(canonicalLockBytes(lock));
}

export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Structural lock validation. Returns an array of human-readable problems
 * (empty when the lock is valid).
 * @param {unknown} lock
 * @returns {string[]}
 */
export function validateLock(lock) {
  const errors = [];
  if (!lock || typeof lock !== 'object') return ['lock 不是对象'];
  const record = lock;
  if (record.schemaVersion !== 1) errors.push(`schemaVersion 必须为 1，实际 ${String(record.schemaVersion)}`);
  if (typeof record.platform !== 'string' || !record.platform) errors.push('platform 缺失');
  if (!Array.isArray(record.components) || record.components.length === 0) errors.push('components 必须为非空数组');
  const seen = new Set();
  for (const component of record.components ?? []) {
    if (!component || typeof component !== 'object') { errors.push('存在非法 component'); continue; }
    if (typeof component.id !== 'string' || !component.id) errors.push('component.id 缺失');
    else if (seen.has(component.id)) errors.push(`component.id 重复: ${component.id}`);
    else seen.add(component.id);
    if (typeof component.kind !== 'string' || !MEDIA_RUNTIME_KINDS.includes(component.kind)) {
      errors.push(`${component.id ?? '?'}: kind 必须是 ${MEDIA_RUNTIME_KINDS.join('/')}`);
    }
    if (typeof component.url !== 'string' || !/^(https?|file):/.test(component.url)) {
      errors.push(`${component.id ?? '?'}: url 必须为 http(s):// 或 file://`);
    }
    if (!/^[0-9a-f]{64}$/.test(String(component.sha256 ?? ''))) errors.push(`${component.id ?? '?'}: sha256 缺失或非法`);
    if (!Number.isInteger(component.size) || component.size <= 0) errors.push(`${component.id ?? '?'}: size 缺失`);
    if (typeof component.version !== 'string' || !component.version) errors.push(`${component.id ?? '?'}: version 缺失`);
    if (typeof component.license !== 'string' || !component.license) errors.push(`${component.id ?? '?'}: license 缺失`);
    if (!Array.isArray(component.files) || component.files.length === 0) errors.push(`${component.id ?? '?'}: files 缺失`);
    if (component.kind === 'file' && Array.isArray(component.files) && component.files.length !== 1) {
      errors.push(`${component.id ?? '?'}: kind=file 必须且只能声明 1 个文件`);
    }
    const targetSeen = new Set();
    for (const file of component.files ?? []) {
      if (!file || typeof file !== 'object') { errors.push(`${component.id ?? '?'}: 存在非法 file`); continue; }
      if (typeof file.to !== 'string' || !file.to || path.isAbsolute(file.to)) errors.push(`${component.id ?? '?'}: file.to 必须为相对路径`);
      else if (targetSeen.has(file.to)) errors.push(`${component.id ?? '?'}: file.to 重复 ${file.to}`);
      else targetSeen.add(file.to);
      if (!/^[0-9a-f]{64}$/.test(String(file.sha256 ?? ''))) errors.push(`${component.id ?? '?'}: file ${file.to ?? '?'} sha256 缺失或非法`);
      if (!Number.isInteger(file.size) || file.size <= 0) errors.push(`${component.id ?? '?'}: file ${file.to ?? '?'} size 缺失`);
    }
  }
  return errors;
}

/**
 * Minimal pure-Node zip index reader (local headers + central directory).
 * Supports stored (0) and deflated (8) entries, which covers every artifact
 * frozen in media-runtime.lock.json. Deterministic and dependency-free so the
 * build gate never depends on 7-Zip/tar being installed.
 * @param {Buffer} buffer
 * @returns {Map<string, {method: number, compSize: number, uncompSize: number, localOffset: number}>}
 */
export function readZipIndex(buffer) {
  let eocd = -1;
  const searchStart = Math.max(0, buffer.length - 22 - 65536);
  for (let i = buffer.length - 22; i >= searchStart; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new MediaRuntimePrepareError(MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_LOCK_INVALID, 'zip: 未找到 EOCD 记录');
  const count = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== 0x02014b50) {
      throw new MediaRuntimePrepareError(MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_LOCK_INVALID, 'zip: 中央目录损坏');
    }
    const method = buffer.readUInt16LE(p + 10);
    const compSize = buffer.readUInt32LE(p + 20);
    const uncompSize = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, compSize, uncompSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Extracts one zip entry's data as a Buffer.
 * @param {Buffer} buffer
 * @param {{method: number, compSize: number, uncompSize: number, localOffset: number}} entry
 * @returns {Buffer}
 */
export function extractZipEntry(buffer, entry) {
  if (entry.localOffset + 30 > buffer.length || buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) {
    throw new MediaRuntimePrepareError(MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_LOCK_INVALID, 'zip: 本地文件头损坏');
  }
  const nameLen = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLen = buffer.readUInt16LE(entry.localOffset + 28);
  const dataStart = entry.localOffset + 30 + nameLen + extraLen;
  if (dataStart + entry.compSize > buffer.length) {
    throw new MediaRuntimePrepareError(MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_LOCK_INVALID, 'zip: 条目数据越界');
  }
  const data = buffer.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) {
    return inflateRawSync(data, { maxOutputLength: entry.uncompSize + 1 });
  }
  throw new MediaRuntimePrepareError(MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_LOCK_INVALID, `zip: 不支持的压缩方法 ${entry.method}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Downloads one artifact. Supports http(s) (redirects, timeout, retries, and
 * HTTP(S)_PROXY / ALL_PROXY via undici EnvHttpProxyAgent when the environment
 * declares a proxy) and file:// (local mirror / air-gapped builds / tests).
 * No mutable URLs are ever resolved here.
 * @param {string} url
 * @param {string} dest
 * @param {{timeoutMs?: number, retries?: number, logger?: (msg: string) => void}} [options]
 */
export async function downloadToFile(url, dest, { timeoutMs = 600_000, retries = 2, logger = noop } = {}) {
  if (url.startsWith('file:')) {
    await copyFile(fileURLToPath(url), dest);
    return;
  }
  let dispatcher;
  const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy ?? process.env.ALL_PROXY ?? process.env.all_proxy;
  if (proxyUrl) {
    try {
      const { EnvHttpProxyAgent } = await import('undici');
      dispatcher = new EnvHttpProxyAgent();
      logger(`[media-runtime] 使用代理 ${proxyUrl}（HTTPS_PROXY/HTTP_PROXY/ALL_PROXY）`);
    } catch {
      logger('[media-runtime] 检测到代理环境变量但 undici 不可用，按直连尝试');
    }
  }
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: 'follow', ...(dispatcher ? { dispatcher } : {}) });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      if (!response.body) throw new Error('响应无 body');
      await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
      return;
    } catch (error) {
      lastError = error;
      await rm(dest, { force: true }).catch(() => {});
      if (attempt < retries) {
        logger(`[media-runtime] 下载失败(${attempt + 1}/${retries + 1}) ${url}: ${error instanceof Error ? error.message : String(error)}`);
        await sleep(1000 * (attempt + 1));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new MediaRuntimePrepareError(
    MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_DOWNLOAD_FAILED,
    `下载失败: ${url} — ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

/** Locates 7-Zip (NSIS extraction fallback). Build-time tooling only — the app never uses PATH for runtime binaries. */
export function findSevenZip() {
  for (const candidate of ['7z.exe', '7za.exe']) {
    try {
      const probe = spawnSync(candidate, ['i'], { windowsHide: true, timeout: 10_000 });
      if (!probe.error && probe.status === 0) return candidate;
    } catch {}
  }
  for (const envName of ['ProgramFiles', 'ProgramFiles(x86)']) {
    const root = process.env[envName];
    if (!root) continue;
    const candidate = path.join(root, '7-Zip', '7z.exe');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Default NSIS silent install (tesseract). /D must be the final argument.
 * UB-Mannheim builds declare `highestAvailable`, so on an unelevated admin
 * session the silent run waits on a UAC consent prompt. When the install
 * cannot be executed at all (EACCES/ENOENT/EFTYPE), fall back to 7-Zip NSIS
 * payload extraction — no execution, no elevation, fully deterministic.
 */
export function defaultInstaller(installerPath, installArgs, installDir) {
  const args = [...installArgs, `/D=${installDir}`];
  const result = spawnSync(installerPath, args, {
    windowsHide: true,
    stdio: 'inherit',
    timeout: 300_000
  });
  if (!result.error && result.status === 0) return;
  const sevenZip = findSevenZip();
  if (sevenZip) {
    const extract = spawnSync(sevenZip, ['x', '-y', `-o${installDir}`, installerPath], {
      windowsHide: true,
      stdio: 'inherit',
      timeout: 300_000
    });
    if (!extract.error && extract.status === 0) return;
  }
  const reason = result.error ? result.error.message : `退出码 ${result.status}`;
  throw new MediaRuntimePrepareError(
    MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_INSTALL_FAILED,
    `安装器执行失败（${reason}）。若安装器需要 UAC 提权，请以管理员身份运行构建，或安装 7-Zip 以启用无执行解包回退。`
  );
}

async function writeVerifiedFile(component, file, data, root) {
  const target = path.join(root, file.to);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, data);
  const actual = await sha256File(target);
  if (actual !== file.sha256) {
    throw new MediaRuntimePrepareError(
      MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_HASH_MISMATCH,
      `${component.id}: ${file.to} SHA-256 不符 expected=${file.sha256} actual=${actual}`
    );
  }
}

/**
 * Verifies an already-prepared runtime root against the lock. Does not touch
 * the root. Returns per-file missing / hash-mismatch lists.
 * @param {string} root
 * @param {unknown} lock
 * @returns {Promise<{ok: boolean, missing: string[], hashMismatch: string[]}>}
 */
export async function verifyPreparedRuntime(root, lock) {
  const missing = [];
  const hashMismatch = [];
  for (const component of lock.components) {
    for (const file of component.files) {
      const target = path.join(root, file.to);
      if (!existsSync(target)) { missing.push(`${component.id}:${file.to}`); continue; }
      let actual;
      try { actual = await sha256File(target); } catch { missing.push(`${component.id}:${file.to}`); continue; }
      if (actual !== file.sha256) hashMismatch.push(`${component.id}:${file.to}`);
    }
  }
  return { ok: missing.length === 0 && hashMismatch.length === 0, missing, hashMismatch };
}

async function readMarker(root) {
  try {
    return (await readFile(path.join(root, 'lock.sha256'), 'utf8')).trim();
  } catch {
    return null;
  }
}

/**
 * Validity check used for idempotent adoption: lock marker present and every
 * locked file verifies. Full byte verification is required by design
 * ("lock 缺失或哈希不符时构建失败"), so the check is intentionally exhaustive.
 * @param {string} root
 * @param {unknown} lock
 * @param {string} lockSha256
 */
export async function isRuntimeValid(root, lock, lockSha256) {
  if (!existsSync(path.join(root, 'lock.json'))) return false;
  if ((await readMarker(root)) !== lockSha256) return false;
  const result = await verifyPreparedRuntime(root, lock);
  return result.ok;
}

/**
 * Freshly prepares a complete runtime from the lock into `root`.
 * On any failure the root is removed (no partial install) and a
 * MediaRuntimePrepareError with a stable code is thrown.
 * @param {unknown} lock
 * @param {{root: string, logger?: (msg: string) => void, runInstaller?: (installerPath: string, installArgs: string[], installDir: string) => void, mirrorDir?: string}} options
 * @returns {Promise<{lockSha256: string, preparedAt: string, preparedBy: string, platform: string, components: Array<{id: string, version: string}>}>}
 */
export async function prepareMediaRuntime(lock, { root, logger = noop, runInstaller = defaultInstaller, mirrorDir } = {}) {
  const errors = validateLock(lock);
  if (errors.length) {
    throw new MediaRuntimePrepareError(MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_LOCK_INVALID, `lock 无效: ${errors.join('; ')}`);
  }
  if (lock.platform !== `${process.platform}-${process.arch}`) {
    throw new MediaRuntimePrepareError(
      MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_PLATFORM_MISMATCH,
      `lock 平台 ${lock.platform} 与当前 ${process.platform}-${process.arch} 不匹配`
    );
  }
  root = path.resolve(root);
  const lockSha256 = lockSha256Of(lock);
  const staging = path.join(root, '.staging');
  await rm(root, { recursive: true, force: true });
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const components = [];
  try {
    for (const component of lock.components) {
      logger(`[media-runtime] ${component.id} ${component.version} ...`);
      // nsis 安装器必须带可执行扩展名，Windows CreateProcess 才能直接 spawn。
      const artifactExt = component.kind === 'nsis' ? '.exe' : component.kind === 'zip' ? '.zip' : '';
      const artifactPath = path.join(staging, `${component.id}.artifact${artifactExt}`);
      // 本地镜像优先：WMB_MEDIA_RUNTIME_MIRROR / --mirror-dir 下存在与 lock sha256 一致的
      // 工件时直接复用（离线/弱网构建），否则按 lock URL 下载。lock 对象不变，marker 保持 canonical。
      const mirrorCandidate = mirrorDir ? path.join(path.resolve(mirrorDir), path.basename(new URL(component.url, 'file:///').pathname)) : null;
      if (mirrorCandidate && existsSync(mirrorCandidate) && (await sha256File(mirrorCandidate)) === component.sha256) {
        await copyFile(mirrorCandidate, artifactPath);
        logger(`[media-runtime] ${component.id}: 采用本地镜像 ${mirrorCandidate}`);
      } else {
        await downloadToFile(component.url, artifactPath, { logger });
      }
      const artifactSha = await sha256File(artifactPath);
      if (artifactSha !== component.sha256) {
        throw new MediaRuntimePrepareError(
          MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_HASH_MISMATCH,
          `${component.id}: 下载物 SHA-256 不符 expected=${component.sha256} actual=${artifactSha}`
        );
      }
      if (component.kind === 'file') {
        const file = component.files[0];
        const target = path.join(root, file.to);
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(artifactPath, target);
        const actual = await sha256File(target);
        if (actual !== file.sha256) {
          throw new MediaRuntimePrepareError(
            MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_HASH_MISMATCH,
            `${component.id}: ${file.to} SHA-256 不符 expected=${file.sha256} actual=${actual}`
          );
        }
      } else if (component.kind === 'zip') {
        const buffer = await readFile(artifactPath);
        const index = readZipIndex(buffer);
        for (const file of component.files) {
          const entry = index.get(file.from);
          if (!entry) {
            throw new MediaRuntimePrepareError(MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_INCOMPLETE, `${component.id}: zip 中缺少 ${file.from}`);
          }
          await writeVerifiedFile(component, file, extractZipEntry(buffer, entry), root);
        }
      } else if (component.kind === 'nsis') {
        const installDir = path.join(staging, `${component.id}-install`);
        await runInstaller(artifactPath, component.installArgs ?? ['/S'], installDir);
        for (const file of component.files) {
          let data;
          try {
            data = await readFile(path.join(installDir, file.from));
          } catch {
            throw new MediaRuntimePrepareError(
              MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_INSTALL_FAILED,
              `${component.id}: 安装产物缺少 ${file.from}`
            );
          }
          await writeVerifiedFile(component, file, data, root);
        }
      }
      components.push({ id: component.id, version: component.version });
      logger(`[media-runtime] ${component.id} 完成`);
    }
    const result = await verifyPreparedRuntime(root, lock);
    if (!result.ok) {
      const problems = [...result.missing.map((p) => `缺失 ${p}`), ...result.hashMismatch.map((p) => `哈希不符 ${p}`)];
      throw new MediaRuntimePrepareError(
        result.missing.length ? MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_INCOMPLETE : MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_HASH_MISMATCH,
        `运行时校验失败: ${problems.join('; ')}`
      );
    }
    await writeFile(path.join(root, 'lock.json'), canonicalLockBytes(lock));
    await writeFile(path.join(root, 'lock.sha256'), lockSha256);
    const manifest = {
      lockSha256,
      preparedAt: new Date().toISOString(),
      preparedBy: 'scripts/prepare-media-runtime.mjs',
      platform: lock.platform,
      cpu: lock.cpu === true,
      fileCount: lock.components.reduce((sum, c) => sum + c.files.length, 0),
      components
    };
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  const argv = process.argv.slice(2);
  let lockPath = path.join(process.cwd(), 'media-runtime.lock.json');
  let root = process.env.WMB_MEDIA_RUNTIME_ROOT ?? path.join(process.cwd(), '.r', 'media-runtime');
  let mirrorDir = process.env.WMB_MEDIA_RUNTIME_MIRROR ?? '';
  let verifyOnly = false;
  let quiet = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--lock') lockPath = argv[++i];
    else if (arg === '--root') root = argv[++i];
    else if (arg === '--verify-only') verifyOnly = true;
    else if (arg === '--mirror-dir') mirrorDir = argv[++i];
    else if (arg === '--quiet') quiet = true;
    else {
      console.error(`[media-runtime] 未知参数: ${arg}`);
      process.exit(MEDIA_RUNTIME_EXIT.USAGE);
    }
  }
  const logger = quiet ? noop : (message) => console.log(message);

  let lockBytes;
  try {
    lockBytes = await readFile(lockPath);
  } catch {
    console.error(`[media-runtime] ${MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_LOCK_MISSING}: lock 缺失 ${lockPath} — 构建失败`);
    process.exit(MEDIA_RUNTIME_EXIT.LOCK_MISSING);
  }
  let lock;
  try {
    lock = JSON.parse(lockBytes);
  } catch (error) {
    console.error(`[media-runtime] ${MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_LOCK_INVALID}: lock 无法解析 ${lockPath}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(MEDIA_RUNTIME_EXIT.LOCK_INVALID);
  }
  const validationErrors = validateLock(lock);
  if (validationErrors.length) {
    console.error(`[media-runtime] ${MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_LOCK_INVALID}: ${validationErrors.join('; ')}`);
    process.exit(MEDIA_RUNTIME_EXIT.LOCK_INVALID);
  }
  const lockSha256 = lockSha256Of(lock);

  if (verifyOnly) {
    const result = await verifyPreparedRuntime(root, lock);
    if (!result.ok) {
      const problems = [...result.missing.map((p) => `缺失 ${p}`), ...result.hashMismatch.map((p) => `哈希不符 ${p}`)];
      console.error(`[media-runtime] ${MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_INCOMPLETE}: ${problems.join('; ')}`);
      process.exit(MEDIA_RUNTIME_EXIT.INCOMPLETE);
    }
    console.log(`[media-runtime] ${root} 校验通过 (${lock.components.length} 组件)。`);
    process.exit(MEDIA_RUNTIME_EXIT.OK);
  }

  try {
    if (await isRuntimeValid(root, lock, lockSha256)) {
      logger(`[media-runtime] 采用既有运行时 ${root}（lock.sha256=${lockSha256}）。`);
      process.exit(MEDIA_RUNTIME_EXIT.OK);
    }
    await prepareMediaRuntime(lock, { root, logger, mirrorDir: mirrorDir || undefined });
    console.log(`[media-runtime] 准备完成 ${root}（${lock.components.length} 组件，${lock.components.reduce((s, c) => s + c.files.length, 0)} 文件，lock.sha256=${lockSha256}）。`);
    process.exit(MEDIA_RUNTIME_EXIT.OK);
  } catch (error) {
    if (error instanceof MediaRuntimePrepareError) {
      console.error(`[media-runtime] ${error.code}: ${error.message}`);
      const exitCode = MEDIA_RUNTIME_EXIT[error.code.replace('MEDIA_RUNTIME_', '')] ?? MEDIA_RUNTIME_EXIT.INCOMPLETE;
      process.exit(exitCode);
    }
    console.error(`[media-runtime] 未知错误: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exit(MEDIA_RUNTIME_EXIT.INCOMPLETE);
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  await main();
}
