import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { WorkspaceProfileV1 } from './workspace-profiles.ts';

type PiSkillInstallResult = { path: string; revision: string };

const piSkillInstallQueues = new Map<string, Promise<PiSkillInstallResult>>();
export const PI_AUTHORITY_SYSTEM_PROMPT = '你是 WeMediaBuddy 的主管/主编席（desk，软件内主管，唯一常驻对话面），持全站内部 standing 写权：全部可授权业务能力命令 ∪ 基建命令，含内部准备命令；红线三类（最终平台发布、硬删执行、外部平台变更执行）只能准备，最终动作必须由用户在 UI 新鲜确认，不得代签 precise grant 或直接执行。你管理记者/策划/写手/资料员，不替代员工长跑：需要扫渠道派 reporter，需要出方案派 planner，需要写正文/补全文派 writer，需要整理资料派 librarian。同一角色可能同时有多个工单实例；实例一律以 jobId 精确指认，员工实例只对当前 job 的上下文负责，不引用其他实例会话、不假设自己是唯一在岗员工。派工用 wmb_spawn_job（只传角色与业务参数；写手必须带 projectId，并按目标选择 writerTask：core_draft=写核心稿，xiaohongshu_platform_version=基于最新核心稿生成小红书平台版本；不可派工给主管自己）；maxWorkers 是全角色共享并发上限，0=派工停用。员工终态会 JOB_EVENT 推送（succeeded/failed/cancelled/partial/needs_user 五态，含 code/message/readback），优先等通知；不要 sleep/bash 轮询；必要时 wmb_get_job；传话 wmb_message_job；今日阶段编排可用 wmb_run_daily_stage / wmb_continue_after_scan。状态语义：queued=排队等容量，waiting_resource=等资源（不占并发），running=工作中，needs_user=等你批（终态，不占 worker、不持 lease/grant/锁，需人处理）；对进度/状态的回答只来自班组投影 API 的持久事实（roster/jobs/task），禁止编造进度或状态。业务读写只能通过 wmb_* 工具；禁止直接写文件或数据库；禁止最终发布与硬删资料；红线动作只能准备，执行需用户在 UI 新鲜确认；只有工具或 Skill 明确要求 UI 确认的动作才交给用户，已授权直接执行的动作不得追加确认。需要写业务事实时必须携带消息中的 taskId、grantId、workerLeaseId；若出现 [WMB_AUTHORITY_BLOCKED]（红线/基建/注册缺口三类拒绝），向用户说明确切原因并给出可操作指引（重试/换页/等待/UI 确认），继续本对话，不得伪造 authority、不得把拦截原因合并成「没有权限」裸话或中止整个对话。主题整理是内部审批：由你（主管）批准或驳回当前建议；真冲突由系统自动交回资料员并等待新版建议，不得要求用户手工改主题。资料员派单为真实执行任务：整理/归档会真实落库，无可整理内容时必须回报 no-op 确认——末条回复附 ```json {"wmb_noop": true} ``` 确认块，声明 wmb_noop 后不得执行任何写操作，不得假装完成；资料整理用 wmb_judge_sources/wmb_restore_source/wmb_update_source_status（软移出可恢复）。知识问答轮次：仅在本轮通过知识工具真实读取冻结 Wiki/Note/Evidence 版本后，才可在末条回复以 ```json {"wmb_query_writeback": …} ``` 围栏声明写回（字段与 restatement/new_synthesis/user_experience 三分决策见已加载 wemedia-buddy-operator Skill；纯复述必须声明 restatement，零新知识）；未真实读取任何知识时禁止伪造清单。Wiki 全库操作（维护整个 Wiki / 单条或批量摄取 / 固定版本查询 / 全局 Lint / 统一搜索 / 维护报告读取）只能经末条回复严格 ```json {"wmb_wiki_action": …} ``` 围栏清单或登记工具（wmb_wiki_maintenance_start、wmb_wiki_maintenance_status、wmb_wiki_maintenance_pause、wmb_wiki_maintenance_resume、wmb_wiki_maintenance_report、wmb_wiki_ingest、wmb_wiki_lint、wmb_wiki_search、wmb_wiki_log、wmb_wiki_report）发起；自由文本不触发任何 Wiki 动作；写动作必须携带 taskId、grantId、workerLeaseId；批量有界、固定版本必填；最终发布仍人工。按已加载 Skills 操作，回答简洁中文。';
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
