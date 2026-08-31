// WMB-5350 scoring intake gates: evidence-driven pending 0, six criteria weights, minimal draft no pseudo prose, planner dedupe, no hardcode Yann UUID
// Verify via: node --test tests/planning-stage-scoring.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { editorialDecision, scoredReasons } from './helpers/planning-fixture.mjs';

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const planningStage = await import('../src/main/planning-stage.ts');
const { ensurePlannerTask } = await import('../src/main/planning-stage-intake.ts');
const { ensureDailyCycleInternal } = await import('../src/main/daily-content-cycle.ts');
const { upsertSource } = await import('../src/main/sources.ts');
const scoring = await import('../src/main/zhihu-hot-scoring.ts');
const { setActiveJobSpawner } = await import('../src/main/job-spawner.ts');

let currentDbForSpawner = null;
const fakeSpawnerState = { spawnCount: 0, map: new Map() };
const fakeSpawner = {
  spawn(req, jobId) {
    fakeSpawnerState.spawnCount++;
    const jId = jobId || randomUUID();
    if (fakeSpawnerState.map.has(jId)) {
      return { id: jId };
    }
    const tId = randomUUID();
    const db = currentDbForSpawner;
    if (db) {
      try {
        const now = new Date().toISOString();
        const planItemId = req.planItemId ?? null;
        const ctx = JSON.stringify({ planItemId, roleId: 'planner', brief: req.brief });
        const businessDate = req.businessDate || new Date().toISOString().slice(0, 10);
        db.prepare(
          "INSERT INTO agent_tasks (id, intent, business_date, status, phase, context_refs_json, result_refs_json, progress_json, checkpoint_json, events_json, heartbeat_at, created_at, updated_at, finished_at) VALUES (?, 'daily_judge', ?, 'running', 'starting', ?, '{}', '{}', '{}', '[]', ?, ?, ?, NULL)"
        ).run(tId, businessDate, ctx, now, now, now);
      } catch {}
    }
    fakeSpawnerState.map.set(jId, tId);
    return { id: jId };
  },
  getHandle(jobId) {
    const tId = fakeSpawnerState.map.get(jobId);
    return tId ? { taskId: tId, jobId, leaseId: null, grantId: null, sessionFile: null } : null;
  },
  get(jobId) {
    const tId = fakeSpawnerState.map.get(jobId);
    if (!tId) return null;
    return { id: jobId, status: 'running', roleId: 'planner' };
  },
  dispose() {},
};

function withFakeSpawner(db, fn) {
  currentDbForSpawner = db;
  fakeSpawnerState.spawnCount = 0;
  fakeSpawnerState.map.clear();
  setActiveJobSpawner(fakeSpawner);
  try {
    return fn();
  } finally {
    setActiveJobSpawner(null);
    currentDbForSpawner = null;
  }
}

function withTempDir(work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmb5350-'));
  try {
    return work(dir);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
}
function migrateFresh(dir) {
  const dbPath = path.join(dir, 'wmb.db');
  const db = migrateDatabase(dbPath);
  try {
    db.prepare("INSERT OR IGNORE INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id','ws-test','2026-08-23T00:00:00Z','2026-08-23T00:00:00Z',1)").run();
  } catch {}
  return db;
}
function makeSourceWithEvidence(db, opts = {}) {
  const title = opts.title ?? '真实来源标题用于证据驱动评分的示例内容标题长度足够';
  const url = opts.url ?? `https://example.com/src-${Math.random().toString(36).slice(2, 7)}`;
  const summary = opts.summary ?? '这是一段具有实质内容的摘要，包含 AI 技术进展与行业影响的真实信息，长度足够支撑证据覆盖维度超过阈值。';
  const categories = opts.categories ?? ['tech', 'ai'];
  return upsertSource(db, {
    originalUrl: url,
    title,
    summary,
    categories,
    keywords: [],
    evidence: url,
  });
}
function makeSourceNoEvidence(db, opts = {}) {
  const title = opts.title ?? '无证据来源标题示例用于触发 pending 逻辑的标题文本';
  const url = opts.url ?? `https://example.com/no-ev-${Math.random().toString(36).slice(2, 7)}`;
  return upsertSource(db, {
    originalUrl: url,
    title,
    // no summary, no categories => insufficient
    categories: [],
    keywords: [],
    evidence: url,
  });
}
function seedZhihuObservation(db, businessDate, sourceId, title, opts = {}) {
  const taskId = `task-${Math.random().toString(36).slice(2, 8)}`;
  const workspaceId = 'ws-test';
  const collectedAt = opts.collectedAt ?? `${businessDate}T12:00:00.000Z`;
  const evidenceUrl = 'https://www.zhihu.com/topic/19551275/hot';
  const item = {
    rank: opts.rank ?? 1,
    title,
    canonicalUrl: opts.canonicalUrl ?? `https://www.zhihu.com/question/${Math.floor(Math.random() * 1e8)}`,
    heatText: opts.heatText ?? null,
    excerpt: opts.excerpt ?? null,
  };
  const obsId = `obs-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const fingerprint = `${item.canonicalUrl}:${title}:${item.rank}`;
  try {
    db.prepare(
      `INSERT INTO zhihu_hot_observations (id, source_item_id, business_date, rank, heat_text, question_title_snapshot, question_url_snapshot, excerpt_snapshot, evidence_url, collected_at, scan_task_id, input_fingerprint, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      obsId,
      sourceId,
      businessDate,
      item.rank,
      opts.heatText ?? null,
      title,
      item.canonicalUrl,
      opts.excerpt ?? null,
      evidenceUrl,
      collectedAt,
      taskId,
      fingerprint,
      now
    );
  } catch (e) {
    // if duplicate fingerprint, ignore
  }
}

const EXPECTED_WEIGHTS = new Map([
  ['reality_change_significance', 25],
  ['tension_curiosity_gap', 20],
  ['audience_stakes', 20],
  ['why_now_window', 15],
  ['one_sentence_relayability', 15],
  ['account_fit', 5],
]);

test('no evidence => pending/0 with explicit reason, never 100', async () => {
  await withTempDir((dir) => {
    const db = migrateFresh(dir);
    const businessDate = '2026-08-23';
    const src = makeSourceNoEvidence(db, { title: '无证据 pending 测试标题足够长度的示例标题文本' });
    // ensure source has no summary (explicitly clear)
    db.prepare('UPDATE source_items SET summary = NULL, categories_json = ?, collected_at = ? WHERE id = ?').run('[]', `${businessDate}T10:00:00.000Z`, src.id);
    // create observation with no excerpt/heat
    seedZhihuObservation(db, businessDate, src.id, '无证据 pending 测试标题足够长度的示例标题文本', {
      heatText: null,
      excerpt: null,
      canonicalUrl: `https://www.zhihu.com/question/${Math.floor(Math.random() * 1e8)}`,
    });

    const beforeTargets = db.prepare('SELECT COUNT(*) as c FROM daily_content_cycles').get().c;
    withFakeSpawner(db, () => ensureDailyCycleInternal(db, businessDate));
    const projRow = db.prepare('SELECT planning_status, score_reasons_json, why_now, timeliness, target_audience, angle, point_of_view, platforms_json FROM plan_items WHERE source_ids_json LIKE ? ORDER BY created_at DESC LIMIT 1').get(`%"${src.id}"%`);
    assert.ok(projRow, 'should create draft for pending source');
    assert.equal(projRow.planning_status, 'draft');
    const score = JSON.parse(projRow.score_reasons_json);
    assert.equal(score.status, 'pending');
    assert.equal(score.score, 0);
    assert.notEqual(score.score, 100, 'pending must never be 100 by construction');
    assert.ok(Array.isArray(score.reasons) && score.reasons.length === 6, 'pending should have six criteria');
    for (const r of score.reasons) {
      const expectedWeight = EXPECTED_WEIGHTS.get(r.criterion);
      assert.ok(expectedWeight !== undefined, `unknown criterion ${r.criterion}`);
      assert.equal(r.weight, expectedWeight, `weight mismatch for ${r.criterion}`);
    }
    assert.equal(score.pending_reason ?? score.pendingReason ?? score.pending_reason, 'insufficient_evidence');
    db.close();
  });
});

test('scored reasons are exactly six criteria with agreed weights and sum', async () => {
  await withTempDir((dir) => {
    const db = migrateFresh(dir);
    const src = makeSourceWithEvidence(db, {
      title: '完整策划标题用于评审通过的选题示例标题验证权重',
      url: 'https://example.com/scored-src',
      summary: '这是一段具有实质内容的摘要，包含 AI 技术进展与行业影响的真实信息，长度足够支撑证据覆盖维度超过阈值，并且包含足够的细节以支撑策划质量评估。',
      categories: ['zhihu_hot', 'tech'],
    });
    // also ensure observation with excerpt and heat for richer evidence
    const businessDate = '2026-08-23';
    seedZhihuObservation(db, businessDate, src.id, '完整策划标题用于评审通过的选题示例标题验证权重', {
      heatText: '1.2万热度',
      excerpt: '这是一段来自知乎热榜的真实摘录，描述了问题的核心争议与证据，长度足够且与摘要互补。',
      canonicalUrl: 'https://www.zhihu.com/question/12345678',
    });
    // Use planning-stage pending vs scored via direct helper: create draft then submit with scored reasons should pass validation
    const draft = planningStage.createPlanningDraftFromTarget(db, {
      title: '完整策划标题用于评审通过的选题示例标题验证权重',
      sourceIds: [src.id],
      planDate: '2026-08-24',
      origin: 'zhihu_hot',
    });
    assert.equal(draft.planningStatus, 'draft');
    const scored = scoredReasons(82);
    let sum = 0;
    for (const r of scored.reasons) {
      const expected = EXPECTED_WEIGHTS.get(r.criterion);
      assert.equal(r.weight, expected);
      assert.ok(r.score >= 0 && r.score <= r.weight);
      sum += r.score;
    }
    assert.equal(sum, scored.score, 'sum must equal score');
    assert.equal(scored.reasons.length, 6);
    // submit draft with scored reasons should succeed
    const submitted = planningStage.submitPlanItemForReview(db, {
      planItemId: draft.planItemId,
      expectedRevision: 1,
      item: {
        title: '完整策划标题用于评审通过的选题示例标题验证权重',
        priority: 2,
        whyNow: '2026-08-23 某厂商发布新模型，引发技术社区对齐争议，需在窗口期内解读',
        timeliness: 'today',
        targetAudience: 'AI 从业者与技术管理者',
        angle: '世界模型路线是否具备规模化证据的争议切口',
        pointOfView: '当前证据不支持世界模型已解决长程一致性，主张分层验证',
        platforms: ['x'],
        formats: ['article'],
        titleGuidance: '以争议为引的标题',
        openingGuidance: '用发布事件开场，给出核心分歧',
        structureGuidance: '第一段交代事件；第二段展示争议与证据；第三段给出判断与行动。',
        effortEstimate: 'M',
        sourceIds: [src.id],
        availableMaterials: ['官方发布原文与时间线'],
        missingMaterials: [],
        scoreReasons: scored,
        editorialDecision: editorialDecision('当前证据不支持世界模型已解决长程一致性，主张分层验证'),
      },
    });
    assert.equal(submitted.planningStatus, 'ready_for_review');
    const after = db.prepare('SELECT score_reasons_json FROM plan_items WHERE id = ?').get(draft.planItemId).score_reasons_json;
    const parsed = JSON.parse(after);
    assert.equal(parsed.status, 'scored');
    assert.equal(parsed.score, 82);
    assert.equal(parsed.reasons.length, 6);
    db.close();
  });
});

test('minimal draft has no pseudo-planning prose (empty fallback fields)', async () => {
  await withTempDir((dir) => {
    const db = migrateFresh(dir);
    const src = makeSourceNoEvidence(db, { title: '最小草稿无伪策划文案的测试标题示例文本' });
    db.prepare('UPDATE source_items SET summary = NULL, categories_json = ?, collected_at = ? WHERE id = ?').run('[]', '2026-08-23T10:00:00.000Z', src.id);
    const businessDate = '2026-08-25';
    seedZhihuObservation(db, businessDate, src.id, '最小草稿无伪策划文案的测试标题示例文本', {
      heatText: null,
      excerpt: null,
    });
    withFakeSpawner(db, () => ensureDailyCycleInternal(db, businessDate));
    const row = db.prepare('SELECT why_now, timeliness, target_audience, angle, point_of_view, platforms_json, formats_json, title_guidance, opening_guidance, structure_guidance, planning_provenance_json, score_reasons_json, title FROM plan_items WHERE source_ids_json LIKE ? ORDER BY created_at DESC LIMIT 1').get(`%"${src.id}"%`);
    assert.ok(row);
    assert.equal(row.why_now, '', 'why_now must be empty for minimal draft');
    assert.equal(row.timeliness, '', 'timeliness empty');
    assert.equal(row.target_audience, '', 'target_audience empty');
    assert.equal(row.angle, '', 'angle empty');
    assert.equal(row.point_of_view, '', 'point_of_view empty');
    assert.deepEqual(JSON.parse(row.platforms_json), [], 'platforms empty');
    assert.deepEqual(JSON.parse(row.formats_json), [], 'formats empty');
    assert.equal(row.title_guidance, '', 'title_guidance empty');
    assert.equal(row.opening_guidance, '', 'opening_guidance empty');
    assert.equal(row.structure_guidance, '', 'structure_guidance empty');
    const prov = JSON.parse(row.planning_provenance_json);
    assert.equal(prov.origin, 'zhihu_hot');
    // ensure title preserves real source title and no padding
    assert.equal(row.title, '最小草稿无伪策划文案的测试标题示例文本');
    assert.equal(row.title.includes('选题补充说明满足最小长度要求'), false, 'title must not contain fake padding');
    // ensure not fallback template strings
    const forbidden = [
      '基于知乎热题的每日内容目标',
      '泛科技受众',
      '深度解读该问题的核心争议与证据',
      '提供独立判断与可操作建议',
      '以问题为引，快速建立共识再展开分析',
      '背景→拆解→证据→观点→行动',
    ];
    for (const v of forbidden) {
      assert.equal(row.why_now.includes(v), false);
      assert.equal(row.target_audience.includes(v), false);
      assert.equal(row.angle.includes(v), false);
    }
    db.close();
  });
});

test('repeated intake yields one active Planner task and stable planItem identity', async () => {
  await withTempDir((dir) => {
    const db = migrateFresh(dir);
    const businessDate = '2026-08-26';
    const src = makeSourceNoEvidence(db, { title: '重复 intake 去重的测试标题示例文本足够长度' });
    db.prepare('UPDATE source_items SET summary = NULL, categories_json = ?, collected_at = ? WHERE id = ?').run('[]', `${businessDate}T10:00:00.000Z`, src.id);
    seedZhihuObservation(db, businessDate, src.id, '重复 intake 去重的测试标题示例文本足够长度', {
      heatText: null,
      excerpt: null,
    });
    currentDbForSpawner = db;
    fakeSpawnerState.spawnCount = 0;
    fakeSpawnerState.map.clear();
    setActiveJobSpawner(fakeSpawner);
    try {
      ensureDailyCycleInternal(db, businessDate);
    } finally {
      // keep spawner for second call to test dedupe
    }
    const firstPlanItem = db.prepare('SELECT id FROM plan_items WHERE source_ids_json LIKE ? ORDER BY created_at ASC LIMIT 1').get(`%"${src.id}"%`);
    assert.ok(firstPlanItem);
    const firstId = firstPlanItem.id;
    const firstProvenance = JSON.parse(db.prepare('SELECT planning_provenance_json FROM plan_items WHERE id = ?').get(firstId).planning_provenance_json);
    const firstTaskId = firstProvenance.planner_task_id;
    assert.ok(firstTaskId, 'first intake should create planner_task_id in provenance');
    const firstTaskRow = db.prepare('SELECT status FROM agent_tasks WHERE id = ?').get(firstTaskId);
    assert.equal(firstTaskRow.status, 'running');
    assert.equal(fakeSpawnerState.spawnCount, 1, 'first intake should spawn once');

    // repeated Stage C
    ensureDailyCycleInternal(db, businessDate);

    const secondPlanItem = db.prepare('SELECT id FROM plan_items WHERE source_ids_json LIKE ? ORDER BY created_at ASC LIMIT 1').get(`%"${src.id}"%`);
    assert.equal(secondPlanItem.id, firstId, 'planItem identity must be stable');

    const countPlanItems = db.prepare('SELECT COUNT(*) as c FROM plan_items WHERE source_ids_json LIKE ?').get(`%"${src.id}"%`).c;
    assert.equal(countPlanItems, 1, 'repeated intake must not create duplicate draft');

    const secondProvenance = JSON.parse(db.prepare('SELECT planning_provenance_json FROM plan_items WHERE id = ?').get(firstId).planning_provenance_json);
    const secondTaskId = secondProvenance.planner_task_id;
    assert.equal(secondTaskId, firstTaskId, 'planner task must be deduped');
    assert.equal(fakeSpawnerState.spawnCount, 1, 'repeated intake must not spawn again');

    const activeCount = db.prepare("SELECT COUNT(*) as c FROM agent_tasks WHERE status = 'running' AND json_extract(context_refs_json, '$.planItemId') = ?").get(firstId).c;
    assert.equal(activeCount, 1, 'only one active planner task');

    // direct ensurePlannerTask dedupe
    const r1 = ensurePlannerTask(db, { planItemId: firstId, sourceIds: [src.id], requestId: `req-${firstId}` });
    const r2 = ensurePlannerTask(db, { planItemId: firstId, sourceIds: [src.id], requestId: `req-${firstId}` });
    assert.equal(r1.taskId, r2.taskId);
    assert.equal(r2.created, false);
    assert.equal(fakeSpawnerState.spawnCount, 1, 'direct dedupe must not spawn again');
    setActiveJobSpawner(null);
    currentDbForSpawner = null;
    fakeSpawnerState.map.clear();
    db.close();
  });
});

test('no hardcoded Yann/user UUID in owned files', async () => {
  const owned = [
    'src/main/planning-stage-intake.ts',
    'src/main/daily-content-cycle.ts',
    'src/main/zhihu-hot-scoring.ts',
    'src/main/zhihu-hot-channel.ts',
  ];
  const forbidden = ['6ce12d8a', '8aae5605', '8342f64f', 'e91ad226'];
  for (const rel of owned) {
    const abs = path.join(process.cwd(), rel);
    let content = '';
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      // try alternative cwd for test runner
      const alt = path.resolve(path.join('J:/PigeonYang/WeMediaBuddy', rel));
      content = fs.readFileSync(alt, 'utf8');
    }
    for (const needle of forbidden) {
      assert.equal(content.includes(needle), false, `${rel} must not contain hardcoded UUID ${needle}`);
    }
  }
});

test('no direct INSERT into agent_tasks/jobs and no fake title padding in owned files', async () => {
  const owned = [
    'src/main/planning-stage-intake.ts',
    'src/main/daily-content-cycle.ts',
  ];
  for (const rel of owned) {
    const abs = path.join(process.cwd(), rel);
    let content = '';
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      const alt = path.resolve(path.join('J:/PigeonYang/WeMediaBuddy', rel));
      content = fs.readFileSync(alt, 'utf8');
    }
    assert.equal(content.includes('INSERT INTO agent_tasks'), false, `${rel} must not contain direct INSERT INTO agent_tasks`);
    assert.equal(content.includes('INSERT INTO jobs'), false, `${rel} must not contain direct INSERT INTO jobs`);
  }
  for (const rel of ['src/main/planning-stage-intake.ts', 'src/main/daily-content-cycle.ts', 'src/main/zhihu-hot-scoring.ts', 'src/main/zhihu-hot-channel.ts']) {
    const abs = path.join(process.cwd(), rel);
    let content = '';
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      const alt = path.resolve(path.join('J:/PigeonYang/WeMediaBuddy', rel));
      content = fs.readFileSync(alt, 'utf8');
    }
    assert.equal(content.includes('选题补充说明满足最小长度要求'), false, `${rel} must not contain fake title padding`);
  }
});

test('missing spawner fails closed with stable error', async () => {
  await withTempDir((dir) => {
    const db = migrateFresh(dir);
    const src = makeSourceNoEvidence(db, { title: '缺失 spawner 时 fail closed 的标题文本示例足够长度' });
    db.prepare('UPDATE source_items SET summary = NULL, categories_json = ?, collected_at = ? WHERE id = ?').run('[]', '2026-08-23T10:00:00.000Z', src.id);
    const businessDate = '2026-08-27';
    seedZhihuObservation(db, businessDate, src.id, '缺失 spawner 时 fail closed 的标题文本示例足够长度', { heatText: null, excerpt: null });
    // create draft directly to test ensurePlannerTask without spawner
    const draft = planningStage.createPlanningDraftFromTarget(db, {
      title: '缺失 spawner 时 fail closed 的标题文本示例足够长度',
      sourceIds: [src.id],
      planDate: businessDate,
      origin: 'zhihu_hot',
    });
    setActiveJobSpawner(null);
    currentDbForSpawner = null;
    let threw = false;
    let code = null;
    try {
      ensurePlannerTask(db, { planItemId: draft.planItemId, sourceIds: [src.id], requestId: 'req-missing-spawner', businessDate });
    } catch (e) {
      threw = true;
      code = (e && typeof e === 'object' && 'code' in e) ? e.code : null;
    }
    assert.equal(threw, true, 'ensurePlannerTask without spawner should throw');
    assert.equal(code, 'PLANNER_SPAWNER_UNAVAILABLE', 'stable error code');
    // Stage C should also surface failure, not silently pretend task exists
    let stageThrew = false;
    try {
      ensureDailyCycleInternal(db, businessDate);
    } catch (e) {
      stageThrew = true;
      const c = (e && typeof e === 'object' && 'code' in e) ? e.code : null;
      assert.equal(c, 'PLANNER_SPAWNER_UNAVAILABLE');
    }
    // either throws or records provenance error
    if (!stageThrew) {
      const row = db.prepare('SELECT planning_provenance_json FROM plan_items WHERE id = ?').get(draft.planItemId);
      if (row) {
        const prov = JSON.parse(row.planning_provenance_json);
        assert.ok(prov.planner_spawn_error || prov.planner_spawn_code, 'Stage C should record planner spawn failure');
      } else {
        assert.fail('Stage C without spawner should either throw or record error');
      }
    }
    db.close();
  });
});
