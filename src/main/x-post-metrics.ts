import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { xMetricFields, type XMetricEvidenceMap } from './platforms/metric-value.ts';

export type XPostMetricSnapshot = {
  id: string;
  sourceItemId: string;
  accountKey: string;
  listId: string;
  bindingId: string;
  bindingRevision: number;
  observationKey: string;
  scheduledFor: string | null;
  capturedAt: string;
  normalized: Record<string, unknown>;
  raw: Record<string, unknown>;
  evidence: Record<string, unknown>;
  createdAt: string;
};
export type XTrendReason = 'source_not_found' | 'insufficient_samples' | 'capture_time_invalid'
  | 'capture_time_not_increasing' | 'interval_too_short' | 'views_unsupported'
  | 'views_unavailable' | 'views_parse_failed' | 'views_decreased';
type XTrendInterval = { fromSnapshotId: string; toSnapshotId: string; elapsedHours: number; viewDelta: number; viewsPerHour: number };
export type XTrendValue =
  | { status: 'value'; value: number; snapshotIds: string[]; intervals: XTrendInterval[] }
  | { status: 'data_insufficient'; reason: XTrendReason };
export type XPostTrend = {
  sourceItemId: string;
  sourceUrl: string | null;
  title: string | null;
  status: 'ready' | 'data_insufficient';
  reason: XTrendReason | null;
  sampleCount: number;
  snapshots: XPostMetricSnapshot[];
  viewsPerHour: XTrendValue;
  velocityChange: XTrendValue;
};

type SnapshotRow = {
  id: string; sourceItemId: string; accountKey: string; listId: string; bindingId: string;
  bindingRevision: number; observationKey: string; scheduledFor: string | null; capturedAt: string;
  normalized: string; raw: string; evidence: string; createdAt: string;
};

const snapshotSelect = `SELECT id, source_item_id AS sourceItemId, account_key AS accountKey, list_id AS listId,
  binding_id AS bindingId, binding_revision AS bindingRevision, observation_key AS observationKey,
  scheduled_for AS scheduledFor, captured_at AS capturedAt, normalized_json AS normalized,
  raw_json AS raw, evidence_json AS evidence, created_at AS createdAt FROM x_post_metric_snapshots`;

export function saveXPostMetricSnapshot(database: DatabaseSync, input: {
  sourceItemId: string;
  accountKey: string;
  listId: string;
  bindingId: string;
  bindingRevision: number;
  observationKey: string;
  scheduledFor?: string | null;
  capturedAt: string;
  metrics: XMetricEvidenceMap;
  evidence: Record<string, unknown>;
}): XPostMetricSnapshot {
  const workspace = database.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get() as { value?: string } | undefined;
  if (!workspace?.value) throw new Error('X_METRIC_WORKSPACE_REQUIRED');
  const profile = database.prepare("SELECT revision FROM workspace_profiles WHERE id='effective'").get() as { revision?: number } | undefined;
  const binding = database.prepare(`SELECT id, account_key AS accountKey, list_id AS listId,
    source_feed_id AS sourceFeedId, enabled, revision FROM x_list_bindings WHERE id=?`).get(input.bindingId) as {
      id: string; accountKey: string; listId: string; sourceFeedId: string; enabled: number; revision: number;
    } | undefined;
  if (!binding || !binding.enabled || binding.accountKey.toLowerCase() !== input.accountKey.toLowerCase()
    || binding.listId !== input.listId || binding.revision !== input.bindingRevision) throw new Error('X_METRIC_BINDING_STALE');
  const source = database.prepare('SELECT feed_id AS feedId FROM source_items WHERE id=?').get(input.sourceItemId) as { feedId: string } | undefined;
  if (!source || source.feedId !== binding.sourceFeedId) throw new Error('X_METRIC_SOURCE_MISMATCH');
  if (!input.observationKey.trim() || !Number.isFinite(Date.parse(input.capturedAt))) throw new Error('X_METRIC_OBSERVATION_INVALID');

  const existing = database.prepare(`${snapshotSelect} WHERE observation_key=? AND source_item_id=?`)
    .get(input.observationKey, input.sourceItemId) as SnapshotRow | undefined;
  if (existing) return parseSnapshot(existing);

  const normalized = Object.fromEntries(xMetricFields.map((field) => {
    const metric = input.metrics[field];
    return [field, metric.status === 'value' ? { status: metric.status, value: metric.value } : { status: metric.status }];
  }));
  const raw = Object.fromEntries(xMetricFields.map((field) => [field, input.metrics[field]]));
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  database.prepare(`INSERT INTO x_post_metric_snapshots (id, source_item_id, account_key, list_id, binding_id,
    binding_revision, observation_key, scheduled_for, captured_at, normalized_json, raw_json, evidence_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, input.sourceItemId, binding.accountKey, binding.listId, binding.id, binding.revision,
    input.observationKey, input.scheduledFor ?? null, input.capturedAt, JSON.stringify(normalized),
    JSON.stringify(raw), JSON.stringify({ ...input.evidence, workspaceId: workspace.value, profileRevision: profile?.revision ?? null }), createdAt
  );
  return parseSnapshot(database.prepare(`${snapshotSelect} WHERE id=?`).get(id) as SnapshotRow);
}

export function listXPostMetricSnapshots(database: DatabaseSync, sourceItemId: string, limit = 100): XPostMetricSnapshot[] {
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 500);
  return (database.prepare(`${snapshotSelect} WHERE source_item_id=? ORDER BY captured_at DESC, id DESC LIMIT ?`)
    .all(sourceItemId, bounded) as SnapshotRow[]).reverse().map(parseSnapshot);
}

export function getXPostTrend(database: DatabaseSync, sourceItemId: string): XPostTrend {
  const source = database.prepare('SELECT canonical_url AS sourceUrl, title FROM source_items WHERE id=?')
    .get(sourceItemId) as { sourceUrl: string | null; title: string } | undefined;
  const snapshots = source ? listXPostMetricSnapshots(database, sourceItemId, 100) : [];
  const samples = snapshots.slice(-3);
  const viewsPerHour = samples.length >= 2 ? interval(samples.at(-2)!, samples.at(-1)!) : insufficient('insufficient_samples');
  let velocityChange: XTrendValue = insufficient('insufficient_samples');
  if (samples.length >= 3) {
    const previous = interval(samples[0], samples[1]);
    if (previous.status === 'data_insufficient') velocityChange = previous;
    else if (viewsPerHour.status === 'data_insufficient') velocityChange = viewsPerHour;
    else velocityChange = {
      status: 'value', value: viewsPerHour.value - previous.value,
      snapshotIds: [samples[0].id, samples[1].id, samples[2].id],
      intervals: [...previous.intervals, ...viewsPerHour.intervals]
    };
  }
  const missing = !source ? insufficient('source_not_found') : null;
  const current = missing ?? viewsPerHour;
  return {
    sourceItemId,
    sourceUrl: source?.sourceUrl ?? null,
    title: source?.title ?? null,
    status: current.status === 'value' ? 'ready' : 'data_insufficient',
    reason: current.status === 'data_insufficient' ? current.reason : null,
    sampleCount: snapshots.length,
    snapshots,
    viewsPerHour: current,
    velocityChange: missing ?? velocityChange
  };
}

export function listXPostTrends(database: DatabaseSync, input: { sourceIds?: string[]; bindingId?: string; limit?: number }): XPostTrend[] {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 100);
  const sourceIds = input.sourceIds?.length
    ? [...new Set(input.sourceIds)].slice(0, limit)
    : (database.prepare(`SELECT source_item_id AS id FROM x_post_metric_snapshots
        WHERE (? IS NULL OR binding_id=?) GROUP BY source_item_id ORDER BY MAX(captured_at) DESC LIMIT ?`)
      .all(input.bindingId ?? null, input.bindingId ?? null, limit) as Array<{ id: string }>).map((row) => row.id);
  return sourceIds.map((sourceId) => getXPostTrend(database, sourceId));
}

function parseSnapshot(row: SnapshotRow): XPostMetricSnapshot {
  return {
    ...row,
    normalized: JSON.parse(row.normalized),
    raw: JSON.parse(row.raw),
    evidence: JSON.parse(row.evidence)
  };
}

function interval(from: XPostMetricSnapshot, to: XPostMetricSnapshot): XTrendValue {
  const fromTime = Date.parse(from.capturedAt); const toTime = Date.parse(to.capturedAt);
  if (!Number.isFinite(fromTime) || !Number.isFinite(toTime)) return insufficient('capture_time_invalid');
  if (toTime <= fromTime) return insufficient('capture_time_not_increasing');
  const elapsedMs = toTime - fromTime;
  if (elapsedMs < 10 * 60_000) return insufficient('interval_too_short');
  const fromViews = metricValue(from.normalized.views); const toViews = metricValue(to.normalized.views);
  if (typeof fromViews === 'string') return insufficient(fromViews);
  if (typeof toViews === 'string') return insufficient(toViews);
  if (toViews < fromViews) return insufficient('views_decreased');
  const elapsedHours = elapsedMs / 3_600_000; const viewDelta = toViews - fromViews;
  const viewsPerHour = viewDelta / elapsedHours;
  return {
    status: 'value', value: viewsPerHour, snapshotIds: [from.id, to.id],
    intervals: [{ fromSnapshotId: from.id, toSnapshotId: to.id, elapsedHours, viewDelta, viewsPerHour }]
  };
}

function metricValue(value: unknown): number | XTrendReason {
  if (!value || typeof value !== 'object') return 'views_unavailable';
  const metric = value as { status?: unknown; value?: unknown };
  if (metric.status !== 'value') {
    return metric.status === 'unsupported' || metric.status === 'parse_failed' ? `views_${metric.status}` : 'views_unavailable';
  }
  return typeof metric.value === 'number' && Number.isFinite(metric.value) && metric.value >= 0 ? metric.value : 'views_parse_failed';
}

function insufficient(reason: XTrendReason): XTrendValue {
  return { status: 'data_insufficient', reason };
}
