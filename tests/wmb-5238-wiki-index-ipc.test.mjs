// WMB-5238：统一全文搜索 / 索引摘要 / 有界 hot cache / 全局时间日志的 IPC 接线聚焦测试
// （本 worker：WireWikiSearchIpc）。
// 覆盖：
// - shared 通道常量冻结且有界（3 搜索 + 2 日志；无 execute/raw/sql 写面通道）；
// - main 注册（registerWikiIndexIpc）逐通道注册且复用 shared 常量（单源命名）；
//   registerKnowledgeContentIpc 聚合调用（接线不遗漏）；
// - preload 逐通道引用同一共享常量恰好一次；无内联第二套通道字符串；入参纯透传；
// - renderer global.d.ts 类型面与 preload 方法对齐；
// - 功能面：真实 migrateDatabase（migration 63）→ 捕获注册 handler → 调用返回统一契约
//   （分页信封 / 摘要 / hot cache 状态 / keyset 日志页）；空查询空结果；非法游标 fail-closed；
//   无 data-root 诚实空态。
// 运行：node --test --test-concurrency=1 tests/wmb-5238-wiki-index-ipc.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';

// ---- 测试本地 ESM 解析钩子：electron → 捕获型 ipcMain 桩；相对无扩展名补 .ts ----
const CAPTURED = new Map();
const ELECTRON_STUB = [
  'const noop = () => {};',
  'const ipcMain = {',
  '  handle(channel, fn) { globalThis.__wmbIpcHandlers.set(channel, fn); },',
  '  on: noop, removeHandler: noop, removeAllListeners: noop',
  '};',
  'export { ipcMain };',
  'export default { ipcMain };',
].join('\n');
const HOOK_SOURCE = [
  "const { existsSync } = process.getBuiltinModule('node:fs');",
  "const path = process.getBuiltinModule('node:path');",
  "const { fileURLToPath, pathToFileURL } = process.getBuiltinModule('node:url');",
  'const ELECTRON_STUB = ' + JSON.stringify(ELECTRON_STUB) + ';',
  'export async function resolve(specifier, context, nextResolve) {',
  "  if (specifier === 'electron') return { url: 'data:text/javascript,' + encodeURIComponent(ELECTRON_STUB), shortCircuit: true };",
  "  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !path.extname(specifier)) {",
  '    const base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);',
  "    for (const ext of ['.ts', '.mts', '.cts']) {",
  '      const candidate = base + ext;',
  '      if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };',
  '    }',
  '  }',
  '  return nextResolve(specifier, context);',
  '}',
].join('\n');
register('data:text/javascript,' + encodeURIComponent(HOOK_SOURCE), import.meta.url);
globalThis.__wmbIpcHandlers = CAPTURED;

const { WIKI_SEARCH_READ_IPC_CHANNELS } = await import('../src/shared/knowledge-search.ts');
const { KNOWLEDGE_GLOBAL_LOG_READ_IPC_CHANNELS } = await import('../src/shared/knowledge-global-log.ts');
const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { upsertIndexEntries } = await import('../src/main/db/wiki-index-store.ts');
const { registerWikiIndexIpc, WIKI_INDEX_IPC_CHANNELS } = await import('../src/main/ipc-wiki-index.ts');

const PRELOAD_PATH = new URL('../src/preload/preload.ts', import.meta.url);
const GLOBALS_PATH = new URL('../src/renderer/global.d.ts', import.meta.url);

/** 冻结只读通道清单（WMB-5238：3 搜索 + 2 日志；无写面）。 */
const FROZEN_CHANNELS = [
  'knowledge-index:search',
  'knowledge-index:summary',
  'knowledge-index:hot-cache',
  'knowledge-global-log:list',
  'knowledge-global-log:get'
];

// ============================================================
// 1. shared 通道契约：冻结、有界、前缀不变量、无内部 SQL/写面
// ============================================================

test('WMB-5238 shared channel contract: frozen, bounded, prefix invariant, no write/raw channels', () => {
  const allChannels = [
    ...Object.values(WIKI_SEARCH_READ_IPC_CHANNELS),
    ...Object.values(KNOWLEDGE_GLOBAL_LOG_READ_IPC_CHANNELS)
  ];
  assert.deepEqual([...allChannels].sort(), [...FROZEN_CHANNELS].sort(), '通道全集必须与冻结清单一致');
  assert.equal(new Set(allChannels).size, allChannels.length, '通道名不得重复');
  for (const channel of allChannels) {
    assert.match(channel, /^knowledge-(?:index|global-log):/, `通道前缀不变量: ${channel}`);
    assert.doesNotMatch(channel, /sql|raw|execute|exec|rebuild|write|db/i, `禁止写面/内部通道: ${channel}`);
  }
  // 无孤儿通道：IPC 注册聚合常量与 shared 常量一致。
  assert.deepEqual([...WIKI_INDEX_IPC_CHANNELS].sort(), [...allChannels].sort());
});

// ============================================================
// 2. main 注册：逐通道注册且复用 shared 常量；聚合调用接线
// ============================================================

test('WMB-5238 main registers every channel via shared constants; content aggregation calls it', async () => {
  const ipcSource = await readFile(new URL('../src/main/ipc-wiki-index.ts', import.meta.url), 'utf8');
  const contentSource = await readFile(new URL('../src/main/ipc-knowledge-content.ts', import.meta.url), 'utf8');

  for (const [key, channel] of Object.entries(WIKI_SEARCH_READ_IPC_CHANNELS)) {
    assert.ok(ipcSource.includes(`WIKI_SEARCH_READ_IPC_CHANNELS.${key}`), `搜索通道 ${channel} 必须经共享常量注册`);
    assert.ok(!ipcSource.includes(`'${channel}'`), `不得内联搜索通道字符串: ${channel}`);
  }
  for (const [key, channel] of Object.entries(KNOWLEDGE_GLOBAL_LOG_READ_IPC_CHANNELS)) {
    assert.ok(ipcSource.includes(`KNOWLEDGE_GLOBAL_LOG_READ_IPC_CHANNELS.${key}`), `日志通道 ${channel} 必须经共享常量注册`);
    assert.ok(!ipcSource.includes(`'${channel}'`), `不得内联日志通道字符串: ${channel}`);
  }
  // 聚合接线：registerKnowledgeContentIpc 调用 registerWikiIndexIpc。
  assert.ok(contentSource.includes('registerWikiIndexIpc(dependencies)'), 'registerKnowledgeContentIpc 必须调用 registerWikiIndexIpc');
});

// ============================================================
// 3. preload：逐通道引用同一共享常量恰好一次；无内联字符串；入参纯透传
// ============================================================

test('WMB-5238 preload wires every shared channel exactly once via shared constants', async () => {
  const preload = await readFile(PRELOAD_PATH, 'utf8');
  const invokes = [
    [WIKI_SEARCH_READ_IPC_CHANNELS.search, 'WIKI_SEARCH_READ_IPC_CHANNELS.search', 'searchWikiIndex', 'input'],
    [WIKI_SEARCH_READ_IPC_CHANNELS.summary, 'WIKI_SEARCH_READ_IPC_CHANNELS.summary', 'getWikiIndexSummary', null],
    [WIKI_SEARCH_READ_IPC_CHANNELS.hotCache, 'WIKI_SEARCH_READ_IPC_CHANNELS.hotCache', 'getWikiHotCache', null],
    [KNOWLEDGE_GLOBAL_LOG_READ_IPC_CHANNELS.list, 'KNOWLEDGE_GLOBAL_LOG_READ_IPC_CHANNELS.list', 'listKnowledgeLogEntries', 'input'],
    [KNOWLEDGE_GLOBAL_LOG_READ_IPC_CHANNELS.get, 'KNOWLEDGE_GLOBAL_LOG_READ_IPC_CHANNELS.get', 'getKnowledgeLogEntry', 'id']
  ];
  for (const [channel, expression, method, arg] of invokes) {
    const reference = arg === null
      ? `ipcRenderer.invoke(${expression})`
      : `ipcRenderer.invoke(${expression}, ${arg})`;
    const occurrences = preload.split(reference).length - 1;
    assert.equal(occurrences, 1, `${channel} (${method}) 应恰好接线一次，实际 ${occurrences}`);
    assert.ok(!preload.includes(`'${channel}'`), `不得内联通道字符串: ${channel}`);
    assert.ok(preload.includes(`${method}: (`), `preload 应暴露 ${method}`);
  }
  // 无孤儿通道：共享清单之外不得出现 knowledge-index:/knowledge-global-log: 通道字符串。
  const orphanMatches = preload.match(/'(knowledge-index|knowledge-global-log):[^']*'/g) ?? [];
  assert.deepEqual(orphanMatches, [], `preload 不应出现共享清单之外的通道: ${orphanMatches.join(', ')}`);
  // 纯透传：无默认值/类型判断/清洗。
  for (const line of preload.split('\n')) {
    if (line.includes('WIKI_SEARCH_READ_IPC_CHANNELS.') || line.includes('KNOWLEDGE_GLOBAL_LOG_READ_IPC_CHANNELS.')) {
      assert.doesNotMatch(line, /\?\?|typeof|\.trim\(|Array\.isArray/, `preload 不得猜测/校验参数: ${line.trim()}`);
    }
  }
});

// ============================================================
// 4. renderer global.d.ts：方法面与 preload 对齐
// ============================================================

test('WMB-5238 renderer global.d.ts declares the preload methods with shared types', async () => {
  const globals = await readFile(GLOBALS_PATH, 'utf8');
  for (const method of ['searchWikiIndex', 'getWikiIndexSummary', 'getWikiHotCache', 'listKnowledgeLogEntries', 'getKnowledgeLogEntry']) {
    assert.ok(globals.includes(`${method}(`), `global.d.ts 必须声明 ${method}`);
  }
  assert.ok(globals.includes("from '../shared/knowledge-search'"), '类型面必须消费知识搜索共享类型');
  assert.ok(globals.includes("from '../shared/knowledge-global-log'"), '类型面必须消费全局日志共享类型');
  assert.doesNotMatch(globals, /knowledge-index:|knowledge-global-log:/, '类型面不持有通道字符串');
});

// ============================================================
// 5. 功能面：真实迁移 DB → 捕获 handler → 统一契约
// ============================================================

async function makeDatabase() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5238-ipc-'));
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  return { root, database };
}

/** 捕获型注册：handlers Map 中每个通道可被直接调用（等同 ipcMain.handle 注册面）。 */
function captureRegistration(dependencies) {
  CAPTURED.clear();
  registerWikiIndexIpc(dependencies);
  const handlers = Object.fromEntries(CAPTURED.entries());
  assert.deepEqual(Object.keys(handlers).sort(), [...FROZEN_CHANNELS].sort(), '注册面必须覆盖全部冻结通道');
  return handlers;
}

const noRootDeps = {
  loadSelectedDataRoot: async () => null,
  migrate: (root) => root,
  getActiveRuntime: () => null
};

test('WMB-5238 IPC functional: search/summary/hot-cache/log return unified contracts on real DB', async () => {
  const { root, database } = await makeDatabase();
  try {
    const deps = {
      loadSelectedDataRoot: async () => null,
      migrate: (value) => value,
      getActiveRuntime: () => ({ database, identity: { workspaceId: 'ws-5238' } })
    };
    const handlers = captureRegistration(deps);

    // 种子：一条 topic 索引 + 一条 wiki_page 固定版本引用（直接经 store upsert，模拟投影结果）。
    const now = new Date().toISOString();
    upsertIndexEntries(database, [
      {
        objectType: 'topic',
        objectId: 'topic-1',
        versionRef: 'topic-1:r1',
        title: 'AI 自媒体选题方法',
        summary: '基于真实数据的选择方法',
        searchableText: 'AI 自媒体选题方法 基于真实数据的选择方法',
        scope: 'global',
        updatedAt: now,
        navObjectType: 'topic',
        navObjectId: 'topic-1'
      },
      {
        objectType: 'wiki_page',
        objectId: 'page-1',
        versionRef: 'wiki_page:page-1:ver-1',
        title: '知识飞轮设计',
        summary: 'SQLite 唯一真源',
        searchableText: '知识飞轮设计 SQLite 唯一真源 索引与日志',
        topicIds: ['topic-1'],
        scope: 'global',
        updatedAt: now,
        navObjectType: 'wiki_page',
        navObjectId: 'page-1'
      }
    ], false);

    // search：命中 + 统一契约字段（对象类型/稳定ID/固定版本/标题/片段/更新时间/导航）。
    const page = await handlers[WIKI_SEARCH_READ_IPC_CHANNELS.search]({}, { query: '选题', limit: 10 });
    assert.equal(page.ok ?? true, true);
    assert.equal(page.total, 1, '仅 topic 命中「选题」');
    assert.equal(page.items.length, 1);
    assert.equal(page.limit, 10);
    assert.equal(page.offset, 0);
    assert.equal(page.hasMore, false);
    assert.equal(page.cursor, null);
    const hit = page.items[0];
    assert.equal(hit.objectType, 'topic');
    assert.equal(hit.objectId, 'topic-1');
    assert.equal(hit.versionRef, 'topic-1:r1');
    assert.ok(hit.title.includes('选题'));
    assert.ok(typeof hit.snippet === 'string' && hit.snippet.length > 0);
    assert.ok(hit.updatedAt);
    assert.equal(hit.navigation.objectType, 'topic');
    assert.equal(hit.navigation.objectId, 'topic-1');

    // 空查询 → 空结果 total 0（契约语义，非全量分页）。
    const empty = await handlers[WIKI_SEARCH_READ_IPC_CHANNELS.search]({}, { query: '   ', limit: 10 });
    assert.equal(empty.total, 0);
    assert.deepEqual(empty.items, []);
    assert.equal(empty.hasMore, false);

    // 非法游标 → fail-closed 抛错（不回退为空页）。
    await assert.rejects(
      handlers[WIKI_SEARCH_READ_IPC_CHANNELS.search]({}, { query: '选题', cursor: 'not-a-cursor' }),
      (error) => error?.code === 'INVALID_CURSOR' || /INVALID_CURSOR/.test(String(error?.message ?? error))
    );

    // 非法 limit 类型 → fail-closed；越界 limit 钳制到 [1,100]。
    await assert.rejects(
      handlers[WIKI_SEARCH_READ_IPC_CHANNELS.search]({}, { query: '选题', limit: 'abc' }),
      (error) => error?.code === 'INVALID_INPUT' || /INVALID_INPUT/.test(String(error?.message ?? error))
    );
    const clamped = await handlers[WIKI_SEARCH_READ_IPC_CHANNELS.search]({}, { query: '选题', limit: 0 });
    assert.equal(clamped.limit, 1, 'limit 越界钳制到 1');

    // summary：counts 按类型 + total + 索引时间。
    const summary = await handlers[WIKI_SEARCH_READ_IPC_CHANNELS.summary]({});
    assert.equal(summary.total, 2);
    assert.equal(summary.counts.topic, 1);
    assert.equal(summary.counts.wiki_page, 1);
    assert.equal(summary.counts.knowledge_note, 0);
    assert.ok(summary.updatedAt);
    assert.ok(typeof summary.rebuiltAt === 'string' || summary.rebuiltAt === null);

    // hot cache：有界 + 等价摘要（非真源）。
    const hot = await handlers[WIKI_SEARCH_READ_IPC_CHANNELS.hotCache]({});
    assert.equal(hot.maxEntries, 500);
    assert.equal(hot.entryCount, 2);
    assert.equal(hot.summary.total, 2);
    assert.equal(typeof hot.cached, 'boolean');

    // global log：list 返回 keyset 分页信封；get 单条可导航。
    const logPage = await handlers[KNOWLEDGE_GLOBAL_LOG_READ_IPC_CHANNELS.list]({}, { limit: 50 });
    assert.equal(logPage.total, 0, '种子未产生日志事件（投影为 0 条是诚实空态）');
    assert.deepEqual(logPage.items, []);
    assert.equal(logPage.limit, 50);
    assert.equal(logPage.before, null);
    assert.equal(logPage.after, null);
    assert.equal(logPage.hasMore, false);
    const entry = await handlers[KNOWLEDGE_GLOBAL_LOG_READ_IPC_CHANNELS.get]({}, 'receipt:missing');
    assert.equal(entry, null, '不存在条目诚实返回 null');
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('WMB-5238 IPC no data-root: honest empty states (no crash, no fabrication)', async () => {
  const handlers = captureRegistration(noRootDeps);
  const page = await handlers[WIKI_SEARCH_READ_IPC_CHANNELS.search]({}, { query: 'x' });
  assert.equal(page.total, 0);
  assert.deepEqual(page.items, []);
  assert.equal(page.hasMore, false);
  const summary = await handlers[WIKI_SEARCH_READ_IPC_CHANNELS.summary]({});
  assert.equal(summary.total, 0);
  assert.equal(summary.updatedAt, null);
  const hot = await handlers[WIKI_SEARCH_READ_IPC_CHANNELS.hotCache]({});
  assert.equal(hot.cached, false);
  assert.equal(hot.entryCount, 0);
  const logPage = await handlers[KNOWLEDGE_GLOBAL_LOG_READ_IPC_CHANNELS.list]({}, {});
  assert.equal(logPage.total, 0);
  assert.equal(logPage.hasMore, false);
});
