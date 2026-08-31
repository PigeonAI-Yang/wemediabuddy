/**
 * Remove stale WeMediaBuddy E2E fixtures, evidence, rollback drills, and
 * regenerable local caches without touching the live workspace database/assets.
 *
 * The runner imports cleanupE2eArtifacts() before and after an E2E run. The
 * command-line form also cleans explicitly allow-listed WMBData repair/rollback
 * backup copies, logs, and caches (npm run e2e:cleanup). Generic or ambiguous
 * backups are intentionally preserved.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_FILE), '..');
const E2E_ROOT = path.join(REPO_ROOT, 'tests', 'e2e');
const DEFAULT_RUNTIME_DIR = path.join(E2E_ROOT, '.runtime');
const DEFAULT_ARTIFACTS_DIR = path.join(E2E_ROOT, '.artifacts');
const DEFAULT_TMP_DIR = path.join(REPO_ROOT, 'tmp');
const DEFAULT_DATA_ROOT = path.resolve(REPO_ROOT, '..', 'WeMediaBuddyData');
const RUN_MANIFEST = '.wmb-e2e-run.json';

export const CLEANUP_POLICY = Object.freeze({
  activeGraceMs: 2 * 60 * 60 * 1000,
  recentSuccessMs: 24 * 60 * 60 * 1000,
  recentFailureMs: 14 * 24 * 60 * 60 * 1000,
  recentFailureCount: 20,
  cacheAgeMs: 24 * 60 * 60 * 1000,
  logAgeMs: 48 * 60 * 60 * 1000,
  generatedBackupsKeptPerKind: 1
});

function normalizeProcessText(value) {
  return String(value ?? '').replaceAll('\\', '/').toLowerCase();
}

function isDirectChild(parent, candidate) {
  return path.dirname(path.resolve(candidate)) === path.resolve(parent);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listDirect(parent) {
  if (!existsSync(parent)) return [];
  try {
    return readdirSync(parent, { withFileTypes: true }).map((entry) => {
      const fullPath = path.join(parent, entry.name);
      let info;
      try { info = lstatSync(fullPath); } catch { return null; }
      if (info.isSymbolicLink() || info.isFile() || info.isDirectory()) {
        return { name: entry.name, path: fullPath, isFile: info.isFile(), isDirectory: info.isDirectory(), info };
      }
      return null;
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function bytesOf(file) {
  try {
    const info = lstatSync(file);
    if (info.isSymbolicLink()) return 0;
    if (info.isFile()) return info.size;
    if (!info.isDirectory()) return 0;
    let total = 0;
    for (const entry of listDirect(file)) total += bytesOf(entry.path);
    return total;
  } catch {
    return 0;
  }
}

function ageMs(info, now) {
  return Math.max(0, now - info.mtimeMs);
}

function markerFor(dir) {
  const markerPath = path.join(dir, RUN_MANIFEST);
  if (!existsSync(markerPath)) return null;
  const marker = readJson(markerPath);
  return marker && typeof marker === 'object' ? marker : null;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function listProcesses() {
  if (process.platform !== 'win32') return [];
  try {
    const command = 'Get-CimInstance Win32_Process | ForEach-Object { "{0}`t{1}`t{2}" -f $_.ProcessId, $_.Name, $_.CommandLine }';
    const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    });
    return output.split(/\r?\n/u).map((line) => {
      const [pid, name, ...rest] = line.split('\t');
      return { pid: Number(pid), name: String(name ?? ''), commandLine: rest.join('\t') };
    }).filter((item) => Number.isInteger(item.pid) && item.pid > 0);
  } catch {
    return [];
  }
}

function hasActiveProcess(candidate, marker, processes) {
  if (marker?.state === 'active' && processAlive(Number(marker.pid))) return true;
  const wanted = normalizeProcessText(candidate);
  return processes.some((item) => normalizeProcessText(item.commandLine).includes(wanted));
}

function hasActiveWmbProcess(processes, dataRoot) {
  const repo = normalizeProcessText(REPO_ROOT);
  const data = normalizeProcessText(dataRoot);
  return processes.some((item) => {
    const name = String(item.name ?? '').toLowerCase();
    const command = normalizeProcessText(item.commandLine);
    if (/^wemediabuddy(?:\.exe)?$/u.test(name)) return true;
    return /^(?:electron|electron\.exe)$/u.test(name) && (command.includes(repo) || command.includes(data));
  });
}

function candidate(entry, kind, reason) {
  return {
    path: entry.path,
    kind,
    reason,
    bytes: bytesOf(entry.path),
    isDirectory: entry.isDirectory
  };
}

function isFailureArtifact(dir) {
  const names = listDirect(dir).map((entry) => entry.name);
  if (names.some((name) => /^failure-/iu.test(name))) return true;
  for (const name of ['result.json', 'readback.json', 'classification.json']) {
    const parsed = readJson(path.join(dir, name));
    if (!parsed || typeof parsed !== 'object') continue;
    if (parsed.status === 'failed' || parsed.status === 'failure' || parsed.pass === false || parsed.ok === false) return true;
  }
  return false;
}

function collectRuntimeCandidates(root, now, processes, result) {
  const entries = listDirect(root).filter((entry) => entry.isDirectory && /^run-[A-Za-z0-9_-]+$/u.test(entry.name));
  const failures = entries.filter((entry) => markerFor(entry.path)?.state === 'failed' || isFailureArtifact(entry.path)).sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
  const keepFailures = new Set(failures.slice(0, CLEANUP_POLICY.recentFailureCount).map((entry) => entry.path));
  for (const entry of entries) {
    const marker = markerFor(entry.path);
    const age = ageMs(entry.info, now);
    if (hasActiveProcess(entry.path, marker, processes)) {
      result.skipped.push({ path: entry.path, kind: 'runtime', reason: 'active-process', bytes: bytesOf(entry.path) });
      continue;
    }
    if (age < CLEANUP_POLICY.activeGraceMs) {
      result.skipped.push({ path: entry.path, kind: 'runtime', reason: 'recent-root', bytes: bytesOf(entry.path) });
      continue;
    }
    if (marker?.state === 'failed' && marker.keepRuntime === true && age < CLEANUP_POLICY.recentFailureMs && keepFailures.has(entry.path)) {
      result.skipped.push({ path: entry.path, kind: 'runtime', reason: 'recent-failure-retained', bytes: bytesOf(entry.path) });
      continue;
    }
    result.planned.push(candidate(entry, 'runtime', marker?.state === 'passed' ? 'completed-success' : 'stale-runtime'));
  }
}

function collectArtifactCandidates(root, now, processes, result) {
  const entries = listDirect(root).filter((entry) => entry.isDirectory);
  const failures = entries.filter((entry) => markerFor(entry.path)?.state === 'failed' || isFailureArtifact(entry.path)).sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
  const keepFailures = new Set(failures.slice(0, CLEANUP_POLICY.recentFailureCount).map((entry) => entry.path));
  for (const entry of entries) {
    const marker = markerFor(entry.path);
    const age = ageMs(entry.info, now);
    const failure = marker?.state === 'failed' || isFailureArtifact(entry.path);
    if (hasActiveProcess(entry.path, marker, processes)) {
      result.skipped.push({ path: entry.path, kind: 'artifact', reason: 'active-process', bytes: bytesOf(entry.path) });
      continue;
    }
    if (age < CLEANUP_POLICY.activeGraceMs) {
      result.skipped.push({ path: entry.path, kind: 'artifact', reason: 'recent-root', bytes: bytesOf(entry.path) });
      continue;
    }
    if (failure && age < CLEANUP_POLICY.recentFailureMs && keepFailures.has(entry.path)) {
      result.skipped.push({ path: entry.path, kind: 'artifact', reason: 'recent-failure-retained', bytes: bytesOf(entry.path) });
      continue;
    }
    if (!failure && age < CLEANUP_POLICY.recentSuccessMs) {
      result.skipped.push({ path: entry.path, kind: 'artifact', reason: 'recent-success-retained', bytes: bytesOf(entry.path) });
      continue;
    }
    const reason = failure ? 'aged-failure' : (bytesOf(entry.path) === 0 ? 'empty-artifact' : 'aged-success');
    result.planned.push(candidate(entry, 'artifact', reason));
  }
}

function collectTmpCandidates(root, now, processes, result) {
  const generated = /^(?:approved-chain-rollback-drill-[0-9a-f]{32}|rollback-drill(?:-[A-Za-z0-9_-]+)?|wmb[0-9]+-e2e-(?:data|userdata))$/iu;
  for (const entry of listDirect(root).filter((item) => item.isDirectory && generated.test(item.name))) {
    const age = ageMs(entry.info, now);
    if (hasActiveProcess(entry.path, null, processes)) {
      result.skipped.push({ path: entry.path, kind: 'tmp', reason: 'active-process', bytes: bytesOf(entry.path) });
      continue;
    }
    if (age < CLEANUP_POLICY.activeGraceMs) {
      result.skipped.push({ path: entry.path, kind: 'tmp', reason: 'recent-root', bytes: bytesOf(entry.path) });
      continue;
    }
    result.planned.push(candidate(entry, 'tmp', 'stale-generated-temp'));
  }
}

function backupKind(name) {
  if (/^wmb\.db\.approved-chain-repair-backup-.+\.db$/iu.test(name)) return 'repair';
  if (/^wmb\.db\.approved-chain-rollback-backup-.+\.db$/iu.test(name)) return 'rollback';
  return null;
}

function collectDataCandidates(dataRoot, now, processes, result) {
  if (!existsSync(dataRoot) || hasActiveWmbProcess(processes, dataRoot)) {
    if (existsSync(dataRoot)) result.skipped.push({ path: dataRoot, kind: 'data-root', reason: 'active-wmb-process', bytes: 0 });
    return;
  }
  const entries = listDirect(dataRoot);
  const bases = entries.filter((entry) => entry.isFile && backupKind(entry.name));
  const grouped = new Map();
  for (const entry of bases) {
    const kind = backupKind(entry.name);
    if (!grouped.has(kind)) grouped.set(kind, []);
    grouped.get(kind).push(entry);
  }
  const plannedBases = new Set();
  for (const [kind, group] of grouped) {
    group.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
    for (const entry of group.slice(CLEANUP_POLICY.generatedBackupsKeptPerKind)) {
      result.planned.push(candidate(entry, 'backup', `superseded-${kind}-backup`));
      plannedBases.add(entry.path);
    }
  }
  for (const entry of entries) {
    if (!entry.isFile || !/\.db-(?:shm|wal)$/iu.test(entry.name)) continue;
    const base = entry.path.replace(/\.db-(?:shm|wal)$/iu, '.db');
    if (plannedBases.has(base)) result.planned.push(candidate(entry, 'backup-sidecar', 'sidecar-of-removed-backup'));
  }

  for (const relative of ['logs', path.join('xiaohongshu-mcp', 'logs')]) {
    const logRoot = path.join(dataRoot, relative);
    for (const entry of listDirect(logRoot).filter((item) => item.isFile && /\.log$/iu.test(item.name))) {
      if (ageMs(entry.info, now) < CLEANUP_POLICY.logAgeMs || hasActiveProcess(entry.path, null, processes)) {
        result.skipped.push({ path: entry.path, kind: 'log', reason: 'recent-or-active', bytes: entry.info.size });
        continue;
      }
      result.planned.push(candidate(entry, 'log', 'aged-log'));
    }
  }

  for (const name of ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache']) {
    const entry = entries.find((item) => item.isDirectory && item.name === name);
    if (!entry) continue;
    if (ageMs(entry.info, now) < CLEANUP_POLICY.cacheAgeMs || hasActiveProcess(entry.path, null, processes)) {
      result.skipped.push({ path: entry.path, kind: 'cache', reason: 'recent-or-active', bytes: bytesOf(entry.path) });
      continue;
    }
    result.planned.push(candidate(entry, 'cache', 'aged-regenerable-cache'));
  }
}

function emptyResult(now, dryRun, roots) {
  return {
    version: 1,
    now: new Date(now).toISOString(),
    dryRun,
    roots,
    policy: CLEANUP_POLICY,
    planned: [],
    removed: [],
    skipped: [],
    errors: []
  };
}

export function cleanupE2eArtifacts({
  dryRun = false,
  includeDataRoot = false,
  runtimeDir = DEFAULT_RUNTIME_DIR,
  artifactsDir = DEFAULT_ARTIFACTS_DIR,
  tmpDir = DEFAULT_TMP_DIR,
  dataRoot = DEFAULT_DATA_ROOT,
  now = Date.now()
} = {}) {
  const roots = {
    runtimeDir: path.resolve(runtimeDir),
    artifactsDir: path.resolve(artifactsDir),
    tmpDir: path.resolve(tmpDir),
    dataRoot: path.resolve(dataRoot)
  };
  const result = emptyResult(now, dryRun, roots);
  const processes = listProcesses();
  collectRuntimeCandidates(roots.runtimeDir, now, processes, result);
  collectArtifactCandidates(roots.artifactsDir, now, processes, result);
  collectTmpCandidates(roots.tmpDir, now, processes, result);
  if (includeDataRoot) collectDataCandidates(roots.dataRoot, now, processes, result);

  if (dryRun) return result;
  for (const item of result.planned) {
    const parent = ['backup', 'backup-sidecar', 'cache'].includes(item.kind) ? roots.dataRoot : path.dirname(item.path);
    if (!isDirectChild(parent, item.path) || (item.kind === 'artifact' && !isDirectChild(roots.artifactsDir, item.path)) || (item.kind === 'runtime' && !isDirectChild(roots.runtimeDir, item.path)) || (item.kind === 'tmp' && !isDirectChild(roots.tmpDir, item.path))) {
      result.errors.push({ path: item.path, reason: 'safety-boundary-rejected' });
      continue;
    }
    if (!existsSync(item.path)) continue;
    try {
      const info = lstatSync(item.path);
      if (info.isSymbolicLink()) {
        result.errors.push({ path: item.path, reason: 'symbolic-link-rejected' });
        continue;
      }
      if (hasActiveProcess(item.path, null, processes)) {
        result.skipped.push({ path: item.path, kind: item.kind, reason: 'became-active', bytes: bytesOf(item.path) });
        continue;
      }
      rmSync(item.path, { recursive: info.isDirectory(), force: false });
      result.removed.push(item);
    } catch (error) {
      result.errors.push({ path: item.path, reason: String(error?.message ?? error) });
    }
  }
  return result;
}

function summarize(result) {
  const sum = (items) => items.reduce((total, item) => total + Number(item.bytes ?? 0), 0);
  const byKind = (items) => Object.fromEntries([...new Set(items.map((item) => item.kind))].sort().map((kind) => [kind, {
    count: items.filter((item) => item.kind === kind).length,
    bytes: sum(items.filter((item) => item.kind === kind))
  }]));
  return {
    version: result.version,
    dryRun: result.dryRun,
    roots: result.roots,
    policy: result.policy,
    planned: { count: result.planned.length, bytes: sum(result.planned), byKind: byKind(result.planned) },
    removed: { count: result.removed.length, bytes: sum(result.removed), byKind: byKind(result.removed) },
    skipped: { count: result.skipped.length, bytes: sum(result.skipped), byReason: Object.fromEntries([...new Set(result.skipped.map((item) => item.reason))].sort().map((reason) => [reason, result.skipped.filter((item) => item.reason === reason).length])) },
    errors: result.errors
  };
}

function parseArgs(argv) {
  const options = { dryRun: false, includeDataRoot: true, report: null, runtimeDir: DEFAULT_RUNTIME_DIR, artifactsDir: DEFAULT_ARTIFACTS_DIR, tmpDir: DEFAULT_TMP_DIR, dataRoot: DEFAULT_DATA_ROOT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--skip-data-root') options.includeDataRoot = false;
    else if (arg === '--report') options.report = argv[++index];
    else if (arg === '--runtime-dir') options.runtimeDir = argv[++index];
    else if (arg === '--artifacts-dir') options.artifactsDir = argv[++index];
    else if (arg === '--tmp-dir') options.tmpDir = argv[++index];
    else if (arg === '--data-root') options.dataRoot = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE;
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = cleanupE2eArtifacts(options);
    if (options.report) writeFileSync(path.resolve(options.report), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({ ...summarize(result), report: options.report ? path.resolve(options.report) : null }, null, 2));
    if (result.errors.length) process.exitCode = 1;
  } catch (error) {
    console.error(`[wmb] E2E cleanup failed: ${String(error?.message ?? error)}`);
    process.exitCode = 1;
  }
}
