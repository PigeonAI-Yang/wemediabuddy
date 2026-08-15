import type { AgentTask } from './agent-tasks';

function envMs(name: string, fallback: number, min = 1_000): number {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, n);
}

/** 整次 daily_intelligence 墙钟上限（可测：WMB_DAILY_WALL_MS） */
export function dailyWallMs(): number {
  return envMs('WMB_DAILY_WALL_MS', 30 * 60_000);
}

/** phase 无真实业务进展（lastActivityAt）过久视为 stall（可测：WMB_DAILY_STALL_MS） */
export function dailyStallMs(): number {
  return envMs('WMB_DAILY_STALL_MS', 10 * 60_000);
}


export type DailyWatchdogDecision = {
  reason: 'wall_clock' | 'stall';
  code: 'DAILY_WALL_CLOCK' | 'DAILY_STALL';
  message: string;
};

function parseTime(value: string | null | undefined, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : fallbackMs;
}

/** 自动 partial 总开关：默认开；WMB_DAILY_AUTO_PARTIAL=0 关闭 */
export function dailyAutoPartialEnabled(): boolean {
  const raw = String(process.env.WMB_DAILY_AUTO_PARTIAL ?? '1').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off';
}

/** 控制审计事件开关：默认开 */
export function dailyControlAuditEnabled(): boolean {
  const raw = String(process.env.WMB_DAILY_CONTROL_AUDIT ?? '1').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off';
}

/**
 * 墙钟 / stall 判定。heartbeat 只刷新 heartbeatAt，不刷新 progress.lastActivityAt，
 * 因此 stall 以 lastActivityAt（无则 createdAt）为准。
 */
export function dailyControlWatchdogDecision(task: Pick<AgentTask, 'status' | 'createdAt' | 'progress' | 'phase' | 'heartbeatAt' | 'updatedAt'>, nowMs = Date.now()): DailyWatchdogDecision | null {
  if (task.status !== 'running') return null;
  if (!dailyAutoPartialEnabled()) return null;
  const wallMs = dailyWallMs();
  const stallMs = dailyStallMs();
  const startedMs = parseTime(task.createdAt, nowMs);
  if (nowMs - startedMs >= wallMs) {
    const mins = Math.max(1, Math.round(wallMs / 60_000));
    return {
      reason: 'wall_clock',
      code: 'DAILY_WALL_CLOCK',
      message: `今日情报已超过 ${mins} 分钟墙钟上限，系统已自动保存并停止。`
    };
  }
  // F1: 业务 lastActivityAt + 心跳/更新时间取新，避免长流式输出被误判 stall。
  const activityMs = Math.max(
    parseTime(task.progress?.lastActivityAt, 0),
    parseTime(task.progress?.streamActivityAt as string | undefined, 0),
    parseTime(task.heartbeatAt, 0),
    parseTime(task.updatedAt, 0),
    startedMs
  );
  if (nowMs - activityMs >= stallMs) {
    const mins = Math.max(1, Math.round(stallMs / 60_000));
    return {
      reason: 'stall',
      code: 'DAILY_STALL',
      message: `今日情报在「${task.phase || 'running'}」超过 ${mins} 分钟无业务进展，系统已自动保存并停止。`
    };
  }
  return null;
}

export function controlAuditMessage(action: string, detail?: string): string {
  const base = `控制动作：${action}`;
  return detail ? `${base} · ${detail}` : base;
}

/**
 * channel_scanned 且无协调器在跑时：扫完未接力判断的孤儿任务。
 * 默认 3 分钟无进展则应被收尸或重拉 judge（调用方决定）。
 */
export function orphanChannelScannedHandoffMs(): number {
  return envMs('WMB_DAILY_HANDOFF_STALL_MS', 3 * 60_000);
}

export function isOrphanChannelScannedTask(
  task: Pick<AgentTask, 'status' | 'phase' | 'intent' | 'progress' | 'createdAt' | 'updatedAt'>,
  nowMs = Date.now()
): boolean {
  if (task.status !== 'running') return false;
  if (!(task.intent === 'daily_scan' || task.intent === 'daily_intelligence' || task.intent === 'daily_judge')) return false;
  // channel_scanned: 扫完未接力判断
  // starting/scanning_*: 任务已落库但协调器/执行者已死
  const phase = String(task.phase || '');
  const handoffish = phase === 'channel_scanned' || phase === 'starting' || phase === 'resume_pending'
    || phase.startsWith('scanning') || phase === 'channel_preflight' || phase === 'planning_sources';
  if (!handoffish) return false;
  const activityMs = parseTime(task.progress?.lastActivityAt, parseTime(task.updatedAt, parseTime(task.createdAt, nowMs)));
  return nowMs - activityMs >= orphanChannelScannedHandoffMs();
}

/** starting 过久且无业务进展：应收尸而非无限假运行 */
export function isOrphanStartingDailyTask(
  task: Pick<AgentTask, 'status' | 'phase' | 'intent' | 'progress' | 'createdAt' | 'updatedAt'>,
  nowMs = Date.now()
): boolean {
  if (task.status !== 'running') return false;
  if (!(task.intent === 'daily_scan' || task.intent === 'daily_intelligence' || task.intent === 'daily_judge')) return false;
  const phase = String(task.phase || '');
  if (!(phase === 'starting' || phase === 'channel_preflight' || phase === 'planning_sources')) return false;
  const activityMs = parseTime(task.progress?.lastActivityAt, parseTime(task.updatedAt, parseTime(task.createdAt, nowMs)));
  return nowMs - activityMs >= orphanChannelScannedHandoffMs();
}
