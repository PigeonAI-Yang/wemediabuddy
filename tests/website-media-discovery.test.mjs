// WMB-5244：官网渠道媒体发现与 Source 事务内冻结（设计 §7.3 / §6.1–6.4 / §8）。
// 覆盖：相对 URL 解析、srcset、OG 兜底、直接视频、poster 父引用、重复 URL 去重、
// tracking pixel / favicon / 头像 / 广告位 / 小尺寸排除、20图4视频限额（skipped_limit）、
// 同事务原子性（回滚零部分写）、Raw HTML 不成为第二内容真源。
// 运行：node --test --test-concurrency=1 tests/website-media-discovery.test.mjs

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const {
  confirmWebsiteSource,
  resolveWebsiteCandidates,
  scanWebsiteSource
} = await import('../src/main/website-channel.ts');
const {
  discoverWebsiteMedia,
  persistWebsiteMediaCandidates,
  sanitizeMediaSnapshot,
  scanWebsiteMediaElements
} = await import('../src/main/website-media-discovery.ts');
const {
  enqueueMediaDiscoverJob,
  listArchiveAttempts,
  listMediaCandidatesForRevision,
  mediaArchiveStatusSummary
} = await import('../src/main/db/media-archive-store.ts');
const { getSource, upsertSource } = await import('../src/main/sources.ts');
const { sourceRevisionKey } = await import('../src/shared/media-candidates.ts');

const BASE = 'https://example.com/news';

function html(body, title = 'Example News') {
  return `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
}

function candidatesOf(database, sourceId, revision) {
  return listMediaCandidatesForRevision(database, sourceRevisionKey(sourceId, revision));
}

function jobsFor(database, kind, like) {
  const rows = database.prepare('SELECT * FROM jobs WHERE kind = ? AND dedupe_key LIKE ? ORDER BY dedupe_key').all(kind, like);
  return rows;
}

async function makeDatabase() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5244-web-'));
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO app_meta (key, value, created_at, updated_at, revision)
    VALUES ('workspace_id', 'workspace-web', ?, ?, 1)`).run(now, now);
  return { root, database };
}

async function directCandidate(url) {
  const [candidate] = await resolveWebsiteCandidates({ inputText: url });
  assert.ok(candidate);
  return candidate;
}

// ============================================================================
// 净化快照与标签扫描
// ============================================================================

test('website media: sanitize strips script/style/noscript and bounds the snapshot', () => {
  const htmlWithScript = html('<script>const img = "<img src=\'/fake.png\'>";</script><img src="/real.png">');
  const snapshot = sanitizeMediaSnapshot(htmlWithScript);
  assert.doesNotMatch(snapshot, /fake\.png/);
  assert.match(snapshot, /real\.png/);
  const bounded = sanitizeMediaSnapshot(html('<p>padding</p>'), 16);
  assert.ok(bounded.length <= 16);
});

test('website media: scan collects img, video with source children, and meta in DOM order', () => {
  const body = [
    '<meta property="og:image" content="/og.png">',
    '<img src="/a.png">',
    '<video src="/v.mp4" poster="/p.jpg"><source src="/v.webm"></video>',
    '<img src="/b.png">'
  ].join('');
  const elements = scanWebsiteMediaElements(html(body));
  assert.deepEqual(elements.map((element) => element.tag), ['meta', 'img', 'video', 'img']);
  const video = elements.find((element) => element.tag === 'video');
  assert.deepEqual(video?.childSources, ['/v.webm']);
});

// ============================================================================
// 纯发现：URL 解析 / 排除 / 顺序 / OG 兜底
// ============================================================================

test('website media: relative URLs resolve against the final canonical URL', () => {
  const discovered = discoverWebsiteMedia({
    html: html('<img src="/img/a.png"><img src="img/b.png"><img src="//cdn.example.com/c.png">'),
    baseUrl: BASE
  });
  assert.deepEqual(discovered.map((media) => media.url), [
    'https://example.com/img/a.png',
    'https://example.com/img/b.png',
    'https://cdn.example.com/c.png'
  ]);
});

test('website media: srcset emits each candidate in order', () => {
  const discovered = discoverWebsiteMedia({
    html: html('<img src="/img/a.png" srcset="/img/a-2x.png 2x, /img/a-3x.png 3x">'),
    baseUrl: BASE
  });
  assert.deepEqual(discovered.map((media) => media.url), [
    'https://example.com/img/a.png',
    'https://example.com/img/a-2x.png',
    'https://example.com/img/a-3x.png'
  ]);
  assert.deepEqual(discovered.map((media) => media.source), ['img', 'srcset', 'srcset']);
});

test('website media: og:image supplements only when body lacks the same URL', () => {
  const body = '<img src="/hero.png"><meta property="og:image" content="/hero.png"><meta property="og:image" content="/og-cover.png">';
  const discovered = discoverWebsiteMedia({ html: html(body), baseUrl: BASE });
  assert.deepEqual(discovered.map((media) => media.url), [
    'https://example.com/hero.png',
    'https://example.com/og-cover.png'
  ]);
  // 正文优先：hero 是 img 来源，og 同 URL 被去重；og-cover 补入。
  assert.deepEqual(discovered.map((media) => media.source), ['img', 'og:image']);
});

test('website media: direct video, source children and poster parent relationship', () => {
  const body = [
    '<video src="/v.mp4" poster="/v-poster.jpg"></video>',
    '<video poster="/w-poster.jpg"><source src="/w.webm"></video>'
  ].join('');
  const discovered = discoverWebsiteMedia({ html: html(body), baseUrl: BASE });
  const videos = discovered.filter((media) => media.kind === 'video');
  const posters = discovered.filter((media) => media.kind === 'video_poster');
  assert.deepEqual(videos.map((media) => media.url), [
    'https://example.com/v.mp4',
    'https://example.com/w.webm'
  ]);
  assert.equal(posters.length, 2);
  assert.equal(posters[0]?.parentOrdinal, videos[0]?.ordinal);
  assert.equal(posters[1]?.parentOrdinal, videos[1]?.ordinal);
  // poster 复用父视频 ordinal（设计 §6.3：视频和 poster 可共享 ordinal）。
  assert.equal(posters[0]?.ordinal, videos[0]?.ordinal);
});

test('website media: og:video is discovered as a video candidate', () => {
  const discovered = discoverWebsiteMedia({
    html: html('<meta property="og:video" content="/promo.mp4">'),
    baseUrl: BASE
  });
  assert.deepEqual(discovered.map((media) => media.url), ['https://example.com/promo.mp4']);
  assert.equal(discovered[0]?.kind, 'video');
});

test('website media: duplicate URLs across body and srcset collapse to one candidate', () => {
  const body = '<img src="/a.png"><img src="/a.png"><img srcset="/a.png 1x, /b.png 2x">';
  const discovered = discoverWebsiteMedia({ html: html(body), baseUrl: BASE });
  assert.deepEqual(discovered.map((media) => media.url), [
    'https://example.com/a.png',
    'https://example.com/b.png'
  ]);
});

test('website media: tracking pixels, favicon, avatars, ad slots, data/blob and tiny declared sizes are excluded', () => {
  const body = [
    '<img src="https://px.example.com/pixel.gif" width="1" height="1">',
    '<img src="/favicon.ico">',
    '<img class="avatar" src="/author.png">',
    '<img class="ad-banner" src="/promo.png">',
    '<img src="data:image/png;base64,AAAA">',
    '<img src="blob:https://example.com/uuid">',
    '<img src="/tiny.png" width="40" height="40">',
    '<img src="/keep.png" width="320" height="180">'
  ].join('');
  const discovered = discoverWebsiteMedia({ html: html(body), baseUrl: BASE });
  assert.deepEqual(discovered.map((media) => media.url), ['https://example.com/keep.png']);
});

test('website media: non-http(s) schemes and unparseable URLs are dropped', () => {
  const body = '<img src="ftp://example.com/x.png"><img src="file:///etc/passwd"><img src="mailto:a@b.c"><img src="/ok.png">';
  const discovered = discoverWebsiteMedia({ html: html(body), baseUrl: BASE });
  assert.deepEqual(discovered.map((media) => media.url), ['https://example.com/ok.png']);
});

// ============================================================================
// 限额：20 图 / 4 视频，超限为 skipped_limit（无 Attempt/Job）
// ============================================================================

test('website media: over-cap images and videos become skipped_limit candidates without attempt or job', async () => {
  const { root, database } = await makeDatabase();
  try {
    const seeded = seedSource(database, 'https://example.com/caps/post');
    const source = getSource(database, seeded.id);
    const revisionKey = sourceRevisionKey(source.id, source.revision);
    const images = Array.from({ length: 25 }, (_, index) => `<img src="/img/cap-${index}.png">`).join('');
    const videos = Array.from({ length: 6 }, (_, index) => `<video src="/v/cap-${index}.mp4"></video>`).join('');
    const result = persistWebsiteMediaCandidates(database, {
      sourceId: source.id,
      sourceRevisionKey: revisionKey,
      requestId: 'website-caps',
      discoveredAt: '2026-08-14T00:00:00.000Z',
      html: html(images + videos),
      baseUrl: 'https://example.com/caps'
    });
    assert.equal(result.pendingCount, 24, '20 images + 4 videos pending');
    assert.equal(result.skippedLimitCount, 7, '5 over-cap images + 2 over-cap videos');
    assert.equal(result.archiveJobCount, 24);

    const candidates = listMediaCandidatesForRevision(database, revisionKey);
    assert.equal(candidates.length, 31);
    const skipped = candidates.filter((candidate) => candidate.status === 'skipped_limit');
    assert.equal(skipped.length, 7);
    const pending = candidates.filter((candidate) => candidate.status === 'pending');
    assert.equal(pending.length, 24);
    // skipped_limit 无 Attempt / Job。
    for (const candidate of skipped) {
      assert.equal(listArchiveAttempts(database, candidate.id).length, 0);
    }
    assert.equal(jobsFor(database, 'media_archive', `media:${revisionKey}:%`).length, 24);
    const summary = mediaArchiveStatusSummary(database, revisionKey);
    assert.equal(summary.total, 31);
    assert.equal(summary.pending, 24);
    assert.equal(summary.skippedLimit, 7);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 端到端：persistWebsiteSourceScan 同事务冻结 / 按 item 原 URL 重发现
// ============================================================================

test('WMB-5244 website: item owning the fetched DOM freezes candidates+jobs in the Source transaction', async () => {
  const { root, database } = await makeDatabase();
  try {
    // 单个 changelog item 页面：扫描页自身即 item URL（markdown changelog 自我引用）。
    const pageUrl = 'https://example.com/changelog?wmb_item=august-14-2026-1';
    const body = [
      '# Changelog',
      '',
      'August 14, 2026',
      '- Launch: benchmark chart published',
      '',
      '<img src="/img/benchmark.png" width="640" height="360" alt="Benchmark chart">',
      '<img srcset="/img/hero-1x.png 1x, /img/hero-2x.png 2x" width="800" height="450">',
      '<img src="https://px.example.com/pixel.gif" width="1" height="1">',
      '<img class="avatar" src="/img/author.png">',
      '<meta property="og:image" content="/img/og-cover.png">',
      '<meta property="og:video" content="https://cdn.example.com/promo.mp4">',
      '<video src="/video/demo.mp4" poster="/video/demo-poster.jpg"></video>',
      '',
      'August 13, 2026',
      '- Previous release'
    ].join('\n');
    const candidate = await directCandidate(pageUrl);
    const trial = {
      title: 'Changelog', url: pageUrl, requestedUrl: pageUrl, readable: true, itemCount: 2,
      summary: 'Launch: benchmark chart published August 14 2026', httpStatus: 200, contentType: 'text/html'
    };
    const source = confirmWebsiteSource(database, { inputText: 'Changelog', candidate, trialRead: trial });
    const scanned = await scanWebsiteSource(database, {
      taskId: 'web-freeze-task', workspaceId: 'workspace-web', sourceId: source.id,
      fetchImpl: async () => new Response(html(body), { status: 200, headers: { 'content-type': 'text/html' } })
    });
    assert.equal(scanned.receipt.status, 'succeeded');
    assert.equal(scanned.receipt.savedCount, 2, 'two changelog items saved');

    // item 1（= 抓取页自身）：候选 + Attempt + Job 与 Source 同事务冻结。
    const owning = getSource(database, scanned.sourceIds[0]);
    assert.equal(owning?.canonicalUrl, pageUrl);
    const owningKey = sourceRevisionKey(owning.id, owning.revision);
    const candidates = candidatesOf(database, owning.id, owning.revision);
    // DOM 顺序 + OG 兜底；pixel/avatar 被过滤（listMediaCandidatesForRevision 按 ordinal,id 排序，
    // image/video 各自成序且 poster 复用父视频 ordinal，因此用集合断言而非行序）。
    assert.deepEqual(
      [...candidates.map((candidate) => candidate.originalUrl)].sort(),
      [
        'https://example.com/img/benchmark.png',
        'https://example.com/img/hero-1x.png',
        'https://example.com/img/hero-2x.png',
        'https://example.com/img/og-cover.png',
        'https://example.com/video/demo.mp4',
        'https://example.com/video/demo-poster.jpg',
        'https://cdn.example.com/promo.mp4'
      ].sort()
    );
    const kinds = candidates.map((candidate) => candidate.kind).sort();
    assert.deepEqual(kinds, ['image', 'image', 'image', 'image', 'video', 'video', 'video_poster']);
    const video = candidates.find((candidate) => candidate.kind === 'video' && candidate.originalUrl === 'https://example.com/video/demo.mp4');
    const poster = candidates.find((candidate) => candidate.kind === 'video_poster');
    assert.equal(poster?.parentCandidateId, video?.id);
    assert.equal(poster?.ordinal, video?.ordinal);
    assert.ok(candidates.every((candidate) => candidate.channel === 'official_web'));
    assert.equal(candidates.length, jobsFor(database, 'media_archive', `media:${owningKey}:%`).length);
    for (const candidate of candidates) {
      assert.equal(listArchiveAttempts(database, candidate.id).length, 1);
    }

    // item 2（其他 URL）：不复制页面级媒体，按 item 原 URL 入队 media_discover 重发现。
    const other = getSource(database, scanned.sourceIds[1]);
    const otherKey = sourceRevisionKey(other.id, other.revision);
    assert.equal(candidatesOf(database, other.id, other.revision).length, 0);
    const discoveryJobs = jobsFor(database, 'media_discover', 'media_discover:%');
    assert.equal(discoveryJobs.length, 1);
    assert.equal(discoveryJobs[0].dedupe_key, `media_discover:${otherKey}`);
    const payload = JSON.parse(discoveryJobs[0].payload_json);
    assert.deepEqual(payload, {
      workspaceId: 'workspace-web', sourceId: other.id, sourceRevisionKey: otherKey, originalUrl: other.originalUrl
    });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('WMB-5244 website: transaction rollback leaves neither Source nor candidate partial writes', async () => {
  const { root, database } = await makeDatabase();
  try {
    const pageUrl = 'https://example.com/rollback?wmb_item=august-14-2026-1';
    const body = '# Changelog\n\nAugust 14, 2026\n- Launch announcement published\n\n<img src="/img/a.png">\n\nAugust 13, 2026\n- Prior release notes\n';
    const candidate = await directCandidate(pageUrl);
    const trial = {
      title: 'Changelog', url: pageUrl, requestedUrl: pageUrl, readable: true, itemCount: 2,
      summary: 'Launch rollback fixture', httpStatus: 200, contentType: 'text/html'
    };
    const source = confirmWebsiteSource(database, { inputText: 'Changelog rollback', candidate, trialRead: trial });
    const scanInput = {
      taskId: 'web-rollback-task', workspaceId: 'workspace-web', sourceId: source.id,
      fetchImpl: async () => new Response(html(body), { status: 200, headers: { 'content-type': 'text/html' } })
    };
    database.exec('BEGIN');
    await scanWebsiteSource(database, scanInput);
    database.exec('ROLLBACK');
    // 零 Source、零候选、零 Attempt、零 Job。
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM source_items').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM source_media_candidates').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM media_archive_attempts').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM jobs').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM source_scan_receipts').get().count, 0);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('WMB-5244 website: raw HTML is never persisted as a parallel content truth', async () => {
  const { root, database } = await makeDatabase();
  try {
    const pageUrl = 'https://example.com/raw?wmb_item=august-14-2026-1';
    const body = '# Changelog\n\nAugust 14, 2026\n- Launch announcement published\n\n<img src="/img/marker-xyz.png">\n';
    const candidate = await directCandidate(pageUrl);
    const trial = {
      title: 'Changelog', url: pageUrl, requestedUrl: pageUrl, readable: true, itemCount: 1,
      summary: 'Raw html must not be stored', httpStatus: 200, contentType: 'text/html'
    };
    const source = confirmWebsiteSource(database, { inputText: 'Changelog raw', candidate, trialRead: trial });
    await scanWebsiteSource(database, {
      taskId: 'web-raw-task', workspaceId: 'workspace-web', sourceId: source.id,
      fetchImpl: async () => new Response(html(body), { status: 200, headers: { 'content-type': 'text/html' } })
    });
    // 候选只存 URL，不含页面正文 / 原始 HTML。
    const candidates = database.prepare('SELECT original_url, caption_hint FROM source_media_candidates').all();
    assert.ok(candidates.length >= 1);
    for (const row of candidates) {
      assert.doesNotMatch(row.original_url, /<img|<html|# Changelog|August 14/);
      assert.doesNotMatch(row.caption_hint ?? '', /<img|# Changelog|August 14/);
    }
    // Source evidence 只含结构化 JSON，无原始 HTML。
    const evidence = database.prepare("SELECT evidence FROM source_items WHERE evidence IS NOT NULL").all();
    for (const row of evidence) {
      assert.doesNotMatch(row.evidence, /<img|# Changelog|August 14/);
    }
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('WMB-5244 website: media_discover job enqueue is idempotent per source revision', async () => {
  const { root, database } = await makeDatabase();
  try {
    const seeded = seedSource(database, 'https://example.com/idem/post');
    const source = getSource(database, seeded.id);
    const revisionKey = sourceRevisionKey(source.id, source.revision);
    const payload = {
      workspaceId: 'workspace-web', sourceId: source.id, sourceRevisionKey: revisionKey, originalUrl: 'https://example.com/idem/post'
    };
    enqueueMediaDiscoverJob(database, payload);
    enqueueMediaDiscoverJob(database, payload);
    const jobs = jobsFor(database, 'media_discover', `media_discover:${revisionKey}`);
    assert.equal(jobs.length, 1, 'dedupe_key UNIQUE keeps one discovery job per revision');
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('WMB-5244 website: listing scan attaches zero page-level candidates and only enqueues rediscovery', async () => {
  const { root, database } = await makeDatabase();
  try {
    const pageUrl = 'https://example.com/listings';
    const body = [
      '<img src="/hero.png">',
      '<a href="https://example.com/listings/article-one">Article one announcement</a>',
      '<a href="https://example.com/listings/article-two">Article two announcement</a>'
    ].join('');
    const candidate = await directCandidate(pageUrl);
    const trial = {
      title: 'Listings', url: pageUrl, requestedUrl: pageUrl, readable: true, itemCount: 2,
      summary: 'Listing page with two article links', httpStatus: 200, contentType: 'text/html'
    };
    const source = confirmWebsiteSource(database, { inputText: 'Listings', candidate, trialRead: trial });
    const scanned = await scanWebsiteSource(database, {
      taskId: 'web-listing-task', workspaceId: 'workspace-web', sourceId: source.id,
      fetchImpl: async () => new Response(html(body), { status: 200, headers: { 'content-type': 'text/html' } })
    });
    assert.equal(scanned.receipt.status, 'succeeded');
    assert.equal(scanned.receipt.savedCount, 2);
    // 页面级媒体不复制到任何 item Source（Main 规则：无 dedicated page Source、不重复）。
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM source_media_candidates').get().count, 0);
    const discoveryJobs = jobsFor(database, 'media_discover', 'media_discover:%');
    assert.equal(discoveryJobs.length, 2);
    for (const itemId of scanned.sourceIds) {
      const item = getSource(database, itemId);
      assert.ok(item);
      const key = sourceRevisionKey(item.id, item.revision);
      const job = discoveryJobs.find((row) => row.dedupe_key === `media_discover:${key}`);
      assert.ok(job, `missing discovery job for ${key}`);
      const payload = JSON.parse(job.payload_json);
      assert.equal(payload.originalUrl, item.originalUrl);
    }
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 工具：seed 一个真实 source_items 行（经生产 upsertSource）
// ============================================================================

function seedSource(database, url) {
  return upsertSource(database, {
    originalUrl: url,
    title: 'Seeded website source',
    summary: 'Seeded for website media fixture',
    categories: ['official_web', 'website_item'],
    verificationStatus: 'pending',
    managementStatus: 'active'
  });
}
