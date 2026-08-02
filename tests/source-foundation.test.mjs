import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { reportAgentTaskProgress, startAgentTask } from '../src/main/agent-tasks.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { loadPrimaryReleaseSources, runOfficialWebWire } from '../src/main/intelligence-wire.ts';
import { ensureRegistrySourceFeed } from '../src/main/sources.ts';
import { getWireHealthLedger } from '../src/main/source-wire-health.ts';

test('official wire binds registry feed and health ledger reads checkpoint', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-foundation-'));
  try {
    const references = path.join(directory, 'references');
    await mkdir(references, { recursive: true });
    await writeFile(path.join(references, 'source-index.json'), JSON.stringify({
      version: 1,
      sources: [
        {
          id: 'deepseek-api-docs',
          name: 'DeepSeek API Docs',
          url: 'https://api-docs.deepseek.com/?utm_source=wire',
          trust_level: 'primary',
          roles: ['release'],
          enabled: true,
          collector: 'official-web'
        },
        {
          id: 'broken-release',
          name: 'Broken Release',
          url: 'https://example.com/broken-release',
          trust_level: 'primary',
          roles: ['release'],
          enabled: true,
          collector: 'official-web'
        }
      ]
    }), 'utf8');

    const loaded = loadPrimaryReleaseSources(directory);
    assert.equal(loaded.length, 2);

    const database = migrateDatabase(path.join(directory, 'wmb.db'));
    const feed = ensureRegistrySourceFeed(database, {
      registryId: 'deepseek-api-docs',
      name: 'DeepSeek API Docs',
      url: 'https://api-docs.deepseek.com/'
    });
    assert.equal(feed.created, true);

    const fetchImpl = async (url) => {
      const href = String(url);
      if (href.includes('broken-release')) {
        return new Response('nope', { status: 500, headers: { 'content-type': 'text/plain' } });
      }
      return new Response('<html><head><title>DeepSeek API</title></head><body><p>docs body</p></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' }
      });
    };

    const wire = await runOfficialWebWire({
      database,
      skillRoot: directory,
      checkpoint: {},
      onProgress: () => {},
      fetchImpl
    });
    assert.equal(wire.sourceIds.length, 0);
    assert.equal(wire.checkpoint.sourceHealth['deepseek-api-docs']?.ok, true);
    assert.equal(wire.checkpoint.sourceHealth['broken-release']?.ok, false);

    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM source_items WHERE feed_id=?').get(feed.id).count, 0);

    const started = startAgentTask(database, {
      intent: 'daily_intelligence',
      businessDate: '2026-08-01'
    });
    assert.equal(started.ok, true);
    assert.ok(started.data?.id);
    const progress = reportAgentTaskProgress(database, started.data.id, {
      phase: 'scanning_sources',
      checkpoint: wire.checkpoint,
      message: 'wire done'
    });
    assert.equal(progress.ok, true);

    const ledger = getWireHealthLedger(database, { businessDate: '2026-08-01' });
    assert.equal(ledger.taskId, started.data.id);
    assert.equal(ledger.summary.total, 2);
    assert.equal(ledger.summary.ok, 1);
    assert.equal(ledger.summary.failed, 1);
    assert.ok(ledger.entries.some((entry) => entry.key === 'broken-release' && entry.ok === false));
    assert.ok(ledger.entries.some((entry) => entry.key === 'deepseek-api-docs' && entry.kind === 'registry'));

    database.close();
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
