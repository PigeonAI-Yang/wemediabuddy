import type { IntelligenceModule } from './intelligence-channels.ts';

export type DailyScanSchedulerOptions = {
  isCurrent: () => boolean;
  run: (modules: IntelligenceModule[]) => Promise<{ savedCount?: number } | void>;
  onNewSources?: (modules: IntelligenceModule[]) => Promise<unknown>;
  officialWebMs?: number;
  xListsMs?: number;
  firstDelayMs?: number;
  onError?: (error: unknown) => void;
};

function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 5_000 ? Math.floor(raw) : fallback;
}

/**
 * 滚动采集调度：官网源与 X List 各自按节奏触发同一协调器的 scanOnly 运行。
 * 单例防重入；运行时切换后 isCurrent 为 false 时跳过；stop() 立即停掉后续 tick。
 */
export class DailyScanScheduler {
  private timers: NodeJS.Timeout[] = [];
  private inFlight = new Set<IntelligenceModule>();
  private stopped = false;
  private judgeRunning = false;
  private judgeQueued = false;
  private readonly options: DailyScanSchedulerOptions;
  private readonly officialWebMs: number;
  private readonly xListsMs: number;
  private readonly firstDelayMs: number;

  constructor(options: DailyScanSchedulerOptions) {
    this.options = options;
    this.officialWebMs = options.officialWebMs ?? envMs('WMB_SCAN_OFFICIAL_WEB_MS', 2 * 3_600_000);
    this.xListsMs = options.xListsMs ?? envMs('WMB_SCAN_X_LISTS_MS', 8 * 3_600_000);
    this.firstDelayMs = options.firstDelayMs ?? envMs('WMB_SCAN_FIRST_DELAY_MS', 90_000);
  }

  start(): void {
    this.schedule(['official_web'], this.firstDelayMs, this.officialWebMs);
    this.schedule(['x_lists'], this.firstDelayMs * 2, this.xListsMs);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    this.inFlight.clear();
  }

  private schedule(modules: IntelligenceModule[], delay: number, interval: number): void {
    const tick = async () => {
      if (this.stopped) return;
      this.timers.push(setTimeout(() => void tick(), interval));
      if (!this.options.isCurrent()) return;
      const key = modules[0];
      if (this.inFlight.has(key)) return;
      this.inFlight.add(key);
      try {
        const result = await this.options.run(modules);
        const savedCount = result?.savedCount ?? 0;
        if (savedCount > 0) await this.triggerJudge(modules);
      } catch (error) {
        this.options.onError?.(error);
      } finally {
        this.inFlight.delete(key);
      }
    };
    this.timers.push(setTimeout(() => void tick(), delay));
  }

  /**
   * 触发方式甲：采集有新入库即自动判断。判断全局单例；判断运行期间的新触发排队为一轮后续。
   */
  private async triggerJudge(modules: IntelligenceModule[]): Promise<void> {
    if (!this.options.onNewSources || this.stopped) return;
    if (this.judgeRunning) {
      this.judgeQueued = true;
      return;
    }
    this.judgeRunning = true;
    try {
      await this.options.onNewSources(modules);
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.judgeRunning = false;
      if (this.judgeQueued && !this.stopped) {
        this.judgeQueued = false;
        await this.triggerJudge(modules);
      }
    }
  }
}
