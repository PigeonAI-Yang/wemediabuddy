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

  // 实例卡动作：复制 jobId（全部）+ 取消（活动非终态）+ 续派/关闭（needs_user）+ 续派（历史）。
  assert.match(instances, /复制 jobId/);
  assert.match(instances, /inst\.status === 'needs_user'/);
  assert.match(instances, />\s*续派\s*</);
  assert.match(instances, />\s*关闭\s*</);
  assert.match(instances, />\s*取消\s*</);

  // 五角色分组始终可见，空角色「当前无任务」；历史每角色折叠区。
  assert.match(overview, /className="agents-role-empty">当前无任务</);
  assert.match(instances, /className="agents-role-history"/);
  assert.match(instances, /历史 · \{history\.length\}/);
  assert.match(instances, /className="agents-instance-list"/);

  // 页头摘要：工作中/排队/等你批 + 容量，全部来自投影；可点过滤。
  assert.match(source, /工作中 \{counts\.running\}/);
  assert.match(source, /排队 \{counts\.queued\}/);
  assert.match(source, /等你批 \{counts\.needsUser\}/);
  assert.match(source, /容量 \{pool\.maxWorkers\}/);
  assert.match(source, /setFilter\('running'\)/);
  assert.match(source, /setFilter\('all'\)/);

  // 桌助不渲染实例卡（desk 分支先返回，无 agents-instance-list）。
  assert.match(overview, /if \(roleId === 'desk'\)/);
  assert.match(overview, /roleId === 'desk'[\s\S]*?return \(/);

  // 数据接线：投影 + 桌助行 + 容量 + 头像。
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
  // 桌助受阻（deskConflict）时视图输出 agents-status-dot/word status-blocked，
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
  // 固定员工角色序不含 desk：桌助永远不进入活动实例区（协调入口语义）。
  assert.deepEqual([...EMPLOYEE_ORDER], ['reporter', 'planner', 'writer', 'librarian']);
});

test('view DOM gates: overview first, compact controls second, active+history unified third (WMB-5151)', async () => {
  const source = await readFile(new URL('../src/renderer/agents-roster-view.tsx', import.meta.url), 'utf8');
  const instances = await readFile(new URL('../src/renderer/agents-roster-instances.tsx', import.meta.url), 'utf8');
  const overview = await readFile(new URL('../src/renderer/agents-roster-overview.tsx', import.meta.url), 'utf8');
  // Owner 指定顺序：班组概览 → 紧凑状态/派单 → 活动实例+历史工单统一组件。
  assert.match(source, /className="agents-main"/);
  assert.match(source, /className="agents-active"/);
  assert.match(source, /className="agents-overview"/);
  assert.match(source, /className="agents-history-area"/);
  assert.match(source, /className="agents-control-strip"/);
  assert.match(source, /className="agents-work-ledger" aria-label="活动实例与历史工单"/);
  assert.ok(source.indexOf('className="agents-overview"') < source.indexOf('className="agents-team-card"'));
  assert.ok(source.indexOf('className="agents-team-card"') < source.indexOf('className="agents-work-ledger"'));
  assert.doesNotMatch(source, /className="page-command"/, 'the old 96px command card must stay removed');
  assert.doesNotMatch(source, /className="agents-groups"/, 'island grid must be gone');
  // 活动实例区内容驱动：仅当存在可见实例角色才渲染，否则给紧凑筛选空态，不占网格。
  assert.match(source, /sections\.length > 0 \?/);
  assert.match(source, /sections\.map\(/);
  assert.match(source, /<ActiveRoleInstances[\s>]/, 'active role sections render through the extracted component');
  assert.match(source, /className="agents-filter-empty"/);
  // 概览始终渲染全部五组；空角色仍「当前无任务」，有实例角色带状态词 + 跳转。
  assert.match(source, /ORDER\.map\(/);
  assert.match(source, /<RoleOverviewRow[\s>]/, 'overview rows render through the extracted component');
  assert.match(overview, /className="agents-role-empty">当前无任务</);
  assert.match(overview, /agents-overview-jump/);
  assert.match(source, /projection === null \? \(\s*<p className="agents-overview-loading" role="status">正在读取班组状态…<\/p>/, 'overview must not invent empty roles before projection loads');
  assert.match(source, /role="group" aria-label="按实例状态筛选"/, 'status filters expose their group semantics');
  assert.match(source, /aria-pressed=\{filter === 'running'\}/);
  assert.match(source, /aria-pressed=\{filter === 'queued'\}/);
  assert.match(source, /aria-pressed=\{filter === 'needs_user'\}/);
  // 统一历史区按角色折叠（historyRoles 只收集有历史的角色，无参差高度）。
  assert.match(source, /historyRoles\.map\(/);
  assert.match(instances, /className="agents-role-history"/);
  assert.match(instances, /<summary>\{roleLabel\(roleId\)\} · 历史 · \{history\.length\}<\/summary>/, 'unified history rows retain their role context');
  // 概览跳转活动区实例：scrollIntoView + prefers-reduced-motion 尊重。
  assert.match(source, /scrollToRole/);
  assert.match(source, /prefers-reduced-motion/);
});

test('view DOM gates: desk stays coordination entry in overview, weaker than instance cards (WMB-5146)', async () => {
  const overview = await readFile(new URL('../src/renderer/agents-roster-overview.tsx', import.meta.url), 'utf8');
  // desk 分支先返回：概览行 = 协调入口状态 + 提示，不渲染实例卡。
  assert.match(overview, /if \(roleId === 'desk'\)/);
  assert.match(overview, /协调入口 · 派工与盯梢请到桌助对话/);
  assert.match(overview, /agents-overview-row is-desk/);
  // 桌助状态行仍由 deskConflict 驱动（WMB-5137 双编码保持）。
  assert.match(overview, /const deskState = deskOccupied \? \(deskConflict \? '受阻' : '工作中'\) : '当前无任务'/);
});

test('styles gates: responsive continuous zones, no island grid, single-card constraint (WMB-5146)', async () => {
  const cssShell = await readFile(new URL('../src/renderer/styles-agents.css', import.meta.url), 'utf8');
  const cssOverview = await readFile(new URL('../src/renderer/styles-agents-overview.css', import.meta.url), 'utf8');
  const cssInstances = await readFile(new URL('../src/renderer/styles-agents-instances.css', import.meta.url), 'utf8');
  const cssStatus = await readFile(new URL('../src/renderer/styles-agents-status.css', import.meta.url), 'utf8');
  const css = cssShell + cssOverview + cssInstances + cssStatus;
  assert.doesNotMatch(css, /\.agents-groups/, 'island grid styles must be gone');
  // 同角色多实例才展开实例卡网格（auto-fit minmax 240px）；单实例收窄（:has only-child）。
  assert.match(cssInstances, /\.agents-instance-list\s*\{/);
  assert.match(cssInstances, /repeat\(auto-fit, minmax\(min\(100%, 240px\), 1fr\)\)/);
  assert.match(cssInstances, /agents-instance-card:only-child/);
  // 概览：连续 auto-fit 紧凑目录（宽屏一排、窄屏换行，min(100%,…) 单列保底，无横向溢出）。
  assert.match(cssOverview, /\.agents-overview-grid\s*\{/);
  assert.match(cssOverview, /repeat\(auto-fit, minmax\(min\(100%, 140px\), 1fr\)\)/);
  // 等你批卡主次明确：info 边框 + 内环 + 底色。
  assert.match(cssInstances, /\.agents-instance-card\.status-needs_user/);
  assert.match(cssInstances, /background: color-mix\(in srgb, var\(--info\) 5%, var\(--surface\)\)/);
  // 统一历史区 + 每角色折叠；新交互元素聚焦轮廓与 reduced-motion 保留。
  assert.match(cssInstances, /\.agents-history-area/);
  assert.match(cssInstances, /\.agents-work-ledger\s*\{/);
  assert.match(cssShell, /\.agents-control-strip\s*\{/);
  assert.match(cssInstances, /\.agents-role-history \+ \.agents-role-history/);
  assert.match(cssOverview, /\.agents-overview-jump:focus-visible/);
  assert.match(cssShell, /prefers-reduced-motion/);
  // 无 seat/slot 样式回归（WMB-5143 门延续）。
  for (const term of ['待命', '槽位', '坐席', 'agents-seat', 'slot']) {
    assert.doesNotMatch(css, new RegExp(term), `styles must not contain ${term}`);
  }
});
