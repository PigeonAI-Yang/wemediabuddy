import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { collectBoundXListTimeline } from '../src/main/x-list-execution.ts';
import { bindXList } from '../src/main/x-lists.ts';
import { getXPostTrend, listXPostMetricSnapshots } from '../src/main/x-post-metrics.ts';
import { insertWorkspaceProfile } from '../src/main/workspace-profiles.ts';

const statePath = path.join(process.cwd(), '.ai', 'wmb-2205-real-metrics-state.json');
const receiptPath = path.join(process.cwd(), '.ai', 'wmb-2205-real-metrics.json');
const accountKey = '@KimbomArtist'; const listId = '2082851520417255750';
let state;
try { state = JSON.parse(await readFile(statePath, 'utf8')); }
catch {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-2205-real-'));
  const db = migrateDatabase(path.join(root, 'wmb.db')); const now = new Date().toISOString();
  db.prepare('INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES(?,?,?,?,1)').run('workspace_id', 'wmb-2205-real', now, now);
  insertWorkspaceProfile(db, { profileId: 'profile.wmb-2205', revision: 1, officialTemplateId: null, officialTemplateVersion: null,
    displayName: 'WMB-2205', audience: 'acceptance', contentGoal: 'acceptance', editorialBrief: 'acceptance',
    intelligencePackId: 'game-news-radar', intelligencePackVersion: 1, creationPackId: 'wmb-core-creation', creationPackVersion: 1, platforms: ['x'] });
  const bound = bindXList(db, { accountKey, list: { listId, canonicalUrl: `https://x.com/i/lists/${listId}`, ownerHandle: accountKey, name: 'AI前沿', kind: 'owned' } });
  assert.equal(bound.ok, true); db.close(); state = { root, bindingId: bound.data.id, bindingRevision: bound.data.revision, captures: [] };
}
if (process.argv.includes('--cleanup')) {
  assert.equal(state.root.startsWith(path.join(os.tmpdir(), 'wmb-2205-real-')), true);
  await rm(state.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(statePath, { force: true }); process.exit(0);
}

const db = migrateDatabase(path.join(state.root, 'wmb.db'));
try {
  const result = await collectBoundXListTimeline(db, { id: 'edge:pyaireader-default', cdpUrl: 'http://127.0.0.1:9334', workspaceId: 'wmb-2205-real', accountKey }, {
    accountKey, listId, expectedBindingId: state.bindingId, expectedRevision: state.bindingRevision,
    observationKey: `wmb-2205-real-${crypto.randomUUID()}`, limit: 50
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  state.captures.push({ capturedAt: result.data.capturedAt, sourceIds: result.data.sourceIds, snapshotIds: result.data.snapshotIds });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  if (state.captures.length >= 3) {
    const candidates = [...new Set(state.captures.flatMap((capture) => capture.sourceIds))]
      .map((sourceId) => ({ sourceId, snapshots: listXPostMetricSnapshots(db, sourceId), trend: getXPostTrend(db, sourceId) }))
      .filter((item) => item.snapshots.length >= 3 && item.trend.status === 'ready' && item.trend.velocityChange.status === 'value');
    assert.ok(candidates.length, 'three real reads produced no common post with a three-point trend');
    const sample = candidates[0]; const times = sample.snapshots.slice(-3).map((snapshot) => Date.parse(snapshot.capturedAt));
    assert.ok(times[1] - times[0] >= 10 * 60_000 && times[2] - times[1] >= 10 * 60_000, 'real captures are less than ten minutes apart');
    const receipt = { taskId: 'WMB-2205', finishedAt: new Date().toISOString(), accountKey, listId,
      captures: state.captures, commonPostCount: candidates.length, sample: { sourceItemId: sample.sourceId, snapshots: sample.snapshots.slice(-3), trend: sample.trend } };
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ complete: true, commonPostCount: candidates.length, sourceItemId: sample.sourceId,
      viewsPerHour: sample.trend.viewsPerHour.value, velocityChange: sample.trend.velocityChange.value }));
  } else console.log(JSON.stringify({ complete: false, capture: state.captures.length, capturedAt: result.data.capturedAt, snapshots: result.data.snapshotIds.length }));
} finally { db.close(); }
