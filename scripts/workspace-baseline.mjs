import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REQUIRED_ROOT_ENTRIES = ['wmb.db', 'assets', 'browser-profile', 'logs', 'exports'];
const PRESERVED_TREES = ['assets', 'exports', 'browser-profile', 'pi-agent', 'xiaohongshu-mcp'];
const ALLOWED_NEW_TABLES = ['workspace_profiles'];
const ALLOWED_APP_META_KEYS = ['workspace_id'];
const ALLOWED_ROOT_ENTRIES = ['wmb.db-wal', 'wmb.db-shm'];

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function hashFile(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

async function hashTree(rootPath) {
  try {
    await stat(rootPath);
  } catch {
    return { exists: false, fileCount: 0, byteCount: 0, sha256: sha256('missing') };
  }
  const entries = [];
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = path.relative(rootPath, fullPath).replaceAll('\\', '/');
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile()) {
        const fileStats = await stat(fullPath);
        entries.push({ path: relativePath, bytes: fileStats.size, sha256: await hashFile(fullPath) });
      } else {
        throw new Error(`数据根目录不允许非普通文件/目录：${relativePath}`);
      }
    }
  }
  await visit(rootPath);
  return {
    exists: true,
    fileCount: entries.length,
    byteCount: entries.reduce((total, entry) => total + entry.bytes, 0),
    sha256: sha256(JSON.stringify(entries))
  };
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function normalize(value) {
  if (Buffer.isBuffer(value)) return { type: 'buffer', base64: value.toString('base64') };
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalize(child)]));
  return value;
}

function tableRowsHash(database, tableName) {
  const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all().map((row) => row.name);
  const orderBy = columns.map((column) => quoteIdentifier(column)).join(', ');
  const rows = database.prepare(`SELECT * FROM ${quoteIdentifier(tableName)} ORDER BY ${orderBy}`).all().map(normalize);
  return { rowCount: rows.length, sha256: sha256(JSON.stringify(rows)) };
}

function appMetaSnapshot(database) {
  const rows = database.prepare('SELECT key, value FROM app_meta ORDER BY key').all();
  const entries = rows.map((row) => ({ key: row.key, sha256: sha256(JSON.stringify(normalize(row))) }));
  return { rowCount: rows.length, sha256: sha256(JSON.stringify(entries)), entries };
}

export async function captureDataRoot(rootPath) {
  const resolvedRoot = await realpath(rootPath);
  for (const entry of REQUIRED_ROOT_ENTRIES) {
    await stat(path.join(resolvedRoot, entry));
  }
  const databasePath = path.join(resolvedRoot, 'wmb.db');
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rootEntries = (await readdir(resolvedRoot)).sort();
    const tableNames = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
    const businessTables = Object.fromEntries(tableNames.filter((name) => name !== 'app_meta' && name !== 'schema_migrations').map((name) => [name, tableRowsHash(database, name)]));
    const appMeta = tableNames.includes('app_meta') ? appMetaSnapshot(database) : { rowCount: 0, sha256: sha256('missing'), entries: [] };
    const accounts = tableNames.includes('platform_accounts') ? tableRowsHash(database, 'platform_accounts') : { rowCount: 0, sha256: sha256('missing') };
    const migrationVersion = tableNames.includes('schema_migrations')
      ? Number(database.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get().version)
      : 0;
    const trees = Object.fromEntries(await Promise.all(PRESERVED_TREES.map(async (entry) => [entry, await hashTree(path.join(resolvedRoot, entry))])));
    const dbStats = await stat(databasePath);
    return {
      resolvedRoot,
      rootEntries,
      schemaVersion: Number(database.prepare('PRAGMA user_version').get().user_version),
      migrationVersion,
      database: { byteCount: dbStats.size, sha256: await hashFile(databasePath) },
      tableNames,
      businessTables,
      appMeta,
      loginReadback: accounts,
      trees,
      stableProjectionSha256: sha256(JSON.stringify({ businessTables, accounts, trees }))
    };
  } finally {
    database.close();
  }
}

async function gitText(repoPath, args) {
  const { stdout } = await execFileAsync('git', args, { cwd: repoPath, windowsHide: true });
  return stdout.trimEnd();
}

async function hashUntrackedFiles(repoPath, status, ignoredPaths) {
  const entries = [];
  for (const line of status.split(/\r?\n/)) {
    if (!line.startsWith('?? ')) continue;
    const relativePath = line.slice(3);
    const fullPath = path.join(repoPath, relativePath);
    if (ignoredPaths.has(path.resolve(fullPath))) continue;
    entries.push({ path: relativePath.replaceAll('\\', '/'), sha256: await hashFile(fullPath) });
  }
  return entries;
}

async function captureGit(repoPath, ignoredPaths = []) {
  const [head, branch, status, stagedDiff, workingDiff] = await Promise.all([
    gitText(repoPath, ['rev-parse', 'HEAD']),
    gitText(repoPath, ['branch', '--show-current']),
    gitText(repoPath, ['status', '--porcelain=v1', '--untracked-files=all']),
    gitText(repoPath, ['diff', '--cached', '--binary']),
    gitText(repoPath, ['diff', '--binary'])
  ]);
  const ignored = new Set(ignoredPaths.map((filePath) => path.resolve(filePath)));
  const visibleStatus = status ? status.split(/\r?\n/).filter((line) => !line.startsWith('?? ') || !ignored.has(path.resolve(repoPath, line.slice(3)))) : [];
  return {
    head,
    branch,
    status: visibleStatus,
    stagedDiffSha256: sha256(stagedDiff),
    workingDiffSha256: sha256(workingDiff),
    untrackedFiles: await hashUntrackedFiles(repoPath, status, ignored)
  };
}

async function captureFiles(repoPath, relativePaths, packagePath) {
  const files = {};
  for (const relativePath of relativePaths) {
    const fullPath = path.join(repoPath, relativePath);
    try { files[relativePath] = await hashFile(fullPath); } catch { files[relativePath] = null; }
  }
  return {
    files,
    package: packagePath ? { path: path.resolve(packagePath), sha256: await hashFile(packagePath) } : null
  };
}

export async function createBaseline({ rootPath, repoPath, packagePath, preTask, ignoredPaths = [] }) {
  const root = await captureDataRoot(rootPath);
  const acceptance = await captureFiles(repoPath, [
    'scripts/check.ps1', 'scripts/workspace-baseline.mjs', 'tests/workspace-baseline.test.mjs',
    'package.json', 'package-lock.json', '.ai/evals/README.md'
  ], packagePath);
  return {
    schema: 'wmb.workspace-baseline.v1',
    capturedAt: new Date().toISOString(),
    preTask,
    git: await captureGit(repoPath, ignoredPaths),
    acceptance,
    root,
    allowedEnrollmentDifferences: {
      database: {
        schemaVersionMayAdvance: true,
        allowedNewTables: ALLOWED_NEW_TABLES,
        allowedChangedTables: ['app_meta', 'schema_migrations'],
        allowedAddedAppMetaKeys: ALLOWED_APP_META_KEYS
      },
      filesystem: {
        allowedChangedPaths: ['logs/**'],
        preservedTreeHashes: PRESERVED_TREES
      }
    }
  };
}

export async function verifyBaseline(rootPath, manifest) {
  assert.equal(manifest.schema, 'wmb.workspace-baseline.v1', '未知基线收据格式');
  const current = await captureDataRoot(rootPath);
  const violations = [];
  for (const [tableName, baseline] of Object.entries(manifest.root.businessTables)) {
    const observed = current.businessTables[tableName];
    if (!observed || observed.sha256 !== baseline.sha256 || observed.rowCount !== baseline.rowCount) violations.push(`business table changed: ${tableName}`);
  }
  for (const tableName of current.tableNames) {
    if (!manifest.root.tableNames.includes(tableName) && !ALLOWED_NEW_TABLES.includes(tableName)) violations.push(`unexpected table: ${tableName}`);
  }
  for (const baselineEntry of manifest.root.appMeta.entries) {
    const observed = current.appMeta.entries.find((entry) => entry.key === baselineEntry.key);
    if (!observed || observed.sha256 !== baselineEntry.sha256) violations.push(`app meta changed: ${baselineEntry.key}`);
  }
  for (const observed of current.appMeta.entries) {
    if (!manifest.root.appMeta.entries.some((entry) => entry.key === observed.key) && !ALLOWED_APP_META_KEYS.includes(observed.key)) violations.push(`unexpected app meta: ${observed.key}`);
  }
  for (const entry of current.rootEntries) {
    if (!manifest.root.rootEntries.includes(entry) && !ALLOWED_ROOT_ENTRIES.includes(entry)) violations.push(`unexpected root entry: ${entry}`);
  }
  for (const treeName of PRESERVED_TREES) {
    if (current.trees[treeName].sha256 !== manifest.root.trees[treeName].sha256) violations.push(`preserved tree changed: ${treeName}`);
  }
  return { ok: violations.length === 0, violations, current };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = {};
  for (let index = 0; index < rest.length; index += 2) args[rest[index]] = rest[index + 1];
  return { command, args };
}

async function main() {
  const { command, args } = parseArgs(process.argv.slice(2));
  if (command === 'capture') {
    if (!args['--root'] || !args['--out']) throw new Error('用法：capture --root <data-root> --out <manifest> [--package <app.asar>]');
    const manifest = await createBaseline({
      rootPath: args['--root'], repoPath: path.resolve(args['--repo'] || process.cwd()), packagePath: args['--package'], ignoredPaths: [path.resolve(args['--out'])],
      preTask: { head: args['--pre-task-head'] || null, clean: args['--pre-task-clean'] === 'true' }
    });
    await mkdir(path.dirname(path.resolve(args['--out'])), { recursive: true });
    await writeFile(path.resolve(args['--out']), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ result: 'captured', root: manifest.root.resolvedRoot, projection: manifest.root.stableProjectionSha256 }, null, 2));
    return;
  }
  if (command === 'verify') {
    if (!args['--root'] || !args['--manifest']) throw new Error('用法：verify --root <data-root> --manifest <manifest>');
    const result = await verifyBaseline(args['--root'], JSON.parse(await readFile(path.resolve(args['--manifest']), 'utf8')));
    console.log(JSON.stringify({ result: result.ok ? 'pass' : 'fail', violations: result.violations }, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  throw new Error('命令必须是 capture 或 verify。');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
