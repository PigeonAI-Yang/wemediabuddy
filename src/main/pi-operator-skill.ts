import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { WorkspaceProfileV1 } from './workspace-profiles.ts';

type PiSkillInstallResult = { path: string; revision: string };

const piSkillInstallQueues = new Map<string, Promise<PiSkillInstallResult>>();
export const PI_AUTHORITY_SYSTEM_PROMPT = '你是 WeMediaBuddy 的主编席主管（desk）。你管理记者/策划/写手/资料员，不替代员工长跑：需要扫渠道派 reporter，需要出方案派 planner，需要写正文/补全文派 writer，需要整理资料派 librarian。派工用 wmb_spawn_job（只传角色与业务参数，写手必须带 projectId；系统按角色自动选择固定工作流）；员工终态会 JOB_EVENT 推送（succeeded/failed/cancelled/partial/needs_user 五态，含 code/message/readback），优先等通知；不要 sleep/bash 轮询；必要时 wmb_get_job；传话 wmb_message_job；今日阶段编排可用 wmb_run_daily_stage / wmb_continue_after_scan。业务读写只能通过 wmb_* 工具；禁止直接写文件或数据库；禁止最终发布与硬删资料；只有工具或 Skill 明确要求 UI 确认的动作才交给用户，已授权直接执行的动作不得追加确认。需要写业务事实时必须携带消息中的 taskId、grantId、workerLeaseId；若出现 [WMB_AUTHORITY_BLOCKED] 则向用户说明本页未授权原因，禁止伪造 authority。资料员派单为真实执行任务：整理/归档会真实落库，无可整理内容时必须回报 no-op 确认——末条回复附 ```json {"wmb_noop": true} ``` 确认块，声明 wmb_noop 后不得执行任何写操作，不得假装完成；资料整理用 wmb_judge_sources/wmb_restore_source/wmb_update_source_status（软移出可恢复）。按已加载 Skills 操作，回答简洁中文。';
export function piTaskAuthorityPrompt(input: { taskId: string; grantId?: string | null; workerLeaseId?: string | null; context?: string }): string {
  if (!input.grantId || !input.workerLeaseId) throw new Error('PI_TASK_AUTHORITY_REQUIRED');
  const context = input.context?.trim();
  return `${PI_AUTHORITY_SYSTEM_PROMPT}${context ? ` ${context}` : ''} 当前 taskId=${input.taskId}；当前自动签发 grantId=${input.grantId}；当前 Pi workerLeaseId=${input.workerLeaseId}。写业务事实必须携带 taskId、grantId、workerLeaseId 三个值；本次任务的授权已随启动或继续动作自动完成，无需用户额外授权。`;
}

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
