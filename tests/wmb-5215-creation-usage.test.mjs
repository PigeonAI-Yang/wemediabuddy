/**
 * WMB-5215 M6：创作知识调用血缘集成（本 worker：IntegrateCreationUsage）。
 * 验收：真实 Topic Wiki→选题提案→简报→核心版本→平台版本→复盘固定版本可追溯；
 * consulted 不冒充 used；usage 失败内容版本零提交；平台换基（事实变化）拒绝；
 * 历史复盘读发布时固定血缘（不读未来知识）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { applyKnowledgeChangeSet, getWikiPage, getWikiPageVersion } from '../src/main/knowledge-flywheel.ts';
import {
  createContentProjectWithVersion,
  createProjectFromPlanItem,
  saveCoreVersion,
  savePlatformVersion
} from '../src/main/content.ts';
import { createTopicMaintenanceProposal } from '../src/main/topic-maintenance.ts';
import { createCreativeBrief } from '../src/main/knowledge-canvas.ts';
import { createPublication } from '../src/main/publishing.ts';
import { savePublicationMetricSnapshot } from '../src/main/metrics.ts';
import { saveReview, listReviews } from '../src/main/reviews.ts';
import { saveAccount } from '../src/main/accounts.ts';
import { upsertSource } from '../src/main/sources.ts';
import { getKnowledgeUsagePackageByRequest, listKnowledgeUsageRecords, listKnowledgeUsagePackages } from '../src/main/knowledge-usage.ts';
import { readPublicationTimeUsage, recordCreativeBriefUsage, usageRequestId } from '../src/main/knowledge-usage-integration.ts';

async function withDb(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5215-'));
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

function csMeta(requestId, reason = '测试') {
  return { workspaceId: 'ws-a', requestId, reason, triggerSource: 'ingest', resolutionMode: 'none', createdBy: 'background_agent' };
}

/** 知识侧种子：Source + Topic + Claim Note(版本 nv-1) + Topic Wiki(版本 wv-1，采纳 nv-1) + 证据链。 */
function seedKnowledge(database) {
  const source = upsertSource(database, { originalUrl: 'https://example.com/seed', title: '种子资料' });
  database.prepare(`INSERT INTO topics (id, title, created_at, updated_at, revision, canonical_key, kind, status, first_seen_at, last_seen_at)
    VALUES ('topic-a', 'AI 赛道', ?, ?, 1, 'ai-赛道', 'theme', 'active', ?, ?)`).run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  applyKnowledgeChangeSet(database, csMeta('cs-seed-1'), {
    notes: [{
      id: 'note-a', scope: 'global', kind: 'claim', canonicalKey: 'claim-ai-1', title: 'AI 关键事实',
      version: { versionId: 'nv-1', statement: 'AI 赛道新关键事实', conclusionStatus: 'supported', evidenceLevel: 'primary' }
    }],
    wikiPages: [{
      id: 'page-a', scope: 'global', pageType: 'topic', canonicalKey: 'wiki-ai-topic', title: 'AI 赛道 Wiki', subjectType: 'topic', subjectId: 'topic-a',
      version: { versionId: 'wv-1', body: { summary: '当前综合' }, adoptedNoteVersionIds: ['nv-1'], changeSummary: '首版', compileReason: '测试' }
    }],
    evidenceLinks: [{ id: 'ev-1', knowledgeNoteVersionId: 'nv-1', evidenceObjectType: 'source', evidenceObjectId: source.id, relation: 'supports', sourceNature: 'primary_source' }]
  });
  return { sourceId: source.id };
}

function seedPublished(database, sourceId) {
  const account = saveAccount(database, { platform: 'x', accountKey: '@tester', displayName: 'tester', loginState: 'authenticated' });
  const project = createContentProjectWithVersion(database, { title: '创作项目', body: '首版正文', topicId: 'topic-a', sourceIds: sourceId ? [sourceId] : [] });
  assert.ok(project.contentVersionId);
  const core2 = saveCoreVersion(database, { projectId: project.id, body: '核心正文 V2', expectedRevision: 1 });
  assert.equal(core2.ok, true);
  const platform = savePlatformVersion(database, { projectId: project.id, contentVersionId: core2.data.id, platform: 'x', format: 'text', body: '平台正文' });
  assert.equal(platform.ok, true);
  const publication = createPublication(database, { platformVersionId: platform.data.id, accountId: account.id });
  assert.equal(publication.ok, true);
  const now = new Date().toISOString();
  database.prepare(`UPDATE publications SET status='published', external_url=?, external_id=?, published_at=?, prepared_title=?, prepared_body=?, prepared_assets_json='[]', updated_at=?, revision=? WHERE id=?`)
    .run('https://x.com/tester/status/1', '1', now, null, '平台正文', now, 2, publication.data.id);
  const snap = savePublicationMetricSnapshot(database, {
    publicationId: publication.data.id, scheduledFor: now, sourceUrl: 'https://x.com/tester/status/1', capturedAt: now,
    normalized: { views: { status: 'value', value: 10, rawLabel: '10' } }, raw: { views: { status: 'value', value: 10, rawLabel: '10' } }
  });
  assert.equal(snap.ok, true);
  return { publicationId: publication.data.id, projectId: project.id, core1Id: project.contentVersionId, core2Id: core2.data.id, platformVersionId: platform.data.id, snapshotId: snap.data.id };
}

function packageOf(database, stage, objectId) {
  return getKnowledgeUsagePackageByRequest(database, 'ws-a', usageRequestId(stage, objectId));
}

test('WMB-5215 Topic→proposal→brief→core→platform→review 固定版本可追溯', async () => {
  await withDb((database) => {
    seedKnowledge(database);

    // 1) 选题呈报：Topic 整理提案冻结固定 Wiki 版本（consulted，不冒充 used）
    const proposal = createTopicMaintenanceProposal(database, {
      title: 'AI 赛道整理', reason: '资料已更新',
      changes: [{ kind: 'update', topicId: 'topic-a', after: { title: 'AI 赛道（更新）', canonicalKey: 'ai-赛道-updated' } }]
    });
    const proposalPkg = packageOf(database, 'topic_proposal', proposal.id);
    assert.ok(proposalPkg, '选题提案应有 usage 包');
    assert.equal(proposalPkg.stage, 'topic_proposal');
    assert.deepEqual([...proposalPkg.wikiPageVersionIds], ['wv-1'], '提案冻结 Topic Wiki 固定版本');
    const proposalRecords = listKnowledgeUsageRecords(database, { packageId: proposalPkg.id });
    assert.equal(proposalRecords.items.length, 2, '提案记录：wiki V1 + note V1');
    assert.ok(proposalRecords.items.every((record) => record.used === false), '提案阶段全部 consulted（used=0）');

    // 2) 创作简报：画布选中 Topic → brief 记录固定血缘
    const canvasId = 'canvas-1';
    const now = new Date().toISOString();
    database.prepare('INSERT INTO knowledge_canvases (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(canvasId, '创作画布', now, now);
    database.prepare(`INSERT INTO knowledge_canvas_nodes (id, canvas_id, object_type, object_id, note_title, note_text, x, y, created_at, updated_at)
      VALUES ('cn-topic', ?, 'topic', 'topic-a', NULL, NULL, 0, 0, ?, ?)`).run(canvasId, now, now);
    const brief = createCreativeBrief(database, {      canvasId, nodeIds: ['cn-topic'], selectionMode: 'selected',
      title: 'AI 赛道简报', coreJudgment: '核心判断', whyNow: '为什么现在',
      structure: ['开头', '正文'], evidenceNodeIds: ['cn-topic']
    });
    recordCreativeBriefUsage(database, { briefId: brief.id, contextNodeIds: brief.contextNodeIds, reason: 'creative_brief_create' });
    const briefPkg = packageOf(database, 'creative_brief', brief.id);
    assert.ok(briefPkg, '简报应有 usage 包');
    assert.deepEqual([...briefPkg.wikiPageVersionIds], ['wv-1'], '简报固定 Topic Wiki 版本');
    const briefRecords = listKnowledgeUsageRecords(database, { packageId: briefPkg.id });
    const briefUsed = briefRecords.items.filter((record) => record.used === true);
    const briefConsulted = briefRecords.items.filter((record) => record.used === false);
    assert.equal(briefUsed.length, 1, '简报 used 恰 1 条（Wiki reasoning_basis）');
    assert.equal(briefUsed[0].usageKind, 'reasoning_basis');
    assert.equal(briefUsed[0].outputObjectType, 'creative_brief');
    assert.equal(briefConsulted.length, 1, '简报 consulted 恰 1 条（Note）');
    assert.equal(briefConsulted[0].usageKind, 'consulted');

    // 3) 核心版本（首个版本经 brief→project 路径；随后 saveCoreVersion）
    const core1 = createContentProjectWithVersion(database, { title: 'AI 项目', body: '核心 V1', topicId: 'topic-a', sourceIds: [] });
    const core1Pkg = packageOf(database, 'core_draft', core1.contentVersionId);
    assert.ok(core1Pkg, '首个核心版本应有 usage 包');
    assert.deepEqual([...core1Pkg.wikiPageVersionIds], ['wv-1']);
    const core1Records = listKnowledgeUsageRecords(database, { packageId: core1Pkg.id });
    assert.equal(core1Records.items.filter((record) => record.used === true).length, 1, '核心 used 恰 1 条（Wiki reasoning_basis）');
    assert.equal(core1Records.items.filter((record) => record.used === false).length, 1, '核心 consulted 恰 1 条（Note）');

    const core2 = saveCoreVersion(database, { projectId: core1.id, body: '核心 V2', expectedRevision: 1 });
    assert.equal(core2.ok, true);
    const core2Pkg = packageOf(database, 'core_draft', core2.data.id);
    assert.ok(core2Pkg, '第二个核心版本应有 usage 包');
    assert.deepEqual([...core2Pkg.wikiPageVersionIds], ['wv-1']);

    // 4) 平台版本继承核心血缘（与 core2 同一批固定版本）
    const platform = savePlatformVersion(database, { projectId: core1.id, contentVersionId: core2.data.id, platform: 'xiaohongshu', format: 'text', body: '平台 V1' });
    assert.equal(platform.ok, true);
    const platformPkg = packageOf(database, 'platform_adaptation', platform.data.id);
    assert.ok(platformPkg, '平台版本应有 usage 包');
    assert.deepEqual([...platformPkg.wikiPageVersionIds], ['wv-1'], '平台继承核心血缘（同一 Wiki 固定版本）');
    const platformRecords = listKnowledgeUsageRecords(database, { packageId: platformPkg.id });
    const platformUsed = platformRecords.items.filter((record) => record.used === true);
    assert.equal(platformUsed.length, 1);
    assert.equal(platformUsed[0].usageKind, 'structure_pattern');
    assert.equal(platformUsed[0].outputObjectType, 'platform_version');
    assert.equal(platformUsed[0].outputObjectId, platform.data.id);

    // 5) 复盘：发布时固定版本
    const account = saveAccount(database, { platform: 'xiaohongshu', accountKey: '@tester-1', displayName: 'tester', loginState: 'authenticated' });
    const publication = createPublication(database, { platformVersionId: platform.data.id, accountId: account.id });
    assert.equal(publication.ok, true);
    const pubNow = new Date().toISOString();
    database.prepare(`UPDATE publications SET status='published', external_url=?, external_id=?, published_at=?, prepared_title=?, prepared_body=?, prepared_assets_json='[]', updated_at=?, revision=? WHERE id=?`)
      .run('https://x.com/tester/2', '2', pubNow, null, '平台 V1', pubNow, 2, publication.data.id);
    const snap = savePublicationMetricSnapshot(database, {
      publicationId: publication.data.id, scheduledFor: pubNow, sourceUrl: 'https://x.com/tester/2', capturedAt: pubNow,
      normalized: { views: { status: 'value', value: 100, rawLabel: '100' } }, raw: { views: { status: 'value', value: 100, rawLabel: '100' } }
    });
    assert.equal(snap.ok, true);
    const review = saveReview(database, {
      publicationId: publication.data.id, metricSnapshotIds: [snap.data.id],
      keep: ['keep'], stop: ['stop'], change: ['change'], status: 'final', summary: '复盘'
    });
    assert.equal(review.ok, true);
    const reviewPkg = packageOf(database, 'review', review.data.id);
    assert.ok(reviewPkg, '复盘应有 usage 包');
    assert.deepEqual([...reviewPkg.wikiPageVersionIds], ['wv-1'], '复盘固定发布时 Wiki 版本');

    // 6) 知识更新后：历史复盘仍读发布时固定血缘（不回读未来知识）
    // WMB-5216 结果回流会在 final Review 保存时原子重编译 Topic Wiki（追加结果观察版本），
    // 因此这里以语义断言读取当前 revision 追加编译版本，不断言固定 revision。
    const pageBefore = getWikiPage(database, 'page-a');
    applyKnowledgeChangeSet(database, csMeta('cs-seed-2', '知识更新'), {
      wikiPages: [{
        id: 'page-a', beforeRevision: pageBefore.page.revision, scope: 'global', pageType: 'topic', canonicalKey: 'wiki-ai-topic', subjectType: 'topic', subjectId: 'topic-a',
        version: { versionId: 'wv-2', body: { summary: '更新后综合' }, adoptedNoteVersionIds: ['nv-1'], changeSummary: '更新', compileReason: '测试' }
      }]
    });
    const currentWiki = getWikiPage(database, 'page-a');
    assert.equal(currentWiki.version.id, 'wv-2', '当前 Wiki 已更新到 V2');
    const pageVersions = database.prepare('SELECT id FROM knowledge_wiki_page_versions WHERE page_id = ? ORDER BY version_number').all('page-a');
    const outcomeVersion = pageVersions.map((row) => getWikiPageVersion(database, row.id)).find((version) => version.body?.recentOutcomes?.length >= 1);
    assert.ok(outcomeVersion, 'Review 结果回流已立即写入 Topic Wiki 新版本（recentOutcomes 可见）');
    const historical = readPublicationTimeUsage(database, { publicationId: publication.data.id });
    assert.ok(historical, '历史复盘应能读到发布时血缘');
    assert.deepEqual([...historical.platformPackage.wikiPageVersionIds], ['wv-1'], '复盘读取发布时平台包固定版本，而非当前 wv-2');
    assert.deepEqual([...historical.corePackage.wikiPageVersionIds], ['wv-1'], '复盘读取发布时核心包固定版本');
    assert.equal(historical.reviewPackages.length, 1);
    assert.deepEqual([...historical.reviewPackages[0].package.wikiPageVersionIds], ['wv-1']);
  });
});

test('WMB-5215 平台换基核心版本（事实变化）拒绝保存', async () => {
  await withDb((database) => {
    const { sourceId } = seedKnowledge(database);
    const { projectId, core1Id, core2Id, platformVersionId } = seedPublished(database, sourceId);
    // 平台版本更新但换基到不同核心版本 → 拒绝且零变更
    assert.throws(() => {
      savePlatformVersion(database, {
        id: platformVersionId, projectId, contentVersionId: core1Id, platform: 'x', format: 'text', body: '换基正文',
        expectedRevision: 1
      }, true);
    }, (error) => error?.code === 'REQUEST_REPLAY_CONFLICT');
    const row = database.prepare('SELECT content_version_id AS contentVersionId, revision FROM platform_versions WHERE id=?').get(platformVersionId);
    assert.equal(row.contentVersionId, core2Id, '拒绝后平台版本仍指向原核心版本');
    assert.equal(row.revision, 1, '拒绝后平台版本 revision 未变');
    // 未换基更新正常保存（血缘已在创建时固定）
    const sameBase = savePlatformVersion(database, {
      id: platformVersionId, projectId, contentVersionId: core2Id, platform: 'x', format: 'text', body: '同基修订',
      expectedRevision: 1
    }, true);
    assert.equal(sameBase.ok, true);
    assert.equal(sameBase.data.revision, 2);
  });
});

test('WMB-5215 usage 保存失败 → 内容版本零提交', async () => {
  await withDb((database) => {
    seedKnowledge(database);
    const project = createContentProjectWithVersion(database, { title: '原子项目', body: 'V1', topicId: 'topic-a' });
    const before = Number(database.prepare('SELECT count(*) AS c FROM content_versions').get().c);
    // 制造 usage 写必然失败：删除 usage 表（先子后父避免 FK 约束；仅本测试库）
    database.exec('DROP TABLE knowledge_usage_records');
    database.exec('DROP TABLE knowledge_usage_packages');
    assert.throws(() => {
      saveCoreVersion(database, { projectId: project.id, body: '不应落库', expectedRevision: 1 }, true);
    }, (error) => /no such table|KNOWLEDGE_USAGE/i.test(String(error?.message ?? error)));
    const after = Number(database.prepare('SELECT count(*) AS c FROM content_versions').get().c);
    assert.equal(after, before, 'usage 失败后核心版本零新增');
    assert.equal(listReviews(database).length, 0);
  });
});

test('WMB-5215 选题采纳（plan item）核心版本携带 plan_item 血缘', async () => {
  await withDb((database) => {
    seedKnowledge(database);
    const now = new Date().toISOString();
    database.prepare(`INSERT INTO plans (id, plan_date, timezone, summary, is_current, created_at, updated_at, revision)
      VALUES ('plan-1', '2026-08-12', 'Asia/Shanghai', '当日计划', 1, ?, ?, 1)`).run(now, now);
    database.prepare(`INSERT INTO plan_items (id, plan_id, topic_id, title, priority, why_now, timeliness, target_audience, angle, point_of_view,
      platforms_json, formats_json, title_guidance, opening_guidance, structure_guidance, effort_estimate, source_ids_json,
      review_ids_json, method_finding_ids_json, sort_order, created_at, updated_at, revision)
      VALUES ('plan-item-1', 'plan-1', 'topic-a', '选题采纳', 1, 'why', 'now', '受众', '角度', '观点',
      '["x"]', '["text"]', '标题', '开头', '结构', '低', '[]', '[]', '[]', 1, ?, ?, 1)`).run(now, now);
    const adopted = createProjectFromPlanItem(database, 'plan-item-1', true);
    assert.equal(adopted.created, true);
    const versionId = database.prepare('SELECT id FROM content_versions WHERE project_id=? ORDER BY version_number DESC LIMIT 1').get(adopted.id).id;
    const corePkg = packageOf(database, 'core_draft', versionId);
    assert.ok(corePkg, '选题采纳首版应有 usage 包');
    assert.equal(corePkg.planItemId, 'plan-item-1', 'core 包携带 plan_item 血缘');
    assert.equal(corePkg.topicId, 'topic-a');
    assert.deepEqual([...corePkg.wikiPageVersionIds], ['wv-1']);
  });
});

test('WMB-5215 全程包清单只经单一 store（无第二套 schema）', async () => {
  await withDb((database) => {
    seedKnowledge(database);
    const all = listKnowledgeUsagePackages(database, {});
    assert.equal(all.total, 0, '未发生创作保存时零包');
    const core1 = createContentProjectWithVersion(database, { title: '包计数项目', body: 'V1', topicId: 'topic-a' });
    const listed = listKnowledgeUsagePackages(database, { projectId: core1.id });
    assert.equal(listed.total, 1);
    assert.equal(listed.items[0].requestId, usageRequestId('core_draft', core1.contentVersionId));
  });
});
