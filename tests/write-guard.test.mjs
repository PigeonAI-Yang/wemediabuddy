import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createCommandEnvelope } from '../src/main/command-dispatcher.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';

const WRITE_REQUIRES_DISPATCH = /WMB_WRITE_REQUIRES_COMMAND_DISPATCH/;
const SQLITE_AUTHORIZATION_DENIED = /not authorized|authorization/i;
const owner = { type: 'owner_ui', id: 'renderer', label: 'Owner UI' };

test('active workspace database permits mutations only for the complete command dispatch', async () => {
  await withGuardedRuntime(async ({ runtime, database }) => {
    assert.throws(
      () => database.prepare('INSERT INTO guard_probe(id, value) VALUES(?, ?)').run('direct-insert', 'blocked'),
      WRITE_REQUIRES_DISPATCH
    );
    assert.throws(
      () => database.prepare('UPDATE guard_probe SET value=? WHERE id=?').run('blocked', 'direct-update'),
      WRITE_REQUIRES_DISPATCH
    );
    assert.equal(database.prepare('SELECT value FROM guard_probe WHERE id=?').get('direct-update').value, 'original');
    assert.throws(
      () => database.prepare('DELETE FROM guard_probe WHERE id=?').run('direct-delete'),
      WRITE_REQUIRES_DISPATCH
    );
    assert.equal(database.prepare('SELECT COUNT(*) count FROM guard_probe WHERE id=?').get('direct-delete').count, 1);
    assert.equal(database.prepare('SELECT value FROM guard_probe WHERE id=?').get('direct-update').value, 'original');
    assert.throws(() => database.exec('BEGIN IMMEDIATE'), SQLITE_AUTHORIZATION_DENIED);
    assert.throws(() => database.exec('SAVEPOINT direct_write'), SQLITE_AUTHORIZATION_DENIED);
    assert.throws(
      () => database.exec('CREATE TABLE direct_dynamic_probe (id TEXT PRIMARY KEY)'),
      SQLITE_AUTHORIZATION_DENIED
    );


    let asyncDescendantWrite;
    const successEnvelope = envelope(runtime, 'guard.success', 'guard-success');
    const success = await runtime.dispatchCommand(successEnvelope, () => {
      database.prepare('INSERT INTO guard_probe(id, value) VALUES(?, ?)').run('dispatched-success', 'committed');
      asyncDescendantWrite = new Promise((resolve) => {
        queueMicrotask(() => {
          try {
            database.prepare('INSERT INTO guard_probe(id, value) VALUES(?, ?)').run('async-descendant', 'must-not-land');
            resolve(null);
          } catch (error) {
            resolve(error);
          }
        });
      });
      return {
        data: { id: 'dispatched-success', value: 'committed' },
        entityType: 'guard_probe',
        entityId: 'dispatched-success'
      };
    });

    assert.equal(success.ok, true);
    const dispatchedRow = database.prepare('SELECT id, value FROM guard_probe WHERE id=?').get('dispatched-success');
    assert.equal(dispatchedRow.id, 'dispatched-success');
    assert.equal(dispatchedRow.value, 'committed');
    assert.equal(database.prepare('SELECT status FROM command_receipts WHERE request_id=?').get('guard-success').status, 'ok');
    assert.equal(database.prepare('SELECT result FROM operation_log WHERE command=?').get('guard.success').result, 'ok');
    assert.throws(
      () => database.prepare('UPDATE guard_probe SET value=? WHERE id=?').run('escaped', 'dispatched-success'),
      WRITE_REQUIRES_DISPATCH
    );
    const descendantError = await asyncDescendantWrite;
    assert.match(descendantError.message, WRITE_REQUIRES_DISPATCH);
    assert.equal(database.prepare('SELECT COUNT(*) count FROM guard_probe WHERE id=?').get('async-descendant').count, 0);


    const failureEnvelope = envelope(runtime, 'guard.failure', 'guard-failure');
    const failure = await runtime.dispatchCommand(failureEnvelope, () => {
      database.prepare('INSERT INTO guard_probe(id, value) VALUES(?, ?)').run('dispatched-failure', 'must-roll-back');
      throw new Error('HANDLER_FAILED');
    });

    assert.equal(failure.ok, false);
    assert.equal(failure.error.code, 'HANDLER_FAILED');
    assert.equal(database.prepare('SELECT COUNT(*) count FROM guard_probe WHERE id=?').get('dispatched-failure').count, 0);
    const failureRow = database.prepare('SELECT status, receipt_json FROM command_receipts WHERE request_id=?').get('guard-failure');
    assert.equal(failureRow.status, 'error');
    assert.equal(JSON.parse(failureRow.receipt_json).error.code, 'HANDLER_FAILED');
    assert.equal(database.prepare('SELECT result FROM operation_log WHERE command=?').get('guard.failure').result, 'error');
    assert.throws(
      () => database.prepare('DELETE FROM guard_probe WHERE id=?').run('dispatched-success'),
      WRITE_REQUIRES_DISPATCH
    );
    assert.equal(database.prepare('SELECT COUNT(*) count FROM guard_probe WHERE id=?').get('dispatched-success').count, 1);

    const staleEnvelope = createCommandEnvelope({
      workspaceId: runtime.identity.workspaceId,
      runtimeEpoch: 'other-runtime-epoch',
      command: 'guard.identity-mismatch',
      requestId: 'guard-identity-mismatch',
      input: {},
      boundIdentity: { entityType: 'guard_probe' },
      actor: owner
    });
    await assert.rejects(
      () => runtime.dispatchCommand(staleEnvelope, () => {
        database.prepare('INSERT INTO guard_probe(id, value) VALUES(?, ?)').run('identity-mismatch', 'must-not-land');
        return { data: {}, entityType: 'guard_probe' };
      }),
      { code: 'WORKSPACE_STALE' }
    );
    assert.equal(database.prepare('SELECT COUNT(*) count FROM guard_probe WHERE id=?').get('identity-mismatch').count, 0);
    const dynamicEnvelope = envelope(runtime, 'guard.dynamic-table', 'guard-dynamic-table');
    const dynamic = await runtime.dispatchCommand(dynamicEnvelope, () => {
      database.exec('CREATE TABLE dispatched_dynamic_probe (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
      database.prepare('INSERT INTO dispatched_dynamic_probe(id, value) VALUES(?, ?)').run('created', 'inside-dispatch');
      return { data: { id: 'created' }, entityType: 'dispatched_dynamic_probe', entityId: 'created' };
    });
    assert.equal(dynamic.ok, true);
    assert.equal(database.prepare('SELECT value FROM dispatched_dynamic_probe WHERE id=?').get('created').value, 'inside-dispatch');
    assert.throws(
      () => database.prepare('INSERT INTO dispatched_dynamic_probe(id, value) VALUES(?, ?)').run('direct', 'blocked'),
      WRITE_REQUIRES_DISPATCH
    );


    const migrationVersion = 900_000;
    assert.throws(
      () => database.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)')
        .run(migrationVersion, new Date().toISOString()),
      WRITE_REQUIRES_DISPATCH
    );
    assert.equal(database.prepare('SELECT COUNT(*) count FROM schema_migrations WHERE version=?').get(migrationVersion).count, 0);
  });
});

function envelope(runtime, command, requestId) {
  return createCommandEnvelope({
    workspaceId: runtime.identity.workspaceId,
    runtimeEpoch: runtime.identity.runtimeEpoch,
    command,
    requestId,
    input: {},
    boundIdentity: { entityType: 'guard_probe' },
    actor: owner
  });
}

async function withGuardedRuntime(work) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-write-guard-'));
  let runtime;
  try {
    const database = migrateDatabase(path.join(root, 'wmb.db'));
    const now = new Date().toISOString();
    database.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)")
      .run(`workspace-${randomUUID()}`, now, now);
    database.exec('CREATE TABLE guard_probe (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    database.prepare('INSERT INTO guard_probe(id, value) VALUES(?, ?), (?, ?)')
      .run('direct-update', 'original', 'direct-delete', 'original');
    database.close();

    runtime = ActiveWorkspaceRuntime.open(root, {
      openDatabase: migrateDatabase,
      createEpoch: () => 'guard-runtime'
    });
    await work({ runtime, database: runtime.database });
  } finally {
    await runtime?.stop({ drain: false });
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
