import path from 'node:path';
import type { DataRoot } from './data-root.ts';
import { migrateDatabase } from './db/migrations.ts';
import { selectedXListBrowser } from './x-list-context.ts';
import type { WorkspaceRuntimeGate } from './workspace-runtime.ts';
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

  constructor(private readonly input: {
    loadSelectedDataRoot: () => Promise<DataRoot | null>;
    gate: WorkspaceRuntimeGate;
    getConfig?: (database: ReturnType<typeof migrateDatabase>, payload: XObservationPayload) => Promise<XListBrowserConfig>;
  }) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.generation += 1;
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
    this.current = this.input.gate.run(async () => {
      const root = await this.input.loadSelectedDataRoot();
      if (!root || this.stopped || generation !== this.generation) return;
      const database = migrateDatabase(path.join(root.path, 'wmb.db'));
      try {
        if (this.recoveredRoot !== root.path) {
          recoverRunningXObservationJobs(database);
          this.recoveredRoot = root.path;
        }
        await processDueXObservationJobs(database, {
          isCurrent: () => !this.stopped && generation === this.generation,
          getConfig: (payload) => this.input.getConfig
            ? this.input.getConfig(database, payload)
            : selectedXListBrowser(database).then((config) => ({ ...config, workspaceId: payload.workspaceId, accountKey: payload.accountKey }))
        });
        const dueAt = nextXObservationDueAt(database);
        if (dueAt) delayMs = Math.max(0, Math.min(60_000, Date.parse(dueAt) - Date.now()));
      } finally { database.close(); }
    }).catch(() => {});
    await this.current;
    this.current = null;
    if (this.stopped) return;
    if (this.rerun) { this.rerun = false; return this.wake(); }
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref();
  }
}
