// E2E coverage gate (WMB-5243).
//
// Reads tests/e2e/user-journeys.json and computes the ratio of critical/high
// automatable journeys that have a testFile AND actually passed. Exits
// non-zero when the ratio is below --min (default 0.95).
//
// Formula (aligns with user-journeys.json meta.coverage.formula):
//   coveragePct = passed / denominator * 100
//   denominator = journeys with risk ∈ {critical, high} AND automatable === true
//   passed      = denominator journeys whose testFile exists AND the CURRENT
//                 runner results file records status === 'passed'.
//   not-run ≠ passed：journey 不在 results 中、或 results 文件缺失时一律不计为通过
//   （唯一例外是显式 --dry-run，按矩阵 status 估算，恒 exit 0）。
// 聚焦跑（--journey/--file/smoke）会覆盖 results.json，其中未包含的旅程不会被计为通过，
// 因此聚焦跑永远无法伪造全量 gate。
//
// Usage:
//   node tests/e2e/coverage-gate.mjs
//   node tests/e2e/coverage-gate.mjs --min 0.9 --results tests/e2e/.runtime/results.json
//   node tests/e2e/coverage-gate.mjs --dry-run        # matrix status only, exit 0
//   node tests/e2e/coverage-gate.mjs --json           # machine-readable stats
//   node tests/e2e/coverage-gate.mjs --update-matrix  # write meta.coverage.current back

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { E2E_ROOT, REPO_ROOT, RUNTIME_DIR } from './harness.mjs';

const JOURNEYS_FILE = path.join(E2E_ROOT, 'user-journeys.json');
const DEFAULT_RESULTS = path.join(RUNTIME_DIR, 'results.json');

function parseArgs(argv) {
  const options = { results: DEFAULT_RESULTS, min: 0.95, dryRun: false, json: false, updateMatrix: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--results') options.results = argv[++i];
    else if (arg === '--min') options.min = Number(argv[++i]);
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--update-matrix') options.updateMatrix = true;
    else {
      console.error(`未知参数: ${arg}`);
      process.exit(2);
    }
  }
  return options;
}

function loadMatrix() {
  if (!existsSync(JOURNEYS_FILE)) {
    console.error(`缺少旅程矩阵: ${JOURNEYS_FILE}`);
    process.exit(2);
  }
  const raw = JSON.parse(readFileSync(JOURNEYS_FILE, 'utf8'));
  if (!Array.isArray(raw.journeys)) {
    console.error(`旅程矩阵格式错误: 缺少 journeys 数组 (${JOURNEYS_FILE})`);
    process.exit(2);
  }
  return raw;
}

function loadResults(resultsPath) {
  if (!existsSync(resultsPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(resultsPath, 'utf8'));
    return raw?.journeys ?? {};
  } catch {
    return null;
  }
}

function compute(matrix, results, dryRun, minOverride) {
  const journeys = matrix.journeys;
  const gatePct = typeof minOverride === 'number' && Number.isFinite(minOverride)
    ? minOverride * 100
    : (matrix.meta?.coverage?.gatePct ?? 95);
  const eligible = journeys.filter((journey) => ['critical', 'high'].includes(journey.risk) && journey.automatable === true);
  const hasTestFile = eligible.filter((journey) => journey.testFile && existsSync(path.resolve(REPO_ROOT, journey.testFile)));
  const passed = eligible.filter((journey) => {
    if (!journey.testFile || !existsSync(path.resolve(REPO_ROOT, journey.testFile))) return false;
    if (dryRun) return journey.status === 'passing';
    if (!results) return false; // 未运行（无结果文件）→ 未运行不算通过
    return results[journey.id]?.status === 'passed';
  });
  const excludedManual = journeys.filter((journey) => journey.automatable === false);
  const excludedOther = journeys.filter((journey) => journey.automatable !== false && !['critical', 'high'].includes(journey.risk));
  const gaps = eligible
    .filter((journey) => !passed.includes(journey))
    .map((journey) => ({ id: journey.id, testFile: journey.testFile ?? null, status: journey.status ?? 'planned' }));
  return {
    denominator: eligible.length,
    withTestFile: hasTestFile.length,
    passing: passed.length,
    coveragePct: eligible.length ? Math.round((passed.length / eligible.length) * 1000) / 10 : 0,
    gatePct,
    gateMet: eligible.length > 0 && passed.length / eligible.length >= gatePct / 100,
    manualExcluded: excludedManual.length,
    excludedOther: excludedOther.length,
    gaps
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const matrix = loadMatrix();
  const results = options.dryRun ? null : loadResults(options.results);
  const missingResults = results === null && !options.dryRun;
  const stats = compute(matrix, results, options.dryRun, options.min);

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...stats, missingResults }, null, 2)}\n`);
  } else {
    console.log('=== E2E 覆盖率 (critical/high 可自动化旅程) ===');
    console.log(`分母: ${stats.denominator} | 有 testFile: ${stats.withTestFile} | 实际通过: ${stats.passing} | 比率: ${stats.coveragePct}% (要求 >= ${stats.gatePct}%)`);
    if (missingResults) console.log(`注意: 未找到结果文件 ${options.results}；未运行不算通过，本次按 0 计。请先运行 npm run e2e 获取真实结果（--dry-run 才按矩阵 status 估算）。`);
    if (stats.manualExcluded) console.log(`排除（automatable=false manual）: ${stats.manualExcluded}`);
    if (stats.excludedOther) console.log(`排除（非 critical/high 风险）: ${stats.excludedOther}`);
    if (stats.gaps.length) {
      console.log(`未通过 (${stats.gaps.length}):`);
      for (const gap of stats.gaps) console.log(`  - ${gap.id} (${gap.status}) ${gap.testFile ?? '(无 testFile)'}`);
    }
    console.log(`gate ${stats.gateMet ? 'PASS' : 'FAIL'} (${stats.coveragePct}% >= ${stats.gatePct}%)`);
  }

  if (options.updateMatrix) {
    matrix.meta.coverage.current = {
      denominator: stats.denominator,
      manualExcluded: stats.manualExcluded,
      passing: stats.passing,
      coveragePct: stats.coveragePct,
      gateMet: stats.gateMet,
      note: '由 tests/e2e/coverage-gate.mjs --update-matrix 重算',
      gaps: stats.gaps
    };
    writeFileSync(JOURNEYS_FILE, `${JSON.stringify(matrix, null, 2)}\n`);
    if (!options.json) console.log(`已更新 ${JOURNEYS_FILE} 的 meta.coverage.current`);
  }

  if (options.dryRun) process.exit(0);
  process.exit(stats.gateMet ? 0 : 1);
}

main();
