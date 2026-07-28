import { mkdir, open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const requiredEntries = ['wmb.db', 'assets', 'browser-profile', 'logs', 'exports'] as const;

export type DataRoot = { path: string; isNew: boolean };

export async function openDataRoot(rootPath: string): Promise<DataRoot> {
  const resolvedPath = path.resolve(rootPath);
  let rootStats: Awaited<ReturnType<typeof stat>> | undefined;
  try {
    rootStats = await stat(resolvedPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  if (rootStats && !rootStats.isDirectory()) throw new Error('数据根目录必须是目录。');
  const entries = await Promise.all(requiredEntries.map((entry) => exists(path.join(resolvedPath, entry))));
  const complete = entries.every(Boolean);
  if (rootStats && !complete) {
    if (entries.some(Boolean) || (await readdir(resolvedPath)).length > 0) {
      throw new Error('现有数据根目录不完整，无法打开。');
    }
  }

  if (!rootStats) await mkdir(resolvedPath, { recursive: true });
  if (!complete) {
    await Promise.all(['assets', 'browser-profile', 'logs', 'exports'].map((entry) => mkdir(path.join(resolvedPath, entry))));
    await (await open(path.join(resolvedPath, 'wmb.db'), 'a')).close();
  }
  return { path: resolvedPath, isNew: !complete };
}

export async function validateDataRoot(rootPath: string): Promise<DataRoot> {
  const resolvedPath = path.resolve(rootPath);
  const checks = await Promise.all(requiredEntries.map(async (entry) => {
    try { return await stat(path.join(resolvedPath, entry)); } catch { return undefined; }
  }));
  if (!checks[0]?.isFile() || checks.slice(1).some((entry) => !entry?.isDirectory())) {
    throw new Error('数据根目录缺少 WMB 所需文件或目录。');
  }
  return { path: resolvedPath, isNew: false };
}

async function exists(targetPath: string): Promise<boolean> {
  try { await stat(targetPath); return true; } catch { return false; }
}
