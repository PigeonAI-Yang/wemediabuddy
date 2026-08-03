import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildDailyOpportunityPrompt } from '../src/main/agent-runner.ts';
import { startDailyChannelRun } from '../src/main/daily-intelligence-channels.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { recordKnowledgeBatch } from '../src/main/knowledge.ts';
import { xMetricEvidenceMap } from '../src/main/platforms/metric-value.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { upsertSource } from '../src/main/sources.ts';
import { getToday } from '../src/main/workbench.ts';
import { insertWorkspaceProfile } from '../src/main/workspace-profiles.ts';
import { bindXList } from '../src/main/x-lists.ts';
import { saveXPostMetricSnapshot } from '../src/main/x-post-metrics.ts';

test('one existing event opportunity carries exact X trend evidence into daily jobs, Today, and Pi context', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-x-trend-opportunity-')); let db;
  try {
    db = migrateDatabase(path.join(root, 'wmb.db')); const now = new Date().toISOString();
    db.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id','trend-root',?,?,1)").run(now, now);
    insertWorkspaceProfile(db, {
      profileId: 'profile.test', revision: 1, officialTemplateId: null, officialTemplateVersion: null,
      displayName: 'Test', audience: 'test', contentGoal: 'test', editorialBrief: 'test',
      intelligencePackId: 'game-news-radar', intelligencePackVersion: 1,
      creationPackId: 'wmb-core-creation', creationPackVersion: 1, platforms: ['x']
    });
    const bound = bindXList(db, { accountKey: '@owner', list: {
      listId: '123', canonicalUrl: 'https://x.com/i/lists/123', ownerHandle: '@owner', name: 'AI', kind: 'owned'
    } });
    assert.equal(bound.ok, true);
    const xSource = upsertSource(db, { feedId: bound.data.sourceFeedId, originalUrl: 'https://x.com/author/status/1', title: 'X evidence' });
    const webSource = upsertSource(db, { originalUrl: 'https://example.com/release', title: 'Official evidence' });
    const links = recordKnowledgeBatch(db, { items: [xSource.id, webSource.id].map((sourceId) => ({
      sourceId, topic: { canonicalKey: 'same-event', title: 'Same event', kind: 'event' }, relation: 'primary'
    })) });
    assert.equal(new Set(links.map((item) => item.topicId)).size, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM topics').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM topic_source_links').get().count, 2);

    const save = (key, capturedAt, views) => saveXPostMetricSnapshot(db, {
      sourceItemId: xSource.id, accountKey: '@owner', listId: '123', bindingId: bound.data.id, bindingRevision: bound.data.revision,
      observationKey: key, capturedAt, metrics: xMetricEvidenceMap({ views }, 'graphql', { views: 'views.count' }),
      evidence: { pageUrl: 'https://x.com/i/lists/123' }
    });
    const snapshots = [save('one', '2026-08-02T00:00:00.000Z', 100), save('two', '2026-08-02T00:15:00.000Z', 160), save('three', '2026-08-02T01:00:00.000Z', 400)];
    const plan = saveCurrentPlan(db, { planDate: '2026-08-03', timezone: 'Asia/Shanghai', summary: 'trend', items: [{
      topicId: links[0].topicId, title: 'Trend opportunity', priority: 1, whyNow: 'views accelerate', timeliness: 'today',
      targetAudience: 'builders', angle: 'explain', pointOfView: 'evidence first', platforms: ['x'], formats: ['text'],
      titleGuidance: 'title', openingGuidance: 'opening', structureGuidance: 'structure', effortEstimate: '30m',
      sourceIds: [xSource.id, webSource.id]
    }] });
    const today = getToday(db, '2026-08-03'); const evidence = today.plan.items[0].trendEvidence[0];
    assert.equal(evidence.viewsPerHour.value, 320); assert.equal(evidence.velocityChange.value, 80);
    assert.deepEqual(evidence.velocityChange.snapshotIds, snapshots.map((item) => item.id));
    const prompt = buildDailyOpportunityPrompt(db, { id: 'task', intent: 'daily_intelligence', businessDate: '2026-08-03', checkpoint: {} }, 'plan-request');
    assert.match(prompt, new RegExp(xSource.id)); assert.match(prompt, new RegExp(snapshots[2].id)); assert.match(prompt, /320/);

    let collectCalls = 0;
    const run = await startDailyChannelRun(db, { businessDate: '2026-08-04', workspaceId: 'trend-root', profileRevision: 1 }, {
      browserConfig: { id: 'edge:test', cdpUrl: 'http://127.0.0.1:1' },
      collectX: async () => { collectCalls += 1; return { ok: true, data: {
        binding: bound.data, sourceIds: [xSource.id], snapshotIds: [snapshots[2].id], candidateCount: 1, capturedAt: '2026-08-02T01:00:00.000Z'
      }, error: null }; }
    });
    assert.equal(run.shouldRunJudgment, true); assert.equal(collectCalls, 1);
    const jobs = db.prepare("SELECT payload_json AS payload FROM jobs WHERE kind='x_list_observation' ORDER BY due_at").all();
    assert.equal(jobs.length, 3); assert.deepEqual(jobs.map((row) => JSON.parse(row.payload).window), ['15m', '60m', '180m']);
  } finally { db?.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});
