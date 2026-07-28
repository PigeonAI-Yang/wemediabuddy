import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type SettingsSnapshot = {
  paths: Record<'dataRoot' | 'database' | 'assets' | 'browserProfile' | 'logs' | 'exports', string>;
  usage: Record<'database' | 'assets' | 'browserProfile' | 'logs' | 'exports', number>;
  counts: { migrations: number; appMeta: number };
  mcp: { status: 'not_started' | 'ready'; url: string | null };
  health: { database: 'ready'; mcp: 'not_started'; browser: 'not_started'; jobs: 'not_started'; platforms: Record<'x' | 'xiaohongshu' | 'wechat', 'unknown'> };
};

export async function readSettings(rootPath: string): Promise<SettingsSnapshot> {
  const paths = {
    dataRoot: rootPath,
    database: path.join(rootPath, 'wmb.db'),
    assets: path.join(rootPath, 'assets'),
    browserProfile: path.join(rootPath, 'browser-profile'),
    logs: path.join(rootPath, 'logs'),
    exports: path.join(rootPath, 'exports')
  };
  const database = new DatabaseSync(paths.database, { readOnly: true });
  const counts = {
    migrations: Number((database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as { count: number }).count),
    appMeta: Number((database.prepare('SELECT COUNT(*) AS count FROM app_meta').get() as { count: number }).count)
  };
  database.close();
  return {
    paths,
    usage: {
      database: (await stat(paths.database)).size,
      assets: await directorySize(paths.assets),
      browserProfile: await directorySize(paths.browserProfile),
      logs: await directorySize(paths.logs),
      exports: await directorySize(paths.exports)
    },
    counts,
    mcp: { status: 'not_started', url: null },
    health: { database: 'ready', mcp: 'not_started', browser: 'not_started', jobs: 'not_started', platforms: { x: 'unknown', xiaohongshu: 'unknown', wechat: 'unknown' } }
  };
}

async function directorySize(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) bytes += await directorySize(entryPath);
    else if (entry.isFile()) bytes += (await stat(entryPath)).size;
  }
  return bytes;
}
