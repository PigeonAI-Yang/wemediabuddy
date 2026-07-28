import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

export type BrowserConfig = {
  id: string;
  label: string;
  executablePath: string;
  userDataDir: string;
  profileDirectory: string;
  cdpUrl?: string;
};

export type BrowserRuntime = {
  executablePath: string;
  profilePath: string;
  pid: number;
  cdpUrl: string;
  stop: () => void;
};

const edgeExecutable = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const configKey = 'browser.config';

export async function discoverBrowserProfiles(): Promise<BrowserConfig[]> {
  const profiles: BrowserConfig[] = [];
  try {
    const pyaireaderDir = path.join(process.env.USERPROFILE!, '.pyaireader', 'edge-cdp-profiles', 'default');
    await access(pyaireaderDir);
    profiles.push({ id: 'edge:pyaireader-default', label: 'Edge · Pyaireader 独立登录态', executablePath: edgeExecutable, userDataDir: pyaireaderDir, profileDirectory: 'Default', cdpUrl: 'http://127.0.0.1:9334' });
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

export async function startBrowser(config: BrowserConfig): Promise<BrowserRuntime> {
  if (config.cdpUrl && await cdpReady(config.cdpUrl)) {
    return { executablePath: config.executablePath, profilePath: config.userDataDir, pid: 0, cdpUrl: config.cdpUrl, stop: () => {} };
  }
  const port = await reservePort();
  const child = spawn(config.executablePath, [
    `--user-data-dir=${config.userDataDir}`,
    `--profile-directory=${config.profileDirectory}`,
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    '--new-window',
    'about:blank'
  ], { detached: false, stdio: 'ignore' });
  if (!child.pid) throw new Error('浏览器未能启动。');
  const cdpUrl = `http://127.0.0.1:${port}`;
  await waitForCdp(cdpUrl);
  return {
    executablePath: config.executablePath,
    profilePath: path.join(config.userDataDir, config.profileDirectory),
    pid: child.pid,
    cdpUrl,
    stop: () => child.kill()
  };
}

async function cdpReady(cdpUrl: string): Promise<boolean> {
  try { return (await fetch(`${cdpUrl}/json/version`)).ok; } catch { return false; }
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
