// Electron E2E harness for WeMediaBuddy (WMB-5243).
//
// Contract (peers: E2EWorkflowEarly / E2EWorkflowLate / E2EKnowledgeSettings):
// - Scenario files: tests/e2e/scenarios/<journey-id>.e2e.mjs
// - Each file default-exports `async function run(ctx)` where ctx is:
//     { app, page, workspace, artifactsDir, evidence, runtimeDir, helpers }
//   - app: playwright-core ElectronApplication
//   - page: the app's main window page (collectors already attached)
//   - workspace: { userDataDir, dataRoot, workspaceId, displayName } seeded fixture
//   - evidence: { console, errors, pageerrors, crashed, closed, electronStdout, electronStderr }
//   - helpers: { waitForAppReady, navigateTo, captureEvidence, closeApp, delay }
// - Navigation: `navigateTo(page, 'agents' | 'today' | 'discover' | ...)` clicks the
//   sidebar button and waits until it is the active view.
// - The scenario must NOT close the app unless exit is the last assertion
//   (runner/withApp closes and cleans up in `finally`).
// - No business code is touched; the harness only seeds isolated userData/data-root
//   fixtures and launches the real Electron app.
//
// Isolation: every launch gets its own userData dir (fresh single-instance lock,
// fresh CDP debug port from playwright, fresh cache) under tests/e2e/.runtime/,
// so concurrent runs on Windows cannot collide.

import { _electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateDatabase } from '../../src/main/db/migrations.ts';

const require = createRequire(import.meta.url);

export { migrateDatabase } from '../../src/main/db/migrations.ts';
export const E2E_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
export const REPO_ROOT = path.resolve(E2E_ROOT, '..', '..');
export const RUNTIME_DIR = path.join(E2E_ROOT, '.runtime');
export const ARTIFACTS_DIR = path.join(E2E_ROOT, '.artifacts');
export const DEFAULT_UPDATE_TAG = process.env.WMB_E2E_UPDATE_TAG || 'v0.3.0';

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Bundled Pi runtime (.r) prerequisite
// ---------------------------------------------------------------------------

/**
 * The bundled Pi runtime (`.r`) is a gitignored build artifact produced by
 * scripts/prepare-pi-runtime.mjs (npm run package). In dev mode the app reads
 * the real Pi version from `.r/node_modules/a/package.json` (the bundled
 * @earendil-works/pi-coding-agent); a missing/stale/corrupt `.r` silently
 * renders `unknown` in the 关于 WMB section (STG-007). Validate it against the
 * installed packages and rebuild via the same script before launching, so the
 * E2E either sees the real version or fails loudly with an actionable reason.
 */
function bundledRuntimeState() {
  const readVersion = (file) => {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      return typeof parsed?.version === 'string' ? parsed.version : null;
    } catch {
      return null;
    }
  };
  const agent = readVersion(path.join(REPO_ROOT, '.r', 'node_modules', 'a', 'package.json'));
  const vision = readVersion(path.join(REPO_ROOT, '.r', 'node_modules', 'pi-vision-tool', 'package.json'));
  const installedAgent = readVersion(path.join(REPO_ROOT, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'));
  const installedVision = readVersion(path.join(REPO_ROOT, 'node_modules', 'pi-vision-tool', 'package.json'));
  return {
    valid: Boolean(agent && vision && agent === installedAgent && vision === installedVision),
    agent,
    vision,
    installedAgent,
    installedVision
  };
}

/** Rebuild `.r` with the same script `npm run package` uses; verifies the result. */
function rebuildBundledRuntime() {
  const script = path.join(REPO_ROOT, 'scripts', 'prepare-pi-runtime.mjs');
  const result = spawnSync(process.execPath, [script], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 600_000 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.status !== 0) {
    return {
      ok: false,
      reason: `捆绑 Pi 运行时 (.r) 重建失败（exit ${result.status}）：${output.slice(-500) || '无输出'}\n` +
        '提示：Windows 上若 WeMediaBuddy 仍在运行，会锁定 .r 内的原生 .node 文件导致删除失败；请先退出应用再重试。'
    };
  }
  const state = bundledRuntimeState();
  if (!state.valid) {
    return {
      ok: false,
      reason: `捆绑 Pi 运行时重建后仍不完整：bundled agent=${state.agent ?? 'missing'} vision=${state.vision ?? 'missing'}，` +
        `installed agent=${state.installedAgent ?? 'missing'} vision=${state.installedVision ?? 'missing'}`
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Launch target resolution
// ---------------------------------------------------------------------------

/**
 * Resolve how to launch the real Electron app.
 * 1. WMB_E2E_APP_PATH (or options.appPath): packaged output dir -> launch its exe.
 * 2. Default: dev build at .vite/build/index.js (electron-forge Vite output).
 */
export function resolveLaunchTarget(options = {}) {
  const appPath = (options.appPath ?? process.env.WMB_E2E_APP_PATH ?? '').trim();
  if (appPath) {
    const exe = path.resolve(appPath, process.platform === 'win32' ? 'WeMediaBuddy.exe' : 'WeMediaBuddy');
    if (!existsSync(exe)) {
      return { ok: false, reason: `打包应用不存在: ${exe}（请用 WMB_E2E_APP_PATH 指向打包输出目录）` };
    }
    const resourcesRuntime = path.join(path.resolve(appPath), 'resources', '.r', 'node_modules', 'a', 'package.json');
    if (!existsSync(resourcesRuntime)) {
      return {
        ok: false,
        reason: `打包产物缺少捆绑 Pi 运行时 ${resourcesRuntime}。请重新执行 npm run package（会先运行 prepare-pi-runtime.mjs 生成 .r 再打包）。`
      };
    }
    return { ok: true, mode: 'packaged', executablePath: exe, args: [], appRoot: path.resolve(appPath), rendererShape: 'file', devServerRequired: false, devServerPort: null };
  }
  const mainEntry = path.join(REPO_ROOT, '.vite', 'build', 'index.js');
  if (!existsSync(mainEntry)) {
    return {
      ok: false,
      reason: `缺少开发构建产物 ${mainEntry}。请先执行一次 npm run package（或 npx electron-forge start）生成 .vite/build，再运行 E2E。`
    };
  }
  // electron-forge Vite 生产形态构建会把渲染器打进 .vite/renderer/<name>/index.html（loadFile 分支）；
  // dev 形态构建内联 MAIN_WINDOW_VITE_DEV_SERVER_URL，需要 27391 的 vite dev server。
  const rendererIndex = path.join(REPO_ROOT, '.vite', 'renderer', 'main_window', 'index.html');
  const devServerRequired = !existsSync(rendererIndex);
  const devServerPort = Number(process.env.WMB_RENDERER_PORT ?? '27391');
  let executablePath;
  try {
    executablePath = require('electron');
  } catch {
    return { ok: false, reason: '无法解析 electron 可执行文件（devDependencies 中缺失？）。' };
  }
  return {
    ok: true,
    mode: 'dev',
    executablePath,
    args: [REPO_ROOT],
    appRoot: REPO_ROOT,
    rendererShape: devServerRequired ? 'dev-server' : 'file',
    devServerRequired,
    devServerPort,
    runtimeValid: bundledRuntimeState().valid
  };
}

/** 探测 vite dev server 是否可达（仅 dev 形态构建需要）。 */
async function probeDevServer(port, timeoutMs = 2000) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    const html = await response.text();
    const isWmb = /<title>WeMediaBuddy<\/title>/i.test(html) && /id=["']root["']/.test(html);
    return isWmb ? { ok: true, reason: 'vite dev server 响应 WeMediaBuddy 页面' } : { ok: false, reason: '端口有响应但不是 WeMediaBuddy 页面（黑屏故障模式）' };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

// ---------------------------------------------------------------------------
// Workspace / userData fixture seeding (no business code changes)
// ---------------------------------------------------------------------------

/**
 * Seed a fully-formed first-run state so the app boots straight into the main
 * shell (`.app-shell`), without dialogs:
 * - data-root.json + workspace-registry.json  -> active workspace
 * - onboarding.json (currentStep complete)    -> renderer skips the wizard
 * - pi-api-config.json (active placeholder)   -> onboarding "aiReady" prereq,
 *   since deriveCurrentStep requires an active profile to mark complete.
 *   The key is never decrypted unless Pi is actually invoked; smoke tests
 *   never invoke it.
 * The wmb.db is built with the app's OWN migration pipeline (migrateDatabase)
 * and bound to the workspace via app_meta.workspace_id — the exact shape
 * loadSelectedDataRoot/enrollAiWorkspace require, so the booted app gets a
 * live workspace runtime (without the binding, enrollAiWorkspace throws
 * WORKSPACE_ID_MISMATCH and no runtime ever starts).
 */
export function seedWorkspace({
  userDataDir,
  dataRoot,
  displayName = 'E2E 工作空间',
  workspaceId = randomUUID(),
  seedPi = true,
  onboarding = true,
  now = new Date().toISOString()
} = {}) {
  mkdirSync(userDataDir, { recursive: true });
  mkdirSync(dataRoot, { recursive: true });
  for (const sub of ['assets', 'browser-profile', 'logs', 'exports']) {
    mkdirSync(path.join(dataRoot, sub), { recursive: true });
  }
  const database = migrateDatabase(path.join(dataRoot, 'wmb.db'));
  try {
    if (!database.prepare("SELECT value FROM app_meta WHERE key = 'workspace_id'").get()) {
      database.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', ?, ?, ?, 1)")
        .run(workspaceId, now, now);
    }
  } finally {
    database.close();
  }
  const files = {
    'data-root.json': { path: dataRoot },
    'workspace-registry.json': {
      version: 1,
      activeWorkspaceId: workspaceId,
      workspaces: [{ id: workspaceId, displayName, rootPath: dataRoot }],
      switchJournal: null
    }
  };
  if (onboarding) {
    files['onboarding.json'] = {
      version: 1,
      state: {
        currentStep: 'complete',
        workspace: { workspaceId, rootPath: dataRoot, createdAt: now },
        ai: null,
        platforms: {},
        startedAt: now,
        completedAt: now,
        updatedAt: now
      }
    };
  }
  if (seedPi) {
    files['pi-api-config.json'] = {
      version: 1,
      state: {
        activeId: 'e2e',
        profiles: [{
          id: 'e2e',
          name: 'E2E 占位配置',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-5.4',
          api: 'openai-responses',
          thinking: 'medium',
          nativeSearch: false,
          contextWindow: 400000,
          maxTokens: 65536,
          encryptedApiKey: Buffer.from('e2e-placeholder-key-do-not-use').toString('base64')
        }],
        fallbackOrder: ['e2e']
      }
    };
  }
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(userDataDir, name), `${JSON.stringify(content, null, 2)}\n`);
  }
  return { userDataDir, dataRoot, workspaceId, displayName };
}

// ---------------------------------------------------------------------------
// Collectors: console / pageerror / crash / process output
// ---------------------------------------------------------------------------

export function attachCollectors(page, evidence) {
  const handlers = [
    [page, 'console', (msg) => {
      const record = { type: msg.type(), text: msg.text(), location: msg.location() };
      evidence.console.push(record);
      if (msg.type() === 'error') evidence.errors.push(record);
    }],
    [page, 'pageerror', (error) => {
      evidence.pageerrors.push({ message: String(error?.message ?? error), stack: String(error?.stack ?? '') });
    }],
    [page, 'crash', () => { evidence.crashed = true; }],
    [page, 'close', () => { evidence.closed = true; }]
  ];
  for (const [emitter, event, fn] of handlers) emitter.on(event, fn);
  return () => {
    for (const [emitter, event, fn] of handlers) emitter.off(event, fn);
  };
}

function attachProcessOutput(proc, evidence) {
  const tail = (stream, key) => {
    if (!stream) return;
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer = (buffer + String(chunk)).slice(-200_000);
      evidence[key] = buffer;
    });
  };
  tail(proc.stdout, 'electronStdout');
  tail(proc.stderr, 'electronStderr');
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

/**
 * Launch a real, isolated Electron instance.
 * - WMB_ACCEPTANCE_USER_DATA -> isolated userData (single-instance lock is
 *   per-userData, so parallel runs never conflict).
 * - WMB_ACCEPTANCE_HEADLESS=1 -> window created with show:false (no focus steal);
 *   evidence screenshots force-show it first.
 * - WMB_ACCEPTANCE_UPDATE_TAG -> required because the main process derives the
 *   acceptance update feed from it whenever WMB_ACCEPTANCE_USER_DATA is set.
 * - playwright connects over its own ephemeral CDP port; WMB_ACCEPTANCE_CDP_PORT
 *   is deliberately not passed.
 */
export async function launchApp(options = {}) {
  const target = resolveLaunchTarget(options);
  if (!target.ok) throw new Error(target.reason);
  if (target.devServerRequired) {
    const probe = await probeDevServer(target.devServerPort);
    if (!probe.ok) {
      throw new Error(
        `当前 .vite/build 是 dev 形态构建（无 .vite/renderer/main_window/index.html），需要 27391 的 vite dev server 才能加载渲染器。\n` +
        `探测 http://127.0.0.1:${target.devServerPort}/ 失败: ${probe.reason}\n` +
        `解决：启动 dev server（npm run start）后重试；或先 npm run package 生成生产形态构建（loadFile 分支，无需 dev server）。`
      );
    }
  }
  if (target.mode === 'dev' && !target.runtimeValid) {
    // 版本真源：捆绑 Pi 运行时 (.r)。缺失/失效则用与 npm run package 相同的脚本重建，
    // 避免 关于 WMB 分区静默显示 unknown（STG-007）。
    const built = rebuildBundledRuntime();
    if (!built.ok) throw new Error(built.reason);
  }
  const runtimeDir = mkdtempSync(path.join(ensureDir(RUNTIME_DIR), 'run-'));
  const userDataDir = options.userDataDir ? path.resolve(options.userDataDir) : path.join(runtimeDir, 'user-data');
  const dataRoot = options.dataRoot ? path.resolve(options.dataRoot) : path.join(runtimeDir, 'data-root');
  const workspace = options.seed === false
    ? (mkdirSync(userDataDir, { recursive: true }), { userDataDir, dataRoot, workspaceId: null, displayName: null })
    : seedWorkspace({
        userDataDir,
        dataRoot,
        displayName: options.displayName,
        seedPi: options.seedPi !== false,
        onboarding: options.onboarding !== false
      });
  if (typeof options.seedFixture === 'function') {
    await options.seedFixture(workspace);
  }
  const artifactsDir = options.artifactsDir ?? mkdtempSync(path.join(ensureDir(ARTIFACTS_DIR), `${options.name ?? 'run'}-`));
  const env = {
    ...process.env,
    WMB_ACCEPTANCE_USER_DATA: userDataDir,
    WMB_ACCEPTANCE_HEADLESS: options.headless === false ? '0' : '1',
    WMB_ACCEPTANCE_UPDATE_TAG: options.updateTag ?? DEFAULT_UPDATE_TAG,
    ELECTRON_ENABLE_LOGGING: '1',
    ELECTRON_ENABLE_STACK_DUMPING: '1',
    ...(options.extraEnv ?? {})
  };
  delete env.WMB_ACCEPTANCE_CDP_PORT; // playwright manages its own debug port

  const app = await _electron.launch({
    executablePath: target.executablePath,
    args: target.args,
    cwd: REPO_ROOT,
    env,
    timeout: options.launchTimeoutMs ?? 120_000
  });
  const page = await app.firstWindow({ timeout: options.firstWindowTimeoutMs ?? 90_000 });
  const evidence = {
    console: [],
    errors: [],
    pageerrors: [],
    steps: [],
    crashed: false,
    closed: false,
    electronStdout: '',
    electronStderr: ''
  };
  attachProcessOutput(app.process(), evidence);
  const detach = attachCollectors(page, evidence);
  evidence.launch = { mode: target.mode, rendererShape: target.rendererShape, devServerRequired: target.devServerRequired === true, devServerPort: target.devServerPort };
  return { app, page, workspace, runtimeDir, artifactsDir, evidence, detach, target };
}

// ---------------------------------------------------------------------------
// Reliable waiting & navigation
// ---------------------------------------------------------------------------

/** Wait until the app shell (default `.app-shell`) is visible. */
export async function waitForAppReady(page, { shell = '.app-shell', timeoutMs = 60_000 } = {}) {
  await page.waitForSelector(shell, { state: 'visible', timeout: timeoutMs });
  return page;
}

/** Sidebar button title per view (single source, mirrors renderer main.tsx). */
export const VIEW_TITLES = Object.freeze({
  today: '今日',
  agents: '智能体',
  discover: '发现',
  proposals: '选题',
  studio: '创作',
  publish: '发布',
  results: '结果',
  topic: '主题',
  library: '资料库',
  canvas: '关系画布',
  settings: '设置'
});

/** Minimal assertion; throws Error(message) on failure for scenario evidence. */
export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Record a named step into evidence; rethrows failures with step context. */
export async function step(evidence, name, fn) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    evidence.steps.push({ name, ok: true, durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    evidence.steps.push({
      name,
      ok: false,
      durationMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

/** Read-only access to the workspace SQLite DB (the app holds the write handle;
 *  SQLite allows concurrent read-only connections). Dual-readback pattern:
 *  assert UI state, then verify the DB row. */
export function openReadOnlyDb(dataRoot) {
  const db = new DatabaseSync(path.join(dataRoot, 'wmb.db'), { readOnly: true });
  return { db, close: () => { try { db.close(); } catch { /* already closed */ } } };
}

/** Click the sidebar button for a view and wait until it is the active view.
 *  Scoped to `aside.sidebar`: 页面内层 nav（如 proposals 的 nav.proposal-tabs、
 *  topic 的章节 tab）可能含同名/同 title 的 button，裸 `nav button` 会歧义。
 *  settings-mode 下产品隐藏侧栏（.settings-mode .sidebar { display:none }）：
 *  - 目标视图已激活（如 settings 内再次 navigateTo('settings')）→ 直接返回；
 *  - 侧栏不可见时（从 settings 导航离开）→ 对真实侧栏按钮派发 DOM click，
 *    触发同一 React 导航 handler（仍是真实用户 DOM + 真实状态切换/真实 IPC）。 */
export async function navigateTo(page, view, { timeoutMs = 20_000 } = {}) {
  const title = VIEW_TITLES[view];
  if (!title) throw new Error(`未知视图: ${view}`);
  const selector = `aside.sidebar nav button[title="${title}"]`;
  const alreadyActive = await page.evaluate(
    (s) => document.querySelector(s)?.classList.contains('active') ?? false,
    selector
  );
  if (alreadyActive) return page;
  if (await page.locator(selector).isVisible().catch(() => false)) {
    await page.locator(selector).click();
  } else {
    await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) throw new Error(`侧栏导航按钮不存在: ${s}`);
      el.click();
    }, selector);
  }
  await page.waitForFunction(
    (s) => document.querySelector(s)?.classList.contains('active'),
    selector,
    { timeout: timeoutMs }
  );
  return page;
}

// ---------------------------------------------------------------------------
// Evidence capture
// ---------------------------------------------------------------------------

export async function captureEvidence({ app, page, evidence = {}, artifactsDir, name = 'evidence' }) {
  if (!artifactsDir) return artifactsDir;
  ensureDir(artifactsDir);
  const notes = [];
  try {
    await app.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed() && !win.isVisible()) win.show();
      }
    });
  } catch (error) {
    notes.push(`show windows: ${String(error?.message ?? error)}`);
  }
  try {
    await page.screenshot({ path: path.join(artifactsDir, `${name}-screenshot.png`), fullPage: true, timeout: 20_000 });
  } catch (error) {
    notes.push(`screenshot: ${String(error?.message ?? error)}`);
  }
  writeFileSync(path.join(artifactsDir, `${name}-console.json`), `${JSON.stringify(evidence.console ?? [], null, 2)}\n`);
  writeFileSync(path.join(artifactsDir, `${name}-pageerrors.json`), `${JSON.stringify(evidence.pageerrors ?? [], null, 2)}\n`);
  writeFileSync(path.join(artifactsDir, `${name}-electron-stdout.log`), String(evidence.electronStdout ?? ''));
  writeFileSync(path.join(artifactsDir, `${name}-electron-stderr.log`), String(evidence.electronStderr ?? ''));
  if (notes.length) writeFileSync(path.join(artifactsDir, `${name}-notes.txt`), notes.join('\n'));
  return artifactsDir;
}

// ---------------------------------------------------------------------------
// Process cleanup (Windows process-tree kill fallback)
// ---------------------------------------------------------------------------

function forceKillProcessTree(pid) {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // already gone
  }
}

/**
 * Graceful close first (close windows -> window-all-closed -> app.quit), then
 * app.quit() via evaluate, then taskkill process tree. Returns true when the
 * process exited. Idempotent: safe to call after the app already closed.
 */
export async function closeApp(app, { timeoutMs = 20_000 } = {}) {
  const proc = app?.process?.();
  if (!proc || !proc.pid) return true;
  let exited = false;
  const onExit = () => { exited = true; };
  proc.once('exit', onExit);
  if (exited) return true;
  try {
    await Promise.race([app.close(), delay(timeoutMs), new Promise((resolve) => proc.once('exit', resolve))]);
  } catch {
    // fall through to harder shutdown
  }
  if (!exited) {
    try {
      await app.evaluate(({ app: electronApp }) => electronApp.quit());
    } catch {
      // app may already be tearing down
    }
    await Promise.race([delay(5_000), new Promise((resolve) => proc.once('exit', resolve))]);
  }
  if (!exited) {
    forceKillProcessTree(proc.pid);
    await Promise.race([delay(5_000), new Promise((resolve) => proc.once('exit', resolve))]);
  }
  proc.off('exit', onExit);
  return exited;
}

// ---------------------------------------------------------------------------
// Scenario composition
// ---------------------------------------------------------------------------

export const helpers = Object.freeze({ waitForAppReady, navigateTo, captureEvidence, closeApp, delay, VIEW_TITLES, assert, step, openReadOnlyDb });

/**
 * Launch -> run handler -> always cleanup. On handler failure, captures an
 * evidence bundle (screenshot, console, pageerrors, electron stdout/stderr)
 * into artifactsDir and rethrows with `.evidenceDir` attached.
 */
export async function withApp(handler, options = {}) {
  const started = await launchApp(options);
  const { app, page, workspace, runtimeDir, artifactsDir, evidence } = started;
  try {
    const result = await handler({
      app,
      page,
      workspace,
      artifactsDir,
      evidence,
      runtimeDir,
      helpers,
      assert,
      step: (name, fn) => step(evidence, name, fn),
      openDb: () => openReadOnlyDb(workspace.dataRoot)
    });
    return { ok: true, result, evidence, artifactsDir, workspace, runtimeDir };
  } catch (error) {
    try {
      await captureEvidence({ app, page, evidence, artifactsDir, name: 'failure' });
    } catch {
      // evidence is best-effort
    }
    const wrapped = new Error(`场景失败: ${error instanceof Error ? error.message : String(error)}\n证据目录: ${artifactsDir}`);
    wrapped.stack = error?.stack;
    wrapped.cause = error;
    wrapped.evidenceDir = artifactsDir;
    throw wrapped;
  } finally {
    try { started.detach(); } catch { /* noop */ }
    try { await closeApp(app); } catch { /* noop */ }
    if (options.keepRuntime !== true) {
      try { rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* locked on win32; .runtime is gitignored */ }
    }
  }
}
