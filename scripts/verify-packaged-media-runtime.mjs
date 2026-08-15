#!/usr/bin/env node
/**
 * scripts/verify-packaged-media-runtime.mjs
 *
 * Post-package media runtime gate (WMB-5245).
 *
 * Runs against a packaged Electron output (or any runtime root via --root):
 *  1. Locates the frozen runtime (packaged: <output>/resources/.r/media-runtime/).
 *  2. Verifies every locked file's SHA-256 against media-runtime.lock.json.
 *  3. Actually executes the three frozen commands from their absolute packaged
 *     paths (never PATH):
 *       - ffprobe -version
 *       - whisper-cli --help
 *       - tesseract --version  (with TESSDATA_PREFIX pinned to the packaged tessdata)
 *
 * Failure exits with the stable media-runtime codes (see
 * MEDIA_RUNTIME_EXIT in prepare-media-runtime.mjs); the Forge postPackage hook
 * aborts packaging on any non-zero exit.
 *
 * Usage:
 *   node scripts/verify-packaged-media-runtime.mjs --output <packagedDir>
 *   node scripts/verify-packaged-media-runtime.mjs --root <runtimeRoot> [--lock <lockPath>]
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  MEDIA_RUNTIME_CODES,
  MEDIA_RUNTIME_EXIT,
  lockSha256Of,
  sha256Text,
  validateLock,
  verifyPreparedRuntime
} from './prepare-media-runtime.mjs';

const RUNTIME_REL = path.join('resources', '.r', 'media-runtime');

/** Probe commands: exact frozen executables, exact args, absolute paths only. */
const PROBES = [
  { id: 'ffprobe', componentId: 'ffmpeg', name: 'ffprobe', args: ['-version'], label: 'ffprobe -version' },
  { id: 'whisper', componentId: 'whisper-cli', name: 'whisper-cli', args: ['--help'], label: 'whisper-cli --help' },
  { id: 'tesseract', componentId: 'tesseract', name: 'tesseract', args: ['--version'], label: 'tesseract --version' }
];

/**
 * Resolves the frozen probe executable from the lock (basename match on the
 * component's files — `ffprobe.exe` in production, `.cmd` fixture twins in
 * tests). Never consults PATH.
 */
function resolveProbeExecutable(lock, probe, runtimeRoot) {
  const component = lock.components.find((c) => c.id === probe.componentId);
  const file = component?.files.find((f) => path.basename(f.to).replace(/\.[^.]+$/, '').toLowerCase() === probe.name.toLowerCase());
  return file ? path.join(runtimeRoot, file.to) : null;
}

function fail(code, message) {
  console.error(`[media-runtime-gate] ${code}: ${message}`);
  const exitCode = MEDIA_RUNTIME_EXIT[code.replace('MEDIA_RUNTIME_', '')] ?? MEDIA_RUNTIME_EXIT.INCOMPLETE;
  process.exit(exitCode);
}

async function main() {
  const argv = process.argv.slice(2);
  let outputDir;
  let root;
  let lockPath;
  let probeShell = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--output') outputDir = argv[++i];
    else if (arg === '--root') root = argv[++i];
    else if (arg === '--lock') lockPath = argv[++i];
    else if (arg === '--probe-shell') probeShell = true;
    else {
      console.error(`[media-runtime-gate] 未知参数: ${arg}`);
      process.exit(MEDIA_RUNTIME_EXIT.USAGE);
    }
  }
  if (root && outputDir) fail(MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_LOCK_INVALID, '--output 与 --root 只能提供一个');
  if (!root && !outputDir) fail(MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_LOCK_INVALID, '需要 --output <packagedDir> 或 --root <runtimeRoot>');

  const runtimeRoot = root ?? path.join(outputDir, RUNTIME_REL);
  const resolvedLockPath = lockPath ?? path.join(process.cwd(), 'media-runtime.lock.json');

  let lock;
  try {
    lock = JSON.parse(await readFile(resolvedLockPath, 'utf8'));
  } catch (error) {
    fail(MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_LOCK_MISSING, `lock 缺失或无法解析 ${resolvedLockPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const validationErrors = validateLock(lock);
  if (validationErrors.length) {
    fail(MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_LOCK_INVALID, validationErrors.join('; '));
  }

  if (!existsSync(runtimeRoot)) {
    fail(MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_MISSING, `打包产物缺少媒体运行时 ${runtimeRoot} — 打包前必须运行 node scripts/prepare-media-runtime.mjs`);
  }

  // Byte-identical lock copy must be packaged alongside the runtime.
  let packagedLockBytes;
  try {
    packagedLockBytes = await readFile(path.join(runtimeRoot, 'lock.json'));
  } catch {
    fail(MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_LOCK_MISMATCH, `${runtimeRoot} 缺少 lock.json（运行时未按当前 lock 准备）`);
  }
  const expectedLockSha = lockSha256Of(lock);
  if (sha256Text(packagedLockBytes) !== expectedLockSha) {
    fail(MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_LOCK_MISMATCH, `打包运行时 lock.json 与仓库 lock 不一致 — 请重新运行 prepare-media-runtime`);
  }
  let packagedMarker;
  try {
    packagedMarker = (await readFile(path.join(runtimeRoot, 'lock.sha256'), 'utf8')).trim();
  } catch {
    fail(MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_LOCK_MISMATCH, `${runtimeRoot} 缺少 lock.sha256`);
  }
  if (packagedMarker !== expectedLockSha) {
    fail(MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_LOCK_MISMATCH, `打包运行时 lock.sha256 与仓库 lock 不一致 — 请重新运行 prepare-media-runtime`);
  }

  // 1. Full byte verification of every locked file.
  const result = await verifyPreparedRuntime(runtimeRoot, lock);
  if (!result.ok) {
    if (result.missing.length) {
      fail(MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_MISSING, `打包运行时缺少文件: ${result.missing.join(', ')}`);
    }
    fail(MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_HASH_MISMATCH, `打包运行时哈希不符: ${result.hashMismatch.join(', ')}`);
  }

  // 2. Actually execute the frozen commands from the packaged paths.
  const tessdataDir = path.join(runtimeRoot, 'tesseract', 'tessdata');
  for (const probe of PROBES) {
    const executable = resolveProbeExecutable(lock, probe, runtimeRoot);
    if (!executable || !existsSync(executable)) fail(MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_MISSING, `打包产物缺少 ${probe.label} 可执行文件`);
    const env = { ...process.env };
    if (probe.id === 'tesseract') env.TESSDATA_PREFIX = tessdataDir;
    const spawned = spawnSync(executable, probe.args, { env, encoding: 'utf8', windowsHide: true, timeout: 120_000, shell: probeShell });
    if (spawned.error || spawned.status !== 0) {
      fail(
        MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_INSTALL_FAILED,
        `${probe.label} 执行失败（status=${spawned.status ?? 'n/a'} error=${spawned.error?.message ?? '无'}）: ${String(spawned.stderr ?? spawned.stdout ?? '').slice(0, 500)}`
      );
    }
    const output = `${spawned.stdout ?? ''}${spawned.stderr ?? ''}`.trim();
    if (!output) fail(MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_INSTALL_FAILED, `${probe.label} 无输出`);
    console.log(`[media-runtime-gate] ${probe.label}: ${output.split(/\r?\n/)[0].slice(0, 160)}`);
  }

  console.log(`[media-runtime-gate] 打包媒体运行时门禁通过 ${runtimeRoot}（lock.sha256=${expectedLockSha}）。`);
  process.exit(MEDIA_RUNTIME_EXIT.OK);
}

await main();
