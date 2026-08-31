import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { CommandDispatcher, createCommandEnvelope } from '../src/main/command-dispatcher.ts';
import { approvedPlanItemChainPreStateHash } from '../src/main/approved-plan-chain-repair.ts';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (key.startsWith('--') && value && !value.startsWith('--')) { args.set(key, value); index += 1; }
}
const required = ['--data-root', '--reference-backup', '--reference-sha256', '--plan-item-id', '--project-id', '--content-version-id', '--receipt-id'];
for (const key of required) if (!String(args.get(key) ?? '').trim()) throw new Error(`missing ${key}`);

const dataRoot = path.resolve(args.get('--data-root'));
const databasePath = path.join(dataRoot, 'wmb.db');
const referencePath = path.resolve(args.get('--reference-backup'));
const referenceSha256 = args.get('--reference-sha256').toUpperCase();
if (!/^[A-F0-9]{64}$/.test(referenceSha256)) throw new Error('--reference-sha256 must be a SHA-256 hex digest');
const ids = {
  planItemId: args.get('--plan-item-id'),
  projectId: args.get('--project-id'),
  contentVersionId: args.get('--content-version-id'),
  receiptId: args.get('--receipt-id')
};

async function verifiedBackup() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  const output = `${databasePath}.approved-chain-rollback-backup-${stamp}-${process.pid}.db`;
  const source = new DatabaseSync(databasePath, { readOnly: true });
  try { await backup(source, output); } finally { source.close(); }
  const copy = new DatabaseSync(output, { readOnly: true });
  try {
    if (Object.values(copy.prepare('PRAGMA quick_check').get())[0] !== 'ok') throw new Error('rollback backup quick_check failed');
  } finally { copy.close(); }
  return { path: output, sha256: createHash('sha256').update(readFileSync(output)).digest('hex').toUpperCase() };
}

function readSnapshot(database) {
  const planItem = database.prepare('SELECT * FROM plan_items WHERE id=?').get(ids.planItemId);
  const project = database.prepare('SELECT * FROM content_projects WHERE id=? AND plan_item_id=?').get(ids.projectId, ids.planItemId);
  const versions = database.prepare('SELECT id, version_number AS versionNumber, created_at AS createdAt FROM content_versions WHERE project_id=? ORDER BY version_number').all(ids.projectId);
  const carry = database.prepare("SELECT * FROM work_carry_items WHERE object_type='plan_item' AND object_id=?").all(ids.planItemId);
  const projectSources = database.prepare('SELECT source_id AS sourceId FROM content_project_sources WHERE project_id=? ORDER BY source_id').all(ids.projectId).map((row) => row.sourceId);
  return { planItem, project, versions, carry, projectSources };
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function collectJsonReferences(database, contentVersionId) {
  const references = [];
  const excludedTables = new Set(['command_receipts', 'mcp_request_results']);
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
  const referenceKey = /(?:content[_-]?version|source[_-]?version|target[_-]?version|predecessor[_-]?version)[_-]?id$/i;
  const walk = (value, key, path) => {
    if (typeof value === 'string') {
      if (key && referenceKey.test(key) && value === contentVersionId) references.push({ path });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, key, `${path}[${index}]`));
      return;
    }
    if (value && typeof value === 'object') {
      Object.entries(value).forEach(([entryKey, entry]) => walk(entry, entryKey, `${path}.${entryKey}`));
    }
  };
  for (const table of tables) {
    if (excludedTables.has(table)) continue;
    const jsonColumns = database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all()
      .map((column) => column.name).filter((name) => /json$/i.test(name));
    for (const column of jsonColumns) {
      const rows = database.prepare(`SELECT rowid AS rowId, ${quoteIdentifier(column)} AS value FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} IS NOT NULL`).all();
      for (const row of rows) {
        try {
          walk(JSON.parse(row.value), null, `${table}[${row.rowId}].${column}`);
        } catch {
          // Invalid JSON is outside this rollback contract; it is not a version reference.
        }
      }
    }
  }
  return references;
}

const rollbackBackup = await verifiedBackup();
const actualReferenceSha256 = createHash('sha256').update(readFileSync(referencePath)).digest('hex').toUpperCase();
if (actualReferenceSha256 !== referenceSha256) throw new Error('reference backup SHA-256 mismatch');
const reference = new DatabaseSync(referencePath, { readOnly: true });
const database = new DatabaseSync(databasePath);
database.exec('PRAGMA busy_timeout=5000');
try {
  const before = readSnapshot(reference);
  if (!before.planItem || !before.project || before.versions.length !== 0 || before.carry.length !== 1) throw new Error('reference backup is not the exact pre-repair state');

  const workspaceId = database.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get()?.value;
  if (!workspaceId) throw new Error('workspace identity missing');
  const identity = { workspaceId, rootPath: dataRoot, runtimeEpoch: `approved-chain-rollback-${ids.receiptId}` };
  const dispatcher = new CommandDispatcher(database, identity);
  const envelope = createCommandEnvelope({
    workspaceId,
    runtimeEpoch: identity.runtimeEpoch,
    command: 'plan_item.rollback_approved_chain_repair',
    requestId: `approved-chain-rollback:${ids.receiptId}`,
    input: ids,
    boundIdentity: { planItemId: ids.planItemId },
    actor: { type: 'owner_ui', id: 'approved-chain-rollback' }
  });
  const priorRollback = database.prepare('SELECT 1 FROM command_receipts WHERE workspace_id=? AND request_id=?').get(workspaceId, envelope.requestId);
  if (priorRollback) {
    const commandReceipt = dispatcher.dispatch(envelope, () => { throw new Error('rollback replay unexpectedly executed'); });
    console.log(JSON.stringify({ databasePath, rollbackBackup, commandReceipt }, null, 2));
    process.exitCode = 0;
  } else {
    const commandReceipt = dispatcher.dispatch(envelope, () => {
      const live = readSnapshot(database);
      if (!live.project || live.versions.length !== 1 || live.versions[0].id !== ids.contentVersionId || live.versions[0].versionNumber !== 1 || live.carry.length !== 1) {
        throw new Error('live chain has changed since the unsafe repair');
      }
      if (!live.planItem || JSON.stringify(live.planItem) !== JSON.stringify(before.planItem)) {
        throw new Error('plan item changed after the reference backup');
      }
      if (JSON.stringify(live.projectSources) !== JSON.stringify(before.projectSources)) throw new Error('project source lineage changed after the reference backup');

      const receipt = database.prepare('SELECT command, status, result_json AS resultJson, created_at AS createdAt FROM command_receipts WHERE id=?').get(ids.receiptId);
      const result = receipt?.resultJson ? JSON.parse(receipt.resultJson) : null;
      if (!receipt || receipt.command !== 'plan_item.repair_approved_chain' || receipt.status !== 'ok'
          || result?.planItemId !== ids.planItemId || result?.projectId !== ids.projectId
          || result?.contentVersionId !== ids.contentVersionId || !result?.actions?.includes('initial_version_created')) {
        throw new Error('receipt does not prove this version was created by approved-chain repair');
      }
      if (!result.rollbackBinding || result.rollbackBinding.referenceSha256 !== referenceSha256
          || result.rollbackBinding.preStateHash !== approvedPlanItemChainPreStateHash(reference, ids.planItemId)) {
        throw new Error('repair receipt is not bound to the supplied reference backup pre-state');
      }
      const stableProjectFields = ['id', 'topic_id', 'plan_item_id', 'title', 'created_at', 'status', 'archived_at'];
      if (stableProjectFields.some((field) => live.project[field] !== before.project[field])
          || live.project.revision !== result.projectRevision || live.carry[0].id !== before.carry[0].id) {
        throw new Error('live project or carry identity does not match the proven repair snapshot');
      }
      const stableCarryFields = ['object_type', 'object_id', 'fingerprint', 'title', 'priority', 'topic_id', 'source_ids_json',
        'origin_plan_date', 'first_seen_at', 'last_seen_at', 'expires_at', 'decay_score', 'aftershock_json', 'created_at', 'story_key', 'stage'];
      if (stableCarryFields.some((field) => live.carry[0][field] !== before.carry[0][field])
          || live.carry[0].state !== 'done' || live.carry[0].revision !== before.carry[0].revision + 1
          || !result.actions.includes('carry_completed')) {
        throw new Error('live carry does not match the single state transition proven by the repair receipt');
      }
      if (Math.abs(Date.parse(live.versions[0].createdAt) - Date.parse(receipt.createdAt)) > 5_000) throw new Error('version timestamp does not match repair receipt');

      const referencingRows = [];
      const logicalUsageCount = Number(database.prepare(`SELECT count(*) AS count FROM knowledge_usage_records
        WHERE output_object_type='content_version' AND output_object_id=?`).get(ids.contentVersionId).count);
      if (logicalUsageCount > 0) {
        referencingRows.push({ table: 'knowledge_usage_records', column: 'output_object_id', count: logicalUsageCount });
      }
      const reviewCount = Number(database.prepare('SELECT count(*) AS count FROM reviews WHERE content_version_id=?').get(ids.contentVersionId).count);
      if (reviewCount > 0) referencingRows.push({ table: 'reviews', column: 'content_version_id', count: reviewCount });
      const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
      for (const table of tables) {
        for (const foreignKey of database.prepare(`PRAGMA foreign_key_list(${JSON.stringify(table)})`).all().filter((row) => row.table === 'content_versions')) {
          const count = Number(database.prepare(`SELECT count(*) AS count FROM ${JSON.stringify(table)} WHERE ${JSON.stringify(foreignKey.from)}=?`).get(ids.contentVersionId).count);
          if (count > 0) referencingRows.push({ table, column: foreignKey.from, count });
        }
      }
      const jsonReferences = collectJsonReferences(database, ids.contentVersionId);
      if (jsonReferences.length > 0) referencingRows.push({ table: 'json', column: 'content_version_id', count: jsonReferences.length, paths: jsonReferences.slice(0, 10).map((entry) => entry.path) });
      if (referencingRows.length > 0) throw new Error(`content version has downstream references: ${JSON.stringify(referencingRows)}`);

      database.prepare('DELETE FROM content_versions WHERE id=? AND project_id=?').run(ids.contentVersionId, ids.projectId);
      database.prepare('UPDATE content_projects SET updated_at=?, revision=? WHERE id=?').run(before.project.updated_at, before.project.revision, ids.projectId);
      const priorCarry = before.carry[0];
      database.prepare(`UPDATE work_carry_items SET state=?, reason=?, updated_at=?, revision=? WHERE id=?`)
        .run(priorCarry.state, priorCarry.reason, priorCarry.updated_at, priorCarry.revision, priorCarry.id);
      const readback = readSnapshot(database);
      if (readback.versions.length !== 0 || readback.carry.length !== 1 || readback.carry[0].state !== priorCarry.state
          || readback.carry[0].revision !== priorCarry.revision) throw new Error('rollback exact readback failed');
      const data = {
        ...ids,
        restoredVersionCount: 0,
        restoredCarryState: priorCarry.state,
        retainedRepairReceiptId: ids.receiptId,
        retainedUsageAudit: `usage:core_draft:${ids.contentVersionId}`
      };
      return { data, entityType: 'plan_item', entityId: ids.planItemId, readback: data };
    });
    if (!commandReceipt.ok) throw new Error(`rollback command failed: ${JSON.stringify(commandReceipt.error)}`);
    console.log(JSON.stringify({ databasePath, rollbackBackup, commandReceipt }, null, 2));
  }
} finally {
  reference.close();
  database.close();
}
