import type { DataRoot } from './data-root.ts';
import type { DatabaseSync } from 'node:sqlite';
import { selectedXListBrowser } from './x-list-context.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import {
  nextXObservationDueAt,
  processDueXObservationJobs,
  recoverRunningXObservationJobs,
  type XObservationPayload
} from './x-observation-jobs.ts';
import type { XListBrowserConfig } from './platforms/x-list-primitives.ts';

export class XObservationScheduler {
  private stopped = true;
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<void> | null = null;
  private rerun = false;
  private generation = 0;
  private recoveredRoot: string | null = null;
  private generationStartedAt = '';

  constructor(private readonly input: {
    runtime: ActiveWorkspaceRuntime;
    loadSelectedDataRoot: () => Promise<DataRoot | null>;
    isCurrent?: () => boolean;
    getConfig?: (database: DatabaseSync, payload: XObservationPayload) => Promise<XListBrowserConfig>;
  }) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.generation += 1;
    this.generationStartedAt = new Date().toISOString();
    this.recoveredRoot = null;
    this.wake();
  }

  wake(): void {
    if (this.stopped) return;
    if (this.current) { this.rerun = true; return; }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), 0);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation += 1;
    this.rerun = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.current?.catch(() => {});
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.current) return;
    this.timer = null;
    const generation = this.generation;
    let delayMs = 60_000;
    this.current = (async () => {
      const root = await this.input.loadSelectedDataRoot();
      const runtime = this.input.runtime;
      if (!root || this.stopped || generation !== this.generation || !runtime.isActive || (this.input.isCurrent && !this.input.isCurrent())) return;
      const database = runtime.database;
      if (this.recoveredRoot !== root.path) {
        await recoverRunningXObservationJobs(runtime, generation, this.generationStartedAt);
        this.recoveredRoot = root.path;
      }
      await processDueXObservationJobs(runtime, {
        generation,
        isCurrent: () => !this.stopped && generation === this.generation && runtime.isActive && (!this.input.isCurrent || this.input.isCurrent()),
        getConfig: (payload) => this.input.getConfig
          ? this.input.getConfig(database, payload)
          : selectedXListBrowser(database).then((config) => ({ ...config, workspaceId: payload.workspaceId, accountKey: payload.accountKey }))
      });
      if (!runtime.isActive || (this.input.isCurrent && !this.input.isCurrent())) return;
      const dueAt = nextXObservationDueAt(database);
      if (dueAt) delayMs = Math.max(0, Math.min(60_000, Date.parse(dueAt) - Date.now()));
    })().catch(() => {});
    await this.current;
    this.current = null;
    if (this.stopped || (this.input.isCurrent && !this.input.isCurrent())) return;
    if (this.rerun) { this.rerun = false; return this.wake(); }
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref();
  }
}
