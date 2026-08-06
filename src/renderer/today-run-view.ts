import type { IntelligenceChannelsSummary } from '../main/intelligence-channels';

export type TodayStep =
  | 'idle'
  | 'starting'
  | 'scanning'
  | 'judging'
  | 'done'
  | 'partial'
  | 'needs_user'
  | 'failed';

export type TodayPrimaryKind =
  | 'start'
  | 'continue'
  | 'retry'
  | 'open_studio'
  | 'none';

export type TodaySecondaryId =
  | 'view_sources'
  | 'save_partial'
  | 'cancel'
  | 'open_studio'
  | 'refresh'
  | 'restart';

export type TodayBlockerAction =
  | 'open_settings_browser'
  | 'open_settings_channels'
  | 'open_settings_ai'
  | 'retry';

export type DailyTaskSnapshot = {
  id?: string;
  status?: string;
  phase?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  progress?: {
    planned?: number;
    processed?: number;
    failed?: number;
    verified?: number;
    saved?: number;
    opportunityCount?: number;
    currentSource?: string;
    lastActivityAt?: string;
  };
  events?: Array<{ message?: string }>;
  createdAt?: string;
  updatedAt?: string;
  heartbeatAt?: string;
};

export type TodayRunView = {
  step: TodayStep;
  headline: string;
  detail: string;
  primaryCta: { kind: TodayPrimaryKind; label: string; confirm?: string };
  secondaryCtas: Array<{ id: TodaySecondaryId; label: string; disabled?: boolean }>;
  progress?: {
    label: string;
    ratio?: number;
    indeterminate?: boolean;
    currentSource?: string;
    diagnostics?: string[];
    stalled?: { waitSec: number } | null;
  };
  blockers: Array<{ code: string; title: string; body: string; action: TodayBlockerAction }>;
  stats?: Array<{ label: string; value: string; tone?: 'up' | 'amber' }>;
  showOpportunityEmpty: boolean;
  opportunityEmptyTitle: string;
  opportunityEmptyBody: string;
  statusLine: string;
};

export type TodayRunInput = {
  task: DailyTaskSnapshot | null;
  localStarting?: boolean;
  hasTodayPlan: boolean;
  hasRecentPlan: boolean;
  opportunityCount: number;
  sssCount: number;
  sourcesTotal: number;
  studioActive: number | null;
  piConfigured: boolean;
  channelsSummary: IntelligenceChannelsSummary | null | undefined;
  nowMs?: number;
};

const SCAN_PHASES = new Set(['channel_preflight', 'scanning_sources', 'planning_sources']);
const JUDGE_PHASES = new Set(['channel_scanned', 'running_pi', 'judging_opportunities', 'synthesizing', 'validating']);
const START_PHASES = new Set(['starting', 'resume_pending', 'resuming']);

function clip(text: string, max = 120): string {
  const value = text.trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function visibleTaskMessage(task: DailyTaskSnapshot | null, fallback: string): string {
  const message = String(task?.errorMessage || '').trim();
  if (!message) return fallback;
  if (/\bWMB_[A-Z0-9_]+\b|requestId|revision|command dispatch|dispatcher|SQLite|\bIPC\b|\bMCP\b/i.test(message)) return fallback;
  return clip(message);
}

function fillPrimary(body: string, primaryLabel: string): string {
  return body.replaceAll('{primaryLabel}', primaryLabel);
}

function ageSec(value: string | undefined, nowMs: number): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor((nowMs - parsed) / 1000));
}

function formatWait(totalSec: number): string {
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec ? `${min}m${sec}s` : `${min}m`;
}

export function mapTaskToStep(task: DailyTaskSnapshot | null, localStarting = false): TodayStep {
  if (localStarting && (!task || task.status !== 'running')) return 'starting';
  if (!task?.status) return 'idle';
  if (task.status === 'running') {
    const phase = String(task.phase || '');
    if (START_PHASES.has(phase) || !phase) return 'starting';
    if (SCAN_PHASES.has(phase)) return 'scanning';
    if (JUDGE_PHASES.has(phase)) return 'judging';
    return 'starting';
  }
  if (task.status === 'partial') return 'partial';
  if (task.status === 'needs_user') return 'needs_user';
  if (task.status === 'succeeded' || task.status === 'completed') return 'done';
  if (task.status === 'failed' || task.status === 'cancelled' || task.status === 'interrupted') return 'failed';
  return 'idle';
}

export function derivePreflightBlockers(input: {
  piConfigured: boolean;
  channelsSummary: IntelligenceChannelsSummary | null | undefined;
}): TodayRunView['blockers'] {
  const blockers: TodayRunView['blockers'] = [];
  if (!input.piConfigured) {
    blockers.push({
      code: 'PI_CONFIG_REQUIRED',
      title: '先配置创作助手连接',
      body: '今日情报生成方案需要可用的 Pi API 配置。',
      action: 'open_settings_ai'
    });
  }
  const readiness = input.channelsSummary?.readiness ?? [];
  const ready = readiness.some((item) => item.readyCount > 0);
  if (ready) return blockers;
  if (readiness.some((item) => item.blockedCount > 0)) {
    blockers.push({
      code: 'CHANNELS_NEEDS_USER',
      title: '渠道未就绪',
      body: '已有来源需要浏览器登录或重新确认。',
      action: 'open_settings_browser'
    });
    return blockers;
  }
  blockers.push({
    code: 'CHANNELS_NOT_CONFIGURED',
    title: '先配置情报渠道',
    body: '没有可运行的官网或 X List，请先在设置中添加并启用。',
    action: 'open_settings_channels'
  });
  return blockers;
}

function taskBlockers(task: DailyTaskSnapshot | null): TodayRunView['blockers'] {
  if (!task || task.status !== 'needs_user') return [];
  const code = String(task.errorCode || 'BROWSER_NEEDS_USER');
  if (code === 'PI_CONFIG_REQUIRED') {
    return [{ code, title: '先配置创作助手连接', body: clip(task.errorMessage || 'Pi 尚未配置。'), action: 'open_settings_ai' }];
  }
  if (code === 'CHANNELS_NOT_CONFIGURED') {
    return [{ code, title: '先配置情报渠道', body: clip(task.errorMessage || '当前没有可运行的情报渠道。'), action: 'open_settings_channels' }];
  }
  if (code === 'CHANNELS_NEEDS_USER' || code.includes('CHANNEL')) {
    return [{ code, title: '渠道需要处理', body: clip(task.errorMessage || '请检查渠道登录或配置。'), action: 'open_settings_channels' }];
  }
  return [{
    code,
    title: '先验证浏览器账号',
    body: clip(task.errorMessage || '浏览器绑定需要 Owner 验证后才能继续。'),
    action: 'open_settings_browser'
  }];
}

function idleStats(input: TodayRunInput): TodayRunView['stats'] {
  return [
    { label: '今日新资料', value: String(input.sourcesTotal) },
    {
      label: '今日内容机会',
      value: String(input.opportunityCount),
      tone: input.sssCount ? 'up' : undefined
    },
    {
      label: '进行中项目',
      value: input.studioActive == null ? '–' : String(input.studioActive)
    }
  ];
}

export function deriveTodayRunView(input: TodayRunInput): TodayRunView {
  const nowMs = input.nowMs ?? Date.now();
  const step = mapTaskToStep(input.task, input.localStarting === true);
  const preflight = derivePreflightBlockers(input);
  const blockers = step === 'needs_user'
    ? (taskBlockers(input.task).length ? taskBlockers(input.task) : preflight)
    : [];
  const planned = Math.max(0, Number(input.task?.progress?.planned ?? 0));
  const processed = Math.max(0, Number(input.task?.progress?.processed ?? 0));
  const failed = Math.max(0, Number(input.task?.progress?.failed ?? 0));
  const verified = Math.max(0, Number(input.task?.progress?.verified ?? 0));
  const saved = Math.max(0, Number(input.task?.progress?.saved ?? 0));
  const opportunityProgress = Math.max(0, Number(input.task?.progress?.opportunityCount ?? 0));
  const currentSource = String(input.task?.progress?.currentSource || '').trim();
  const lastEvent = Array.isArray(input.task?.events) && input.task!.events!.length
    ? String(input.task!.events![input.task!.events!.length - 1]?.message || '').trim()
    : '';
  const heartbeatAge = ageSec(input.task?.heartbeatAt, nowMs) || ageSec(input.task?.updatedAt, nowMs);
  const stalled = step !== 'idle' && step !== 'done' && step !== 'partial' && step !== 'failed' && step !== 'needs_user' && heartbeatAge > 60
    ? { waitSec: heartbeatAge }
    : null;
  const runningSecondaries = (): TodayRunView['secondaryCtas'] => [
    { id: 'view_sources', label: '查看资料' },
    { id: 'save_partial', label: '保存并停止', disabled: !input.task?.id },
    { id: 'cancel', label: '取消任务', disabled: !input.task?.id }
  ];
  const effectiveBlockers = blockers;

  if (step === 'starting' || step === 'scanning' || step === 'judging') {
    const ratio = planned > 0 ? Math.min(1, processed / planned) : undefined;
    const diagnostics = [
      planned ? `渠道 ${processed}/${planned}` : null,
      failed ? `失败 ${failed}` : null,
      verified ? `核验 ${verified}` : null,
      saved ? `保存 ${saved}` : null,
      opportunityProgress ? `机会 ${opportunityProgress}` : null,
      lastEvent && lastEvent !== currentSource ? lastEvent : null
    ].filter((item): item is string => Boolean(item));
    const headline = step === 'starting'
      ? '正在启动今日情报'
      : step === 'scanning'
        ? '正在扫描情报渠道'
        : '正在生成今日运营方案';
    const detail = step === 'starting'
      ? '正在连接情报渠道'
      : step === 'scanning'
        ? (currentSource
          ? `渠道 ${processed}/${planned || '–'} · 正在处理：${currentSource}`
          : (planned ? `渠道 ${processed}/${planned}` : '正在扫描已启用渠道'))
        : '渠道已完成，正在整理内容机会';
    return {
      step,
      headline,
      detail,
      primaryCta: { kind: 'none', label: '' },
      secondaryCtas: runningSecondaries(),
      progress: {
        label: step === 'judging' ? '正在生成方案' : (planned ? `渠道 ${processed}/${planned}` : '启动中'),
        ratio: step === 'judging' ? undefined : ratio,
        indeterminate: step === 'judging' || planned <= 0,
        currentSource: currentSource || undefined,
        diagnostics,
        stalled
      },
      blockers: [],
      showOpportunityEmpty: true,
      opportunityEmptyTitle: step === 'judging' ? '正在生成今日运营方案' : '正在侦察今日内容机会',
      opportunityEmptyBody: step === 'judging'
        ? '机会生成后会自动出现，无需你操作。'
        : (currentSource ? `正在处理：${currentSource}` : '来源扫描和整理完成后，机会会自动出现在这里。'),
      statusLine: headline
    };
  }

  if (step === 'partial') {
    const primary = { kind: 'continue' as const, label: '继续生成方案' };
    return {
      step,
      headline: '资料已入库，今日方案还没生成完',
      detail: visibleTaskMessage(input.task, '已保存部分渠道结果，方案生成时遇到内部错误'),
      primaryCta: primary,
      secondaryCtas: [
        { id: 'view_sources', label: '查看资料' },
        { id: 'refresh', label: '刷新' }
      ],
      blockers: [],
      stats: idleStats(input),
      showOpportunityEmpty: input.opportunityCount <= 0,
      opportunityEmptyTitle: '资料已入库，方案还没生成完',
      opportunityEmptyBody: fillPrimary('点「{primaryLabel}」让系统接着完成，不用手工写；已入库资料可在右侧查看。', primary.label),
      statusLine: '资料已入库，今日方案还没生成完'
    };
  }

  if (step === 'needs_user') {
    const first = effectiveBlockers[0];
    const primary = { kind: 'continue' as const, label: '继续今日情报' };
    return {
      step,
      headline: '需要你处理一项前置问题后才能继续',
      detail: first ? `${first.title}：${first.body}` : '请先处理右侧待办。',
      primaryCta: primary,
      secondaryCtas: [{ id: 'view_sources', label: '查看资料' }],
      blockers: effectiveBlockers,
      stats: idleStats(input),
      showOpportunityEmpty: true,
      opportunityEmptyTitle: '今天的机会还没生成',
      opportunityEmptyBody: fillPrimary('先处理右侧「待你处理」卡片，完成后点「{primaryLabel}」。', primary.label),
      statusLine: '需要你处理一项前置问题后才能继续'
    };
  }

  if (step === 'failed') {
    const message = visibleTaskMessage(input.task,
      input.task?.status === 'cancelled' ? '今日情报已取消'
        : input.task?.status === 'interrupted' ? '上次情报任务已中断'
          : '今日情报失败');
    const primary = { kind: 'retry' as const, label: '重试今日情报' };
    return {
      step,
      headline: '今日情报未完成',
      detail: message,
      primaryCta: primary,
      secondaryCtas: [
        { id: 'view_sources', label: '查看资料' },
        { id: 'refresh', label: '刷新' }
      ],
      blockers: [],
      stats: idleStats(input),
      showOpportunityEmpty: input.opportunityCount <= 0,
      opportunityEmptyTitle: '今日情报未完成',
      opportunityEmptyBody: fillPrimary(`原因：${message}。点「{primaryLabel}」重新开始；已保存资料不会丢。`, primary.label),
      statusLine: message
    };
  }

  if (step === 'done') {
    if (input.opportunityCount > 0) {
      const detailParts = [`${input.opportunityCount} 个内容机会`];
      if (input.sssCount) detailParts.push(`${input.sssCount} 个优先`);
      return {
        step,
        headline: '今日运营方案已就绪',
        detail: detailParts.join(' · '),
        primaryCta: { kind: 'open_studio', label: '去创作' },
        secondaryCtas: [
          { id: 'restart', label: '重新侦察' },
          { id: 'view_sources', label: '查看资料' }
        ],
        blockers: [],
        stats: idleStats(input),
        showOpportunityEmpty: false,
        opportunityEmptyTitle: '',
        opportunityEmptyBody: '',
        statusLine: '今日运营方案已就绪'
      };
    }
    const primary = {
      kind: 'start' as const,
      label: '重新侦察',
      confirm: '重新侦察会用新结果替换今日方案，继续？'
    };
    return {
      step,
      headline: '今日侦察完成，暂无新机会',
      detail: '零更新也是有效结果',
      primaryCta: primary,
      secondaryCtas: [{ id: 'view_sources', label: '查看资料' }],
      blockers: [],
      stats: idleStats(input),
      showOpportunityEmpty: true,
      opportunityEmptyTitle: '今天没有新的内容机会',
      opportunityEmptyBody: fillPrimary('渠道检查完成，没有发现值得做的机会；可点「{primaryLabel}」换一轮，或在右侧查看资料。', primary.label),
      statusLine: '今日侦察完成，暂无新机会'
    };
  }

  // idle
  if (input.hasTodayPlan) {
    const primary = {
      kind: 'start' as const,
      label: '重新侦察',
      confirm: '重新侦察会用新结果替换今日方案，继续？'
    };
    return {
      step: 'idle',
      headline: '今日运营方案已就绪',
      detail: '重新侦察会刷新资料并替换今日方案',
      primaryCta: primary,
      secondaryCtas: [
        { id: 'view_sources', label: '查看资料' },
        { id: 'refresh', label: '刷新' }
      ],
      blockers: [],
      stats: idleStats(input),
      showOpportunityEmpty: false,
      opportunityEmptyTitle: '',
      opportunityEmptyBody: '',
      statusLine: '今日运营方案已就绪'
    };
  }

  if (input.hasRecentPlan) {
    const primary = { kind: 'start' as const, label: '开始今日情报' };
    return {
      step: 'idle',
      headline: '今日方案尚未生成',
      detail: '下方保留最近方案，完成今日情报后将替换为今天的结果',
      primaryCta: primary,
      secondaryCtas: [
        { id: 'view_sources', label: '查看资料' },
        { id: 'refresh', label: '刷新' }
      ],
      blockers: [],
      stats: idleStats(input),
      showOpportunityEmpty: false,
      opportunityEmptyTitle: '',
      opportunityEmptyBody: '',
      statusLine: '今日方案尚未生成，当前显示最近方案'
    };
  }

  const primary = { kind: 'start' as const, label: '开始今日情报' };
  return {
    step: 'idle',
    headline: '点「开始今日情报」，扫描渠道并生成今日运营方案',
    detail: '每天一轮：渠道 → 机会 → 方案',
    primaryCta: primary,
    secondaryCtas: [
      { id: 'view_sources', label: '查看资料' },
      { id: 'refresh', label: '刷新' }
    ],
    blockers: [],
    stats: idleStats(input),
    showOpportunityEmpty: true,
    opportunityEmptyTitle: '今日内容机会还在准备中',
    opportunityEmptyBody: fillPrimary('点「{primaryLabel}」，系统会自动扫描并生成今日运营方案。', primary.label),
    statusLine: '点「开始今日情报」，扫描渠道并生成今日运营方案'
  };
}
