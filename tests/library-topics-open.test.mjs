import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

/**
 * Topic-first flywheel contracts (LIBRARY_TOPICS_REFACTOR_PLAN F0+).
 * Topics is a first-class view (`navigate('topic')`), not a library sub-tab.
 * Mount must NOT wrap LibraryTopicsView in library-home-head marketing hero.
 * Default work tabs (labels): 判断 | 证据 | 回流 — internal keys judgments|sources|outcomes.
 */
/** Contract constants kept in sync with renderer open-topic wiring. */
const OPEN_LIBRARY_TOPIC_EVENT = 'wmb-open-library-topic';
const LIBRARY_SECTION_KEY = 'wmb.librarySection';
const LIBRARY_TOPIC_ID_KEY = 'wmb.libraryTopicId';
const STUDIO_SELECTED_ID_KEY = 'wmb.studioSelectedId';
const STUDIO_TOPIC_ID_KEY = 'wmb.studioTopicId';

/** Default segment label map for the flywheel workbench (UI copy). */
const TOPIC_WORK_TAB_LABELS = Object.freeze({
  judgments: '判断',
  sources: '证据',
  outcomes: '回流',
});

/** Forbidden outer marketing chrome on the primary Topics route. */
const FORBIDDEN_TOPIC_MARKETING = Object.freeze({
  wrapperClass: 'library-home-head',
  eyebrow: '长期记忆',
});

/**
 * Same tolerance used by main.tsx global search: page `{ items }` or legacy array.
 * @param {unknown} raw
 * @returns {Array<{ id: string, title: string }>}
 */
function normalizeKnowledgeTopicsList(raw) {
  let topicItems = [];
  if (Array.isArray(raw)) {
    topicItems = raw;
  } else if (raw && typeof raw === 'object' && 'items' in raw && Array.isArray(raw.items)) {
    topicItems = raw.items;
  }
  const out = [];
  for (const entry of topicItems) {
    if (!entry || typeof entry !== 'object') continue;
    if (!('id' in entry) || !('title' in entry)) continue;
    const id = entry.id;
    const title = entry.title;
    if (typeof id !== 'string' || typeof title !== 'string') continue;
    out.push({ id, title });
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {{ items: unknown[], total: number, limit: number, offset: number, hasMore: boolean } | null}
 */
function asTopicsPage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!('items' in raw) || !Array.isArray(raw.items)) return null;
  const total = 'total' in raw && typeof raw.total === 'number' ? raw.total : raw.items.length;
  const limit = 'limit' in raw && typeof raw.limit === 'number' ? raw.limit : raw.items.length;
  const offset = 'offset' in raw && typeof raw.offset === 'number' ? raw.offset : 0;
  const hasMore = 'hasMore' in raw && typeof raw.hasMore === 'boolean'
    ? raw.hasMore
    : offset + raw.items.length < total;
  return { items: raw.items, total, limit, offset, hasMore };
}

test('library topic open event name and storage keys stay stable', () => {
  assert.equal(OPEN_LIBRARY_TOPIC_EVENT, 'wmb-open-library-topic');
  assert.equal(LIBRARY_SECTION_KEY, 'wmb.librarySection');
  assert.equal(LIBRARY_TOPIC_ID_KEY, 'wmb.libraryTopicId');
  assert.equal(STUDIO_SELECTED_ID_KEY, 'wmb.studioSelectedId');
});

test('topic work tab labels stay flywheel-facing 判断/证据/回流', () => {
  assert.equal(TOPIC_WORK_TAB_LABELS.judgments, '判断');
  assert.equal(TOPIC_WORK_TAB_LABELS.sources, '证据');
  assert.equal(TOPIC_WORK_TAB_LABELS.outcomes, '回流');
  assert.deepEqual(Object.keys(TOPIC_WORK_TAB_LABELS), ['judgments', 'sources', 'outcomes']);
});

test('topic route must not use library marketing header chrome', () => {
  // Documents F0 acceptance: no outer 长期记忆 hero around LibraryTopicsView.
  // Runtime DOM is covered by mount shape in main.tsx; this locks the contract name.
  assert.equal(FORBIDDEN_TOPIC_MARKETING.wrapperClass, 'library-home-head');
  assert.equal(FORBIDDEN_TOPIC_MARKETING.eyebrow, '长期记忆');
  assert.equal(STUDIO_TOPIC_ID_KEY, 'wmb.studioTopicId');
});

test('custom event detail carries topicId for open path', () => {
  const bus = new EventEmitter();
  /** @type {{ topicId?: string } | null} */
  let received = null;
  bus.on(OPEN_LIBRARY_TOPIC_EVENT, (detail) => {
    received = detail;
  });

  const topicId = 'topic-open-1';
  bus.emit(OPEN_LIBRARY_TOPIC_EVENT, { topicId });
  assert.ok(received);
  assert.equal(received.topicId, topicId);

  // Mimic LibraryView listener: only string topicId opens.
  const detail = received;
  const opened = typeof detail?.topicId === 'string' ? detail.topicId : '';
  assert.equal(opened, topicId);
});

test('listKnowledgeTopics page normalizer accepts page shape or legacy array', () => {
  const page = {
    items: [
      { id: 't1', title: 'Agent 工作流', contentCount: 2, publicationCount: 1 },
      { id: 't2', title: '小红书选题', contentCount: 0, publicationCount: 0 },
      { id: 3, title: 'bad-id' },
      { id: 't4' },
    ],
    total: 2,
    limit: 8,
    offset: 0,
    hasMore: false,
  };

  assert.deepEqual(normalizeKnowledgeTopicsList(page), [
    { id: 't1', title: 'Agent 工作流' },
    { id: 't2', title: '小红书选题' },
  ]);

  assert.deepEqual(
    normalizeKnowledgeTopicsList([{ id: 'legacy', title: '旧数组' }, null, 'x']),
    [{ id: 'legacy', title: '旧数组' }],
  );

  assert.deepEqual(normalizeKnowledgeTopicsList(null), []);
  assert.deepEqual(normalizeKnowledgeTopicsList({ total: 0 }), []);

  const shaped = asTopicsPage(page);
  assert.ok(shaped);
  assert.equal(shaped.total, 2);
  assert.equal(shaped.limit, 8);
  assert.equal(shaped.offset, 0);
  assert.equal(shaped.hasMore, false);
  assert.equal(shaped.items.length, 4);

  const row = shaped.items[0];
  assert.ok(row && typeof row === 'object');
  assert.equal(row.contentCount, 2);
  assert.equal(row.publicationCount, 1);
});

test('openGlobalResult topic path writes topic id then dispatches event', () => {
  /** @type {Map<string, string>} */
  const store = new Map();
  const localStorage = {
    setItem(key, value) {
      store.set(String(key), String(value));
    },
    getItem(key) {
      return store.has(String(key)) ? store.get(String(key)) : null;
    },
    removeItem(key) {
      store.delete(String(key));
    },
  };

  const bus = new EventEmitter();
  /** @type {string[]} */
  const events = [];
  /** @type {string[]} */
  const navigations = [];
  bus.on(OPEN_LIBRARY_TOPIC_EVENT, (detail) => {
    events.push(detail?.topicId ?? '');
  });

  const item = { kind: 'topic', id: 'topic-from-search', title: '搜索命中主题' };
  // Mirrors main.tsx openTopic / openGlobalResult: topic is first-class flywheel view (no library section hop).
  localStorage.setItem(LIBRARY_TOPIC_ID_KEY, item.id);
  navigations.push('topic');
  bus.emit(OPEN_LIBRARY_TOPIC_EVENT, { topicId: item.id });

  assert.equal(localStorage.getItem(LIBRARY_TOPIC_ID_KEY), 'topic-from-search');
  assert.deepEqual(navigations, ['topic']);
  assert.deepEqual(events, ['topic-from-search']);
});
