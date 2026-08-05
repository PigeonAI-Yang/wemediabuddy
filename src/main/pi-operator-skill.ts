import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { WorkspaceProfileV1 } from './workspace-profiles.ts';

type PiSkillInstallResult = { path: string; revision: string };

const piSkillInstallQueues = new Map<string, Promise<PiSkillInstallResult>>();
export const PI_AUTHORITY_SYSTEM_PROMPT = '你是 WeMediaBuddy 内置 Pi。业务读写只能通过 wmb_* 工具完成；禁止直接写文件或数据库；禁止最终发布；只有工具或 Skill 明确要求 UI 确认的动作才交给用户，已授权直接执行的动作不得追加确认。需要写资料时只调用 wmb_save_source（底层命令 sources.upsert_batch），并携带当前 taskId、Owner grantId 和 WMB 注入的 workerLeaseId；缺少任一项就停止并说明。按已加载 Skills 操作，回答简洁中文。';

export function operatorSkillSourcePath(): string {
  return skillSourcePath('wemedia-buddy-operator');
}

function skillSourcePath(skillId: string): string {
  const local = path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../../skills/${skillId}`);
  try {
    const electron = createRequire(import.meta.url)('electron') as { app?: { isPackaged?: boolean } };
    if (electron.app?.isPackaged) return path.join(process.resourcesPath, 'skills', skillId);
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
  return installPiSkill(agentDir, 'wemedia-buddy-operator', operatorSkillSourcePath());
}

export async function installPiWorkspaceLaneSkill(dataRootPath: string, agentDir = path.join(dataRootPath, 'pi-agent')): Promise<{ path: string; revision: string } | null> {
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(path.join(dataRootPath, 'wmb.db'), { readOnly: true });
    const row = database.prepare("SELECT intelligence_pack_id AS skillId FROM workspace_profiles WHERE id='effective'").get() as { skillId?: WorkspaceProfileV1['intelligencePackId'] } | undefined;
    return row?.skillId ? installPiSkill(agentDir, row.skillId, skillSourcePath(row.skillId)) : null;
  } catch (error) {
    if (/unable to open database|no such table/i.test(error instanceof Error ? error.message : String(error))) return null;
    throw error;
  } finally {
    database?.close();
  }
}

export function installPiSkill(agentDir: string, name: string, sourceRoot: string, metadata: Record<string, unknown> = {}): Promise<PiSkillInstallResult> {
  const queueKey = path.resolve(agentDir, 'skills', name);
  const previous = piSkillInstallQueues.get(queueKey);
  let installation!: Promise<PiSkillInstallResult>;
  installation = (previous ? previous.catch(() => undefined) : Promise.resolve())
    .then(() => installPiSkillOnce(agentDir, name, sourceRoot, metadata))
    .finally(() => {
      if (piSkillInstallQueues.get(queueKey) === installation) piSkillInstallQueues.delete(queueKey);
    });
  piSkillInstallQueues.set(queueKey, installation);
  return installation;
}

async function installPiSkillOnce(agentDir: string, name: string, sourceRoot: string, metadata: Record<string, unknown>): Promise<PiSkillInstallResult> {
  const revision = await operatorSkillRevision(sourceRoot);
  const skillsRoot = path.join(agentDir, 'skills');
  const target = path.join(skillsRoot, name);
  try {
    if (await operatorSkillRevision(target) === revision) return { path: target, revision };
  } catch {}
  const staging = path.join(skillsRoot, `.${name}.installing-${process.pid}-${randomUUID()}`);
  await mkdir(skillsRoot, { recursive: true });
  try {
    await cp(sourceRoot, staging, { recursive: true, force: true });
    await writeFile(path.join(staging, '.wmb-install.json'), JSON.stringify({ name, revision, ...metadata }) + '\n', 'utf8');
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
