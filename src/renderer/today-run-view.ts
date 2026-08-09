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
  | 'restart'
  | 'continue';

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
    message?: string;
  };
  events?: Array<{ message?: string }>;
  createdAt?: string;
  startedAt?: string;
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
  controlPending?: boolean;
  controlPendingAction?: 'save_partial' | 'cancel' | null;
};
const SCAN_PHASES = new Set(['channel_preflight', 'scanning_sources', 'planning_sources']);
const JUDGE_PHASES = new Set(['channel_scanned', 'running_pi', 'judging_opportunities', 'synthesizing', 'validating']);
const START_PHASES = new Set(['starting', 'resume_pending', 'resuming']);
// 主管（ManagerTask checkpoint.phase）阶段 → 同一运行卡语义分组：派工/监工记者=采集，策划=增量判断，report=更新选题池。
const MANAGER_SCAN_PHASES = new Set(['accepted', 'dispatch_reporter', 'monitor_reporter']);
const MANAGER_JUDGE_PHASES = new Set(['dispatch_planner', 'monitor_planner', 'report', 'done']);

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

export function mapTaskToStep(
  task: DailyTaskSnapshot | null,
  localStarting = false,
  opts: { hasDeliveredPlan?: boolean } = {}
): TodayStep {
  if (localStarting && (!task || task.status !== 'running')) return 'starting';
  if (!task?.status) return opts.hasDeliveredPlan ? 'done' : 'idle';
  if (task.status === 'running') {
    const phase = String(task.phase || '');
    if (phase === 'manager' || MANAGER_SCAN_PHASES.has(phase)) return 'scanning';
    if (MANAGER_JUDGE_PHASES.has(phase)) return 'judging';
    if (START_PHASES.has(phase) || !phase) return 'starting';
    if (SCAN_PHASES.has(phase)) return 'scanning';
    if (JUDGE_PHASES.has(phase)) return 'judging';
    return 'starting';
  }
  if (task.status === 'partial') return 'partial';
  if (task.status === 'needs_user') return 'needs_user';
  if (task.status === 'succeeded' || task.status === 'completed') return 'done';
  // 成功交付后用户取消/中断：不得盖住已有今日方案。
  if (task.status === 'failed' || task.status === 'cancelled' || task.status === 'interrupted') {
    if (opts.hasDeliveredPlan) return 'done';
    return 'failed';
  }
  return opts.hasDeliveredPlan ? 'done' : 'idle';
}

/**
 * 主管任务未终态判定：agent 行 status='running' 或 checkpoint 处于 accepted/running/reporting/waiting_human。
 * 语义非终态（含 waiting_human：方案已生成待批准）不得因旧方案存在或 legacy child 停止而降级为 idle/ready。
 */
export function isManagerNonterminal(view: {
  status?: string | null;
  checkpoint?: { status?: string | null } | null;
}): boolean {
  if (!view) return false;
  if (view.status === 'running') return true;
  const cp = view.checkpoint?.status;
  return cp === 'accepted' || cp === 'running' || cp === 'reporting' || cp === 'waiting_human';
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
      body: '今日情报更新选题池需要可用的 Pi API 配置。',
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
  const hasDeliveredPlan = Boolean(input.hasTodayPlan) || Number(input.opportunityCount || 0) > 0;
  const step = mapTaskToStep(input.task, input.localStarting === true, { hasDeliveredPlan });
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
  const startedAge = ageSec(input.task?.startedAt ?? input.task?.createdAt, nowMs);
  const stalled = step !== 'idle' && step !== 'done' && step !== 'partial' && step !== 'failed' && step !== 'needs_user' && heartbeatAge > 60
    ? { waitSec: heartbeatAge }
    : null;
  // 僵尸：心跳/更新过久，或整次任务墙钟过长仍 running（与设计 10m stall / 30m wall 对齐的 UI 提示）。
  const zombie = (step === 'starting' || step === 'scanning' || step === 'judging')
    && (heartbeatAge > 600 || startedAge > 1800 || input.task?.phase === 'resume_pending');
  const runningSecondaries = (): TodayRunView['secondaryCtas'] => [
    { id: 'view_sources', label: '查看资料' },
    { id: 'save_partial', label: zombie ? '清理并保留结果' : '保存并停止', disabled: !input.task?.id || input.controlPending === true },
    { id: 'cancel', label: zombie ? '丢弃任务' : '取消任务', disabled: !input.task?.id || input.controlPending === true }
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
      lastEvent && lastEvent !== currentSource ? lastEvent : null,
      zombie ? '执行者可能已丢失，可清理并保留结果' : null
    ].filter((item): item is string => Boolean(item));
    const managerOwned = Boolean(
      input.task?.phase === 'manager'
      || (typeof input.task?.errorMessage === 'string' && /主管/.test(input.task.errorMessage))
      || (typeof input.task?.progress?.message === 'string' && /主管/.test(String(input.task.progress.message)))
    );
    if (managerOwned) {
      // 主管任务有实际计数（如 monitor_reporter 汇报 processed/planned）→ 沿用同一 .intelligence-bar 的确定进度；
      // 无计数（策划/report 等阶段）→ indeterminate，保留方案生成标签供用户判断。
      const hasDeterminateProgress = planned > 0;
      return {
        step,
        headline: '主管编排中',
        detail: visibleTaskMessage(input.task, '进度在对话中更新'),
        primaryCta: { kind: 'continue' as const, label: '对话中 · 查看进度' },
        secondaryCtas: [
          { id: 'view_sources', label: '查看资料' },
          { id: 'save_partial', label: '保存并停止', disabled: !input.task?.id || input.controlPending === true },
          { id: 'cancel', label: '取消任务', disabled: !input.task?.id || input.controlPending === true }
        ],
        blockers: [],
        stats: idleStats(input),
        progress: {
          label: step === 'judging' ? '正在更新选题池' : '编排中',
          ratio: hasDeterminateProgress ? Math.min(1, processed / planned) : undefined,
          indeterminate: !hasDeterminateProgress,
          diagnostics,
          stalled: stalled || (zombie ? { waitSec: Math.max(heartbeatAge, startedAge) } : null)
        },
        showOpportunityEmpty: true,
        opportunityEmptyTitle: '主管正在编排今日情报',
        opportunityEmptyBody: '进度在右侧对话中更新；需要批准方案时会回到今日页。',
        statusLine: visibleTaskMessage(input.task, '主管编排中')
      };
    }

    const headline = input.controlPending
      ? (input.controlPendingAction === 'cancel' ? '正在取消任务' : '正在保存并停止')
      : zombie
        ? '任务可能已失去执行者'
        : step === 'starting'
          ? '正在启动今日情报'
          : step === 'scanning'
            ? '正在扫描情报渠道'
            : '正在评估新资料并更新选题池';
    const detail = input.controlPending
      ? '请稍候，系统正在结束当前运行并写回状态'
      : zombie
        ? `已等待 ${formatWait(Math.max(heartbeatAge, startedAge))}；点「清理并保留结果」结束假运行并保留已入库资料`
        : step === 'starting'
          ? '正在连接情报渠道'
          : step === 'scanning'
            ? (currentSource
              ? `渠道 ${processed}/${planned || '–'} · 正在处理：${currentSource}`
              : (planned ? `渠道 ${processed}/${planned}` : '正在扫描已启用渠道'))
            : '渠道已完成，正在判断新资料是否值得进入选题池';
    return {
      step,
      headline,
      detail,
      primaryCta: { kind: 'none', label: '' },
      secondaryCtas: runningSecondaries(),
      progress: {
        label: zombie ? '可能已卡住' : step === 'judging' ? '正在更新选题池' : (planned ? `渠道 ${processed}/${planned}` : '启动中'),
        ratio: step === 'judging' ? undefined : ratio,
        indeterminate: step === 'judging' || planned <= 0,
        currentSource: currentSource || undefined,
        diagnostics,
        stalled: stalled || (zombie ? { waitSec: Math.max(heartbeatAge, startedAge) } : null)
      },
      blockers: [],
      showOpportunityEmpty: true,
      opportunityEmptyTitle: zombie ? '任务可能已失去执行者' : step === 'judging' ? '正在更新选题池' : '正在侦察今日内容机会',
      opportunityEmptyBody: zombie
        ? '点「清理并保留结果」结束假运行；已入库资料可在右侧查看。'
        : step === 'judging'
          ? '新机会判断完成后会自动加入选题池，无需你操作。'
          : (currentSource ? `正在处理：${currentSource}` : '来源扫描和整理完成后，机会会自动出现在这里。'),
      statusLine: headline
    };
  }

  if (step === 'partial') {
    // 渠道 partial 但选题池已有可批项：主态按「当前有可批选题」展示，避免有机会仍提示「选题池没更新完」。
    if (input.opportunityCount > 0) {
      return {
        step: 'done',
        headline: '当前有可批选题',
        detail: (() => {
          const msg = visibleTaskMessage(input.task, '');
          if (!msg || /方案由当前任务写入|VALIDATION_ERROR|内部错误/.test(msg)) {
            return '部分渠道未完全成功，已基于可用资料新增选题机会';
          }
          return msg;
        })(),
        primaryCta: { kind: 'open_studio', label: '去创作' },
        secondaryCtas: [
          { id: 'restart', label: '重新侦察' },
          { id: 'view_sources', label: '查看资料' },
          { id: 'continue', label: '继续更新选题池' }
        ],
        blockers: [],
        stats: idleStats(input),
        showOpportunityEmpty: false,
        opportunityEmptyTitle: '',
        opportunityEmptyBody: '',
        statusLine: '当前有可批选题'
      };
    }
    const primary = { kind: 'continue' as const, label: '继续更新选题池' };
    return {
      step,
      headline: '资料已入库，选题池还没更新完',
      detail: visibleTaskMessage(input.task, '已保存部分渠道结果；可点继续更新选题池完成增量判断'),
      primaryCta: primary,
      secondaryCtas: [
        { id: 'view_sources', label: '查看资料' },
        { id: 'refresh', label: '刷新' }
      ],
      blockers: [],
      stats: idleStats(input),
      showOpportunityEmpty: true,
      opportunityEmptyTitle: '资料已入库，选题池还没更新完',
      opportunityEmptyBody: fillPrimary('点「{primaryLabel}」让系统接着完成增量判断；已入库资料可在右侧查看。', primary.label),
      statusLine: '资料已入库，选题池还没更新完'
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
      opportunityEmptyTitle: '新的选题机会还没完成判断',
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
      return {
        step,
        headline: '当前有可批选题',
        detail: '',
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
        statusLine: '当前有可批选题'
      };
    }
    const primary = {
      kind: 'start' as const,
      label: '重新侦察',
      confirm: '重新侦察会采集新资料并增量更新选题池，继续？'
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
      confirm: '重新侦察会采集新资料并增量更新选题池，继续？'
    };
    return {
      step: 'idle',
      headline: '当前有可批选题',
      detail: '重新侦察会补充新资料，并增量更新选题池',
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
      statusLine: '当前有可批选题'
    };
  }

  if (input.hasRecentPlan) {
    const primary = { kind: 'start' as const, label: '开始今日情报' };
    return {
      step: 'idle',
      headline: '当前显示最近可批选题',
      detail: '开始今日情报后，新机会会增量加入选题池',
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
      statusLine: '当前显示最近可批选题'
    };
  }

  const primary = { kind: 'start' as const, label: '开始今日情报' };
  return {
    step: 'idle',
    headline: '点「开始今日情报」，扫描渠道并更新选题池',
    detail: '滚动采集 → 增量判断 → 选题池',
    primaryCta: primary,
    secondaryCtas: [
      { id: 'view_sources', label: '查看资料' },
      { id: 'refresh', label: '刷新' }
    ],
    blockers: [],
    stats: idleStats(input),
    showOpportunityEmpty: true,
    opportunityEmptyTitle: '选题池还在准备中',
    opportunityEmptyBody: fillPrimary('点「{primaryLabel}」，系统会自动扫描并增量更新选题池。', primary.label),
    statusLine: '点「开始今日情报」，扫描渠道并更新选题池'
  };
}
