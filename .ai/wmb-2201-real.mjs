// WMB-2201 real readback: logged-in X -> canonical source -> append-only metric snapshot in an isolated temp root.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { collectBoundXListTimeline } from '../src/main/x-list-execution.ts';
import { bindXList, getXListBinding } from '../src/main/x-lists.ts';
import { listXPostMetricSnapshots } from '../src/main/x-post-metrics.ts';

const workspaceId = 'wmb-2201-real-temp';
const accountKey = '@KimbomArtist';
const listId = '2082851520417255750';
const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-2201-real-'));
const database = migrateDatabase(path.join(directory, 'wmb.db'));
const now = new Date().toISOString();
database.prepare('INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES(?,?,?,?,1)')
  .run('workspace_id', workspaceId, now, now);

try {
  const bound = bindXList(database, {
    accountKey,
    list: { listId, canonicalUrl: `https://x.com/i/lists/${listId}`, ownerHandle: accountKey, name: 'AI前沿', kind: 'owned' }
  });
  assert.equal(bound.ok, true, JSON.stringify(bound));
  const collected = await collectBoundXListTimeline(database, {
    id: 'edge:pyaireader-default', cdpUrl: 'http://127.0.0.1:9334', workspaceId, accountKey
  }, {
    accountKey, listId, expectedBindingId: bound.data.id, expectedRevision: bound.data.revision,
    observationKey: `wmb-2201-real-${Date.now()}`, limit: 20
  });
  assert.equal(collected.ok, true, JSON.stringify(collected));
  assert.ok(collected.data.sourceIds.length > 0);
  assert.equal(collected.data.snapshotIds.length, collected.data.sourceIds.length);
  const snapshots = collected.data.sourceIds.flatMap((sourceId) => listXPostMetricSnapshots(database, sourceId));
  assert.equal(snapshots.length, collected.data.snapshotIds.length);
  assert.ok(snapshots.some((snapshot) => snapshot.normalized.views?.status === 'value'));
  assert.ok(snapshots.every((snapshot) => snapshot.raw.views?.source === 'graphql' || snapshot.raw.views?.source === 'dom'));
  assert.equal(getXListBinding(database, accountKey, listId).revision, bound.data.revision);
  const receipt = {
    taskId: 'WMB-2201', finishedAt: new Date().toISOString(), workspaceId, accountKey, listId,
    sourceCount: collected.data.sourceIds.length, snapshotCount: snapshots.length,
    sample: snapshots.slice(0, 3).map((snapshot) => ({
      sourceItemId: snapshot.sourceItemId, capturedAt: snapshot.capturedAt,
      views: snapshot.normalized.views, rawViews: snapshot.raw.views, evidence: snapshot.evidence
    }))
  };
  writeFileSync(path.join(process.cwd(), '.ai', 'wmb-2201-real.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ok: true, sourceCount: receipt.sourceCount, snapshotCount: receipt.snapshotCount }, null, 2));
} finally {
  database.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
process.exit(0);
