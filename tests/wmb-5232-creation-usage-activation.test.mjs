/**
 * WMB-5232 激活创作使用与结果回流（真实保存链聚焦验收）。
 *
 * 验收（TASKS.md WMB-5232）：
 * - 用「已编译 Topic fixture」（真实 compileSourceKnowledge 管线，非手工 applyKnowledgeChangeSet）
 *   走真实五阶段保存 API：选题呈报 → 创作简报 → 核心正文 → 平台版本 → 复盘，
 *   每阶段 Usage 包读回非空且有效的固定 Wiki/Note/Evidence 版本引用；
 * - used/consulted 语义正确（六种用途 used=1，consulted=0），平台版本继承核心血缘、
 *   换基事实版本拒绝；
 * - 零知识语义 = 如实空血缘（包存在、血缘为空、零记录），绝不伪造知识引用；
 * - final Review 只读发布时固定 Usage，保守形成 case/限域 qualify/阈值限域 pattern，
 *   零新因果 Method，同一 ChangeSet 原子更新 Topic Wiki + Receipt；
 * - Topic 读模型 creationImpact 投影可见五阶段 Usage。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';
import { upsertKnowledgeTopic } from '../src/main/knowledge.ts';
import { compileSourceKnowledge, sourceCompileRequestId } from '../src/main/knowledge-compiler.ts';
import { createTopicMaintenanceProposal } from '../src/main/topic-maintenance.ts';
import { createCreativeBrief } from '../src/main/knowledge-canvas.ts';
import { createContentProjectWithVersion, copyContentVersionToNewProject, saveCoreVersion, savePlatformVersion } from '../src/main/content.ts';
import { createPublication } from '../src/main/publishing.ts';
import { savePublicationMetricSnapshot } from '../src/main/metrics.ts';
import { saveReview } from '../src/main/reviews.ts';
import { saveAccount } from '../src/main/accounts.ts';
import { getKnowledgeUsagePackageByRequest, listKnowledgeUsageRecords, listKnowledgeUsagePackages } from '../src/main/knowledge-usage.ts';
import { readPublicationTimeUsage, recordCreativeBriefUsage, usageRequestId } from '../src/main/knowledge-usage-integration.ts';
import { getKnowledgeNote, getKnowledgeNoteVersion, getUpdateReceiptByRequest, getWikiPage, getWikiPageVersion, listKnowledgeNotes } from '../src/main/knowledge-flywheel.ts';
import { getTopicWikiDetail } from '../src/main/knowledge-topic-library.ts';

async function withDb(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5232-'));
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  const now = new Date().toISOString();
  database.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', 'ws-a', ?, ?, 1)").run(now, now);
  try {
    await run(database);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

/** 真实编译 Topic fixture：Source r1 → compileSourceKnowledge → Entity + Claim Note + 证据 + Topic Wiki V1。 */
function seedCompiledTopic(database) {
  const source = upsertSource(database, { originalUrl: 'https://news.example/agentforge-v2', title: 'AgentForge 发布 v2：多模型路由', summary: '官方发布 v2 引入多模型路由。' });
  const topic = upsertKnowledgeTopic(database, { title: 'AI Agent 工具链' });
  const compiled = compileSourceKnowledge(database, {
    workspaceId: 'ws-a', sourceId: source.id, sourceRevision: source.revision, topicId: topic.id,
    reason: '摄取 AgentForge v2 发布资料', topicCompile: { summary: '工具链主题编译' },
    requestId: sourceCompileRequestId(source.id, source.revision),
    entities: [{ entityType: 'organization', canonicalKey: 'agentforge', canonicalName: 'AgentForge', valueRationale: '选型判断与创作复用' }],
    notes: [{
      kind: 'claim', canonicalKey: 'agentforge-v2-multi-router', statement: 'AgentForge v2 支持多模型路由',
      conclusionStatus: 'supported', evidenceLevel: 'primary', locator: 'L12-18', entityKeys: ['agentforge'], valueRationale: '可验证产品事实'
    }]
  });
  assert.equal(compiled.ok, true, '真实编译必须成功');
  assert.ok(compiled.wikiPageVersionId, '编译必须产出 Topic Wiki 版本');
  const wikiVersionId = compiled.wikiPageVersionId;
  const noteVersionId = compiled.noteVersionIds['agentforge-v2-multi-router'];
  assert.ok(noteVersionId, '编译必须产出 Claim Note 版本');
  const evidenceRows = database.prepare('SELECT id FROM knowledge_evidence_links WHERE knowledge_note_version_id = ?').all(noteVersionId);
  assert.equal(evidenceRows.length, 1, '编译必须产出 EvidenceLink');
  const evidenceId = evidenceRows[0].id;
  return { sourceId: source.id, topicId: topic.id, wikiVersionId, noteVersionId, evidenceId };
}

/** 编译 Source V2（知识更新：追加第二 Note + 新 Wiki 版本）——模拟发布后知识被改写。 */
function seedKnowledgeUpdate(database, fixture) {
  const sourceV2 = upsertSource(database, { originalUrl: 'https://news.example/agentforge-v2', title: 'AgentForge v2 后续：定价公开', summary: '企业版定价公布。' });
  const compiled = compileSourceKnowledge(database, {
    workspaceId: 'ws-a', sourceId: fixture.sourceId, sourceRevision: sourceV2.revision, topicId: fixture.topicId,
    reason: '摄取后续资料', topicCompile: { summary: '工具链主题编译（更新）' },
    requestId: sourceCompileRequestId(fixture.sourceId, sourceV2.revision),
    notes: [{
      kind: 'claim', canonicalKey: 'agentforge-v2-pricing', statement: 'AgentForge v2 企业版定价为每席位 99 美元/月',
      conclusionStatus: 'supported', evidenceLevel: 'primary', locator: 'L40-44', valueRationale: '价格事实'
    }]
  });
  assert.equal(compiled.ok, true, '知识更新编译必须成功');
  assert.notEqual(compiled.wikiPageVersionId, fixture.wikiVersionId, '知识更新必须产生新 Wiki 版本');
  return { wikiVersionId: compiled.wikiPageVersionId, noteVersionId: compiled.noteVersionIds['agentforge-v2-pricing'] };
}

function packageOf(database, stage, objectId) {
  return getKnowledgeUsagePackageByRequest(database, 'ws-a', usageRequestId(stage, objectId));
}

function recordsOf(database, pkg) {
  return listKnowledgeUsageRecords(database, { packageId: pkg.id }).items;
}

/** 发布一篇文章并 final 复盘（复刻 WMB-5215 发布流程；keep 可指定以命中既有 Note）。 */
function publishAndReview(database, { platformVersionId, platform = 'x', keep, label }) {
  const account = saveAccount(database, { platform, accountKey: `@${label}`, displayName: label, loginState: 'authenticated' });
  const publication = createPublication(database, { platformVersionId, accountId: account.id });
  assert.equal(publication.ok, true);
  const now = new Date().toISOString();
  database.prepare(`UPDATE publications SET status='published', external_url=?, external_id=?, published_at=?, prepared_title=?, prepared_body=?, prepared_assets_json='[]', updated_at=?, revision=? WHERE id=?`)
    .run(`https://x.com/${label}/1`, label, now, null, '平台正文', now, 2, publication.data.id);
  const snap = savePublicationMetricSnapshot(database, {
    publicationId: publication.data.id, scheduledFor: now, sourceUrl: `https://x.com/${label}/1`, capturedAt: now,
    normalized: { views: { status: 'value', value: 100, rawLabel: '100' } }, raw: { views: { status: 'value', value: 100, rawLabel: '100' } }
  });
  assert.equal(snap.ok, true);
  const review = saveReview(database, {
    publicationId: publication.data.id, metricSnapshotIds: [snap.data.id],
    keep, stop: ['stop'], change: ['change'], status: 'final', summary: `复盘 ${label}`
  });
  assert.equal(review.ok, true, `final Review ${label} 必须保存成功`);
  return { publicationId: publication.data.id, snapshotId: snap.data.id, reviewId: review.data.id };
}

test('WMB-5232 真实编译 Topic 五阶段保存链：每阶段固定 Wiki/Note/Evidence 版本非空且 used/consulted 正确', async () => {
  await withDb((database) => {
    const fixture = seedCompiledTopic(database);

    // 1) 选题呈报：Topic 整理提案冻结固定 Wiki 版本（consulted，不冒充 used）
    const proposal = createTopicMaintenanceProposal(database, {
      title: 'AI Agent 工具链整理', reason: '资料已更新',
      changes: [{ kind: 'update', topicId: fixture.topicId, after: { title: 'AI Agent 工具链（更新）', canonicalKey: 'ai-agent-toolchain-updated' } }]
    });
    const proposalPkg = packageOf(database, 'topic_proposal', proposal.id);
    assert.ok(proposalPkg, '选题提案必须有 usage 包');
    assert.deepEqual([...proposalPkg.wikiPageVersionIds], [fixture.wikiVersionId], '提案固定编译 Wiki 版本');
    assert.deepEqual([...proposalPkg.noteVersionIds], [fixture.noteVersionId], '提案固定采纳 Note 版本');
    assert.deepEqual([...proposalPkg.evidenceIds], [fixture.evidenceId], '提案固定 Evidence 入口');
    const proposalRecords = recordsOf(database, proposalPkg);
    assert.equal(proposalRecords.length, 2, '提案记录：wiki V1 + note V1');
    assert.ok(proposalRecords.every((record) => record.used === false), '提案阶段全部 consulted（used=0）');
    assert.ok(proposalRecords.every((record) => record.usageKind === 'consulted'));

    // 2) 创作简报：画布选中 Topic → brief 固定血缘（Wiki reasoning_basis=used，Note consulted）
    const now = new Date().toISOString();
    const canvasId = 'canvas-1';
    database.prepare('INSERT INTO knowledge_canvases (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(canvasId, '创作画布', now, now);
    database.prepare(`INSERT INTO knowledge_canvas_nodes (id, canvas_id, object_type, object_id, note_title, note_text, x, y, created_at, updated_at)
      VALUES ('cn-topic', ?, 'topic', ?, NULL, NULL, 0, 0, ?, ?)`).run(canvasId, fixture.topicId, now, now);
    const brief = createCreativeBrief(database, {
      canvasId, nodeIds: ['cn-topic'], selectionMode: 'selected',
      title: '工具链简报', coreJudgment: '核心判断', whyNow: '为什么现在',
      structure: ['开头', '正文'], evidenceNodeIds: ['cn-topic']
    });
    recordCreativeBriefUsage(database, { briefId: brief.id, contextNodeIds: brief.contextNodeIds, reason: 'creative_brief_create' });
    const briefPkg = packageOf(database, 'creative_brief', brief.id);
    assert.ok(briefPkg, '简报必须有 usage 包');
    assert.deepEqual([...briefPkg.wikiPageVersionIds], [fixture.wikiVersionId], '简报固定编译 Wiki 版本');
    assert.deepEqual([...briefPkg.noteVersionIds], [fixture.noteVersionId]);
    const briefRecords = recordsOf(database, briefPkg);
    assert.equal(briefRecords.filter((record) => record.used === true).length, 1, '简报 used 恰 1 条（Wiki reasoning_basis）');
    assert.equal(briefRecords.filter((record) => record.used === false).length, 1, '简报 consulted 恰 1 条（Note）');
    assert.equal(briefRecords.find((record) => record.used === true).usageKind, 'reasoning_basis');
    assert.equal(briefRecords.find((record) => record.used === false).usageKind, 'consulted');

    // 3) 核心正文：两个版本各固定同一血缘
    const core1 = createContentProjectWithVersion(database, { title: 'AI 项目', body: '核心 V1', topicId: fixture.topicId, sourceIds: [fixture.sourceId] });
    for (const [label, versionId] of [['core1', core1.contentVersionId]]) {
      const corePkg = packageOf(database, 'core_draft', versionId);
      assert.ok(corePkg, `${label} 必须有 usage 包`);
      assert.deepEqual([...corePkg.wikiPageVersionIds], [fixture.wikiVersionId], `${label} 固定编译 Wiki 版本`);
      assert.deepEqual([...corePkg.noteVersionIds], [fixture.noteVersionId], `${label} 固定采纳 Note 版本`);
      assert.deepEqual([...corePkg.evidenceIds], [fixture.evidenceId], `${label} 固定 Evidence 入口`);
      const coreRecords = recordsOf(database, corePkg);
      assert.equal(coreRecords.filter((record) => record.used === true).length, 1, `${label} used 恰 1 条`);
      assert.equal(coreRecords.filter((record) => record.used === false).length, 1, `${label} consulted 恰 1 条`);
    }
    const core2 = saveCoreVersion(database, { projectId: core1.id, body: '核心 V2', expectedRevision: 1 });
    assert.equal(core2.ok, true);
    const core2Pkg = packageOf(database, 'core_draft', core2.data.id);
    assert.ok(core2Pkg, 'core2 必须有 usage 包');
    assert.deepEqual([...core2Pkg.wikiPageVersionIds], [fixture.wikiVersionId], 'core2 与 core1 同批固定版本');
    assert.deepEqual([...core2Pkg.noteVersionIds], [fixture.noteVersionId]);

    // 4) 平台版本：继承核心血缘（同一固定版本；structure_pattern=used）
    const platform = savePlatformVersion(database, { projectId: core1.id, contentVersionId: core2.data.id, platform: 'x', format: 'text', body: '平台 V1' });
    assert.equal(platform.ok, true);
    const platformPkg = packageOf(database, 'platform_adaptation', platform.data.id);
    assert.ok(platformPkg, '平台版本必须有 usage 包');
    assert.deepEqual([...platformPkg.wikiPageVersionIds], [fixture.wikiVersionId], '平台继承核心血缘（同一 Wiki 固定版本）');
    assert.deepEqual([...platformPkg.noteVersionIds], [fixture.noteVersionId]);
    assert.deepEqual([...platformPkg.evidenceIds], [fixture.evidenceId], '平台继承核心 Evidence 入口');
    const platformRecords = recordsOf(database, platformPkg);
    const platformUsed = platformRecords.filter((record) => record.used === true);
    assert.equal(platformUsed.length, 1);
    assert.equal(platformUsed[0].usageKind, 'structure_pattern');
    assert.equal(platformUsed[0].outputObjectType, 'platform_version');
    assert.equal(platformUsed[0].outputObjectId, platform.data.id);

    // 5) 复盘：发布 + final Review → 固定同一血缘（发布时版本）
    const review = publishAndReview(database, { platformVersionId: platform.data.id, platform: 'x', keep: ['agentforge-v2-multi-router'], label: 'rv1' });
    const reviewPkg = packageOf(database, 'review', review.reviewId);
    assert.ok(reviewPkg, '复盘必须有 usage 包');
    assert.deepEqual([...reviewPkg.wikiPageVersionIds], [fixture.wikiVersionId], '复盘固定发布时 Wiki 版本');
    assert.deepEqual([...reviewPkg.noteVersionIds], [fixture.noteVersionId]);
    assert.deepEqual([...reviewPkg.evidenceIds], [fixture.evidenceId]);

    // 6) 发布后知识更新（新 Wiki 版本）→ 历史复盘仍读发布时固定血缘，不回读未来知识
    const updated = seedKnowledgeUpdate(database, fixture);
    const pageRow = database.prepare(`SELECT id FROM knowledge_wiki_pages WHERE subject_type='topic' AND subject_id=? AND lifecycle='active' LIMIT 1`).get(fixture.topicId);
    assert.equal(getWikiPage(database, pageRow.id).version.id, updated.wikiVersionId, '当前 Wiki 已更新到新版本');
    const historical = readPublicationTimeUsage(database, { publicationId: review.publicationId });
    assert.ok(historical, '历史复盘应能读到发布时血缘');
    assert.deepEqual([...historical.platformPackage.wikiPageVersionIds], [fixture.wikiVersionId], '复盘读取发布时平台包固定版本，而非更新后版本');
    assert.deepEqual([...historical.corePackage.wikiPageVersionIds], [fixture.wikiVersionId], '复盘读取发布时核心包固定版本');
    assert.equal(historical.reviewPackages.length, 1);
    assert.deepEqual([...historical.reviewPackages[0].package.wikiPageVersionIds], [fixture.wikiVersionId]);
    assert.deepEqual([...historical.reviewPackages[0].package.noteVersionIds], [fixture.noteVersionId]);

    // 7) 五阶段包全量只经单一 store；无一包血缘为空（真实工作空间非空验收）
    const all = listKnowledgeUsagePackages(database, {});
    assert.equal(all.total, 6, '五阶段共 6 个包（proposal/brief/core1/core2/platform/review）');
    for (const pkg of all.items) {
      assert.ok(pkg.wikiPageVersionIds.length >= 1 && pkg.noteVersionIds.length >= 1, `${pkg.stage} 包血缘非空`);
    }
  });
});

test('WMB-5232 复制内容项目继承来源 Topic 血缘（空 Usage 根因回归）', async () => {
  await withDb((database) => {
    const fixture = seedCompiledTopic(database);
    const project = createContentProjectWithVersion(database, { title: '原项目', body: 'V1', topicId: fixture.topicId, sourceIds: [fixture.sourceId] });
    const originalPkg = packageOf(database, 'core_draft', project.contentVersionId);
    assert.deepEqual([...originalPkg.wikiPageVersionIds], [fixture.wikiVersionId], '原项目首个核心版本固定编译血缘');

    const copy = copyContentVersionToNewProject(database, { sourceProjectId: project.id, contentVersionId: project.contentVersionId, title: '副本项目' });
    assert.equal(copy.ok, true);
    assert.equal(copy.data.topicId, fixture.topicId, '副本必须继承来源项目 Topic 归属');
    const copyPkg = packageOf(database, 'core_draft', copy.data.latestVersion.id);
    assert.ok(copyPkg, '副本首个核心版本必须有 usage 包（空 Usage 根因：此前副本 topic_id 为空 → 包血缘全空）');
    assert.deepEqual([...copyPkg.wikiPageVersionIds], [fixture.wikiVersionId], '副本固定与来源同一编译 Wiki 版本');
    assert.deepEqual([...copyPkg.noteVersionIds], [fixture.noteVersionId], '副本固定与来源同一采纳 Note 版本');
    assert.deepEqual([...copyPkg.evidenceIds], [fixture.evidenceId]);

    // 副本继续走平台/复盘也继承同一血缘
    const core2 = saveCoreVersion(database, { projectId: copy.data.id, body: '副本 V2', expectedRevision: 1 });
    assert.equal(core2.ok, true);
    const platform = savePlatformVersion(database, { projectId: copy.data.id, contentVersionId: core2.data.id, platform: 'x', format: 'text', body: '副本平台' });
    assert.equal(platform.ok, true);
    const platformPkg = packageOf(database, 'platform_adaptation', platform.data.id);
    assert.deepEqual([...platformPkg.wikiPageVersionIds], [fixture.wikiVersionId], '副本平台版本继承同一血缘');
  });
});

test('WMB-5232 零知识语义：如实空血缘（包存在、零记录），绝不伪造引用', async () => {
  await withDb((database) => {
    // 无 Topic、无已编译知识的工作项目：核心/平台/复盘包必须存在但血缘如实为空、零记录
    const project = createContentProjectWithVersion(database, { title: '无知识项目', body: 'V1' });
    const corePkg = packageOf(database, 'core_draft', project.contentVersionId);
    assert.ok(corePkg, '零知识核心版本仍应生成包（稳定 requestId 契约）');
    assert.equal(corePkg.topicId, null);
    assert.deepEqual([...corePkg.wikiPageVersionIds], [], '零知识核心包血缘如实为空');
    assert.deepEqual([...corePkg.noteVersionIds], []);
    assert.deepEqual([...corePkg.evidenceIds], []);
    assert.equal(recordsOf(database, corePkg).length, 0, '零知识核心包零记录（不冒充 used/consulted）');

    const core2 = saveCoreVersion(database, { projectId: project.id, body: 'V2', expectedRevision: 1 });
    assert.equal(core2.ok, true);
    const platform = savePlatformVersion(database, { projectId: project.id, contentVersionId: core2.data.id, platform: 'x', format: 'text', body: '平台' });
    assert.equal(platform.ok, true);
    const platformPkg = packageOf(database, 'platform_adaptation', platform.data.id);
    assert.ok(platformPkg, '零知识平台版本仍应生成包');
    assert.deepEqual([...platformPkg.wikiPageVersionIds], [], '平台继承空血缘（如实）');
    assert.equal(recordsOf(database, platformPkg).length, 0);

    const review = publishAndReview(database, { platformVersionId: platform.data.id, platform: 'x', keep: ['keep'], label: 'zk' });
    const reviewPkg = packageOf(database, 'review', review.reviewId);
    assert.ok(reviewPkg, '零知识复盘仍应生成包');
    assert.deepEqual([...reviewPkg.wikiPageVersionIds], [], '复盘空血缘（如实）');
    assert.equal(recordsOf(database, reviewPkg).length, 0);

    // 发布时固定血缘投影：包存在但血缘为空（不是缺失），回执 lineagePresent=false
    const usage = readPublicationTimeUsage(database, { publicationId: review.publicationId });
    assert.ok(usage?.platformPackage, '平台包存在（空血缘）');
    assert.ok(usage.corePackage, '核心包存在（空血缘）');
    assert.deepEqual([...usage.platformPackage.wikiPageVersionIds], []);
    const outcomeReceipt = getUpdateReceiptByRequest(database, 'ws-a', `outcome:review:${review.reviewId}`);
    assert.ok(outcomeReceipt, 'final Review 结果回流回执存在');
    assert.equal(outcomeReceipt.impact.lineagePresent, false, '零知识回执如实标注无血缘');

    // 结果 case Note 仍保守形成，但 adoptedKnowledgeVersionIds 为空（不伪造引用）
    const caseNote = database.prepare(`SELECT id FROM knowledge_notes WHERE canonical_key = ? AND kind='case' LIMIT 1`)
      .get(`case:outcome:${review.reviewId}`);
    assert.ok(caseNote, '零知识仍形成 case 观察 Note');
    const caseVersion = getKnowledgeNote(database, caseNote.id).version;
    assert.deepEqual([...caseVersion.adoptedKnowledgeVersionIds], [], 'case Note 不引用任何知识版本（无知识可引用）');
    // 零新因果 Method：全程无 method Note 产生
    const methods = listKnowledgeNotes(database, { kind: 'method' });
    assert.equal(methods.total, 0, '零知识回流不产生任何因果 Method');
  });
});

test('WMB-5232 平台换基核心版本（事实变化）拒绝保存，未换基更新正常', async () => {
  await withDb((database) => {
    const fixture = seedCompiledTopic(database);
    const project = createContentProjectWithVersion(database, { title: '换基项目', body: '核心 V1', topicId: fixture.topicId });
    const core2 = saveCoreVersion(database, { projectId: project.id, body: '核心 V2', expectedRevision: 1 });
    assert.equal(core2.ok, true);
    const platform = savePlatformVersion(database, { projectId: project.id, contentVersionId: core2.data.id, platform: 'x', format: 'text', body: '平台 V1' });
    assert.equal(platform.ok, true);

    // 平台版本更新但换基到不同核心版本 → 拒绝且零变更
    assert.throws(() => {
      savePlatformVersion(database, {
        id: platform.data.id, projectId: project.id, contentVersionId: project.contentVersionId, platform: 'x', format: 'text', body: '换基正文',
        expectedRevision: 1
      }, true);
    }, (error) => error?.code === 'REQUEST_REPLAY_CONFLICT');
    const row = database.prepare('SELECT content_version_id AS contentVersionId, revision FROM platform_versions WHERE id=?').get(platform.data.id);
    assert.equal(row.contentVersionId, core2.data.id, '拒绝后平台版本仍指向原核心版本');
    assert.equal(row.revision, 1, '拒绝后平台版本 revision 未变');

    // 未换基更新正常保存（血缘已在创建时固定，不重复写包）
    const pkgBefore = packageOf(database, 'platform_adaptation', platform.data.id);
    const sameBase = savePlatformVersion(database, {
      id: platform.data.id, projectId: project.id, contentVersionId: core2.data.id, platform: 'x', format: 'text', body: '同基修订',
      expectedRevision: 1
    }, true);
    assert.equal(sameBase.ok, true);
    assert.equal(sameBase.data.revision, 2);
    const pkg = packageOf(database, 'platform_adaptation', platform.data.id);
    assert.equal(pkg.id, pkgBefore.id, '未换基更新不重写平台包（血缘在创建时固定）');
    assert.deepEqual([...pkg.wikiPageVersionIds], [fixture.wikiVersionId], '平台包仍为创建时固定血缘');
    assert.equal(listKnowledgeUsagePackages(database, { stage: 'platform_adaptation' }).total, 1, '同一平台版本只一个平台包（无重复写）');
  });
});

test('WMB-5232 final Review 保守回流：发布时固定血缘、限域 qualify/pattern、零新因果 Method、同 ChangeSet 更新 Wiki/Receipt', async () => {
  await withDb((database) => {
    const fixture = seedCompiledTopic(database);
    const project = createContentProjectWithVersion(database, { title: '保守项目', body: '核心 V1', topicId: fixture.topicId, sourceIds: [fixture.sourceId] });
    const platform = savePlatformVersion(database, { projectId: project.id, contentVersionId: project.contentVersionId, platform: 'x', format: 'text', body: '平台 V1' });
    assert.equal(platform.ok, true);

    // Review A：keep 精确命中既有 Claim Note canonicalKey → case + 限域 qualified；单次不建 pattern
    const reviewA = publishAndReview(database, { platformVersionId: platform.data.id, platform: 'x', keep: ['agentforge-v2-multi-router'], label: 'rvA' });
    const reviewAPkg = packageOf(database, 'review', reviewA.reviewId);
    assert.deepEqual([...reviewAPkg.wikiPageVersionIds], [fixture.wikiVersionId], '复盘包固定发布时 Wiki 版本');

    // 同一 ChangeSet：Topic Wiki 追加结果版本 + Receipt 落库
    const receiptA = getUpdateReceiptByRequest(database, 'ws-a', `outcome:review:${reviewA.reviewId}`);
    assert.ok(receiptA, '结果回流 Receipt 必须存在');
    assert.equal(receiptA.triggerType, 'review');
    assert.deepEqual([...receiptA.affectedTopics], [fixture.topicId]);
    const pageRow = database.prepare(`SELECT id FROM knowledge_wiki_pages WHERE subject_type='topic' AND subject_id=? AND lifecycle='active' LIMIT 1`).get(fixture.topicId);
    const wikiAfterA = getWikiPage(database, pageRow.id);
    assert.equal(wikiAfterA.version.id, receiptA.wikiPageVersions[0], 'Wiki 新版本与回执一致（同一 ChangeSet）');
    assert.ok(Array.isArray(wikiAfterA.version.body.recentOutcomes) && wikiAfterA.version.body.recentOutcomes[0].reviewId === reviewA.reviewId, 'Wiki 新版本含 recentOutcomes（Review 后立即可见）');

    // 保守性：case 恰 1 条；claim Note 追加 qualified（限域）；零新因果 Method；单次零 pattern
    const caseNotes = listKnowledgeNotes(database, { kind: 'case' });
    assert.equal(caseNotes.total, 1, '单次 final Review 恰 1 条 case Note');
    const claimNote = database.prepare("SELECT id FROM knowledge_notes WHERE canonical_key='agentforge-v2-multi-router' AND lifecycle='active' LIMIT 1").get();
    const claimCurrent = getKnowledgeNote(database, claimNote.id);
    assert.equal(claimCurrent.version.changeType, 'qualified', 'keep 精确命中既有 Note → 限域 qualified 版本');
    assert.equal(claimCurrent.version.conclusionStatus, 'inference');
    assert.match(claimCurrent.version.appliesTo, /^platform:x\|audience:/, 'qualified 版本限平台/受众/时间窗');
    assert.equal(listKnowledgeNotes(database, { kind: 'method' }).total, 0, 'final Review 零新因果 Method');
    assert.equal(listKnowledgeNotes(database, { kind: 'creative_pattern' }).total, 0, '单次结果零 pattern');

    // 发布后知识更新 → 历史复盘与结果血缘仍固定发布时版本
    const updated = seedKnowledgeUpdate(database, fixture);
    const historical = readPublicationTimeUsage(database, { publicationId: reviewA.publicationId });
    assert.deepEqual([...historical.platformPackage.wikiPageVersionIds], [fixture.wikiVersionId], '平台包仍固定发布时版本');
    assert.deepEqual([...historical.reviewPackages[0].package.wikiPageVersionIds], [fixture.wikiVersionId]);
    const caseVersion = getKnowledgeNote(database, caseNotes.items[0].id).version;
    assert.deepEqual([...caseVersion.adoptedKnowledgeVersionIds], [fixture.noteVersionId], 'case Note 只 pin 发布时固定 Note 版本，不回读更新后 nv-2');
    assert.notEqual(updated.noteVersionId, fixture.noteVersionId);

    // Review B：同 topic + 同 platform/audience + 同 keep 达到 2 次 → 限域 pattern（inference+corroborated），仍零因果 Method
    const platform2 = savePlatformVersion(database, { projectId: project.id, contentVersionId: project.contentVersionId, platform: 'x', format: 'text', body: '平台 V2' });
    assert.equal(platform2.ok, true);
    publishAndReview(database, { platformVersionId: platform2.data.id, platform: 'x', keep: ['agentforge-v2-multi-router'], label: 'rvB' });
    const patterns = listKnowledgeNotes(database, { kind: 'creative_pattern' });
    assert.equal(patterns.total, 1, '重复同向结果（≥2 次）才建立限域 pattern');
    const patternVersion = getKnowledgeNote(database, patterns.items[0].id).version;
    assert.equal(patternVersion.changeType, 'created');
    assert.equal(patternVersion.conclusionStatus, 'inference');
    assert.equal(patternVersion.evidenceLevel, 'corroborated');
    assert.match(patternVersion.appliesTo, /^platform:x\|audience:.*window:/, 'pattern 严格限平台/受众/时间窗');
    assert.match(patternVersion.statement, /不构成因果证明/, 'pattern 语句不宣称因果');
    assert.equal(listKnowledgeNotes(database, { kind: 'method' }).total, 0, '两次复盘后仍零因果 Method');
    assert.equal(listKnowledgeNotes(database, { kind: 'case' }).total, 2, '两次 final Review 两条 case Note');
  });
});

test('WMB-5232 Topic 读模型创作影响投影：五阶段 Usage 固定版本可见', async () => {
  await withDb((database) => {
    const fixture = seedCompiledTopic(database);

    // 走五阶段到平台版本（复盘前：当前 Wiki 仍为编译 V1，投影可全量命中固定版本）
    const proposal = createTopicMaintenanceProposal(database, {
      title: '整理', reason: '资料已更新',
      changes: [{ kind: 'update', topicId: fixture.topicId, after: { title: 'AI Agent 工具链（更新）', canonicalKey: 'ai-agent-toolchain-updated' } }]
    });
    const now = new Date().toISOString();
    const canvasId = 'canvas-1';
    database.prepare('INSERT INTO knowledge_canvases (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(canvasId, '创作画布', now, now);
    database.prepare(`INSERT INTO knowledge_canvas_nodes (id, canvas_id, object_type, object_id, note_title, note_text, x, y, created_at, updated_at)
      VALUES ('cn-topic', ?, 'topic', ?, NULL, NULL, 0, 0, ?, ?)`).run(canvasId, fixture.topicId, now, now);
    const brief = createCreativeBrief(database, {
      canvasId, nodeIds: ['cn-topic'], selectionMode: 'selected',
      title: '简报', coreJudgment: '判断', whyNow: 'why', structure: ['开头'], evidenceNodeIds: ['cn-topic']
    });
    recordCreativeBriefUsage(database, { briefId: brief.id, contextNodeIds: brief.contextNodeIds, reason: 'creative_brief_create' });
    const project = createContentProjectWithVersion(database, { title: '项目', body: 'V1', topicId: fixture.topicId, sourceIds: [fixture.sourceId] });
    const core2 = saveCoreVersion(database, { projectId: project.id, body: 'V2', expectedRevision: 1 });
    assert.equal(core2.ok, true);
    const platform = savePlatformVersion(database, { projectId: project.id, contentVersionId: core2.data.id, platform: 'x', format: 'text', body: '平台' });
    assert.equal(platform.ok, true);

    const detail = getTopicWikiDetail(database, { topicId: fixture.topicId });
    assert.ok(detail.creationImpact, '读模型必须返回创作影响投影');
    assert.equal(detail.creationImpact.total, 10, '五阶段（proposal/brief/core1/core2/platform）× 2 记录（wiki+note）全量命中固定版本');
    const outputTypes = new Set(detail.creationImpact.items.map((item) => item.outputObjectType));
    for (const expected of ['topic_proposal', 'creative_brief', 'content_version', 'platform_version']) {
      assert.ok(outputTypes.has(expected), `投影包含 ${expected} 阶段 Usage`);
    }
    const wikiRecords = detail.creationImpact.items.filter((item) => item.knowledgeVersionKind === 'wiki_page');
    assert.ok(wikiRecords.length >= 5, '投影含全部阶段的 Wiki 固定版本记录');
    assert.ok(wikiRecords.every((item) => item.knowledgeVersionId === fixture.wikiVersionId), '投影 Wiki 版本固定为编译 V1');
    const noteRecords = detail.creationImpact.items.filter((item) => item.knowledgeVersionKind === 'note');
    assert.ok(noteRecords.every((item) => item.knowledgeVersionId === fixture.noteVersionId), '投影 Note 版本固定为采纳 V1');
    const usedCount = detail.creationImpact.items.filter((item) => item.used === true).length;
    const consultedCount = detail.creationImpact.items.filter((item) => item.used === false).length;
    assert.equal(usedCount + consultedCount, detail.creationImpact.total, 'used/consulted 合计等于投影总数');
    assert.ok(usedCount >= 4 && consultedCount >= 5, 'used（Wiki 采用）与 consulted（Note 读取）语义正确呈现');
  });
});
