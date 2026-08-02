import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import {
  getWebsiteSource,
  removeWebsiteSource,
  setWebsiteSourceEnabled
} from '../src/main/intelligence-channels.ts';
import { createSourceFeed, getSource } from '../src/main/sources.ts';
import {
  confirmWebsiteSource,
  resolveWebsiteCandidates,
  scanWebsiteSource,
  trialReadWebsite
} from '../src/main/website-channel.ts';

async function makeRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-website-channel-'));
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO app_meta (key, value, created_at, updated_at, revision)
    VALUES ('workspace_id', 'workspace-web', ?, ?, 1)`).run(now, now);
  return { root, database };
}

function html(title, body) {
  return `<html><head><title>${title}</title></head><body>${body}</body></html>`;
}

async function directCandidate(url) {
  const [candidate] = await resolveWebsiteCandidates({ inputText: url });
  assert.ok(candidate);
  return candidate;
}

test('website resolver handles URL, bare domain, real Bing candidates, dedupe, and search failure', async () => {
  const direct = await resolveWebsiteCandidates({ inputText: 'https://WWW.Example.com/updates/?utm_source=test' });
  assert.deepEqual(direct, [{
    inputText: 'https://WWW.Example.com/updates/?utm_source=test',
    name: 'www.example.com', url: 'https://www.example.com/updates/', canonicalUrl: 'https://example.com/updates', origin: 'direct'
  }]);
  const bare = await resolveWebsiteCandidates({ inputText: 'gov.uk/visas-immigration' });
  assert.equal(bare[0]?.canonicalUrl, 'https://gov.uk/visas-immigration');

  for (const inputText of ['localhost', 'api.localhost', '127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1', '169.254.1.1', '[::1]', '[fd00::1]', '[fe80::1]']) {
    await assert.rejects(resolveWebsiteCandidates({ inputText }), /WEBSITE_URL_NOT_PUBLIC/);
  }

  const candidates = await resolveWebsiteCandidates({
    inputText: 'GOV.UK visas immigration official',
    fetchImpl: async () => new Response([
      '<li class="b_algo"><h2><a href="https://www.bing.com/search?q=gov">Bing navigation</a></h2></li>',
      '<li class="b_algo"><h2><a href="https://go.microsoft.com/fwlink/?search=gov">Microsoft search navigation</a></h2></li>',
      '<li class="b_algo"><h2><a href="http://127.0.0.1/private">Private result</a></h2></li>',
      '<li class="b_algo"><h2><a href="https://www.gov.uk/visas-immigration?utm_source=bing">Visas and immigration - GOV.UK</a></h2></li>',
      '<li class="b_algo"><h2><a href="https://gov.uk/visas-immigration">Duplicate GOV.UK result</a></h2></li>',
      '<li class="b_algo"><h2><a href="https://www.gov.uk/browse/visas-immigration">Browse visas - GOV.UK</a></h2></li>'
    ].join(''), { status: 200, headers: { 'content-type': 'text/html' } })
  });
  assert.deepEqual(candidates.map(({ url, canonicalUrl, origin }) => ({ url, canonicalUrl, origin })), [
    { url: 'https://www.gov.uk/visas-immigration', canonicalUrl: 'https://gov.uk/visas-immigration', origin: 'bing_search' },
    { url: 'https://www.gov.uk/browse/visas-immigration', canonicalUrl: 'https://gov.uk/browse/visas-immigration', origin: 'bing_search' }
  ]);
  await assert.rejects(
    resolveWebsiteCandidates({ inputText: 'unavailable site', fetchImpl: async () => new Response('down', { status: 503 }) }),
    /SOURCE_SEARCH_FAILED/
  );
  await assert.rejects(
    resolveWebsiteCandidates({
      inputText: 'private result only',
      fetchImpl: async () => new Response('<li class="b_algo"><h2><a href="http://127.0.0.1/private">Private</a></h2></li>', {
        status: 200, headers: { 'content-type': 'text/html' }
      })
    }),
    /WEBSITE_URL_NOT_PUBLIC/
  );
});

test('trial read returns real page facts and marks inaccessible pages accurately', async () => {
  const readable = await trialReadWebsite({
    url: 'https://www.example.com/news/?utm_source=fixture',
    fetchImpl: async () => new Response(html('Example News', [
      '<h1>Example News</h1><p>A readable official page with enough body text for trial confirmation.</p>',
      '<a href="/news/launch">Launch announcement</a>'
    ].join('')), { status: 200, headers: { 'content-type': 'text/html' } })
  });
  assert.equal(readable.readable, true);
  assert.equal(readable.url, 'https://example.com/news');
  assert.equal(readable.requestedUrl, 'https://www.example.com/news/');
  assert.equal(readable.title, 'Example News');
  assert.equal(readable.itemCount, 1);
  assert.match(readable.summary || '', /readable official page/);

  const blocked = await trialReadWebsite({
    url: 'https://blocked.example/',
    fetchImpl: async () => new Response('sign in', { status: 403, headers: { 'content-type': 'text/plain' } })
  });
  assert.equal(blocked.readable, false);
  assert.equal(blocked.errorCode, 'WEBSITE_NEEDS_USER');
  assert.match(blocked.errorMessage || '', /HTTP 403/);

  const redirectedPrivate = await trialReadWebsite({
    url: 'https://public.example/updates',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      url: 'http://127.0.0.1/private',
      headers: new Headers({ 'content-type': 'text/html' }),
      text: async () => html('Private redirect', '<p>This body must not become a readable public website.</p>')
    })
  });
  assert.equal(redirectedPrivate.readable, false);
  assert.equal(redirectedPrivate.errorCode, 'WEBSITE_URL_NOT_PUBLIC');
});

test('a public redirect keeps the selected request identity and confirms the final canonical entry', async () => {
  const { root, database } = await makeRoot();
  try {
    const candidate = await directCandidate('https://www.example.com/updates');
    const trial = await trialReadWebsite({
      url: candidate.url,
      fetchImpl: async () => ({
        ok: true, status: 200, url: 'https://example.com/news', headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => html('Redirected news', '<p>The selected public page redirects to this readable official news entry.</p>')
      })
    });
    assert.equal(trial.requestedUrl, 'https://www.example.com/updates');
    assert.equal(trial.url, 'https://example.com/news');
    const source = confirmWebsiteSource(database, { inputText: candidate.inputText, candidate, trialRead: trial });
    assert.equal(source.canonicalUrl, 'https://example.com/news');
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('website confirmation manages canonical sources and remove keeps historical feed/items', async () => {
  const { root, database } = await makeRoot();
  try {
    const emptyCandidate = await directCandidate('https://example.com/empty');
    const emptyTrial = await trialReadWebsite({
      url: emptyCandidate.url,
      fetchImpl: async () => new Response(html('Empty updates', '<p>This official page has no new article links today.</p>'), {
        status: 200, headers: { 'content-type': 'text/html' }
      })
    });
    const empty = confirmWebsiteSource(database, { inputText: 'Example empty updates', candidate: emptyCandidate, trialRead: emptyTrial });
    assert.equal(empty.enabled, true);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM source_feeds').get().count, 1);
    const otherCandidate = await directCandidate('https://example.com/other');
    assert.throws(
      () => confirmWebsiteSource(database, { inputText: 'Wrong candidate', candidate: otherCandidate, trialRead: emptyTrial }),
      /WEBSITE_CANDIDATE_MISMATCH/
    );
    assert.throws(
      () => confirmWebsiteSource(database, { inputText: 'Duplicate', candidate: emptyCandidate, trialRead: emptyTrial }),
      /WEBSITE_SOURCE_EXISTS/
    );
    const disabled = setWebsiteSourceEnabled(database, { id: empty.id, enabled: false, expectedRevision: empty.revision });
    assert.equal(disabled.enabled, false);
    const reenabled = setWebsiteSourceEnabled(database, { id: empty.id, enabled: true, expectedRevision: disabled.revision });
    assert.equal(reenabled.enabled, true);

    const zero = await scanWebsiteSource(database, {
      taskId: 'zero-item-task', workspaceId: 'workspace-web', sourceId: reenabled.id,
      fetchImpl: async () => new Response(html('Empty updates', '<p>This official page has no new article links today.</p>'), {
        status: 200, headers: { 'content-type': 'text/html' }
      })
    });
    assert.equal(zero.receipt.status, 'succeeded');
    assert.equal(zero.receipt.candidateCount, 0);
    assert.equal(zero.receipt.savedCount, 0);
    assert.deepEqual(zero.sourceIds, []);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM source_items').get().count, 0);

    const articleCandidate = await directCandidate('https://example.org/news');
    const articlePage = html('Example Releases', [
      '<h1>Example Releases</h1><p>The current release notes and official updates are listed here.</p>',
      '<a href="/news/launch-one">Launch One Announcement</a>'
    ].join(''));
    const articleTrial = await trialReadWebsite({
      url: articleCandidate.url,
      fetchImpl: async () => new Response(articlePage, { status: 200, headers: { 'content-type': 'text/html' } })
    });
    const article = confirmWebsiteSource(database, { inputText: 'Example release notes', candidate: articleCandidate, trialRead: articleTrial });
    const scanned = await scanWebsiteSource(database, {
      taskId: 'article-task', workspaceId: 'workspace-web', sourceId: article.id,
      fetchImpl: async () => new Response(articlePage, { status: 200, headers: { 'content-type': 'text/html' } })
    });
    assert.equal(scanned.receipt.status, 'succeeded');
    assert.equal(scanned.receipt.candidateCount, 1);
    assert.equal(scanned.receipt.savedCount, 1);
    const saved = getSource(database, scanned.sourceIds[0]);
    assert.equal(saved?.feedId, article.sourceFeedId);
    assert.equal(saved?.originalUrl, 'https://example.org/news/launch-one');
    assert.equal(saved?.clientLabel, article.id);

    const feedCount = database.prepare('SELECT COUNT(*) AS count FROM source_feeds WHERE id=?').get(article.sourceFeedId).count;
    const removed = removeWebsiteSource(database, { id: scanned.source.id, expectedRevision: scanned.source.revision });
    assert.deepEqual(removed, { id: article.id, deleted: true });
    assert.equal(getWebsiteSource(database, article.id), null);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM source_feeds WHERE id=?').get(article.sourceFeedId).count, feedCount);
    assert.equal(getSource(database, scanned.sourceIds[0])?.feedId, article.sourceFeedId);

    const reusedCandidate = await directCandidate('https://reuse.example/updates');
    const reusedTrial = await trialReadWebsite({
      url: reusedCandidate.url,
      fetchImpl: async () => new Response(html('Reused feed', '<p>This site has a uniquely reusable existing source feed.</p>'), {
        status: 200, headers: { 'content-type': 'text/html' }
      })
    });
    const uniqueFeed = createSourceFeed(database, { name: 'Existing unique feed', url: reusedCandidate.canonicalUrl });
    const reused = confirmWebsiteSource(database, { inputText: 'Reuse one feed', candidate: reusedCandidate, trialRead: reusedTrial });
    assert.equal(reused.sourceFeedId, uniqueFeed.id);

    const ambiguousCandidate = await directCandidate('https://ambiguous.example/updates');
    const ambiguousTrial = await trialReadWebsite({
      url: ambiguousCandidate.url,
      fetchImpl: async () => new Response(html('Ambiguous feed', '<p>This site has multiple matching legacy source feeds.</p>'), {
        status: 200, headers: { 'content-type': 'text/html' }
      })
    });
    const firstFeed = createSourceFeed(database, { name: 'First matching feed', url: ambiguousCandidate.canonicalUrl });
    const secondFeed = createSourceFeed(database, { name: 'Second matching feed', url: ambiguousCandidate.canonicalUrl });
    assert.throws(
      () => confirmWebsiteSource(database, { inputText: 'Ambiguous feed', candidate: ambiguousCandidate, trialRead: ambiguousTrial }),
      /SOURCE_FEED_MATCH_REQUIRED/
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM website_sources WHERE canonical_url=?').get(ambiguousCandidate.canonicalUrl).count, 0);
    const explicit = confirmWebsiteSource(database, {
      inputText: 'Explicit matching feed', candidate: ambiguousCandidate, trialRead: ambiguousTrial, sourceFeedId: firstFeed.id
    });
    assert.equal(explicit.sourceFeedId, firstFeed.id);
    assert.notEqual(explicit.sourceFeedId, secondFeed.id);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('partial website scan reports exactly the items that were committed before a write failure', async () => {
  const { root, database } = await makeRoot();
  try {
    const candidate = await directCandidate('https://partial.example/news');
    const page = html('Partial releases', [
      '<p>Two candidate releases are present for this public source.</p>',
      '<a href="/news/first">First launch announcement</a>',
      '<a href="/news/second">Second launch announcement</a>'
    ].join(''));
    const trial = await trialReadWebsite({
      url: candidate.url,
      fetchImpl: async () => new Response(page, { status: 200, headers: { 'content-type': 'text/html' } })
    });
    const source = confirmWebsiteSource(database, { inputText: 'Partial releases', candidate, trialRead: trial });
    database.exec(`CREATE TRIGGER reject_second_website_item BEFORE INSERT ON source_items
      WHEN NEW.canonical_url = 'https://partial.example/news/second'
      BEGIN SELECT RAISE(ABORT, 'second item rejected'); END;`);
    const result = await scanWebsiteSource(database, {
      taskId: 'partial-task', workspaceId: 'workspace-web', sourceId: source.id,
      fetchImpl: async () => new Response(page, { status: 200, headers: { 'content-type': 'text/html' } })
    });
    assert.equal(result.receipt.status, 'failed');
    assert.equal(result.receipt.candidateCount, 2);
    assert.equal(result.receipt.savedCount, 1);
    assert.equal(result.sourceIds.length, result.receipt.savedCount);
    assert.equal(getSource(database, result.sourceIds[0])?.originalUrl, 'https://partial.example/news/first');
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('scan failure records status while wrong workspace or source identity writes nothing', async () => {
  const { root, database } = await makeRoot();
  try {
    const candidate = await directCandidate('https://blocked.example/updates');
    const trial = await trialReadWebsite({
      url: candidate.url,
      fetchImpl: async () => new Response(html('Blocked updates', '<p>Initial successful read to confirm this source.</p>'), {
        status: 200, headers: { 'content-type': 'text/html' }
      })
    });
    const source = confirmWebsiteSource(database, { inputText: 'Blocked updates', candidate, trialRead: trial });
    const blocked = await scanWebsiteSource(database, {
      taskId: 'blocked-task', workspaceId: 'workspace-web', sourceId: source.id,
      fetchImpl: async () => new Response('login required', { status: 403, headers: { 'content-type': 'text/plain' } })
    });
    assert.equal(blocked.receipt.status, 'needs_user');
    assert.equal(blocked.receipt.errorCode, 'WEBSITE_NEEDS_USER');
    assert.equal(blocked.source.resolutionStatus, 'needs_user');

    const receiptCount = database.prepare('SELECT COUNT(*) AS count FROM source_scan_receipts').get().count;
    const sourceCount = database.prepare('SELECT COUNT(*) AS count FROM source_items').get().count;
    await assert.rejects(
      scanWebsiteSource(database, {
        taskId: 'wrong-workspace', workspaceId: 'workspace-other', sourceId: source.id,
        fetchImpl: async () => { throw new Error('fetch must not run'); }
      }),
      /WORKSPACE_ID_MISMATCH/
    );
    await assert.rejects(
      scanWebsiteSource(database, {
        taskId: 'missing-source', workspaceId: 'workspace-web', sourceId: 'not-a-source',
        fetchImpl: async () => { throw new Error('fetch must not run'); }
      }),
      /WEBSITE_SOURCE_NOT_FOUND/
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM source_scan_receipts').get().count, receiptCount);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM source_items').get().count, sourceCount);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
