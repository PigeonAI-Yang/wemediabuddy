import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { broadcastDataChanged, setDataChangedPublisher } from '../src/main/data-changed.ts';
import { createContentProjectWithVersion, saveCoreVersion } from '../src/main/content.ts';

test('data-changed bus uses one global publisher across repeated imports', async () => {
  const events = [];
  setDataChangedPublisher((event) => { events.push(event); });
  const second = await import('../src/main/data-changed.ts');
  second.broadcastDataChanged({ scopes: ['studio'], reason: 'probe' });
  await delay(80);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].scopes, ['studio']);
  setDataChangedPublisher(null);
});

test('saveCoreVersion broadcasts studio scope for open editor refresh', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-studio-bc-'));
  const events = [];
  setDataChangedPublisher((event) => { events.push(event); });
  try {
    const database = migrateDatabase(path.join(directory, 'wmb.db'));
    const created = createContentProjectWithVersion(database, {
      title: 'Pi draft project',
      body: '初稿正文'
    });
    await delay(80);
    assert.ok(events.some((event) => event.scopes.includes('studio') && event.reason === 'content.create'));

    const saved = saveCoreVersion(database, {
      projectId: created.id,
      body: 'Pi 改过的正文',
      expectedRevision: created.revision,
      author: 'ai'
    });
    assert.equal(saved.ok, true);
    await delay(80);
    assert.ok(events.some((event) => event.scopes.includes('studio') && event.reason === 'content.core_version'));
    database.close();
  } finally {
    setDataChangedPublisher(null);
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
