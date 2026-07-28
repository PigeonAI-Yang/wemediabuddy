import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { recordOperation } from '../src/main/operations.ts';

const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-operations-'));
try {
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  recordOperation(database, { actorType: 'mcp', clientLabel: 'Agent A', command: 'sources.upsert_batch', entityType: 'source_item', entityId: 'source-1', beforeRevision: 1, afterRevision: 2, result: 'ok' });
  const entry = database.prepare('SELECT actor_type, client_label, command, entity_id, before_revision, after_revision, result FROM operation_log').get();
  if (entry.actor_type !== 'mcp' || entry.client_label !== 'Agent A' || entry.command !== 'sources.upsert_batch' || entry.entity_id !== 'source-1' || entry.before_revision !== 1 || entry.after_revision !== 2 || entry.result !== 'ok') throw new Error('operation readback mismatch');
  database.close();
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
