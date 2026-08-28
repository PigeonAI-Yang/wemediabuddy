import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';
import { createTopic, saveCurrentPlan } from '../src/main/planning.ts';
import { listFermentingBundle } from '../src/main/ferment.ts';
import { createTopicMaintenanceProposal, decideTopicMaintenanceProposal } from '../src/main/topic-maintenance.ts';
import { PROPAGATION_NEUTRAL_GRADE, resolvePropagationGrade } from '../src/shared/propagation.ts';
import { approvePlanItems } from './helpers/planning-fixture.mjs';

async function withDb(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-persist-'));
  await openDataRoot(root);
  const db = migrateDatabase(path.join(root, 'wmb.db'));
  try { await run(db, root); } finally { try { db.close(); } catch {} try { await rm(root, { recursive: true, force: true }); } catch {} }
}
function seedSource(db, id, title) {
  const saved = upsertSource(db, { originalUrl: `https://example.com/${id}`, title, summary: `${title} 摘要足够支撑证据维度`, categories: ['研究补料'], keywords: [], recommendedPlatforms: [], recommendedFormats: [] }, false);
  db.prepare('UPDATE source_items SET collected_at = ?, categories_json = ? WHERE id = ?').run(new Date().toISOString(), JSON.stringify(['研究补料']), saved.id);
  return saved.id;
}
function scoredReasons(score) {
  const weights = [['reader_immediacy_benefit',20],['tension_curiosity_gap',20],['why_now_window',20],['save_share_comment_motive',20],['evidence_credibility',15],['account_fit',5]];
  let remaining = score;
  const reasons = weights.map(([criterion, weight]) => { const s = Math.min(weight, Math.max(0, remaining)); remaining -= s; return { criterion, weight, score: s, reason: `${criterion} reason` }; });
  return { status: 'scored', score, reasons };
}

test('unscored draft cannot promote to fermenting', async () => {
  await withDb(async (db) => {
    const src = seedSource(db, 'src-draft', '草案资料');
    const beforeTopics = Number(db.prepare('SELECT count(*) as c FROM topics').get().c);
    saveCurrentPlan(db, { planDate:'2026-08-25', timezone:'Asia/Shanghai', summary:'draft test', items: [{
      title:'草案治理话题：综合框架与未来考量', priority:1, whyNow:'值得关注，未来可期', timeliness:'长期', targetAudience:'泛科技受众', angle:'泛泛而谈角度', pointOfView:'需要综合考虑多方因素形成治理框架', platforms:['x'], formats:['text'], titleGuidance:'标题', openingGuidance:'开头', structureGuidance:'方向判断', effortEstimate:'约 40 分钟', sourceIds:[src]
    }]});
    const afterTopics = Number(db.prepare('SELECT count(*) as c FROM topics').get().c);
    assert.equal(afterTopics, beforeTopics, 'draft multi-day must not auto-create topic');
    const bundle = listFermentingBundle(db, '2026-08-25');
    assert.equal(bundle.items.length, 0, 'draft should not appear in fermenting');
    assert.equal(bundle.watchingItems.length, 0);
  });
});

test('scored approved can promote to fermenting', async () => {
  await withDb(async (db) => {
    const src = seedSource(db, 'src-scored', '实证资料');
    const scored = scoredReasons(82);
    const topicId = createTopic(db, '小红书 AI 涨粉方法').id;
    const saved = saveCurrentPlan(db, { planDate:'2026-08-25', timezone:'Asia/Shanghai', summary:'scored test', items: [{
      title:'小红书 AI 涨粉：用对比钩子让收藏翻倍的 3 步模板', priority:1, whyNow:'2026-08-25 窗口期 7 天，对比钩子收藏率高 2.3 倍', timeliness:'持续/多日', targetAudience:'在小红书做 AI 内容但收藏低的人', angle:'给出可直接套用的标题与结构模板，含数字/对比钩子', pointOfView:'对比钩子比泛泛科普更易获得收藏，值得今天就用模板重做 1 篇', platforms:['xiaohongshu'], formats:['text'], titleGuidance:'标题', openingGuidance:'首段立刻兑现钩子', structureGuidance:'方向判断', effortEstimate:'约 40 分钟', sourceIds:[src], topicId, scoreReasons: scored
    }]});
    approvePlanItems(db, [db.prepare('SELECT id FROM plan_items WHERE plan_id=?').get(saved.id).id]);
    const pi = db.prepare('SELECT id, planning_status, score_reasons_json, topic_id FROM plan_items WHERE plan_id=?').get(saved.id);
    assert.equal(pi.planning_status, 'approved');
    const bundle = listFermentingBundle(db, '2026-08-25');
    assert.ok(bundle.items.length >= 1, `scored approved should appear, got ${bundle.items.length}`);
    const found = bundle.items.find(i=>i.topicId===pi.topic_id) || bundle.topics.find(t=>t.topicId===pi.topic_id);
    assert.ok(found, 'created topic should be in bundle');
    const grade = resolvePropagationGrade({ planning_status:'approved', score_reasons_json: pi.score_reasons_json });
    assert.notEqual(grade, PROPAGATION_NEUTRAL_GRADE);
  });
});

test('plan-linked legacy approved without score is excluded', async () => {
  await withDb(async (db) => {
    const src = seedSource(db, 'src-legacy', '遗留资料');
    const topicId = `legacy-${Date.now()}`;
    db.prepare(`INSERT INTO topics (id, title, created_at, updated_at, revision, canonical_key, kind, summary, status, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, 1, ?, 'theme', NULL, 'active', ?, ?)`).run(topicId, '遗留批准但无评分的主题', new Date().toISOString(), new Date().toISOString(), 'legacy', new Date().toISOString(), new Date().toISOString());
    db.prepare(`INSERT INTO topic_source_links (topic_id, source_id, relation, created_at, updated_at) VALUES (?, ?, 'primary', ?, ?)`).run(topicId, src, new Date().toISOString(), new Date().toISOString());
    const planId = 'plan-legacy';
    db.prepare(`INSERT INTO plans (id, plan_date, timezone, summary, is_current, created_at, updated_at, revision) VALUES (?, '2026-08-25', 'Asia/Shanghai', 'legacy no score', 1, ?, ?, 1)`).run(planId, new Date().toISOString(), new Date().toISOString());
    const prov = JSON.stringify({ origin:'migration', legacy:'legacy_approved', transitions:[{from:null,to:'approved',by:'system',at:new Date().toISOString()}] });
    // empty score {} and pending both must NOT qualify
    db.prepare(`INSERT INTO plan_items (id, plan_id, topic_id, title, priority, why_now, timeliness, target_audience, angle, point_of_view, platforms_json, formats_json, title_guidance, opening_guidance, structure_guidance, effort_estimate, source_ids_json, available_materials_json, missing_materials_json, review_ids_json, method_finding_ids_json, sort_order, created_at, updated_at, revision, score_reasons_json, planning_status, planning_provenance_json) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?, ?)`).run('pi-legacy-empty', planId, topicId, '遗留批准但无评分的主题', '窗口', '持续/多日', '受众', '角度', '观点', '[]','[]','标题','开头','结构','40分钟', JSON.stringify([src]), '[]','[]','[]','[]', new Date().toISOString(), new Date().toISOString(), '{}', 'approved', prov);
    // also add a pending draft-like scored object but with approved status? Actually pending status should also be excluded
    db.prepare(`INSERT INTO plan_items (id, plan_id, topic_id, title, priority, why_now, timeliness, target_audience, angle, point_of_view, platforms_json, formats_json, title_guidance, opening_guidance, structure_guidance, effort_estimate, source_ids_json, available_materials_json, missing_materials_json, review_ids_json, method_finding_ids_json, sort_order, created_at, updated_at, revision, score_reasons_json, planning_status, planning_provenance_json) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 1, ?, ?, ?)`).run('pi-legacy-pending', planId, topicId, '遗留批准待评分', '窗口', '长期', '受众', '角度', '观点', '[]','[]','标题','开头','结构','40分钟', JSON.stringify([src]), '[]','[]','[]','[]', new Date().toISOString(), new Date().toISOString(), JSON.stringify({ status:'pending', score:0, reasons:[] }), 'approved', prov);
    db.prepare(`INSERT INTO work_carry_items (id, object_type, object_id, fingerprint, title, state, priority, topic_id, source_ids_json, origin_plan_date, first_seen_at, last_seen_at, expires_at, decay_score, reason, aftershock_json, created_at, updated_at, revision, story_key) VALUES (?, 'plan_item', ?, ?, ?, 'active', 1, ?, ?, '2026-08-25', ?, ?, ?, 1, 'test', '[]', ?, ?, 1, ?)`).run(`carry-${topicId}`, 'pi-legacy-empty', `fp-${topicId}`, '遗留批准但无评分的主题', topicId, JSON.stringify([src]), new Date().toISOString(), new Date().toISOString(), new Date(Date.now()+7*86400000).toISOString(), new Date().toISOString(), new Date().toISOString(), `plan:${topicId}`);
    const bundle = listFermentingBundle(db, '2026-08-25');
    const found = bundle.items.find(i=>i.topicId===topicId) || bundle.topics.find(t=>t.topicId===topicId) || bundle.items.find(i=>i.title==='遗留批准但无评分的主题');
    assert.ok(!found, 'legacy approved without valid scored propagation must be excluded');
  });
});

test('true manual zero-plan topic qualifies', async () => {
  await withDb(async (db) => {
    const src = seedSource(db, 'src-manual-zero', '手动零计划资料');
    const topicId = `manual-zero-${Date.now()}`;
    db.prepare(`INSERT INTO topics (id, title, created_at, updated_at, revision, canonical_key, kind, summary, status, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, 1, ?, 'theme', NULL, 'active', ?, ?)`).run(topicId, '真手动零计划持久主题', new Date().toISOString(), new Date().toISOString(), 'manual-zero', new Date().toISOString(), new Date().toISOString());
    db.prepare(`INSERT INTO topic_source_links (topic_id, source_id, relation, created_at, updated_at) VALUES (?, ?, 'primary', ?, ?)`).run(topicId, src, new Date().toISOString(), new Date().toISOString());
    // No plan_items at all for this topicId -> zero-plan manual
    // Need at least one active carry or recent link to be considered for projection; ensure it has recent source link and active carry
    // Insert a work_carry for topic projection? Actually listFermentingBundle projects topics regardless of carry existence if they have source links recent or carry. We'll rely on topic+source link path.
    // To guarantee projection, also seed a watching-like carry via source link recency is enough if qualified and within window.
    // However our topic has no carry yet; listFermentingBundle will still include it via EXISTS plan_items OR source_links and last_seen_at check.
    // Ensure last_seen_at recent
    db.prepare(`UPDATE topics SET last_seen_at=? WHERE id=?`).run(new Date().toISOString(), topicId);
    const bundle = listFermentingBundle(db, '2026-08-25');
    const found = bundle.items.find(i=>i.topicId===topicId) || bundle.topics.find(t=>t.topicId===topicId);
    assert.ok(found, 'true manual zero-plan topic with source link should qualify');
  });
});

test('equivalent theses dedupe across active persistent topics and new promotions', async () => {
  await withDb(async (db) => {
    const src1 = seedSource(db, 'src-dedupe-1', '资料1');
    const src2 = seedSource(db, 'src-dedupe-2', '资料2');
    const pov = '价值不由最好的一次输出决定，而由可复跑的评测与验收标准决定，强调可验收的真实项目与公开验证';
    const angle = '选一个重复任务，写10个真实样本和验收标准，公开测试与复盘';
    const audience = '正在把提示词/Agent/自动化流程做成真实交付的人';
    const scored = scoredReasons(82);
    const topicId = createTopic(db, '可复跑评测体系').id;
    const first = saveCurrentPlan(db, { planDate:'2026-08-25', timezone:'Asia/Shanghai', summary:'first', items:[{
      title:'别再展示 AI 做成了什么，先把它放进一套能复跑的评测里', priority:1, whyNow:'窗口', timeliness:'持续/多日', targetAudience:audience, angle, pointOfView:pov, platforms:['x'], formats:['text'], titleGuidance:'标题', openingGuidance:'开头', structureGuidance:'方向判断', effortEstimate:'40分钟', sourceIds:[src1], topicId, scoreReasons: scored
    }]});
    approvePlanItems(db, [db.prepare('SELECT id FROM plan_items WHERE plan_id=?').get(first.id).id]);
    const firstBundle = listFermentingBundle(db, '2026-08-25');
    assert.equal(firstBundle.items.length, 1);
    let threw = false;
    try {
      saveCurrentPlan(db, { planDate:'2026-08-26', timezone:'Asia/Shanghai', summary:'dup', items:[{
        title:'一次成功的 Agent 演示，为什么还不能算交付能力', priority:1, whyNow:'窗口', timeliness:'持续/多日', targetAudience:audience, angle, pointOfView:pov, platforms:['x'], formats:['text'], titleGuidance:'标题', openingGuidance:'开头', structureGuidance:'方向判断', effortEstimate:'40分钟', sourceIds:[src2], scoreReasons: scored
      }]});
    } catch (e) { threw = true; assert.ok(String(e.message).includes('thesis')); }
    assert.ok(threw, 'duplicate thesis across active should reject');
    const dupTopicId = 'dup-topic-direct';
    db.prepare(`INSERT INTO topics (id, title, created_at, updated_at, revision, canonical_key, kind, summary, status, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, 1, ?, 'theme', NULL, 'active', ?, ?)`).run(dupTopicId, '批量生成视频以后，先用一致性和闪烁把废片筛掉', new Date().toISOString(), new Date().toISOString(), 'dup', new Date().toISOString(), new Date().toISOString());
    db.prepare(`INSERT INTO topic_source_links (topic_id, source_id, relation, created_at, updated_at) VALUES (?, ?, 'primary', ?, ?)`).run(dupTopicId, src2, new Date().toISOString(), new Date().toISOString());
    const planId2 = 'plan-dup-direct';
    db.prepare(`INSERT INTO plans (id, plan_date, timezone, summary, is_current, created_at, updated_at, revision) VALUES (?, '2026-08-26', 'Asia/Shanghai', 'direct dup', 1, ?, ?, 1)`).run(planId2, new Date().toISOString(), new Date().toISOString());
    const scored2 = JSON.stringify(scored);
    const prov2 = JSON.stringify({ origin:'daily_judge', transitions:[{from:null,to:'approved',by:'system',at:new Date().toISOString()}] });
    db.prepare(`INSERT INTO plan_items (id, plan_id, topic_id, title, priority, why_now, timeliness, target_audience, angle, point_of_view, platforms_json, formats_json, title_guidance, opening_guidance, structure_guidance, effort_estimate, source_ids_json, available_materials_json, missing_materials_json, review_ids_json, method_finding_ids_json, sort_order, created_at, updated_at, revision, score_reasons_json, planning_status, planning_provenance_json) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?, ?)`).run('pi-dup-direct', planId2, dupTopicId, '批量生成视频以后，先用一致性和闪烁把废片筛掉', '窗口', '持续/多日', audience, angle, pov, '[]','[]','标题','开头','结构','40分钟', JSON.stringify([src2]), '[]','[]','[]','[]', new Date().toISOString(), new Date().toISOString(), scored2, 'approved', prov2);
    const bundle2 = listFermentingBundle(db, '2026-08-26');
    assert.equal(bundle2.items.length, 1, `dedupe should leave 1, got ${bundle2.items.length} titles: ${bundle2.items.map(i=>i.title).join('|')}`);
  });
});

test('reversible retirement preserves records and fermenting excludes', async () => {
  await withDb(async (db) => {
    const src = seedSource(db, 'src-retire', '退役资料');
    const scored = scoredReasons(75);
    const seededTopicId = createTopic(db, '可退役对比钩子主题').id;
    const saved = saveCurrentPlan(db, { planDate:'2026-08-25', timezone:'Asia/Shanghai', summary:'retire test', items:[{
      title:'可退役主题：用对比钩子让收藏翻倍的 3 步模板', priority:1, whyNow:'窗口', timeliness:'持续/多日', targetAudience:'小红书运营', angle:'对比钩子模板', pointOfView:'对比钩子比泛泛科普更易获得收藏', platforms:['xiaohongshu'], formats:['text'], titleGuidance:'标题', openingGuidance:'开头', structureGuidance:'方向判断', effortEstimate:'40分钟', sourceIds:[src], topicId: seededTopicId, scoreReasons: scored
    }]});
    approvePlanItems(db, [db.prepare('SELECT id FROM plan_items WHERE plan_id=?').get(saved.id).id]);
    const pi = db.prepare('SELECT topic_id FROM plan_items WHERE plan_id=?').get(saved.id);
    const topicId = pi.topic_id;
    assert.ok(topicId);
    let bundleBefore = listFermentingBundle(db, '2026-08-25');
    assert.ok(bundleBefore.items.some(i=>i.topicId===topicId), 'should be visible before archive');
    const proposal = createTopicMaintenanceProposal(db, { title:'退役测试归档', reason:'draft origin not qualified, archive with audit', changes:[{ kind:'archive', topicId }] });
    assert.equal(proposal.status, 'proposed');
    const decided = decideTopicMaintenanceProposal(db, { id: proposal.id, expectedRevision: proposal.revision, decision:'approve' });
    assert.equal(decided.status, 'approved');
    const topicAfter = db.prepare('SELECT * FROM topics WHERE id=?').get(topicId);
    assert.ok(topicAfter, 'record must still exist (never delete)');
    assert.equal(topicAfter.status, 'archived', 'status should be archived');
    const bundleAfter = listFermentingBundle(db, '2026-08-25');
    assert.ok(!bundleAfter.items.some(i=>i.topicId===topicId), 'archived should be excluded from fermenting');
    const restoreProposal = createTopicMaintenanceProposal(db, { title:'恢复测试', reason:'owner manual restore', changes:[{ kind:'update', topicId, after:{ title: String(topicAfter.title), status:'active' } }] });
    const restoreDecided = decideTopicMaintenanceProposal(db, { id: restoreProposal.id, expectedRevision: restoreProposal.revision, decision:'approve' });
    assert.equal(restoreDecided.status, 'approved');
    const topicRestored = db.prepare('SELECT status FROM topics WHERE id=?').get(topicId);
    assert.equal(topicRestored.status, 'active');
    const bundleRestored = listFermentingBundle(db, '2026-08-25');
    assert.ok(bundleRestored.items.some(i=>i.topicId===topicId), 'restored should be visible again');
  });
});
