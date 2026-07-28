import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { saveAccount } from '../src/main/accounts.ts';
import { createContentProject, saveCoreVersion, savePlatformVersion } from '../src/main/content.ts';
import { createPublication } from '../src/main/publishing.ts';
import { savePublicationMetricSnapshot } from '../src/main/metrics.ts';
import { listReviewBacklinks, listReviews, saveReview } from '../src/main/reviews.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { upsertSource } from '../src/main/sources.ts';

async function withDb(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-reviews-'));
  await openDataRoot(root);
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  try {
    await run(database);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

function seedPublished(database) {
  const account = saveAccount(database, {
    platform: 'x',
    accountKey: '@tester',
    displayName: 'tester',
    loginState: 'authenticated'
  });
  const project = createContentProject(database, { title: 'review project', sourceIds: [] });
  const core = saveCoreVersion(database, project.id, 'core body');
  const platform = savePlatformVersion(database, {
    projectId: project.id,
    contentVersionId: core.id,
    platform: 'x',
    format: 'text',
    body: 'platform body'
  });
  assert.equal(platform.ok, true);
  const publication = createPublication(database, {
    platformVersionId: platform.data.id,
    accountId: account.id
  });
  assert.equal(publication.ok, true);
  const detail = database.prepare('SELECT id, revision FROM publications WHERE id = ?').get(publication.data.id);
  const now = new Date().toISOString();
  database.prepare(`UPDATE publications SET
    status = 'published', external_url = ?, external_id = ?, published_at = ?, prepared_title = ?, prepared_body = ?, prepared_assets_json = '[]', updated_at = ?, revision = ?
    WHERE id = ?`).run('https://x.com/tester/status/1', '1', now, null, 'platform body', now, detail.revision + 1, detail.id);
  const snap = savePublicationMetricSnapshot(database, {
    publicationId: detail.id,
    scheduledFor: now,
    sourceUrl: 'https://x.com/tester/status/1',
    capturedAt: now,
    normalized: { views: { status: 'value', value: 10, rawLabel: '10' } },
    raw: { views: { status: 'value', value: 10, rawLabel: '10' } }
  });
  assert.equal(snap.ok, true);
  return { publicationId: detail.id, snapshotId: snap.data.id };
}

test('final review requires snapshot and keep/stop/change then reads back findings', async () => {
  await withDb((database) => {
    const { publicationId, snapshotId } = seedPublished(database);
    const blocked = saveReview(database, {
      publicationId,
      metricSnapshotIds: [snapshotId],
      keep: ['keep one'],
      stop: [],
      change: ['change one'],
      status: 'final'
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'VALIDATION_ERROR');

    const saved = saveReview(database, {
      publicationId,
      metricSnapshotIds: [snapshotId],
      keep: ['keep video hook'],
      stop: ['stop generic CTA'],
      change: ['change cover text first'],
      summary: 'video worked',
      status: 'final',
      findings: [{ title: '封面先给结论', body: '后续方案优先强结论封面' }]
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.data.status, 'final');
    assert.equal(saved.data.keep[0], 'keep video hook');
    assert.equal(saved.data.findings.length, 1);

    const listed = listReviews(database, publicationId);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].metricSnapshotIds[0], snapshotId);
    assert.equal(listed[0].findings[0].title, '封面先给结论');
  });
});

test('later plan item can backlink final review and method finding', async () => {
  await withDb((database) => {
    const { publicationId, snapshotId } = seedPublished(database);
    const source = upsertSource(database, {
      title: 'source for plan',
      originalUrl: 'https://example.com/a',
      summary: 's',
      categories: [],
      keywords: [],
      valueJudgment: 'v',
      ipRelevance: 'i',
      creationAngles: 'c',
      recommendedPlatforms: ['x'],
      recommendedFormats: ['text'],
      timeliness: 'now',
      priority: 1,
      evidence: 'e'
    });
    const review = saveReview(database, {
      publicationId,
      metricSnapshotIds: [snapshotId],
      keep: ['k'],
      stop: ['s'],
      change: ['c'],
      status: 'final',
      findings: [{ title: 'finding', body: 'body' }]
    });
    assert.equal(review.ok, true);
    const plan = saveCurrentPlan(database, {
      planDate: '2026-07-28',
      timezone: 'Asia/Shanghai',
      summary: 'plan with review backlink',
      items: [{
        title: 'next content',
        priority: 1,
        whyNow: 'w',
        timeliness: 't',
        targetAudience: 'a',
        angle: 'ang',
        pointOfView: 'p',
        platforms: ['x'],
        formats: ['text'],
        titleGuidance: 'tg',
        openingGuidance: 'og',
        structureGuidance: 'sg',
        effortEstimate: 'low',
        sourceIds: [source.id],
        reviewIds: [review.data.id],
        methodFindingIds: [review.data.findings[0].id]
      }]
    });
    assert.ok(plan.id);
    const links = listReviewBacklinks(database, [review.data.id], [review.data.findings[0].id]);
    assert.equal(links.length, 1);
    assert.equal(links[0].planItemTitle, 'next content');
    assert.deepEqual(links[0].reviewIds, [review.data.id]);
  });
});
