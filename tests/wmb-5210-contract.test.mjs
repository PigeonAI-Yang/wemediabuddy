import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { register } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

// 复用既有测试的 TS 扩展解析 hook（node 直接 import .ts 模块）。
const hook = "const p=process.getBuiltinModule('node:path'),f=process.getBuiltinModule('node:fs'),u=process.getBuiltinModule('node:url');export async function resolve(s,c,n){if((s.startsWith('./')||s.startsWith('../'))&&!p.extname(s)){const b=p.resolve(p.dirname(u.fileURLToPath(c.parentURL)),s);if(f.existsSync(b+'.ts'))return {url:u.pathToFileURL(b+'.ts').href,shortCircuit:true};}return n(s,c);}";
register('data:text/javascript,' + encodeURIComponent(hook), import.meta.url);

const { migrateDatabase, migrations } = await import('../src/main/db/migrations.ts');
// WMB-5210 M1 核心 store（ImplementWmb5210 交付的共享契约，测试代理只消费不另建）
const {
  applyKnowledgeChangeSet,
  resolveKnowledgeEntity,
  resolveKnowledgeNote,
  resolveWikiPage
} = await import('../src/main/knowledge-flywheel.ts');

const WS = 'ws-main';

// ============================================================================
// helpers：真实旧 schema fixture（v1..v55）+ 全量新库 + 可观察 DB 断言
// ============================================================================

/** 全量迁移（含 v56）的全新工作空间库。 */
async function withDb(work) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5210-'));
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  try { await work(database); } finally { database.close(); await rm(root, { recursive: true, force: true }); }
}

/**
 * 真实旧 schema fixture：按真实 migrations 数组顺序应用 v1..v55（跳过 v56），
 * 模拟「既有工作空间升级到 v56」的存量根。work(database, dbPath) 拿到的是
 * 未升级的旧库；随后可调用 migrateDatabase(dbPath) 应用 v56。
 */
async function withPreV56Db(work) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5210-pre56-'));
  const dbPath = path.join(root, 'wmb.db');
  const database = new DatabaseSync(dbPath);
  database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const migration of migrations) {
    if (migration.version >= 56) continue;
    if (database.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(migration.version)) continue;
    database.exec('PRAGMA foreign_keys = OFF');
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(migration.sql);
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, new Date().toISOString());
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    database.exec('PRAGMA foreign_keys = ON');
  }
  database.exec('PRAGMA foreign_keys = ON');
  try { await work(database, dbPath); }
  finally { try { database.close(); } catch {} await rm(root, { recursive: true, force: true }); }
}

const NOW = () => new Date().toISOString();

/**
 * 落工作空间身份（app_meta.workspace_id）、lane 身份（source_lane_judgments.workspace_lane）
 * 与一个真实 Topic（WikiPage topic subject 与关系端点校验需要）。
 */
function seedWorkspace(database, { workspaceId = WS, lanes = [] } = {}) {
  database.prepare(`INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES (?,?,?,?,1)`)
    .run('workspace_id', workspaceId, NOW(), NOW());
  database.prepare(`INSERT INTO topics (id, title, canonical_key, kind, summary, status, first_seen_at, last_seen_at, created_at, updated_at, revision)
    VALUES ('topic-fx', 'Fixture Topic', 'fixture topic', 'theme', '', 'active', ?, ?, ?, ?, 1)`)
    .run(NOW(), NOW(), NOW(), NOW());
  for (const lane of lanes) {
    const sourceId = `src-${lane}`;
    database.prepare(`INSERT INTO source_items (id, canonical_url, title, collected_at, created_at, updated_at, revision,
        categories_json, keywords_json, recommended_platforms_json, recommended_formats_json)
      VALUES (?,?,?,?,?,?,1,'[]','[]','[]','[]')`)
      .run(sourceId, `https://example.test/${lane}`, `Source ${lane}`, NOW(), NOW(), NOW());
    database.prepare(`INSERT INTO source_lane_judgments (id, source_id, workspace_lane, decision, reason_code, judged_by, source_revision, judged_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), sourceId, lane, 'relevant', 'fixture', 'system', 1, NOW());
  }
}

function meta(overrides = {}) {
  return {
    workspaceId: WS,
    requestId: randomUUID(),
    reason: 'WMB-5210 contract fixture',
    triggerSource: 'lint',
    resolutionMode: 'replaced_current',
    createdBy: 'system',
    ...overrides
  };
}

function count(database, table, where = '', params = []) {
  const row = database.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get(...params);
  return Number(row.n);
}

/** 断言执行失败（抛错或 CommandResult.failure），且错误标识包含期望 code。 */
function expectFailure(fn, code) {
  let outcome;
  try { outcome = fn(); } catch (error) {
    const marker = `${error?.code ?? ''} ${error?.message ?? error}`;
    assert.ok(marker.includes(code), `expected ${code}, got ${marker}`);
    return;
  }
  if (outcome && typeof outcome.then === 'function') {
    return outcome.then((r) => {
      if (r && r.ok === false) {
        assert.ok(String(r.code ?? r.error ?? '').includes(code), `expected ${code}, got ${r.code ?? r.error}`);
        return;
      }
      assert.fail(`expected failure ${code}, got success ${JSON.stringify(r)}`);
    });
  }
  if (outcome && outcome.ok === false) {
    assert.ok(String(outcome.code ?? outcome.error ?? '').includes(code), `expected ${code}, got ${outcome.code ?? outcome.error}`);
    return;
  }
  assert.fail(`expected failure ${code}, got success ${JSON.stringify(outcome)}`);
}

function noteCreate(noteId, { kind = 'claim', canonicalKey = null, statement = 'statement', conclusionStatus = 'unverified', evidenceLevel = 'none', changeType = 'created', title = null, scope = 'global', extra = {} } = {}) {
  return {
    id: noteId, scope, kind, canonicalKey: canonicalKey ?? `${noteId}-key`, title: title ?? noteId,
    version: {
      title: title ?? noteId, statement, conclusionStatus, evidenceLevel, changeType, changeReason: 'fixture',
      ...extra
    }
  };
}

function entityCreate(entityId, { entityType = 'organization', canonicalName = null, scope = 'global', extra = {} } = {}) {
  return { id: entityId, scope, entityType, canonicalKey: `${entityId}-key`, canonicalName: canonicalName ?? entityId, ...extra };
}

function pageCreate(pageId, { pageType = 'topic', subjectType = 'topic', subjectId = 'topic-fx', scope = 'global', extra = {} } = {}) {
  return {
    id: pageId, scope, pageType, canonicalKey: `${pageId}-key`, title: pageId,
    subjectType, subjectId,
    version: { title: pageId, body: { blocks: [] }, changeSummary: 'fixture', compileReason: 'fixture', ...extra }
  };
}

function noteVersionIds(database, noteId) {
  return database.prepare(`SELECT id, version_number FROM knowledge_note_versions WHERE note_id=? ORDER BY version_number`)
    .all(noteId).map(({ id, version_number }) => ({ id, versionNumber: Number(version_number) }));
}

function currentNote(database, noteId) {
  return database.prepare(`SELECT revision, current_version_id AS currentVersionId FROM knowledge_notes WHERE id=?`).get(noteId);
}

function noteVersionRow(database, versionId) {
  return database.prepare(`SELECT id, note_id AS noteId, version_number AS versionNumber, statement, change_type AS changeType,
    restored_from_version_id AS restoredFromVersionId, change_set_id AS changeSetId FROM knowledge_note_versions WHERE id=?`).get(versionId);
}

// ============================================================================
// 1. 真实旧 schema fixture 幂等迁移（验收：真实旧 schema fixture 幂等迁移）
// ============================================================================

test('WMB-5210: v56 lands on a fresh database with the full knowledge flywheel schema', async () => {
  await withDb((database) => {
    const applied = new Set(database.prepare('SELECT version FROM schema_migrations').all().map(({ version }) => Number(version)));
    assert.ok(applied.has(56), 'v56 must be applied on a fresh database');
    for (const table of ['knowledge_change_sets', 'knowledge_free_notes', 'knowledge_entities', 'knowledge_notes',
      'knowledge_note_versions', 'knowledge_wiki_pages', 'knowledge_wiki_page_versions', 'knowledge_relation_registry',
      'knowledge_formal_relations', 'knowledge_evidence_links', 'knowledge_annotations', 'knowledge_update_receipts',
      'knowledge_query_artifacts', 'knowledge_health_issues']) {
      const found = database.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table);
      assert.ok(found, `knowledge table ${table} must exist`);
    }
    // 版本不可变防护必须以 DB 触发器强制（无 AI 硬删除 / 不可变版本）
    for (const trigger of ['knowledge_note_versions_immutable_update', 'knowledge_note_versions_immutable_delete',
      'knowledge_change_sets_immutable_update', 'knowledge_change_sets_immutable_delete',
      'knowledge_entities_delete_immutable', 'knowledge_notes_delete_immutable',
      'knowledge_free_notes_delete_immutable', 'knowledge_evidence_links_immutable_update',
      'knowledge_evidence_links_immutable_delete', 'knowledge_update_receipts_immutable_delete',
      'knowledge_formal_relations_delete_immutable']) {
      const found = database.prepare(`SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?`).get(trigger);
      assert.ok(found, `trigger ${trigger} must exist`);
    }
  });
});

test('WMB-5210: real pre-v56 schema fixture upgrades idempotently and preserves legacy rows', async () => {
  await withPreV56Db(async (database, dbPath) => {
    // 旧 schema 下真实的存量业务数据：Topic、Source、Topic-Source 链、工作空间身份
    database.prepare(`INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES (?,?,?,?,1)`)
      .run('workspace_id', WS, NOW(), NOW());
    database.prepare(`INSERT INTO source_items (id, canonical_url, title, collected_at, created_at, updated_at, revision,
        categories_json, keywords_json, recommended_platforms_json, recommended_formats_json)
      VALUES (?,?,?,?,?,?,1,'[]','[]','[]','[]')`)
      .run('src-legacy', 'https://example.test/legacy', 'Legacy Source', NOW(), NOW(), NOW());
    database.prepare(`INSERT INTO topics (id, title, canonical_key, kind, summary, status, first_seen_at, last_seen_at, created_at, updated_at, revision)
      VALUES (?,?,?,?,?,?,?,?,?,?,1)`)
      .run('topic-legacy', 'Legacy Topic', 'legacy topic', 'theme', 'legacy summary', 'active', NOW(), NOW(), NOW(), NOW());
    database.prepare(`INSERT INTO topic_source_links (topic_id, source_id, relation, created_at, updated_at)
      VALUES (?,?,?,?,?)`).run('topic-legacy', 'src-legacy', 'primary', NOW(), NOW());
    const preTopics = count(database, 'topics');
    const preSources = count(database, 'source_items');
    const preLinks = count(database, 'topic_source_links');

    // 升级：同一路径再跑 migrateDatabase → 应用 v56
    const upgraded = migrateDatabase(dbPath);
    const applied = new Set(upgraded.prepare('SELECT version FROM schema_migrations').all().map(({ version }) => Number(version)));
    assert.ok(applied.has(56), 'v56 must apply on the legacy fixture');
    // 旧数据原样保留
    assert.equal(count(upgraded, 'topics'), preTopics);
    assert.equal(count(upgraded, 'source_items'), preSources);
    assert.equal(count(upgraded, 'topic_source_links'), preLinks);
    const topic = upgraded.prepare(`SELECT title, summary, status FROM topics WHERE id='topic-legacy'`).get();
    assert.equal(topic.title, 'Legacy Topic');
    assert.equal(topic.summary, 'legacy summary');
    assert.equal(topic.status, 'active');
    // 新知识表可用
    assert.ok(upgraded.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_notes'`).get());

    // 幂等：再次打开同一路径不重跑、不报错、不加版本
    const again = migrateDatabase(dbPath);
    assert.equal(count(again, 'schema_migrations'), count(upgraded, 'schema_migrations'));
    assert.equal(again.prepare(`SELECT 1 FROM knowledge_notes`).get(), undefined); // 新表为空但存在
    again.close(); upgraded.close();
  });
});

test('WMB-5210: re-running migrateDatabase adds no schema versions', async () => {
  await withDb((database) => {
    const appliedBefore = new Set(database.prepare('SELECT version FROM schema_migrations').all().map(({ version }) => Number(version)));
    const mainRow = database.prepare('PRAGMA database_list').all().find((r) => r.name === 'main');
    const reopened = migrateDatabase(mainRow.file);
    const appliedAfter = new Set(reopened.prepare('SELECT version FROM schema_migrations').all().map(({ version }) => Number(version)));
    assert.deepEqual([...appliedAfter].sort((a, b) => a - b), [...appliedBefore].sort((a, b) => a - b));
    reopened.close();
  });
});

// ============================================================================
// 2. ChangeSet 原子性与版本不变量
// ============================================================================

test('WMB-5210: one ChangeSet writes note + version + evidence + relation + page + receipt atomically', async () => {
  await withDb((database) => {
    seedWorkspace(database);
    const before = { notes: count(database, 'knowledge_notes'), sets: count(database, 'knowledge_change_sets') };
    const result = applyKnowledgeChangeSet(database, meta({ requestId: 'cs-ok' }), {
      freeNotes: [{ id: 'fn-1', scope: 'global', sourceNature: 'user_quick_note', body: '用户原话，不可改写', processingState: 'captured' }],
      entities: [entityCreate('ent-1')],
      notes: [noteCreate('note-1')],
      wikiPages: [pageCreate('page-1')],
      relations: [{ op: 'create', id: 'rel-1', scope: 'global', relationKey: 'about', fromObjectType: 'knowledge_note', fromObjectId: 'note-1', toObjectType: 'knowledge_entity', toObjectId: 'ent-1' }],
      receipts: [{ triggerType: 'lint', requestId: 'cs-ok', summary: '一次原子知识变化', counts: { notes: 1 } }]
    });
    assert.equal(result.replay, false);
    assert.equal(count(database, 'knowledge_notes'), before.notes + 1);
    assert.equal(count(database, 'knowledge_change_sets'), before.sets + 1);
    assert.equal(count(database, 'knowledge_free_notes'), 1);
    assert.equal(count(database, 'knowledge_entities'), 1);
    assert.equal(count(database, 'knowledge_wiki_pages'), 1);
    assert.equal(count(database, 'knowledge_formal_relations'), 1);
    // 回执是一等读模型：同 requestId 恰好一行，且属于该 ChangeSet
    const receipt = database.prepare(`SELECT id, change_set_id AS changeSetId, request_id AS requestId, workspace_id AS workspaceId
      FROM knowledge_update_receipts WHERE workspace_id=? AND request_id=?`).get(WS, 'cs-ok');
    assert.ok(receipt, 'receipt must be created');
    assert.equal(receipt.changeSetId, result.changeSetId);
    assert.equal(result.receipt.id, receipt.id);
    // 当前对象 revision 从 1 起，current_version_id 指向新版本
    const note = currentNote(database, 'note-1');
    assert.equal(note.revision, 1);
    const [v1] = noteVersionIds(database, 'note-1');
    assert.equal(v1.versionNumber, 1);
    assert.equal(note.currentVersionId, v1.id);
  });
});

test('WMB-5210: any failing reference in a ChangeSet rolls back everything — zero partial writes', async () => {
  await withDb((database) => {
    seedWorkspace(database);
    applyKnowledgeChangeSet(database, meta({ requestId: 'cs-good' }), {
      notes: [noteCreate('note-1')]
    });
    const [v1] = noteVersionIds(database, 'note-1');
    const baseline = {
      notes: count(database, 'knowledge_notes'),
      versions: count(database, 'knowledge_note_versions'),
      sets: count(database, 'knowledge_change_sets'),
      freeNotes: count(database, 'knowledge_free_notes'),
      evidence: count(database, 'knowledge_evidence_links')
    };
    // 有效对象 + 指向不存在版本的 EvidenceLink：整体必须零写（契约 §19 引用缺失）
    expectFailure(() => applyKnowledgeChangeSet(database, meta({ requestId: 'cs-bad-ref' }), {
      freeNotes: [{ id: 'fn-bad', scope: 'global', sourceNature: 'user_quick_note', body: '不应出现', processingState: 'captured' }],
      notes: [noteCreate('note-bad')],
      evidenceLinks: [{ id: 'ev-bad', knowledgeNoteVersionId: 'missing-version', evidenceObjectType: 'source', evidenceObjectId: 'src-x', relation: 'supports', sourceNature: 'primary_source' }]
    }), 'OBJECT_NOT_FOUND');
    assert.equal(count(database, 'knowledge_notes'), baseline.notes, 'note must not be written');
    assert.equal(count(database, 'knowledge_note_versions'), baseline.versions, 'version must not be written');
    assert.equal(count(database, 'knowledge_free_notes'), baseline.freeNotes, 'free note must not be written');
    assert.equal(count(database, 'knowledge_evidence_links'), baseline.evidence, 'evidence must not be written');
    assert.equal(count(database, 'knowledge_change_sets'), baseline.sets, 'change set must not be written');
    // 原对象与版本仍完好
    assert.equal(currentNote(database, 'note-1').revision, 1);
    assert.equal(noteVersionIds(database, 'note-1').length, 1);
    assert.equal(noteVersionRow(database, v1.id).statement, 'statement');
  });
});

test('WMB-5210: evidence-level state matrix is enforced (no supported with none evidence)', async () => {
  await withDb((database) => {
    seedWorkspace(database);
    const baseline = count(database, 'knowledge_change_sets');
    expectFailure(() => applyKnowledgeChangeSet(database, meta({ requestId: 'cs-bad-matrix' }), {
      notes: [noteCreate('note-mx', { conclusionStatus: 'supported', evidenceLevel: 'none' })]
    }), 'CHECK');
    assert.equal(count(database, 'knowledge_change_sets'), baseline, 'change set must not be written');
    assert.equal(count(database, 'knowledge_notes'), 0);
    // 合法组合（unverified + none）成立
    applyKnowledgeChangeSet(database, meta({ requestId: 'cs-good-matrix' }), {
      notes: [noteCreate('note-ok', { conclusionStatus: 'unverified', evidenceLevel: 'none' })]
    });
    assert.equal(count(database, 'knowledge_notes'), 1);
  });
});

test('WMB-5210: same requestId replays with zero new rows and returns the same receipt', async () => {
  await withDb((database) => {
    seedWorkspace(database);
    const input = {
      notes: [noteCreate('note-rp', { statement: '稳定输入' })],
      receipts: [{ triggerType: 'lint', requestId: 'cs-replay', summary: '回执：稳定输入', counts: { notes: 1 } }]
    };
    const first = applyKnowledgeChangeSet(database, meta({ requestId: 'cs-replay' }), input);
    assert.equal(first.replay, false);
    const baseline = {
      notes: count(database, 'knowledge_notes'),
      versions: count(database, 'knowledge_note_versions'),
      sets: count(database, 'knowledge_change_sets'),
      receipts: count(database, 'knowledge_update_receipts')
    };
    const second = applyKnowledgeChangeSet(database, meta({ requestId: 'cs-replay' }), input);
    assert.equal(second.replay, true, 'identical requestId+input must replay');
    assert.equal(second.changeSetId, first.changeSetId, 'replay must return the original change set');
    assert.equal(second.receipt.id, first.receipt.id, 'replay must return the same receipt');
    assert.equal(count(database, 'knowledge_notes'), baseline.notes, 'no new note on replay');
    assert.equal(count(database, 'knowledge_note_versions'), baseline.versions, 'no new version on replay');
    assert.equal(count(database, 'knowledge_change_sets'), baseline.sets, 'no new change set on replay');
    assert.equal(count(database, 'knowledge_update_receipts'), baseline.receipts, 'no new receipt on replay');
    const replayReceipt = database.prepare(`SELECT id, summary FROM knowledge_update_receipts WHERE workspace_id=? AND request_id=?`)
      .get(WS, 'cs-replay');
    assert.equal(replayReceipt.id, first.receipt.id);
    assert.equal(replayReceipt.summary, first.receipt.summary);
  });
});

test('WMB-5210: same requestId with different input is rejected and writes nothing', async () => {
  await withDb((database) => {
    seedWorkspace(database);
    applyKnowledgeChangeSet(database, meta({ requestId: 'cs-idconf' }), {
      notes: [noteCreate('note-idc', { statement: '第一次输入' })]
    });
    const baseline = { notes: count(database, 'knowledge_notes'), sets: count(database, 'knowledge_change_sets') };
    expectFailure(() => applyKnowledgeChangeSet(database, meta({ requestId: 'cs-idconf' }), {
      notes: [noteCreate('note-idc', { statement: '换了输入的第二次' })]
    }), 'REQUEST_REPLAY_CONFLICT');
    assert.equal(count(database, 'knowledge_notes'), baseline.notes);
    assert.equal(count(database, 'knowledge_change_sets'), baseline.sets);
  });
});

// ============================================================================
// 3. 并发旧 revision 拒绝（场景 F：两个 Agent 同旧 revision，首个成功，第二个零写冲突）
// ============================================================================

test('WMB-5210: stale beforeRevision is rejected with zero writes (concurrent old revision)', async () => {
  await withDb((database) => {
    seedWorkspace(database);
    applyKnowledgeChangeSet(database, meta({ requestId: 'cs-v1' }), {
      notes: [noteCreate('note-cc', { statement: 'v1' })]
    });
    assert.equal(currentNote(database, 'note-cc').revision, 1);

    // Agent A：基于 rev1 更新成功 → rev2
    applyKnowledgeChangeSet(database, meta({ requestId: 'cs-v2' }), {
      notes: [{ id: 'note-cc', beforeRevision: 1, scope: 'global', kind: 'claim', canonicalKey: 'note-cc-key', title: 'note-cc',
        version: { title: 'note-cc', statement: 'v2 强化', conclusionStatus: 'unverified', evidenceLevel: 'none', changeType: 'strengthened', changeReason: 'agent a' } }]
    });
    const afterA = currentNote(database, 'note-cc');
    assert.equal(afterA.revision, 2);
    assert.equal(noteVersionIds(database, 'note-cc').length, 2);

    // Agent B：仍带旧 beforeRevision=1 → 冲突，零写
    const baseline = { versions: count(database, 'knowledge_note_versions'), sets: count(database, 'knowledge_change_sets') };
    expectFailure(() => applyKnowledgeChangeSet(database, meta({ requestId: 'cs-v2-stale' }), {
      notes: [{ id: 'note-cc', beforeRevision: 1, scope: 'global', kind: 'claim', canonicalKey: 'note-cc-key', title: 'note-cc',
        version: { title: 'note-cc', statement: 'v2 竞争者', conclusionStatus: 'unverified', evidenceLevel: 'none', changeType: 'strengthened', changeReason: 'agent b' } }]
    }), 'REVISION_CONFLICT');
    assert.equal(count(database, 'knowledge_note_versions'), baseline.versions, 'no version written on conflict');
    assert.equal(count(database, 'knowledge_change_sets'), baseline.sets, 'no change set written on conflict');
    assert.equal(currentNote(database, 'note-cc').revision, 2, 'revision must not move');
    // 最新版本仍是 Agent A 的 v2，旧 v1 仍可读
    const [v1, v2] = noteVersionIds(database, 'note-cc');
    assert.equal(noteVersionRow(database, v2.id).statement, 'v2 强化');
    assert.equal(noteVersionRow(database, v1.id).statement, 'v1');
  });
});

// ============================================================================
// 4. 恢复是追加版本：v1→v2→v3 后恢复 v1 得 v4，错误版本与证据链仍可读
// ============================================================================

test('WMB-5210: restore appends a new version (restored from v1) instead of rewriting history', async () => {
  await withDb((database) => {
    seedWorkspace(database);
    applyKnowledgeChangeSet(database, meta({ requestId: 'cs-r1' }), {
      notes: [noteCreate('note-rs', { statement: 'v1 正确版' })]
    });
    applyKnowledgeChangeSet(database, meta({ requestId: 'cs-r2' }), {
      notes: [{ id: 'note-rs', beforeRevision: 1, scope: 'global', kind: 'claim', canonicalKey: 'note-rs-key', title: 'note-rs',
        version: { title: 'note-rs', statement: 'v2 编辑', conclusionStatus: 'unverified', evidenceLevel: 'none', changeType: 'strengthened', changeReason: 'edit' } }]
    });
    applyKnowledgeChangeSet(database, meta({ requestId: 'cs-r3' }), {
      notes: [{ id: 'note-rs', beforeRevision: 2, scope: 'global', kind: 'claim', canonicalKey: 'note-rs-key', title: 'note-rs',
        version: { title: 'note-rs', statement: 'v3 错误编辑', conclusionStatus: 'inference', evidenceLevel: 'none', changeType: 'weakened', changeReason: 'edit' } }]
    });
    const versions = noteVersionIds(database, 'note-rs');
    const [v1, v2, v3] = versions;
    assert.equal(v1.versionNumber, 1); assert.equal(v2.versionNumber, 2); assert.equal(v3.versionNumber, 3);
    const v1Snapshot = noteVersionRow(database, v1.id);
    const v2Snapshot = noteVersionRow(database, v2.id);
    const v3Snapshot = noteVersionRow(database, v3.id);

    // 恢复 V1 → 追加 V4
    applyKnowledgeChangeSet(database, meta({ requestId: 'cs-r4' }), {
      notes: [{ id: 'note-rs', beforeRevision: 3, scope: 'global', kind: 'claim', canonicalKey: 'note-rs-key', title: 'note-rs',
        version: { title: 'note-rs', statement: '恢复 v1 内容', conclusionStatus: 'unverified', evidenceLevel: 'none', changeType: 'restored', changeReason: 'user restore', restoreFromVersionId: v1.id } }]
    });
    const versionsAfter = noteVersionIds(database, 'note-rs');
    assert.equal(versionsAfter.length, 4);
    const v4 = versionsAfter[3];
    assert.equal(v4.versionNumber, 4, 'restore must append version 4');
    const restored = noteVersionRow(database, v4.id);
    assert.equal(restored.changeType, 'restored');
    assert.equal(restored.restoredFromVersionId, v1.id, 'restored version must point at the source version');
    assert.equal(currentNote(database, 'note-rs').currentVersionId, v4.id, 'current pointer must move to v4');
    assert.equal(currentNote(database, 'note-rs').revision, 4);
    // 旧版本仍可读且未被动过
    assert.deepEqual(noteVersionRow(database, v1.id), v1Snapshot);
    assert.deepEqual(noteVersionRow(database, v2.id), v2Snapshot);
    assert.deepEqual(noteVersionRow(database, v3.id), v3Snapshot);
  });
});

// ============================================================================
// 5. merge/supersede 链解析与防循环
// ============================================================================

test('WMB-5210: merged chain resolves to the kept entity and a cycle is rejected with zero writes', async () => {
  await withDb((database) => {
    seedWorkspace(database);
    applyKnowledgeChangeSet(database, meta({ requestId: 'cs-e1' }), {
      entities: [entityCreate('ent-a'), entityCreate('ent-b')]
    });
    // B 并入 A（保留 A）
    applyKnowledgeChangeSet(database, meta({ requestId: 'cs-e2' }), {
      entities: [{ id: 'ent-b', beforeRevision: 1, scope: 'global', entityType: 'organization', canonicalKey: 'ent-b-key', canonicalName: 'ent-b',
        lifecycle: 'merged', mergedIntoEntityId: 'ent-a' }]
    });
    assert.equal(resolveKnowledgeEntity(database, 'ent-b').resolvedId, 'ent-a', 'merged entity must resolve to kept entity');
    assert.equal(resolveKnowledgeEntity(database, 'ent-a').resolvedId, 'ent-a');

    // 再把 A 并入 B 会成环（a→b→a）→ LIFECYCLE_CYCLE，零写
    const baseline = { entities: count(database, 'knowledge_entities'), sets: count(database, 'knowledge_change_sets') };
    expectFailure(() => applyKnowledgeChangeSet(database, meta({ requestId: 'cs-e3' }), {
      entities: [{ id: 'ent-a', beforeRevision: 1, scope: 'global', entityType: 'organization', canonicalKey: 'ent-a-key', canonicalName: 'ent-a',
        lifecycle: 'merged', mergedIntoEntityId: 'ent-b' }]
    }), 'LIFECYCLE_CYCLE');
    assert.equal(count(database, 'knowledge_entities'), baseline.entities, 'no entity written on cycle');
    assert.equal(count(database, 'knowledge_change_sets'), baseline.sets, 'no change set written on cycle');
    assert.equal(resolveKnowledgeEntity(database, 'ent-a').resolvedId, 'ent-a', 'ent-a stays active after rejected merge');
  });
});

test('WMB-5210: supersede chain must not contain a cycle (rejected with zero writes)', async () => {
  await withDb((database) => {
    seedWorkspace(database);
    applyKnowledgeChangeSet(database, meta({ requestId: 'cs-n1' }), {
      notes: [noteCreate('note-s1'), noteCreate('note-s2'), noteCreate('note-s3')]
    });
    const sup = (noteId, supersededBy) => ({
      id: noteId, scope: 'global', kind: 'claim', canonicalKey: `${noteId}-key`, title: noteId,
      lifecycle: 'superseded', supersededByNoteId: supersededBy,
      version: { title: noteId, statement: `${noteId} 内容`, conclusionStatus: 'unverified', evidenceLevel: 'none', changeType: 'superseded', changeReason: 'supersede' }
    });
    applyKnowledgeChangeSet(database, meta({ requestId: 'cs-n2' }), { notes: [{ ...sup('note-s1', 'note-s2'), beforeRevision: 1 }] });
    applyKnowledgeChangeSet(database, meta({ requestId: 'cs-n3' }), { notes: [{ ...sup('note-s2', 'note-s3'), beforeRevision: 1 }] });
    // 既成链正常解析：s1 → s3
    assert.equal(resolveKnowledgeNote(database, 'note-s1').resolvedId, 'note-s3');
    assert.equal(resolveKnowledgeNote(database, 'note-s3').resolvedId, 'note-s3');

    // s3 → s1 会形成 s1→s2→s3→s1 环 → LIFECYCLE_CYCLE，零写
    const baseline = { notes: count(database, 'knowledge_notes'), sets: count(database, 'knowledge_change_sets') };
    expectFailure(() => applyKnowledgeChangeSet(database, meta({ requestId: 'cs-n4' }), {
      notes: [{ ...sup('note-s3', 'note-s1'), beforeRevision: 1 }]
    }), 'LIFECYCLE_CYCLE');
    assert.equal(count(database, 'knowledge_notes'), baseline.notes);
    assert.equal(count(database, 'knowledge_change_sets'), baseline.sets);
    assert.equal(resolveKnowledgeNote(database, 'note-s3').resolvedId, 'note-s3', 'resolver must not follow a cycle');
    assert.equal(resolveKnowledgeNote(database, 'note-s1').resolvedId, 'note-s3', 'existing chain still resolves');
  });
});

// ============================================================================
// 6. 跨 data-root / Scope 隔离
// ============================================================================

test('WMB-5210: change set bound to a different workspace identity is rejected with zero writes', async () => {
  await withDb((database) => {
    seedWorkspace(database, { workspaceId: WS });
    const baseline = { notes: count(database, 'knowledge_notes'), sets: count(database, 'knowledge_change_sets') };
    expectFailure(() => applyKnowledgeChangeSet(database, meta({ workspaceId: 'ws-other-root', requestId: 'cs-xroot' }), {
      notes: [noteCreate('note-xroot')]
    }), 'WORKSPACE_MISMATCH');
    assert.equal(count(database, 'knowledge_notes'), baseline.notes, 'no note written across roots');
    assert.equal(count(database, 'knowledge_change_sets'), baseline.sets, 'no change set written across roots');
  });
});

test('WMB-5210: lane scope must be a registered lane identity; unknown lane scope is rejected', async () => {
  await withDb((database) => {
    seedWorkspace(database, { lanes: ['ai'] });
    // 已注册 lane：成立
    applyKnowledgeChangeSet(database, meta({ requestId: 'cs-lane-ok' }), {
      notes: [noteCreate('note-lane', { scope: 'lane:ai', canonicalKey: 'note-lane-key' })]
    });
    assert.equal(count(database, 'knowledge_notes'), 1);
    const baseline = count(database, 'knowledge_change_sets');
    // 未注册 lane：拒绝，零写
    expectFailure(() => applyKnowledgeChangeSet(database, meta({ requestId: 'cs-lane-bad' }), {
      notes: [noteCreate('note-lane2', { scope: 'lane:ghost', canonicalKey: 'note-lane2-key' })]
    }), 'SCOPE_NOT_REGISTERED');
    assert.equal(count(database, 'knowledge_change_sets'), baseline, 'no change set written for unknown lane');
    assert.equal(count(database, 'knowledge_notes'), 1);
  });
});

// ============================================================================
// 7. 无 AI 硬删除与版本不可变（DB 触发器强制）
// ============================================================================

test('WMB-5210: immutable versions and receipts reject UPDATE/DELETE; knowledge objects forbid hard delete', async () => {
  await withDb((database) => {
    seedWorkspace(database);
    applyKnowledgeChangeSet(database, meta({ requestId: 'cs-imm' }), {
      freeNotes: [{ id: 'fn-imm', scope: 'global', sourceNature: 'user_quick_note', body: '批注原文', processingState: 'captured' }],
      notes: [noteCreate('note-imm')],
      entities: [entityCreate('ent-imm')],
      wikiPages: [pageCreate('page-imm')],
      relations: [{ op: 'create', id: 'rel-imm', scope: 'global', relationKey: 'about', fromObjectType: 'knowledge_note', fromObjectId: 'note-imm', toObjectType: 'knowledge_entity', toObjectId: 'ent-imm' }],
      receipts: [{ triggerType: 'lint', requestId: 'cs-imm', summary: '不可变回执', counts: {} }]
    });
    const [v1] = noteVersionIds(database, 'note-imm');

    assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1, 'foreign keys must be on');

    assert.throws(() => database.prepare(`UPDATE knowledge_note_versions SET statement='篡改' WHERE id=?`).run(v1.id), /KNOWLEDGE_VERSION_IMMUTABLE/);
    assert.throws(() => database.prepare(`DELETE FROM knowledge_note_versions WHERE id=?`).run(v1.id), /KNOWLEDGE_VERSION_IMMUTABLE/);
    assert.throws(() => database.prepare(`UPDATE knowledge_change_sets SET reason='x' WHERE id=(SELECT change_set_id FROM knowledge_note_versions WHERE id=?)`).run(v1.id), /KNOWLEDGE_CHANGE_SET_IMMUTABLE/);
    assert.throws(() => database.prepare(`DELETE FROM knowledge_change_sets WHERE id=(SELECT change_set_id FROM knowledge_note_versions WHERE id=?)`).run(v1.id), /KNOWLEDGE_CHANGE_SET_IMMUTABLE/);
    assert.throws(() => database.prepare(`UPDATE knowledge_update_receipts SET summary='x'`).run(), /KNOWLEDGE_RECEIPT_IMMUTABLE/);
    assert.throws(() => database.prepare(`DELETE FROM knowledge_update_receipts`).run(), /KNOWLEDGE_RECEIPT_IMMUTABLE/);
    assert.throws(() => database.prepare(`UPDATE knowledge_free_notes SET body='改写原文' WHERE id='fn-imm'`).run(), /KNOWLEDGE_FREE_NOTE_TEXT_IMMUTABLE/);
    assert.throws(() => database.prepare(`DELETE FROM knowledge_entities WHERE id='ent-imm'`).run(), /KNOWLEDGE_OBJECT_DELETE_FORBIDDEN/);
    assert.throws(() => database.prepare(`DELETE FROM knowledge_notes WHERE id='note-imm'`).run(), /KNOWLEDGE_OBJECT_DELETE_FORBIDDEN/);
    assert.throws(() => database.prepare(`DELETE FROM knowledge_wiki_pages WHERE id='page-imm'`).run(), /KNOWLEDGE_OBJECT_DELETE_FORBIDDEN/);
    assert.throws(() => database.prepare(`DELETE FROM knowledge_formal_relations WHERE 1=1`).run(), /KNOWLEDGE_OBJECT_DELETE_FORBIDDEN/);
    // 版本内容原样可读，无任何行被破坏
    assert.equal(noteVersionRow(database, v1.id).statement, 'statement');
    assert.equal(count(database, 'knowledge_notes'), 1);
    assert.equal(count(database, 'knowledge_change_sets'), 1);
  });
});
