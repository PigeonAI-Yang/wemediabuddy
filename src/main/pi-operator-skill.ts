import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PI_AUTHORITY_SYSTEM_PROMPT = '你是 WeMediaBuddy 内置 Pi。业务读写只能通过 wmb_* MCP 工具完成；禁止直接写文件或数据库；禁止最终发布；需要确认、激活或发布的动作只能由用户在 WMB UI 完成。按已加载 Skills 操作，回答简洁中文。';

export function operatorSkillSourcePath(): string {
  const local = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../skills/wemedia-buddy-operator');
  try {
    const electron = createRequire(import.meta.url)('electron') as { app?: { isPackaged?: boolean } };
    if (electron.app?.isPackaged) return path.join(process.resourcesPath, 'skills', 'wemedia-buddy-operator');
  } catch {}
  return local;
}

export async function operatorSkillRevision(sourceRoot = operatorSkillSourcePath()): Promise<string> {
  const hash = createHash('sha256');
  for (const relativePath of await skillFiles(sourceRoot)) {
    hash.update(relativePath.replaceAll('\\', '/')).update('\0').update(await readFile(path.join(sourceRoot, relativePath))).update('\0');
  }
  return hash.digest('hex');
}

export async function installPiOperatorSkill(agentDir: string): Promise<{ path: string; revision: string }> {
  const sourceRoot = operatorSkillSourcePath();
  const revision = await operatorSkillRevision(sourceRoot);
  const skillsRoot = path.join(agentDir, 'skills');
  const target = path.join(skillsRoot, 'wemedia-buddy-operator');
  try {
    if (await operatorSkillRevision(target) === revision) return { path: target, revision };
  } catch {}
  const staging = path.join(skillsRoot, `.wemedia-buddy-operator.installing-${process.pid}-${randomUUID()}`);
  await mkdir(skillsRoot, { recursive: true });
  try {
    await cp(sourceRoot, staging, { recursive: true, force: true });
    await writeFile(path.join(staging, '.wmb-install.json'), JSON.stringify({ name: 'wemedia-buddy-operator', revision }) + '\n', 'utf8');
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return { path: target, revision };
}

export async function installPiOperatorSkillForDataRoots(dataRootPaths: string[]): Promise<Array<{ path: string; revision: string }>> {
  return Promise.all(dataRootPaths.map((rootPath) => installPiOperatorSkill(path.join(rootPath, 'pi-agent'))));
}

async function skillFiles(root: string, relative = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await skillFiles(root, next));
    else if (entry.isFile() && entry.name !== '.wmb-install.json') files.push(next);
  }
  return files;
}
