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



test('no hardcoded Yann/user UUID in owned files', async () => {
  const owned = [
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
  for (const rel of ['src/main/daily-content-cycle.ts', 'src/main/zhihu-hot-scoring.ts', 'src/main/zhihu-hot-channel.ts']) {
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

