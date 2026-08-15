// WMB-5239 资料库全库整理 UI —— renderer 聚焦合同测试。
// 覆盖：library-maintenance-parts 纯函数（阶段/状态用户语言、批量摄取反馈、健康检查摘要、
//   失败项 code→用户语言、后端消息工程词清洗、整理报告汇总）与渲染层接线（library-view.tsx
//   原位渲染 LibraryWikiTools、维护控件仅限资料库、有界轮询 ≥10s、data_changed 订阅、
//   统一搜索/最近变化复用共享 wiki-discovery 面板、样式仅 foundation 变量、无工程词）。
// 运行：node --test --test-concurrency=1 tests/wmb-5239-library-maintenance-ui.test.mjs
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  MAINTENANCE_PHASE_ORDER,
  MAINTENANCE_POLL_INTERVAL_MS,
  maintenanceFailureLabel,
  maintenanceIngestionSummary,
  maintenanceIngestionText,
  maintenanceLintText,
  maintenancePhaseIndex,
  maintenancePhaseLabel,
  maintenanceReportSummary,
  maintenanceStatusCls,
  maintenanceStatusLabel,
  maintenanceUserText,
} from '../src/renderer/library-maintenance-parts.ts';

const partsPath = new URL('../src/renderer/library-maintenance-parts.ts', import.meta.url);
const tsxPath = new URL('../src/renderer/library-maintenance.tsx', import.meta.url);
const viewPath = new URL('../src/renderer/library-view.tsx', import.meta.url);
const cssPath = new URL('../src/renderer/styles-workflow-library.css', import.meta.url);
const rendererDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');

const ENGINEERING_WORDS = ['index', 'cursor', 'hot-cache', 'limit', 'offset', 'compiled', 'receipt', 'changeset', 'scan_compile', 'lint', 'phase'];

// ---------------------------------------------------------------------------
// 阶段/状态用户语言：全量覆盖 + 禁工程词
// ---------------------------------------------------------------------------

test('WMB-5239 UI: phase labels cover the fixed order with Chinese user language', () => {
  assert.deepEqual([...MAINTENANCE_PHASE_ORDER], ['scan_compile', 'lint', 'report', 'completed']);
  const labels = MAINTENANCE_PHASE_ORDER.map((phase) => maintenancePhaseLabel(phase));
  assert.deepEqual(labels, ['整理资料', '检查健康', '生成报告', '已完成']);
  for (const label of labels) assert.match(label, /[\u4e00-\u9fff]/, `label must be Chinese: ${label}`);
  assert.equal(maintenancePhaseLabel(null), '未开始');
  assert.equal(maintenancePhaseLabel('bogus'), '未开始', 'unknown phase must not echo engineering name');
});

test('WMB-5239 UI: phase index orders the fixed phases 0..3', () => {
  assert.equal(maintenancePhaseIndex('scan_compile'), 0);
  assert.equal(maintenancePhaseIndex('lint'), 1);
  assert.equal(maintenancePhaseIndex('report'), 2);
  assert.equal(maintenancePhaseIndex('completed'), 3);
  assert.equal(maintenancePhaseIndex(null), 0);
  assert.equal(maintenancePhaseIndex('bogus'), 0);
});

test('WMB-5239 UI: status labels cover all run states with Chinese user language', () => {
  assert.equal(maintenanceStatusLabel('running'), '整理中');
  assert.equal(maintenanceStatusLabel('paused'), '已暂停');
  assert.equal(maintenanceStatusLabel('completed'), '已完成');
  assert.equal(maintenanceStatusLabel('failed'), '失败');
  assert.equal(maintenanceStatusLabel(null), '未开始');
  assert.equal(maintenanceStatusLabel('bogus'), '未开始');
});

test('WMB-5239 UI: status classes map to existing pill-status semantics only', () => {
  assert.equal(maintenanceStatusCls('running'), 'blue');
  assert.equal(maintenanceStatusCls('paused'), 'amber');
  assert.equal(maintenanceStatusCls('failed'), 'amber');
  assert.equal(maintenanceStatusCls('completed'), 'green');
  assert.equal(maintenanceStatusCls(null), 'gray');
  assert.equal(maintenanceStatusCls('bogus'), 'gray');
});

// ---------------------------------------------------------------------------
// 批量摄取反馈（成功/低价值保留原始资料/失败原因）
// ---------------------------------------------------------------------------

test('WMB-5239 UI: ingestion summary maps checkpoint counts to success/kept-raw/failure', () => {
  const summary = maintenanceIngestionSummary({
    compiled: 5, skippedWeak: 1, skippedNoTopic: 2, skippedNoSignal: 3, failed: 2,
    scanned: 20, pendingRetry: ['s-1', 's-2'],
  });
  assert.equal(summary.success, 5);
  assert.equal(summary.keptRaw, 6, 'weak + no-topic + no-signal are the low-value kept-raw pool');
  assert.equal(summary.failed, 2);
  assert.equal(summary.retry, 2);
  assert.equal(summary.scanned, 20);
  assert.deepEqual(maintenanceIngestionSummary(null), { success: 0, keptRaw: 0, failed: 0, retry: 0, scanned: 0 });
  assert.deepEqual(maintenanceIngestionSummary({ compiled: 3 }), { success: 3, keptRaw: 0, failed: 0, retry: 0, scanned: 0 });
});

test('WMB-5239 UI: ingestion text is user language without engineering terms', () => {
  const text = maintenanceIngestionText({ success: 5, keptRaw: 6, failed: 2, retry: 2, scanned: 20 });
  assert.equal(text, '成功整理 5 条 · 低价值保留原始 6 条 · 失败 2 条 · 2 条待重试');
  const lower = text.toLowerCase();
  for (const word of ENGINEERING_WORDS) assert.ok(!lower.includes(word), `ingestion text leaks "${word}": ${text}`);
});

test('WMB-5239 UI: lint text summarizes health checks in user language', () => {
  assert.equal(maintenanceLintText({ scannedObjects: 12, issuesCreated: 3, repairsApplied: 2, openIssues: 1 }),
    '检查对象 12 · 发现问题 3 · 自动修复 2 · 未解决 1');
  assert.equal(maintenanceLintText(null), '检查对象 0 · 未解决 0');
  assert.equal(maintenanceLintText({ scannedObjects: 8, issuesCreated: 0, repairsApplied: 0, openIssues: 0 }),
    '检查对象 8 · 未解决 0');
});

// ---------------------------------------------------------------------------
// 失败项：code → 用户语言；后端消息清洗
// ---------------------------------------------------------------------------

test('WMB-5239 UI: failure codes map to Chinese user language, unknown never echoed', () => {
  assert.equal(maintenanceFailureLabel('MAINTENANCE_BACKFILL_STALLED'), '整理停滞（连续多批没有进展）');
  assert.equal(maintenanceFailureLabel('MAINTENANCE_UNEXPECTED'), '整理过程出现意外错误');
  assert.equal(maintenanceFailureLabel('MAINTENANCE_WORKSPACE_MISMATCH'), '整理任务与当前工作空间不匹配');
  assert.equal(maintenanceFailureLabel('bogus'), '整理失败');
  assert.equal(maintenanceFailureLabel(null), '整理失败');
});

test('WMB-5239 UI: backend risk/failure messages are sanitized into user language', () => {
  const cases = [
    ['3 个 Source 仍待重试：abc、def。请修复后 resume。', '3 个 资料 仍待重试：abc、def。请修复后 继续。'],
    ['Lint 共创建 2 个健康 Issue。', '健康检查 共创建 2 个健康 问题。'],
    ['2 个 Source 因弱资料/无活跃 Topic/无价值信号保持 Raw（未编译）。', '2 个 资料 因弱资料/无活跃 主题/无价值信号保持 原始资料。'],
    ['回溯编译连续 3 批无进展，仍有 2 个 Source 待重试。', '回溯编译连续 3 批无进展，仍有 2 个 资料 待重试。'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(maintenanceUserText(input), expected, `sanitize: ${input}`);
  }
  assert.equal(maintenanceUserText(null), '');
  assert.equal(maintenanceUserText('普通中文消息。'), '普通中文消息。');
  const sanitized = maintenanceUserText('3 个 Source 仍待重试：abc。请修复后 resume。');
  const lower = sanitized.toLowerCase();
  for (const word of ['source', 'lint', 'issue', 'resume', 'raw']) {
    assert.ok(!lower.includes(word), `sanitized text still leaks "${word}": ${sanitized}`);
  }
});

// ---------------------------------------------------------------------------
// 整理报告汇总
// ---------------------------------------------------------------------------

test('WMB-5239 UI: report summary derives changed count and passes failures/risks through', () => {
  const summary = maintenanceReportSummary({
    changedSources: ['s-1', 's-2', 's-3'],
    failures: [{ code: 'MAINTENANCE_UNEXPECTED', message: '出错' }],
    risks: ['1 个 Source 仍待重试。'],
  });
  assert.equal(summary.changed, 3);
  assert.equal(summary.failures.length, 1);
  assert.equal(summary.risks.length, 1);
  assert.deepEqual(maintenanceReportSummary(null), { changed: 0, failures: [], risks: [] });
  assert.deepEqual(maintenanceReportSummary({ changedSources: ['s-1'] }).changed, 1);
});

// ---------------------------------------------------------------------------
// 渲染层接线：原位入口、维护控件仅资料库、有界轮询、共享面板复用
// ---------------------------------------------------------------------------

test('WMB-5239 UI: library-view renders the in-place wiki tools after the tabs', async () => {
  const view = await readFile(viewPath, 'utf8');
  assert.match(view, /import \{ LibraryWikiTools \} from '\.\/library-maintenance'/, 'library-view must import LibraryWikiTools');
  const renderCount = view.split('<LibraryWikiTools />').length - 1;
  assert.equal(renderCount, 1, 'exactly one in-place tools mount');
  const tabsIndex = view.indexOf('</nav>');
  const toolsIndex = view.indexOf('<LibraryWikiTools />');
  assert.ok(toolsIndex > tabsIndex, 'tools mount must sit after the section tabs nav');
});

test('WMB-5239 UI: maintenance controls live only in the library view (topic/canvas untouched)', async () => {
  const files = (await readdir(rendererDir)).filter((name) => /\.(ts|tsx)$/.test(name));
  for (const name of files) {
    // global.d.ts 是 preload 类型面（声明方法签名），不是 UI 控件；其余文件不得出现维护执行入口。
    if (name === 'library-maintenance.tsx' || name === 'library-maintenance-parts.ts' || name === 'global.d.ts') continue;
    const content = await readFile(path.join(rendererDir, name), 'utf8');
    assert.ok(!content.includes('startKnowledgeMaintenance'), `${name} must not offer maintenance start control`);
    assert.ok(!content.includes('pauseKnowledgeMaintenance'), `${name} must not offer maintenance pause control`);
  }
});

test('WMB-5239 UI: polling is bounded at >=10s and cleaned up on non-running/unmount', async () => {
  assert.ok(MAINTENANCE_POLL_INTERVAL_MS >= 10_000, 'polling cadence must be at least the scheduler interval');
  const tsx = await readFile(tsxPath, 'utf8');
  assert.match(tsx, /window\.setInterval\([\s\S]*?MAINTENANCE_POLL_INTERVAL_MS/, 'bounded polling interval uses the shared constant');
  assert.match(tsx, /window\.clearInterval\(timer\)/, 'poll timer must be cleared on status change/unmount');
  assert.match(tsx, /if \(!running\) return;/, 'polling must only run while status is running');
  assert.match(tsx, /api\?\.onDataChanged/, 'data_changed subscription must use optional chaining');
  assert.match(tsx, /shouldRefreshLibrary\(event\.scopes\)/, 'data_changed refresh reuses the library scope gate');
});

test('WMB-5239 UI: unified search and recent changes reuse shared wiki-discovery panels', async () => {
  const tsx = await readFile(tsxPath, 'utf8');
  assert.match(tsx, /import \{[^}]*WikiSearchPanel[^}]*\} from '\.\/wiki-discovery'/, 'unified search entry consumes the shared search panel');
  assert.match(tsx, /import \{[^}]*KnowledgeLogPanel[^}]*\} from '\.\/wiki-discovery'/, 'recent changes entry consumes the shared log panel');
  assert.match(tsx, /<WikiSearchPanel compact \/>/, 'search panel mounted compact');
  assert.match(tsx, /<KnowledgeLogPanel compact \/>/, 'log panel mounted compact');
  assert.match(tsx, /WIKI_MAINTENANCE_EVENT/, 'log maintenance entry can locate the library maintenance panel');
});

test('WMB-5239 UI: maintenance UI copy is user language, no engineering vocabulary', async () => {
  const tsx = await readFile(tsxPath, 'utf8');
  for (const copy of ['全库整理', '搜索全部资料', '最近变化', '整理报告', '失败项', '暂停', '继续', '开始全库整理', '批量摄取反馈', '成功整理', '低价值保留原始', '待重试']) {
    assert.ok(tsx.includes(copy), `missing user copy: ${copy}`);
  }
  // 仅检查用户可见文案：剥除注释（/*…*/ 与 //…）；data-* 属性与内部常量是测试接缝，
  // 不属于用户语言（E2E 需要 data-maintenance-phase 等稳定选择器）。
  const noComments = tsx.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const lower = noComments.toLowerCase();
  for (const word of ['compiled', 'changeset', 'hot-cache', 'scan_compile', 'checkpoint', 'receipt']) {
    assert.ok(!lower.includes(word), `maintenance UI leaks engineering term "${word}"`);
  }
});

test('WMB-5239 UI: library maintenance styles use only foundation tokens', async () => {
  const css = await readFile(cssPath, 'utf8');
  const blockStart = css.indexOf('WMB-5239 资料库全库工具');
  assert.ok(blockStart >= 0, 'library tools style block must be present in styles-workflow-library.css');
  const block = css.slice(blockStart);
  const literals = block.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]+\)|\bhsla?\([^)]+\)/g) ?? [];
  assert.deepEqual(literals, [], `library tools styles must not introduce color literals: ${literals.join(', ')}`);
  assert.match(block, /prefers-reduced-motion/, 'library tools styles honor reduced motion');
  assert.match(block, /focus-visible/, 'library tools expose visible focus');
  assert.match(block, /var\(--/, 'library tools styles consume foundation variables');
});
