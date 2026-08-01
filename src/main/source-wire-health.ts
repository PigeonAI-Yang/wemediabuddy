import type { DatabaseSync } from 'node:sqlite';
import { getLatestAgentTask } from './agent-tasks.ts';
import type { WireCheckpoint, WireSourceHealth } from './intelligence-wire.ts';

export type WireHealthEntry = {
  key: string;
  kind: 'registry' | 'x_list' | 'other';
  ok: boolean;
  at: string;
  error?: string;
  saved: number;
};

export type WireHealthLedger = {
  taskId: string | null;
  businessDate: string | null;
  status: string | null;
  phase: string | null;
  updatedAt: string | null;
  entries: WireHealthEntry[];
  summary: {
    total: number;
    ok: number;
    failed: number;
    saved: number;
  };
};

export function getWireHealthLedger(
  database: DatabaseSync,
  input: { businessDate?: string } = {}
): WireHealthLedger {
  const task = input.businessDate
    ? getLatestAgentTask(database, 'daily_intelligence', input.businessDate)
    : getLatestAgentTask(database, 'daily_intelligence');

  if (!task) {
    return {
      taskId: null,
      businessDate: input.businessDate ?? null,
      status: null,
      phase: null,
      updatedAt: null,
      entries: [],
      summary: { total: 0, ok: 0, failed: 0, saved: 0 }
    };
  }

  const checkpoint = asWireCheckpoint(task.checkpoint);
  const health = checkpoint.sourceHealth ?? {};
  const entries = Object.entries(health)
    .map(([key, value]) => toEntry(key, value))
    .sort((left, right) => {
      if (left.ok !== right.ok) return left.ok ? 1 : -1;
      return left.key.localeCompare(right.key);
    });

  let ok = 0;
  let failed = 0;
  let saved = 0;
  for (const entry of entries) {
    if (entry.ok) ok += 1;
    else failed += 1;
    saved += entry.saved;
  }

  return {
    taskId: task.id,
    businessDate: task.businessDate,
    status: task.status,
    phase: task.phase,
    updatedAt: task.updatedAt,
    entries,
    summary: {
      total: entries.length,
      ok,
      failed,
      saved
    }
  };
}

function toEntry(key: string, value: WireSourceHealth): WireHealthEntry {
  const kind = key.startsWith('x-list:')
    ? 'x_list'
    : key.includes(':')
      ? 'other'
      : 'registry';
  return {
    key,
    kind,
    ok: Boolean(value?.ok),
    at: typeof value?.at === 'string' ? value.at : '',
    error: typeof value?.error === 'string' ? value.error : undefined,
    saved: Number(value?.saved ?? 0) || 0
  };
}

function asWireCheckpoint(value: unknown): WireCheckpoint {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  const sourceHealthRaw = record.sourceHealth;
  const sourceHealth: Record<string, WireSourceHealth> = {};
  if (sourceHealthRaw && typeof sourceHealthRaw === 'object') {
    for (const [key, item] of Object.entries(sourceHealthRaw as Record<string, unknown>)) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      sourceHealth[key] = {
        ok: Boolean(row.ok),
        at: typeof row.at === 'string' ? row.at : '',
        error: typeof row.error === 'string' ? row.error : undefined,
        saved: typeof row.saved === 'number' ? row.saved : 0
      };
    }
  }
  return {
    completedRoutes: Array.isArray(record.completedRoutes) ? record.completedRoutes.map(String) : [],
    completedListIds: Array.isArray(record.completedListIds) ? record.completedListIds.map(String) : [],
    completedSourceIds: Array.isArray(record.completedSourceIds) ? record.completedSourceIds.map(String) : [],
    sourceHealth
  };
}
