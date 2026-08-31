// WMB-5332 focused gates: six-dim scoring, hard-risk reject-before-score, 30d duplicate, routing, ties, boundary backfill, quota-full.
// Verify via: node --test tests/wmb-5332-scoring.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const scoring = await import('../src/main/zhihu-hot-scoring.ts');
const { getProposalLedger } = await import('../src/main/proposals.ts');
const { editorialDecision, scoredReasons } = await import('./helpers/planning-fixture.mjs');

function withTempDir(work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmb5332-'));
  try { return work(dir); } finally { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {} }
}
function migrateFresh(dir) {
  const dbPath = path.join(dir, 'wmb.db');
  const db = migrateDatabase(dbPath);
  db.prepare("INSERT INTO app_meta (key,value,created_at,updated_at,revision) VALUES ('workspace_id','ws-5332','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)").run();
  return db;
}
function makeCandidate(overrides) {
  return {
    id: `c-${Math.random().toString(36).slice(2,6)}`,
    title: 'Test Question',
    canonicalUrl: 'https://www.zhihu.com/question/123456789',
    audienceFit: 20,
    viewpointRoom: 15,
    evidenceAvailability: 15,
    timelinessLifecycle: 10,
    articleVideoTransfer: 10,
    executionCost: 3,
    hardRisks: [],
    dimensionEvidence: {},
    rank: 1,
    ...overrides
  };
}
function seedEvidence(db, candidates) {
  const now = '2026-08-28T00:00:00.000Z';
  db.prepare("INSERT OR IGNORE INTO source_feeds (id,name,created_at,updated_at,revision) VALUES ('score-feed','score fixtures',?,?,1)").run(now, now);
  for (const candidate of candidates) {
    const requested = candidate.audienceFit + candidate.viewpointRoom + candidate.evidenceAvailability + candidate.timelinessLifecycle + candidate.articleVideoTransfer + candidate.executionCost;
    const rich = requested >= 75;
    const medium = requested >= 55 && !rich;
    const summary = rich
      ? 'AI 大模型行业技术变化带来明确用户影响与执行窗口。'.repeat(30)
      : medium ? 'AI 模型技术变化带来新的用户决策窗口和实际影响。' : '';
    const excerpt = rich ? '该事件包含多方观点、事实证据、成本冲突与可执行路径。'.repeat(12) : '';
    const categories = rich ? ['AI', '大模型', '技术', '行业'] : medium ? ['AI'] : [];
    const collision = db.prepare('SELECT id FROM source_items WHERE canonical_url=? AND id<>? LIMIT 1').get(candidate.canonicalUrl, candidate.id);
    const storedCanonical = candidates.length > 1 || collision ? null : candidate.canonicalUrl;
    db.prepare("INSERT INTO source_items (id,feed_id,original_url,canonical_url,content_fingerprint,title,collected_at,summary,categories_json,keywords_json,recommended_platforms_json,recommended_formats_json,created_at,updated_at,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET summary=excluded.summary,categories_json=excluded.categories_json,updated_at=excluded.updated_at")
      .run(candidate.id, 'score-feed', `https://fixtures.local/${candidate.id}`, storedCanonical, `fixture-${candidate.id}`, candidate.title, now, summary, JSON.stringify(categories), '[]', '[]', '[]', now, now);
    if (rich || medium) {
      db.prepare("INSERT OR REPLACE INTO zhihu_hot_observations (id,source_item_id,business_date,rank,question_title_snapshot,question_url_snapshot,heat_text,excerpt_snapshot,collected_at,input_fingerprint,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(`obs-${candidate.id}`, candidate.id, now.slice(0, 10), candidate.rank ?? 1, candidate.title, candidate.canonicalUrl, rich ? '2万热度' : null, excerpt, now, `fp-${candidate.id}`, now);
    }
  }
}
function scoreCandidates(db, candidates, nowIso, settings) {
  seedEvidence(db, candidates);
  return scoring.scoreCandidates(db, candidates, nowIso, settings);
}

test('six dimensional caps and deterministic total', () => withTempDir(dir => {
  const db = migrateFresh(dir);
  try {
    const c = makeCandidate({ id: 'c1', audienceFit: 30, viewpointRoom: 25, evidenceAvailability: 25, timelinessLifecycle: 20, articleVideoTransfer: 20, executionCost: 10, canonicalUrl: 'https://www.zhihu.com/question/111', title: 'Caps Test' });
    const [scored] = scoreCandidates(db, [c], '2026-08-22T00:00:00.000Z');
    assert.equal(scored.dims.audienceFit, 25);
    assert.equal(scored.dims.viewpointRoom, 20);
    assert.equal(scored.dims.evidenceAvailability, 20);
    assert.equal(scored.dims.timelinessLifecycle, 15);
    assert.equal(scored.dims.articleVideoTransfer, 15);
    assert.equal(scored.dims.executionCost, 5);
    assert.equal(scored.total, 100);
    assert.ok(scored.dimensionEvidence.audienceFit.reason);
    const [scored2] = scoreCandidates(db, [c], '2026-08-22T00:00:00.000Z');
    assert.equal(scored2.total, scored.total);
    assert.deepEqual(scored2.dimensionEvidence, scored.dimensionEvidence);
  } finally { db.close(); }
}));

test('fixed inputs stably hit all three routes (automatic/boundary/rejected)', () => withTempDir(dir => {
  const db = migrateFresh(dir);
  try {
    const auto = makeCandidate({ id: 'auto', audienceFit: 25, viewpointRoom: 20, evidenceAvailability: 20, timelinessLifecycle: 15, articleVideoTransfer: 15, executionCost: 5, canonicalUrl: 'https://www.zhihu.com/question/100', title: 'Auto Q' });
    const boundary = makeCandidate({ id: 'bound', audienceFit: 15, viewpointRoom: 10, evidenceAvailability: 10, timelinessLifecycle: 10, articleVideoTransfer: 10, executionCost: 3, canonicalUrl: 'https://www.zhihu.com/question/101', title: 'Bound Q' });
    const rejected = makeCandidate({ id: 'rej', audienceFit: 5, viewpointRoom: 5, evidenceAvailability: 5, timelinessLifecycle: 5, articleVideoTransfer: 5, executionCost: 1, canonicalUrl: 'https://www.zhihu.com/question/102', title: 'Rej Q' });
    const scored = scoreCandidates(db, [auto, boundary, rejected], '2026-08-22T00:00:00.000Z');
    const byId = new Map(scored.map(s => [s.id, s]));
    assert.equal(byId.get('auto').route, 'automatic');
    assert.equal(byId.get('bound').route, 'boundary');
    assert.equal(byId.get('rej').route, 'rejected');
    const scored2 = scoreCandidates(db, [auto, boundary, rejected], '2026-08-22T00:00:00.000Z');
    const byId2 = new Map(scored2.map(s => [s.id, s]));
    assert.equal(byId2.get('auto').route, 'automatic');
    assert.equal(byId2.get('bound').route, 'boundary');
    assert.equal(byId2.get('rej').route, 'rejected');
  } finally { db.close(); }
}));

test('hard-risk codes reject-before-score preserves raw snapshot', () => withTempDir(dir => {
  const db = migrateFresh(dir);
  try {
    const hard = makeCandidate({ id: 'hard', audienceFit: 25, viewpointRoom: 20, evidenceAvailability: 20, timelinessLifecycle: 15, articleVideoTransfer: 15, executionCost: 5, hardRisks: ['illegal_infringement'], canonicalUrl: 'https://www.zhihu.com/question/200', title: 'Hard Risk Q' });
    const [scored] = scoreCandidates(db, [hard], '2026-08-22T00:00:00.000Z');
    assert.equal(scored.route, 'rejected');
    assert.ok(scored.risks.includes('illegal_infringement'));
    assert.ok(scored.hardRiskCodes.includes('illegal_infringement'));
    assert.equal(scored.rawInput.hardRisks[0], 'illegal_infringement');
    assert.ok(scored.dimensionEvidence.audienceFit);
    const json = JSON.parse(scoring.scoreSnapshotJsonFor(scored));
    assert.equal(json.total, 100);
    assert.ok((json.risks).includes('illegal_infringement'));
    assert.equal(json.route, 'rejected');
    assert.equal(json.canonicalUrl, 'https://www.zhihu.com/question/200');
  } finally { db.close(); }
}));

test('30-day duplicate detection edge (29d duplicate, 31d not duplicate, newValue boundary)', () => withTempDir(dir => {
  const db = migrateFresh(dir);
  try {
    const now = '2026-08-22T00:00:00.000Z';
    const canonical = 'https://www.zhihu.com/question/300';
    const old29 = new Date(new Date(now).getTime() - 29*24*60*60*1000).toISOString();
    const feedId = 'feed1';
    db.prepare("INSERT INTO source_feeds (id,name,created_at,updated_at,revision) VALUES (?,'f',?, ?,1)").run(feedId, now, now);
    db.prepare("INSERT INTO source_items (id,feed_id,original_url,canonical_url,title,collected_at,summary,categories_json,keywords_json,recommended_platforms_json,recommended_formats_json,created_at,updated_at,revision) VALUES ('src29',?, ?, ?, 'Dup Title', ?, 's','[]','[]','[]','[]', ?, ?,1)").run(feedId, canonical, canonical, old29, old29, old29);
    const cDup = makeCandidate({ id: 'dup', canonicalUrl: canonical, title: 'Dup Title', audienceFit: 25, viewpointRoom: 20, evidenceAvailability: 20, timelinessLifecycle: 15, articleVideoTransfer: 15, executionCost: 5 });
    const [scoredDup] = scoreCandidates(db, [cDup], now);
    assert.equal(scoredDup.duplicate, true);
    assert.ok(scoredDup.risks.includes('duplicate_no_value'));
    assert.equal(scoredDup.route, 'rejected');
    const cNew = makeCandidate({ id: 'dupNew', canonicalUrl: canonical, title: 'Dup Title', hasNewEvidence: true, audienceFit: 25, viewpointRoom: 20, evidenceAvailability: 20, timelinessLifecycle: 15, articleVideoTransfer: 15, executionCost: 5 });
    const [scoredNew] = scoreCandidates(db, [cNew], now);
    assert.equal(scoredNew.duplicate, true);
    assert.equal(scoredNew.route, 'boundary');
    db.prepare("DELETE FROM source_items WHERE id='src29'").run();
    const old31 = new Date(new Date(now).getTime() - 31*24*60*60*1000).toISOString();
    db.prepare("INSERT INTO source_items (id,feed_id,original_url,canonical_url,title,collected_at,summary,categories_json,keywords_json,recommended_platforms_json,recommended_formats_json,created_at,updated_at,revision) VALUES ('src31',?, ?, ?, 'Dup Title', ?, 's','[]','[]','[]','[]', ?, ?,1)").run(feedId, canonical, canonical, old31, old31, old31);
    const c31 = makeCandidate({ id: 'c31', canonicalUrl: canonical, title: 'Dup Title 2', audienceFit: 25, viewpointRoom: 20, evidenceAvailability: 20, timelinessLifecycle: 15, articleVideoTransfer: 15, executionCost: 5 });
    const [scored31] = scoreCandidates(db, [c31], now);
    assert.equal(scored31.duplicate, false);
    assert.equal(scored31.route, 'automatic');
  } finally { db.close(); }
}));

test('deterministic ties ordered by canonicalUrl then id', () => withTempDir(dir => {
  const db = migrateFresh(dir);
  try {
    const cA = makeCandidate({ id: 'a', canonicalUrl: 'https://www.zhihu.com/question/400', title: 'T', audienceFit: 20, viewpointRoom: 15, evidenceAvailability: 15, timelinessLifecycle: 10, articleVideoTransfer: 10, executionCost: 3 });
    const cB = makeCandidate({ id: 'b', canonicalUrl: 'https://www.zhihu.com/question/401', title: 'T', audienceFit: 20, viewpointRoom: 15, evidenceAvailability: 15, timelinessLifecycle: 10, articleVideoTransfer: 10, executionCost: 3 });
    const cC = makeCandidate({ id: 'c', canonicalUrl: 'https://www.zhihu.com/question/400', title: 'T', audienceFit: 20, viewpointRoom: 15, evidenceAvailability: 15, timelinessLifecycle: 10, articleVideoTransfer: 10, executionCost: 3 });
    const scored = scoreCandidates(db, [cB, cC, cA], '2026-08-22T00:00:00.000Z');
    assert.deepEqual(scored.map(s=>s.id), ['a','c','b']);
    const scored2 = scoreCandidates(db, [cA, cB, cC], '2026-08-22T00:00:00.000Z');
    assert.deepEqual(scored2.map(s=>s.id), ['a','c','b']);
  } finally { db.close(); }
}));

test('quota selection: automatic first; boundary fills remaining; quota-full never over-allocates', () => withTempDir(dir => {
  const db = migrateFresh(dir);
  try {
    const settings = { autoThreshold: 75, boundaryThreshold: 55, targetCount: 2 };
    const autos = [0,1,2].map(i=> makeCandidate({ id:`auto${i}`, canonicalUrl:`https://www.zhihu.com/question/5${i}0`, title:`Auto ${i}`, audienceFit: 25, viewpointRoom: 20, evidenceAvailability: 20, timelinessLifecycle: 15, articleVideoTransfer: 15, executionCost: 5 }));
    const bounds = [0,1].map(i=> makeCandidate({ id:`bound${i}`, canonicalUrl:`https://www.zhihu.com/question/6${i}0`, title:`Bound ${i}`, audienceFit: 15, viewpointRoom: 10, evidenceAvailability: 10, timelinessLifecycle: 10, articleVideoTransfer: 10, executionCost: 3 }));
    const all = [...autos, ...bounds];
    const scored = scoreCandidates(db, all, '2026-08-22T00:00:00.000Z', settings);
    const sel = scoring.selectWithQuota(scored, settings.targetCount);
    assert.equal(sel.automatic.length, 3);
    assert.equal(sel.boundary.length, 2);
    assert.equal(sel.selected.length, 2);
    assert.ok(sel.selected.every(s=>s.route==='automatic'));
    assert.equal(sel.visibleBoundary.length, 2);
    assert.equal(sel.boundary.length, 2);
    const oneAuto = [makeCandidate({ id:'auto0', canonicalUrl:'https://www.zhihu.com/question/700', title:'A', audienceFit:25,viewpointRoom:20,evidenceAvailability:20,timelinessLifecycle:15,articleVideoTransfer:15,executionCost:5 })];
    const manyBound = [0,1,2].map(i=> makeCandidate({ id:`b${i}`, canonicalUrl:`https://www.zhihu.com/question/80${i}`, title:`B${i}`, audienceFit:15,viewpointRoom:10,evidenceAvailability:10,timelinessLifecycle:10,articleVideoTransfer:10,executionCost:3 }));
    const scored2 = scoreCandidates(db, [...oneAuto, ...manyBound], '2026-08-22T00:00:00.000Z', settings);
    const sel2 = scoring.selectWithQuota(scored2, 2);
    assert.equal(sel2.selected.length, 2);
    assert.equal(sel2.selected[0].route, 'automatic');
    assert.equal(sel2.selected[1].route, 'boundary');
    assert.equal(sel2.selected[1].id, 'b0');
    const manyAuto = [0,1,2,3].map(i=> makeCandidate({ id:`ma${i}`, canonicalUrl:`https://www.zhihu.com/question/90${i}`, title:`M${i}`, audienceFit:25,viewpointRoom:20,evidenceAvailability:20,timelinessLifecycle:15,articleVideoTransfer:15,executionCost:5 }));
    const scored3 = scoreCandidates(db, manyAuto, '2026-08-22T00:00:00.000Z', settings);
    const sel3 = scoring.selectWithQuota(scored3, 2);
    assert.equal(sel3.selected.length, 2);
    assert.ok(sel3.selected.every(s=>s.route==='automatic'));
  } finally { db.close(); }
}));

test('workspace-configurable thresholds and daily target count via Settings route', () => withTempDir(dir => {
  const db = migrateFresh(dir);
  try {
    const defaults = scoring.getScoringSettings(db);
    assert.equal(defaults.autoThreshold, 75);
    assert.equal(defaults.boundaryThreshold, 55);
    assert.equal(defaults.targetCount, 2);
    const updated = scoring.setScoringSettings(db, { autoThreshold: 80, boundaryThreshold: 60, targetCount: 3 });
    assert.equal(updated.autoThreshold, 80);
    assert.equal(updated.boundaryThreshold, 60);
    assert.equal(updated.targetCount, 3);
    const readBack = scoring.getScoringSettings(db);
    assert.deepEqual(readBack, updated);
    assert.throws(()=> scoring.setScoringSettings(db, { autoThreshold: 60, boundaryThreshold: 60 }), /autoThreshold/);
    assert.throws(()=> scoring.setScoringSettings(db, { targetCount: 6 }), /targetCount/);
    const c78 = makeCandidate({ id:'c78', canonicalUrl:'https://www.zhihu.com/question/910', title:'T', audienceFit:15, viewpointRoom:10, evidenceAvailability:10, timelinessLifecycle:10, articleVideoTransfer:10, executionCost:3 });
    const [scored] = scoreCandidates(db, [c78], '2026-08-22T00:00:00.000Z');
    assert.equal(scored.route, 'boundary');
  } finally { db.close(); }
}));

test('Proposal Ledger exposes per-dimension evidence/reasons and hard risks', () => withTempDir(dir => {
  const db = migrateFresh(dir);
  try {
    const feedId = 'feed1';
    const now = '2026-08-22T08:00:00.000Z';
    const canonical = 'https://www.zhihu.com/question/999';
    db.prepare("INSERT INTO source_feeds (id,name,created_at,updated_at,revision) VALUES (?,'f',?, ?,1)").run(feedId, now, now);
    db.prepare("INSERT INTO source_items (id,feed_id,original_url,canonical_url,title,collected_at,summary,categories_json,keywords_json,recommended_platforms_json,recommended_formats_json,created_at,updated_at,revision) VALUES ('src999',?, ?, ?, 'Ledger Score Q', ?, 's','[]','[]','[]','[]', ?, ?,1)").run(feedId, canonical, canonical, now, now, now);
    const planId = 'plan1';
    db.prepare("INSERT INTO topics (id,title,created_at,updated_at,revision) VALUES ('topic1','t',?, ?,1)").run(now, now);
    db.prepare("INSERT INTO plans (id, plan_date, timezone, summary, is_current, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,?,1)").run(planId, '2026-08-22', 'Asia/Shanghai', 's', 1, now, now);
    const planItemId = 'pi1';
    db.prepare("INSERT INTO plan_items (id, plan_id, topic_id, title, priority, why_now, timeliness, target_audience, angle, point_of_view, platforms_json, formats_json, title_guidance, opening_guidance, structure_guidance, effort_estimate, source_ids_json, review_ids_json, method_finding_ids_json, sort_order, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      planItemId, planId, 'topic1', 'Ledger Score Q', 1,
      '官方今日公布关键变化，未来两天是解释窗口，错过后读者关注会明显下降。', '热点 2-3 天',
      '正在选择 AI 工具并需要核对证据的个人开发者',
      '用真实任务回执解释评分结果，而不是复述参数。',
      '完整证据链比单一高分更能支持用户决策。',
      '["xiaohongshu"]','["carousel"]',
      '标题突出传播评分与真实证据之间的关系。',
      '先展示可核验回执，再解释六维评分。',
      '第一段交代事件；第二段展示证据；第三段给出判断清单。',
      '90 分钟', JSON.stringify(['src999']), '[]','[]', 0, now, now, 1
    );
    const reviewScore = scoredReasons(60, now);
    const provenance = { origin:'daily_judge', editorial_decision:editorialDecision('完整证据链比单一高分更能支持用户决策。') };
    db.prepare("UPDATE plan_items SET planning_status='ready_for_review', score_reasons_json=?, planning_provenance_json=? WHERE id=?").run(JSON.stringify(reviewScore), JSON.stringify(provenance), planItemId);
    db.prepare("INSERT INTO daily_content_cycles (id,business_date,timezone,status,created_at,updated_at,revision) VALUES ('cy1','2026-08-22','Asia/Shanghai','running',?, ?,1)").run(now, now);
    const candidate = makeCandidate({ id:'ledgerC', canonicalUrl: canonical, title: 'Ledger Score Q', audienceFit:25, viewpointRoom:20, evidenceAvailability:20, timelinessLifecycle:15, articleVideoTransfer:15, executionCost:5, hardRisks:['private_data_required'], dimensionEvidence:{ audienceFit:{ reason:'strong fit', evidence:'persona doc' } } });
    const [scored] = scoreCandidates(db, [candidate], now);
    const snap = scoring.scoreSnapshotJsonFor(scored);
    db.prepare("INSERT INTO daily_content_targets (id,cycle_id,target_kind,counts_toward_goal,source_item_id,plan_item_id,carry_depth,selection_mode,score_snapshot_json,status,created_at,updated_at,revision) VALUES ('t1','cy1','new_content',1,'src999',?,0,'automatic',?,'proposed',?, ?,1)").run(planItemId, snap, now, now);
    const ledger = getProposalLedger(db, { planDate: '2026-08-22', now: new Date(now) });
    const found = ledger.items.find(i=> i.planItemId===planItemId);
    assert.ok(found, 'ledger should contain plan item');
    assert.ok(found.scoreSnapshot, 'ledger item should expose scoreSnapshot');
    assert.equal(found.scoreSnapshot.total, scored.total);
    assert.ok(found.scoreSnapshot.risks.includes('private_data_required'));
    assert.ok(found.scoreSnapshot.dimensionEvidence?.audienceFit?.reason);
  } finally { db.close(); }
}));
