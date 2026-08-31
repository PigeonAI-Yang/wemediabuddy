// Electron E2E scenario runner (WMB-5243).
//
// Two modes:
//  A) Matrix mode (default): reads tests/e2e/user-journeys.json and runs every
//     journey with `automatable === true` and an existing `testFile`; files are
//     grouped by testFile and imported once. A page file default-exports an
//     ARRAY of scenario objects:
//       export default [
//         { id: 'TD-001-today-plan-normal', journeyIds: ['TD-001-...'], run: async (ctx) => {...} },
//       ];
//     or a single default function for exactly one journey. The runner picks
//     the scenario whose `id` (or journeyIds) matches the journey id.
//  B) File mode (--file): runs scenario files directly, independent of the
//     matrix (used by the standalone smoke command).
//
// ctx passed to every scenario (from tests/e2e/harness.mjs withApp):
//   { app, page, workspace: {userDataDir,dataRoot,workspaceId,displayName},
//     artifactsDir, evidence: {console,errors,pageerrors,crashed,closed,steps,
//     electronStdout,electronStderr}, runtimeDir,
//     helpers: { waitForAppReady, navigateTo, captureEvidence, closeApp, delay,
//                VIEW_TITLES, assert, step, openReadOnlyDb },
//     assert(cond,msg), step(name,fn), openDb() -> {db, close} }
//
// Status: the matrix is read-only; this runner never edits user-journeys.json.
// Results are written to tests/e2e/.runtime/results.json for the coverage gate.
//
// Usage:
//   npm run e2e
//   npm run e2e:smoke
//   node tests/e2e/runner.mjs --journey NAV-001-global-navigation-all-views
//   node tests/e2e/runner.mjs --file tests/e2e/navigation.test.mjs --scenario smoke-launch-exit
//   node tests/e2e/runner.mjs --list
//   node tests/e2e/runner.mjs --max-parallel 2

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cleanupE2eArtifacts } from '../../scripts/cleanup-e2e-artifacts.mjs';
import { E2E_ROOT, REPO_ROOT, RUNTIME_DIR, delay, withApp } from './harness.mjs';

const JOURNEYS_FILE = path.join(E2E_ROOT, 'user-journeys.json');
const DEFAULT_RESULTS_OUT = path.join(RUNTIME_DIR, 'results.json');
function runCleanup(stage) {
  try {
    const report = cleanupE2eArtifacts({ includeDataRoot: false });
    const bytes = (items) => items.reduce((total, item) => total + Number(item.bytes ?? 0), 0);
    console.log(`[runner] cleanup ${stage}: removed=${report.removed.length}/${bytes(report.removed)}B planned=${report.planned.length}/${bytes(report.planned)}B skipped=${report.skipped.length} errors=${report.errors.length}`);
    if (report.errors.length) console.warn(`[runner] cleanup ${stage} warnings: ${report.errors.map((item) => `${item.path}: ${item.reason}`).join('; ')}`);
  } catch (error) {
    console.warn(`[runner] cleanup ${stage} unavailable: ${String(error?.message ?? error)}`);
  }
}

function parseArgs(argv) {
  const options = { journeys: [], files: [], scenarios: [], maxParallel: 1, timeoutMs: 240_000, list: false, resultsOut: DEFAULT_RESULTS_OUT, keepRuntime: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--journey') options.journeys.push(argv[++i]);
    else if (arg === '--file') options.files.push(argv[++i]);
    else if (arg === '--scenario') options.scenarios.push(argv[++i]);
    else if (arg === '--list') options.list = true;
    else if (arg === '--max-parallel') options.maxParallel = Number(argv[++i]);
    else if (arg === '--timeout') options.timeoutMs = Number(argv[++i]) * 1000;
    else if (arg === '--results-out') options.resultsOut = argv[++i];
    else if (arg === '--keep-runtime') options.keepRuntime = true;
    else {
      console.error(`未知参数: ${arg}`);
      process.exit(2);
    }
  }
  return options;
}

function loadJourneys() {
  if (!existsSync(JOURNEYS_FILE)) {
    console.error(`缺少旅程矩阵: ${JOURNEYS_FILE}`);
    process.exit(2);
  }
  const raw = JSON.parse(readFileSync(JOURNEYS_FILE, 'utf8'));
  if (!Array.isArray(raw.journeys)) {
    console.error(`旅程矩阵格式错误: 缺少 journeys 数组 (${JOURNEYS_FILE})`);
    process.exit(2);
  }
  return raw.journeys;
}

function resolveTestFile(testFile) {
  if (!testFile) return null;
  const absolute = path.resolve(REPO_ROOT, testFile);
  return existsSync(absolute) ? absolute : null;
}

async function importScenarios(file) {
  const mod = await import(pathToFileURL(file).href);
  const exported = mod.default ?? mod.run;
  if (Array.isArray(exported)) return exported.filter((item) => item && typeof item.run === 'function');
  if (exported && typeof exported.run === 'function') return [exported];
  if (typeof exported === 'function') return [{ id: null, run: exported }];
  throw new Error(`testFile 未导出场景（需要 default 函数或场景对象数组）: ${file}`);
}

function pickScenario(items, journey) {
  if (!items.length) return null;
  const wanted = journey.scenario ?? journey.id;
  return items.find((item) => item.id === wanted || item.journeyIds?.includes(journey.id))
    ?? (items.length === 1 ? items[0] : null);
}

async function runScenario(label, scenario, options) {
  const startedAt = Date.now();
  try {
    const outcome = await withApp(async (ctx) => {
      let settled = false;
      const guard = delay(options.timeoutMs).then(() => {
        if (!settled) throw new Error(`场景超时 (${options.timeoutMs}ms)`);
      });
      try {
        return await Promise.race([scenario.run(ctx), guard]);
      } finally {
        settled = true;
      }
    }, { name: label, keepRuntime: options.keepRuntime, ...(scenario.launch ?? {}) });
    return {
      status: 'passed',
      durationMs: Date.now() - startedAt,
      evidenceDir: outcome.artifactsDir,
      result: outcome.result
    };
  } catch (error) {
    return {
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
      evidenceDir: error?.evidenceDir ?? null,
      durationMs: Date.now() - startedAt
    };
  }
}

function printSummary(results, counts) {
  console.log(`[runner] 结果: ${counts.resultsOut}`);
  console.log(`[runner] 通过 ${counts.passed}/${counts.total} | 失败 ${counts.failed}${counts.skipped ? ` | 跳过 ${counts.skipped}` : ''}`);
  process.exit(counts.failed === 0 ? 0 : 1);
}

async function runMatrixMode(options) {
  const journeys = loadJourneys();
  const selected = options.journeys.length
    ? journeys.filter((journey) => options.journeys.includes(journey.id))
    : journeys.filter((journey) => journey.automatable === true && journey.testFile);
  const missing = options.journeys.filter((id) => !selected.some((journey) => journey.id === id));
  for (const id of missing) console.warn(`[runner] 警告: 矩阵中不存在旅程 ${id}`);
  if (!selected.length) {
    console.error('[runner] 没有可运行的矩阵旅程（--journey 指定了不存在的 id，或矩阵中没有 automatable=true 且带 testFile 的旅程）。');
    process.exit(2);
  }

  const byFile = new Map();
  for (const journey of selected) {
    const file = resolveTestFile(journey.testFile);
    if (!file) { console.warn(`[runner] 跳过 ${journey.id}: testFile 不存在 (${journey.testFile})`); continue; }
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(journey);
  }
  if (!byFile.size) { console.error('[runner] 所有选中旅程的 testFile 都不存在。'); process.exit(1); }

  if (options.list) {
    const rows = [];
    for (const [file, fileJourneys] of byFile) {
      let scenarios;
      try { scenarios = await importScenarios(file); } catch { scenarios = []; }
      for (const journey of fileJourneys) {
        const item = pickScenario(scenarios, journey);
        rows.push({
          id: journey.id,
          risk: journey.risk ?? '(missing)',
          automatable: journey.automatable ?? '(missing)',
          testFile: journey.testFile,
          scenario: item ? (item.id ?? '(file)') : '(无匹配场景)'
        });
      }
    }
    console.table(rows);
    process.exit(0);
  }

  const results = { version: 2, ranAt: new Date().toISOString(), mode: 'matrix', journeys: {} };
  const pending = [];
  for (const [file, fileJourneys] of byFile) {
    let scenarios;
    try {
      scenarios = await importScenarios(file);
    } catch (error) {
      for (const journey of fileJourneys) {
        results.journeys[journey.id] = { status: 'failed', reason: `场景文件导入失败: ${error instanceof Error ? error.message : error}`, durationMs: 0, evidenceDir: null };
      }
      continue;
    }
    for (const journey of fileJourneys) {
      const scenario = pickScenario(scenarios, journey);
      if (!scenario) {
        results.journeys[journey.id] = { status: 'skipped', reason: `testFile 中无匹配场景 (${journey.testFile})`, durationMs: 0, evidenceDir: null };
        continue;
      }
      pending.push({ id: journey.id, run: () => runScenario(journey.id, scenario, options) });
    }
  }

  let index = 0;
  const workers = Array.from({ length: Math.min(options.maxParallel, pending.length) }, async () => {
    while (index < pending.length) {
      const job = pending[index];
      index += 1;
      process.stdout.write(`[runner] ${job.id} ... `);
      const record = await job.run();
      results.journeys[job.id] = record;
      process.stdout.write(`${record.status} (${record.durationMs}ms)${record.evidenceDir ? ` · 证据: ${record.evidenceDir}` : ''}\n`);
      if (record.status === 'failed') process.stdout.write(`  ${record.reason}\n`);
    }
  });
  await Promise.all(workers);

  mkdirSync(path.dirname(options.resultsOut), { recursive: true });
  writeFileSync(options.resultsOut, `${JSON.stringify(results, null, 2)}\n`);
  runCleanup('after');
  const passed = Object.values(results.journeys).filter((record) => record.status === 'passed').length;
  const failed = Object.values(results.journeys).filter((record) => record.status === 'failed').length;
  const skipped = Object.values(results.journeys).filter((record) => record.status === 'skipped').length;
  printSummary(results, { resultsOut: options.resultsOut, passed, failed, skipped, total: Object.keys(results.journeys).length });
}

async function runFileMode(options) {
  if (!options.files.length) { console.error('--file 模式需要至少一个文件路径。'); process.exit(2); }
  const entries = [];
  for (const raw of options.files) {
    const file = path.resolve(REPO_ROOT, raw);
    if (!existsSync(file)) { console.error(`文件不存在: ${file}`); process.exit(2); }
    let scenarios;
    try { scenarios = await importScenarios(file); } catch (error) {
      console.error(`场景文件导入失败: ${file}: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
    const wanted = options.scenarios.length ? scenarios.filter((item) => options.scenarios.includes(item.id)) : scenarios;
    if (!wanted.length) {
      console.error(`场景文件没有可运行的场景: ${file}${options.scenarios.length ? `（--scenario 未命中: ${options.scenarios.join(', ')}）` : ''}`);
      process.exit(2);
    }
    for (const item of wanted) entries.push({ id: item.id ?? `${path.basename(file)}:${scenarios.indexOf(item)}`, run: () => runScenario(item.id ?? path.basename(file), item, options) });
  }

  if (options.list) {
    console.table(entries.map((entry) => ({ id: entry.id })));
    process.exit(0);
  }

  const results = { version: 2, ranAt: new Date().toISOString(), mode: 'file', journeys: {} };
  let index = 0;
  const workers = Array.from({ length: Math.min(options.maxParallel, entries.length) }, async () => {
    while (index < entries.length) {
      const job = entries[index];
      index += 1;
      process.stdout.write(`[runner] ${job.id} ... `);
      const record = await job.run();
      results.journeys[job.id] = record;
      process.stdout.write(`${record.status} (${record.durationMs}ms)${record.evidenceDir ? ` · 证据: ${record.evidenceDir}` : ''}\n`);
      if (record.status === 'failed') process.stdout.write(`  ${record.reason}\n`);
    }
  });
  await Promise.all(workers);

  mkdirSync(path.dirname(options.resultsOut), { recursive: true });
  writeFileSync(options.resultsOut, `${JSON.stringify(results, null, 2)}\n`);
  runCleanup('after');
  const passed = Object.values(results.journeys).filter((record) => record.status === 'passed').length;
  const failed = Object.values(results.journeys).filter((record) => record.status === 'failed').length;
  printSummary(results, { resultsOut: options.resultsOut, passed, failed, skipped: 0, total: Object.keys(results.journeys).length });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  runCleanup('before');
  mkdirSync(RUNTIME_DIR, { recursive: true });
  if (options.files.length) await runFileMode(options);
  else await runMatrixMode(options);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
