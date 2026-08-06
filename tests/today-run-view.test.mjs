import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveTodayRunView, mapTaskToStep } from '../src/renderer/today-run-view.ts';

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
});

test('idle without plan uses start CTA and empty guidance', () => {
  const view = deriveTodayRunView(base);
  assert.equal(view.step, 'idle');
  assert.equal(view.primaryCta.label, '开始今日情报');
  assert.match(view.headline, /开始今日情报/);
  assert.equal(view.blockers.length, 0);
  assert.match(view.opportunityEmptyBody, /开始今日情报/);
});

test('idle with only a historical plan labels it as recent and keeps today counts at zero', () => {
  const view = deriveTodayRunView({ ...base, hasRecentPlan: true });
  assert.equal(view.step, 'idle');
  assert.equal(view.primaryCta.label, '开始今日情报');
  assert.equal(view.showOpportunityEmpty, false);
  assert.match(view.headline + view.detail + view.statusLine, /最近方案/);
  assert.equal(view.stats?.find((stat) => stat.label === '今日新资料')?.value, '0');
  assert.equal(view.stats?.find((stat) => stat.label === '今日内容机会')?.value, '0');
  assert.doesNotMatch(view.headline + view.detail, /已根据入库资料整理出/);
});

test('idle with plan uses restart confirm and hides empty state', () => {
  const view = deriveTodayRunView({ ...base, hasTodayPlan: true, opportunityCount: 2, sssCount: 1 });
  assert.equal(view.step, 'idle');
  assert.equal(view.primaryCta.label, '重新侦察');
  assert.match(view.primaryCta.confirm || '', /替换今日方案/);
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
  assert.equal(view.headline, '正在生成今日运营方案');
  assert.equal(view.progress?.indeterminate, true);
  assert.equal(view.primaryCta.kind, 'none');
});

test('partial CTA is continue-generate-plan with no fake blockers', () => {
  const view = deriveTodayRunView({
    ...base,
    task: { id: 't1', status: 'partial', errorMessage: '综合整理失败' },
    sourcesTotal: 12
  });
  assert.equal(view.step, 'partial');
  assert.equal(view.primaryCta.label, '继续生成方案');
  assert.equal(view.blockers.length, 0);
  assert.match(view.opportunityEmptyBody, /继续生成方案/);
  assert.doesNotMatch(view.headline + view.detail + view.opportunityEmptyBody, /创建今日运营方案|待你处理/);
});

test('internal failure codes do not leak into partial copy', () => {
  const view = deriveTodayRunView({
    ...base,
    task: { id: 't2', status: 'partial', errorMessage: 'WMB_WRITE_REQUIRES_COMMAND_DISPATCH' }
  });
  assert.equal(view.detail, '已保存部分渠道结果，方案生成时遇到内部错误');
  assert.doesNotMatch(view.headline + view.detail, /WMB_|COMMAND_DISPATCH/);
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

