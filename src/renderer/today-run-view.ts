import type { IntelligenceChannelsSummary } from '../main/intelligence-channels';

export type TodayStep =
  | 'idle'
  | 'starting'
  | 'scanning'
  | 'judging'
  | 'done'
  | 'partial'
  | 'needs_user'
  | 'failed'
  | 'exhausted'
  | 'scoring_incomplete';


export type TodayPrimaryKind =
  | 'start'
  | 'continue'
  | 'retry'
  | 'open_studio'
  | 'open_manager'
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
  checkpoint?: Record<string, unknown> | null;
  emptyQualified?: boolean;
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
  pendingOpportunityCount?: number;
  scoringPendingCount?: number;
  scoringActive?: boolean;
  scoringError?: string | null;
  sssCount: number;
  sourcesTotal: number;
  studioActive: number | null;
  piConfigured: boolean;
  channelsSummary: IntelligenceChannelsSummary | null | undefined;
  nowMs?: number;
  controlPending?: boolean;
  controlPendingAction?: 'save_partial' | 'cancel' | null;
  /** Derived exhausted flag: current plan has items and every item is rejected (planning_status='rejected'). */
  isExhausted?: boolean;
  /** Total items in current plan (for exhausted copy), e.g., 5 */
  totalPlanItemCount?: number;
  /** Rejected count (equals total when exhausted) */
  rejectedCount?: number;
};
/** Same-day history for truthful projection: manager/judge partial/failed over later empty succeeded. */
export type TodayRunHistory = {
  sameDayTasks?: DailyTaskSnapshot[];
};

function isSameDayIncomplete(task: DailyTaskSnapshot | null | undefined): boolean {
  if (!task?.status) return false;
  return task.status === 'partial' || task.status === 'failed';
}

/** Deterministic projection helper: picks the truthful task for empty-plan truthfulness. */
export function selectTruthfulTask(
  primary: DailyTaskSnapshot | null,
  sameDayTasks: DailyTaskSnapshot[] | undefined,
  opts: { hasApprovedToday: boolean; opportunityCount: number }
): DailyTaskSnapshot | null {
  if (opts.hasApprovedToday || Number(opts.opportunityCount || 0) > 0) return primary;
  if (isTodayTaskActive(primary)) return primary;
  if (!Array.isArray(sameDayTasks) || sameDayTasks.length === 0) return primary;
  const incomplete = sameDayTasks.filter(isSameDayIncomplete);
  if (incomplete.length === 0) return primary;
  if (isSameDayIncomplete(primary)) return primary;
  // Qualified clean empty success must not be overridden by earlier partial: genuine zero-result.
  if (primary && (primary.status === 'succeeded' || primary.status === 'completed')) {
    const checkpoint = primary.checkpoint as Record<string, unknown> | null | undefined;
    const qualified = Boolean(primary.emptyQualified)
      || Boolean(checkpoint && (checkpoint.emptyQualified === true || checkpoint.dailyEmptyQualified === true || (checkpoint as Record<string, unknown>).qualifiedEmpty === true));
    if (qualified) return primary;
  }
  let latest: DailyTaskSnapshot | null = null;
  let latestMs = -1;
  for (const task of incomplete) {
    const raw = task.updatedAt || task.createdAt || '';
    const ms = raw ? Date.parse(raw) : 0;
    const value = Number.isFinite(ms) ? ms : 0;
    if (value > latestMs) {
      latestMs = value;
      latest = task;
    }
  }
  return latest ?? primary;
}

/** Resolve TodayRunView with truthful history (deterministic helper over UI special cases). */
export function resolveTodayRunView(input: TodayRunInput & TodayRunHistory): TodayRunView {
  const effectiveTask = selectTruthfulTask(input.task, input.sameDayTasks, {
    hasApprovedToday: Boolean(input.hasTodayPlan),
    opportunityCount: Number(input.opportunityCount || 0)
  }) ?? input.task;
  return deriveTodayRunView({ ...input, task: effectiveTask });
}
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
  if (task.status === 'queued' || task.status === 'waiting_resource') return 'starting';
  if (task.status === 'partial') return 'partial';
  if (task.status === 'needs_user') return 'needs_user';
  if (task.status === 'succeeded' || task.status === 'completed') return 'done';
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

export function projectManagerTaskForToday(
  manager: {
    id: string;
    status?: string | null;
    progress?: DailyTaskSnapshot['progress'];
    checkpoint?: { status?: string | null; phase?: string | null; summary?: string | null } | null;
  },
  child: (DailyTaskSnapshot & { intent?: string }) | null | undefined
): { task: DailyTaskSnapshot; running: boolean } {
  const summary = manager.checkpoint?.summary || manager.progress?.message || '主管任务进行中';
  const runningChild = child?.status === 'running' ? child : null;
  if (manager.checkpoint?.status === 'waiting_human' && !runningChild) {
    return {
      task: {
        id: manager.id,
        status: 'needs_user',
        phase: 'report',
        progress: { message: summary },
        events: summary ? [{ message: summary }] : [],
        errorCode: 'MANAGER_WAITING_APPROVAL',
        errorMessage: summary
      },
      running: false
    };
  }
  return {
    task: {
      id: runningChild?.id || manager.id,
      status: 'running',
      phase: runningChild?.phase || manager.checkpoint?.phase || 'manager',
      progress: {
        ...(runningChild?.progress || {}),
        message: summary,
        planned: runningChild?.progress?.planned,
        processed: runningChild?.progress?.processed
      },
      events: runningChild?.events?.length ? runningChild.events : (summary ? [{ message: summary }] : []),
      errorMessage: summary
    },
    running: true
  };
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
    { label: '今日新增来源', value: String(input.sourcesTotal) },
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

export function deriveTodayRunView(input: TodayRunInput & TodayRunHistory): TodayRunView {
  const effectiveTask = (() => {
    const candidates = (input as TodayRunInput & TodayRunHistory).sameDayTasks;
    if (Array.isArray(candidates) && candidates.length) {
      const picked = selectTruthfulTask(input.task, candidates, {
        hasApprovedToday: Boolean(input.hasTodayPlan),
        opportunityCount: Number(input.opportunityCount || 0)
      });
      return picked ?? input.task;
    }
    return input.task;
  })();
  const nowMs = input.nowMs ?? Date.now();
  const hasDeliveredPlan = Boolean(input.hasTodayPlan) || Number(input.opportunityCount || 0) > 0;
  const step = mapTaskToStep(effectiveTask, input.localStarting === true, { hasDeliveredPlan });
  const preflight = derivePreflightBlockers(input);
  const blockers = step === 'needs_user'
    ? (taskBlockers(effectiveTask).length ? taskBlockers(effectiveTask) : preflight)
    : [];
  const planned = Math.max(0, Number(effectiveTask?.progress?.planned ?? 0));
  const processed = Math.max(0, Number(effectiveTask?.progress?.processed ?? 0));
  const failed = Math.max(0, Number(effectiveTask?.progress?.failed ?? 0));
  const verified = Math.max(0, Number(effectiveTask?.progress?.verified ?? 0));
  const saved = Math.max(0, Number(effectiveTask?.progress?.saved ?? 0));
  const opportunityProgress = Math.max(0, Number(effectiveTask?.progress?.opportunityCount ?? 0));
  const currentSource = String(effectiveTask?.progress?.currentSource || '').trim();
  const lastEvent = Array.isArray(effectiveTask?.events) && effectiveTask!.events!.length
    ? String(effectiveTask!.events![effectiveTask!.events!.length - 1]?.message || '').trim()
    : '';
  const heartbeatAge = ageSec(effectiveTask?.heartbeatAt, nowMs) || ageSec(effectiveTask?.updatedAt, nowMs);
  const startedAge = ageSec(effectiveTask?.startedAt ?? effectiveTask?.createdAt, nowMs);
  const stalled = step !== 'idle' && step !== 'done' && step !== 'partial' && step !== 'failed' && step !== 'needs_user' && heartbeatAge > 60
    ? { waitSec: heartbeatAge }
    : null;
  // 僵尸：心跳/更新过久，或整次任务墙钟过长仍 running（与设计 10m stall / 30m wall 对齐的 UI 提示）。
  const zombie = (step === 'starting' || step === 'scanning' || step === 'judging')
    && (heartbeatAge > 600 || startedAge > 1800 || effectiveTask?.phase === 'resume_pending');
  const runningSecondaries = (): TodayRunView['secondaryCtas'] => [
    { id: 'view_sources', label: '查看资料' },
    { id: 'save_partial', label: zombie ? '清理并保留结果' : '保存并停止', disabled: !effectiveTask?.id || input.controlPending === true },
    { id: 'cancel', label: zombie ? '丢弃任务' : '取消任务', disabled: !effectiveTask?.id || input.controlPending === true }
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
      effectiveTask?.phase === 'manager'
      || (typeof effectiveTask?.errorMessage === 'string' && /主管/.test(effectiveTask.errorMessage))
      || (typeof effectiveTask?.progress?.message === 'string' && /主管/.test(String(effectiveTask.progress.message)))
    );
    if (managerOwned) {
      // 主管任务有实际计数（如 monitor_reporter 汇报 processed/planned）→ 沿用同一 .intelligence-bar 的确定进度；
      // 无计数（策划/report 等阶段）→ indeterminate，保留方案生成标签供用户判断。
      const hasDeterminateProgress = planned > 0;
      return {
        step,
        headline: '主管编排中',
        detail: visibleTaskMessage(effectiveTask, '进度在对话中更新'),
        primaryCta: { kind: 'continue' as const, label: '对话中 · 查看进度' },
        secondaryCtas: [
          { id: 'view_sources', label: '查看资料' },
          { id: 'save_partial', label: '保存并停止', disabled: !effectiveTask?.id || input.controlPending === true },
          { id: 'cancel', label: '取消任务', disabled: !effectiveTask?.id || input.controlPending === true }
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
        statusLine: visibleTaskMessage(effectiveTask, '主管编排中')
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
      primaryCta: { kind: 'continue', label: '对话中 · 查看进度' },
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

  // Exhausted round: current plan exists with items, all rejected. Unresolved =0, must not show waiting confirmation.
  // Derived from existing planning_status; no new schema. Takes precedence over pending.
  if (input.isExhausted === true) {
    const total = Number(input.totalPlanItemCount ?? input.rejectedCount ?? 0);
    const detail = total > 0 ? `本轮 ${total} 条选题已全部否决；可开始新一轮收集。` : '本轮选题已全部否决；可开始新一轮收集。';
    return {
      step: 'exhausted',
      headline: '本轮已结束',
      detail,
      primaryCta: { kind: 'start', label: '开始新一轮收集' },
      secondaryCtas: [{ id: 'view_sources', label: '查看资料' }],
      blockers: [],
      stats: idleStats(input),
      showOpportunityEmpty: true,
      opportunityEmptyTitle: '本轮选题已全部否决',
      opportunityEmptyBody: '本轮已否决全部选题，可开始新一轮收集以获取新机会。',
      statusLine: '本轮已结束 · 已全部否决'
    };
  }

  const scoringPending = Math.max(0, Number(input.scoringPendingCount || 0));
  if (scoringPending > 0) {
    if (input.scoringActive) {
      const msg = visibleTaskMessage(effectiveTask, '正在为本轮选题补充传播评分');
      return {
        step: 'scoring_incomplete' as TodayStep,
        headline: '正在评分',
        detail: msg || `正在为 ${scoringPending} 条选题补充评分，已等待 ${formatWait(heartbeatAge || 0)}`,
        primaryCta: { kind: 'continue' as const, label: '查看评分进度' },
        secondaryCtas: [{ id: 'view_sources', label: '查看资料' }],
        blockers: [],
        stats: idleStats(input),
        progress: {
          label: '正在评分',
          indeterminate: true,
          diagnostics: [`待评分 ${scoringPending}`, msg].filter(Boolean) as string[],
          stalled: stalled
        },
        showOpportunityEmpty: true,
        opportunityEmptyTitle: '正在为本轮选题评分',
        opportunityEmptyBody: '评分完成后，可评分的选题会进入“今日可批”等待确认。',
        statusLine: '正在评分'
      };
    }
    const errorDetail = input.scoringError ? `（${clip(String(input.scoringError))}）` : '';
    return {
      step: 'scoring_incomplete' as TodayStep,
      headline: '本轮评分未完成',
      detail: `本轮有 ${scoringPending} 条选题评分未完成${errorDetail}；需继续评分后才能进入审批。`,
      primaryCta: { kind: 'continue' as const, label: '继续评分' },
      secondaryCtas: [{ id: 'view_sources', label: '查看资料' }],
      blockers: [],
      stats: idleStats(input),
      showOpportunityEmpty: true,
      opportunityEmptyTitle: '本轮评分未完成',
      opportunityEmptyBody: '点“继续评分”让策划继续完成传播评分；评分通过后会进入待审批。',
      statusLine: '本轮评分未完成'
    };
  }

  if (Number(input.pendingOpportunityCount || 0) > 0) {
    const pendingCount = Number(input.pendingOpportunityCount || 0);
    return {
      step: 'needs_user',
      headline: '选题池已更新，等待你确认',
      detail: `本轮有 ${pendingCount} 条选题等待确认；确认完成后再开始下一轮更新。`,
      primaryCta: { kind: 'open_manager', label: '查看待确认选题' },
      secondaryCtas: [{ id: 'view_sources', label: '查看资料' }],
      blockers: [],
      stats: idleStats(input),
      showOpportunityEmpty: true,
      opportunityEmptyTitle: '本轮选题等待确认',
      opportunityEmptyBody: '先查看并确认本轮选题；确认完成后再开始下一轮更新。',
      statusLine: '选题池已更新，等待你确认'
    };
  }

  if (step === 'partial') {
    // 渠道 partial 但选题池已有可批项：主态按「当前有可批选题」展示，避免有机会仍提示「选题池没更新完」。
    if (input.opportunityCount > 0) {
      return {
        step: 'done',
        headline: '',
        detail: (() => {
          const msg = visibleTaskMessage(effectiveTask, '');
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
      detail: visibleTaskMessage(effectiveTask, '已保存部分渠道结果；可点继续更新选题池完成增量判断'),
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
    if (effectiveTask?.errorCode === 'MANAGER_WAITING_APPROVAL') {
      return {
        step,
        headline: '选题池已更新，等待你确认',
        detail: visibleTaskMessage(effectiveTask, '本轮选题已经生成，请查看并确认后再开始下一轮更新。'),
        primaryCta: { kind: 'open_manager', label: '查看待确认选题' },
        secondaryCtas: [{ id: 'view_sources', label: '查看资料' }],
        blockers: [],
        stats: idleStats(input),
        showOpportunityEmpty: true,
        opportunityEmptyTitle: '本轮选题等待确认',
        opportunityEmptyBody: '先查看并确认本轮选题；确认完成后再开始下一轮更新。',
        statusLine: '选题池已更新，等待你确认'
      };
    }
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
    const message = visibleTaskMessage(effectiveTask,
      effectiveTask?.status === 'cancelled' ? '今日情报已取消'
        : effectiveTask?.status === 'interrupted' ? '上次情报任务已中断'
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
        headline: '',
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
      headline: '',
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

// --- Today start latch helpers (WMB-5174 flash fix): pure, deterministic ---
export type TodayStartLatch = { gen: number; managerId?: string; taskId?: string } | null;

export function isTodayTaskActive(task: DailyTaskSnapshot | null | undefined): boolean {
  const s = task?.status;
  return s === 'queued' || s === 'waiting_resource' || s === 'running' || s === 'needs_user';
}

/**
 * focus_existing 优先级：非终态 manager 投影优先于 stale/terminal child。
 * 若 manager 非终态，投影 manager（仅当 child active 时才混入 child 进度），否则回落到 child / manager。
 */
export function resolveFocusExistingProjection(
  manager: { id: string; status?: string | null; checkpoint?: { status?: string | null; phase?: string | null; summary?: string | null } | null; progress?: DailyTaskSnapshot['progress'] } | null | undefined,
  child: DailyTaskSnapshot | null | undefined
): { task: DailyTaskSnapshot | null; running: boolean } {
  if (manager && isManagerNonterminal(manager as Parameters<typeof isManagerNonterminal>[0])) {
    const activeChild = child && isTodayTaskActive(child) ? child : null;
    const proj = projectManagerTaskForToday(manager as Parameters<typeof projectManagerTaskForToday>[0], activeChild as Parameters<typeof projectManagerTaskForToday>[1]);
    return { task: proj.task, running: proj.running };
  }
  if (child) {
    return { task: child, running: isTodayTaskActive(child) };
  }
  if (manager) {
    const proj = projectManagerTaskForToday(manager as Parameters<typeof projectManagerTaskForToday>[0], null);
    return { task: proj.task, running: proj.running };
  }
  return { task: null, running: false };
}

/**
 * Latch 观测归约：while latch pending, stale terminal/ gap 不能清 busy。
 * - 非终态 manager 可见 → 交棒 busy 并清 latch
 * - 同一 run 的 terminal（matching id）→ 清 latch 并 idle
 * - 其它 stale terminal / 空观测 → 保持 latch/busy
 * - active agentTask → 交棒 busy 并清 latch
 * 返回 handled=true 表示调用方应以返回值覆盖 running/task；handled=false 表示无 latch 需走常规 idle 路径。
 * 仅决定 latch/running/task，不写缓存。
 */
export function reduceTodayStartLatch(
  latch: TodayStartLatch,
  observed: {
    manager?: { id?: string; status?: string | null; checkpoint?: { status?: string | null } | null } | null;
    child?: DailyTaskSnapshot | null;
    agentTask?: DailyTaskSnapshot | null;
  }
): { nextLatch: TodayStartLatch; nextRunning: boolean | null; nextTask: DailyTaskSnapshot | null; keepBusy: boolean; handled: boolean } {
  if (!latch) return { nextLatch: null, nextRunning: null, nextTask: null, keepBusy: false, handled: false };
  const manager = observed.manager ?? null;
  const child = observed.child ?? null;
  const agentTask = observed.agentTask ?? null;
  // 1) Nonterminal manager has priority — always handover to busy
  if (manager && isManagerNonterminal(manager as Parameters<typeof isManagerNonterminal>[0])) {
    const activeChild = child && isTodayTaskActive(child) ? child : null;
    const proj = projectManagerTaskForToday(manager as Parameters<typeof projectManagerTaskForToday>[0], activeChild as Parameters<typeof projectManagerTaskForToday>[1]);
    return { nextLatch: null, nextRunning: proj.running, nextTask: proj.task, keepBusy: true, handled: true };
  }
  // 2) Terminal manager matching expected managerId → same run terminal → idle
  if (manager?.id && latch.managerId && manager.id === latch.managerId) {
    return { nextLatch: null, nextRunning: false, nextTask: child ?? agentTask ?? null, keepBusy: false, handled: true };
  }
  // 3) Active agent task → handover (new run authoritative)
  if (agentTask && isTodayTaskActive(agentTask)) {
    return { nextLatch: null, nextRunning: true, nextTask: agentTask, keepBusy: true, handled: true };
  }
  // 4) Terminal agent task matching expected taskId → same run terminal → idle
  if (agentTask && latch.taskId && agentTask.id && agentTask.id === latch.taskId) {
    return { nextLatch: null, nextRunning: false, nextTask: agentTask, keepBusy: false, handled: true };
  }
  // 5) Stale terminal agent task (mismatched id or latch expects manager) → keep busy
  if (agentTask && !isTodayTaskActive(agentTask)) {
    return { nextLatch: latch, nextRunning: null, nextTask: null, keepBusy: true, handled: true };
  }
  // 6) Gap before manager/task creation (all null) → keep busy
  if (!manager && !agentTask && !child) {
    return { nextLatch: latch, nextRunning: null, nextTask: null, keepBusy: true, handled: true };
  }
  // No stale terminal to protect, let caller fall through (e.g., no latch relevant)
  return { nextLatch: latch, nextRunning: null, nextTask: null, keepBusy: true, handled: false };
}
