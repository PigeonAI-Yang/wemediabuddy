import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import {
  extractOfficialItems,
  extractReleaseItems,
  loadPrimaryReleaseSources,
  mergeWireCheckpoint,
  runEnabledXListWire,
  runOfficialWebWire
} from '../src/main/intelligence-wire.ts';
import { searchSources } from '../src/main/sources.ts';
import { writeXListTimelineCache } from '../src/main/x-list-timeline-cache.ts';
import { bindXList } from '../src/main/x-lists.ts';

const FIXTURE_INDEX = {
  version: 1,
  sources: [
    {
      id: 'deepseek-api-docs',
      name: 'DeepSeek API Docs',
      url: 'https://api-docs.deepseek.com/',
      kind: 'official_docs',
      domain: ['models', 'api'],
      trust_level: 'primary',
      roles: ['fact', 'release'],
      logo: 'deepseek.svg',
      enabled: true,
      collector: 'official-web'
    },
    {
      id: 'deepseek-github',
      name: 'DeepSeek GitHub',
      url: 'https://github.com/deepseek-ai',
      kind: 'official_repo',
      domain: ['models', 'open_source'],
      trust_level: 'primary',
      roles: ['fact', 'release', 'code'],
      logo: 'deepseek.svg',
      enabled: true,
      collector: 'github'
    },
    {
      id: 'bytedance-seedance',
      name: 'ByteDance Seedance',
      url: 'https://www.volcengine.com/product/seedance',
      kind: 'official_company',
      domain: ['models', 'products'],
      trust_level: 'primary',
      roles: ['fact', 'release'],
      logo: 'x.svg',
      enabled: true,
      collector: 'official-web'
    },
    {
      id: 'openai-news',
      name: 'OpenAI News',
      url: 'https://openai.com/news/',
      kind: 'official_company',
      domain: ['models', 'products'],
      trust_level: 'primary',
      roles: ['fact', 'release'],
      logo: 'openai.ico',
      enabled: true,
      collector: 'official-web'
    },
    {
      id: 'disabled-release',
      name: 'Disabled',
      url: 'https://example.com/disabled',
      trust_level: 'primary',
      roles: ['release'],
      enabled: false,
      collector: 'official-web'
    },
    {
      id: 'signal-only',
      name: 'Signal',
      url: 'https://example.com/signal',
      trust_level: 'signal_only',
      roles: ['release'],
      enabled: true,
      collector: 'official-web'
    }
  ]
};

test('mergeWireCheckpoint unions ids and merges sourceHealth', () => {
  const merged = mergeWireCheckpoint(
    {
      completedRoutes: ['A'],
      completedListIds: ['1'],
      completedSourceIds: ['s1'],
      sourceHealth: {
        s1: { ok: true, at: 't1', saved: 1 }
      }
    },
    {
      completedRoutes: ['A', 'B'],
      completedListIds: ['2'],
      completedSourceIds: ['s2'],
      sourceHealth: {
        s2: { ok: false, at: 't2', error: 'boom', saved: 0 }
      }
    }
  );
  assert.deepEqual(merged.completedRoutes, ['A', 'B']);
  assert.deepEqual(merged.completedListIds, ['1', '2']);
  assert.deepEqual(merged.completedSourceIds, ['s1', 's2']);
  assert.equal(merged.sourceHealth.s1.ok, true);
  assert.equal(merged.sourceHealth.s2.error, 'boom');
});

test('extractReleaseItems keeps article links and drops nav', () => {
  const html = `
    <a href="/about">About</a>
    <a href="/blog/post-1">First Product Launch</a>
    <a href="https://example.com/blog/post-2">Second Model Update</a>
    <a href="https://other.com/blog/x">External</a>
    <a href="/blog/post-1">First Product Launch</a>
  `;
  const items = extractReleaseItems('https://example.com/blog', html, 8);
  assert.equal(items.length, 2);
  assert.equal(items[0]?.url, 'https://example.com/blog/post-1');
  assert.equal(items[1]?.url, 'https://example.com/blog/post-2');
});

test('extractOfficialItems parses markdown changelog dates', () => {
  const md = `
Changelog
July, 2026
Jul 30
Update · Model: gpt-5.6-sol · API: v1/responses
Starting July 30, GPT-5.6 Luna costs 80% less.
Jul 28
Feature · Realtime API improvements for voice agents
`;
  const items = extractOfficialItems('https://developers.openai.com/api/docs/changelog.md', md, 8);
  assert.ok(items.length >= 2);
  assert.match(items[0]?.title || '', /Jul 30/i);
  assert.match(items[0]?.url || '', /wmb_item=/);
  assert.match(items[1]?.title || '', /Jul 28/i);
});

test('loadPrimaryReleaseSources keeps primary release entries including deepseek', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-wire-index-'));
  try {
    const references = path.join(directory, 'references');
    await mkdir(references, { recursive: true });
    await writeFile(path.join(references, 'source-index.json'), JSON.stringify(FIXTURE_INDEX), 'utf8');
    const sources = loadPrimaryReleaseSources(directory);
    const ids = sources.map((source) => source.id);
    assert.ok(ids.includes('deepseek-api-docs'));
    assert.ok(ids.includes('deepseek-github'));
    assert.ok(ids.includes('bytedance-seedance'));
    assert.ok(ids.includes('openai-news'));
    assert.equal(ids.includes('disabled-release'), false);
    assert.equal(ids.includes('signal-only'), false);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('runOfficialWebWire records health and completes both success and failure', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-wire-web-'));
  try {
    const skillRoot = path.join(directory, 'skill');
    const references = path.join(skillRoot, 'references');
    await mkdir(references, { recursive: true });
    await writeFile(path.join(references, 'source-index.json'), JSON.stringify({
      version: 1,
      sources: [
        {
          id: 'ok-source',
          name: 'OK Source',
          url: 'https://example.com/ok',
          trust_level: 'primary',
          roles: ['release'],
          enabled: true,
          collector: 'official-web'
        },
        {
          id: 'fail-source',
          name: 'Fail Source',
          url: 'https://example.com/fail',
          trust_level: 'primary',
          roles: ['release'],
          enabled: true,
          collector: 'official-web'
        }
      ]
    }), 'utf8');

    const database = migrateDatabase(path.join(directory, 'wmb.db'));
    const progress = [];
    const result = await runOfficialWebWire({
      database,
      skillRoot,
      checkpoint: {},
      onProgress: (message, checkpoint) => {
        progress.push({ message, completedSourceIds: [...(checkpoint.completedSourceIds ?? [])] });
      },
      fetchImpl: async (url) => {
        if (String(url).includes('/ok')) {
          return new Response([
            '<html><title>OK Title</title><body>',
            '<a href="/news/launch-one">Launch One Announcement</a>',
            '<a href="/news/launch-two">Launch Two Details</a>',
            '<a href="/about">About</a>',
            '<p>hello official release page body content</p>',
            '</body></html>'
          ].join(''), {
            status: 200,
            headers: { 'content-type': 'text/html' }
          });
        }
        return new Response('nope', { status: 503 });
      }
    });

    assert.deepEqual(result.checkpoint.completedSourceIds?.sort(), ['fail-source', 'ok-source']);
    assert.equal(result.checkpoint.sourceHealth['ok-source']?.ok, true);
    assert.equal(result.checkpoint.sourceHealth['ok-source']?.saved, 2);
    assert.equal(result.checkpoint.sourceHealth['fail-source']?.ok, false);
    assert.equal(result.sourceIds.length, 2);

    const saved = searchSources(database, 'Launch');
    assert.equal(saved.length, 2);
    assert.ok(saved.some((item) => item.title === 'Launch One Announcement'));
    assert.ok(saved.some((item) => item.originalUrl === 'https://example.com/news/launch-one'));
    assert.ok(saved.every((item) => item.categories.includes('release_item')));
    assert.ok(saved.every((item) => item.clientLabel === 'ok-source'));
    assert.ok(progress.some((item) => item.message.includes('OK Source')));
    database.close();
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('runEnabledXListWire prefers AI前沿 and can upsert from timeline cache without browser', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-wire-xlist-'));
  try {
    const database = migrateDatabase(path.join(directory, 'wmb.db'));
    const other = bindXList(database, {
      accountKey: '@KimbomArtist',
      list: {
        listId: '111',
        canonicalUrl: 'https://x.com/i/lists/111',
        ownerHandle: '@KimbomArtist',
        name: 'Other List',
        kind: 'owned'
      },
      observation: {}
    });
    assert.equal(other.ok, true);
    const frontier = bindXList(database, {
      accountKey: '@KimbomArtist',
      list: {
        listId: '2082851520417255750',
        canonicalUrl: 'https://x.com/i/lists/2082851520417255750',
        ownerHandle: '@KimbomArtist',
        name: 'AI前沿',
        kind: 'owned'
      },
      observation: {}
    });
    assert.equal(frontier.ok, true);

    writeXListTimelineCache(database, {
      accountKey: '@KimbomArtist',
      listId: '2082851520417255750',
      posts: [{
        url: 'https://x.com/deepseek_ai/status/1',
        authorHandle: '@deepseek_ai',
        text: 'DeepSeek release note from list cache',
        postedAt: new Date().toISOString()
      }],
      source: 'live',
      detail: { name: 'AI前沿', canonicalUrl: 'https://x.com/i/lists/2082851520417255750' }
    });

    const seen = [];
    const result = await runEnabledXListWire({
      database,
      browserConfig: null,
      checkpoint: {},
      onProgress: (message, checkpoint) => {
        seen.push({ message, completedListIds: [...(checkpoint.completedListIds ?? [])] });
      }
    });

    assert.deepEqual(result.checkpoint.completedListIds, ['2082851520417255750', '111']);
    assert.equal(result.checkpoint.sourceHealth['x-list:2082851520417255750']?.ok, true);
    assert.equal(result.checkpoint.sourceHealth['x-list:2082851520417255750']?.saved, 1);
    assert.equal(result.checkpoint.sourceHealth['x-list:111']?.ok, false);
    assert.equal(result.sourceIds.length, 1);
    const saved = searchSources(database, 'DeepSeek release note');
    assert.equal(saved.length, 1);
    assert.ok(seen[0]?.message.includes('AI前沿'));
    database.close();
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
