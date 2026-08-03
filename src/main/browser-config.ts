import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BrowserConfig } from './browser.ts';

const sharedId = 'edge:wmb-installation';
const sharedLabel = 'Edge · WMB 共享登录态';
const edgeExecutable = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
let configuredPath: string | null = null;

type Envelope = { version: 1; config: BrowserConfig };

export function configureBrowserConfigPath(configPath: string): void { configuredPath = path.resolve(configPath); }

export function readBrowserConfig(configPath = configuredPath): BrowserConfig | null {
  if (!configPath || !existsSync(configPath)) return null;
  const envelope = JSON.parse(readFileSync(configPath, 'utf8')) as Envelope;
  if (envelope.version !== 1) throw new Error('浏览器配置文件版本不受支持。');
  return normalize(envelope.config);
}

export function saveBrowserConfig(config: BrowserConfig, configPath = requiredPath()): BrowserConfig {
  const normalized = normalize(config);
  mkdirSync(path.dirname(configPath), { recursive: true });
  mkdirSync(normalized.userDataDir, { recursive: true });
  const temporaryPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify({ version: 1, config: normalized } satisfies Envelope, null, 2)}\n`, 'utf8');
  renameSync(temporaryPath, configPath);
  return normalized;
}

export function discoverBrowserProfiles(selected = readBrowserConfig(), configPath = requiredPath()): BrowserConfig[] {
  return [selected ?? normalize({
    id: sharedId, label: sharedLabel, executablePath: edgeExecutable,
    userDataDir: path.join(path.dirname(configPath), 'browser-profile'), profileDirectory: 'Default'
  })];
}

export function migrateBrowserConfigToInstallation(configPath: string, rootPaths: string[]): { migratedFrom: string | null; config: BrowserConfig } {
  configureBrowserConfigPath(configPath);
  const existing = readBrowserConfig(configPath);
  if (existing) { mkdirSync(existing.userDataDir, { recursive: true }); return { migratedFrom: null, config: existing }; }
  const candidates = rootPaths.flatMap((rootPath) => {
    const databasePath = path.join(rootPath, 'wmb.db');
    if (!existsSync(databasePath)) return [];
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = database.prepare("SELECT value FROM app_meta WHERE key='browser.config'").get() as { value?: string } | undefined;
      return row?.value ? [{ rootPath, config: JSON.parse(row.value) as BrowserConfig }] : [];
    } finally { database.close(); }
  });
  const selected = candidates.find((item) => item.config.id === 'edge:pyaireader-default') ?? candidates[0];
  const config = saveBrowserConfig(selected?.config ?? discoverBrowserProfiles(null, configPath)[0], configPath);
  return { migratedFrom: selected?.rootPath ?? null, config };
}

function normalize(config: BrowserConfig): BrowserConfig { return { ...config, id: sharedId, label: sharedLabel }; }
function requiredPath(): string {
  if (!configuredPath) throw new Error('安装级浏览器配置路径尚未初始化。');
  return configuredPath;
}
