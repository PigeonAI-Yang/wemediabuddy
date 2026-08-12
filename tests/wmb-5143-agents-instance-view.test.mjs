import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  EMPLOYEE_ORDER,
  STATUS_WORD,
  activeRoleSections,
  elapsedLabel,
  filterActiveInstances,
  headerCounts,
  instanceDetail,
  instanceTiming,
  redispatchInput,
  roleOverviewStatus,
  sortInstancesForDisplay,
  statusWord,
  waitReasonLabel
} from '../src/renderer/agents-instance-logic.ts';

function instance(overrides = {}) {
  return {
    jobId: 'job-1',
    roleId: 'reporter',
    brief: '扫 A 渠道',
    intent: 'daily_scan',
    status: 'running',
    displayNumber: 1,
    waitReason: null,
    waitingSince: null,
    progressLabel: null,
    progressRatio: null,
    phase: null,
    taskId: null,
    sessionFile: null,
    piSessionId: null,
    businessDate: null,
    projectId: null,
    error: null,
    code: null,
    queuedAt: '2026-08-09T01:00:00Z',
    startedAt: '2026-08-09T01:00:00Z',
    finishedAt: null,
    source: 'memory',
    ...overrides
  };
}

test('status words are double-encoded labels with no idle/待命 instance state (EVAL-030)', () => {
  assert.equal(STATUS_WORD.queued, '排队中');
  assert.equal(STATUS_WORD.waiting_resource, '等资源');
  assert.equal(STATUS_WORD.running, '工作中');
  assert.equal(STATUS_WORD.needs_user, '等你批');
  assert.equal(STATUS_WORD.succeeded, '已完成');
  assert.equal(STATUS_WORD.partial, '部分完成');
  assert.equal(STATUS_WORD.failed, '失败');
  assert.equal(STATUS_WORD.cancelled, '已取消');
  assert.equal(statusWord('mystery'), '未知');
  for (const word of Object.values(STATUS_WORD)) {
    assert.notEqual(word, '待命', 'no fictional standby state');
  }
});

test('wait reasons are human-readable, never bare codes or bare 等资源 (design §11.1)', () => {
  assert.equal(waitReasonLabel(instance({ status: 'waiting_resource', waitReason: 'RESOURCE_LOCK_CONFLICT: plan:<ws>:<date>' })), '等资源释放：该任务对象正被占用');
  assert.equal(waitReasonLabel(instance({ status: 'waiting_resource', waitReason: 'RESOURCE_LEASE_BUSY: 软上限 1 已达' })), '等资源释放：执行租约忙');
  assert.equal(waitReasonLabel(instance({ status: 'waiting_resource', waitReason: 'RESOURCE_JUDGE_IN_FLIGHT: scan-judge 窗口' })), '等扫判交接完成');
  assert.equal(waitReasonLabel(instance({ status: 'waiting_resource', waitReason: null })), '排队等容量');
  assert.equal(waitReasonLabel(instance({ status: 'waiting_resource', waitReason: 'custom park reason' })), 'custom park reason');
  assert.equal(waitReasonLabel(instance({ status: 'queued', waitReason: null })), '排队等容量');
  assert.equal(waitReasonLabel(instance({ status: 'needs_user', waitReason: null })), '需要你处理');
});

test('instance detail answers 谁/在干什么/卡在哪 with actionable copy', () => {
  assert.equal(instanceDetail(instance({ phase: 'judging_opportunities' })), 'judging_opportunities');
  assert.equal(instanceDetail(instance({ status: 'queued' })), '排队等容量');
  assert.equal(
    instanceDetail(instance({ status: 'needs_user', code: 'PI_CONFIG_REQUIRED', error: '缺少浏览器账号绑定，请先到设置补齐' })),
    '缺少浏览器账号绑定，请先到设置补齐'
  );
  assert.equal(instanceDetail(instance({ status: 'failed', code: 'JOB_READBACK_MISSING', error: '缺少业务读回' })), '缺少业务读回');
  assert.equal(instanceDetail(instance({ status: 'succeeded' })), null);
});

test('elapsed labels are bounded and stable', () => {
  const start = '2026-08-09T01:00:00Z';
  assert.equal(elapsedLabel(start, '2026-08-09T01:00:30Z'), '30s');
  assert.equal(elapsedLabel(start, '2026-08-09T01:01:30Z'), '1m30s');
  assert.equal(elapsedLabel(start, '2026-08-09T03:00:00Z'), '2h0m');
  assert.equal(elapsedLabel(null), '—');
  assert.equal(elapsedLabel(start, '2026-08-08T01:00:00Z'), '—');
});

test('instance timing chooses the right anchor per status', () => {
  assert.deepEqual(instanceTiming(instance({ status: 'running', startedAt: '2026-08-09T01:00:00Z' })).prefix, '已跑');
  assert.deepEqual(instanceTiming(instance({ status: 'queued', queuedAt: '2026-08-09T01:00:00Z' })).prefix, '已等');
  assert.deepEqual(
    instanceTiming(instance({ status: 'waiting_resource', waitingSince: '2026-08-09T01:00:00Z', queuedAt: '2026-08-09T00:00:00Z' })).prefix,
    '已等'
  );
  assert.deepEqual(instanceTiming(instance({ status: 'needs_user', queuedAt: '2026-08-09T01:00:00Z' })).prefix, '停留');
});

test('header summary comes only from projection counts (UI 单源)', () => {
  const summary = { active: 4, queued: 1, waitingResource: 1, running: 2, needsUser: 1, history: 3 };
  assert.deepEqual(headerCounts(summary), { running: 2, queued: 1, needsUser: 1 });
  assert.deepEqual(headerCounts(null), { running: 0, queued: 0, needsUser: 0 });
});

test('status filter only affects card visibility, never group presence', () => {
  const list = [
    instance({ jobId: 'a', status: 'running', displayNumber: 1 }),
    instance({ jobId: 'b', status: 'queued', displayNumber: 2 }),
    instance({ jobId: 'c', status: 'needs_user', displayNumber: 3 })
  ];
  assert.equal(filterActiveInstances(list, 'all').length, 3);
  assert.deepEqual(filterActiveInstances(list, 'running').map((i) => i.jobId), ['a']);
  assert.deepEqual(filterActiveInstances(list, 'queued').map((i) => i.jobId), ['b']);
  assert.deepEqual(filterActiveInstances(list, 'needs_user').map((i) => i.jobId), ['c']);
});

test('redispatch input rebuilds the UI-side spawn params from projection fields', () => {
  assert.deepEqual(redispatchInput(instance({ roleId: 'reporter', brief: '扫 A 渠道', businessDate: '2026-08-09' })), {
    roleId: 'reporter',
    brief: '扫 A 渠道',
    businessDate: '2026-08-09'
  });
  assert.deepEqual(redispatchInput(instance({ roleId: 'writer', brief: '写正文', projectId: 'p-7' })), {
    roleId: 'writer',
    brief: '写正文',
    projectId: 'p-7'
  });
  assert.deepEqual(redispatchInput(instance({ roleId: 'planner', brief: '出方案' })), { roleId: 'planner', brief: '出方案' });
});

test('view DOM gates: instance-driven groups, cards, history, actions (EVAL-030)', async () => {
  const source = await readFile(new URL('../src/renderer/agents-roster-view.tsx', import.meta.url), 'utf8');
  const instances = await readFile(new URL('../src/renderer/agents-roster-instances.tsx', import.meta.url), 'utf8');
  const overview = await readFile(new URL('../src/renderer/agents-roster-overview.tsx', import.meta.url), 'utf8');

  // 活动期编号：同角色多实例可辨（「记者 #1」「记者 #2」）。
  assert.match(instances, /inst\.displayNumber > 0 \? <span className="agents-instance-number"> #\{inst\.displayNumber\}/);

  // 任务卡动作：复制任务编号（全部）+ 取消（活动非终态）+ 续派/关闭（needs_user）+ 续派（历史）。
  assert.match(instances, /复制任务编号/);
  assert.match(instances, /inst\.status === 'needs_user'/);
  assert.match(instances, />\s*续派\s*</);
  assert.match(instances, />\s*关闭\s*</);
  assert.match(instances, />\s*取消\s*</);

  // 五角色分组始终可见，空角色「当前无任务」；历史每角色折叠区。
  assert.match(overview, /className="agents-role-empty">当前无任务</);
  assert.match(instances, /className="agents-role-history"/);
  assert.match(instances, /历史 · \{history\.length\}/);
  assert.match(instances, /className="agents-instance-list"/);

  // WMB-5195：手动派单整体移除（agents-team-card/agents-spawn-bar/工作计数/筛选/容量不迁移）。
  assert.doesNotMatch(source, /agents-team-card/);
  assert.doesNotMatch(source, /agents-spawn-bar/);
  assert.doesNotMatch(source, /spawnRole|spawnBrief|setFilter\(/);
  // 续派路径保留：jobsSpawn 只经 redispatchInput 进入（历史/等你批续派仍可用）。
  assert.match(source, /window\.wmb\.jobsSpawn\(redispatchInput\(instance\)\)/);

  // 主管不渲染实例卡（desk 分支先返回，无 agents-instance-list）。
  assert.match(overview, /if \(roleId === 'desk'\)/);
  assert.match(overview, /roleId === 'desk'[\s\S]*?return \(/);

  // 数据接线：投影 + 主管行 + 容量 + 头像。
  assert.match(source, /getCrewInstanceProjection/);
  assert.match(source, /getAgentsRoster/);
  assert.match(source, /jobsPoolStatus/);
});

test('styles gates: no seat/slot styles, running dot has no pulse animation', async () => {
  const cssShell = await readFile(new URL('../src/renderer/styles-agents.css', import.meta.url), 'utf8');
  const cssOverview = await readFile(new URL('../src/renderer/styles-agents-overview.css', import.meta.url), 'utf8');
  const cssInstances = await readFile(new URL('../src/renderer/styles-agents-instances.css', import.meta.url), 'utf8');
  const cssStatus = await readFile(new URL('../src/renderer/styles-agents-status.css', import.meta.url), 'utf8');
  const css = cssShell + cssOverview + cssInstances + cssStatus;
  for (const term of ['待命', '槽位', '坐席', 'agents-seat', 'slot']) {
    assert.doesNotMatch(css, new RegExp(term), `styles must not contain ${term}`);
  }
  assert.match(cssStatus, /\.agents-status-dot\.status-running/);
  assert.doesNotMatch(cssStatus, /status-running[\s\S]{0,80}animation/);
  assert.match(cssInstances, /\.agents-instance-card/);
  assert.match(cssShell, /\.agents-role-group/);
  assert.match(cssOverview, /\.agents-role-empty/);
});

test('styles gates: desk blocked state keeps danger double-encoding (WMB-5143 P3-1)', async () => {
  const cssStatus = await readFile(new URL('../src/renderer/styles-agents-status.css', import.meta.url), 'utf8');
  // 主管受阻（deskConflict）时视图输出 agents-status-dot/word status-blocked，
  // 样式必须给红点 + 红字（danger），不得退回透明圆点/默认墨色。
  assert.match(cssStatus, /\.agents-status-dot\.status-blocked\s*\{\s*background:\s*var\(--danger\)/);
  assert.match(cssStatus, /\.agents-status-word\.status-blocked\s*\{\s*color:\s*var\(--danger\)/);
});

test('view load gates: null projection flips error state, stale requests dropped (WMB-5143 P3-2)', async () => {
  const source = await readFile(new URL('../src/renderer/agents-roster-view.tsx', import.meta.url), 'utf8');
  // 投影 IPC 单独失败（其余三路成功）→ load 结果 proj 为 null 时置错误态，
  // 连接中断 banner + 重试出现，加载门 projection === null && !stale 不再永久成立。
  assert.match(source, /setStale\(!proj\)/);
  assert.match(source, /projection === null && !stale/);
  // 并发保护：interval/onDataChanged 重叠时仅最新请求落地，旧结果不得覆盖新状态。
  assert.match(source, /requestSeq !== latestSeq/);
  assert.match(source, /requestSeq === latestSeq/);
});

// ---- WMB-5146：三区连续架构（活动实例区 → 班组概览 → 统一历史区）的 fixture 渲染与结构/响应式门 ----

function projectFixture(byRole = {}) {
  const roles = ['reporter', 'planner', 'writer', 'librarian'];
  const empty = { active: [], history: [] };
  return {
    active: [],
    history: [],
    summary: { active: 0, queued: 0, waitingResource: 0, running: 0, needsUser: 0, history: 0 },
    byRole: Object.fromEntries(roles.map((r) => [r, byRole[r] ?? empty]))
  };
}

test('fixture render: display sort puts needs_user first, stable across polls (WMB-5146)', () => {
  const a = instance({ jobId: 'a', status: 'running', displayNumber: 1 });
  const b = instance({ jobId: 'b', status: 'needs_user', displayNumber: 2 });
  const c = instance({ jobId: 'c', status: 'queued', displayNumber: 3 });
  const d = instance({ jobId: 'd', status: 'needs_user', displayNumber: 1 });
  const sorted = sortInstancesForDisplay([a, c, b, d]);
  assert.deepEqual(sorted.map((i) => i.jobId), ['d', 'b', 'a', 'c'], 'needs_user leads, then running, then queued; displayNumber tiebreak');
  assert.deepEqual(sortInstancesForDisplay(sorted).map((i) => i.jobId), ['d', 'b', 'a', 'c'], 'idempotent across polls');
});

test('fixture render: active area sections = roles with visible instances, fixed order (WMB-5146)', () => {
  const proj = projectFixture({
    reporter: {
      active: [
        instance({ jobId: 'r1', status: 'running', displayNumber: 1 }),
        instance({ jobId: 'r2', status: 'needs_user', displayNumber: 2 })
      ],
      history: []
    },
    writer: { active: [instance({ jobId: 'w1', roleId: 'writer', status: 'queued', displayNumber: 1 })], history: [] },
    planner: { active: [], history: [] },
    librarian: { active: [], history: [] }
  });
  const sections = activeRoleSections(proj, 'all');
  assert.deepEqual(sections.map((s) => s.roleId), ['reporter', 'writer'], 'only roles with visible instances, fixed employee order');
  assert.deepEqual(sections[0].visible.map((i) => i.jobId), ['r2', 'r1'], 'needs_user leads inside the role section');
  assert.equal(sections[0].total, 2);
  assert.deepEqual(activeRoleSections(proj, 'needs_user').map((s) => s.roleId), ['reporter'], 'filter hides roles with no matching instance');
  assert.deepEqual(activeRoleSections(proj, 'queued').map((s) => s.roleId), ['writer']);
});

test('fixture render: overview status covers empty/filtered/active + leader word (WMB-5146)', () => {
  assert.deepEqual(roleOverviewStatus([], 'all'), { kind: 'empty' });
  const active = [instance({ jobId: 'a', status: 'running', displayNumber: 1 }), instance({ jobId: 'b', status: 'needs_user', displayNumber: 2 })];
  assert.deepEqual(roleOverviewStatus(active, 'all'), { kind: 'active', leaderStatus: 'needs_user', total: 2 });
  assert.deepEqual(roleOverviewStatus(active, 'running'), { kind: 'active', leaderStatus: 'running', total: 1 });
  assert.deepEqual(roleOverviewStatus(active, 'queued'), { kind: 'filtered' }, 'instances exist but hidden by filter');
  // 固定员工角色序不含 desk：主管永远不进入活动实例区（非员工槽语义）。
  assert.deepEqual([...EMPLOYEE_ORDER], ['reporter', 'planner', 'writer', 'librarian']);
});

test('view DOM gates: overview first, active+history unified second (WMB-5151/5195)', async () => {
  const source = await readFile(new URL('../src/renderer/agents-roster-view.tsx', import.meta.url), 'utf8');
  const instances = await readFile(new URL('../src/renderer/agents-roster-instances.tsx', import.meta.url), 'utf8');
  const overview = await readFile(new URL('../src/renderer/agents-roster-overview.tsx', import.meta.url), 'utf8');
  // Owner 指定顺序：班组概览 → 进行中的任务+历史任务统一组件（派单控制面已整块删除）。
  assert.match(source, /className="agents-main"/);
  assert.match(source, /className="agents-active"/);
  assert.match(source, /className="agents-overview"/);
  assert.doesNotMatch(source, /agents-overview-title/, 'overview heading copy must be gone (WMB-5187)');
  assert.match(source, /<section className="agents-overview" aria-label="班组概览">/, 'overview section keeps its accessible label (WMB-5187)');
  assert.match(source, /className="agents-history-area"/);
  assert.doesNotMatch(source, /agents-control-strip/, 'compact controls card must be gone (WMB-5195)');
  assert.match(source, /className="agents-work-ledger" aria-label="进行中的任务与历史任务"/);
  assert.ok(source.indexOf('className="agents-overview"') < source.indexOf('className="agents-work-ledger"'));
  assert.doesNotMatch(source, /className="agents-team-card"/, 'team card block must be gone');
  assert.doesNotMatch(source, /className="agents-spawn-bar"/, 'spawn bar must be gone');
  assert.doesNotMatch(source, /className="page-command"/, 'the old 96px command card must stay removed');
  assert.doesNotMatch(source, /className="agents-groups"/, 'island grid must be gone');
  // 活动实例区内容驱动：仅当存在可见实例角色才渲染，否则给紧凑空态，不占网格。
  assert.match(source, /sections\.length > 0 \?/);
  assert.match(source, /sections\.map\(/);
  assert.match(source, /<ActiveRoleInstances[\s>]/, 'active role sections render through the extracted component');
  assert.match(source, /className="agents-filter-empty"/);
  // 概览始终渲染全部五组；空角色仍「当前无任务」，有实例角色带状态词。
  assert.match(source, /ORDER\.map\(/);
  assert.match(source, /<RoleOverviewRow[\s>]/, 'overview rows render through the extracted component');
  assert.match(overview, /className="agents-role-empty">当前无任务</);
  assert.doesNotMatch(overview, /agents-overview-jump/, 'jump button replaced by whole-card button (WMB-5195)');
  assert.match(source, /projection === null \? \(\s*<p className="agents-overview-loading" role="status">正在读取班组状态…<\/p>/, 'overview must not invent empty roles before projection loads');
  // 角色与能力配置入口移到概览头部轻量位置（保留配置，移除派单）。
  assert.match(source, /agents-overview-head/);
  assert.match(source, />角色与能力配置</);
  // 统一历史区按角色折叠（historyRoles 只收集有历史的角色，无参差高度）。
  assert.match(source, /historyRoles\.map\(/);
  assert.match(instances, /className="agents-role-history"/);
  assert.match(instances, /<summary>\{roleLabel\(roleId\)\} · 历史 · \{history\.length\}<\/summary>/, 'unified history rows retain their role context');
});

test('view DOM gates: overview cards are whole-card buttons with truthful progress (WMB-5195)', async () => {
  const overview = await readFile(new URL('../src/renderer/agents-roster-overview.tsx', import.meta.url), 'utf8');
  // 整卡 button + 键盘语义：aria-expanded/aria-controls，禁止卡内嵌套交互元素（头像按钮已移除）。
  assert.match(overview, /className="agents-role-card/);
  assert.match(overview, /aria-expanded=\{expanded\}/);
  assert.match(overview, /aria-controls="agents-detail-panel"/);
  assert.doesNotMatch(overview, /agents-role-avatar/, 'avatar is not a nested button inside the card anymore');
  // 进度轨主导：卡内恒显 role=progressbar；确定轨带 aria-valuenow，不确定轨只加 indeterminate 类。
  assert.match(overview, /role="progressbar"/);
  assert.match(overview, /aria-valuenow=\{present\.determinate && present\.ratio != null \? Math\.round\(present\.ratio \* 100\) : undefined\}/);
  assert.match(overview, /agents-work-progress\$\{present\.indeterminate \? ' indeterminate' : ''\}/);
  // 进度只认真实比例：running + null → 不确定轨且不显示数字百分比；空角色空轨 0%。
  assert.match(overview, /progressPresentation\(leader\.progressRatio, running\)/);
  assert.match(overview, /progressPresentation\(null, false\)/);
  assert.match(overview, /agents-card-pct">\{present\.percent\}/);
  // 主管行：空轨 0%，非实例；deskConflict 双编码保留。
  assert.match(overview, /progressPresentation\(row\?\.progressRatio, deskOccupied && !deskConflict\)/);
  assert.match(overview, /agents-role-card is-desk/);
});

test('view DOM gates: detail drawer reads real data through shared read-only APIs (WMB-5195)', async () => {
  const source = await readFile(new URL('../src/renderer/agents-roster-view.tsx', import.meta.url), 'utf8');
  const drawer = await readFile(new URL('../src/renderer/agents-detail-drawer.tsx', import.meta.url), 'utf8');
  // 同页右侧抽屉：复用既有 drawer/panel 模式（sources-panel + drawer-backdrop），非 modal。
  assert.match(source, /<AgentsDetailDrawer[\s>]/);
  assert.match(source, /className="drawer-backdrop open"/);
  assert.match(drawer, /className="sources-panel open agents-detail-panel"/);
  // 员工：authoritative projection/task/job transcript；主管：roster taskId + 当前 Pi conversation，同一 dock 事件流。
  assert.match(drawer, /projection\.byRole/);
  assert.match(drawer, /window\.wmb\.getAgentTask\(\{ id: selected\.taskId \}\)\.catch\(\(\) => null\)/);
  assert.match(drawer, /window\.wmb\.jobsMessages\(selected\.jobId\)\.catch\(\(\) => \[\]\)/);
  assert.match(drawer, /window\.wmb\.getAgentTaskTranscript\(selected\.jobId\)\.catch\(\(\) => null\)/);
  assert.match(source, /deskRow=\{deskRow\}/);
  assert.match(source, /deskOccupied=\{deskOccupied\}/);
  assert.match(drawer, /window\.wmb\.getAgentTask\(\{ id: deskRow\.taskId \}\)\.catch\(\(\) => null\)/);
  assert.match(drawer, /window\.wmb\.getPiConversation\(\)\.catch\(\(\) => null\)/);
  assert.match(drawer, /applyPiTranscriptEvent\(items \?\? \[\], event\)/);
  assert.match(drawer, /mergePiConversationWithLive\(disk, current\)/);
  assert.match(drawer, />实时运行记录</);
  // 员工事件重读；主管实时归并并低频与磁盘对账；关闭清理。
  assert.match(drawer, /setInterval\(reload, 5000\)/);
  assert.match(drawer, /window\.addEventListener\('keydown'/);
  // 空态精确「暂无运行明细」，不伪造记录。
  assert.match(drawer, />暂无运行明细</);
  assert.doesNotMatch(drawer, /Math\.random|0\.62|0\.28|0\.15/, 'no fabricated progress values');
});

test('detail transcript separates input, notices, replies, thinking, and tools (WMB-5196)', async () => {
  const drawer = await readFile(new URL('../src/renderer/agents-detail-drawer.tsx', import.meta.url), 'utf8');
  const css = await readFile(new URL('../src/renderer/styles-agents.css', import.meta.url), 'utf8');
  assert.match(drawer, /isPiSystemEvent\(message\)/);
  assert.match(drawer, /<details className="agents-detail-bubble agents-detail-entry system-event">/);
  for (const label of ['系统通知', '安排记录', '任务输入', '智能体回复', '智能体执行', '思考', '回复']) {
    assert.match(drawer, new RegExp(`>${label}<`), `${label} semantic label must remain visible`);
  }
  assert.match(drawer, /segment\.isError \? '错误' : '工具'/);
  assert.match(drawer, /const isLongInput = text\.length > 360 \|\| text\.split\('\\n'\)\.length > 8/);
  assert.match(drawer, /<details className="agents-detail-expandable">/);
  assert.match(css, /\.agents-detail-expandable > summary \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.match(css, /\.agents-detail-transcript \{[\s\S]*gap: 0;[\s\S]*overflow: hidden;/);
  assert.match(css, /\.agents-detail-entry\.user \{[\s\S]*background: color-mix/);
  assert.match(css, /\.agents-detail-entry\.system-event > summary \{[\s\S]*grid-template-columns: auto minmax\(0, 1fr\) auto;/);
  assert.match(css, /\.agents-detail-segment \{[\s\S]*grid-template-columns: 40px minmax\(0, 1fr\);/);
  assert.match(css, /\.agents-detail-segment\.tool \{[\s\S]*background: var\(--surface-raised\);/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test('view DOM gates: desk stays supervisor row in overview, weaker than instance cards (WMB-5146/5184/5187)', async () => {
  const overview = await readFile(new URL('../src/renderer/agents-roster-overview.tsx', import.meta.url), 'utf8');
  // desk 分支先返回：概览行 = 主管/主编席状态，不渲染实例卡。
  assert.match(overview, /if \(roleId === 'desk'\)/);
  // WMB-5187：解释性提示 p 已删除（absence），desk 行结构保持。
  assert.doesNotMatch(overview, /派工、盯梢与内部审批请到主管对话/, 'explanatory supervisor hint must be gone');
  assert.doesNotMatch(overview, /agents-role-hint/, 'no leftover hint class in the desk row');
  assert.match(overview, /agents-role-card is-desk/);
  // 主管状态行仍由 deskConflict 驱动（WMB-5137 双编码保持）。
  assert.match(overview, /const deskState = deskOccupied \? \(deskConflict \? '受阻' : '工作中'\) : '当前无任务'/);
});

test('styles gates: responsive continuous zones, no island grid, single-card constraint (WMB-5146/5195)', async () => {
  const cssShell = await readFile(new URL('../src/renderer/styles-agents.css', import.meta.url), 'utf8');
  const cssOverview = await readFile(new URL('../src/renderer/styles-agents-overview.css', import.meta.url), 'utf8');
  const cssInstances = await readFile(new URL('../src/renderer/styles-agents-instances.css', import.meta.url), 'utf8');
  const cssStatus = await readFile(new URL('../src/renderer/styles-agents-status.css', import.meta.url), 'utf8');
  const css = cssShell + cssOverview + cssInstances + cssStatus;
  assert.doesNotMatch(css, /\.agents-groups/, 'island grid styles must be gone');
  assert.doesNotMatch(cssShell, /\.agents-team-card|\.agents-spawn-bar|\.agents-control-strip/, 'dispatch surface styles must be gone (WMB-5195)');
  // 同角色多实例才展开实例卡网格（auto-fit minmax 240px）；单实例收窄（:has only-child）。
  assert.match(cssInstances, /\.agents-instance-list\s*\{/);
  assert.match(cssInstances, /repeat\(auto-fit, minmax\(min\(100%, 240px\), 1fr\)\)/);
  assert.match(cssInstances, /agents-instance-card:only-child/);
  // 概览高卡：auto-fit 以内容区宽度换行；避免只看窗口宽度强制五列，在 Pi 展开时把卡片压到不可读。
  assert.match(cssOverview, /\.agents-overview-grid\s*\{/);
  assert.doesNotMatch(cssOverview, /\.agents-overview-title/, 'title-only style removed (WMB-5187)');
  assert.match(cssOverview, /repeat\(auto-fit, minmax\(min\(100%, 170px\), 1fr\)\)/);
  assert.doesNotMatch(cssOverview, /repeat\(5, minmax\(0, 1fr\)\)/, 'content-narrow layouts must wrap instead of squeezing five cards');
  assert.match(cssOverview, /\.agents-role-card\s*\{/);
  assert.match(cssOverview, /\.agents-role-card:focus-visible/);
  assert.match(cssOverview, /\.agents-card-avatar\s*\{/);
  assert.match(cssOverview, /width: 120px/);
  assert.match(cssOverview, /height: 120px/);
  assert.match(cssOverview, /min-height: 228px/);
  // 等你批卡主次明确：info 边框 + 内环 + 底色。
  assert.match(cssInstances, /\.agents-instance-card\.status-needs_user/);
  assert.match(cssInstances, /background: color-mix\(in srgb, var\(--info\) 5%, var\(--surface\)\)/);
  // 统一历史区 + 每角色折叠；不确定进度轨 + reduced-motion 保留。
  assert.match(cssInstances, /\.agents-history-area/);
  assert.match(cssInstances, /\.agents-work-ledger\s*\{/);
  assert.match(cssShell, /\.agents-work-progress\.indeterminate/);
  assert.match(cssInstances, /\.agents-role-history \+ \.agents-role-history/);
  assert.match(cssShell, /prefers-reduced-motion/);
  assert.match(cssShell, /\.agents-work-progress\[style\*="--progress"\]:not/, 'minimum fill applies only to determinate progress');
  // 无 seat/slot 样式回归（WMB-5143 门延续）。
  for (const term of ['待命', '槽位', '坐席', 'agents-seat', 'slot']) {
    assert.doesNotMatch(css, new RegExp(term), `styles must not contain ${term}`);
  }
});
