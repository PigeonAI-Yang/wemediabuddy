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
import { saveReview } from '../src/main/reviews.ts';
import { createTopic } from '../src/main/planning.ts';
import { upsertSource } from '../src/main/sources.ts';
import { ensureOfficialWorkspaceProfile } from '../src/main/workspace-profiles.ts';
import { assembleEditorialBrief, renderEditorialBrief } from '../src/main/editorial-brief.ts';

const NOW = new Date('2026-08-05T06:00:00.000Z');

async function withDb(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-brief-'));
  await openDataRoot(root);
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  try {
    await run(database);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

function seedSource(database, id, title, collectedAt, summary = `${title} 摘要`) {
  const saved = upsertSource(database, { title, originalUrl: `https://example.com/${id}`, summary, categories: ['工具'] }, false);
  database.prepare('UPDATE source_items SET collected_at = ? WHERE id = ?').run(collectedAt, saved.id);
  return saved.id;
}

function seedPublished(database, { projectTitle, topicTitle, publishedAt }) {
  const account = saveAccount(database, { platform: 'x', accountKey: '@brief', displayName: 'brief', loginState: 'authenticated' });
  const project = createContentProject(database, { title: projectTitle, sourceIds: [] });
  if (topicTitle) {
    const topic = createTopic(database, topicTitle);
    database.prepare('UPDATE content_projects SET topic_id = ? WHERE id = ?').run(topic.id, project.id);
  }
  const core = saveCoreVersion(database, { projectId: project.id, body: 'core body', expectedRevision: 1 });
  assert.equal(core.ok, true);
  const platform = savePlatformVersion(database, {
    projectId: project.id, contentVersionId: core.data.id, platform: 'x', format: 'post',
    title: projectTitle, body: 'platform body'
  });
  assert.equal(platform.ok, true);
  const publication = createPublication(database, {
    platformVersionId: platform.data.id, accountId: account.id
  });
  assert.equal(publication.ok, true);
  const row = database.prepare('SELECT id, revision FROM publications WHERE id = ?').get(publication.data.id);
  database.prepare(`UPDATE publications SET
    status = 'published', external_url = ?, external_id = '1', published_at = ?, prepared_title = ?, prepared_body = ?,
    prepared_assets_json = '[]', updated_at = ?, revision = ? WHERE id = ?`)
    .run(`https://x.com/brief/status/${project.id.slice(0, 6)}`, publishedAt, projectTitle, 'platform body', publishedAt, row.revision + 1, row.id);
  return { publicationId: row.id };
}

function seedFinalReview(database, publicationId) {
  const now = NOW.toISOString();
  const metric = savePublicationMetricSnapshot(database, {
    publicationId, scheduledFor: now, sourceUrl: 'https://x.com/brief/status/1', capturedAt: now,
    normalized: { views: { status: 'value', value: 42 } }, raw: { views: '42' }
  });
  assert.equal(metric.ok, true);
  const review = saveReview(database, {
    publicationId, metricSnapshotIds: [metric.data.id],
    keep: ['保留数据开头'], stop: ['停止空泛预测'], change: ['加强反方证据'],
    summary: '数据开头有效', status: 'final',
    findings: [{ title: '先给结论', body: '开头第一段必须给结论' }]
  });
  assert.equal(review.ok, true);
  return review.data;
}

test('assemble returns identity, bounded history, inventory and watermark-scoped increment', async () => {
  await withDb(async (database) => {
    ensureOfficialWorkspaceProfile(database, 'official.ai');
    seedSource(database, 'old-1', '旧资料', '2026-08-04T20:00:00.000Z');
    seedSource(database, 'new-1', '新资料甲', '2026-08-05T03:00:00.000Z', '新模型发布，支持原生搜索');
    seedSource(database, 'new-2', '新资料乙', '2026-08-05T05:00:00.000Z');
    seedPublished(database, { projectTitle: '近期作品', topicTitle: 'AI 工具', publishedAt: '2026-08-04T10:00:00.000Z' });
    seedPublished(database, { projectTitle: '远古作品', topicTitle: null, publishedAt: '2026-06-01T10:00:00.000Z' });

    const brief = assembleEditorialBrief(database, { now: NOW, watermark: '2026-08-05T02:00:00.000Z' });

    assert.equal(brief.identity?.audience, '关注 AI 工具、行业、开发和商业机会的中文受众');
    assert.equal(brief.identity?.editorialBrief.includes('SSS'), true);

    assert.deepEqual(brief.history.published.map((item) => item.projectTitle), ['近期作品']);
    assert.equal(brief.history.published[0].topicTitle, 'AI 工具');

    assert.deepEqual(brief.increment.sources.map((item) => item.title), ['新资料甲', '新资料乙']);
    assert.equal(brief.increment.sources[0].summary, '新模型发布，支持原生搜索');
    assert.equal(brief.increment.watermark, '2026-08-05T02:00:00.000Z');
    assert.equal(brief.increment.truncated, false);

    assert.equal(brief.businessDate, '2026-08-05');
    assert.ok(Array.isArray(brief.inventory.watching));
    assert.ok(Array.isArray(brief.inventory.trends));
  });
});

test('null watermark falls back to rolling hours window', async () => {
  await withDb(async (database) => {
    seedSource(database, 'w-1', '窗口内', '2026-08-04T20:00:00.000Z');
    seedSource(database, 'w-2', '窗口外', '2026-08-03T05:00:00.000Z');
    const brief = assembleEditorialBrief(database, { now: NOW, fallbackHours: 24 });
    assert.deepEqual(brief.increment.sources.map((item) => item.title), ['窗口内']);
    assert.equal(brief.increment.since, '2026-08-04T06:00:00.000Z');
  });
});

test('history carries final reviews and method findings', async () => {
  await withDb(async (database) => {
    const { publicationId } = seedPublished(database, { projectTitle: '复盘对象', topicTitle: 'AI 工具', publishedAt: '2026-08-04T10:00:00.000Z' });
    seedFinalReview(database, publicationId);
    const brief = assembleEditorialBrief(database, { now: NOW });
    assert.equal(brief.history.reviews.length, 1);
    assert.deepEqual(brief.history.reviews[0].keep, ['保留数据开头']);
    assert.deepEqual(brief.history.reviews[0].change, ['加强反方证据']);
    assert.equal(brief.history.findings[0].title, '先给结论');
  });
});

test('businessDate override anchors header and ferment carry, not wall clock', async () => {
  await withDb(async (database) => {
    const brief = assembleEditorialBrief(database, { now: NOW, businessDate: '2026-08-03' });
    assert.equal(brief.businessDate, '2026-08-03');
    const text = renderEditorialBrief(brief);
    assert.ok(text.includes('业务日期 2026-08-03'));
    assert.ok(!text.includes('业务日期 2026-08-05'));
  });
});

test('render produces four blocks with payloads and degrades on empty db', async () => {
  await withDb(async (database) => {
    ensureOfficialWorkspaceProfile(database, 'official.ai');
    seedSource(database, 'r-1', '渲染资料', '2026-08-05T03:00:00.000Z', '渲染用摘要');
    const { publicationId } = seedPublished(database, { projectTitle: '渲染作品', topicTitle: 'AI 工具', publishedAt: '2026-08-04T10:00:00.000Z' });
    seedFinalReview(database, publicationId);

    const text = renderEditorialBrief(assembleEditorialBrief(database, { now: NOW }));
    for (const marker of ['■ 身份', '■ 历史', '■ 存量', '■ 增量']) assert.ok(text.includes(marker), `missing ${marker}`);
    assert.ok(text.includes('关注 AI 工具、行业、开发和商业机会的中文受众'));
    assert.ok(text.includes('渲染作品'));
    assert.ok(text.includes('保留数据开头'));
    assert.ok(text.includes('渲染用摘要'));
  });

  await withDb(async (database) => {
    const brief = assembleEditorialBrief(database, { now: NOW });
    assert.equal(brief.identity, null);
    assert.equal(brief.history.published.length, 0);
    assert.equal(brief.increment.sources.length, 0);
    const text = renderEditorialBrief(brief);
    assert.ok(text.includes('（未配置工作空间配方）'));
    assert.ok(text.includes('（本轮无新资料）'));
  });
});
