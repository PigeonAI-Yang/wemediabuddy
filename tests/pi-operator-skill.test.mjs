import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { operatorSkillRevision, PI_AUTHORITY_SYSTEM_PROMPT } from '../src/main/pi-operator-skill.ts';
import { libraryOrganizePrompt } from '../src/main/role-job-policies.ts';

const skillPath = path.join('skills', 'wemedia-buddy-operator', 'SKILL.md');
const toolsRoot = path.join('.pi', 'extensions', 'wmb-mcp');

test('Pi operator Skill documents exactly the registered WMB tools and hard boundaries', async () => {
  const skill = await readFile(skillPath, 'utf8');
  const toolFiles = (await readdir(toolsRoot)).filter((name) => /^wmb-mcp-tools-.+\.ts$/.test(name));
  const registered = new Set();
  for (const file of toolFiles) {
    const source = await readFile(path.join(toolsRoot, file), 'utf8');
    for (const match of source.matchAll(/name:\s*['"]((?:wmb|xhs)_[a-z0-9_]+)['"]/g)) registered.add(match[1]);
  }
  const documented = new Set([...skill.matchAll(/`((?:wmb|xhs)_[a-z0-9_]+)`/g)].map((match) => match[1]));

  assert.deepEqual([...documented].sort(), [...registered].sort());
  assert.doesNotMatch(skill, /\b(?:TODO|TBD)\b/);
  assert.doesNotMatch(skill, /pyaireader/i);
  assert.match(skill, /禁止直接写文件、SQLite、data-root 或安装目录/);
  assert.match(skill, /最终确认、激活和最终发布只由用户/);
  assert.match(skill, /写入后必须按返回 ID 精确回读/);
  assert.match(skill, /数据库、并发取消或内部错误不是登录失效/);
  assert.match(skill, /只操作当前 MCP URL 绑定的工作空间/);
  assert.match(skill, /browserProfileId \/ bindingRevision \/ state \/ expectedAccountSnapshots/);
  assert.match(skill, /registry default.*绝不是运行时 fallback/);
  assert.match(skill, /创建、改绑或迁移旧登录态也只能由 Owner 在 Settings/);
  assert.match(skill, /不存在 browser profile 创建、改绑、验证或迁移工具/);
  assert.match(skill, /ACCOUNT_MISMATCH.*业务写入必须为零/);
  assert.match(skill, /X 是实时 X Lists 的前置验证账号/);
  assert.match(skill, /不要另起一次选题或提议重复保存方案/);
  assert.match(skill, /设置 → Pi Skills/);
  assert.match(skill, /不得直接修改安装目录、data-root 副本/);
  assert.match(skill, /系统会持久排队并自动派资料员读取最新现场/);
  assert.match(skill, /带 `supersedesProposalId` 的新版建议/);
  assert.match(skill, /桌助不得要求 Owner 手工改主题/);
  assert.match(skill, /历史 stale 仅作记录，不主动重提/);
  assert.match(PI_AUTHORITY_SYSTEM_PROMPT, /真冲突由系统自动交回资料员/);
  assert.match(PI_AUTHORITY_SYSTEM_PROMPT, /不得要求主管手工改主题/);
  const librarianPrompt = libraryOrganizePrompt({ id: 'task-1' }, { jobId: 'job-1', brief: 'supersedesProposalId=old-proposal' });
  assert.match(librarianPrompt, /必须读取旧提案与最新现场/);
  assert.match(librarianPrompt, /不得复制旧快照或自动批准/);
});

test('UK lane routes X work through current-root WMB tools, not the retired external provider', async () => {
  const skill = await readFile(path.join('skills', 'uk-life-content-radar', 'SKILL.md'), 'utf8');
  assert.doesNotMatch(skill, /pyaireader/i);
  assert.match(skill, /`wmb_read_x_list_index`/);
  assert.match(skill, /不能换账号、另建工作空间浏览器 profile 或迁移其他账号绑定/);
});

test('WMB-5144: operator Skill registers multi-instance semantics without slot metaphors (EVAL-CAP-027 skill 面)', async () => {
  const skill = await readFile(skillPath, 'utf8');
  // 多实例感知：同角色多实例合法，实例以 jobId 一等身份指认
  assert.match(skill, /同一角色可能同时有多个工单实例/);
  assert.match(skill, /精确 `jobId`/);
  assert.ok(skill.includes('不引用其他实例会话'), 'skill must forbid referencing other instance sessions');
  assert.ok(skill.includes('不假设自己是唯一在岗员工'), 'skill must forbid assuming sole active worker');
  assert.ok(skill.includes('显示编号只在活动期可见'), 'display numbering must not identify across restarts');
  // 读取 → 判断 → 精确动作协议
  assert.ok(skill.includes('读取 → 判断 → 精确动作'), 'read → judge → precise action protocol required');
  assert.ok(skill.includes('`wmb_cancel_job`（参数 jobId）'), 'cancel must take exact jobId');
  assert.ok(skill.includes('`wmb_message_job`（参数 jobId、body）'), 'message must take exact jobId/body');
  // 状态语义：queued / waiting_resource / running / needs_user；needs_user 不占 worker 且需人处理
  assert.ok(skill.includes('`queued`=排队等容量'), 'queued explained');
  assert.ok(skill.includes('`waiting_resource`=等资源'), 'waiting_resource explained');
  assert.ok(skill.includes('`running`=工作中'), 'running explained');
  assert.ok(skill.includes('`needs_user`=等你批'), 'needs_user explained');
  assert.ok(skill.includes('不占 worker、不持 lease/grant/锁'), 'needs_user holds no worker capacity/lease/grant/lock');
  assert.ok(skill.includes('需用户处理或关闭后才闭环'), 'needs_user needs human handling');
  assert.ok(skill.includes('不自动重试'), 'no automatic retry');
  assert.ok(skill.includes('不要把 waiting_resource 说成失败'), 'waiting_resource is not failure');
  // 桌助边界：不占员工容量、不可 spawn、留言≠代批
  assert.ok(skill.includes('不占员工执行容量'), 'desk occupies no employee capacity');
  assert.ok(skill.includes('不可派工给桌助自己'), 'desk cannot be spawned');
  assert.ok(skill.includes('不等于代批'), 'messaging is not approving');
  // maxWorkers=0 含义：共享容量非角色配额
  assert.ok(skill.includes('0=派工停用（spawn 拒绝）'), 'maxWorkers=0 disables dispatch');
  assert.ok(skill.includes('不是每角色配额'), 'maxWorkers is not per-role quota');
  // 历史/活动不混淆；续派从 context_refs_json 重建
  assert.ok(skill.includes('活动视图=池内 queued/waiting_resource/running + 终态 needs_user'), 'active vs history not conflated');
  assert.match(skill, /context_refs_json` 为锚/, 'history rebuilds from context_refs_json');
  assert.ok(skill.includes('续派=从 context_refs_json 重建原 RoleJobRequest'), 'redispatch rebuilds RoleJobRequest');
  // 桌助呈报事实源：只来自投影 API，禁止编造
  assert.ok(skill.includes('禁止编造进度或状态'), 'no fabricated progress/status');
  // 旧槽位隐喻整体移除（WMB-5144 禁词：仅迁移说明/negative assertion 允许，本 Skill 零出现）
  assert.doesNotMatch(skill, /槽位|坐席|工位|待命|席位/, 'slot metaphors must be gone from the operator Skill');
});

test('WMB-5144: desk/employee system prompt registers multi-instance awareness and desk boundary', () => {
  assert.ok(PI_AUTHORITY_SYSTEM_PROMPT.includes('同一角色可能同时有多个工单实例'), 'prompt must state same-role multi-instance is legal');
  assert.ok(PI_AUTHORITY_SYSTEM_PROMPT.includes('jobId'), 'prompt must identify instances by jobId');
  assert.ok(PI_AUTHORITY_SYSTEM_PROMPT.includes('不引用其他实例会话'), 'prompt must forbid cross-instance session references');
  assert.ok(PI_AUTHORITY_SYSTEM_PROMPT.includes('不假设自己是唯一在岗员工'), 'prompt must forbid sole-worker assumption');
  assert.ok(PI_AUTHORITY_SYSTEM_PROMPT.includes('不可派工给桌助自己'), 'desk cannot be spawned');
  assert.ok(PI_AUTHORITY_SYSTEM_PROMPT.includes('0=派工停用'), 'maxWorkers=0 disables dispatch');
  assert.ok(PI_AUTHORITY_SYSTEM_PROMPT.includes('不占 worker、不持 lease/grant/锁'), 'needs_user holds no resources');
  assert.ok(PI_AUTHORITY_SYSTEM_PROMPT.includes('禁止编造进度或状态'), 'desk answers only from projection facts');
  assert.doesNotMatch(PI_AUTHORITY_SYSTEM_PROMPT, /槽位|坐席|工位|待命|席位/, 'prompt must not use slot metaphors');
});

test('WMB-5144 P2 closure: model-facing tool/roster/dock copy keeps 桌助 identity (no supervisor-as-desk)', async () => {
  const [managerTools, mcpSource, jobTools, roster, dock, dispatch, orchestration] = await Promise.all([
    readFile(path.join(toolsRoot, 'wmb-mcp-tools-manager.ts'), 'utf8'),
    readFile('src/main/mcp.ts', 'utf8'),
    readFile('src/main/mcp-job-tools.ts', 'utf8'),
    readFile('src/main/role-roster.ts', 'utf8'),
    readFile('src/main/ipc-pi-dock.ts', 'utf8'),
    readFile('src/main/manager-dispatch.ts', 'utf8'),
    readFile('src/main/manager-orchestration.ts', 'utf8')
  ]);
  // Pi tool labels/descriptions: desk-as-coordinator, no supervisor-as-caller, no seat metaphor
  assert.ok(managerTools.includes('读取班组投影'), 'roster label must drop 席位');
  assert.ok(managerTools.includes('桌助协调用'), 'roster description must name 桌助');
  assert.ok(managerTools.includes('桌助读进度用'), 'list jobs must be 桌助-facing');
  assert.ok(managerTools.includes('桌助派工'), 'spawn label must be 桌助');
  assert.ok(managerTools.includes('不可派工给桌助自己'), 'spawn must forbid desk self-dispatch');
  assert.ok(managerTools.includes('桌助取消员工工单'), 'cancel must be 桌助-facing');
  assert.ok(managerTools.includes('桌助向指定工单传话'), 'message must be 桌助-facing');
  assert.ok(managerTools.includes('桌助给某工单的留言列表'), 'list messages must be 桌助-facing');
  assert.ok(managerTools.includes('桌助选用的自动续接工具'), 'continue must be 桌助-facing');
  assert.ok(managerTools.includes('桌助启动今日阶段'), 'run stage label must be 桌助');
  assert.doesNotMatch(managerTools, /主管监工|主管读进度|主管派工|不可派主管自己|主管取消|主管向指定工单传话|主管给某工单|主管选用|主管启动今日阶段|读取班组席位/, 'no supervisor-as-desk wording in Pi tools');
  // Raw MCP descriptions (mcp.ts + mcp-job-tools.ts)
  assert.ok(mcpSource.includes('读取固定角色班组投影状态（桌助/记者/策划/写手/资料员）与摘要进度。只读。'), 'agents.roster description aligned');
  assert.ok(mcpSource.includes('是否续接由桌助决定'), 'daily.readiness description aligned');
  assert.ok(mcpSource.includes('桌助工具：在扫描完成后显式续接策划'), 'daily.continue_after_scan description aligned');
  assert.ok(mcpSource.includes('桌助启动今日情报阶段'), 'daily.run_stage description aligned');
  assert.ok(mcpSource.includes('自动编排能力由桌助选用，不是禁用'), 'run_stage autonomy stays 桌助');
  assert.ok(jobTools.includes('桌助读进度用'), 'jobs.list description aligned');
  assert.ok(jobTools.includes('桌助向员工角色派有界工单'), 'jobs.spawn description aligned');
  assert.ok(jobTools.includes('不可派工给桌助自己'), 'jobs.spawn desk guard aligned');
  assert.ok(jobTools.includes('桌助取消员工工单'), 'jobs.cancel description aligned');
  assert.ok(jobTools.includes('桌助给指定工单留言'), 'jobs.message description aligned');
  assert.ok(jobTools.includes('桌助无需轮询'), 'monitor note aligned');
  assert.doesNotMatch(mcpSource + jobTools, /主管监工|主管读进度|主管派工|不可派主管自己|主管取消|主管选用|主管启动|主管工具|席位状态|终态会推送主管|主管无需轮询/, 'no supervisor-as-desk wording in raw MCP copy');
  // Roster desk row display mapping: 桌助/协调入口 at the projection layer (registry untouched)
  assert.ok(roster.includes('DESK_ROSTER_FACE'), 'roster must define a desk display face');
  assert.ok(roster.includes("labelZh: '桌助'"), 'desk row labelZh must be 桌助');
  assert.ok(roster.includes("roomZh: '协调入口'"), 'desk row roomZh must be 协调入口');
  assert.ok(roster.includes("roleId === 'desk' ? DESK_ROSTER_FACE : ROLE_CATALOG[roleId]"), 'desk row must use the display face, not the registry entry');
  // Dock manager prompt identity: 桌助, not 主管
  assert.ok(dock.includes('你是桌助。自动编排是你的工具'), 'dock contextRule must call the desk 桌助');
  assert.ok(dispatch.includes('你是桌助，编排方式由你选'), 'manager dispatch prompt must call the desk 桌助');
  assert.ok(dispatch.includes('班组 · 桌助'), 'manager dispatch page label must be 桌助');
  assert.ok(orchestration.includes('已按桌助指令续接策划'), 'continue-after-scan output must be 桌助-facing');
  assert.doesNotMatch(dock + dispatch, /你是主管/, 'no supervisor identity in dock/manager prompts');
  assert.doesNotMatch(orchestration, /已按主管指令续接策划/, 'no supervisor instruction copy in orchestration output');
});

test('WMB-5144: installed data-root and packaged mirrors stay in sync with canonical (behavior eval)', async (t) => {
  const canonical = await operatorSkillRevision(path.resolve('skills/wemedia-buddy-operator'));
  const mirrors = [
    path.join('data', 'gamedata', 'pi-agent', 'skills', 'wemedia-buddy-operator'),
    path.join('data', 'ukcontentdata', 'pi-agent', 'skills', 'wemedia-buddy-operator'),
    path.join('out', 'WeMediaBuddy-win32-x64', 'resources', 'skills', 'wemedia-buddy-operator')
  ].filter((root) => existsSync(path.join(root, 'SKILL.md')));
  if (mirrors.length === 0) {
    t.skip('no installed mirrors in this checkout');
    return;
  }
  const canonicalSkill = await readFile(skillPath, 'utf8');
  for (const root of mirrors) {
    const markerPath = path.join(root, '.wmb-install.json');
    if (existsSync(markerPath)) {
      assert.equal(JSON.parse(await readFile(markerPath, 'utf8')).revision, canonical, `${root} revision must match canonical`);
    }
    assert.equal(await readFile(path.join(root, 'SKILL.md'), 'utf8'), canonicalSkill, `${root} SKILL.md must match canonical`);
  }
});
