import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveTodayRunView, isManagerNonterminal, mapTaskToStep } from '../src/renderer/today-run-view.ts';

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

test('idle with only a historical plan labels it as recent and keeps today counts at zero', () => {
  const view = deriveTodayRunView({ ...base, hasRecentPlan: true });
  assert.equal(view.step, 'idle');
  assert.equal(view.primaryCta.label, '开始今日情报');
  assert.equal(view.showOpportunityEmpty, false);
  assert.equal(view.headline, '当前显示最近可批选题');
  assert.equal(view.stats?.find((stat) => stat.label === '今日新资料')?.value, '0');
  assert.equal(view.stats?.find((stat) => stat.label === '今日内容机会')?.value, '0');
  assert.doesNotMatch(view.headline + view.detail, /已根据入库资料整理出/);
});

test('current opportunity pool opens studio and offers rescan', () => {
  const view = deriveTodayRunView({ ...base, hasTodayPlan: true, opportunityCount: 2, sssCount: 1 });
  assert.equal(view.step, 'done');
  assert.equal(view.headline, '当前有可批选题');
  assert.equal(view.primaryCta.label, '去创作');
  assert.ok(view.secondaryCtas.some((c) => c.id === 'restart'));
  assert.equal(view.showOpportunityEmpty, false);
});

test('scanning exposes progress not a primary start button', () => {
  const view = deriveTodayRunView({
    ...base,
    task: {
      id: 't1', status: 'running', phase: 'channel_preflight',
      progress: { planned: 5, processed: 2, currentSource: 'OpenAI' },
      heartbeatAt: '2026-08-06T11:59:50.000Z'
    }
  });
  assert.equal(view.step, 'scanning');
  assert.equal(view.primaryCta.kind, 'none');
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
  assert.equal(view.primaryCta.kind, 'none');
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
  assert.equal(view.headline, '当前有可批选题');
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
  assert.equal(withOps.headline, '当前有可批选题');
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
