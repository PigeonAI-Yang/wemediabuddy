import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';
import { extractReadableText, fetchAndCacheSourceBody, getSourceBodyCache } from '../src/main/source-body-cache.ts';

test('extractReadableText prefers article text and strips scripts', () => {
  const html = `<html><head><title>T</title><script>evil()</script></head>
    <body><nav>nav</nav><article><h1>Hello</h1><p>World body content here.</p><p>Second paragraph.</p><ul><li>One</li><li>Two</li></ul></article></body></html>`;
  const text = extractReadableText(html, 'text/html', 500);
  assert.match(text, /Hello/);
  assert.match(text, /World body content here/);
  assert.match(text, /Second paragraph/);
  assert.match(text, /Hello\s*\n+\s*World body content here\.\s*\n+\s*Second paragraph\./);
  assert.match(text, /• One/);
  assert.match(text, /• Two/);
  assert.doesNotMatch(text, /evil/);
  assert.doesNotMatch(text, /nav/);
});

test('fetchAndCacheSourceBody stores ready body and reuses cache', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-body-'));
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  try {
    const saved = upsertSource(database, {
      title: 'Seedance 2.5',
      originalUrl: 'https://example.com/seedance-2-5',
      summary: 'short summary'
    });

    const html = '<html><body><article><h1>Seedance 2.5</h1><p>One-take creation with flexible referencing.</p></article></body></html>';
    const fetchImpl = async () => new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' }
    });

    const first = await fetchAndCacheSourceBody(database, { sourceId: saved.id, fetchImpl });
    assert.equal(first.status, 'ready');
    assert.match(first.extractedText, /One-take creation/);
    assert.ok(first.extractedChars > 10);

    let calls = 0;
    const countingFetch = async () => {
      calls += 1;
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    };
    const second = await fetchAndCacheSourceBody(database, { sourceId: saved.id, fetchImpl: countingFetch });
    assert.equal(second.status, 'ready');
    assert.equal(calls, 0, 'ready cache should short-circuit fetch');

    const loaded = getSourceBodyCache(database, saved.id);
    assert.equal(loaded?.status, 'ready');
    assert.match(loaded?.extractedText || '', /Seedance 2.5/);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('fetchAndCacheSourceBody records failed status on HTTP error', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-body-fail-'));
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  try {
    const saved = upsertSource(database, {
      title: 'Broken',
      originalUrl: 'https://example.com/missing',
      summary: 'x'
    });
    const fetchImpl = async () => new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } });
    const result = await fetchAndCacheSourceBody(database, { sourceId: saved.id, fetchImpl });
    assert.equal(result.status, 'failed');
    assert.match(result.errorMessage || '', /404/);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('fetchAndCacheSourceBody reuses ready body within TTL and failed body within cooldown', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-body-ttl-'));
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  try {
    const saved = upsertSource(database, {
      title: 'TTL',
      originalUrl: 'https://www.example.com/ttl?utm_source=x',
      summary: 'ttl'
    });
    let calls = 0;
    const html = '<html><body><article><p>Stable body text for ttl.</p></article></body></html>';
    const fetchImpl = async (url) => {
      calls += 1;
      assert.match(String(url), /https:\/\/example\.com\/ttl$/);
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    };
    const t0 = new Date('2026-08-01T00:00:00.000Z');
    const first = await fetchAndCacheSourceBody(database, { sourceId: saved.id, fetchImpl, now: t0 });
    assert.equal(first.status, 'ready');
    assert.equal(calls, 1);

    const withinTtl = await fetchAndCacheSourceBody(database, {
      sourceId: saved.id,
      fetchImpl,
      now: new Date('2026-08-01T12:00:00.000Z')
    });
    assert.equal(withinTtl.status, 'ready');
    assert.equal(calls, 1, 'ready TTL should avoid refetch');

    const afterTtl = await fetchAndCacheSourceBody(database, {
      sourceId: saved.id,
      fetchImpl,
      now: new Date('2026-08-02T01:00:00.000Z')
    });
    assert.equal(afterTtl.status, 'ready');
    assert.equal(calls, 2, 'expired ready cache should refetch');

    const failSource = upsertSource(database, {
      title: 'Fail TTL',
      originalUrl: 'https://example.com/fail-ttl',
      summary: 'x'
    });
    let failCalls = 0;
    const failFetch = async () => {
      failCalls += 1;
      return new Response('nope', { status: 503, headers: { 'content-type': 'text/plain' } });
    };
    const failed = await fetchAndCacheSourceBody(database, {
      sourceId: failSource.id,
      fetchImpl: failFetch,
      now: new Date('2026-08-01T00:00:00.000Z')
    });
    assert.equal(failed.status, 'failed');
    assert.equal(failCalls, 1);
    const cooled = await fetchAndCacheSourceBody(database, {
      sourceId: failSource.id,
      fetchImpl: failFetch,
      now: new Date('2026-08-01T00:10:00.000Z')
    });
    assert.equal(cooled.status, 'failed');
    assert.equal(failCalls, 1, 'failed cooldown should avoid refetch');
    const forced = await fetchAndCacheSourceBody(database, {
      sourceId: failSource.id,
      fetchImpl: failFetch,
      force: true,
      now: new Date('2026-08-01T00:10:00.000Z')
    });
    assert.equal(forced.status, 'failed');
    assert.equal(failCalls, 2, 'force bypasses cooldown');
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
