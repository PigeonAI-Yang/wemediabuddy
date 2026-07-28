import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDataRoot, validateDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';

test('data root creates, reopens, and rejects an incomplete root', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'wmb-'));
  try {
    const root = path.join(parent, 'data');
    assert.equal((await openDataRoot(root)).isNew, true);
    for (const entry of ['wmb.db', 'assets', 'browser-profile', 'logs', 'exports']) await stat(path.join(root, entry));
    assert.equal((await validateDataRoot(root)).path, path.resolve(root));
    assert.equal((await openDataRoot(root)).isNew, false);
    const incomplete = path.join(parent, 'incomplete');
    await mkdir(path.join(incomplete, 'assets'), { recursive: true });
    await assert.rejects(openDataRoot(incomplete), /不完整/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('the complete data root can move and reopen without losing data', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'wmb-move-'));
  try {
    const originalPath = path.join(parent, 'before');
    const movedPath = path.join(parent, 'after');
    const root = await openDataRoot(originalPath);
    const database = migrateDatabase(path.join(root.path, 'wmb.db'));
    const source = upsertSource(database, { title: '移动后仍存在', summary: 'EVAL-013' });
    database.close();
    await Promise.all(['assets', 'browser-profile', 'logs', 'exports'].map((directory) =>
      writeFile(path.join(root.path, directory, 'receipt.txt'), directory)));

    await rename(originalPath, movedPath);
    const reopened = await validateDataRoot(movedPath);
    const reopenedDatabase = migrateDatabase(path.join(reopened.path, 'wmb.db'));
    const stored = reopenedDatabase.prepare('SELECT title FROM source_items WHERE id = ?').get(source.id);
    reopenedDatabase.close();

    assert.equal(stored.title, '移动后仍存在');
    for (const directory of ['assets', 'browser-profile', 'logs', 'exports']) {
      assert.equal(await readFile(path.join(movedPath, directory, 'receipt.txt'), 'utf8'), directory);
    }
    await assert.rejects(stat(originalPath), { code: 'ENOENT' });
  } finally {
    await rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
