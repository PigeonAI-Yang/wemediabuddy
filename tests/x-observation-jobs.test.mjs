import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { xMetricEvidenceMap } from '../src/main/platforms/metric-value.ts';
import { bindXList } from '../src/main/x-lists.ts';
import { getXObservationSession, processDueXObservationJobs, startXObservationSession, stopXObservationSession } from '../src/main/x-observation-jobs.ts';
import { insertWorkspaceProfile } from '../src/main/workspace-profiles.ts';

test('X observation schedules exact windows, replays idempotently, and resumes only the latest overdue window', async () => {
  const fixture = await createFixture('resume');
  try {
    const first = await startXObservationSession(fixture.db, fixture.config, {
      requestId: 'observe-resume', bindingIds: [fixture.binding.id], readTimeline: timelineAt('2026-08-02T00:00:00.000Z', 100)
    });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.deepEqual(first.data.jobs.map((job) => [job.payload.window, job.dueAt]), [
      ['15m', '2026-08-02T00:15:00.000Z'], ['60m', '2026-08-02T01:00:00.000Z'], ['180m', '2026-08-02T03:00:00.000Z']
    ]);
    const replay = await startXObservationSession(fixture.db, fixture.config, {
      requestId: 'observe-resume', bindingIds: [fixture.binding.id], readTimeline: () => { throw new Error('replay must not read'); }
    });
    assert.equal(replay.ok, true); assert.equal(replay.data.replayed, true); assert.equal(replay.data.jobs.length, 3);
    const conflict = await startXObservationSession(fixture.db, fixture.config, { requestId: 'observe-resume', bindingIds: ['different'] });
    assert.equal(conflict.ok, false); assert.equal(conflict.error.code, 'VALIDATION_ERROR');

    const processed = await processDueXObservationJobs(fixture.db, {
      now: '2026-08-02T01:20:00.000Z', getConfig: async () => fixture.config,
      readTimeline: timelineAt('2026-08-02T01:20:00.000Z', 200)
    });
    assert.deepEqual(processed, { processed: 1, succeeded: 1 }, JSON.stringify(getXObservationSession(fixture.db, first.data.id)));
    const resumed = getXObservationSession(fixture.db, first.data.id);
    assert.deepEqual(resumed.jobs.map((job) => [job.payload.window, job.status, job.lastError]), [
      ['15m', 'failed', 'OBSERVATION_WINDOW_EXPIRED'], ['60m', 'succeeded', null], ['180m', 'pending', null]
    ]);
    assert.equal(count(fixture.db, 'x_post_metric_snapshots'), 2);
    await processDueXObservationJobs(fixture.db, {
      now: '2026-08-03T01:21:00.000Z', getConfig: async () => { throw new Error('expired window must not open browser'); }
    });
    assert.equal(getXObservationSession(fixture.db, first.data.id).jobs[2].lastError, 'OBSERVATION_WINDOW_EXPIRED');
    assert.equal(count(fixture.db, 'x_post_metric_snapshots'), 2);
  } finally { await fixture.close(); }
});

test('stopping an in-flight X observation rejects its late browser result without writes', async () => {
  const fixture = await createFixture('stop');
  try {
    const started = await startXObservationSession(fixture.db, fixture.config, {
      requestId: 'observe-stop', bindingIds: [fixture.binding.id], readTimeline: timelineAt('2026-08-02T00:00:00.000Z', 100)
    });
    assert.equal(started.ok, true, JSON.stringify(started));
    fixture.db.prepare("UPDATE jobs SET due_at='2026-08-02T00:15:00.000Z' WHERE id=?").run(started.data.jobs[0].id);
    let release;
    const delayed = new Promise((resolve) => { release = resolve; });
    const running = processDueXObservationJobs(fixture.db, {
      now: '2026-08-02T00:16:00.000Z', getConfig: async () => fixture.config,
      readTimeline: async (...args) => { await delayed; return timelineAt('2026-08-02T00:16:00.000Z', 200)(...args); }
    });
    await new Promise((resolve) => setImmediate(resolve));
    const stopped = stopXObservationSession(fixture.db, started.data.id);
    assert.equal(stopped.status, 'stopped'); release();
    assert.deepEqual(await running, { processed: 1, succeeded: 0 });
    assert.equal(count(fixture.db, 'source_items'), 1);
    assert.equal(count(fixture.db, 'x_post_metric_snapshots'), 1);
    assert.equal(getXObservationSession(fixture.db, started.data.id).status, 'stopped');
  } finally { await fixture.close(); }
});

async function createFixture(name) {
  const directory = await mkdtemp(path.join(os.tmpdir(), `wmb-x-observation-${name}-`));
  const db = migrateDatabase(path.join(directory, 'wmb.db')); const now = new Date().toISOString();
  db.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id','root-a',?,?,1)").run(now, now);
  insertWorkspaceProfile(db, {
    profileId: 'profile.test', revision: 1, officialTemplateId: null, officialTemplateVersion: null,
    displayName: 'Test', audience: 'test', contentGoal: 'test', editorialBrief: 'test',
    intelligencePackId: 'game-news-radar', intelligencePackVersion: 1,
    creationPackId: 'wmb-core-creation', creationPackVersion: 1, platforms: ['x']
  });
  const bound = bindXList(db, { accountKey: '@Owner', list: {
    listId: '123', canonicalUrl: 'https://x.com/i/lists/123', ownerHandle: '@Owner', name: 'AI', kind: 'owned'
  } });
  assert.equal(bound.ok, true);
  return {
    db, binding: bound.data, config: { id: 'edge:test', workspaceId: 'root-a', accountKey: '@Owner' },
    close: async () => { db.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  };
}

function timelineAt(capturedAt, views) {
  const evidence = xMetricEvidenceMap({ views }, 'graphql', { views: 'views.count' });
  return async () => ({
    accountKey: '@Owner', detail: {
      listId: '123', canonicalUrl: 'https://x.com/i/lists/123', name: 'AI', ownerHandle: '@Owner', kind: 'owned',
      description: '', isPrivate: false, memberCount: 1,
      observation: { capturedAt, pageUrl: 'https://x.com/i/lists/123', fingerprint: `fp-${capturedAt}`, visibleText: 'AI' }
    },
    posts: [{
      url: 'https://x.com/author/status/1', authorHandle: '@author', displayName: 'Author', avatarUrl: null,
      text: 'post', postedAt: capturedAt, images: [], imageThumbs: [], hasVideo: false, videoPoster: null, videoUrl: null,
      metrics: { replies: null, reposts: null, likes: null, bookmarks: null, views }, metricEvidence: evidence
    }], hasMore: false
  });
}

function count(db, table) { return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count; }
