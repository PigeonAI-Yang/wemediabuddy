import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getPiRuntimeInfo, type PiRuntimeInfo } from './pi-runtime-manager.ts';
import { MEDIA_LIMITS_DEFAULT } from '../shared/media-limits.ts';
import { mediaAssetStorageReport, mediaStagingStorageReport } from './media-governance.ts';

export type SettingsSnapshot = {
  paths: Record<'dataRoot' | 'database' | 'assets' | 'boundBrowserProfile' | 'legacyBrowserProfile' | 'logs' | 'exports', string>;
  usage: Record<'database' | 'assets' | 'boundBrowserProfile' | 'legacyBrowserProfile' | 'logs' | 'exports', number>;
  counts: { migrations: number; appMeta: number };
  mcp: { status: 'not_started' | 'ready'; url: string | null };
  health: { database: 'ready'; mcp: 'not_started' | 'ready'; browser: 'not_started' | 'ready'; jobs: 'not_started'; platforms: Record<'x' | 'xiaohongshu' | 'wechat' | 'zhihu', 'unknown'> };
  piRuntime: PiRuntimeInfo;
  /** WMB-5247：媒体容量（原始/派生/staging 数量与字节如实报告；设计 §14）。 */
  media: {
    assets: {
      total: { count: number; bytes: number };
      original: { count: number; bytes: number };
      derived: { count: number; bytes: number };
    };
    staging: { count: number; bytes: number };
    retentionDays: number;
  };
};

export async function readSettings(rootPath: string, options?: { mcpStatus?: 'not_started' | 'ready'; mcpUrl?: string | null; browserStatus?: 'not_started' | 'ready'; boundBrowserProfilePath?: string }): Promise<SettingsSnapshot> {
  const paths = {
    dataRoot: rootPath,
    database: path.join(rootPath, 'wmb.db'),
    assets: path.join(rootPath, 'assets'),
    boundBrowserProfile: options?.boundBrowserProfilePath ?? '',
    legacyBrowserProfile: path.join(rootPath, 'browser-profile'),
    logs: path.join(rootPath, 'logs'),
    exports: path.join(rootPath, 'exports')
  };
  const piRuntime = await getPiRuntimeInfo(rootPath);
  const database = new DatabaseSync(paths.database, { readOnly: true });
  const counts = {
    migrations: Number((database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as { count: number }).count),
    appMeta: Number((database.prepare('SELECT COUNT(*) AS count FROM app_meta').get() as { count: number }).count)
  };
  const mediaAssets = mediaAssetStorageReport(database);
  database.close();
  const staging = await mediaStagingStorageReport(rootPath);
  return {
    paths,
    usage: {
      database: (await stat(paths.database)).size,
      assets: await directorySize(paths.assets),
      boundBrowserProfile: paths.boundBrowserProfile ? await directorySize(paths.boundBrowserProfile) : 0,
      legacyBrowserProfile: await directorySize(paths.legacyBrowserProfile),
      logs: await directorySize(paths.logs),
      exports: await directorySize(paths.exports)
    },
    counts,
    media: {
      assets: mediaAssets.assets,
      staging,
      retentionDays: MEDIA_LIMITS_DEFAULT.derivedCacheRetentionDays
    },
    mcp: { status: options?.mcpStatus ?? 'not_started', url: options?.mcpUrl ?? null },
    health: { database: 'ready', mcp: options?.mcpStatus ?? 'not_started', browser: options?.browserStatus ?? 'not_started', jobs: 'not_started', platforms: { x: 'unknown', xiaohongshu: 'unknown', wechat: 'unknown', zhihu: 'unknown' } },
    piRuntime
  };
}

async function directorySize(directory: string): Promise<number> {
  let pending = [directory];
  let bytes = 0;
  while (pending.length > 0) {
    const directories = pending.splice(0, 16);
    const batches = await Promise.all(directories.map(async (current) => {
      try {
        return await readdir(current, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    }));
    const files: string[] = [];
    for (let index = 0; index < directories.length; index += 1) {
      for (const entry of batches[index]) {
        const entryPath = path.join(directories[index], entry.name);
        if (entry.isDirectory()) pending.push(entryPath);
        else if (entry.isFile()) files.push(entryPath);
      }
    }
    for (let offset = 0; offset < files.length; offset += 16) {
      const sizes = await Promise.all(files.slice(offset, offset + 16).map(async (file) => {
        try {
          return (await stat(file)).size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
          throw error;
        }
      }));
      bytes += sizes.reduce((sum, size) => sum + size, 0);
    }
  }
  return bytes;
}
