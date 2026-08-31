import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveTodayRunView, isManagerNonterminal, mapTaskToStep, projectManagerTaskForToday, selectTruthfulTask } from '../src/renderer/today-run-view.ts';

const base = {
  task: null,
  localStarting: false,
  hasTodayPlan: false,
  hasRecentPlan: false,
  opportunityCount: 0,
  sssCount: 0,
  sourcesTotal: 0,
  sourcesAreToday: true,
  studioActive: null,
  piConfigured: true,
  channelsSummary: {
    readiness: [{ module: 'official_web', configuredCount: 1, enabledCount: 1, readyCount: 1, blockedCount: 0, status: 'ready' }]
  },
  nowMs: Date.parse('2026-08-06T12:00:00.000Z')
};

test('maps backend phases into four user steps', () => {
  assert.equal(mapTaskToStep(null), 'idle');
  assert.equal(mapTaskToStep({ status: 'running', phase: 'starting' }), 'starting');
  assert.equal(mapTaskToStep({ status: 'running', phase: 'channel_preflight' }), 'scanning');
  assert.equal(mapTaskToStep({ status: 'running', phase: 'judging_opportunities' }), 'judging');
  assert.equal(mapTaskToStep({ status: 'partial' }), 'partial');
  assert.equal(mapTaskToStep({ status: 'needs_user' }), 'needs_user');
  assert.equal(mapTaskToStep({ status: 'succeeded' }), 'done');
  assert.equal(mapTaskToStep({ status: 'failed' }), 'failed');
  assert.equal(mapTaskToStep(null, true), 'starting');
  assert.equal(mapTaskToStep({ status: 'cancelled' }, false, { hasDeliveredPlan: true }), 'done');
  assert.equal(mapTaskToStep({ status: 'failed' }, false, { hasDeliveredPlan: true }), 'done');
});

test('idle without plan uses start CTA and empty guidance', () => {
  const view = deriveTodayRunView(base);
  assert.equal(view.step, 'idle');
  assert.equal(view.primaryCta.label, '开始今日情报');
  assert.match(view.headline, /开始今日情报/);
  assert.equal(view.detail, '滚动采集 → 增量判断 → 选题池');
  assert.equal(view.blockers.length, 0);
  assert.match(view.opportunityEmptyBody, /开始今日情报/);
});

test('historical plan without a visible recommendation renders actionable start guidance', () => {
  const view = deriveTodayRunView({ ...base, hasRecentPlan: false });
  assert.equal(view.step, 'idle');
  assert.equal(view.primaryCta.label, '开始今日情报');
  assert.equal(view.showOpportunityEmpty, true);
  assert.notEqual(view.opportunityEmptyTitle.trim(), '');
  assert.notEqual(view.opportunityEmptyBody.trim(), '');
  assert.equal(view.stats?.find((stat) => stat.label === '今日新增来源')?.value, '0');
  assert.equal(view.stats?.find((stat) => stat.label === '今日内容机会')?.value, '0');
  assert.doesNotMatch(view.headline + view.detail, /已根据入库资料整理出/);
});

test('visible carried recommendation keeps the recent-plan state', () => {
  const view = deriveTodayRunView({ ...base, hasRecentPlan: true });
  assert.equal(view.step, 'idle');
  assert.equal(view.primaryCta.label, '开始今日情报');
  assert.equal(view.showOpportunityEmpty, false);
  assert.equal(view.headline, '当前显示最近可批选题');
});

test('current opportunity pool opens studio and offers rescan', () => {
  const view = deriveTodayRunView({ ...base, hasTodayPlan: true, opportunityCount: 2, sssCount: 1 });
  assert.equal(view.step, 'done');
  assert.equal(view.headline, '');
  assert.equal(view.statusLine, '当前有可批选题');
  assert.equal(view.primaryCta.label, '去创作');
  assert.ok(view.secondaryCtas.some((c) => c.id === 'restart'));
  assert.equal(view.showOpportunityEmpty, false);
});

test('current plan without a visible recommendation never renders an empty title/body or claims approval availability', () => {
  const view = deriveTodayRunView({ ...base, hasTodayPlan: true, opportunityCount: 0 });
  assert.notEqual(view.opportunityEmptyTitle.trim(), '');
  assert.notEqual(view.opportunityEmptyBody.trim(), '');
  assert.notEqual(view.statusLine, '当前有可批选题');
});
test('pending draft count keeps approval CTA after manager projection is unavailable', () => {
  const view = deriveTodayRunView({
    ...base,
    task: { id: 'latest', status: 'partial', phase: 'partial' },
    pendingOpportunityCount: 4,
    opportunityCount: 0,
    hasTodayPlan: false
  });
  assert.equal(view.step, 'needs_user');
  assert.equal(view.primaryCta.kind, 'open_manager');
  assert.equal(view.primaryCta.label, '查看待确认选题');
  assert.match(view.detail, /4 条选题等待确认/);
});


test('scanning exposes progress with an actionable conversation CTA', () => {
  const view = deriveTodayRunView({
    ...base,
    task: {
      id: 't1', status: 'running', phase: 'channel_preflight',
      progress: { planned: 5, processed: 2, currentSource: 'OpenAI' },
      heartbeatAt: '2026-08-06T11:59:50.000Z'
    }
  });
  assert.equal(view.step, 'scanning');
  assert.equal(view.primaryCta.kind, 'continue');
  assert.equal(view.primaryCta.label, '对话中 · 查看进度');
  assert.equal(view.headline, '正在扫描情报渠道');
  assert.match(view.detail, /OpenAI/);
  assert.equal(view.progress?.currentSource, 'OpenAI');
  assert.ok((view.progress?.diagnostics || []).some((line) => line.includes('渠道 2/5')));
});

test('judging is indeterminate and keeps single narrative', () => {
  const view = deriveTodayRunView({
    ...base,
    task: { id: 't1', status: 'running', phase: 'synthesizing', progress: { planned: 5, processed: 5 } }
  });
  assert.equal(view.step, 'judging');
  assert.equal(view.headline, '正在评估新资料并更新选题池');
  assert.equal(view.progress?.indeterminate, true);
  assert.equal(view.primaryCta.kind, 'continue');
  assert.equal(view.primaryCta.label, '对话中 · 查看进度');
});

test('partial CTA continues opportunity-pool update with no fake blockers', () => {
  const view = deriveTodayRunView({
    ...base,
    task: { id: 't1', status: 'partial', errorMessage: '综合整理失败' },
    sourcesTotal: 12
  });
  assert.equal(view.step, 'partial');
  assert.equal(view.primaryCta.label, '继续更新选题池');
  assert.equal(view.blockers.length, 0);
  assert.match(view.opportunityEmptyBody, /继续更新选题池/);
  assert.doesNotMatch(view.headline + view.detail + view.opportunityEmptyBody, /今日运营方案|待你处理/);
});

test('internal failure codes do not leak into partial copy', () => {
  const view = deriveTodayRunView({
    ...base,
    opportunityCount: 0,
    task: { id: 't2', status: 'partial', errorMessage: 'WMB_WRITE_REQUIRES_COMMAND_DISPATCH' }
  });
  assert.equal(view.step, 'partial');
  assert.equal(view.detail, '已保存部分渠道结果；可点继续更新选题池完成增量判断');
  assert.doesNotMatch(view.headline + view.detail, /WMB_|COMMAND_DISPATCH/);
});

test('partial with opportunities presents ready state', () => {
  const view = deriveTodayRunView({
    ...base,
    opportunityCount: 8,
    task: { id: 't2', status: 'partial', errorMessage: '部分渠道未完全成功' }
  });
  assert.equal(view.step, 'done');
  assert.equal(view.headline, '');
  assert.equal(view.statusLine, '当前有可批选题');
  assert.equal(view.primaryCta.label, '去创作');
  assert.equal(view.showOpportunityEmpty, false);
});

test('needs_user surfaces actionable blocker and continue CTA', () => {
  const view = deriveTodayRunView({
    ...base,
    task: {
      id: 't1', status: 'needs_user', errorCode: 'BROWSER_NEEDS_USER',
      errorMessage: '当前浏览器绑定需要 Owner 验证。'
    }
  });
  assert.equal(view.step, 'needs_user');
  assert.equal(view.primaryCta.label, '继续今日情报');
  assert.equal(view.blockers.length, 1);
  assert.equal(view.blockers[0].action, 'open_settings_browser');
  assert.match(view.opportunityEmptyBody, /继续今日情报/);
});

test('failed puts a user-facing error on command-bar detail', () => {
  const view = deriveTodayRunView({
    ...base,
    task: { id: 't1', status: 'failed', errorMessage: '同一 requestId 已绑定不同命令或输入。' }
  });
  assert.equal(view.step, 'failed');
  assert.equal(view.headline, '今日情报未完成');
  assert.equal(view.detail, '今日情报失败');
  assert.equal(view.primaryCta.label, '重试今日情报');
  assert.doesNotMatch(view.headline + view.detail, /点「开始今日情报」|requestId|WMB_|revision/);
});

test('done with opportunities opens studio; zero opportunities is empty-success', () => {
  const withOps = deriveTodayRunView({ ...base, hasTodayPlan: true, opportunityCount: 3, sssCount: 1, task: { status: 'succeeded' } });
  assert.equal(withOps.step, 'done');
  assert.equal(withOps.headline, '');
  assert.equal(withOps.statusLine, '当前有可批选题');
  assert.equal(withOps.primaryCta.label, '去创作');
  assert.equal(withOps.showOpportunityEmpty, false);

  const empty = deriveTodayRunView({ ...base, hasTodayPlan: true, opportunityCount: 0, task: { status: 'succeeded' } });
  assert.equal(empty.step, 'done');
  assert.equal(empty.headline, '今日侦察完成，暂无新机会');
  assert.equal(empty.primaryCta.label, '重新侦察');
  assert.match(empty.opportunityEmptyBody, /没有新的内容机会|没有发现值得做的机会/);
  assert.doesNotMatch(empty.opportunityEmptyBody, /还在准备中/);
});

test('local starting wins over stale idle task snapshot', () => {
  const view = deriveTodayRunView({
    ...base,
    localStarting: true,
    task: { status: 'failed', errorMessage: 'old' }
  });
  assert.equal(view.step, 'starting');
  assert.equal(view.headline, '正在启动今日情报');
});

test('statusLine equals headline for non-failed running and idle', () => {
  const idle = deriveTodayRunView(base);
  assert.equal(idle.statusLine, idle.headline);
  const scanning = deriveTodayRunView({
    ...base,
    task: { status: 'running', phase: 'scanning_sources', progress: { planned: 1, processed: 0 } }
  });
  assert.equal(scanning.statusLine, scanning.headline);
});

test('running view exposes no grant administration action', () => {
  const view = deriveTodayRunView({
    ...base,
    task: { id: 't1', status: 'running', phase: 'judging_opportunities', progress: { planned: 5, processed: 5 } }
  });
  assert.equal(view.step, 'judging');
  assert.equal(view.secondaryCtas.some((action) => action.id === 'grant_control'), false);
  assert.ok(view.secondaryCtas.some((action) => action.id === 'save_partial'));
  assert.ok(view.secondaryCtas.some((action) => action.id === 'cancel'));
});



test('zombie running shows cleanup CTA', () => {
  const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const view = deriveTodayRunView({
    task: {
      id: 't-zombie',
      status: 'running',
      phase: 'synthesizing',
      heartbeatAt: old,
      updatedAt: old,
      startedAt: old,
      progress: { planned: 15, processed: 15 }
    },
    hasTodayPlan: false,
    hasRecentPlan: false,
    opportunityCount: 0,
    sssCount: 0,
    sourcesTotal: 0,
    studioActive: null,
    piConfigured: true,
    channelsSummary: { enabledCount: 1, readyCount: 1, needsUserCount: 0, blockedCount: 0 }
  });
  assert.equal(view.step, 'judging');
  assert.match(view.headline, /失去执行者|卡住|保存并停止|清理/);
  const save = view.secondaryCtas.find((a) => a.id === 'save_partial');
  assert.ok(save);
  assert.equal(save.label, '清理并保留结果');
});

test('controlPending disables save and cancel', () => {
  const view = deriveTodayRunView({
    task: { id: 't1', status: 'running', phase: 'synthesizing', progress: { planned: 1, processed: 1 } },
    hasTodayPlan: false,
    hasRecentPlan: false,
    opportunityCount: 0,
    sssCount: 0,
    sourcesTotal: 0,
    studioActive: null,
    piConfigured: true,
    channelsSummary: { enabledCount: 1, readyCount: 1, needsUserCount: 0, blockedCount: 0 },
    controlPending: true,
    controlPendingAction: 'save_partial'
  });
  assert.match(view.headline, /保存并停止/);
  assert.ok(view.secondaryCtas.every((a) => a.id === 'view_sources' || a.disabled));
});


test('manager-owned running shows view-progress CTA', () => {
  const view = deriveTodayRunView({
    ...base,
    task: {
      id: 'm1',
      status: 'running',
      phase: 'manager',
      errorMessage: '主管任务进行中 · 查看对话进度'
    }
  });
  assert.equal(view.headline, '主管编排中');
  assert.equal(view.primaryCta.label, '对话中 · 查看进度');
  assert.equal(view.primaryCta.kind, 'continue');
});

test('manager monitor_reporter maps to scanning with determinate progress', () => {
  const view = deriveTodayRunView({
    ...base,
    task: {
      id: 'm1',
      status: 'running',
      phase: 'monitor_reporter',
      progress: { message: '主管任务进行中', planned: 5, processed: 3 }
    }
  });
  assert.equal(view.headline, '主管编排中');
  assert.equal(view.step, 'scanning');
  assert.equal(view.progress?.ratio, 0.6);
  assert.equal(view.progress?.indeterminate, false);
  assert.equal(view.primaryCta.kind, 'continue');
});

test('manager monitor_planner maps to judging with indeterminate pool update', () => {
  const view = deriveTodayRunView({
    ...base,
    task: { id: 'm1', status: 'running', phase: 'monitor_planner', progress: { message: '主管任务进行中' } }
  });
  assert.equal(view.headline, '主管编排中');
  assert.equal(view.step, 'judging');
  assert.equal(view.progress?.indeterminate, true);
  assert.equal(view.progress?.ratio, undefined);
  assert.equal(view.progress?.label, '正在更新选题池');
});

test('manager report maps to judging with indeterminate pool update', () => {
  const view = deriveTodayRunView({
    ...base,
    task: { id: 'm1', status: 'running', phase: 'report', progress: { message: '主管任务进行中' } }
  });
  assert.equal(view.headline, '主管编排中');
  assert.equal(view.step, 'judging');
  assert.equal(view.progress?.indeterminate, true);
  assert.equal(view.progress?.ratio, undefined);
  assert.equal(view.progress?.label, '正在更新选题池');
});

test('isManagerNonterminal treats running and waiting_human as nonterminal, succeeded as terminal', () => {
  assert.equal(isManagerNonterminal({ status: 'running' }), true);
  assert.equal(isManagerNonterminal({ checkpoint: { status: 'waiting_human' } }), true);
  assert.equal(isManagerNonterminal({ status: 'succeeded' }), false);
});

test('waiting-human manager projects a stable approval state instead of flashing running then idle', () => {
  const manager = {
    id: 'm1',
    status: 'running',
    checkpoint: { status: 'waiting_human', phase: 'report', summary: '方案已保存，等待确认' }
  };
  const child = { id: 'planner-1', status: 'succeeded', phase: 'completed', progress: { planned: 5, processed: 5 } };
  const projected = projectManagerTaskForToday(manager, child);
  assert.equal(isManagerNonterminal(manager), true, '主管串行锁保持');
  assert.equal(projected.running, false, '等待确认不能伪装成后台运行');
  assert.equal(projected.task.id, 'm1');
  assert.equal(projected.task.status, 'needs_user');
  assert.equal(projected.task.errorCode, 'MANAGER_WAITING_APPROVAL');
  const view = deriveTodayRunView({
    ...base,
    task: projected.task,
    sameDayTasks: [{ id: 'old-partial', status: 'partial', updatedAt: '2026-08-25T01:00:00.000Z' }],
    hasTodayPlan: false,
    opportunityCount: 0
  });
  assert.equal(view.step, 'needs_user');
  assert.equal(view.headline, '选题池已更新，等待你确认');
  assert.equal(view.primaryCta.kind, 'open_manager');
  assert.equal(view.primaryCta.label, '查看待确认选题');
});

test('active manager projection is never replaced by earlier same-day partial task', () => {
  const activeManager = { id: 'manager-new', status: 'running', phase: 'monitor_planner', progress: { message: '正在更新选题池' } };
  const earlierPartial = { id: 'task-old', status: 'partial', phase: 'validating', errorMessage: '旧任务未完成', updatedAt: '2026-08-25T01:00:00.000Z' };
  const view = deriveTodayRunView({
    ...base,
    task: activeManager,
    sameDayTasks: [earlierPartial],
    hasTodayPlan: false,
    hasRecentPlan: false,
    opportunityCount: 0
  });
  assert.equal(view.step, 'judging');
  assert.equal(view.progress?.label, '正在更新选题池');
  assert.notEqual(view.headline, '资料已入库，选题池还没更新完');
});

test('incomplete same-day partial hides empty succeeded: shows 资料已入库 copy', () => {
  const succeededEmpty = { id: 't-succ', status: 'succeeded', phase: 'completed', updatedAt: '2026-08-24T15:32:24.000Z' };
  const partialFailed = { id: 't-part', status: 'partial', phase: 'validating', errorMessage: '同一 requestId 已绑定不同命令或输入。', updatedAt: '2026-08-24T13:53:24.000Z', progress: { planned: 20, processed: 20 } };
  const view = deriveTodayRunView({
    ...base,
    task: succeededEmpty,
    sameDayTasks: [succeededEmpty, partialFailed],
    hasTodayPlan: false,
    hasRecentPlan: false,
    opportunityCount: 0
  });
  assert.equal(view.step, 'partial');
  assert.equal(view.headline, '资料已入库，选题池还没更新完');
  assert.equal(view.statusLine, '资料已入库，选题池还没更新完');
  assert.doesNotMatch(view.opportunityEmptyTitle + view.opportunityEmptyBody + view.statusLine, /今天没有新的内容机会|暂无新机会/);
});

test('incomplete same-day failed hides empty succeeded: shows 今日情报未完成', () => {
  const succeededEmpty = { id: 't-succ', status: 'succeeded', phase: 'completed', updatedAt: '2026-08-24T15:32:24.000Z' };
  const failed = { id: 't-fail', status: 'failed', phase: 'validating', errorMessage: '今日情报失败', updatedAt: '2026-08-24T13:53:24.000Z' };
  const view = deriveTodayRunView({
    ...base,
    task: succeededEmpty,
    sameDayTasks: [succeededEmpty, failed],
    hasTodayPlan: false,
    hasRecentPlan: false,
    opportunityCount: 0
  });
  assert.equal(view.step, 'failed');
  assert.equal(view.headline, '今日情报未完成');
  assert.doesNotMatch(view.opportunityEmptyTitle + view.statusLine, /今天没有新的内容机会/);
});

test('clean successful empty run without same-day failure shows genuine empty copy', () => {
  const succeededEmpty = { id: 't-succ', status: 'succeeded', phase: 'completed', updatedAt: '2026-08-24T15:32:24.000Z' };
  const view = deriveTodayRunView({
    ...base,
    task: succeededEmpty,
    sameDayTasks: [succeededEmpty],
    hasTodayPlan: false,
    hasRecentPlan: false,
    opportunityCount: 0
  });
  assert.equal(view.step, 'done');
  assert.equal(view.headline, '今日侦察完成，暂无新机会');
  assert.match(view.opportunityEmptyTitle, /今天没有新的内容机会/);
  assert.equal(view.statusLine, '今日侦察完成，暂无新机会');
});

test('nonempty approved plan shows normal opportunity view even with same-day failure present', () => {
  const succeededEmpty = { id: 't-succ', status: 'succeeded', phase: 'completed', updatedAt: '2026-08-24T15:32:24.000Z' };
  const partialFailed = { id: 't-part', status: 'partial', phase: 'validating', errorMessage: '同一 requestId 已绑定不同命令或输入。', updatedAt: '2026-08-24T13:53:24.000Z' };
  const view = deriveTodayRunView({
    ...base,
    task: succeededEmpty,
    sameDayTasks: [succeededEmpty, partialFailed],
    hasTodayPlan: true,
    hasRecentPlan: false,
    opportunityCount: 3
  });
  assert.equal(view.step, 'done');
  assert.equal(view.headline, '');
  assert.equal(view.statusLine, '当前有可批选题');
  assert.equal(view.showOpportunityEmpty, false);
  assert.doesNotMatch(view.headline + view.statusLine, /资料已入库|今日情报未完成/);
});

test('selectTruthfulTask prioritizes latest same-day partial over empty succeeded when no approved plan', () => {
  const succeeded = { id: 's1', status: 'succeeded', updatedAt: '2026-08-24T15:32:00.000Z' };
  const partialOld = { id: 'p1', status: 'partial', updatedAt: '2026-08-24T13:00:00.000Z' };
  const partialNew = { id: 'p2', status: 'partial', errorMessage: '综合整理失败', updatedAt: '2026-08-24T15:30:00.000Z' };
  const picked = selectTruthfulTask(succeeded, [succeeded, partialOld, partialNew], { hasApprovedToday: false, opportunityCount: 0 });
  assert.equal(picked?.id, 'p2');
  const pickedWhenApproved = selectTruthfulTask(succeeded, [succeeded, partialNew], { hasApprovedToday: true, opportunityCount: 2 });
  assert.equal(pickedWhenApproved?.id, 's1');
});

test('qualified clean empty success is not overridden by earlier partial: genuine empty', () => {
  const qualifiedEmpty = { id: 't-succ', status: 'succeeded', phase: 'completed', updatedAt: '2026-08-24T16:00:00.000Z', checkpoint: { emptyQualified: true }, emptyQualified: true };
  const partialOld = { id: 'p1', status: 'partial', errorMessage: '同一 requestId 已绑定不同命令或输入。', updatedAt: '2026-08-24T13:53:24.000Z' };
  const view = deriveTodayRunView({
    ...base,
    task: qualifiedEmpty,
    sameDayTasks: [qualifiedEmpty, partialOld],
    hasTodayPlan: false,
    hasRecentPlan: false,
    opportunityCount: 0
  });
  assert.equal(view.step, 'done');
  assert.equal(view.headline, '今日侦察完成，暂无新机会');
  assert.match(view.opportunityEmptyTitle, /今天没有新的内容机会/);
  assert.doesNotMatch(view.headline + view.statusLine, /资料已入库/);
  const picked = selectTruthfulTask(qualifiedEmpty, [qualifiedEmpty, partialOld], { hasApprovedToday: false, opportunityCount: 0 });
  assert.equal(picked?.id, 't-succ');
});

test('unqualified empty success is overridden by same-day partial (Wan 3.0 case)', () => {
  const unqualifiedEmpty = { id: 't-succ', status: 'succeeded', phase: 'completed', updatedAt: '2026-08-24T15:32:24.000Z', checkpoint: { emptyQualified: false }, emptyQualified: false };
  const partial = { id: 'p1', status: 'partial', errorMessage: '同一 requestId 已绑定不同命令或输入。', updatedAt: '2026-08-24T13:53:24.000Z' };
  const view = deriveTodayRunView({
    ...base,
    task: unqualifiedEmpty,
    sameDayTasks: [unqualifiedEmpty, partial],
    hasTodayPlan: false,
    hasRecentPlan: false,
    opportunityCount: 0
  });
  assert.equal(view.step, 'partial');
  assert.equal(view.headline, '资料已入库，选题池还没更新完');
});
