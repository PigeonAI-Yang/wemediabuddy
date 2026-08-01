import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { isPyaireaderXProfile, pyaireaderXEndpoint, pyaireaderXProfileId } from './platforms/x-list-primitives.ts';
import { X_BROWSER_VIEWPORT } from './platforms/x-humanization.ts';
import { stopProcessIdTree, stopProcessTree } from './workspace-runtime.ts';

const execFileAsync = promisify(execFile);

export type BrowserConfig = {
  id: string;
  label: string;
  executablePath: string;
  userDataDir: string;
  profileDirectory: string;
  cdpUrl?: string;
};

/** quiet = headed minimized (safe default for X). visible = takeover/login. headless = experimental only. */
export type BrowserLaunchMode = 'quiet' | 'visible' | 'headless';

export type BrowserRuntime = {
  executablePath: string;
  profilePath: string;
  pid: number;
  cdpUrl: string;
  mode: BrowserLaunchMode;
  stop: () => Promise<void>;
};

export type StartBrowserOptions = {
  mode?: BrowserLaunchMode;
};

const edgeExecutable = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const configKey = 'browser.config';
const managedRuntimes = new Map<string, BrowserRuntime>();
const lastQuietHideAt = new Map<string, number>();
const QUIET_HIDE_THROTTLE_MS = 2_500;

export async function discoverBrowserProfiles(): Promise<BrowserConfig[]> {
  const profiles: BrowserConfig[] = [];
  try {
    const pyaireaderDir = path.join(process.env.USERPROFILE!, '.pyaireader', 'edge-cdp-profiles', 'default');
    await access(pyaireaderDir);
    profiles.push({
      id: pyaireaderXProfileId,
      label: 'Edge · Pyaireader 独立登录态',
      executablePath: edgeExecutable,
      userDataDir: pyaireaderDir,
      profileDirectory: 'Default',
      cdpUrl: pyaireaderXEndpoint
    });
  } catch {}
  try {
    await access(edgeExecutable);
    const userDataDir = path.join(process.env.LOCALAPPDATA!, 'Microsoft', 'Edge', 'User Data');
    const state = JSON.parse(await readFile(path.join(userDataDir, 'Local State'), 'utf8')) as {
      profile?: { info_cache?: Record<string, { name?: string }> };
    };
    profiles.push(...Object.entries(state.profile?.info_cache ?? {}).map(([profileDirectory, info]) => ({
      id: `edge:${profileDirectory}`,
      label: `Edge · ${info.name ?? profileDirectory}`,
      executablePath: edgeExecutable,
      userDataDir,
      profileDirectory
    })));
  } catch {}
  return profiles;
}

export function readBrowserConfig(database: DatabaseSync): BrowserConfig | null {
  const row = database.prepare('SELECT value FROM app_meta WHERE key = ?').get(configKey) as { value: string } | undefined;
  return row ? JSON.parse(row.value) as BrowserConfig : null;
}

export function saveBrowserConfig(database: DatabaseSync, config: BrowserConfig): BrowserConfig {
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, revision=app_meta.revision + 1
  `).run(configKey, JSON.stringify(config), now, now);
  return config;
}

export function resolveBrowserLaunchMode(config: BrowserConfig, options: StartBrowserOptions = {}): BrowserLaunchMode {
  if (options.mode) return options.mode;
  // X dedicated profile defaults to quiet headed automation, not true headless.
  return isPyaireaderXProfile(config) ? 'quiet' : 'visible';
}

export function buildBrowserLaunchArgs(config: BrowserConfig, options: { mode: BrowserLaunchMode; port: number }): string[] {
  const args = [
    `--user-data-dir=${config.userDataDir}`,
    `--profile-directory=${config.profileDirectory}`,
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${options.port}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--window-size=${X_BROWSER_VIEWPORT.width},${X_BROWSER_VIEWPORT.height}`,
    '--disable-features=Translate,MediaRouter',
    '--lang=zh-CN'
  ];
  if (options.mode === 'headless') {
    // Experimental only. Prefer quiet headed for X account safety.
    args.push('--headless=new', '--disable-gpu');
  } else if (options.mode === 'quiet') {
    // Real headed Chromium, but treated as a background worker window.
    // Keep it out of the user's face: minimized + off-screen.
    args.push(
      '--start-minimized',
      '--window-position=-32000,-32000',
      `--window-size=${X_BROWSER_VIEWPORT.width},${X_BROWSER_VIEWPORT.height}`
    );
  } else {
    args.push('--new-window');
  }
  args.push('about:blank');
  return args;
}

export async function startBrowser(config: BrowserConfig, options: StartBrowserOptions = {}): Promise<BrowserRuntime> {
  const mode = resolveBrowserLaunchMode(config, options);
  const preferredCdpUrl = config.cdpUrl;
  if (preferredCdpUrl && await cdpReady(preferredCdpUrl)) {
    const runtime = attachExistingRuntime(config, preferredCdpUrl, mode);
    if (mode === 'quiet') await ensureQuietXBrowserWindow(preferredCdpUrl).catch(() => {});
    if (mode === 'visible') await revealXBrowserWindow(preferredCdpUrl).catch(() => {});
    return runtime;
  }

  const port = preferredCdpUrl ? portFromCdpUrl(preferredCdpUrl) : await reservePort();
  const cdpUrl = preferredCdpUrl ?? `http://127.0.0.1:${port}`;
  if (await cdpReady(cdpUrl)) {
    const runtime = await attachExistingRuntime(config, cdpUrl, mode);
    if (mode === 'quiet') await ensureQuietXBrowserWindow(cdpUrl).catch(() => {});
    if (mode === 'visible') await revealXBrowserWindow(cdpUrl).catch(() => {});
    return runtime;
  }

  const child = spawn(config.executablePath, buildBrowserLaunchArgs(config, { mode, port }), {
    detached: false,
    stdio: 'ignore',
    windowsHide: mode !== 'visible'
  });
  if (!child.pid) throw new Error('浏览器未能启动。');
  try {
    await waitForCdp(cdpUrl);
    if (mode === 'quiet') await ensureQuietXBrowserWindow(cdpUrl).catch(() => {});
    if (mode === 'visible') await revealXBrowserWindow(cdpUrl).catch(() => {});
  } catch (error) {
    await stopProcessTree(child);
    throw error;
  }
  const runtime: BrowserRuntime = {
    executablePath: config.executablePath,
    profilePath: path.join(config.userDataDir, config.profileDirectory),
    pid: child.pid,
    cdpUrl,
    mode,
    stop: () => stopProcessTree(child)
  };
  managedRuntimes.set(cdpUrl, runtime);
  return runtime;
}

/** Ensure Pyaireader X browser is reachable. Default mode is quiet headed (not true headless). */
export async function ensurePyaireaderXBrowser(config: BrowserConfig, options: StartBrowserOptions = {}): Promise<BrowserRuntime> {
  if (!isPyaireaderXProfile(config)) {
    throw new Error('X List 只能使用已选择的 Pyaireader 专用 X 登录态。');
  }
  return startBrowser(config, { mode: options.mode ?? 'quiet' });
}

/** Keep the dedicated X worker out of the user's face during automation. */
export async function ensureQuietXBrowserWindow(cdpUrl: string, options: { force?: boolean } = {}): Promise<void> {
  const key = cdpUrl.replace(/\/$/, '');
  const now = Date.now();
  const last = lastQuietHideAt.get(key) ?? 0;
  if (!options.force && now - last < QUIET_HIDE_THROTTLE_MS) return;
  lastQuietHideAt.set(key, now);
  // Prefer OS-level hide first so CDP bounds changes do not flash a real window.
  await hidePyaireaderWindowsOnWindows().catch(() => {});
  await setBrowserWindowState(cdpUrl, 'quiet').catch(() => {});
  await hidePyaireaderWindowsOnWindows().catch(() => {});
}

/** Only for explicit takeover / login. */
export async function revealXBrowserWindow(cdpUrl: string): Promise<void> {
  lastQuietHideAt.delete(cdpUrl.replace(/\/$/, ''));
  await showPyaireaderWindowsOnWindows().catch(() => {});
  await setBrowserWindowState(cdpUrl, 'visible').catch(() => {});
}

export async function cdpReady(cdpUrl: string): Promise<boolean> {
  try { return (await fetch(`${cdpUrl}/json/version`)).ok; } catch { return false; }
}

async function attachExistingRuntime(config: BrowserConfig, cdpUrl: string, mode: BrowserLaunchMode): Promise<BrowserRuntime> {
  const existing = managedRuntimes.get(cdpUrl);
  const pid = existing?.pid || await listeningPid(cdpUrl);
  const runtime: BrowserRuntime = {
    executablePath: config.executablePath,
    profilePath: path.join(config.userDataDir, config.profileDirectory),
    pid,
    cdpUrl,
    mode,
    stop: existing?.stop ?? (() => stopProcessIdTree(pid))
  };
  managedRuntimes.set(cdpUrl, runtime);
  return runtime;
}

export async function stopManagedBrowsers(): Promise<void> {
  const runtimes = [...new Set(managedRuntimes.values())];
  await Promise.all(runtimes.map((runtime) => runtime.stop()));
  managedRuntimes.clear();
}

async function listeningPid(cdpUrl: string): Promise<number> {
  if (process.platform !== 'win32') return 0;
  const port = portFromCdpUrl(cdpUrl);
  const { stdout } = await execFileAsync('netstat.exe', ['-ano', '-p', 'tcp'], { windowsHide: true });
  for (const line of stdout.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length >= 5 && columns[1]?.endsWith(`:${port}`) && columns[3] === 'LISTENING') return Number(columns[4]) || 0;
  }
  return 0;
}

async function setBrowserWindowState(cdpUrl: string, windowState: 'quiet' | 'visible' | 'minimized' | 'normal'): Promise<void> {
  const load = createRequire(import.meta.url);
  const isPackaged = process.versions.electron
    ? (load('electron') as typeof import('electron')).app.isPackaged
    : false;
  const { chromium } = load(isPackaged
    ? path.join(process.resourcesPath, 'playwright-core')
    : 'playwright-core') as typeof import('playwright-core');
  const browser = await chromium.connectOverCDP(cdpUrl);
  try {
    const context = browser.contexts()[0];
    const page = context?.pages()[0] ?? await context?.newPage();
    if (!page) return;
    const session = await context!.newCDPSession(page);
    const { windowId } = await session.send('Browser.getWindowForTarget') as { windowId: number };
    if (windowState === 'quiet' || windowState === 'minimized') {
      // Keep it minimized/off-screen as a second line of defense.
      await session.send('Browser.setWindowBounds', {
        windowId,
        bounds: {
          windowState: 'minimized',
          left: -32000,
          top: -32000,
          width: X_BROWSER_VIEWPORT.width,
          height: X_BROWSER_VIEWPORT.height
        }
      });
      return;
    }
    await session.send('Browser.setWindowBounds', {
      windowId,
      bounds: {
        windowState: 'normal',
        left: 80,
        top: 80,
        width: X_BROWSER_VIEWPORT.width,
        height: X_BROWSER_VIEWPORT.height
      }
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

async function hidePyaireaderWindowsOnWindows(): Promise<void> {
  if (process.platform !== 'win32') return;
  await runPyaireaderWindowScript('hide');
}

async function showPyaireaderWindowsOnWindows(): Promise<void> {
  if (process.platform !== 'win32') return;
  await runPyaireaderWindowScript('show');
}

async function runPyaireaderWindowScript(mode: 'hide' | 'show'): Promise<void> {
  // Only touch the dedicated pyaireader Edge worker windows. Never the user's normal browser.
  // hide: SW_HIDE + toolwindow + cloak => no taskbar button / no visible flash.
  // show: restore appwindow + uncloak + SW_RESTORE for explicit takeover only.
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class WmbWin {
  public const int GWL_EXSTYLE = -20;
  public const int WS_EX_APPWINDOW = 0x00040000;
  public const int WS_EX_TOOLWINDOW = 0x00000080;
  public const int WS_EX_NOACTIVATE = 0x08000000;
  public const int SW_HIDE = 0;
  public const int SW_SHOWNOACTIVATE = 4;
  public const int SW_RESTORE = 9;
  public const int SWP_NOSIZE = 0x0001;
  public const int SWP_NOMOVE = 0x0002;
  public const int SWP_NOACTIVATE = 0x0010;
  public const int SWP_SHOWWINDOW = 0x0040;
  public const int SWP_HIDEWINDOW = 0x0080;
  public static readonly IntPtr HWND_BOTTOM = new IntPtr(1);
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);
}
"@
$targets = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -match 'msedge|chrome' -and $_.CommandLine -match 'pyaireader\\\\edge-cdp-profiles|pyaireader/edge-cdp-profiles'
}
if (-not $targets) { return }
$pids = @{}
foreach ($p in $targets) { $pids[[uint32]$p.ProcessId] = $true }
$mode = '${mode}'
[WmbWin]::EnumWindows({
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  [uint32]$procId = 0
  [void][WmbWin]::GetWindowThreadProcessId($hWnd, [ref]$procId)
  if (-not $pids.ContainsKey($procId)) { return $true }
  $cls = New-Object System.Text.StringBuilder 256
  [void][WmbWin]::GetClassName($hWnd, $cls, $cls.Capacity)
  if ($cls.ToString() -notmatch 'Chrome_WidgetWin_1') { return $true }
  $ex = [WmbWin]::GetWindowLong($hWnd, [WmbWin]::GWL_EXSTYLE)
  if ($mode -eq 'hide') {
    $ex = ($ex -bor [WmbWin]::WS_EX_TOOLWINDOW -bor [WmbWin]::WS_EX_NOACTIVATE) -band (-bnot [WmbWin]::WS_EX_APPWINDOW)
    [void][WmbWin]::SetWindowLong($hWnd, [WmbWin]::GWL_EXSTYLE, $ex)
    $cloak = 1
    [void][WmbWin]::DwmSetWindowAttribute($hWnd, 13, [ref]$cloak, 4)
    [void][WmbWin]::ShowWindow($hWnd, [WmbWin]::SW_HIDE)
    [void][WmbWin]::SetWindowPos($hWnd, [WmbWin]::HWND_BOTTOM, -32000, -32000, 0, 0, [uint32]([WmbWin]::SWP_NOSIZE -bor [WmbWin]::SWP_NOACTIVATE -bor [WmbWin]::SWP_HIDEWINDOW))
  } else {
    $ex = ($ex -bor [WmbWin]::WS_EX_APPWINDOW) -band (-bnot [WmbWin]::WS_EX_TOOLWINDOW) -band (-bnot [WmbWin]::WS_EX_NOACTIVATE)
    [void][WmbWin]::SetWindowLong($hWnd, [WmbWin]::GWL_EXSTYLE, $ex)
    $cloak = 0
    [void][WmbWin]::DwmSetWindowAttribute($hWnd, 13, [ref]$cloak, 4)
    [void][WmbWin]::ShowWindow($hWnd, [WmbWin]::SW_RESTORE)
    [void][WmbWin]::SetWindowPos($hWnd, [IntPtr]::Zero, 80, 80, 0, 0, [uint32]([WmbWin]::SWP_NOSIZE -bor [WmbWin]::SWP_SHOWWINDOW))
    [void][WmbWin]::SetForegroundWindow($hWnd)
  }
  return $true
}, [IntPtr]::Zero) | Out-Null
`
  await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], {
    windowsHide: true,
    timeout: 4_000
  });
}

function portFromCdpUrl(cdpUrl: string): number {
  const port = Number(new URL(cdpUrl).port || '9222');
  if (!Number.isInteger(port) || port <= 0) throw new Error(`无效的 CDP 地址：${cdpUrl}`);
  return port;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法分配 CDP 端口。');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForCdp(cdpUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`${cdpUrl}/json/version`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('浏览器未在时限内提供 CDP；请先完全关闭正在运行的同 profile Edge 后重试。');
}
