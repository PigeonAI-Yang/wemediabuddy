/**
 * WMB-5210 M1 知识飞轮存储契约验收（子进程，真实 SQLite）。
 * 验收：旧 schema fixture 幂等迁移；原子提交失败零部分写；并发旧 revision 拒绝；
 * 同 requestId 重放零增量且返回同一回执；恢复 V1 后追加 V4；merge/supersede 无循环；
 * 跨 data-root/lane 拒绝；不可变版本/无硬删除/状态矩阵/真实引用校验。
 * 退出码 0 = 全部通过；任何断言失败抛错并以非 0 退出。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase, migrations } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';
import {
  applyKnowledgeChangeSet, getKnowledgeNote, getKnowledgeEntity,
  getUpdateReceiptByRequest, listChangeSets, listKnowledgeEntities, listKnowledgeNoteVersions,
  listKnowledgeRelations, listKnowledgeEvidenceLinks, listKnowledgeAnnotations, listHealthIssues,
  listRelationRegistry, getQueryArtifactByRequest, resolveKnowledgeEntity, resolveKnowledgeNote,
  KNOWLEDGE_FLYWHEEL_CHANGE_SET_COMMAND
} from '../src/main/knowledge-flywheel.ts';

const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-5210-db-'));
const directoryPath = path.join(directory, 'wmb.db');

let checks = 0;
function check(label, condition, detail = '') {
  checks += 1;
  if (!condition) throw new Error(`FAIL [${checks}] ${label}${detail ? ` — ${detail}` : ''}`);
}
async function expectError(label, fn, code) {
  checks += 1;
  try {
    await fn();
  } catch (error) {
    if (code) {
      const actual = error?.code ?? '';
      if (actual !== code) throw new Error(`FAIL [${checks}] ${label} — 期望错误码 ${code}，实际 ${actual ?? error?.message}`);
    }
    return;
  }
  throw new Error(`FAIL [${checks}] ${label} — 未抛出 ${code ?? '错误'}`);
}
function count(database, table) {
  return Number(database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count);
}
function meta(requestId, workspaceId = 'ws-a') {
  return { workspaceId, requestId, reason: '测试原因', triggerSource: 'ingest', resolutionMode: 'none', createdBy: 'background_agent' };
}

// ============ 1. 旧 schema fixture：v1..v55 已应用，v56 幂等追加，画布 knowledge_relations 不冲突 ============
{
  const fixture = new DatabaseSync(directoryPath);
  const legacy = migrations.filter((migration) => migration.version <= 55);
  fixture.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  fixture.exec('PRAGMA foreign_keys = OFF');
  for (const migration of legacy) {
    fixture.exec('BEGIN IMMEDIATE');
    try {
      fixture.exec(migration.sql);
      fixture.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, new Date().toISOString());
      fixture.exec('COMMIT');
    } catch (error) {
      fixture.exec('ROLLBACK');
      throw new Error(`旧 schema fixture v${migration.version} 应用失败：${error}`);
    }
  }
  fixture.exec('PRAGMA foreign_keys = ON');
  check('fixture 停在 v55', Number(fixture.prepare('SELECT max(version) AS m FROM schema_migrations').get().m) === 55);

  // 既有画布关系表（v18/v21）存在且可写 —— v56 必须与它共存
  const canvasStamp = new Date().toISOString();
  fixture.prepare("INSERT INTO knowledge_canvases (id, title, created_at, updated_at) VALUES ('canvas-1', '旧画布', ?, ?)").run(canvasStamp, canvasStamp);
  fixture.prepare(`INSERT INTO knowledge_canvas_nodes (id, canvas_id, object_type, object_id, note_title, note_text, x, y, created_at, updated_at)
    VALUES ('cn-1', 'canvas-1', 'note', NULL, '旧笔记', '旧正文', 0, 0, ?, ?)`).run(canvasStamp, canvasStamp);
  fixture.prepare(`INSERT INTO knowledge_canvas_nodes (id, canvas_id, object_type, object_id, note_title, note_text, x, y, created_at, updated_at)
    VALUES ('cn-2', 'canvas-1', 'note', NULL, '旧笔记二', '旧正文二', 10, 10, ?, ?)`).run(canvasStamp, canvasStamp);
  const canvasRelationId = 'canvas-rel-1';
  fixture.prepare(`INSERT INTO knowledge_relations (id, canvas_id, from_node_id, to_node_id, relation_type, created_at, updated_at)
    VALUES (?, 'canvas-1', 'cn-1', 'cn-2', 'custom', ?, ?)`).run(canvasRelationId, canvasStamp, canvasStamp);
  const source = upsertSource(fixture, { originalUrl: 'https://legacy.example/1', title: '旧资料' });

  // 第二次打开：migrateDatabase 只补 v56（幂等，不重跑已应用版本）
  const migrated = migrateDatabase(directoryPath);
  check('migrateDatabase 补齐 v56-v58', migrated.prepare('SELECT max(version) AS m FROM schema_migrations').get().m === 58);
  check('画布 knowledge_relations 仍可读（无表名冲突）', migrated.prepare('SELECT relation_type AS t FROM knowledge_relations WHERE id = ?').get(canvasRelationId).t === 'custom');
  check('画布关系列语义未变（from_node_id）', migrated.prepare('SELECT from_node_id AS f FROM knowledge_relations WHERE id = ?').get(canvasRelationId).f === 'cn-1');  check('旧资料保留', migrated.prepare('SELECT id FROM source_items WHERE id = ?').get(source.id) !== undefined);
  check('正式关系表为 knowledge_formal_relations', migrated.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='knowledge_formal_relations'").get().c === 1);
  check('迁移总数 = 58', count(migrated, 'schema_migrations') === 58);
  const reopened = migrateDatabase(directoryPath);
  check('重开幂等', count(reopened, 'schema_migrations') === 58);
  reopened.close();
  migrated.close();
  fixture.close();
}

const database = migrateDatabase(directoryPath);
database.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', 'ws-a', ?, ?, 1)").run(new Date().toISOString(), new Date().toISOString());
// 注册一个既有赛道身份，供 lane scope 校验
{
  const source = upsertSource(database, { originalUrl: 'https://lane.example/1', title: '赛道资料' });
  database.prepare(`INSERT INTO source_lane_judgments (id, source_id, workspace_lane, decision, reason_code, reason, judged_by, confidence, source_revision, judged_at)
    VALUES (?, ?, 'uk-life-content-radar', 'relevant', 'lane_relevant', NULL, 'editor', NULL, 1, ?)`)
    .run('lane-judg-1', source.id, new Date().toISOString());
}

// ============ 2. 原子 ChangeSet：一次创建全部对象，失败零部分写 ============
{
  const full = {
    freeNotes: [{ id: 'fn-1', scope: 'global', sourceNature: 'user_quick_note', body: '用户原始记录原文' }],
    entities: [{ id: 'ent-a', scope: 'global', entityType: 'organization', canonicalKey: 'acme', canonicalName: 'Acme', aliases: ['ACME 集团'] }],
    notes: [{
      id: 'note-a', scope: 'global', kind: 'claim', canonicalKey: 'acme-claim-1',
      version: { statement: 'Acme 发布了新产品', conclusionStatus: 'supported', evidenceLevel: 'primary', adoptedEntityIds: ['ent-a'] }
    }],
    wikiPages: [{
      id: 'page-a', scope: 'global', pageType: 'entity', canonicalKey: 'wiki-acme', subjectType: 'entity', subjectId: 'ent-a',
      version: { body: { summary: 'Acme 页面' }, changeSummary: '首版', compileReason: '测试' }
    }],
    receipts: [{ triggerType: 'ingest', requestId: 'ingest-full', summary: '完整摄取', counts: { notes: 1, entities: 1, wikiPages: 1 } }]
  };
  const result = applyKnowledgeChangeSet(database, meta('cs-full'), full);
  check('原子创建返回 changeSetId', Boolean(result.changeSetId));
  check('逐对象 revision 明细', result.revisions['note-a'] === 1 && result.revisions['ent-a'] === 1 && result.revisions['page-a'] === 1);
  check('同 ChangeSet 内生成回执', result.receipt?.triggerType === 'ingest' && result.receipt.counts.notes === 1);

  const note = getKnowledgeNote(database, 'note-a');
  check('note 当前版本指针', note.note.currentVersionId === note.version.id && note.version.versionNumber === 1);
  check('wiki 页面版本采用 Note 版本', getWikiPageVersionNumber(database, 'page-a') === 1);

  // 失败零部分写：先建 FreeNote，随后引用不存在的实体 → 整体回滚
  const before = count(database, 'knowledge_free_notes');
  await expectError('原子失败零部分写', async () => {
    applyKnowledgeChangeSet(database, meta('cs-bad'), {
      freeNotes: [{ id: 'fn-bad', scope: 'global', sourceNature: 'user_quick_note', body: '不应落库' }],
      notes: [{ id: 'note-bad', scope: 'global', kind: 'claim', canonicalKey: 'bad-claim', version: { statement: 'x', conclusionStatus: 'supported', evidenceLevel: 'primary', adoptedEntityIds: ['missing-entity'] } }]
    });
  }, 'OBJECT_NOT_FOUND');
  check('失败后零部分写（FreeNote 未落库）', count(database, 'knowledge_free_notes') === before);
  check('失败后零部分写（ChangeSet 未落库）', count(database, 'knowledge_change_sets') === 1);

  // 真实引用校验：证据对象必须存在
  await expectError('证据对象真实引用', async () => {
    applyKnowledgeChangeSet(database, meta('cs-bad-evidence'), {
      evidenceLinks: [{ knowledgeNoteVersionId: note.version.id, evidenceObjectType: 'source', evidenceObjectId: 'ghost-source', relation: 'supports', sourceNature: 'primary_source' }]
    });
  }, 'OBJECT_NOT_FOUND');
  check('证据失败零写', count(database, 'knowledge_evidence_links') === 0);
}

// ============ 3. requestId 幂等：重放零增量且返回同一回执；同 requestId 不同输入拒绝 ============
{
  const input = {
    notes: [{ id: 'note-dup', scope: 'global', kind: 'concept', canonicalKey: 'concept-dup', version: { statement: '概念定义', conclusionStatus: 'unverified', evidenceLevel: 'none' } }],
    receipts: [{ triggerType: 'query', requestId: 'query-dup', summary: '同请求回执', counts: { notes: 1 } }]
  };
  const first = applyKnowledgeChangeSet(database, meta('cs-dup'), input);
  const replay = applyKnowledgeChangeSet(database, meta('cs-dup'), input);
  check('重放返回 replay=true', replay.replay === true);
  check('重放返回同一 changeSetId', replay.changeSetId === first.changeSetId);
  check('重放返回同一回执', replay.receipt?.id === first.receipt?.id && replay.receipt?.requestId === 'query-dup');
  check('重放零新增版本', listKnowledgeNoteVersions(database, 'note-dup', {}).items.length === 1);
  check('重放零新增 ChangeSet', count(database, 'knowledge_change_sets') === 2);
  check('按 request 读回同一回执', getUpdateReceiptByRequest(database, 'ws-a', 'query-dup')?.id === first.receipt?.id);

  await expectError('同 requestId 不同输入拒绝', async () => {
    applyKnowledgeChangeSet(database, meta('cs-dup'), {
      notes: [{ id: 'note-dup', scope: 'global', kind: 'concept', canonicalKey: 'concept-dup', version: { statement: '不同内容', conclusionStatus: 'unverified', evidenceLevel: 'none' } }]
    });
  }, 'REQUEST_REPLAY_CONFLICT');
}

// ============ 4. 版本连续 + 并发旧 revision 拒绝 + 恢复追加 ============
{
  applyKnowledgeChangeSet(database, meta('cs-v1'), {
    notes: [{ id: 'note-v', scope: 'global', kind: 'claim', canonicalKey: 'v-claim', version: { statement: 'V1 表述', conclusionStatus: 'unverified', evidenceLevel: 'none' } }]
  });
  const state = getKnowledgeNote(database, 'note-v');
  check('V1 创建 revision=1', state.note.revision === 1 && state.version.versionNumber === 1);

  applyKnowledgeChangeSet(database, meta('cs-v2'), {
    notes: [{ id: 'note-v', scope: 'global', kind: 'claim', canonicalKey: 'v-claim', beforeRevision: 1, version: { statement: 'V2 加强', conclusionStatus: 'supported', evidenceLevel: 'corroborated', changeType: 'strengthened' } }]
  });
  const v2 = getKnowledgeNote(database, 'note-v');
  check('V2 追加 revision=2', v2.note.revision === 2 && v2.version.versionNumber === 2);

  // 并发：两个编译基于同一旧 revision=2 → 第一个成功，第二个零写拒绝
  applyKnowledgeChangeSet(database, meta('cs-v3a'), {
    notes: [{ id: 'note-v', scope: 'global', kind: 'claim', canonicalKey: 'v-claim', beforeRevision: 2, version: { statement: 'V3A', conclusionStatus: 'supported', evidenceLevel: 'single', changeType: 'strengthened' } }]
  });
  const afterA = count(database, 'knowledge_note_versions');
  await expectError('并发旧 revision 拒绝', async () => {
    applyKnowledgeChangeSet(database, meta('cs-v3b'), {
      notes: [{ id: 'note-v', scope: 'global', kind: 'claim', canonicalKey: 'v-claim', beforeRevision: 2, version: { statement: 'V3B 不应落库', conclusionStatus: 'supported', evidenceLevel: 'single', changeType: 'strengthened' } }]
    });
  }, 'REVISION_CONFLICT');
  check('冲突方零新增版本', count(database, 'knowledge_note_versions') === afterA);
  const v3 = getKnowledgeNote(database, 'note-v');
  check('冲突方版本未覆盖', v3.version.statement === 'V3A' && v3.note.revision === 3);

  // 恢复 V1 → 追加 V4，旧版本仍可读
  applyKnowledgeChangeSet(database, meta('cs-v4-restore'), {
    notes: [{ id: 'note-v', scope: 'global', kind: 'claim', canonicalKey: 'v-claim', beforeRevision: 3, version: { restoreFromVersionId: state.version.id, changeReason: '用户要求恢复 V1' } }]
  });
  const v4 = getKnowledgeNote(database, 'note-v');
  check('恢复后 revision=4', v4.note.revision === 4);
  check('恢复追加 V4 且 changeType=restored', v4.version.versionNumber === 4 && v4.version.changeType === 'restored');
  check('V4 记录 restoredFromVersionId', v4.version.restoredFromVersionId === state.version.id);
  check('V4 内容来自 V1', v4.version.statement === 'V1 表述' && v4.version.conclusionStatus === 'unverified');
  const versions = listKnowledgeNoteVersions(database, 'note-v', {});
  check('V1..V4 全部保留可读', versions.items.length === 4 && versions.items.some((v) => v.versionNumber === 1) && versions.items.some((v) => v.versionNumber === 4));
  const v1 = versions.items.find((v) => v.versionNumber === 1);
  check('V1 不可变（原表述保留）', v1.statement === 'V1 表述');
}

// ============ 5. merge/supersede 无循环 + 解析 ============
{
  applyKnowledgeChangeSet(database, meta('cs-entity'), {
    entities: [
      { id: 'ent-1', scope: 'global', entityType: 'organization', canonicalKey: 'org-a', canonicalName: 'Org A' },
      { id: 'ent-2', scope: 'global', entityType: 'organization', canonicalKey: 'org-b', canonicalName: 'Org B' },
      { id: 'ent-3', scope: 'global', entityType: 'organization', canonicalKey: 'org-c', canonicalName: 'Org C' }
    ]
  });
  applyKnowledgeChangeSet(database, meta('cs-merge-ab'), {
    entities: [{ id: 'ent-1', scope: 'global', entityType: 'organization', canonicalKey: 'org-a', canonicalName: 'Org A', beforeRevision: 1, lifecycle: 'merged', mergedIntoEntityId: 'ent-2' }]
  });
  const resolutionA = resolveKnowledgeEntity(database, 'ent-1');
  check('A 解析到 B', resolutionA.resolvedId === 'ent-2' && resolutionA.originalId === 'ent-1' && resolutionA.hops.length === 1);
  applyKnowledgeChangeSet(database, meta('cs-supersede-bc'), {
    entities: [{ id: 'ent-2', scope: 'global', entityType: 'organization', canonicalKey: 'org-b', canonicalName: 'Org B', beforeRevision: 1, lifecycle: 'superseded', supersededByEntityId: 'ent-3' }]
  });
  const resolutionA2 = resolveKnowledgeEntity(database, 'ent-1');
  check('A → B → C 链式解析', resolutionA2.resolvedId === 'ent-3' && resolutionA2.hops.join(',') === 'ent-2,ent-3');

  await expectError('反向合并成环拒绝', async () => {
    applyKnowledgeChangeSet(database, meta('cs-cycle-ba'), {
      entities: [{ id: 'ent-3', scope: 'global', entityType: 'organization', canonicalKey: 'org-c', canonicalName: 'Org C', beforeRevision: 1, lifecycle: 'merged', mergedIntoEntityId: 'ent-1' }]
    });
  }, 'LIFECYCLE_CYCLE');
  await expectError('自合并拒绝', async () => {
    applyKnowledgeChangeSet(database, meta('cs-cycle-self'), {
      entities: [{ id: 'ent-3', scope: 'global', entityType: 'organization', canonicalKey: 'org-c', canonicalName: 'Org C', beforeRevision: 1, lifecycle: 'merged', mergedIntoEntityId: 'ent-3' }]
    });
  }, 'LIFECYCLE_CYCLE');
  check('成环尝试零写（Entity 数不变）', count(database, 'knowledge_entities') === 4);

  // Note 链：n1 merged → n2，resolve 跟随
  applyKnowledgeChangeSet(database, meta('cs-note-merge'), {
    notes: [
      { id: 'n-1', scope: 'global', kind: 'insight', canonicalKey: 'ins-1', version: { statement: '洞察一', conclusionStatus: 'unverified', evidenceLevel: 'none' } },
      { id: 'n-2', scope: 'global', kind: 'insight', canonicalKey: 'ins-2', version: { statement: '洞察二', conclusionStatus: 'unverified', evidenceLevel: 'none' } }
    ]
  });
  applyKnowledgeChangeSet(database, meta('cs-note-merge-apply'), {
    notes: [{ id: 'n-1', scope: 'global', kind: 'insight', canonicalKey: 'ins-1', beforeRevision: 1, lifecycle: 'merged', mergedIntoNoteId: 'n-2', version: { statement: '洞察一合并标记', conclusionStatus: 'unverified', evidenceLevel: 'none', changeType: 'merged' } }]
  });
  check('Note 解析跟随合并链', resolveKnowledgeNote(database, 'n-1').resolvedId === 'n-2');
}

// ============ 6. 跨 data-root / lane 隔离 ============
{
  await expectError('跨 data-root 拒绝（workspace 不匹配）', async () => {
    applyKnowledgeChangeSet(database, meta('cs-cross-root', 'ws-b'), {
      freeNotes: [{ id: 'fn-cross', scope: 'global', sourceNature: 'user_quick_note', body: '不得跨 root' }]
    });
  }, 'WORKSPACE_MISMATCH');
  check('跨 root 零写', count(database, 'knowledge_free_notes') === 1);

  await expectError('未注册 lane 拒绝', async () => {
    applyKnowledgeChangeSet(database, meta('cs-ghost-lane'), {
      notes: [{ id: 'note-lane', scope: 'lane:ghost-lane', kind: 'claim', canonicalKey: 'lane-claim', version: { statement: 'x', conclusionStatus: 'unverified', evidenceLevel: 'none' } }]
    });
  }, 'SCOPE_NOT_REGISTERED');
  check('幽灵 lane 零写', count(database, 'knowledge_notes') === 5);

  // 已注册赛道身份可写
  applyKnowledgeChangeSet(database, meta('cs-real-lane'), {
    notes: [{ id: 'note-lane-ok', scope: 'lane:uk-life-content-radar', kind: 'claim', canonicalKey: 'lane-claim-ok', version: { statement: '赛道知识', conclusionStatus: 'unverified', evidenceLevel: 'none' } }]
  });
  check('已注册 lane 可写', getKnowledgeNote(database, 'note-lane-ok').note.scope === 'lane:uk-life-content-radar');
}

// ============ 7. 不可变版本 / 无硬删除 / FreeNote 原文不可变 ============
{
  const v = getKnowledgeNote(database, 'note-v').version;
  await expectError('版本 UPDATE 拒绝', async () => {
    database.prepare('UPDATE knowledge_note_versions SET statement = ? WHERE id = ?').run('篡改', v.id);
  });
  await expectError('版本 DELETE 拒绝', async () => {
    database.prepare('DELETE FROM knowledge_note_versions WHERE id = ?').run(v.id);
  });
  await expectError('正式对象 DELETE 拒绝（无 AI 硬删除）', async () => {
    database.prepare('DELETE FROM knowledge_notes WHERE id = ?').run('note-v');
  });
  await expectError('ChangeSet 不可变', async () => {
    const cs = database.prepare('SELECT id FROM knowledge_change_sets LIMIT 1').get();
    database.prepare('UPDATE knowledge_change_sets SET reason = ? WHERE id = ?').run('篡改', cs.id);
  });
  await expectError('FreeNote 原文 UPDATE 拒绝', async () => {
    database.prepare('UPDATE knowledge_free_notes SET body = ? WHERE id = ?').run('改写原文', 'fn-1');
  });
  applyKnowledgeChangeSet(database, meta('cs-fn-transition'), {
    freeNoteTransitions: [{ id: 'fn-1', beforeRevision: 1, processingState: 'processed', processingReason: '已知识化' }]
  });
  check('FreeNote 处理状态可变更（原文不可变）', getFreeNoteRevision(database, 'fn-1') === 2);
}

// ============ 8. 状态矩阵与证据边界 ============
{
  await expectError('Question 不能标记 supported', async () => {
    applyKnowledgeChangeSet(database, meta('cs-question-bad'), {
      notes: [{ id: 'q-1', scope: 'global', kind: 'question', canonicalKey: 'q-1', version: { statement: '待研究', conclusionStatus: 'supported', evidenceLevel: 'single' } }]
    });
  }, 'VERSION_STATUS_INVALID');
  await expectError('证据 none 不能标记 supported（DB CHECK）', async () => {
    applyKnowledgeChangeSet(database, meta('cs-evidence-bad'), {
      notes: [{ id: 'n-ev-bad', scope: 'global', kind: 'claim', canonicalKey: 'n-ev-bad', version: { statement: '无证据却宣称支持', conclusionStatus: 'supported', evidenceLevel: 'none' } }]
    });
  });
  check('状态矩阵失败零写', count(database, 'knowledge_notes') === 6);
  applyKnowledgeChangeSet(database, meta('cs-inference-ok'), {
    notes: [{ id: 'n-inf', scope: 'global', kind: 'claim', canonicalKey: 'n-inf', version: { statement: 'AI 推断', conclusionStatus: 'inference', evidenceLevel: 'none' } }]
  });
  check('inference+none 合法', getKnowledgeNote(database, 'n-inf').version.conclusionStatus === 'inference');
}

// ============ 9. 关系注册表 + 扩展关系 + 终结 ============
{
  const registry = listRelationRegistry(database, {});
  check('核心关系词典 21 条', registry.items.length === 21 && registry.items.every((entry) => !entry.extension));
  await expectError('未知关系拒绝', async () => {
    applyKnowledgeChangeSet(database, meta('cs-rel-unknown'), {
      relations: [{ op: 'create', scope: 'global', relationKey: 'influences_xyz', fromObjectType: 'knowledge_note', fromObjectId: 'note-a', toObjectType: 'knowledge_note', toObjectId: 'note-dup' }]
    });
  }, 'RELATION_NOT_IN_REGISTRY');
  await expectError('端点类型不匹配拒绝', async () => {
    applyKnowledgeChangeSet(database, meta('cs-rel-badtype'), {
      relations: [{ op: 'create', scope: 'global', relationKey: 'uses_method', fromObjectType: 'knowledge_entity', fromObjectId: 'ent-2', toObjectType: 'knowledge_note', toObjectId: 'note-a' }]
    });
  }, 'RELATION_ENDPOINT_INVALID');
  await expectError('端点不存在拒绝', async () => {
    applyKnowledgeChangeSet(database, meta('cs-rel-missing'), {
      relations: [{ op: 'create', scope: 'global', relationKey: 'supports', fromObjectType: 'knowledge_note', fromObjectId: 'ghost-note', toObjectType: 'knowledge_note', toObjectId: 'note-a' }]
    });
  }, 'RELATION_ENDPOINT_NOT_FOUND');

  applyKnowledgeChangeSet(database, meta('cs-rel-ok'), {
    relations: [{ op: 'create', scope: 'global', relationKey: 'supports', fromObjectType: 'knowledge_note', fromObjectId: 'note-a', toObjectType: 'knowledge_note', toObjectId: 'note-dup' }]
  });
  const activeRelations = listKnowledgeRelations(database, { fromObjectId: 'note-a' }).items.filter((r) => !r.endedChangeSetId);
  check('核心关系创建', activeRelations.length === 1 && activeRelations[0].relationKey === 'supports');
  applyKnowledgeChangeSet(database, meta('cs-rel-end'), {
    relations: [{ op: 'end', id: activeRelations[0].id, reason: '表述实质变化，重建关系' }]
  });
  const ended = listKnowledgeRelations(database, { fromObjectId: 'note-a' }).items.find((r) => r.id === activeRelations[0].id);
  check('关系终结保留历史', Boolean(ended.endedChangeSetId) && ended.endReason === '表述实质变化，重建关系');

  applyKnowledgeChangeSet(database, meta('cs-ext-reg'), {
    extensionRelations: [{ relationKey: 'extension:test:synergizes_with', displayName: '协同', fromTypes: ['knowledge_note'], toTypes: ['knowledge_note'], reason: '测试扩展关系' }]
  });
  check('扩展关系入注册表', listRelationRegistry(database, { extension: true }).items.some((entry) => entry.relationKey === 'extension:test:synergizes_with'));
  applyKnowledgeChangeSet(database, meta('cs-ext-use'), {
    relations: [{ op: 'create', scope: 'global', relationKey: 'extension:test:synergizes_with', fromObjectType: 'knowledge_note', fromObjectId: 'note-a', toObjectType: 'knowledge_note', toObjectId: 'n-2' }]
  });
  check('扩展关系可用', listKnowledgeRelations(database, { relationKey: 'extension:test:synergizes_with' }).items.length === 1);
}

// ============ 10. EvidenceLink 派生知识边界 + Wiki stale/恢复 ============
{
  const note = getKnowledgeNote(database, 'note-a');
  await expectError('非 derived_knowledge 不能指向 Note 版本（DB CHECK）', async () => {
    applyKnowledgeChangeSet(database, meta('cs-ev-mislabel'), {
      evidenceLinks: [{ knowledgeNoteVersionId: note.version.id, evidenceObjectType: 'knowledge_note_version', evidenceObjectId: note.version.id, relation: 'derived_from', sourceNature: 'primary_source' }]
    });
  });
  applyKnowledgeChangeSet(database, meta('cs-ev-ok'), {
    evidenceLinks: [
      { knowledgeNoteVersionId: note.version.id, evidenceObjectType: 'knowledge_note_version', evidenceObjectId: note.version.id, relation: 'derived_from', sourceNature: 'derived_knowledge', excerpt: '派生自同库版本' },
      { knowledgeNoteVersionId: note.version.id, evidenceObjectType: 'source', evidenceObjectId: getFirstSourceId(database), relation: 'supports', sourceNature: 'primary_source', locator: 'L12-18' }
    ]
  });
  check('版本级证据可读', listKnowledgeEvidenceLinks(database, { noteVersionId: note.version.id }).items.length === 2);

  applyKnowledgeChangeSet(database, meta('cs-page-stale'), {
    wikiPages: [{ id: 'page-a', scope: 'global', pageType: 'entity', canonicalKey: 'wiki-acme', subjectType: 'entity', subjectId: 'ent-a', beforeRevision: 1, markStaleInstead: { reason: 'Acme 知识已变化，等待重编译' } }]
  });
  const page = getWikiPageRecord(database, 'page-a');
  check('页面显式 stale 并记录原因', page.compileStatus === 'stale' && page.compileNote === 'Acme 知识已变化，等待重编译');
  check('stale 不产生新版本', count(database, 'knowledge_wiki_page_versions') === 1);

  applyKnowledgeChangeSet(database, meta('cs-page-v2'), {
    wikiPages: [{ id: 'page-a', scope: 'global', pageType: 'entity', canonicalKey: 'wiki-acme', subjectType: 'entity', subjectId: 'ent-a', beforeRevision: page.revision, version: { body: { summary: 'Acme 新页面' }, changeSummary: '重编译', compileReason: '测试' } }]
  });
  const page2 = getWikiPageRecord(database, 'page-a');
  check('页面新版本恢复 current', page2.compileStatus === 'current' && count(database, 'knowledge_wiki_page_versions') === 2);
  applyKnowledgeChangeSet(database, meta('cs-page-restore'), {
    wikiPages: [{ id: 'page-a', scope: 'global', pageType: 'entity', canonicalKey: 'wiki-acme', subjectType: 'entity', subjectId: 'ent-a', beforeRevision: page2.revision, version: { body: {}, changeSummary: '', compileReason: '', restoreFromVersionId: getFirstPageVersionId(database, 'page-a') } }]
  });
  const page3 = getWikiPageRecord(database, 'page-a');
  check('页面恢复为追加版本', count(database, 'knowledge_wiki_page_versions') === 3 && page3.currentVersionId !== page2.currentVersionId);
}

// ============ 11. Annotation 原文不可变 + 幂等回执/QueryArtifact + HealthIssue ============
{
  const note = getKnowledgeNote(database, 'note-a');
  applyKnowledgeChangeSet(database, meta('cs-ann-create'), {
    annotations: [{ op: 'create', scope: 'global', targetType: 'knowledge_note_version', targetId: note.version.id, quotedText: 'Acme 发布了新产品', intent: 'correction', body: '表述需要限域', userIdentity: 'owner@local' }]
  });
  const anns = listKnowledgeAnnotations(database, { targetType: 'knowledge_note_version', targetId: note.version.id }).items;
  check('批注创建', anns.length === 1 && anns[0].intent === 'correction');
  await expectError('批注原文不可修改', async () => {
    database.prepare('UPDATE knowledge_annotations SET body = ? WHERE id = ?').run('篡改批注', anns[0].id);
  });
  applyKnowledgeChangeSet(database, meta('cs-ann-process'), {
    annotations: [{ op: 'process', id: anns[0].id, processingState: 'processed', migrationState: 'migrated' }]
  });
  const processed = listKnowledgeAnnotations(database, { targetType: 'knowledge_note_version', targetId: note.version.id }).items[0];
  check('批注处理状态变更且保留原文', processed.processingState === 'processed' && processed.migrationState === 'migrated' && processed.body === '表述需要限域');

  applyKnowledgeChangeSet(database, meta('cs-artifact'), {
    queryArtifacts: [{ scope: 'global', requestId: 'query-art-1', question: 'Acme 是否发布了新产品？', answerSummary: '是', readNoteVersionIds: [note.version.id], writeBackDecision: 'no_write_back', skipReason: '纯复述' }]
  });
  check('QueryArtifact 可读', getQueryArtifactByRequest(database, 'query-art-1')?.writeBackDecision === 'no_write_back');
  applyKnowledgeChangeSet(database, meta('cs-artifact-2'), {
    queryArtifacts: [{ scope: 'global', requestId: 'query-art-1', question: '重复问题', answerSummary: '重复', writeBackDecision: 'skipped_repetition' }]
  });
  check('QueryArtifact 同 request 幂等（不重复行）', count(database, 'knowledge_query_artifacts') === 1);

  const receiptBefore = count(database, 'knowledge_update_receipts');
  applyKnowledgeChangeSet(database, meta('cs-receipt-replay'), {
    receipts: [{ triggerType: 'ingest', requestId: 'ingest-full', summary: '重复回执不应落库', counts: {} }]
  });
  check('Receipt 同 request 幂等', count(database, 'knowledge_update_receipts') === receiptBefore);

  applyKnowledgeChangeSet(database, meta('cs-health-open'), {
    healthIssues: [{ op: 'create', scope: 'global', issueType: 'stale_wiki_page', affectedObjectType: 'wiki_page', affectedObjectId: 'page-a', severity: 'medium', suggestedAction: '重编译' }]
  });
  const issues = listHealthIssues(database, { issueType: 'stale_wiki_page' }).items;
  check('HealthIssue 创建为 open', issues.length === 1 && issues[0].status === 'open');
  await expectError('HealthIssue 硬删拒绝', async () => {
    database.prepare('DELETE FROM knowledge_health_issues WHERE id = ?').run(issues[0].id);
  });
  applyKnowledgeChangeSet(database, meta('cs-health-resolve'), {
    healthIssues: [{ op: 'update', id: issues[0].id, beforeRevision: 1, status: 'resolved', resolutionNote: '已重编译' }]
  });
  const resolved = listHealthIssues(database, { status: 'resolved' }).items[0];
  check('HealthIssue 可终结且保留', resolved.status === 'resolved' && resolved.resolutionNote === '已重编译');
}

// ============ 12. 接线元数据完整性 + 有界读 ============
{
  check('写命令常量', KNOWLEDGE_FLYWHEEL_CHANGE_SET_COMMAND === 'knowledge_flywheel.change_set_apply');
  check('ChangeSet 列表有界信封', listChangeSets(database, { limit: 2 }).items.length <= 2);
  const entityList = listKnowledgeEntities(database, { scope: 'global', limit: 5 });
  check('Entity 列表信封', Array.isArray(entityList.items) && entityList.total >= 4 && entityList.hasMore === false);
  check('relation registry 全量可读', listRelationRegistry(database, { limit: 100 }).items.length >= 21);
  check('getKnowledgeEntity 含解析', getKnowledgeEntity(database, 'ent-1')?.resolution.resolvedId === 'ent-3');
}

database.close();
console.log(`WMB-5210 child: ${checks} checks passed`);
await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });

// ---- helpers ----
function getWikiPageVersionNumber(database, pageId) {
  const page = database.prepare('SELECT current_version_id AS c FROM knowledge_wiki_pages WHERE id = ?').get(pageId);
  if (!page?.c) return null;
  const version = database.prepare('SELECT version_number AS v FROM knowledge_wiki_page_versions WHERE id = ?').get(page.c);
  return version?.v ?? null;
}
function getWikiPageRecord(database, pageId) {
  return database.prepare('SELECT id, revision, compile_status AS compileStatus, compile_note AS compileNote, current_version_id AS currentVersionId FROM knowledge_wiki_pages WHERE id = ?').get(pageId);
}
function getFirstPageVersionId(database, pageId) {
  return database.prepare('SELECT id FROM knowledge_wiki_page_versions WHERE page_id = ? ORDER BY version_number ASC LIMIT 1').get(pageId).id;
}
function getFreeNoteRevision(database, id) {
  return Number(database.prepare('SELECT revision FROM knowledge_free_notes WHERE id = ?').get(id).revision);
}
function getFirstSourceId(database) {
  return database.prepare('SELECT id FROM source_items ORDER BY created_at ASC LIMIT 1').get().id;
}
