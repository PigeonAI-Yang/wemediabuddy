// WMB-5331 / WMB-5339 focused gates: AI topic URL, DOM extraction, unrelated-card rejection, canonical dedupe, idempotency, login/challenge/DOM drift, isolated failure receipts.
// Verify via: node --test tests/wmb-5331-zhihu-hot.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { migrations, migrateDatabase } = await import('../src/main/db/migrations.ts');
const { canonicalizeZhihuQuestionUrl, parseZhihuHotHtml, isZhihuHotChallengeHtml, isZhihuHotSigninHtml, ZHIHU_HOT_ERROR_CODES, fingerprintForZhihuObservation, persistZhihuHotScan, listZhihuHotObservations, listZhihuTopicCategoryObservations, zhihuHotReadiness, ZHIHU_HOT_URL, ZHIHU_HOT_SELECTORS, ZHIHU_TOPIC_CATEGORY_MAP, ZHIHU_TOPIC_CATEGORIES } = await import('../src/main/zhihu-hot-channel.ts');
const { canonicalizeUrl } = await import('../src/main/sources.ts');
const { recordSourceScanReceipt, readIntelligenceChannelsSummary } = await import('../src/main/intelligence-channels.ts');
const { configureBrowserProfileRegistryPath, createInstallationBrowserProfile, openBrowserProfileRegistry } = await import('../src/main/browser-config.ts');
const { initializeWorkspaceBrowserBinding, markWorkspaceBrowserBindingVerified } = await import('../src/main/workspace-browser-binding.ts');

function withTempDir(work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmb5331-'));
  try { return work(dir); } finally {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
}
function migrateFresh(dir) {
  const dbPath = path.join(dir, 'wmb.db');
  const db = migrateDatabase(dbPath);
  return { db, dbPath };
}
function seedWorkspace(db) {
  db.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id','ws-test','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)").run();
}

const sampleAiHtml = `
<main role="main">
  <div class="ContentItem AnswerItem">
    <h2 class="ContentItem-title"><a href="https://www.zhihu.com/question/123456789/answer/101?utm_source=test&fbclid=xxx">AI 大模型如何改变内容生产？</a></h2>
    <button class="VoteButton">赞同 520</button>
    <div class="RichContent-inner">关于大模型在内容产业的应用讨论</div>
  </div>
  <div class="ContentItem AnswerItem">
    <h2 class="ContentItem-title"><a href="/question/987654321/answer/111">如何评价 GPT-5 在中文创作中的表现？</a></h2>
    <div class="RichContent-inner">GPT-5 中文能力测评摘要</div>
  </div>
  <div class="ContentItem AnswerItem">
    <h2 class="ContentItem-title"><a href="https://www.zhihu.com/question/123456789">AI 大模型如何改变内容生产？（重复）</a></h2>
  </div>
</main>
`;

const mixedHtmlWithUnrelatedCards = `
<main role="main">
  <div class="ContentItem AnswerItem">
    <h2 class="ContentItem-title"><a href="https://www.zhihu.com/question/111111111">AI 智能体如何落地企业工作流？</a></h2>
    <div class="RichContent-inner">AI Agent 企业落地</div>
  </div>
  <div class="ContentItem AnswerItem">
    <h2 class="ContentItem-title"><a href="/question/222222222">AI 推理强度 medium 与 high 的取舍？</a></h2>
    <div class="RichContent-inner">推理强度讨论</div>
  </div>
  <div class="ContentItem ArticleItem">
    <h2 class="ContentItem-title"><a href="https://www.zhihu.com/question/444444444">非回答型推荐卡</a></h2>
  </div>
</main>
<div class="RecommendCard">
  <a href="https://www.zhihu.com/question/999999999">娱乐八卦：某明星绯闻</a>
</div>
<nav class="SideNav">
  <a href="https://www.zhihu.com/question/333333333">侧边推荐娱乐问题</a>
</nav>
`;

test('canonicalizeZhihuQuestionUrl normalizes only official question URLs', () => {
  assert.equal(canonicalizeZhihuQuestionUrl('https://www.zhihu.com/question/123456789'), 'https://www.zhihu.com/question/123456789');
  assert.equal(canonicalizeZhihuQuestionUrl('https://www.zhihu.com/question/123456789/answer/999?utm_source=xxx#section'), 'https://www.zhihu.com/question/123456789');
  assert.equal(canonicalizeZhihuQuestionUrl('/question/987654321'), 'https://www.zhihu.com/question/987654321');
  assert.equal(canonicalizeZhihuQuestionUrl('https://zhihu.com/question/555?fbclid=abc'), 'https://www.zhihu.com/question/555');
  assert.equal(canonicalizeZhihuQuestionUrl('https://www.zhihu.com/hot'), null);
  assert.equal(canonicalizeZhihuQuestionUrl('https://example.com/question/123'), null);
  assert.equal(canonicalizeZhihuQuestionUrl('https://www.zhihu.com/topic/19551275/hot'), null);
});

test('ZHIHU_HOT_URL is official AI topic page, not generic /hot', () => {
  assert.equal(ZHIHU_HOT_URL, 'https://www.zhihu.com/topic/19551275/hot');
  assert.ok(ZHIHU_HOT_URL.includes('/topic/19551275/hot'), 'must be AI topic 19551275 hot');
  assert.notEqual(ZHIHU_HOT_URL, 'https://www.zhihu.com/hot', 'must no longer be generic hot');
});
test('Zhihu AI topic exposes one fixed mapping for all five categories', () => {
  assert.deepEqual([...ZHIHU_TOPIC_CATEGORIES], ['index', 'intro', 'discussion', 'essence', 'unanswered']);
  assert.deepEqual(Object.fromEntries(ZHIHU_TOPIC_CATEGORIES.map((id) => [id, ZHIHU_TOPIC_CATEGORY_MAP[id].url])), {
    index: 'https://www.zhihu.com/topic/19551275/index',
    intro: 'https://www.zhihu.com/topic/19551275/intro',
    discussion: 'https://www.zhihu.com/topic/19551275/hot',
    essence: 'https://www.zhihu.com/topic/19551275/top-answers',
    unanswered: 'https://www.zhihu.com/topic/19551275/unanswered'
  });
});

test('ZHIHU_HOT_SELECTORS match the live AI topic ContentItem contract', async () => {
  assert.equal(ZHIHU_HOT_SELECTORS.container, 'main[role="main"]');
  assert.equal(ZHIHU_HOT_SELECTORS.item, '.ContentItem.AnswerItem');
  assert.ok(ZHIHU_HOT_SELECTORS.titleLink.includes('ContentItem-title'));
  assert.ok(ZHIHU_HOT_SELECTORS.titleLink.includes('/question/'));
  const driftHtml = `<html><body><main role="main"><div class="empty">no topic items</div></main></body></html>`;
  const items = parseZhihuHotHtml(driftHtml);
  assert.equal(items.length, 0);
  assert.equal(ZHIHU_HOT_ERROR_CODES.DOM_DRIFT, 'ZHIHU_HOT_DOM_DRIFT');
});

test('parseZhihuHotHtml extracts AI-topic AnswerItems and dedupes canonical URL', () => {
  const items = parseZhihuHotHtml(sampleAiHtml);
  assert.equal(items.length, 2, 'duplicate question 123456789 deduped');
  assert.equal(items[0].canonicalUrl, 'https://www.zhihu.com/question/123456789');
  assert.ok(items[0].title.includes('AI 大模型'));
  assert.equal(items[1].canonicalUrl, 'https://www.zhihu.com/question/987654321');
  assert.equal(items[1].questionId, '987654321');
  assert.ok(items[0].heatText?.includes('赞同'));
});

test('parseZhihuHotHtml rejects non-AnswerItem and off-topic-surface cards structurally', () => {
  const items = parseZhihuHotHtml(mixedHtmlWithUnrelatedCards);
  assert.equal(items.length, 2, 'only AI-topic AnswerItem question cards reach persistence');
  const urls = items.map((it) => it.canonicalUrl).sort();
  assert.deepEqual(urls, ['https://www.zhihu.com/question/111111111', 'https://www.zhihu.com/question/222222222'].sort());
  assert.ok(!urls.includes('https://www.zhihu.com/question/444444444'), 'ArticleItem card must be rejected');
  assert.ok(!urls.includes('https://www.zhihu.com/question/999999999'), 'RecommendCard outside main must be rejected');
  assert.ok(!urls.includes('https://www.zhihu.com/question/333333333'), 'SideNav outside main must be rejected');
  assert.ok(parseZhihuHotHtml(sampleAiHtml, ZHIHU_HOT_URL).length > 0);
});

test('challenge and signin detection yield stable codes', () => {
  assert.equal(isZhihuHotChallengeHtml('<div>请输入验证码完成验证</div>'), true);
  assert.equal(isZhihuHotChallengeHtml('<html><body><main>知乎 AI 专题</main><script>const challenge = "请输入验证码";</script></body></html>'), false);
  assert.equal(isZhihuHotSigninHtml('<div data-za-detail-view-path-module="SignInButton">登录</div>', ZHIHU_HOT_URL), true);
  assert.equal(isZhihuHotSigninHtml('<div class="ContentItem AnswerItem"><a href="/question/123">AI 问题</a></div><div>登录</div>', ZHIHU_HOT_URL), false);
});

test('persistZhihuHotScan idempotent: rescanning does not duplicate Source; observations dedupe by fingerprint (AI topic)', () => withTempDir((dir) => {
  const { db } = migrateFresh(dir);
  try {
    seedWorkspace(db);
    const now = new Date().toISOString();
    const businessDate = '2026-08-22';
    const items = parseZhihuHotHtml(sampleAiHtml);
    const r1 = persistZhihuHotScan(db, { taskId: 'task-1', workspaceId: 'ws-test', businessDate, evidenceUrl: ZHIHU_HOT_URL, collectedAt: now }, items);
    assert.equal(r1.sourceIds.length, 2);
    const srcCount1 = (db.prepare('SELECT COUNT(*) AS c FROM source_items').get()).c;
    const obsCount1 = (db.prepare('SELECT COUNT(*) AS c FROM zhihu_hot_observations').get()).c;
    assert.equal(srcCount1, 2);
    assert.equal(obsCount1, 2);
    // Repeat scan same businessDate same fingerprint -> idempotent
    const r2 = persistZhihuHotScan(db, { taskId: 'task-2', workspaceId: 'ws-test', businessDate, evidenceUrl: ZHIHU_HOT_URL, collectedAt: now }, items);
    assert.equal(r2.sourceIds.length, 2);
    const srcCount2 = (db.prepare('SELECT COUNT(*) AS c FROM source_items').get()).c;
    const obsCount2 = (db.prepare('SELECT COUNT(*) AS c FROM zhihu_hot_observations').get()).c;
    assert.equal(srcCount2, 2, 'Source deduped by canonical URL');
    assert.equal(obsCount2, 2, 'observations deduped by source/date/fingerprint');
    // Same source different fingerprint (changed heat) should create new observation same source
    const mutated = items.map((it) => ({ ...it, heatText: (it.heatText ?? '') + ' updated' }));
    const r3 = persistZhihuHotScan(db, { taskId: 'task-3', workspaceId: 'ws-test', businessDate, evidenceUrl: ZHIHU_HOT_URL, collectedAt: now }, mutated);
    const obsCount3 = (db.prepare('SELECT COUNT(*) AS c FROM zhihu_hot_observations').get()).c;
    assert.equal(obsCount3, 4, 'changed fingerprint creates new observation row');
    const srcCount3 = (db.prepare('SELECT COUNT(*) AS c FROM source_items').get()).c;
    assert.equal(srcCount3, 2);
    // Verify source_feeds registry uses AI topic URL
    const feed = db.prepare("SELECT url, registry_id, name FROM source_feeds WHERE registry_id='zhihu_hot'").get();
    assert.equal(feed.url, canonicalizeUrl(ZHIHU_HOT_URL));
    assert.equal(feed.registry_id, 'zhihu_hot');
  } finally { db.close(); }
}));

test('unrelated cards never reach persistence; repeat mixed scan remains idempotent', () => withTempDir((dir) => {
  const { db } = migrateFresh(dir);
  try {
    seedWorkspace(db);
    const now = new Date().toISOString();
    const businessDate = '2026-08-22';
    const aiOnly = parseZhihuHotHtml(sampleAiHtml);
    const mixed = parseZhihuHotHtml(mixedHtmlWithUnrelatedCards);
    // mixed should have been filtered to 2
    assert.equal(mixed.length, 2);
    const r1 = persistZhihuHotScan(db, { taskId: 'task-mix-1', workspaceId: 'ws-test', businessDate, evidenceUrl: ZHIHU_HOT_URL, collectedAt: now }, mixed);
    assert.equal(r1.sourceIds.length, 2);
    const srcCount1 = (db.prepare('SELECT COUNT(*) AS c FROM source_items').get()).c;
    assert.equal(srcCount1, 2);
    // Rescan same mixed -> idempotent
    const r2 = persistZhihuHotScan(db, { taskId: 'task-mix-2', workspaceId: 'ws-test', businessDate, evidenceUrl: ZHIHU_HOT_URL, collectedAt: now }, mixed);
    const srcCount2 = (db.prepare('SELECT COUNT(*) AS c FROM source_items').get()).c;
    const obsCount2 = (db.prepare('SELECT COUNT(*) AS c FROM zhihu_hot_observations').get()).c;
    assert.equal(srcCount2, 2);
    assert.equal(obsCount2, 2);
    // Ensure unrelated URLs never created source_items
    const unrelated = db.prepare("SELECT COUNT(*) AS c FROM source_items WHERE canonical_url='https://www.zhihu.com/question/999999999'").get().c;
    assert.equal(unrelated, 0, 'unrelated RecommendCard must not persist');
  } finally { db.close(); }
}));

test('failure of zhihu_hot does not erase successful unrelated channels (isolated receipts)', () => withTempDir((dir) => {
  const { db } = migrateFresh(dir);
  try {
    db.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id','ws-test','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)").run();
    const now = new Date().toISOString();
    const items = parseZhihuHotHtml(sampleAiHtml);
    persistZhihuHotScan(db, { taskId: 'task-ok', workspaceId: 'ws-test', businessDate: '2026-08-22', evidenceUrl: ZHIHU_HOT_URL, collectedAt: now }, items.slice(0,1));
    const zhihuFeed = db.prepare("SELECT id FROM source_feeds WHERE registry_id='zhihu_hot'").get().id;
    recordSourceScanReceipt(db, { taskId: 'task-fail', workspaceId: 'ws-test', module: 'zhihu_hot', sourceId: 'zhihu_hot', sourceFeedId: zhihuFeed, status: 'failed', errorCode: 'ZHIHU_HOT_DOM_DRIFT', errorMessage: 'drift', candidateCount: 0, savedCount: 0 });
    const obs = db.prepare('SELECT COUNT(*) AS c FROM zhihu_hot_observations').get().c;
    assert.equal(obs, 1);
    persistZhihuHotScan(db, { taskId: 'task-recover', workspaceId: 'ws-test', businessDate: '2026-08-23', evidenceUrl: ZHIHU_HOT_URL, collectedAt: now }, items.slice(0,1));
    const obs2 = db.prepare('SELECT COUNT(*) AS c FROM zhihu_hot_observations').get().c;
    assert.equal(obs2, 2);
    const srcCount = db.prepare('SELECT COUNT(*) AS c FROM source_items').get().c;
    assert.equal(srcCount, 1);
  } finally { db.close(); }
}));

test('intelligence channel summary reflects AI topic URL and name', () => withTempDir((dir) => {
  const { db } = migrateFresh(dir);
  try {
    db.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id','ws-test','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)").run();
    // Trigger feed creation via persist
    const items = parseZhihuHotHtml(sampleAiHtml);
    persistZhihuHotScan(db, { taskId: 't-summary', workspaceId: 'ws-test', businessDate: '2026-08-22', evidenceUrl: ZHIHU_HOT_URL, collectedAt: new Date().toISOString() }, items.slice(0,1));
    const summary = readIntelligenceChannelsSummary(db, false);
    const zh = summary.sources.find((s) => s.module === 'zhihu_hot');
    assert.ok(zh, 'zhihu_hot source exists');
    assert.equal(zh.canonicalUrl, ZHIHU_HOT_URL);
    assert.equal(zh.canonicalUrl, 'https://www.zhihu.com/topic/19551275/hot');
    assert.ok(zh.name.includes('AI'), 'name must reflect AI topic');
  } finally { db.close(); }
}));

test('discovery projection returns latest official AI-topic observation per Source only', () => withTempDir((dir) => {
  const { db } = migrateFresh(dir);
  try {
    seedWorkspace(db);
    const items = parseZhihuHotHtml(sampleAiHtml);
    persistZhihuHotScan(db, { taskId: 'projection-ai-1', workspaceId: 'ws-test', businessDate: '2026-08-22', evidenceUrl: ZHIHU_HOT_URL, collectedAt: '2026-08-22T10:00:00.000Z' }, items);
    persistZhihuHotScan(db, { taskId: 'projection-generic', workspaceId: 'ws-test', businessDate: '2026-08-23', evidenceUrl: 'https://www.zhihu.com/hot', collectedAt: '2026-08-23T10:00:00.000Z' }, [{ ...items[0], title: '不应出现在 AI 专题入口', heatText: 'generic' }]);
    persistZhihuHotScan(db, { taskId: 'projection-ai-2', workspaceId: 'ws-test', businessDate: '2026-08-22', evidenceUrl: ZHIHU_HOT_URL, collectedAt: '2026-08-22T11:00:00.000Z' }, [{ ...items[0], heatText: '赞同 999' }]);
    const result = listZhihuHotObservations(db, 50);
    assert.equal(result.businessDate, '2026-08-22', 'newer generic /hot rows do not move the AI-topic business date');
    assert.equal(result.items.length, 2, 'same Source is deduped to its latest observation');
    assert.equal(result.items[0].heatText, '赞同 999');
    assert.ok(result.items.every((item) => item.title !== '不应出现在 AI 专题入口'));
    assert.equal(result.sourceUrl, ZHIHU_HOT_URL);
  } finally { db.close(); }
}));
test('category projections filter observations by exact evidence URL', () => withTempDir((dir) => {
  const { db } = migrateFresh(dir);
  try {
    seedWorkspace(db);
    const items = parseZhihuHotHtml(sampleAiHtml);
    persistZhihuHotScan(db, { taskId: 'category-discussion', workspaceId: 'ws-test', businessDate: '2026-08-23', evidenceUrl: ZHIHU_TOPIC_CATEGORY_MAP.discussion.url, collectedAt: '2026-08-23T10:00:00.000Z' }, items.slice(0, 1));
    persistZhihuHotScan(db, { taskId: 'category-essence', workspaceId: 'ws-test', businessDate: '2026-08-23', evidenceUrl: ZHIHU_TOPIC_CATEGORY_MAP.essence.url, collectedAt: '2026-08-23T11:00:00.000Z' }, items.slice(1, 2));
    const discussion = listZhihuTopicCategoryObservations(db, 'discussion');
    const essence = listZhihuTopicCategoryObservations(db, 'essence');
    const unanswered = listZhihuTopicCategoryObservations(db, 'unanswered');
    const intro = listZhihuTopicCategoryObservations(db, 'intro');
    assert.equal(discussion.items.length, 1);
    assert.equal(discussion.items[0].title, items[0].title);
    assert.equal(essence.items.length, 1);
    assert.equal(essence.items[0].title, items[1].title);
    assert.equal(unanswered.items.length, 0);
    assert.equal(intro.items.length, 0);
    assert.equal(intro.summary, null, 'summary categories have no persisted cache');
  } finally { db.close(); }
}));
test('Zhihu category collection stays background-only and refresh reuses the scan receipt path', () => {
  const channel = fs.readFileSync(new URL('../src/main/zhihu-hot-channel.ts', import.meta.url), 'utf8');
  const ipc = fs.readFileSync(new URL('../src/main/ipc-intelligence-channels.ts', import.meta.url), 'utf8');
  const preload = fs.readFileSync(new URL('../src/preload/preload.ts', import.meta.url), 'utf8');
  const view = fs.readFileSync(new URL('../src/renderer/zhihu-hot-view.tsx', import.meta.url), 'utf8');
  assert.match(channel, /startBrowser\(profile, \{ mode: 'quiet' \}\)/);
  assert.doesNotMatch(channel, /bringToFront|\.mouse\.|\.keyboard\.|\.click\(|\.type\(/, 'category reads must not activate or interact with the foreground');
  assert.match(ipc, /zhihu-hot:refresh-category/);
  assert.match(ipc, /readZhihuTopicCategoryViaBrowser[\s\S]*dispatchZhihuHotScan/);
  assert.match(ipc, /dispatchZhihuHotFailure/);
  assert.match(preload, /refreshZhihuHotCategory[\s\S]*zhihu-hot:refresh-category/);
  assert.match(view, /正在刷新/);
  assert.match(view, /刷新成功/);
  assert.match(view, /刷新失败，请重试/);
  assert.match(view, /等待回答/);
});

test('verified BrowserProfile reaches live Zhihu even without a stale zhihu account snapshot', () => withTempDir((dir) => {
  const configPath = path.join(dir, 'browser-config.json');
  const registry = openBrowserProfileRegistry(configPath);
  const profile = createInstallationBrowserProfile({ expectedRevision: registry.revision, label: 'Zhihu live truth', configPath }).profile;
  configureBrowserProfileRegistryPath(configPath);
  const { db } = migrateFresh(dir);
  try {
    initializeWorkspaceBrowserBinding(db, profile.id);
    const binding = markWorkspaceBrowserBindingVerified(db, {
      profileId: profile.id,
      expectedBindingRevision: 1,
      account: { platform: 'x', accountKey: 'owner', displayName: 'Owner', loginState: 'authenticated' }
    });
    assert.equal(binding.expectedAccountSnapshot.zhihu, undefined, 'precondition: no persisted Zhihu verification marker');
    assert.deepEqual(zhihuHotReadiness(db), { state: 'ready', code: null, message: null });
  } finally { db.close(); }
}));
