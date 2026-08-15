// WMB-5239：全库维护 / 批量反馈 / 导航接缝的 IPC 接线聚焦测试（本 worker：WireWmb5239UiSeams）。
// 覆盖：
// - shared 维护通道契约：冻结、有界、前缀不变量、无 execute/raw/sql 写面通道；
// - main 注册（registerKnowledgeMaintenanceIpc）逐通道复用 shared 常量；registerKnowledgeContentIpc
//   聚合调用（接线不遗漏）；无内联第二套通道字符串；
// - preload 逐通道引用同一共享常量恰好一次；无内联通道字符串；入参纯透传；
// - renderer global.d.ts 类型面与 preload 方法对齐；
// - 功能面：真实 migrateDatabase + 真实 CommandDispatcher runtime → 捕获 handler →
//   空态 status / start 创建 / 幂等 / pause/resume / fail-closed（无 run resume 拒绝）/
//   data_changed 广播 scopes / 无 data-root 隔离空态与拒绝；
// - WMB-5239 导航接缝：app-types 事件常量 + main.tsx 深链监听（topic/source/knowledge_object 分支）、
//   View 联合与顶层路由零新增。
// 运行：node --test --test-concurrency=1 tests/wmb-5239-ui-seams-ipc.test.mjs
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

const { KNOWLEDGE_MAINTENANCE_IPC_CHANNELS } = await import('../src/shared/knowledge-maintenance.ts');
const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { registerKnowledgeMaintenanceIpc } = await import('../src/main/ipc-knowledge-business.ts');
const { setDataChangedPublisher } = await import('../src/main/data-changed.ts');
const { CommandDispatcher } = await import('../src/main/command-dispatcher.ts');

const PRELOAD_PATH = new URL('../src/preload/preload.ts', import.meta.url);
const GLOBALS_PATH = new URL('../src/renderer/global.d.ts', import.meta.url);
const MAIN_IPC_PATH = new URL('../src/main/ipc-knowledge-business.ts', import.meta.url);
const CONTENT_IPC_PATH = new URL('../src/main/ipc-knowledge-content.ts', import.meta.url);
const MAIN_TSX_PATH = new URL('../src/renderer/main.tsx', import.meta.url);
const APP_TYPES_PATH = new URL('../src/renderer/app-types.ts', import.meta.url);

/** 冻结维护通道清单（WMB-5236：start/status/pause/resume；无写面/内部通道）。 */
const FROZEN_MAINTENANCE_CHANNELS = [
  'knowledge-maintenance:start',
  'knowledge-maintenance:status',
  'knowledge-maintenance:pause',
  'knowledge-maintenance:resume'
];

// ============================================================
// 1. shared 通道契约：冻结、有界、前缀不变量、无内部 SQL/写面
// ============================================================

test('WMB-5239 shared maintenance channel contract: frozen, bounded, prefix invariant, no write/raw channels', () => {
  const allChannels = Object.values(KNOWLEDGE_MAINTENANCE_IPC_CHANNELS);
  assert.deepEqual([...allChannels].sort(), [...FROZEN_MAINTENANCE_CHANNELS].sort(), '维护通道全集必须与冻结清单一致');
  assert.equal(new Set(allChannels).size, allChannels.length, '通道名不得重复');
  for (const channel of allChannels) {
    assert.match(channel, /^knowledge-maintenance:/, `通道前缀不变量: ${channel}`);
    assert.doesNotMatch(channel, /sql|raw|execute|exec|rebuild|query|db/i, `禁止写面/内部通道: ${channel}`);
  }
});

// ============================================================
// 2. main 注册：逐通道注册且复用 shared 常量；聚合调用接线
// ============================================================

test('WMB-5239 main registers every maintenance channel via shared constants; content aggregation calls it', async () => {
  const ipcSource = await readFile(MAIN_IPC_PATH, 'utf8');
  const contentSource = await readFile(CONTENT_IPC_PATH, 'utf8');

  for (const [key, channel] of Object.entries(KNOWLEDGE_MAINTENANCE_IPC_CHANNELS)) {
    assert.ok(ipcSource.includes(`KNOWLEDGE_MAINTENANCE_IPC_CHANNELS.${key}`), `维护通道 ${channel} 必须经共享常量注册`);
    assert.ok(!ipcSource.includes(`'${channel}'`), `不得内联维护通道字符串: ${channel}`);
  }
  // 聚合接线：registerKnowledgeContentIpc 调用 registerKnowledgeMaintenanceIpc。
  assert.ok(contentSource.includes('registerKnowledgeMaintenanceIpc(dependencies)'), 'registerKnowledgeContentIpc 必须调用 registerKnowledgeMaintenanceIpc');
});

// ============================================================
// 3. preload：逐通道引用同一共享常量恰好一次；无内联字符串；入参纯透传
// ============================================================

test('WMB-5239 preload wires every maintenance channel exactly once via shared constants', async () => {
  const preload = await readFile(PRELOAD_PATH, 'utf8');
  const invokes = [
    [KNOWLEDGE_MAINTENANCE_IPC_CHANNELS.start, 'KNOWLEDGE_MAINTENANCE_IPC_CHANNELS.start', 'startKnowledgeMaintenance', 'input'],
    [KNOWLEDGE_MAINTENANCE_IPC_CHANNELS.status, 'KNOWLEDGE_MAINTENANCE_IPC_CHANNELS.status', 'getKnowledgeMaintenanceStatus', null],
    [KNOWLEDGE_MAINTENANCE_IPC_CHANNELS.pause, 'KNOWLEDGE_MAINTENANCE_IPC_CHANNELS.pause', 'pauseKnowledgeMaintenance', null],
    [KNOWLEDGE_MAINTENANCE_IPC_CHANNELS.resume, 'KNOWLEDGE_MAINTENANCE_IPC_CHANNELS.resume', 'resumeKnowledgeMaintenance', null]
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
  // 无孤儿通道：共享清单之外不得出现 knowledge-maintenance: 通道字符串。
  const orphanMatches = preload.match(/'knowledge-maintenance:[^']*'/g) ?? [];
  assert.deepEqual(orphanMatches, [], `preload 不应出现共享清单之外的通道: ${orphanMatches.join(', ')}`);
  // 纯透传：无默认值/类型判断/清洗。
  for (const line of preload.split('\n')) {
    if (line.includes('KNOWLEDGE_MAINTENANCE_IPC_CHANNELS.')) {
      assert.doesNotMatch(line, /\?\?|typeof|\.trim\(|Array\.isArray/, `preload 不得猜测/校验参数: ${line.trim()}`);
    }
  }
});

// ============================================================
// 4. renderer global.d.ts：方法面与 preload 对齐
// ============================================================

test('WMB-5239 renderer global.d.ts declares the maintenance methods with shared types', async () => {
  const globals = await readFile(GLOBALS_PATH, 'utf8');
  for (const method of ['startKnowledgeMaintenance', 'getKnowledgeMaintenanceStatus', 'pauseKnowledgeMaintenance', 'resumeKnowledgeMaintenance']) {
    assert.ok(globals.includes(`${method}(`), `global.d.ts 必须声明 ${method}`);
  }
  assert.ok(globals.includes("from '../shared/knowledge-maintenance'"), '类型面必须消费维护共享类型');
  assert.doesNotMatch(globals, /knowledge-maintenance:/, '类型面不持有通道字符串');
});

// ============================================================
// 5. 功能面：真实迁移 DB + 真实 CommandDispatcher → 捕获 handler → 统一契约
// ============================================================

async function makeDatabase() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5239-ipc-'));
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  const now = new Date().toISOString();
  return { root, database, now };
}

/** 真实生产命令路径 runtime 桩：CommandDispatcher 原样执行（含回执/操作日志落库）。 */
function makeRuntime(database, root, ws) {
  const dispatcher = new CommandDispatcher(database, { workspaceId: ws, rootPath: root, runtimeEpoch: 'epoch-1' });
  return {
    database,
    identity: { workspaceId: ws, runtimeEpoch: 'epoch-1' },
    dispatchCommand: (envelope, execute) => dispatcher.dispatch(envelope, execute)
  };
}

/** 捕获型注册：handlers Map 中每个通道可被直接调用（等同 ipcMain.handle 注册面）。 */
function captureMaintenanceRegistration(dependencies) {
  CAPTURED.clear();
  registerKnowledgeMaintenanceIpc(dependencies);
  const handlers = Object.fromEntries(CAPTURED.entries());
  assert.deepEqual(Object.keys(handlers).sort(), [...FROZEN_MAINTENANCE_CHANNELS].sort(), '注册面必须覆盖全部冻结通道');
  return handlers;
}

test('WMB-5239 IPC functional: empty status → start idempotent → pause/resume → fail-closed → broadcasts', async () => {
  const { root, database, now } = await makeDatabase();
  const ws = 'ws-5239';
  database.prepare('INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)')
    .run('workspace_id', ws, now, now);
  try {
    const runtime = makeRuntime(database, root, ws);
    const deps = {
      loadSelectedDataRoot: async () => null,
      migrate: (value) => value,
      getActiveRuntime: () => runtime
    };
    const handlers = captureMaintenanceRegistration(deps);

    // 空态：无 run 时 status 返回诚实空投影（不猜测、不落库）。
    const empty = await handlers[KNOWLEDGE_MAINTENANCE_IPC_CHANNELS.status]({});
    assert.equal(empty.run, null, '无 run 时 run 必须为 null');
    assert.equal(empty.backfill.done, false);
    assert.equal(empty.backfill.scanned, 0);
    assert.equal(empty.lint.done, false);
    assert.equal(empty.report, null, '未完成时 report 必须为 null');

    // data_changed 广播捕获（50ms 合并冲刷）。
    const events = [];
    setDataChangedPublisher((event) => events.push(event));
    try {
      // start：创建 run（scan_compile → running；绑定 workspaceId）。
      const started = await handlers[KNOWLEDGE_MAINTENANCE_IPC_CHANNELS.start]({}, { batchLimit: 3 });
      assert.equal(started.created, true, '首个 start 必须新建 run');
      assert.equal(started.run.status, 'running');
      assert.equal(started.run.phase, 'scan_compile');
      assert.equal(started.run.workspaceId, ws, 'run 必须绑定创建它的 workspaceId');
      assert.equal(started.run.config.batchLimit, 3, 'start 入参透传冻结进 run');

      // 幂等：同活动 run 重复 start 返回同一 run（created=false）。
      await new Promise((resolve) => setTimeout(resolve, 5)); // requestId 用 Date.now()，防同毫秒重放
      const again = await handlers[KNOWLEDGE_MAINTENANCE_IPC_CHANNELS.start]({}, { batchLimit: 9 });
      assert.equal(again.created, false, '活动 run 重复 start 必须幂等（created=false）');
      assert.equal(again.run.runId, started.run.runId, '重复 start 必须返回同一 run');
      assert.equal(again.run.config.batchLimit, 3, '幂等返回不得重置既有 config');

      // status 投影：run/backfill/lint 齐全；report 仍为 null。
      const status = await handlers[KNOWLEDGE_MAINTENANCE_IPC_CHANNELS.status]({});
      assert.equal(status.run.runId, started.run.runId);
      assert.equal(typeof status.backfill.pendingRetry.length, 'number');
      assert.equal(typeof status.lint.issuesCreated, 'number');
      assert.equal(status.report, null);

      // pause（批次边界生效；paused 不占执行）→ resume（沿 checkpoint 续跑）。
      const paused = await handlers[KNOWLEDGE_MAINTENANCE_IPC_CHANNELS.pause]({});
      assert.equal(paused.status, 'paused', 'pause 必须在批次边界进入 paused');
      const resumed = await handlers[KNOWLEDGE_MAINTENANCE_IPC_CHANNELS.resume]({});
      assert.equal(resumed.status, 'running', 'resume 必须回到 running');

      // fail-closed：resume 后生命周期广播 scopes 固定五元组（knowledge/topics/health/receipt/library）。
      await new Promise((resolve) => setTimeout(resolve, 90));
      assert.ok(events.length >= 1, 'start/pause/resume 必须产生 data_changed 事件');
      const allScopes = new Set(events.flatMap((event) => event.scopes));
      for (const scope of ['knowledge', 'topics', 'health', 'receipt', 'library']) {
        assert.ok(allScopes.has(scope), `维护广播必须包含 scope ${scope}`);
      }
      assert.ok(events.some((event) => event.reason?.includes('knowledge.maintenance.start')), 'start 广播 reason 必须保留');
    } finally {
      setDataChangedPublisher(null);
    }

    // fail-closed：无 run 的 resume 拒绝；无 run 的 pause 诚实返回 null。
    const root2 = await mkdtemp(path.join(os.tmpdir(), 'wmb-5239-ipc-norun-'));
    const db2 = migrateDatabase(path.join(root2, 'wmb.db'));
    try {
      const now2 = new Date().toISOString();
      db2.prepare('INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)')
        .run('workspace_id', ws, now2, now2);
      const runtime2 = makeRuntime(db2, root2, ws);
      const handlers2 = captureMaintenanceRegistration({
        loadSelectedDataRoot: async () => null,
        migrate: (value) => value,
        getActiveRuntime: () => runtime2
      });
      const pausedNull = await handlers2[KNOWLEDGE_MAINTENANCE_IPC_CHANNELS.pause]({});
      assert.equal(pausedNull, null, '无 run 时 pause 必须诚实返回 null');
      await assert.rejects(
        handlers2[KNOWLEDGE_MAINTENANCE_IPC_CHANNELS.resume]({}),
        (error) => error?.code === 'MAINTENANCE_RUN_NOT_FOUND' || /MAINTENANCE_RUN_NOT_FOUND/.test(String(error?.message ?? error)),
        '无 run 时 resume 必须 fail-closed 拒绝'
      );
      await assert.rejects(
        handlers2[KNOWLEDGE_MAINTENANCE_IPC_CHANNELS.start]({}, { batchLimit: 1, workspaceId: 'other-ws' }),
        (error) => error?.code === 'MAINTENANCE_WORKSPACE_MISMATCH' || /MAINTENANCE_WORKSPACE_MISMATCH/.test(String(error?.code ?? '')),
        '跨 workspace start 必须拒绝'
      );
    } finally {
      db2.close();
      await rm(root2, { recursive: true, force: true });
    }
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('WMB-5239 IPC no data-root: honest empty status; mutations reject fail-closed', async () => {
  const noRootDeps = {
    loadSelectedDataRoot: async () => null,
    migrate: (value) => value,
    getActiveRuntime: () => null
  };
  const handlers = captureMaintenanceRegistration(noRootDeps);
  const status = await handlers[KNOWLEDGE_MAINTENANCE_IPC_CHANNELS.status]({});
  assert.equal(status.run, null, '无 data-root 时 status 必须诚实空态');
  assert.equal(status.report, null);
  await assert.rejects(
    handlers[KNOWLEDGE_MAINTENANCE_IPC_CHANNELS.start]({}, {}),
    (error) => /数据根目录|运行时尚未就绪/.test(String(error?.message ?? error)),
    '无 data-root 时 start 必须拒绝（不猜测不落库）'
  );
});

// ============================================================
// 6. WMB-5239 渲染端导航接缝：事件常量 + main.tsx 深链监听；View/路由零新增
// ============================================================

test('WMB-5239 navigation seam: shared event constant + main.tsx deep-link listener; no View/route additions', async () => {
  const appTypes = await readFile(APP_TYPES_PATH, 'utf8');
  const mainTsx = await readFile(MAIN_TSX_PATH, 'utf8');

  // 事件常量单一真源（app-types），main.tsx 经常量监听（不内联字符串）。
  assert.ok(appTypes.includes(`export const WMB_NAVIGATE_WIKI_OBJECT_EVENT = 'wmb-navigate-wiki-object' as const;`), 'app-types 必须导出深链事件常量');
  assert.ok(mainTsx.includes("WMB_NAVIGATE_WIKI_OBJECT_EVENT } from './app-types'"), 'main.tsx 必须从 app-types 导入事件常量');
  assert.ok(mainTsx.includes('window.addEventListener(WMB_NAVIGATE_WIKI_OBJECT_EVENT'), 'main.tsx 必须经常量注册监听');
  assert.ok(mainTsx.includes("window.removeEventListener(WMB_NAVIGATE_WIKI_OBJECT_EVENT"), '监听必须可退订');
  assert.ok(!mainTsx.includes("'wmb-navigate-wiki-object'"), 'main.tsx 不得内联事件字符串');

  // 三分支深链：topic→openTopic(objectId)；source→libraryFocusSourceId+navigate(library)；object→navigate(canvas)。
  // 事件契约 detail={payload}（wiki-discovery 派发端已按此实现；监听端必须解包）。
  assert.ok(mainTsx.includes('CustomEvent<{ payload?: KnowledgeDeepLinkPayload }>'), '监听必须按 detail.payload 包装契约类型化');
  assert.ok(mainTsx.includes('const payload = detail?.payload;'), '必须解包 detail.payload（缺 detail 时 fail-closed）');
  assert.ok(mainTsx.includes("payload.targetType === 'topic_wiki' && payload.objectId"), 'topic_wiki 分支必须存在');
  assert.ok(mainTsx.includes("openTopic(payload.objectId)"), 'topic 必须按稳定 objectId 定位');
  assert.ok(mainTsx.includes("payload.targetType === 'source' && payload.objectId"), 'source 分支必须存在');
  assert.ok(mainTsx.includes("libraryFocusSourceId"), 'source 必须写 libraryFocusSourceId');
  assert.ok(mainTsx.includes("payload.targetType === 'knowledge_object'"), 'knowledge_object 分支必须存在');
  assert.ok(mainTsx.includes("navigate('canvas')"), '知识对象降级到知识网络');
  assert.ok(mainTsx.includes('navigate(\'library\')'), 'source 导航必须切到资料库');

  // 顶层路由/View 联合零新增：11 个既有 View 值不变，无 wiki/knowledge 新值。
  const viewDecl = "export type View = 'today' | 'agents' | 'discover' | 'proposals' | 'topic' | 'library' | 'canvas' | 'studio' | 'publish' | 'results' | 'settings';";
  assert.ok(appTypes.includes(viewDecl), 'View 联合必须保持不变（零新增顶层路由）');
  const viewsDecl = "export const views: View[] = ['today', 'agents', 'discover', 'proposals', 'topic', 'library', 'canvas', 'studio', 'publish', 'results', 'settings'];";
  assert.ok(appTypes.includes(viewsDecl), 'views 清单必须保持不变');
  assert.doesNotMatch(appTypes, /'wiki'|'knowledge'/, '不得新增 wiki/knowledge 顶层路由值');
});
