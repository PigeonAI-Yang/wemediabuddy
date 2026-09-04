// WMB-5244：X Lists 时间线媒体候选接线（设计 §7.2 / §6.1–6.4）。
// 覆盖：单图/多图、视频+poster、引用帖媒体、转发帖媒体、媒体顺序与父关系、
// 同事务原子性（回滚零部分写）、重放幂等、指标快照与缓存行为保持。
// 运行：node --test --test-concurrency=1 tests/wmb-5244-x-media-wiring.test.mjs

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { bindXList } = await import('../src/main/x-lists.ts');
const { collectBoundXListTimeline, persistBoundXListTimeline } = await import('../src/main/x-list-execution.ts');
const { xPostMediaSlots } = await import('../src/main/x-media-wiring.ts');
const { xMetricEvidenceMap } = await import('../src/main/platforms/metric-value.ts');
const { readXListTimelineCache } = await import('../src/main/x-list-timeline-cache.ts');
const { listXPostMetricSnapshots } = await import('../src/main/x-post-metrics.ts');
const { stableRemoteIdentity, listMediaCandidatesForRevision } = await import('../src/main/db/media-archive-store.ts');

const BASE_MEDIA = {
  images: [], imageThumbs: [], hasVideo: false, videoPoster: null, videoUrl: null,
  metrics: { replies: 1, reposts: 2, likes: 3, bookmarks: 4, views: 100 }
};

function post(url, overrides = {}) {
  return {
    url,
    authorHandle: '@author',
    displayName: 'Author',
    avatarUrl: null,
    text: overrides.text ?? 'fixture post',
    postedAt: '2026-08-14T00:00:00.000Z',
    ...BASE_MEDIA,
    metricEvidence: xMetricEvidenceMap(
      { replies: '1', reposts: '2', likes: '3', bookmarks: '4', views: '100' },
      'graphql',
      { replies: 'legacy.reply_count', reposts: 'legacy.retweet_count', likes: 'legacy.favorite_count', bookmarks: 'legacy.bookmark_count', views: 'views.count' }
    ),
    ...overrides
  };
}

function makeDatabase(directory, workspaceId = 'ws-x-media') {
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  const now = new Date().toISOString();
  database.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)").run(workspaceId, now, now);
  return database;
}

async function makeRoot() {
  return mkdtemp(path.join(os.tmpdir(), 'wmb-5244-x-'));
}

function bind(database, listId = '998877665544332211') {
  const bound = bindXList(database, {
    accountKey: '@Owner',
    list: { listId, canonicalUrl: `https://x.com/i/lists/${listId}`, ownerHandle: '@Owner', name: 'AI 前沿', kind: 'owned' },
    notify: false
  });
  assert.equal(bound.ok, true);
  return bound.data;
}

function timelineRead(binding, posts, capturedAt = new Date(Date.now() - 60_000).toISOString()) {
  return {
    binding,
    timeline: {
      accountKey: binding.accountKey,
      detail: {
        listId: binding.listId,
        canonicalUrl: binding.canonicalUrl,
        name: binding.name,
        ownerHandle: binding.ownerHandle,
        kind: 'owned',
        description: '',
        isPrivate: false,
        memberCount: 1,
        observation: { capturedAt, pageUrl: binding.canonicalUrl, fingerprint: 'fp', visibleText: 'AI 前沿' }
      },
      posts,
      hasMore: false
    }
  };
}

function collect(database, binding, posts, options = {}) {
  return collectBoundXListTimeline(database, { id: 'fixture-browser', cdpUrl: 'http://127.0.0.1:9999', workspaceId: 'ws-x-media', accountKey: binding.accountKey }, {
    accountKey: binding.accountKey,
    listId: binding.listId,
    expectedBindingId: binding.id,
    expectedRevision: binding.revision,
    observationKey: options.observationKey ?? 'observation-1',
    readTimeline: async () => timelineRead(binding, posts, options.capturedAt).timeline
  });
}

function candidatesOf(database, sourceId, revision) {
  return listMediaCandidatesForRevision(database, `source:${sourceId}:r${revision}`);
}

function jobsFor(database, sourceId, revision) {
  const prefix = `media:source:${sourceId}:r${revision}:`;
  return database.prepare('SELECT id, kind, status, dedupe_key AS dedupeKey, payload_json AS payloadJson FROM jobs WHERE dedupe_key LIKE ? ORDER BY dedupe_key')
    .all(`${prefix}%`) ;
}

// ============================================================================
// 纯映射：槽位确定性
// ============================================================================

test('X slot mapping: single image keeps best URL and thumb as fallback chain', () => {
  const { slots, nextOrdinal } = xPostMediaSlots(post('https://x.com/a/status/1', {
    images: ['https://pbs.twimg.com/media/A.jpg?format=jpg&name=medium'],
    imageThumbs: ['https://pbs.twimg.com/media/A.jpg?format=jpg&name=thumb']
  }), 0);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].kind, 'image');
  assert.equal(slots[0].originalUrl, 'https://pbs.twimg.com/media/A.jpg?format=jpg&name=medium');
  assert.deepEqual(slots[0].alternateUrls, ['https://pbs.twimg.com/media/A.jpg?format=jpg&name=thumb']);
  assert.equal(slots[0].postKind, 'tweet');
  assert.equal(slots[0].postOrdinal, 0);
  assert.equal(slots[0].ordinalInPost, 0);
  assert.equal(slots[0].ordinal, 0);
  assert.equal(slots[0].parentOrdinal, null);
  assert.equal(nextOrdinal, 1);
});

test('X slot mapping: missing medium falls back to thumb; multi-image preserves order', () => {
  const { slots } = xPostMediaSlots(post('https://x.com/a/status/2', {
    images: [],
    imageThumbs: ['https://pbs.twimg.com/media/B.jpg?format=jpg&name=thumb']
  }), 2);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].originalUrl, 'https://pbs.twimg.com/media/B.jpg?format=jpg&name=thumb');
  assert.equal(slots[0].postOrdinal, 2);

  const multi = xPostMediaSlots(post('https://x.com/a/status/3', {
    images: [
      'https://pbs.twimg.com/media/C.jpg?format=jpg&name=medium',
      'https://pbs.twimg.com/media/D.jpg?format=jpg&name=medium',
      'https://pbs.twimg.com/media/E.jpg?format=jpg&name=medium'
    ],
    imageThumbs: []
  }), 0);
  assert.deepEqual(multi.slots.map((slot) => slot.ordinal), [0, 1, 2]);
  assert.deepEqual(multi.slots.map((slot) => slot.ordinalInPost), [0, 1, 2]);
  assert.deepEqual(multi.slots.map((slot) => slot.originalUrl), [
    'https://pbs.twimg.com/media/C.jpg?format=jpg&name=medium',
    'https://pbs.twimg.com/media/D.jpg?format=jpg&name=medium',
    'https://pbs.twimg.com/media/E.jpg?format=jpg&name=medium'
  ]);
  assert.deepEqual(multi.slots.map((slot) => slot.parentOrdinal), [null, null, null]);
});

test('X slot mapping: video shares ordinal with highest-quality poster parented to video', () => {
  const { slots } = xPostMediaSlots(post('https://x.com/a/status/4', {
    hasVideo: true,
    videoPoster: 'https://pbs.twimg.com/ext_tw_video_thumb/123/poster.jpg?format=jpg&name=thumb',
    videoUrl: 'https://video.twimg.com/ext_tw_video/123/pu/vid/avc1/720x1280.mp4?tag=14'
  }), 0);
  assert.equal(slots.length, 2);
  const video = slots[0];
  const poster = slots[1];
  assert.equal(video.kind, 'video');
  assert.equal(video.ordinal, 0);
  assert.equal(video.ordinalInPost, 0);
  assert.equal(poster.kind, 'video_poster');
  assert.equal(poster.ordinal, video.ordinal, 'poster 与视频共享 ordinal');
  assert.equal(poster.ordinalInPost, video.ordinalInPost);
  assert.equal(poster.parentOrdinal, video.ordinal, 'poster parent 指向视频');
  assert.equal(poster.originalUrl, 'https://pbs.twimg.com/ext_tw_video_thumb/123/poster.jpg?format=jpg&name=orig', 'poster 升级为最高质量 orig');
  assert.deepEqual(poster.alternateUrls, ['https://pbs.twimg.com/ext_tw_video_thumb/123/poster.jpg?format=jpg&name=thumb']);
});

test('X slot mapping: quote media appended after own media with quote post kind and group root parent', () => {
  const quoted = {
    url: 'https://x.com/b/status/99',
    authorHandle: '@b',
    displayName: 'B',
    avatarUrl: null,
    text: 'quoted body',
    postedAt: '2026-08-13T00:00:00.000Z',
    images: ['https://pbs.twimg.com/media/Q1.jpg?format=jpg&name=medium', 'https://pbs.twimg.com/media/Q2.jpg?format=jpg&name=medium'],
    imageThumbs: [],
    hasVideo: true,
    videoPoster: 'https://pbs.twimg.com/ext_tw_video_thumb/999/q.jpg?format=jpg&name=thumb',
    videoUrl: 'https://video.twimg.com/ext_tw_video/999/pu/vid/avc1/720x1280.mp4?tag=14',
    metrics: { replies: 0, reposts: 0, likes: 0, bookmarks: 0, views: 0 },
    quotedPost: null
  };
  const { slots } = xPostMediaSlots(post('https://x.com/a/status/5', {
    text: 'my quote',
    postKind: 'quote',
    images: ['https://pbs.twimg.com/media/M.jpg?format=jpg&name=medium'],
    imageThumbs: [],
    quotedPost: quoted
  }), 0);
  // 主帖 1 图 → 引用帖 2 图 + 视频 + poster
  assert.equal(slots.length, 5);
  assert.deepEqual(slots.map((slot) => slot.kind), ['image', 'image', 'image', 'video', 'video_poster']);
  assert.deepEqual(slots.map((slot) => slot.postKind), ['quote', 'quote', 'quote', 'quote', 'quote']);
  assert.deepEqual(slots.map((slot) => slot.ordinalInPost), [0, 1, 2, 3, 3]);
  assert.deepEqual(slots.map((slot) => slot.ordinal), [0, 1, 2, 3, 3]);
  // 主帖媒体 parent null；引用组根（ordinal 1）parent null；组内后续媒体 parent=组根
  assert.deepEqual(slots.map((slot) => slot.parentOrdinal), [null, null, 1, 1, 3]);
  assert.equal(slots[3].originalUrl, quoted.videoUrl);
  assert.equal(slots[4].parentOrdinal, 3, '引用帖 poster 指向引用帖视频');
  assert.equal(slots[4].originalUrl, 'https://pbs.twimg.com/ext_tw_video_thumb/999/q.jpg?format=jpg&name=orig');
  assert.equal(slots[1].surroundingText, 'quoted body');
});

test('X slot mapping: repost media keeps repost kind; text-only post yields no slots', () => {
  const reposted = xPostMediaSlots(post('https://x.com/a/status/6', {
    postKind: 'repost',
    images: ['https://pbs.twimg.com/media/R.jpg?format=jpg&name=medium'],
    imageThumbs: []
  }), 1, 5);
  assert.equal(reposted.slots.length, 1);
  assert.equal(reposted.slots[0].postKind, 'repost');
  assert.equal(reposted.slots[0].ordinal, 5);

  const none = xPostMediaSlots(post('https://x.com/a/status/7', { text: 'plain' }), 0);
  assert.equal(none.slots.length, 0);
  assert.equal(none.nextOrdinal, 0);
});

// ============================================================================
// 端到端：collectBoundXListTimeline 同事务冻结
// ============================================================================

test('WMB-5244: single/multi-image posts freeze candidates with jobs and attempts in Source transaction', async () => {
  const root = await makeRoot();
  let database;
  try {
    database = makeDatabase(root);
    const binding = bind(database);
    const posts = [
      post('https://x.com/a/status/1', {
        images: ['https://pbs.twimg.com/media/A.jpg?format=jpg&name=medium'],
        imageThumbs: ['https://pbs.twimg.com/media/A.jpg?format=jpg&name=thumb']
      }),
      post('https://x.com/a/status/2', {
        images: [
          'https://pbs.twimg.com/media/B1.jpg?format=jpg&name=medium',
          'https://pbs.twimg.com/media/B2.jpg?format=jpg&name=medium',
          'https://pbs.twimg.com/media/B3.jpg?format=jpg&name=medium'
        ],
        imageThumbs: []
      })
    ];
    const result = await collect(database, binding, posts);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.sourceIds.length, 2);
    assert.equal(result.data.candidateCount, 4, '1 图 + 3 图 = 4 媒体候选');

    const first = candidatesOf(database, result.data.sourceIds[0], 1);
    const second = candidatesOf(database, result.data.sourceIds[1], 1);
    assert.equal(first.length, 1);
    assert.equal(first[0].kind, 'image');
    assert.equal(first[0].ordinal, 0);
    assert.equal(first[0].ordinalInPost, 0);
    assert.equal(first[0].postOrdinal, 0);
    assert.equal(first[0].postKind, 'tweet');
    assert.equal(first[0].originalUrl, 'https://pbs.twimg.com/media/A.jpg?format=jpg&name=medium');
    assert.deepEqual(first[0].alternateUrls, ['https://pbs.twimg.com/media/A.jpg?format=jpg&name=thumb'], 'thumb 回退链未丢失');
    assert.equal(first[0].stableRemoteIdentity, stableRemoteIdentity('https://pbs.twimg.com/media/A.jpg?format=jpg&name=medium'));
    assert.equal(first[0].status, 'pending');
    assert.equal(first[0].channel, 'x_lists');
    assert.equal(first[0].requestId, 'observation-1');

    assert.deepEqual(second.map((c) => c.ordinal), [0, 1, 2]);
    assert.deepEqual(second.map((c) => c.originalUrl), [
      'https://pbs.twimg.com/media/B1.jpg?format=jpg&name=medium',
      'https://pbs.twimg.com/media/B2.jpg?format=jpg&name=medium',
      'https://pbs.twimg.com/media/B3.jpg?format=jpg&name=medium'
    ]);
    assert.deepEqual(second.map((c) => c.parentCandidateId), [null, null, null]);

    // 初始 Attempt（attempt=1 running 预建行）+ media_archive job（dedupe/payload 契约）
    for (const candidate of [...first, ...second]) {
      const attemptRow = database.prepare(
        'SELECT candidate_id AS candidateId, attempt, status, started_at AS startedAt FROM media_archive_attempts WHERE candidate_id = ?'
      ).get(candidate.id);
      assert.ok(attemptRow, '初始 Attempt 行存在');
      assert.equal(attemptRow.attempt, 1);
      assert.equal(attemptRow.status, 'running');
      assert.equal(attemptRow.candidateId, candidate.id);
    }
    const firstJob = jobsFor(database, result.data.sourceIds[0], 1);
    assert.equal(firstJob.length, 1);
    assert.equal(firstJob[0].kind, 'media_archive');
    assert.equal(firstJob[0].status, 'pending');
    assert.equal(firstJob[0].dedupeKey, `media:source:${result.data.sourceIds[0]}:r1:${first[0].id}`);
    assert.deepEqual(JSON.parse(firstJob[0].payloadJson), {
      workspaceId: 'ws-x-media', sourceId: result.data.sourceIds[0], sourceRevisionKey: `source:${result.data.sourceIds[0]}:r1`, candidateId: first[0].id
    });
  } finally {
    database?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('WMB-5244: video+poster and quote/repost fixtures freeze deterministic parents with no field loss', async () => {
  const root = await makeRoot();
  let database;
  try {
    database = makeDatabase(root);
    const binding = bind(database);
    const quoted = {
      url: 'https://x.com/b/status/99',
      authorHandle: '@b',
      displayName: 'B',
      avatarUrl: null,
      text: 'quoted with video',
      postedAt: '2026-08-13T00:00:00.000Z',
      images: [],
      imageThumbs: [],
      hasVideo: true,
      videoPoster: 'https://pbs.twimg.com/ext_tw_video_thumb/999/q.jpg?format=jpg&name=thumb',
      videoUrl: 'https://video.twimg.com/ext_tw_video/999/pu/vid/avc1/720x1280.mp4?tag=14',
      metrics: { replies: 0, reposts: 0, likes: 0, bookmarks: 0, views: 0 },
      quotedPost: null
    };
    const posts = [
      post('https://x.com/a/status/1', {
        hasVideo: true,
        videoPoster: 'https://pbs.twimg.com/ext_tw_video_thumb/123/p.jpg?format=jpg&name=thumb',
        videoUrl: 'https://video.twimg.com/ext_tw_video/123/pu/vid/avc1/720x1280.mp4?tag=14'
      }),
      post('https://x.com/a/status/2', {
        postKind: 'repost',
        images: ['https://pbs.twimg.com/media/R.jpg?format=jpg&name=medium'],
        imageThumbs: []
      }),
      post('https://x.com/a/status/3', {
        postKind: 'quote',
        text: 'quoting',
        images: ['https://pbs.twimg.com/media/M.jpg?format=jpg&name=medium'],
        imageThumbs: [],
        quotedPost: quoted
      })
    ];
    const result = await collect(database, binding, posts);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.candidateCount, 2 + 1 + 3, '视频+poster=2、转发图=1、引用帖(1图+视频+poster)=3');

    // 视频 + poster：共享 ordinal，poster parent 指向视频
    const videoSource = candidatesOf(database, result.data.sourceIds[0], 1);
    assert.equal(videoSource.length, 2);
    const video = videoSource.find((c) => c.kind === 'video');
    const poster = videoSource.find((c) => c.kind === 'video_poster');
    assert.ok(video && poster, 'video + video_poster 候选都存在');
    assert.equal(video.ordinal, 0);
    assert.equal(poster.ordinal, video.ordinal);
    assert.equal(poster.parentCandidateId, video.id);
    assert.equal(poster.originalUrl, 'https://pbs.twimg.com/ext_tw_video_thumb/123/p.jpg?format=jpg&name=orig', 'poster 字段未丢失且为最高质量');
    assert.deepEqual(poster.alternateUrls, ['https://pbs.twimg.com/ext_tw_video_thumb/123/p.jpg?format=jpg&name=thumb'], 'poster thumb 回退链保留');
    assert.equal(video.originalUrl, 'https://video.twimg.com/ext_tw_video/123/pu/vid/avc1/720x1280.mp4?tag=14');

    // 转发帖：post_kind='repost' 保留
    const repostCandidates = candidatesOf(database, result.data.sourceIds[1], 1);
    assert.equal(repostCandidates.length, 1);
    assert.equal(repostCandidates[0].postKind, 'repost');
    assert.equal(repostCandidates[0].kind, 'image');

    // 引用帖：post_kind='quote'，引用媒体排在主帖媒体之后，poster parent 指向引用帖视频
    const quoteCandidates = candidatesOf(database, result.data.sourceIds[2], 1);
    assert.equal(quoteCandidates.length, 3);
    assert.deepEqual(quoteCandidates.map((c) => c.postKind), ['quote', 'quote', 'quote']);
    assert.deepEqual(quoteCandidates.map((c) => c.kind), ['image', 'video', 'video_poster']);
    assert.deepEqual(quoteCandidates.map((c) => c.ordinal), [0, 1, 1]);
    assert.equal(quoteCandidates[0].parentCandidateId, null);
    assert.equal(quoteCandidates[1].parentCandidateId, null, '引用帖视频为组根（无图片时）');
    assert.equal(quoteCandidates[2].parentCandidateId, quoteCandidates[1].id, '引用帖 poster 指向引用帖视频');

    const quoteBody = database.prepare('SELECT extracted_text AS extractedText FROM source_body_cache WHERE source_id = ?')
      .get(result.data.sourceIds[2]);
    assert.equal(quoteBody?.extractedText, [
      'quoting',
      '引用内容 · @b\nquoted with video\n引用原帖：https://x.com/b/status/99'
    ].join('\n\n'), '引用帖正文必须与主帖转述一起进入资料正文');
  } finally {
    database?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('WMB-5244: metric snapshots and cache behavior preserved alongside candidate freeze', async () => {
  const root = await makeRoot();
  let database;
  try {
    database = makeDatabase(root);
    const binding = bind(database);
    const capturedAt = new Date(Date.now() - 60_000).toISOString();
    const posts = [
      post('https://x.com/a/status/1', {
        images: ['https://pbs.twimg.com/media/A.jpg?format=jpg&name=medium'],
        imageThumbs: [],
        metricEvidence: xMetricEvidenceMap({ views: '120' }, 'graphql', { views: 'views.count' })
      })
    ];
    const result = await collect(database, binding, posts, { capturedAt });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.snapshotIds.length, 1, '指标快照仍写入');
    assert.equal(listXPostMetricSnapshots(database, result.data.sourceIds[0]).length, 1);
    const cache = readXListTimelineCache(database, binding.accountKey, binding.listId, { touch: false });
    assert.ok(cache, '缓存仍写入');
    assert.equal(cache.payload.posts[0].url, posts[0].url);
    assert.equal(cache.payload.posts[0].images[0], posts[0].images[0], '缓存保留媒体字段');
    assert.equal(result.data.candidateCount, 1);
  } finally {
    database?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('WMB-5244: identical replay reuses the same Source revision and media candidates', async () => {
  const root = await makeRoot();
  let database;
  try {
    database = makeDatabase(root);
    const binding = bind(database);
    const posts = [
      post('https://x.com/a/status/1', {
        images: ['https://pbs.twimg.com/media/A.jpg?format=jpg&name=medium'],
        imageThumbs: []
      })
    ];
    const first = await collect(database, binding, posts, { observationKey: 'observation-1' });
    assert.equal(first.ok, true);
    const second = await collect(database, binding, posts, { observationKey: 'observation-2' });
    assert.equal(second.ok, true);
    assert.equal(second.data.sourceIds[0], first.data.sourceIds[0], '同一 URL 复用同一 Source');
    const r1 = candidatesOf(database, first.data.sourceIds[0], 1);
    const r2 = candidatesOf(database, first.data.sourceIds[0], 2);
    assert.equal(r1.length, 1, '原 revision 候选保持不变');
    assert.equal(r2.length, 0, '相同正文与媒体不制造新 revision');
    assert.equal(r1[0].id, 'smc:source:' + first.data.sourceIds[0] + ':r1:0:image');
    assert.equal(jobsFor(database, first.data.sourceIds[0], 1).length, 1);
    assert.equal(jobsFor(database, first.data.sourceIds[0], 2).length, 0);
  } finally {
    database?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('WMB-5244: transaction rollback leaves neither Source nor candidate partial writes', async () => {
  const root = await makeRoot();
  let database;
  try {
    database = makeDatabase(root);
    const binding = bind(database);
    const posts = [
      post('https://x.com/a/status/1', {
        images: ['https://pbs.twimg.com/media/A.jpg?format=jpg&name=medium'],
        imageThumbs: []
      })
    ];

    // 显式回滚：BEGIN → persist → ROLLBACK ⇒ Source/Candidate/Attempt/Job 全部零行
    database.exec('BEGIN IMMEDIATE');
    const persisted = persistBoundXListTimeline(database, { id: 'fixture-browser', cdpUrl: 'http://127.0.0.1:9999', workspaceId: 'ws-x-media' }, {
      accountKey: binding.accountKey,
      listId: binding.listId,
      expectedBindingId: binding.id,
      expectedRevision: binding.revision,
      observationKey: 'rollback-1'
    }, timelineRead(binding, posts));
    assert.equal(persisted.ok, true, JSON.stringify(persisted));
    database.exec('ROLLBACK');
    assert.equal(database.prepare('SELECT COUNT(*) AS c FROM source_items').get().c, 0, '回滚后无 Source');
    assert.equal(database.prepare('SELECT COUNT(*) AS c FROM source_media_candidates').get().c, 0, '回滚后无候选');
    assert.equal(database.prepare('SELECT COUNT(*) AS c FROM media_archive_attempts').get().c, 0, '回滚后无 Attempt');
    assert.equal(database.prepare("SELECT COUNT(*) AS c FROM jobs WHERE kind='media_archive'").get().c, 0, '回滚后无 media_archive Job');

    // 失败路径：候选插入被触发器中止 ⇒ collectBoundXListTimeline 失败且零部分写
    database.exec(`CREATE TRIGGER reject_media_candidate BEFORE INSERT ON source_media_candidates BEGIN SELECT RAISE(ABORT, 'reject candidate'); END`);
    const failed = await collect(database, binding, posts, { observationKey: 'rollback-2' });
    assert.equal(failed.ok, false);
    assert.equal(failed.error.code, 'VALIDATION_ERROR');
    assert.equal(database.prepare('SELECT COUNT(*) AS c FROM source_items').get().c, 0, 'Source 与候选同事务回滚');
    assert.equal(database.prepare('SELECT COUNT(*) AS c FROM source_media_candidates').get().c, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS c FROM media_archive_attempts').get().c, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS c FROM jobs WHERE kind='media_archive'").get().c, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS c FROM x_post_metric_snapshots').get().c, 0, '指标快照也未部分写入');
    database.exec('DROP TRIGGER reject_media_candidate');
  } finally {
    database?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('WMB-5244: text-only timeline freezes zero candidates and keeps source save path intact', async () => {
  const root = await makeRoot();
  let database;
  try {
    database = makeDatabase(root);
    const binding = bind(database);
    const posts = [post('https://x.com/a/status/1', { text: 'no media here' })];
    const result = await collect(database, binding, posts);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.sourceIds.length, 1);
    assert.equal(result.data.candidateCount, 0);
    assert.equal(candidatesOf(database, result.data.sourceIds[0], 1).length, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS c FROM jobs WHERE kind='media_archive'").get().c, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS c FROM source_items').get().c, 1, '文字 Source 正常保存');
  } finally {
    database?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
