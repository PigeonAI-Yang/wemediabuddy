// WMB-5239 共享 Wiki 发现组件（wiki-discovery-parts.ts / wiki-discovery.tsx）—— renderer 聚焦合同测试。
// 覆盖：对象/事件用户语言映射全量覆盖与禁工程词、时间格式化、日志 locator→深链映射
//   （Scout 风险：source 条目 locator.id 是 revisionId，导航必须取 versionRefs.sourceId）、
//   刷新 scope 门、深链 CustomEvent 契约、竞态防护接线（旧响应不覆盖新查询）、
//   可访问性/四态接线、keyset 分页接线、全 renderer 无重复 IPC/映射、样式 token 合规。
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  WIKI_DISCOVERY_REFRESH_SCOPES,
  WIKI_LOG_PAGE_LIMIT,
  WIKI_MAINTENANCE_EVENT,
  WIKI_NAVIGATE_EVENT,
  WIKI_SEARCH_DEBOUNCE_MS,
  WIKI_SEARCH_PAGE_LIMIT,
  dispatchWikiDeepLink,
  dispatchWikiLogEntry,
  dispatchWikiMaintenance,
  formatWikiWhen,
  shouldRefreshWikiDiscovery,
  wikiLogEntryDeepLinkInput,
  wikiLogEventLabel,
  wikiLogObjectLabel,
  wikiSearchObjectLabel,
} from '../src/renderer/wiki-discovery-parts.ts';

const partsPath = new URL('../src/renderer/wiki-discovery-parts.ts', import.meta.url);
const tsxPath = new URL('../src/renderer/wiki-discovery.tsx', import.meta.url);
const cssPath = new URL('../src/renderer/styles-knowledge.css', import.meta.url);
const rendererDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');

// ---------------------------------------------------------------------------
// 用户语言映射：全量覆盖 + 禁工程词
// ---------------------------------------------------------------------------

const ENGINEERING_WORDS = ['index', 'cursor', 'hot-cache', 'limit', 'offset', 'compiled', 'receipt', 'changeset'];

test('WMB-5239 UI: search object labels cover all six object types with Chinese user language', () => {
  const types = ['wiki_page', 'knowledge_note', 'entity', 'topic', 'source', 'fixed_version_reference'];
  for (const type of types) {
    const label = wikiSearchObjectLabel(type);
    assert.ok(label && label.length > 1, `missing label for ${type}`);
    assert.match(label, /[\u4e00-\u9fff]/, `label for ${type} must contain Chinese: ${label}`);
  }
  assert.equal(wikiSearchObjectLabel('bogus'), '知识对象');
});

test('WMB-5239 UI: log event labels cover all nine event types with Chinese user language', () => {
  const events = [
    'change_set', 'receipt', 'compile', 'lint_detected', 'lint_resolved',
    'maintenance_started', 'maintenance_completed', 'query', 'source',
  ];
  for (const eventType of events) {
    const label = wikiLogEventLabel(eventType);
    assert.ok(label && label.length > 1, `missing label for ${eventType}`);
    assert.match(label, /[\u4e00-\u9fff]/, `label for ${eventType} must contain Chinese: ${label}`);
  }
  assert.equal(wikiLogEventLabel('bogus'), '知识事件');
});

test('WMB-5239 UI: log object labels cover all seven object types with Chinese user language', () => {
  const objects = [
    'change_set', 'receipt', 'wiki_page_version', 'health_issue', 'maintenance_run', 'query_artifact', 'source_revision',
  ];
  for (const objectType of objects) {
    const label = wikiLogObjectLabel(objectType);
    assert.ok(label && label.length > 1, `missing label for ${objectType}`);
    assert.match(label, /[\u4e00-\u9fff]/, `label for ${objectType} must contain Chinese: ${label}`);
  }
  assert.equal(wikiLogObjectLabel('bogus'), '知识对象');
});

test('WMB-5239 UI: labels never leak engineering vocabulary', () => {
  const allLabels = [
    'wiki_page', 'knowledge_note', 'entity', 'topic', 'source', 'fixed_version_reference',
  ].map(wikiSearchObjectLabel).concat(
    ['change_set', 'receipt', 'compile', 'lint_detected', 'lint_resolved', 'maintenance_started', 'maintenance_completed', 'query', 'source'].map(wikiLogEventLabel),
    ['change_set', 'receipt', 'wiki_page_version', 'health_issue', 'maintenance_run', 'query_artifact', 'source_revision'].map(wikiLogObjectLabel),
  );
  for (const label of allLabels) {
    const lower = label.toLowerCase();
    for (const word of ENGINEERING_WORDS) {
      assert.ok(!lower.includes(word), `label "${label}" leaks engineering word "${word}"`);
    }
  }
});

// ---------------------------------------------------------------------------
// 时间格式化
// ---------------------------------------------------------------------------

test('WMB-5239 UI: formatWikiWhen covers empty, invalid, relative and absolute ranges', () => {
  assert.equal(formatWikiWhen(null), '—');
  assert.equal(formatWikiWhen(undefined), '—');
  assert.equal(formatWikiWhen(''), '—');
  assert.equal(formatWikiWhen('not-a-date'), '—');
  assert.equal(formatWikiWhen(new Date().toISOString()), '刚刚');
  assert.equal(formatWikiWhen(new Date(Date.now() - 5 * 60_000).toISOString()), '5 分钟前');
  assert.equal(formatWikiWhen(new Date(Date.now() - 2 * 3_600_000).toISOString()), '2 小时前');
  assert.equal(formatWikiWhen(new Date(Date.now() - 3 * 86_400_000).toISOString()), '3 天前');
  assert.match(formatWikiWhen(new Date(Date.now() - 30 * 86_400_000).toISOString()), /^\d{4}-\d{2}-\d{2}$/);
});

// ---------------------------------------------------------------------------
// 刷新 scope 门
// ---------------------------------------------------------------------------

test('WMB-5239 UI: bounded defaults match shared contract limits', () => {
  assert.equal(WIKI_SEARCH_DEBOUNCE_MS, 260);
  assert.equal(WIKI_SEARCH_PAGE_LIMIT, 20);
  assert.equal(WIKI_LOG_PAGE_LIMIT, 50);
});

test('WMB-5239 UI: refresh scope gate matches knowledge write-surface broadcast contract', () => {
  assert.ok(WIKI_DISCOVERY_REFRESH_SCOPES.includes('knowledge'));
  assert.ok(WIKI_DISCOVERY_REFRESH_SCOPES.includes('topics'));
  assert.ok(WIKI_DISCOVERY_REFRESH_SCOPES.includes('receipt'));
  assert.ok(WIKI_DISCOVERY_REFRESH_SCOPES.includes('health'));
  assert.ok(WIKI_DISCOVERY_REFRESH_SCOPES.includes('library'));
  assert.ok(WIKI_DISCOVERY_REFRESH_SCOPES.includes('sources'));
  assert.ok(WIKI_DISCOVERY_REFRESH_SCOPES.includes('canvas'));
  assert.equal(shouldRefreshWikiDiscovery(undefined), true);
  assert.equal(shouldRefreshWikiDiscovery([]), true);
  assert.equal(shouldRefreshWikiDiscovery(['knowledge']), true);
  assert.equal(shouldRefreshWikiDiscovery(['today', 'publications']), false);
  assert.equal(shouldRefreshWikiDiscovery(['publications']), false);
  assert.equal(shouldRefreshWikiDiscovery(['health', 'receipt']), true);
});

// ---------------------------------------------------------------------------
// 日志 locator → 深链输入（Scout 风险：source 条目用 versionRefs.sourceId）
// ---------------------------------------------------------------------------

const emptyRefs = () => ({ topicIds: [], entityIds: [], sourceIds: [], noteIds: [], wikiPageIds: [] });
const emptyVersionRefs = () => ({
  changeSetId: null, receiptId: null, wikiPageId: null, wikiPageVersionIds: [],
  noteVersionIds: [], healthIssueId: null, sourceId: null, sourceRevisionId: null,
  previousSourceRevisionId: null, maintenanceRunId: null, reportId: null,
});
const entry = (overrides) => ({
  id: 'e:1', eventType: 'source', time: '2026-08-13T00:00:00.000Z', objectType: 'source_revision',
  objectId: 'rev-99', title: '标题', summary: '摘要', scope: null, workspaceId: null, actor: null,
  versionRefs: emptyVersionRefs(), refs: emptyRefs(), locator: { kind: 'source_revision', id: 'rev-99' },
  ...overrides,
});

test('WMB-5239 UI: source log entry navigates by versionRefs.sourceId, never the revision locator id', () => {
  const source = entry({
    objectId: 'rev-99',
    locator: { kind: 'source_revision', id: 'rev-99' },
    versionRefs: { ...emptyVersionRefs(), sourceId: 'src-1', sourceRevisionId: 'rev-99' },
    refs: { ...emptyRefs(), sourceIds: ['src-1'] },
  });
  assert.deepEqual(wikiLogEntryDeepLinkInput(source), { objectType: 'source', objectId: 'src-1' });
});

test('WMB-5239 UI: source log entry falls back to locator id only when sourceId is missing', () => {
  const source = entry({ locator: { kind: 'source_revision', id: 'rev-99' }, versionRefs: emptyVersionRefs() });
  assert.deepEqual(wikiLogEntryDeepLinkInput(source), { objectType: 'source', objectId: 'rev-99' });
});

test('WMB-5239 UI: wiki page version entry navigates by wikiPageId', () => {
  const wiki = entry({
    eventType: 'compile', objectType: 'wiki_page_version',
    locator: { kind: 'wiki_page_version', id: 'wp-1:v-7' },
    versionRefs: { ...emptyVersionRefs(), wikiPageId: 'wp-1', wikiPageVersionIds: ['wp-1:v-7'] },
  });
  assert.deepEqual(wikiLogEntryDeepLinkInput(wiki), { objectType: 'wiki_page', objectId: 'wp-1' });
});

test('WMB-5239 UI: health/change/receipt/query entries pick first ref by wikiPage > note > topic > source > entity', () => {
  const base = {
    eventType: 'lint_detected', objectType: 'health_issue',
    locator: { kind: 'health_issue', id: 'h-1' },
    versionRefs: { ...emptyVersionRefs(), healthIssueId: 'h-1' },
    refs: { topicIds: ['t-1'], entityIds: ['e-1'], sourceIds: ['s-1'], noteIds: ['n-1'], wikiPageIds: ['wp-1'] },
  };
  assert.deepEqual(wikiLogEntryDeepLinkInput(entry(base)), { objectType: 'wiki_page', objectId: 'wp-1' });

  const noteOnly = entry({ ...base, refs: { topicIds: [], entityIds: [], sourceIds: [], noteIds: ['n-1'], wikiPageIds: [] } });
  assert.deepEqual(wikiLogEntryDeepLinkInput(noteOnly), { objectType: 'knowledge_note', objectId: 'n-1' });

  const topicOnly = entry({ eventType: 'change_set', objectType: 'change_set', locator: { kind: 'change_set', id: 'c-1' }, refs: { topicIds: ['t-1'], entityIds: [], sourceIds: [], noteIds: [], wikiPageIds: [] } });
  assert.deepEqual(wikiLogEntryDeepLinkInput(topicOnly), { objectType: 'topic', objectId: 't-1' });

  const entityOnly = entry({ eventType: 'receipt', objectType: 'receipt', locator: { kind: 'receipt', id: 'r-1' }, refs: { topicIds: [], entityIds: ['e-1'], sourceIds: [], noteIds: [], wikiPageIds: [] } });
  assert.deepEqual(wikiLogEntryDeepLinkInput(entityOnly), { objectType: 'entity', objectId: 'e-1' });

  const noRefs = entry({ locator: { kind: 'query_artifact', id: 'q-1' }, refs: emptyRefs() });
  assert.equal(wikiLogEntryDeepLinkInput(noRefs), null);
});

test('WMB-5239 UI: maintenance run entries have no object deep link', () => {
  const run = entry({
    eventType: 'maintenance_completed', objectType: 'maintenance_run',
    locator: { kind: 'maintenance_run', id: 'run-1' },
    versionRefs: { ...emptyVersionRefs(), maintenanceRunId: 'run-1' },
  });
  assert.equal(wikiLogEntryDeepLinkInput(run), null);
});

// ---------------------------------------------------------------------------
// 深链 CustomEvent 契约（复用既有导航机制；Wire 在 main.tsx 注册监听）
// ---------------------------------------------------------------------------

const savedWindow = globalThis.window;

test('WMB-5239 UI: deep link dispatch reuses the documented navigation bridge event', () => {
  const captured = [];
  globalThis.window = { dispatchEvent: (event) => { captured.push(event); return true; } };
  try {
    dispatchWikiDeepLink({
      objectType: 'topic', objectId: 't-1', title: '某主题', route: 'topic', targetType: 'topic_wiki',
      targetId: 'wp-1', hasWiki: true, formalObjectType: null, formalObjectId: null, exists: true,
    });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].type, WIKI_NAVIGATE_EVENT);
    assert.equal(WIKI_NAVIGATE_EVENT, 'wmb-navigate-wiki-object');
    assert.equal(captured[0].detail.payload.objectId, 't-1');
  } finally {
    globalThis.window = savedWindow;
  }
});

test('WMB-5239 UI: maintenance dispatch uses the library maintenance panel event', () => {
  const captured = [];
  globalThis.window = { dispatchEvent: (event) => { captured.push(event); return true; } };
  try {
    dispatchWikiMaintenance('run-9');
    assert.equal(captured.length, 1);
    assert.equal(captured[0].type, WIKI_MAINTENANCE_EVENT);
    assert.equal(WIKI_MAINTENANCE_EVENT, 'wmb-open-library-maintenance');
    assert.equal(captured[0].detail.runId, 'run-9');
  } finally {
    globalThis.window = savedWindow;
  }
});

test('WMB-5239 UI: log entry dispatch routes maintenance events to the maintenance panel without IPC', () => {
  const captured = [];
  globalThis.window = {
    dispatchEvent: (event) => { captured.push(event); return true; },
    wmb: { resolveKnowledgeDeepLink: async () => { throw new Error('must not be called'); } },
  };
  try {
    const run = entry({
      eventType: 'maintenance_started', objectType: 'maintenance_run',
      locator: { kind: 'maintenance_run', id: 'run-2' },
      versionRefs: { ...emptyVersionRefs(), maintenanceRunId: 'run-2' },
    });
    return dispatchWikiLogEntry(run).then(() => {
      assert.equal(captured.length, 1);
      assert.equal(captured[0].type, WIKI_MAINTENANCE_EVENT);
      assert.equal(captured[0].detail.runId, 'run-2');
    });
  } finally {
    globalThis.window = savedWindow;
  }
});

test('WMB-5239 UI: log entry dispatch resolves locator then navigates for object entries', async () => {
  const captured = [];
  globalThis.window = {
    dispatchEvent: (event) => { captured.push(event); return true; },
    wmb: {
      resolveKnowledgeDeepLink: async (input) => ({
        objectType: input.objectType, objectId: input.objectId, title: '资料',
        route: 'library', targetType: 'source', targetId: 'src-1', hasWiki: false,
        formalObjectType: null, formalObjectId: null, exists: true,
      }),
    },
  };
  try {
    const source = entry({
      locator: { kind: 'source_revision', id: 'rev-99' },
      versionRefs: { ...emptyVersionRefs(), sourceId: 'src-1', sourceRevisionId: 'rev-99' },
      refs: { ...emptyRefs(), sourceIds: ['src-1'] },
    });
    await dispatchWikiLogEntry(source);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].type, WIKI_NAVIGATE_EVENT);
    assert.equal(captured[0].detail.payload.targetId, 'src-1');
  } finally {
    globalThis.window = savedWindow;
  }
});

// ---------------------------------------------------------------------------
// 纯逻辑源码接线：竞态防护、keyset 分页、可选链订阅
// ---------------------------------------------------------------------------

test('WMB-5239 UI: hooks guard stale responses so old queries cannot overwrite new ones', async () => {
  const parts = await readFile(partsPath, 'utf8');
  const guards = parts.match(/requestSeq !== seq\.current/g) ?? [];
  assert.ok(guards.length >= 4, `expected seq guard in search, log first-load, load-more and cleanup, found ${guards.length}`);
  assert.match(parts, /window\.wmb\?\.onDataChanged/, 'data_changed subscription must use optional chaining');
  assert.match(parts, /\.\.\.\(before \? \{ before \} : \{\}\)/, 'log pagination must use keyset before cursor');
  assert.match(parts, /seen\.has\(entry\.id\)/, 'load-more must dedupe against inserted entries');
  assert.match(parts, /searchWikiIndex/, 'search IPC single-sourced in shared hook');
  assert.match(parts, /listKnowledgeLogEntries/, 'log IPC single-sourced in shared hook');
  assert.match(parts, /getWikiIndexSummary/, 'index summary IPC single-sourced in shared hook');
});

// ---------------------------------------------------------------------------
// 组件接线：可访问性、四态、默认深链
// ---------------------------------------------------------------------------

test('WMB-5239 UI: panels provide accessible label, keyboard, focus and loading/empty/error/retry states', async () => {
  const tsx = await readFile(tsxPath, 'utf8');
  assert.match(tsx, /aria-label=\{label\}/, 'search input must expose an accessible label');
  assert.match(tsx, /type="search"/, 'search uses native search input');
  assert.match(tsx, /role="status"[\s\S]*?aria-live="polite"/, 'results count must be announced politely');
  assert.match(tsx, /aria-busy=\{search\.loading \|\| search\.refreshing\}/, 'results region busy state');
  assert.match(tsx, /event\.key === 'Escape'/, 'Escape clears the search query');
  assert.match(tsx, /event\.key === 'ArrowDown'/, 'ArrowDown moves focus into results');
  assert.match(tsx, /role="alert"/, 'error state uses alert role');
  assert.match(tsx, />重试<\/button>/, 'error state offers a visible retry action');
  assert.match(tsx, /正在搜索…/, 'loading state is observable');
  assert.match(tsx, /dispatchWikiDeepLink\(result\.navigation\)/, 'default result click deep links via shared dispatch');
  assert.match(tsx, /dispatchWikiLogEntry\(entry\)/, 'default log click dispatches via shared handler');
  assert.match(tsx, /loadMore/, 'log panel exposes load-more pagination');
});

// ---------------------------------------------------------------------------
// 无重复 IPC/映射：全 renderer 仅共享模块调用搜索/日志 IPC
// ---------------------------------------------------------------------------

test('WMB-5239 UI: no other renderer file calls wiki search/log IPC or re-implements the mapping', async () => {
  const files = (await readdir(rendererDir)).filter((name) => /\.(ts|tsx)$/.test(name));
  const directIpc = /searchWikiIndex|listKnowledgeLogEntries|getWikiIndexSummary|getWikiHotCache|getKnowledgeLogEntry/;
  for (const name of files) {
    if (name === 'global.d.ts' || name === 'wiki-discovery.tsx' || name === 'wiki-discovery-parts.ts') continue;
    const content = await readFile(path.join(rendererDir, name), 'utf8');
    assert.ok(!directIpc.test(content), `${name} must consume shared discovery hooks instead of calling search/log IPC directly`);
  }
});

test('WMB-5239 UI: shared module reuses shared contract types (no second naming)', async () => {
  const parts = await readFile(partsPath, 'utf8');
  assert.match(parts, /from '\.\.\/shared\/knowledge-search(\.ts)?'/, 'reuses WikiSearchFilter/WikiSearchResult contract');
  assert.match(parts, /from '\.\.\/shared\/knowledge-global-log(\.ts)?'/, 'reuses KnowledgeLogEntry/ReadFilter contract');
  assert.match(parts, /from '\.\.\/shared\/knowledge-topic-library(\.ts)?'/, 'reuses KnowledgeDeepLink contract');
});

// ---------------------------------------------------------------------------
// 样式：发现面板块仅 foundation 变量（无新 hex/rgb/hsl）
// ---------------------------------------------------------------------------

test('WMB-5239 UI: discovery styles use only foundation tokens (no new color literals)', async () => {
  const css = await readFile(cssPath, 'utf8');
  const blockStart = css.indexOf('/* WMB-5239 wiki discovery');
  assert.ok(blockStart >= 0, 'discovery style block must be present in styles-knowledge.css');
  const block = css.slice(blockStart);
  const literals = block.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]+\)|\bhsla?\([^)]+\)/g) ?? [];
  assert.deepEqual(literals, [], `discovery styles must not introduce color literals: ${literals.join(', ')}`);
  assert.match(block, /prefers-reduced-motion/, 'discovery styles honor reduced motion');
  assert.match(block, /focus-visible/, 'discovery styles expose visible focus');
});
