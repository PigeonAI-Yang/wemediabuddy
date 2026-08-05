import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validateDataRoot } from '../src/main/data-root.ts';
import { readWorkspaceProfile } from '../src/main/workspace-profiles.ts';
import { readWorkspaceRegistry } from '../src/main/workspaces.ts';
import { quoteIdentifier, ROOT_KEYS, sha256, stableStringify } from './eval-029-fixtures-shared.mjs';

const PROJECTION_TABLES = Object.freeze([
  'workspace_profiles',
  'agent_tasks',
  'source_feeds',
  'source_items',
  'topics',
  'topic_source_links',
  'plans',
  'plan_items',
  'content_projects',
  'content_project_sources',
  'content_versions',
  'platform_versions',
  'platform_accounts',
  'publications',
  'publication_metric_snapshots',
  'reviews',
  'method_findings',
  'mcp_request_results',
  'source_scan_receipts'
]);
const ID_TABLES = Object.freeze({
  feed: 'source_feeds',
  agentTask: 'agent_tasks',
  source: 'source_items',
  topic: 'topics',
  plan: 'plans',
  planItem: 'plan_items',
  project: 'content_projects',
  contentVersion: 'content_versions',
  platformVersion: 'platform_versions',
  account: 'platform_accounts',
  publication: 'publications',
  metricSnapshot: 'publication_metric_snapshots',
  review: 'reviews',
  methodFinding: 'method_findings',
  scanReceipt: 'source_scan_receipts'
});

export async function buildEvidence(paths, fixture, publishedPaths = paths) {
  const registry = await readWorkspaceRegistry(paths.registryPath);
  assert.equal(registry.version, 1);
  assert.equal(registry.activeWorkspaceId, fixture.roots.ai.workspaceId);
  assert.equal(registry.switchJournal, null);
  assert.equal(registry.workspaces.length, 2);

  const expectedRegistry = ROOT_KEYS.map((rootKey) => ({
    id: fixture.roots[rootKey].workspaceId,
    displayName: fixture.roots[rootKey].displayName,
    rootPath: publishedPaths.roots[rootKey].rootPath
  }));
  assert.deepEqual(registry.workspaces, expectedRegistry);
  const physicalProfileSentinel = JSON.parse(await readFile(paths.physicalProfileSentinel, 'utf8'));
  assert.equal(Object.hasOwn(physicalProfileSentinel, 'defaultProfileId'), false);
  assert.deepEqual(physicalProfileSentinel, fixture.installation.physicalProfileFixture.sentinel);
  assert.notEqual(expectedRegistry[0].rootPath, expectedRegistry[1].rootPath);

  const roots = {};
  const shared = {};
  for (const rootKey of ROOT_KEYS) {
    const rootFixture = fixture.roots[rootKey];
    const rootPath = paths.roots[rootKey].rootPath;
    await validateDataRoot(rootPath);
    const inspected = await inspectRoot(paths.roots[rootKey], rootFixture, fixture);
    roots[rootKey] = inspected.projection;
    shared[rootKey] = inspected.shared;
  }
  assert.deepEqual(shared.ai, shared.uk, 'visible business values must be byte-for-byte equal across roots');
  assert.notEqual(fixture.roots.ai.workspaceId, fixture.roots.uk.workspaceId);
  assert.notEqual(fixture.roots.ai.rootLocalId, fixture.roots.uk.rootLocalId);
  assert.notEqual(fixture.roots.ai.profile.profileId, fixture.roots.uk.profile.profileId);
  for (const idName of Object.keys(ID_TABLES)) assert.notEqual(fixture.roots.ai.ids[idName], fixture.roots.uk.ids[idName], `${idName} identity must differ`);

  const projection = {
    schema: 'wmb.eval-029-semantic-projection.v1',
    version: fixture.semanticProjectionVersion,
    fixedTime: fixture.fixedTime,
    schemaVersion: fixture.schemaVersion,
    currentVsTargetAbsent: fixture.currentVsTargetAbsent,
    deliveredAuthorities: fixture.deliveredAuthorities,
    installation: {
      physicalProfileFixtureLabel: fixture.installation.physicalProfileFixture.label,
      physicalProfilePath: fixture.installation.physicalProfileFixture.relativePath,
      sentinel: physicalProfileSentinel
    },
    registry: {
      version: registry.version,
      activeWorkspaceId: registry.activeWorkspaceId,
      workspaces: ROOT_KEYS.map((rootKey) => ({
        rootKey,
        id: fixture.roots[rootKey].workspaceId,
        displayName: fixture.roots[rootKey].displayName,
        rootDirectory: fixture.roots[rootKey].directoryName
      })),
      switchJournal: registry.switchJournal
    },
    roots
  };
  return { projection, semanticSha256: sha256(stableStringify(projection)) };
}

export async function captureStrictState(paths, manifestPath = paths.manifestPath) {
  return {
    schema: 'wmb.eval-029-strict-parent-state.v1',
    parentTreeSha256: await hashTree(paths.parent, manifestPath)
  };
}

async function inspectRoot(rootPaths, rootFixture, fixture) {
  const rootPath = rootPaths.rootPath;
  const database = new DatabaseSync(path.join(rootPath, 'wmb.db'), { readOnly: true });
  try {
    database.exec('PRAGMA query_only = ON; PRAGMA foreign_keys = ON');
    assert.deepEqual(database.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check), ['ok']);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);

    const workspaceRow = database.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get();
    const rootIdentityRow = database.prepare("SELECT value FROM app_meta WHERE key='eval029.root_id'").get();
    assert.equal(workspaceRow?.value, rootFixture.workspaceId);
    assert.equal(rootIdentityRow?.value, rootFixture.rootLocalId);
    assert.deepEqual(readWorkspaceProfile(database), rootFixture.profile);
    const legacyConversation = await assertLegacyState(database, rootPaths, rootFixture, fixture);
    const authorityState = readAuthorityState(database, fixture);
    assertLocalChains(database, rootFixture, fixture);
    assertCrossRootInvisibility(database, rootFixture, fixture);

    const tableRows = Object.fromEntries(PROJECTION_TABLES.map((table) => [table, rows(database, table)]));
    const appMeta = database.prepare("SELECT key,value,created_at,updated_at,revision FROM app_meta WHERE key IN ('workspace_id','eval029.root_id','browser.config') ORDER BY key").all().map(plainRow);
    const migrationVersions = database.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version);
    assert.deepEqual(migrationVersions, Array.from({ length: fixture.schemaVersion }, (_, index) => index + 1), 'fixture schema migrations must be exact and contiguous');
    const legacyBrowserFile = JSON.parse(await readFile(rootPaths.legacyBrowserFile, 'utf8'));
    const rootIdentityFile = JSON.parse(await readFile(rootPaths.rootIdentityFile, 'utf8'));
    assert.deepEqual(rootIdentityFile, { schema: 'wmb.eval-029-root-identity.v1', id: rootFixture.rootLocalId });

    return {
      projection: {
        workspaceId: rootFixture.workspaceId,
        rootLocalId: rootFixture.rootLocalId,
        profileId: rootFixture.profile.profileId,
        migrationVersions,
        authorityState,
        appMeta,
        tableRows,
        legacyBrowserFile,
        legacyConversation,
        rootIdentityFile
      },
      shared: sharedBusinessProjection(database, fixture)
    };
  } finally {
    database.close();
  }
}

function assertLocalChains(database, rootFixture, fixture) {
  const ids = rootFixture.ids;
  const shared = fixture.sharedBusinessValues;
  assert.deepEqual(plainRow(database.prepare('SELECT topic_id AS topicId, source_id AS sourceId, relation FROM topic_source_links').get()), { topicId: ids.topic, sourceId: ids.source, relation: 'primary' });
  assert.equal(database.prepare('SELECT topic_id AS topicId FROM plan_items WHERE id=?').get(ids.planItem)?.topicId, ids.topic);
  assert.deepEqual(JSON.parse(database.prepare('SELECT source_ids_json AS value FROM plan_items WHERE id=?').get(ids.planItem).value), [ids.source]);
  assert.equal(database.prepare('SELECT plan_item_id AS planItemId FROM content_projects WHERE id=?').get(ids.project)?.planItemId, ids.planItem);
  assert.equal(database.prepare('SELECT source_id AS sourceId FROM content_project_sources WHERE project_id=?').get(ids.project)?.sourceId, ids.source);
  assert.equal(database.prepare('SELECT project_id AS projectId FROM content_versions WHERE id=?').get(ids.contentVersion)?.projectId, ids.project);
  assert.deepEqual(plainRow(database.prepare('SELECT project_id AS projectId, content_version_id AS contentVersionId FROM platform_versions WHERE id=?').get(ids.platformVersion)), { projectId: ids.project, contentVersionId: ids.contentVersion });
  assert.deepEqual(plainRow(database.prepare('SELECT platform_version_id AS platformVersionId, account_id AS accountId FROM publications WHERE id=?').get(ids.publication)), { platformVersionId: ids.platformVersion, accountId: ids.account });
  assert.equal(database.prepare('SELECT publication_id AS publicationId FROM publication_metric_snapshots WHERE id=?').get(ids.metricSnapshot)?.publicationId, ids.publication);
  const review = database.prepare('SELECT publication_id AS publicationId, content_version_id AS contentVersionId, metric_snapshot_ids_json AS metricIds FROM reviews WHERE id=?').get(ids.review);
  assert.deepEqual({ publicationId: review.publicationId, contentVersionId: review.contentVersionId, metricIds: JSON.parse(review.metricIds) }, { publicationId: ids.publication, contentVersionId: ids.contentVersion, metricIds: [ids.metricSnapshot] });
  assert.equal(database.prepare('SELECT review_id AS reviewId FROM method_findings WHERE id=?').get(ids.methodFinding)?.reviewId, ids.review);
  const agentTask = database.prepare('SELECT intent,business_date AS businessDate,status,phase,pi_session_id AS piSessionId,context_refs_json AS contextRefs FROM agent_tasks WHERE id=?').get(ids.agentTask);
  assert.deepEqual({ ...agentTask, contextRefs: JSON.parse(agentTask.contextRefs) }, {
    intent: shared.agentTaskIntent,
    businessDate: shared.planDate,
    status: 'running',
    phase: shared.agentTaskPhase,
    piSessionId: ids.legacySession,
    contextRefs: { workspaceId: rootFixture.workspaceId, fixture: 'EVAL-029' }
  });

  const requestRows = database.prepare('SELECT result_json AS resultJson FROM mcp_request_results WHERE tool=? AND request_id=?').all(shared.requestTool, shared.requestId);
  assert.equal(requestRows.length, 1);
  assert.deepEqual(JSON.parse(requestRows[0].resultJson), { objectId: ids.project, sharedBusinessValue: shared.requestSharedResult, workspaceId: rootFixture.workspaceId });
  const receipt = database.prepare('SELECT * FROM source_scan_receipts WHERE task_id=? AND module=? AND source_id=?').all(shared.scanTaskId, shared.scanModule, shared.scanSourceId);
  assert.equal(receipt.length, 1);
  assert.equal(receipt[0].id, ids.scanReceipt);
  assert.equal(receipt[0].workspace_id, rootFixture.workspaceId);
  assert.equal(receipt[0].source_feed_id, ids.feed);
}

function assertCrossRootInvisibility(database, rootFixture, fixture) {
  const otherKey = ROOT_KEYS.find((rootKey) => fixture.roots[rootKey].workspaceId !== rootFixture.workspaceId);
  const other = fixture.roots[otherKey];
  for (const [idName, table] of Object.entries(ID_TABLES)) {
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)} WHERE id=?`).get(other.ids[idName]).count, 0, `${otherKey} ${idName} leaked across roots`);
  }
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM app_meta WHERE key='workspace_id' AND value=?").get(other.workspaceId).count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM app_meta WHERE key='eval029.root_id' AND value=?").get(other.rootLocalId).count, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM workspace_profiles WHERE profile_id=?').get(other.profile.profileId).count, 0);

  const shared = fixture.sharedBusinessValues;
  assert.equal(database.prepare('SELECT id FROM source_items WHERE canonical_url=?').get(shared.sourceUrl)?.id, rootFixture.ids.source);
  assert.equal(database.prepare('SELECT id FROM topics WHERE canonical_key=?').get(shared.topicCanonicalKey)?.id, rootFixture.ids.topic);
  assert.equal(database.prepare('SELECT id FROM content_projects WHERE title=?').get(shared.projectTitle)?.id, rootFixture.ids.project);
  assert.equal(database.prepare('SELECT id FROM platform_accounts WHERE account_key=?').get(shared.accountKey)?.id, rootFixture.ids.account);
}

async function assertLegacyState(database, rootPaths, rootFixture, fixture) {
  const legacy = fixture.legacySentinels;
  const row = database.prepare('SELECT value FROM app_meta WHERE key=?').get(legacy.browserConfigKey);
  assert.deepEqual(JSON.parse(row?.value), legacy.browserConfigValue);
  assert.deepEqual(JSON.parse(await readFile(rootPaths.legacyBrowserFile, 'utf8')), legacy.browserFileValue);
  assert.equal(database.prepare('SELECT status FROM publications WHERE id=?').get(rootFixture.ids.publication)?.status, legacy.publicationStatus);
  assert.equal(database.prepare('SELECT status FROM reviews WHERE id=?').get(rootFixture.ids.review)?.status, legacy.reviewStatus);
  const pointerBytes = await readFile(rootPaths.legacyConversationPointer, 'utf8');
  const pointer = JSON.parse(pointerBytes);
  const sessionBytes = await readFile(rootPaths.legacyConversationSession, 'utf8');
  const sessionEntries = sessionBytes.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(pointer.id, rootFixture.ids.legacyConversation);
  assert.equal(pointer.sessionId, rootFixture.ids.legacySession);
  assert.equal(pointer.title, fixture.sharedBusinessValues.legacyConversationTitle);
  assert.equal(pointer.messages[0]?.text, fixture.sharedBusinessValues.legacyConversationMessage);
  assert.equal(path.basename(pointer.sessionFile), path.basename(rootPaths.legacyConversationSession));
  assert.equal(sessionEntries[0]?.id, rootFixture.ids.legacySession);
  assert.equal(sessionEntries[1]?.message?.content?.[0]?.text, fixture.sharedBusinessValues.legacyConversationMessage);
  return {
    pointer: { id: pointer.id, title: pointer.title, sessionId: pointer.sessionId, sessionFile: legacy.conversationSessionRelativePath, messages: pointer.messages },
    session: sessionEntries.map((entry) => entry.type === 'session' ? { ...entry, cwd: 'ROOT/pi-agent/workspace' } : entry)
  };
}

function readAuthorityState(database, fixture) {
  const profileColumns = new Set(database.prepare('PRAGMA table_info(workspace_profiles)').all().map((row) => row.name));
  assert.equal(profileColumns.has('browser_profile_id'), false);
  assert.equal(profileColumns.has('expected_account_snapshot_json'), false);
  const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  const deliveredTables = new Set(fixture.deliveredAuthorities.map((authority) => authority.table));
  const authorityState = {};
  for (const authority of fixture.deliveredAuthorities) {
    assert.equal(tables.has(authority.table), true, `${authority.table} must be delivered by schema ${fixture.schemaVersion}`);
    const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier(authority.table)})`).all().map((row) => row.name);
    assert.equal(columns.includes('runtime_epoch'), true, `${authority.table}.runtime_epoch must bind authority to one runtime`);
    const tableRows = rows(database, authority.table);
    assert.equal(tableRows.length, authority.expectedRowsPerRoot, `${authority.table} fixture row count changed`);
    for (const dependency of authority.dependentColumns ?? []) {
      assert.equal(tables.has(dependency.table), true, `${dependency.table} must exist for ${authority.id}`);
      const dependentColumns = database.prepare(`PRAGMA table_info(${quoteIdentifier(dependency.table)})`).all().map((row) => row.name);
      assert.equal(dependentColumns.includes(dependency.column), true, `${dependency.table}.${dependency.column} must be delivered for ${authority.id}`);
    }
    authorityState[authority.id] = { table: authority.table, columns, rows: tableRows };
  }
  for (const table of tables) {
    if (deliveredTables.has(table)) continue;
    const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map((row) => row.name);
    assert.equal(columns.includes('runtime_epoch'), false, `${table}.runtime_epoch must not create an undeclared authority surface`);
  }
  return authorityState;
}

function sharedBusinessProjection(database, fixture) {
  const shared = fixture.sharedBusinessValues;
  const one = (sql, ...params) => ({ ...database.prepare(sql).get(...params) });
  const request = JSON.parse(database.prepare('SELECT result_json AS value FROM mcp_request_results WHERE tool=? AND request_id=?').get(shared.requestTool, shared.requestId).value);
  return {
    source: one(`SELECT original_url,canonical_url,content_fingerprint,title,author,published_at,collected_at,summary,categories_json,keywords_json,
      value_judgment,ip_relevance,creation_angles,recommended_platforms_json,recommended_formats_json,timeliness,priority,evidence,client_label,
      created_at,updated_at,revision,verification_status,management_status FROM source_items WHERE canonical_url=?`, shared.sourceUrl),
    topic: one('SELECT title,canonical_key,kind,summary,status,first_seen_at,last_seen_at,created_at,updated_at,revision FROM topics WHERE canonical_key=?', shared.topicCanonicalKey),
    plan: one('SELECT plan_date,timezone,summary,is_current,created_at,updated_at,revision FROM plans WHERE plan_date=?', shared.planDate),
    planItem: one(`SELECT title,priority,why_now,timeliness,target_audience,angle,point_of_view,platforms_json,formats_json,title_guidance,
      opening_guidance,structure_guidance,effort_estimate,sort_order,created_at,updated_at,revision,missing_materials_json,score_reasons_json FROM plan_items`),
    project: one('SELECT title,created_at,updated_at,revision,status,archived_at FROM content_projects'),
    contentVersion: one('SELECT body,version_number,created_at,author FROM content_versions'),
    platformVersion: one('SELECT platform,format,title,body,asset_ids_json,created_at,updated_at,revision FROM platform_versions'),
    account: one('SELECT platform,account_key,display_name,login_state,evidence_url,created_at,updated_at,revision FROM platform_accounts'),
    publication: one(`SELECT platform_version_revision,platform,account_key,status,prepared_title,prepared_body,prepared_assets_json,prepared_evidence_url,
      external_url,external_id,published_at,last_error_code,last_error_message,created_at,updated_at,revision FROM publications`),
    metric: one('SELECT scheduled_for,captured_at,source_url,normalized_json,raw_json,created_at FROM publication_metric_snapshots'),
    review: one('SELECT status,keep_json,stop_json,change_json,summary,created_at,updated_at,finalized_at,revision FROM reviews'),
    methodFinding: one('SELECT title,body,created_at,updated_at,revision FROM method_findings'),
    request: { tool: shared.requestTool, requestId: shared.requestId, sharedBusinessValue: request.sharedBusinessValue },
    scanReceipt: one(`SELECT task_id,module,source_id,checked_at,status,candidate_count,saved_count,error_code,error_message,created_at,updated_at,revision
      FROM source_scan_receipts`),
    legacyBrowserConfig: JSON.parse(database.prepare('SELECT value FROM app_meta WHERE key=?').get(fixture.legacySentinels.browserConfigKey).value),
    legacyBrowserFile: fixture.legacySentinels.browserFileValue
  };
}

function rows(database, table) {
  const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map((row) => row.name);
  const order = columns.includes('id') ? quoteIdentifier('id') : columns.map(quoteIdentifier).join(',');
  return database.prepare(`SELECT * FROM ${quoteIdentifier(table)} ORDER BY ${order}`).all().map(plainRow);
}

async function hashTree(root, normalizedManifestPath) {
  const entries = [];
  await walk(root, '');
  return sha256(entries.join('\n'));

  async function walk(directory, relativeDirectory) {
    const children = await readdir(directory, { withFileTypes: true });
    entries.push(`D ${toPosix(relativeDirectory || '.')}`);
    children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const child of children) {
      const relative = path.join(relativeDirectory, child.name);
      const absolute = path.join(directory, child.name);
      if (child.isSymbolicLink()) throw new Error(`Fixture trees must not contain symbolic links: ${absolute}`);
      if (child.isDirectory()) {
        await walk(absolute, relative);
      } else if (child.isFile()) {
        let value = await readFile(absolute);
        if (path.resolve(absolute) === path.resolve(normalizedManifestPath)) value = normalizeManifest(value);
        entries.push(`F ${toPosix(relative)} ${value.byteLength} ${sha256(value)}`);
      } else {
        throw new Error(`Unsupported fixture tree entry: ${absolute}`);
      }
    }
  }
}

function normalizeManifest(value) {
  const text = value.toString('utf8');
  const pattern = /(\"parentTreeSha256\"\s*:\s*)\"[^\"]*\"/g;
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) throw new Error('Manifest must contain exactly one strict parentTreeSha256.');
  return Buffer.from(text.replace(pattern, `$1\"${'0'.repeat(64)}\"`), 'utf8');
}

function plainRow(row) {
  return row ? { ...row } : row;
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}
