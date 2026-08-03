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

export function listXPostMetricSnapshots(database: DatabaseSync, sourceItemId: string): XPostMetricSnapshot[] {
  return (database.prepare(`${snapshotSelect} WHERE source_item_id=? ORDER BY captured_at, id`).all(sourceItemId) as SnapshotRow[])
    .map(parseSnapshot);
}

function parseSnapshot(row: SnapshotRow): XPostMetricSnapshot {
  return {
    ...row,
    normalized: JSON.parse(row.normalized),
    raw: JSON.parse(row.raw),
    evidence: JSON.parse(row.evidence)
  };
}
