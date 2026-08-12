/**
 * WMB-5215 M6 创作知识调用血缘 store 契约验收（子进程，真实 SQLite）。
 * Design: docs/spark/2026-08-12-wmb-creation-knowledge-usage-protocol-design.md §2/§6/§10。
 * 验收：v56→v57 旧 fixture 幂等迁移；包+记录同事务原子；used/consulted 判别（DB CHECK）；
 * 引用不存在版本/证据拒绝、跨 workspace/lane 拒绝；usage 失败零产物（transaction=false 可嵌入
 * 内容保存事务）；requestId 幂等/冲突；包不可变/无硬删；历史读回固定发布当时版本；过滤信封。
 * 退出码 0 = 全部通过；任何断言失败抛错并以非 0 退出。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase, migrations } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';
import { applyKnowledgeChangeSet, getKnowledgeNoteVersion, getWikiPageVersion } from '../src/main/knowledge-flywheel.ts';
import {
  createKnowledgeUsage, addKnowledgeUsageRecords,
  getKnowledgeUsagePackage, getKnowledgeUsagePackageByRequest, listKnowledgeUsagePackages,
  getKnowledgeUsageRecord, listKnowledgeUsageRecords
} from '../src/main/knowledge-usage.ts';

const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-5215-db-'));
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
function meta(requestId, workspaceId = 'ws-a', reason = '测试原因') {
  // triggerSource/resolutionMode 仅供 applyKnowledgeChangeSet 使用；usage store 忽略多余字段。
  return { workspaceId, requestId, reason, createdBy: 'background_agent', triggerSource: 'ingest', resolutionMode: 'none' };
}

// ============ 0. 种子：业务对象 + 正式知识（只经 applyKnowledgeChangeSet） ============
const database = migrateDatabase(directoryPath);
database.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', 'ws-a', ?, ?, 1)").run(new Date().toISOString(), new Date().toISOString());
{
  const source = upsertSource(database, { originalUrl: 'https://lane.example/1', title: '赛道资料' });
  database.prepare(`INSERT INTO source_lane_judgments (id, source_id, workspace_lane, decision, reason_code, reason, judged_by, confidence, source_revision, judged_at)
    VALUES (?, ?, 'uk-life-content-radar', 'relevant', 'lane_relevant', NULL, 'editor', NULL, 1, ?)`)
    .run('lane-judg-1', source.id, new Date().toISOString());
}
const stamp = new Date().toISOString();
const seedSource = upsertSource(database, { originalUrl: 'https://seed.example/1', title: '种子资料' });
database.prepare('INSERT INTO topics (id, title, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)').run('topic-1', '主题A', stamp, stamp);
database.prepare('INSERT INTO content_projects (id, topic_id, title, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, 1)').run('proj-1', 'topic-1', '项目A', stamp, stamp);
database.prepare('INSERT INTO content_versions (id, project_id, body, version_number, created_at) VALUES (?, ?, ?, 1, ?)').run('cv-1', 'proj-1', '核心正文V1', stamp);
database.prepare(`INSERT INTO platform_versions (id, project_id, content_version_id, platform, format, title, body, asset_ids_json, created_at, updated_at, revision)
  VALUES (?, ?, ?, 'x', 'post', '平台标题', '平台正文', '[]', ?, ?, 1)`).run('pv-1', 'proj-1', 'cv-1', stamp, stamp);
database.prepare('INSERT INTO creative_briefs (id, title, core_judgment, why_now, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
  .run('brief-1', '简报A', '核心判断', '为什么现在值得做', stamp, stamp);
database.prepare(`INSERT INTO topic_maintenance_proposals (id, title, reason, changes_json, expected_json, status, revision, created_at, updated_at)
  VALUES (?, ?, ?, '[]', '{}', 'proposed', 1, ?, ?)`).run('prop-1', '提案A', '选题原因', stamp, stamp);

const full = {
  notes: [{
    id: 'note-1', scope: 'global', kind: 'claim', canonicalKey: 'acme-usage-claim',
    version: { statement: '核心事实：Acme 发布新产品', conclusionStatus: 'supported', evidenceLevel: 'primary' }
  }, {
    id: 'note-lane', scope: 'lane:uk-life-content-radar', kind: 'insight', canonicalKey: 'lane-usage-insight',
    version: { statement: '赛道洞察', conclusionStatus: 'unverified', evidenceLevel: 'none' }
  }],
  wikiPages: [{
    id: 'page-1', scope: 'global', pageType: 'topic', canonicalKey: 'wiki-acme-usage', subjectType: 'topic', subjectId: 'topic-1',
    version: { body: { summary: 'Acme 主题页面' }, changeSummary: '首版', compileReason: '测试' }
  }]
};
const applied = applyKnowledgeChangeSet(database, meta('cs-seed'), full);
const noteV1Id = database.prepare('SELECT current_version_id AS c FROM knowledge_notes WHERE id = ?').get('note-1').c;
const pageV1Id = database.prepare('SELECT current_version_id AS c FROM knowledge_wiki_pages WHERE id = ?').get('page-1').c;
check('种子 ChangeSet 成功', Boolean(applied.changeSetId));
const evidenceApplied = applyKnowledgeChangeSet(database, meta('cs-seed-evidence'), {
  evidenceLinks: [{
    knowledgeNoteVersionId: noteV1Id, evidenceObjectType: 'source', evidenceObjectId: seedSource.id,
    relation: 'supports', sourceNature: 'primary_source', locator: 'L12-18'
  }]
});
const evidenceId = database.prepare('SELECT id FROM knowledge_evidence_links ORDER BY created_at LIMIT 1').get().id;
check('种子证据成功', Boolean(evidenceApplied.changeSetId) && Boolean(evidenceId));

// ============ 1. v56→v57 旧 fixture 幂等迁移 ============
{
  const fixture = new DatabaseSync(path.join(directory, 'fixture.db'));
  fixture.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  fixture.exec('PRAGMA foreign_keys = OFF');
  for (const migration of migrations) {
    if (migration.version >= 57) continue;
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
  check('fixture 停在 v56', Number(fixture.prepare('SELECT max(version) AS m FROM schema_migrations').get().m) === 56);
  check('v56 下无 usage 表', fixture.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='knowledge_usage_packages'").get().c === 0);

  const migrated = migrateDatabase(path.join(directory, 'fixture.db'));
  check('migrateDatabase 补齐 v57-v58', Number(migrated.prepare('SELECT max(version) AS m FROM schema_migrations').get().m) === 58);
  check('usage 包表存在', migrated.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='knowledge_usage_packages'").get().c === 1);
  check('usage 记录表存在', migrated.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='knowledge_usage_records'").get().c === 1);
  check('迁移总数 = 58', count(migrated, 'schema_migrations') === 58);
  const reopened = migrateDatabase(path.join(directory, 'fixture.db'));
  check('重开幂等', count(reopened, 'schema_migrations') === 58);
  reopened.close();
  migrated.close();
  fixture.close();
}

// ============ 2. 包+记录同事务提交 + 读回（core_draft 阶段） ============
let corePackageId;
{
  const result = createKnowledgeUsage(database, meta('usage:core_draft:cv-1'), {
    package: {
      scope: 'global', stage: 'core_draft', projectId: 'proj-1', topicId: 'topic-1', sourceIds: [seedSource.id],
      platform: 'x', audience: '在英华人', format: 'post',
      wikiPageVersionIds: [pageV1Id], noteVersionIds: [noteV1Id], evidenceIds: [evidenceId],
      freeNoteIds: [],
      riskFlags: [{ kind: 'stale', versionKind: 'note', versionId: noteV1Id, note: '待补编译' }],
      selectionReasons: ['与目标受众强相关', '有直接证据'],
      cutReasons: [{ kind: 'budget', versionKind: 'note', versionId: noteV1Id, reason: '篇幅限制' }],
      compilerSchemaVersion: 'v1'
    },
    records: [
      { outputObjectType: 'content_version', outputObjectId: 'cv-1', versionKind: 'note', versionId: noteV1Id, usageKind: 'quoted', locator: 'L12', reason: '关键事实', actor: 'writer', evidenceId },
      { outputObjectType: 'content_version', outputObjectId: 'cv-1', versionKind: 'wiki_page', versionId: pageV1Id, usageKind: 'consulted', reason: '主题结构参考' }
    ]
  });
  corePackageId = result.packageId;
  check('包+记录同事务返回 packageId', Boolean(corePackageId) && result.replay === false);
  check('两条记录同事务落库', result.recordIds.length === 2);

  const pkg = getKnowledgeUsagePackage(database, corePackageId);
  check('包读回 stage/project', pkg.stage === 'core_draft' && pkg.projectId === 'proj-1' && pkg.workspaceId === 'ws-a');
  check('包读回固定版本', pkg.noteVersionIds.length === 1 && pkg.noteVersionIds[0] === noteV1Id && pkg.wikiPageVersionIds[0] === pageV1Id);
  check('包读回证据入口', pkg.evidenceIds.length === 1 && pkg.evidenceIds[0] === evidenceId);
  check('包读回风险标记', pkg.riskFlags.length === 1 && pkg.riskFlags[0].kind === 'stale' && pkg.riskFlags[0].versionId === noteV1Id);
  check('包读回选择/裁剪原因', pkg.selectionReasons.length === 2 && pkg.cutReasons[0].kind === 'budget');
  check('包读回 audience/platform/compiler', pkg.audience === '在英华人' && pkg.platform === 'x' && pkg.compilerSchemaVersion === 'v1');

  const byRequest = getKnowledgeUsagePackageByRequest(database, 'ws-a', 'usage:core_draft:cv-1');
  check('按 requestId 读回同一包', byRequest.id === corePackageId);

  const records = listKnowledgeUsageRecords(database, { packageId: corePackageId });
  check('记录信封 total=2', records.total === 2);
  const quoted = records.items.find((r) => r.usageKind === 'quoted');
  const consulted = records.items.find((r) => r.usageKind === 'consulted');
  check('actual used（quoted）读回 used=true', quoted.used === true && quoted.knowledgeVersionKind === 'note' && quoted.evidenceId === evidenceId);
  check('consulted 读回 used=false', consulted.used === false && consulted.knowledgeVersionKind === 'wiki_page');
  check('记录读回输出绑定', quoted.outputObjectType === 'content_version' && quoted.outputObjectId === 'cv-1');
}

// ============ 3. 无效证据/版本/产物拒绝 → 整体零产物 ============
{
  const packagesBefore = count(database, 'knowledge_usage_packages');
  await expectError('包引用不存在 Note 版本拒绝', async () => {
    createKnowledgeUsage(database, meta('usage:bad_version'), {
      package: { scope: 'global', stage: 'core_draft', noteVersionIds: ['ghost-note-version'], compilerSchemaVersion: 'v1' }
    });
  }, 'OBJECT_NOT_FOUND');
  await expectError('包引用不存在 Wiki 版本拒绝', async () => {
    createKnowledgeUsage(database, meta('usage:bad_wiki_version'), {
      package: { scope: 'global', stage: 'core_draft', wikiPageVersionIds: ['ghost-page-version'], compilerSchemaVersion: 'v1' }
    });
  }, 'OBJECT_NOT_FOUND');
  await expectError('包引用不存在证据拒绝', async () => {
    createKnowledgeUsage(database, meta('usage:bad_evidence'), {
      package: { scope: 'global', stage: 'core_draft', evidenceIds: ['ghost-evidence'], compilerSchemaVersion: 'v1' }
    });
  }, 'OBJECT_NOT_FOUND');
  await expectError('记录引用不存在版本拒绝（事务内整体回滚）', async () => {
    createKnowledgeUsage(database, meta('usage:bad_record_version'), {
      package: { scope: 'global', stage: 'core_draft', compilerSchemaVersion: 'v1' },
      records: [{ outputObjectType: 'content_version', outputObjectId: 'cv-1', versionKind: 'note', versionId: 'ghost', usageKind: 'quoted' }]
    });
  }, 'OBJECT_NOT_FOUND');
  await expectError('记录引用不存在证据拒绝', async () => {
    createKnowledgeUsage(database, meta('usage:bad_record_evidence'), {
      package: { scope: 'global', stage: 'core_draft', compilerSchemaVersion: 'v1' },
      records: [{ outputObjectType: 'content_version', outputObjectId: 'cv-1', versionKind: 'note', versionId: noteV1Id, usageKind: 'quoted', evidenceId: 'ghost-evidence' }]
    });
  }, 'OBJECT_NOT_FOUND');
  await expectError('记录引用不存在产物拒绝', async () => {
    createKnowledgeUsage(database, meta('usage:bad_output'), {
      package: { scope: 'global', stage: 'core_draft', compilerSchemaVersion: 'v1' },
      records: [{ outputObjectType: 'content_version', outputObjectId: 'ghost-cv', versionKind: 'note', versionId: noteV1Id, usageKind: 'quoted' }]
    });
  }, 'OBJECT_NOT_FOUND');
  await expectError('非法 stage 拒绝', async () => {
    createKnowledgeUsage(database, meta('usage:bad_stage'), {
      package: { scope: 'global', stage: 'bogus_stage', compilerSchemaVersion: 'v1' }
    });
  }, 'INVALID_INPUT');
  check('失败后零包（整体回滚）', count(database, 'knowledge_usage_packages') === packagesBefore);
  check('失败后零记录', count(database, 'knowledge_usage_records') === 2);
}

// ============ 4. 跨 data-root / lane 拒绝 ============
{
  await expectError('跨 workspace 拒绝', async () => {
    createKnowledgeUsage(database, meta('usage:cross_root', 'ws-b'), {
      package: { scope: 'global', stage: 'core_draft', compilerSchemaVersion: 'v1' }
    });
  }, 'WORKSPACE_MISMATCH');
  await expectError('幽灵 lane 拒绝', async () => {
    createKnowledgeUsage(database, meta('usage:ghost_lane'), {
      package: { scope: 'lane:ghost-lane', stage: 'core_draft', compilerSchemaVersion: 'v1' }
    });
  }, 'SCOPE_NOT_REGISTERED');
  await expectError('记录追加到他工作空间包拒绝（包级跨 root 门）', async () => {
    // 直接 SQL 制造一个 workspace_id 不同的包（绕过 store 的合法创建路径），验证记录级 gate
    database.prepare(`INSERT INTO knowledge_usage_packages
      (id, scope, workspace_id, stage, request_id, input_hash, compiler_schema_version, created_by, created_at)
      VALUES ('pkg-foreign', 'global', 'ws-foreign', 'core_draft', 'usage:foreign', 'hash', 'v1', 'background_agent', ?)`).run(stamp);
    await addKnowledgeUsageRecords(database, meta('usage:foreign_record'), {
      packageId: 'pkg-foreign',
      records: [{ outputObjectType: 'content_version', outputObjectId: 'cv-1', versionKind: 'note', versionId: noteV1Id, usageKind: 'quoted' }]
    });
  }, 'WORKSPACE_MISMATCH');
  check('跨 root 尝试零写', count(database, 'knowledge_usage_records') === 2);

  // 已注册 lane 可建包
  const laneResult = createKnowledgeUsage(database, meta('usage:lane_ok'), {
    package: { scope: 'lane:uk-life-content-radar', stage: 'creative_brief', noteVersionIds: [noteV1Id], compilerSchemaVersion: 'v1' },
    records: [{ outputObjectType: 'creative_brief', outputObjectId: 'brief-1', versionKind: 'note', versionId: noteV1Id, usageKind: 'paraphrased', locator: 'L3-5' }]
  });
  check('已注册 lane 包可写且 creative_brief 产物可用', Boolean(laneResult.packageId) && laneResult.recordIds.length === 1);
  const lanePkg = getKnowledgeUsagePackage(database, laneResult.packageId);
  check('lane 包读回 scope', lanePkg.scope === 'lane:uk-life-content-radar' && lanePkg.stage === 'creative_brief');
  check('跨包追加到本工作空间包成功', (() => {
    const r = addKnowledgeUsageRecords(database, meta('usage:lane_ok_append'), {
      packageId: corePackageId,
      records: [{ outputObjectType: 'platform_version', outputObjectId: 'pv-1', versionKind: 'note', versionId: noteV1Id, usageKind: 'structure_pattern', reason: '平台版本继承核心血缘' }]
    });
    return r.recordIds.length === 1;
  })());
}

// ============ 5. requestId 幂等 + 冲突 + 记录去重 ============
{
  const input = {
    package: { scope: 'global', stage: 'source_judgment', topicId: 'topic-1', sourceIds: [seedSource.id], noteVersionIds: [noteV1Id], compilerSchemaVersion: 'v1' },
    records: [{ outputObjectType: 'source_item', outputObjectId: seedSource.id, versionKind: 'note', versionId: noteV1Id, usageKind: 'reasoning_basis' }]
  };
  const first = createKnowledgeUsage(database, meta('usage:judge:src-1'), input);
  const replay = createKnowledgeUsage(database, meta('usage:judge:src-1'), input);
  check('重放返回 replay=true 同一 packageId', replay.replay === true && replay.packageId === first.packageId);
  check('重放零新增包（4 个既有包）', count(database, 'knowledge_usage_packages') === 4);
  check('重放零新增记录（5 条既有记录）', count(database, 'knowledge_usage_records') === 5);
  await expectError('同 requestId 不同输入拒绝', async () => {
    createKnowledgeUsage(database, meta('usage:judge:src-1'), {
      package: { scope: 'global', stage: 'source_judgment', compilerSchemaVersion: 'v1' }
    });
  }, 'REQUEST_REPLAY_CONFLICT');

  // 同包内重复记录幂等跳过（去重键 = 输出+用途+版本）
  const before = count(database, 'knowledge_usage_records');
  const dup = addKnowledgeUsageRecords(database, meta('usage:core_draft:cv-1_dup'), {
    packageId: corePackageId,
    records: [{ outputObjectType: 'content_version', outputObjectId: 'cv-1', versionKind: 'note', versionId: noteV1Id, usageKind: 'quoted' }]
  });
  check('重复记录零新增（去重）', dup.recordIds.length === 0 && count(database, 'knowledge_usage_records') === before);
}

// ============ 6. used/consulted DB CHECK 判别（schema 级） ============
{
  const badConsultedUsed = () => database.prepare(`INSERT INTO knowledge_usage_records
    (id, scope, workspace_id, package_id, output_object_type, output_object_id, note_version_id, usage_kind, used, created_by, created_at)
    VALUES ('chk-1', 'global', 'ws-a', ?, 'content_version', 'cv-1', ?, 'consulted', 1, 'background_agent', ?)`)
    .run(corePackageId, noteV1Id, stamp);
  await expectError('consulted 不得 used=1（DB CHECK）', badConsultedUsed);
  const badUsedKind = () => database.prepare(`INSERT INTO knowledge_usage_records
    (id, scope, workspace_id, package_id, output_object_type, output_object_id, note_version_id, usage_kind, used, created_by, created_at)
    VALUES ('chk-2', 'global', 'ws-a', ?, 'content_version', 'cv-1', ?, 'quoted', 0, 'background_agent', ?)`)
    .run(corePackageId, noteV1Id, stamp);
  await expectError('quoted 不得 used=0（DB CHECK）', badUsedKind);
  const bothVersions = () => database.prepare(`INSERT INTO knowledge_usage_records
    (id, scope, workspace_id, package_id, output_object_type, output_object_id, note_version_id, wiki_page_version_id, usage_kind, used, created_by, created_at)
    VALUES ('chk-3', 'global', 'ws-a', ?, 'content_version', 'cv-1', ?, ?, 'consulted', 0, 'background_agent', ?)`)
    .run(corePackageId, noteV1Id, pageV1Id, stamp);
  await expectError('同时两个版本列拒绝（XOR CHECK）', bothVersions);
  check('非法 CHECK 尝试零落库', count(database, 'knowledge_usage_records') === 5);
}

// ============ 7. 包/记录不可变 + 无硬删 ============
{
  await expectError('包 UPDATE 拒绝', async () => {
    database.prepare('UPDATE knowledge_usage_packages SET audience = ? WHERE id = ?').run('篡改', corePackageId);
  });
  await expectError('包 DELETE 拒绝', async () => {
    database.prepare('DELETE FROM knowledge_usage_packages WHERE id = ?').run(corePackageId);
  });
  const recordId = listKnowledgeUsageRecords(database, { packageId: corePackageId }).items[0].id;
  await expectError('记录 UPDATE 拒绝', async () => {
    database.prepare('UPDATE knowledge_usage_records SET reason = ? WHERE id = ?').run('篡改', recordId);
  });
  await expectError('记录 DELETE 拒绝', async () => {
    database.prepare('DELETE FROM knowledge_usage_records WHERE id = ?').run(recordId);
  });
  check('包仍可读（未受影响）', getKnowledgeUsagePackage(database, corePackageId).id === corePackageId);
}

// ============ 8. 历史读回：复盘使用发布当时版本，不随知识更新漂移 ============
{
  // 知识更新：note-1 追加 V2
  applyKnowledgeChangeSet(database, meta('cs-note-v2'), {
    notes: [{ id: 'note-1', scope: 'global', kind: 'claim', canonicalKey: 'acme-usage-claim', beforeRevision: 1, version: { statement: '核心事实更新：Acme 发布两款新产品', conclusionStatus: 'supported', evidenceLevel: 'corroborated', changeType: 'strengthened' } }]
  });
  const noteV2Id = database.prepare('SELECT current_version_id AS c FROM knowledge_notes WHERE id = ?').get('note-1').c;
  check('知识已更新到 V2', noteV2Id !== noteV1Id);

  // 复盘包固定发布当时版本 V1
  const review = createKnowledgeUsage(database, meta('usage:review:pub-1'), {
    package: {
      scope: 'global', stage: 'review', projectId: 'proj-1',
      wikiPageVersionIds: [pageV1Id], noteVersionIds: [noteV1Id], evidenceIds: [evidenceId],
      selectionReasons: ['复盘发布当时所用知识'], compilerSchemaVersion: 'v1'
    }
  });
  const reviewPkg = getKnowledgeUsagePackage(database, review.packageId);
  check('复盘包仍固定 V1 版本', reviewPkg.noteVersionIds[0] === noteV1Id && reviewPkg.wikiPageVersionIds[0] === pageV1Id);
  const oldVersion = getKnowledgeNoteVersion(database, noteV1Id);
  const newVersion = getKnowledgeNoteVersion(database, noteV2Id);
  check('发布当时版本内容可读且不被改写', oldVersion.statement === '核心事实：Acme 发布新产品' && newVersion.statement === '核心事实更新：Acme 发布两款新产品');
  check('历史包未引用未来版本', reviewPkg.noteVersionIds.includes(noteV2Id) === false);

  // 新包引用最新版本，两个包并存
  const latest = createKnowledgeUsage(database, meta('usage:core_draft:v2-latest'), {
    package: { scope: 'global', stage: 'core_draft', projectId: 'proj-1', noteVersionIds: [noteV2Id], wikiPageVersionIds: [pageV1Id], compilerSchemaVersion: 'v1' }
  });
  const latestPkg = getKnowledgeUsagePackage(database, latest.packageId);
  check('新包引用 V2 而复盘包仍 V1', latestPkg.noteVersionIds[0] === noteV2Id && reviewPkg.noteVersionIds[0] === noteV1Id);
  check('Wiki 页面版本读回', getWikiPageVersion(database, pageV1Id).pageId === 'page-1');
}

// ============ 9. usage 失败零产物：transaction=false 可嵌入内容保存事务 ============
{
  // 9a. 内容先写 + usage 失败 → 整体回滚（零内容、零 usage）
  const beforeCv = count(database, 'content_versions');
  const beforePkg = count(database, 'knowledge_usage_packages');
  database.exec('BEGIN IMMEDIATE');
  database.prepare('INSERT INTO content_versions (id, project_id, body, version_number, created_at) VALUES (?, ?, ?, 99, ?)').run('cv-fail-1', 'proj-1', '不应提交', stamp);
  let usageError = null;
  try {
    createKnowledgeUsage(database, meta('usage:fail_cv-1'), {
      package: { scope: 'global', stage: 'core_draft', projectId: 'proj-1', noteVersionIds: ['ghost'], compilerSchemaVersion: 'v1' }
    }, false);
  } catch (error) {
    usageError = error?.code ?? error?.message;
  }
  database.exec('ROLLBACK');
  check('usage 失败在事务内抛出', usageError === 'OBJECT_NOT_FOUND');
  check('内容版本随回滚零提交', count(database, 'content_versions') === beforeCv);
  check('usage 随回滚零提交', count(database, 'knowledge_usage_packages') === beforePkg && count(database, 'knowledge_usage_records') === 5);

  // 9b. usage + 内容同事务提交成功 → 两者同时可见
  database.exec('BEGIN IMMEDIATE');
  database.prepare('INSERT INTO content_versions (id, project_id, body, version_number, created_at) VALUES (?, ?, ?, 2, ?)').run('cv-2', 'proj-1', '核心正文V2', stamp);
  const ok = createKnowledgeUsage(database, meta('usage:core_draft:cv-2'), {
    package: { scope: 'global', stage: 'core_draft', projectId: 'proj-1', noteVersionIds: [noteV1Id], compilerSchemaVersion: 'v1' },
    records: [{ outputObjectType: 'content_version', outputObjectId: 'cv-2', versionKind: 'note', versionId: noteV1Id, usageKind: 'quoted' }]
  }, false);
  database.exec('COMMIT');
  check('同事务提交返回记录', ok.recordIds.length === 1);
  check('内容版本已提交', database.prepare('SELECT 1 FROM content_versions WHERE id = ?').get('cv-2') !== undefined);
  check('usage 包已提交', getKnowledgeUsagePackageByRequest(database, 'ws-a', 'usage:core_draft:cv-2').id === ok.packageId);

  // 9c. usage 写成功后同事务后续内容步骤失败 → 整体回滚（无血缘内容版本零产物）
  database.exec('BEGIN IMMEDIATE');
  database.prepare('INSERT INTO content_versions (id, project_id, body, version_number, created_at) VALUES (?, ?, ?, 3, ?)').run('cv-3', 'proj-1', '正文V3', stamp);
  createKnowledgeUsage(database, meta('usage:core_draft:cv-3'), {
    package: { scope: 'global', stage: 'core_draft', projectId: 'proj-1', noteVersionIds: [noteV1Id], compilerSchemaVersion: 'v1' },
    records: [{ outputObjectType: 'content_version', outputObjectId: 'cv-3', versionKind: 'note', versionId: noteV1Id, usageKind: 'quoted' }]
  }, false);
  let contentError = null;
  try {
    // 同事务后续步骤失败：cv-3 已占 version_number=3，再插同版本号 → UNIQUE 冲突
    database.prepare('INSERT INTO content_versions (id, project_id, body, version_number, created_at) VALUES (?, ?, ?, 3, ?)').run('cv-3b', 'proj-1', '撞版本号', stamp);
  } catch (error) {
    contentError = true;
  }
  database.exec('ROLLBACK');
  check('内容后续步骤失败被捕获', contentError === true);
  check('usage 包未残留（无血缘内容版本零产物）', getKnowledgeUsagePackageByRequest(database, 'ws-a', 'usage:core_draft:cv-3') === null);
  check('内容 cv-3 随回滚未残留', database.prepare('SELECT 1 FROM content_versions WHERE id = ?').get('cv-3') === undefined);
  check('失败包零记录', listKnowledgeUsageRecords(database, { packageId: ok.packageId }).total === 1);
}

// ============ 10. 过滤信封 + 有界读 ============
{
  const byStage = listKnowledgeUsagePackages(database, { stage: 'review' });
  check('按 stage 过滤', byStage.total === 1 && byStage.items[0].stage === 'review');
  const byTopic = listKnowledgeUsagePackages(database, { topicId: 'topic-1' });
  check('按 topicId 过滤且信封完整', byTopic.total >= 1 && Array.isArray(byTopic.items) && byTopic.hasMore === false);
  const byProject = listKnowledgeUsagePackages(database, { projectId: 'proj-1', limit: 1 });
  check('分页信封 limit 生效', byProject.items.length <= 1 && byProject.limit === 1);
  const usedRecords = listKnowledgeUsageRecords(database, { used: true });
  const consultedRecords = listKnowledgeUsageRecords(database, { used: false });
  check('used=true 过滤', usedRecords.total >= 2 && usedRecords.items.every((r) => r.used === true));
  check('used=false 过滤（consulted）', consultedRecords.total >= 1 && consultedRecords.items.every((r) => r.used === false));
  const byOutput = listKnowledgeUsageRecords(database, { outputObjectId: 'pv-1' });
  check('按产物过滤', byOutput.total === 1 && byOutput.items[0].outputObjectType === 'platform_version');
  const single = getKnowledgeUsageRecord(database, byOutput.items[0].id);
  check('getKnowledgeUsageRecord 单对象读回', single.outputObjectId === 'pv-1' && single.used === true);
}

database.close();
console.log(`WMB-5215 child: ${checks} checks passed`);
await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
