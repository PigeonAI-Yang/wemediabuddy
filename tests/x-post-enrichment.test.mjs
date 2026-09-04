import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { migrateDatabase } from '../src/main/db/migrations.ts';
import { bindXList } from '../src/main/x-lists.ts';
import { collectBoundXListTimeline } from '../src/main/x-list-execution.ts';
import { getSourceBodyCache } from '../src/main/source-body-cache.ts';
import { composeXListSourceBody } from '../src/main/x-list-source-content.ts';
import { xPostMediaSlots } from '../src/main/x-media-wiring.ts';
import {
  classifyXPostReplies,
  findXArticleUrls,
  limitXPostReplies
} from '../src/main/x-post-enrichment.ts';
import { extractStructuredXArticle, extractTweetDetailArticles, extractTweetDetailPosts } from '../src/main/platforms/x-detail-structured.ts';
import { xMetricEvidenceMap } from '../src/main/platforms/metric-value.ts';
import { readXListTimelineCache, X_LIST_TIMELINE_CACHE_SCHEMA_VERSION } from '../src/main/x-list-timeline-cache.ts';
import { X_LIST_POST_CACHE_SCHEMA_VERSION, clearXListPostCache, readXListPostCache, writeXListPostCache } from '../src/main/x-list-post-cache.ts';
import { listMediaCandidatesForRevision } from '../src/main/db/media-archive-store.ts';

const EMPTY_METRICS = { replies: 0, reposts: 0, likes: 0, bookmarks: 0, views: 0 };

function post(id, overrides = {}) {
  const handle = overrides.authorHandle ?? '@author';
  return {
    url: `https://x.com/${handle.replace(/^@/, '')}/status/${id}`,
    statusId: String(id),
    parentStatusId: null,
    conversationId: String(id),
    authorHandle: handle,
    displayName: overrides.displayName ?? 'Author',
    avatarUrl: null,
    text: overrides.text ?? `post ${id}`,
    postedAt: overrides.postedAt ?? `2026-09-04T00:00:${String(id).padStart(2, '0')}.000Z`,
    images: [],
    imageThumbs: [],
    hasVideo: false,
    videoPoster: null,
    videoUrl: null,
    postKind: 'tweet',
    repostedBy: null,
    quotedPost: null,
    metrics: EMPTY_METRICS,
    ...overrides
  };
}

function reply(id, parentStatusId, authorHandle, text) {
  return post(id, {
    authorHandle,
    text,
    parentStatusId: String(parentStatusId),
    conversationId: '1'
  });
}

function article(overrides = {}) {
  return {
    id: '900',
    canonicalUrl: 'https://x.com/i/article/900',
    title: 'Article title',
    authorHandle: '@author',
    displayName: 'Author',
    publishedAt: '2026-09-04T01:00:00.000Z',
    status: 'ready',
    source: 'graphql',
    capturedAt: '2026-09-04T02:00:00.000Z',
    errorMessage: null,
    blocks: [
      { kind: 'paragraph', text: 'First paragraph.' },
      { kind: 'heading', text: 'Section', level: 2 },
      { kind: 'list_item', text: 'First item' },
      { kind: 'quote', text: 'Quoted line' },
      { kind: 'image', url: 'https://pbs.twimg.com/media/article-a.jpg', alt: 'Chart' },
      { kind: 'paragraph', text: 'Last paragraph.' }
    ],
    ...overrides
  };
}

const CAPTURE = {
  status: 'ready',
  replyLimit: 30,
  hasMoreReplies: false,
  fetchedAt: '2026-09-04T02:00:00.000Z',
  source: 'graphql',
  errorMessage: null
};

test('plain and quoted posts keep the established source-body hierarchy', () => {
  const root = post(1, { text: 'Main body' });
  assert.equal(composeXListSourceBody(root), 'Main body');

  const quoted = post(2, { authorHandle: '@quoted', text: 'Quoted body' });
  const body = composeXListSourceBody({ ...root, quotedPost: quoted, postKind: 'quote' });
  assert.match(body, /^Main body\n\n引用内容 · @quoted\nQuoted body/);
  assert.match(body, /引用原帖：https:\/\/x\.com\/quoted\/status\/2/);
});

test('author thread classification follows parent ancestry, orders the chain, deduplicates root, and isolates comments', () => {
  const root = post(1, { text: 'Root', metrics: { ...EMPTY_METRICS, replies: 5 } });
  const result = classifyXPostReplies(root, [
    reply(3, 2, '@author', 'Thread 2'),
    reply(1, 1, '@author', 'Duplicate root'),
    reply(5, 4, '@author', 'Author reply to somebody else'),
    reply(2, 1, '@author', 'Thread 1'),
    reply(4, 1, '@other', 'External comment'),
    reply(3, 2, '@author', 'Duplicate thread 2'),
    reply(6, 3, '@author', 'Thread 3')
  ], CAPTURE);

  assert.deepEqual(result.authorThread.map((item) => item.text), ['Thread 1', 'Thread 2', 'Thread 3']);
  assert.deepEqual(result.authorThread.map((item) => item.conversationOrdinal), [0, 1, 2]);
  assert.deepEqual(result.comments.map((item) => item.text), ['External comment', 'Author reply to somebody else']);
  assert.equal(result.replies.some((item) => item.statusId === '1'), false);
});

test('reply limits distinguish a bounded partial capture from a complete reply set', () => {
  const replies = [reply(2, 1, '@author', 'one'), reply(3, 2, '@author', 'two'), reply(4, 3, '@author', 'three')];
  assert.deepEqual(limitXPostReplies(replies, 2, 3), { replies: replies.slice(0, 2), hasMoreReplies: true });
  assert.deepEqual(limitXPostReplies(replies, 4, 3), { replies, hasMoreReplies: false });
  assert.deepEqual(limitXPostReplies(replies, 0, 3), { replies: [], hasMoreReplies: true });
  assert.deepEqual(limitXPostReplies(replies.slice(0, 1), 30, 57), { replies: replies.slice(0, 1), hasMoreReplies: true });
});

test('direct and t.co-expanded X Article links resolve to one canonical URL', () => {
  assert.deepEqual(findXArticleUrls('Read https://x.com/i/article/900.'), ['https://x.com/i/article/900']);
  assert.deepEqual(findXArticleUrls('Read https://t.co/abc', [{
    url: 'https://t.co/abc', expandedUrl: 'https://twitter.com/i/article/900', displayUrl: 'x.com/i/article/900', source: 'graphql'
  }]), ['https://x.com/i/article/900']);
});

test('structured TweetDetail parsing retains reply ancestry and link entities', () => {
  const payload = {
    data: { thread: [
      { rest_id: '1', core: { user_results: { result: { core: { screen_name: 'author', name: 'Author' } } } }, legacy: { full_text: 'Root', conversation_id_str: '1', entities: { urls: [] } } },
      { rest_id: '2', core: { user_results: { result: { core: { screen_name: 'author', name: 'Author' } } } }, legacy: { full_text: 'Continuation', conversation_id_str: '1', in_reply_to_status_id_str: '1', entities: { urls: [{ url: 'https://t.co/a', expanded_url: 'https://x.com/i/article/900', display_url: 'x.com/i/article/900' }] } } }
    ] }
  };
  const parsed = extractTweetDetailPosts(payload);
  const continuation = parsed.find((item) => item.statusId === '2');
  assert.equal(continuation?.parentStatusId, '1');
  assert.equal(continuation?.conversationId, '1');
  assert.equal(continuation?.links?.[0]?.expandedUrl, 'https://x.com/i/article/900');
});

test('structured X Article extraction preserves headings, lists, quotes, paragraphs, and image order', () => {
  const payload = {
    article_results: { result: {
      rest_id: '900', title: 'Article title',
      author: { screen_name: 'author', name: 'Author' },
      content_state: { blocks: [
        { type: 'unstyled', text: 'First paragraph.' },
        { type: 'header-two', text: 'Section' },
        { type: 'unordered-list-item', text: 'First item' },
        { type: 'blockquote', text: 'Quoted line' },
        { type: 'atomic', text: '', data: { media: { original_img_url: 'https://pbs.twimg.com/media/article-a.jpg' } } },
        { type: 'unstyled', text: 'Last paragraph.' }
      ] }
    } }
  };
  const parsed = extractStructuredXArticle(payload, 'https://x.com/i/article/900', '2026-09-04T02:00:00.000Z');
  assert.equal(parsed?.title, 'Article title');
  assert.equal(parsed?.status, 'ready');
  assert.deepEqual(parsed?.blocks.map((block) => block.kind), ['paragraph', 'heading', 'list_item', 'quote', 'image', 'paragraph']);
  assert.equal(parsed?.blocks[4]?.url, 'https://pbs.twimg.com/media/article-a.jpg');
});

test('native Article attached to a status response keeps its Article id, author, and rich blocks', () => {
  const payload = { data: { tweetResult: { result: {
    rest_id: '2086538297384550491',
    core: { user_results: { result: { core: { screen_name: 'MarioNawfal', name: 'Mario Nawfal' } } } },
    legacy: { full_text: '[Image]', conversation_id_str: '2086538297384550491', entities: { urls: [] } },
    article: { article_results: { result: {
      rest_id: '2086531291550257152',
      metadata: { first_published_at_secs: 1786304470 },
      title: 'EXCLUSIVE: Article title',
      content_state: { blocks: [
        { type: 'header-two', text: 'A Different Perspective' },
        { type: 'unstyled', text: 'Full Article paragraph.' }
      ] }
    } } }
  } } } };

  const parsed = extractTweetDetailArticles(payload, '2026-09-04T02:00:00.000Z');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.statusId, '2086538297384550491');
  assert.equal(parsed[0]?.article.id, '2086531291550257152');
  assert.equal(parsed[0]?.article.canonicalUrl, 'https://x.com/i/article/2086531291550257152');
  assert.equal(parsed[0]?.article.authorHandle, '@MarioNawfal');
  assert.equal(parsed[0]?.article.publishedAt, '2026-08-09T19:41:10.000Z');
  assert.deepEqual(parsed[0]?.article.blocks.map((block) => block.kind), ['heading', 'paragraph']);
});

test('combined body is stable: main, quote, author threads, then Article; comments never enter text', () => {
  const root = post(1, {
    text: 'Main body',
    quotedPost: post(20, {
      authorHandle: '@quoted', text: 'Quoted body',
      authorThread: [reply(21, 20, '@quoted', 'Quoted continuation')]
    }),
    authorThread: [reply(2, 1, '@author', 'Main continuation')],
    comments: [reply(8, 1, '@other', 'Do not include this comment')],
    articles: [article()]
  });
  const body = composeXListSourceBody(root);
  const labels = ['Main body', '引用内容 · @quoted', '作者 Thread · @author', '引用作者 Thread · @quoted', 'X Article · Article title'];
  assert.deepEqual(labels.map((label) => body.indexOf(label)), [...labels.map((label) => body.indexOf(label))].sort((a, b) => a - b));
  assert.doesNotMatch(body, /Do not include this comment/);
  assert.match(body, /First paragraph\.\n\n## Section\n\n- First item\n\n> Quoted line\n\nLast paragraph\./);
});

test('thread and Article images reuse the existing media slot pipeline in source order', () => {
  const root = post(1, {
    images: ['https://pbs.twimg.com/media/root.jpg'],
    authorThread: [reply(2, 1, '@author', 'Continuation with image')],
    articles: [article()]
  });
  root.authorThread[0].images = ['https://pbs.twimg.com/media/thread.jpg'];
  const { slots } = xPostMediaSlots(root, 0);
  assert.deepEqual(slots.map((slot) => slot.originalUrl), [
    'https://pbs.twimg.com/media/root.jpg',
    'https://pbs.twimg.com/media/thread.jpg',
    'https://pbs.twimg.com/media/article-a.jpg'
  ]);
  assert.deepEqual(slots.map((slot) => slot.captionHint), [null, '作者 Thread', 'X Article · Article title']);
});

test('timeline persistence stores structured comments, body excludes them, and repeated capture is idempotent', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-x-enrichment-'));
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  try {
    const now = '2026-09-04T03:00:00.000Z';
    database.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)").run('ws-x-enrichment', now, now);
    const bindingResult = bindXList(database, {
      accountKey: '@Owner',
      list: { listId: '9001', canonicalUrl: 'https://x.com/i/lists/9001', ownerHandle: '@Owner', name: 'AI', kind: 'owned' },
      notify: false
    });
    assert.equal(bindingResult.ok, true);
    const binding = bindingResult.data;
    const root = post(1, {
      text: '[图片]',
      metrics: { ...EMPTY_METRICS, replies: 2 },
      metricEvidence: xMetricEvidenceMap({ replies: '2', reposts: '0', likes: '0', bookmarks: '0', views: '0' }, 'graphql'),
      links: [{ url: 'https://x.com/i/article/900', expandedUrl: 'https://x.com/i/article/900', displayUrl: 'x.com/i/article/900', source: 'graphql' }]
    });
    const detail = {
      ...root,
      authorThread: [reply(2, 1, '@author', 'Main continuation')],
      comments: [reply(3, 1, '@other', 'External comment')],
      replies: [reply(2, 1, '@author', 'Main continuation'), reply(3, 1, '@other', 'External comment')],
      articles: [article()],
      hasMoreReplies: false,
      replyCapture: CAPTURE
    };
    const input = {
      accountKey: binding.accountKey,
      listId: binding.listId,
      expectedBindingId: binding.id,
      expectedRevision: binding.revision,
      observationKey: 'same-observation',
      readTimeline: async () => ({
        accountKey: binding.accountKey,
        detail: { ...binding, description: '', isPrivate: false, memberCount: 1, observation: { capturedAt: now, pageUrl: binding.canonicalUrl, fingerprint: 'fp', visibleText: 'AI' } },
        posts: [root], hasMore: false
      }),
      readPostDetail: async () => ({ accountKey: binding.accountKey, post: detail })
    };

    const first = await collectBoundXListTimeline(database, { id: 'browser', cdpUrl: 'http://127.0.0.1:1', workspaceId: 'ws-x-enrichment', accountKey: binding.accountKey }, input);
    const second = await collectBoundXListTimeline(database, { id: 'browser', cdpUrl: 'http://127.0.0.1:1', workspaceId: 'ws-x-enrichment', accountKey: binding.accountKey }, input);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepEqual(first.data.contentCapture, { status: 'ready', attempted: 1, succeeded: 1, failed: 0 });

    const source = database.prepare('SELECT id, revision, title, summary FROM source_items WHERE original_url=?').get(root.url);
    const body = getSourceBodyCache(database, source.id)?.extractedText ?? '';
    assert.match(body, /Main continuation/);
    assert.match(body, /X Article · Article title/);
    assert.doesNotMatch(body, /External comment/);
    assert.equal(source.title, 'Article title');
    assert.equal(source.summary, 'First paragraph.');
    assert.equal(source.revision, 1);
    assert.equal(listMediaCandidatesForRevision(database, `source:${source.id}:r${source.revision}`).length, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM source_body_capture_jobs WHERE source_id=?').get(source.id).count, 1);

    const cached = readXListTimelineCache(database, binding.accountKey, binding.listId);
    assert.equal(cached?.schemaVersion, X_LIST_TIMELINE_CACHE_SCHEMA_VERSION);
    assert.equal(cached?.payload.posts[0]?.comments?.[0]?.text, 'External comment');
    assert.equal(cached?.payload.posts[0]?.authorThread?.[0]?.text, 'Main continuation');
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('Article/detail failure remains partial while the main and quoted post still persist', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-x-partial-'));
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  try {
    const now = '2026-09-04T04:00:00.000Z';
    database.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)").run('ws-x-partial', now, now);
    const bound = bindXList(database, { accountKey: '@Owner', list: { listId: '9002', canonicalUrl: 'https://x.com/i/lists/9002', ownerHandle: '@Owner', name: 'AI', kind: 'owned' }, notify: false });
    const root = post(10, {
      text: 'Main survives',
      quotedPost: post(11, { authorHandle: '@quoted', text: 'Quote survives' }),
      metrics: { ...EMPTY_METRICS, replies: 1 },
      metricEvidence: xMetricEvidenceMap({ replies: '1', reposts: '0', likes: '0', bookmarks: '0', views: '0' }, 'graphql')
    });
    const result = await collectBoundXListTimeline(database, { id: 'browser', workspaceId: 'ws-x-partial', accountKey: bound.data.accountKey }, {
      accountKey: bound.data.accountKey,
      listId: bound.data.listId,
      expectedBindingId: bound.data.id,
      expectedRevision: bound.data.revision,
      readTimeline: async () => ({ accountKey: bound.data.accountKey, detail: { ...bound.data, description: '', isPrivate: false, memberCount: 1, observation: { capturedAt: now, pageUrl: bound.data.canonicalUrl, fingerprint: 'fp', visibleText: 'AI' } }, posts: [root], hasMore: false }),
      readPostDetail: async () => { throw new Error('rate limited'); }
    });
    assert.equal(result.ok, true);
    assert.equal(result.data.contentCapture.status, 'partial');
    const source = database.prepare('SELECT id FROM source_items WHERE original_url=?').get(root.url);
    const body = getSourceBodyCache(database, source.id)?.extractedText ?? '';
    assert.match(body, /Main survives/);
    assert.match(body, /Quote survives/);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('cache versions are explicit and legacy timeline schema v2 upgrades deterministically on read', async () => {
  assert.equal(X_LIST_POST_CACHE_SCHEMA_VERSION, 2);
  const root = post(1, { authorThread: [], comments: [], replies: [], hasMoreReplies: false, replyCapture: CAPTURE });
  writeXListPostCache({ workspaceId: 'ws', browserId: 'browser', accountKey: '@owner' }, root.url, { accountKey: '@owner', post: root });
  assert.equal(readXListPostCache({ workspaceId: 'ws', browserId: 'browser', accountKey: '@owner' }, root.url)?.post.replyCapture.status, 'ready');
  clearXListPostCache();

  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-x-cache-v2-'));
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  try {
    const now = new Date().toISOString();
    database.prepare(`INSERT INTO x_list_timeline_cache(
      account_key,list_id,payload_json,posts_count,payload_bytes,fetched_at,last_accessed_at,source,schema_version,fingerprint
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run('@owner', 'legacy', JSON.stringify({ accountKey: '@owner', listId: 'legacy', posts: [post(1)] }), 1, 100, now, now, 'live', 2, 'legacy-fp');
    const cached = readXListTimelineCache(database, '@owner', 'legacy');
    assert.equal(cached?.schemaVersion, X_LIST_TIMELINE_CACHE_SCHEMA_VERSION);
    assert.deepEqual(cached?.payload.posts[0]?.authorThread, []);
    assert.deepEqual(cached?.payload.posts[0]?.comments, []);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
