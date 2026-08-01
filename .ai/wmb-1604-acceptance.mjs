// WMB-1604 / EVAL-016 minimal real acceptance.
// Uses only the product browser path (Pyaireader CDP 9334). One reversible owned-list member batch + bind/collect.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { readXListIndex, readXListMembers, readXListTimeline } from '../src/main/platforms/x-list-browser.ts';
import { armXListOperation, bindXList, getXListOperation, prepareXListOperation } from '../src/main/x-lists.ts';
import { captureXListOperationSnapshot, collectBoundXListTimeline, confirmAndRunXListOperation } from '../src/main/x-list-execution.ts';

const config = { id: 'edge:pyaireader-default', cdpUrl: 'http://127.0.0.1:9334' };
const knownListName = '赚钱信息差博主';
const testHandle = '@OpenAI';
const receiptPath = path.join(process.cwd(), '.ai', 'wmb-1604-acceptance.json');
mkdirSync(path.dirname(receiptPath), { recursive: true });

const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-1604-'));
const database = migrateDatabase(path.join(directory, 'wmb.db'));
const receipt = {
  startedAt: new Date().toISOString(),
  accountKey: null,
  list: null,
  membersBefore: [],
  memberBatch: null,
  binding: null,
  collected: null,
  finishedAt: null
};

try {
  const index = await readXListIndex(config);
  assert.match(index.accountKey, /^@[A-Za-z0-9_]{1,15}$/);
  assert.ok(index.lists.length > 0, 'index returned zero lists');
  const list = index.lists.find((item) => item.name === knownListName) ?? index.lists.find((item) => item.kind === 'owned');
  assert.ok(list, `known owned list not found: ${knownListName}`);
  receipt.accountKey = index.accountKey;
  receipt.list = list;

  const before = await readXListMembers(config, list.listId);
  receipt.membersBefore = before.members;
  assert.ok(before.members.length > 0, 'owned list members empty');

  const addPrepared = prepareXListOperation(database, {
    requestId: `wmb-1604-add-${Date.now()}`,
    accountKey: index.accountKey,
    kind: 'members_add',
    listId: list.listId,
    handles: [testHandle]
  });
  assert.equal(addPrepared.ok, true);
  const addSnapshot = await captureXListOperationSnapshot(config, addPrepared.data.operation);
  const addArmed = armXListOperation(database, {
    operationId: addPrepared.data.operation.id,
    expectedRevision: addPrepared.data.operation.revision,
    snapshot: addSnapshot
  });
  assert.equal(addArmed.ok, true, addArmed.ok ? '' : JSON.stringify(addArmed.error));
  assert.equal(addArmed.data.state, 'awaiting_confirmation');
  const addConfirmed = await confirmAndRunXListOperation(database, config, {
    operationId: addArmed.data.id,
    expectedRevision: addArmed.data.revision
  });
  assert.equal(addConfirmed.ok, true, addConfirmed.ok ? '' : JSON.stringify(addConfirmed.error));
  assert.ok(['succeeded', 'partial'].includes(addConfirmed.data.state), `unexpected add state ${addConfirmed.data.state}`);

  const afterAdd = await readXListMembers(config, list.listId);
  const presentAfterAdd = afterAdd.members.some((member) => member.handle.toLowerCase() === testHandle.toLowerCase());
  assert.equal(presentAfterAdd, true, `${testHandle} not present after add batch`);

  const removePrepared = prepareXListOperation(database, {
    requestId: `wmb-1604-remove-${Date.now()}`,
    accountKey: index.accountKey,
    kind: 'members_remove',
    listId: list.listId,
    handles: [testHandle]
  });
  assert.equal(removePrepared.ok, true);
  const removeSnapshot = await captureXListOperationSnapshot(config, removePrepared.data.operation);
  const removeArmed = armXListOperation(database, {
    operationId: removePrepared.data.operation.id,
    expectedRevision: removePrepared.data.operation.revision,
    snapshot: removeSnapshot
  });
  assert.equal(removeArmed.ok, true, removeArmed.ok ? '' : JSON.stringify(removeArmed.error));
  const removeConfirmed = await confirmAndRunXListOperation(database, config, {
    operationId: removeArmed.data.id,
    expectedRevision: removeArmed.data.revision
  });
  assert.equal(removeConfirmed.ok, true, removeConfirmed.ok ? '' : JSON.stringify(removeConfirmed.error));
  assert.ok(['succeeded', 'partial'].includes(removeConfirmed.data.state), `unexpected remove state ${removeConfirmed.data.state}`);

  const afterRemove = await readXListMembers(config, list.listId);
  const presentAfterRemove = afterRemove.members.some((member) => member.handle.toLowerCase() === testHandle.toLowerCase());
  assert.equal(presentAfterRemove, false, `${testHandle} still present after remove batch`);
  receipt.memberBatch = {
    handle: testHandle,
    addOperationId: addConfirmed.data.id,
    addState: addConfirmed.data.state,
    addItems: addConfirmed.data.items,
    removeOperationId: removeConfirmed.data.id,
    removeState: removeConfirmed.data.state,
    removeItems: removeConfirmed.data.items,
    membersAfterRemove: afterRemove.members.length
  };

  const binding = bindXList(database, {
    accountKey: index.accountKey,
    list: {
      listId: list.listId,
      canonicalUrl: list.canonicalUrl,
      ownerHandle: list.ownerHandle ?? index.accountKey,
      name: list.name,
      kind: list.kind === 'unknown' ? 'owned' : list.kind
    },
    observation: { index: index.observation, detail: afterRemove.detail.observation }
  });
  assert.equal(binding.ok, true);
  assert.equal(binding.data.enabled, true);
  const collected = await collectBoundXListTimeline(database, config, {
    accountKey: binding.data.accountKey,
    listId: binding.data.listId,
    limit: 5
  });
  assert.equal(collected.ok, true, collected.ok ? '' : JSON.stringify(collected.error));
  assert.ok(collected.data.sourceIds.length > 0, 'bound timeline wrote zero source items');
  const sourceCount = database.prepare('SELECT COUNT(*) AS count FROM source_items').get().count;
  assert.equal(sourceCount, collected.data.sourceIds.length);
  receipt.binding = binding.data;
  receipt.collected = { sourceIds: collected.data.sourceIds, sourceCount };
  receipt.operations = [getXListOperation(database, addConfirmed.data.id), getXListOperation(database, removeConfirmed.data.id)];
  receipt.timelineProbe = await readXListTimeline(config, list.listId, 3);
  receipt.finishedAt = new Date().toISOString();
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({
    ok: true,
    accountKey: receipt.accountKey,
    list: { listId: list.listId, name: list.name },
    memberBatch: {
      handle: testHandle,
      addState: addConfirmed.data.state,
      removeState: removeConfirmed.data.state
    },
    collectedSources: collected.data.sourceIds.length,
    receiptPath
  }, null, 2));
} catch (error) {
  receipt.finishedAt = new Date().toISOString();
  receipt.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  throw error;
} finally {
  database.close();
}
