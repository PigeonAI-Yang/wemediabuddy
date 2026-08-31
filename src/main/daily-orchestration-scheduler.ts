import { shanghaiDate } from "./ferment.ts";
import { getDailyOrchestrationSchedule } from "./daily-orchestration.ts";
import type {
  SubmitWorkspaceOrchestratorIntentInput,
  WorkspaceOrchestratorReceipt,
} from "./workspace-orchestrator-runtime.ts";
import type { DatabaseSync } from "node:sqlite";

export type DailyOrchestrationIntentSubmitter = (
  input: SubmitWorkspaceOrchestratorIntentInput,
) => Promise<WorkspaceOrchestratorReceipt>;

export function dailyOrchestrationSchedulerRequestId(
  workspaceId: string,
  businessDate: string,
): string {
  return `scheduler.daily-0900:${workspaceId}:${businessDate}`;
}

export function getNextShanghaiTickMs(
  nowMs: number,
  scheduleTime: string,
): number {
  const m = /^(\d{2}):(\d{2})$/.exec(scheduleTime);
  const hh = m ? Number(m[1]) : 9;
  const mm = m ? Number(m[2]) : 0;
  const shanghaiParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const y = Number(shanghaiParts.find((p) => p.type === "year")?.value);
  const mo = Number(shanghaiParts.find((p) => p.type === "month")?.value);
  const d = Number(shanghaiParts.find((p) => p.type === "day")?.value);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d))
    return nowMs + 60_000;
  const candidateUtc = Date.UTC(y, mo - 1, d, hh, mm, 0) - 8 * 3600 * 1000;
  if (candidateUtc > nowMs) return candidateUtc;
  // next day 09:00 Shanghai = candidate + 24h (Asia/Shanghai has no DST, 24h is exact)
  return candidateUtc + 24 * 3600 * 1000;
}

export type DailyOrchestrationSchedulerOptions = {
  getDatabase: () => DatabaseSync | null;
  getWorkspaceId: () => string;
  nowMs?: () => number;
  onError?: (e: unknown) => void;
  submitIntent: DailyOrchestrationIntentSubmitter;
};

export class DailyOrchestrationScheduler {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private opts: DailyOrchestrationSchedulerOptions;
  constructor(opts: DailyOrchestrationSchedulerOptions) {
    this.opts = opts;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const db = this.opts.getDatabase();
    let scheduleTime = "09:00";
    let autoEnabled = true;
    if (db) {
      try {
        const s = getDailyOrchestrationSchedule(db);
        scheduleTime = s.time;
        autoEnabled = s.autoEnabled;
      } catch {}
    }
    if (!autoEnabled) {
      this.timer = setTimeout(() => this.scheduleNext(), 60_000);
      return;
    }
    const now = this.opts.nowMs ? this.opts.nowMs() : Date.now();
    const nextMs = getNextShanghaiTickMs(now, scheduleTime);
    const delay = Math.max(1000, nextMs - now);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
      this.scheduleNext();
    }, delay);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const db = this.opts.getDatabase();
    if (!db) return;
    let autoEnabled = true;
    try {
      autoEnabled = getDailyOrchestrationSchedule(db).autoEnabled;
    } catch {}
    if (!autoEnabled) return;
    const businessDate = shanghaiDate(
      new Date(this.opts.nowMs ? this.opts.nowMs() : Date.now()),
    );
    const workspaceId = this.opts.getWorkspaceId();
    try {
      await this.opts.submitIntent({
        producerId: "scheduler.daily-0900",
        businessDate,
        requestId: dailyOrchestrationSchedulerRequestId(
          workspaceId,
          businessDate,
        ),
        action: "stage_d",
        logicalInput: { businessDate, source: "scheduler_0900" },
        payload: { businessDate, source: "scheduler_0900" },
        rootMode: "scheduler",
      });
    } catch (e) {
      this.opts.onError?.(e);
    }
  }

  // for tests: trigger immediately without waiting for timer
  async triggerNow(
    businessDate?: string,
  ): Promise<WorkspaceOrchestratorReceipt | undefined> {
    const db = this.opts.getDatabase();
    if (!db) return;
    const date =
      businessDate ??
      shanghaiDate(new Date(this.opts.nowMs ? this.opts.nowMs() : Date.now()));
    const workspaceId = this.opts.getWorkspaceId();
    return this.opts.submitIntent({
      producerId: "scheduler.daily-0900",
      businessDate: date,
      requestId: dailyOrchestrationSchedulerRequestId(workspaceId, date),
      action: "stage_d",
      logicalInput: { businessDate: date, source: "scheduler_0900" },
      payload: { businessDate: date, source: "scheduler_0900" },
      rootMode: "scheduler",
    });
  }
}
