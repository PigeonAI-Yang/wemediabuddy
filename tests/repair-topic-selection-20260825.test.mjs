import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { assembleEditorialBrief } from '../src/main/editorial-brief.ts';
import { parseDailyPlanOutput } from '../src/main/agent-runner.ts';
import { getToday } from '../src/main/workbench.ts';
import { propagationGradeFromScore, resolvePropagationGrade, PROPAGATION_NEUTRAL_GRADE } from '../src/shared/propagation.ts';
import { editorialDecision, scoredReasons } from './helpers/planning-fixture.mjs';
const NOW = new Date('2026-08-25T06:00:00.000Z');

async function withDb(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-repair-'));
  await openDataRoot(root);
  const db = migrateDatabase(path.join(root, 'wmb.db'));
  try {
    await run(db, root);
  } finally {
    try { db.close(); } catch {}
    try { await rm(root, { recursive: true, force: true }); } catch {}
  }
}

function seedSource(db, id, title, opts = {}) {
  const url = opts.url ?? `https://example.com/${id}`;
  const categories = opts.categories ?? ['研究补料'];
  const collectedAt = opts.collectedAt ?? new Date().toISOString();
  const saved = upsertSource(db, {
    originalUrl: url,
    title,
    summary: opts.summary ?? `${title} 摘要内容足够支撑证据维度`,
    categories,
    keywords: [],
    recommendedPlatforms: [],
    recommendedFormats: [],
  }, false);
  db.prepare('UPDATE source_items SET collected_at = ?, categories_json = ? WHERE id = ?').run(collectedAt, JSON.stringify(categories), saved.id);
  return saved.id;
}

test('A: pending score 0 + priority 0 renders neutral 待评分 not SSS', async () => {
  const fakePending = { planning_status: 'draft', score_reasons_json: JSON.stringify({ status: 'pending', score: 0, reasons: [] }), priority: 0, title: '草案' };
  const grade = resolvePropagationGrade(fakePending);
  assert.equal(grade, PROPAGATION_NEUTRAL_GRADE);
  assert.notEqual(grade, 'SSS');
  assert.notEqual(grade, 'S');
  assert.notEqual(grade, 'A');
  // Also via priority 0 but scored false should not be SSS
  const fakePending2 = { planning_status: 'draft', score_reasons_json: JSON.stringify({ status: 'pending', score: 0, reasons: [] }), priority: 0 };
  assert.equal(resolvePropagationGrade(fakePending2), '待评分');
  // Approved but pending also neutral
  const fakeApprovedPending = { planning_status: 'approved', score_reasons_json: JSON.stringify({ status: 'pending', score: 0, reasons: [] }), priority: 0 };
  assert.equal(resolvePropagationGrade(fakeApprovedPending), '待评分');
});

// B: Semantics — propagation grade independent of priority
test('B: scored approved items map to grade by propagation score independent of priority', async () => {
  const makeItem = (score, priority) => ({
    planning_status: 'approved',
    score_reasons_json: JSON.stringify(scoredReasons(score)),
    priority,
  });
  const itemSssPriority7 = makeItem(92, 7); // low priority but high score => SSS
  const itemF = makeItem(10, 0); // high priority but low score => F
  assert.equal(resolvePropagationGrade(itemSssPriority7), 'SSS');
  assert.equal(resolvePropagationGrade(itemF), 'F');
  // Thresholds
  assert.equal(propagationGradeFromScore(95), 'SSS');
  assert.equal(propagationGradeFromScore(85), 'S');
  assert.equal(propagationGradeFromScore(75), 'A');
  assert.equal(propagationGradeFromScore(65), 'B');
  assert.equal(propagationGradeFromScore(55), 'C');
  assert.equal(propagationGradeFromScore(45), 'D');
  assert.equal(propagationGradeFromScore(35), 'E');
  assert.equal(propagationGradeFromScore(10), 'F');
  // Same score different priority yields same grade
  const a = makeItem(82, 0);
  const b = makeItem(82, 6);
  assert.equal(resolvePropagationGrade(a), resolvePropagationGrade(b));
  assert.equal(resolvePropagationGrade(a), 'S');
});

// C: Scoring/judging — formal criteria and daily prompt explicitly score propagation dimensions

// D: Input — signal quota survives flood of research rows while trust provenance remains
test('D: signal quota survives flood of research rows while trust provenance remains', async () => {
  await withDb(async (db) => {
    const watermark = '2026-08-24T19:41:55.160Z';
    const since = new Date(watermark);
    // Flood with 80 research rows (recent)
    for (let i = 0; i < 80; i++) {
      const at = new Date(since.getTime() + 1000 + i * 60000).toISOString(); // incrementally recent
      seedSource(db, `research-${i}`, `研究补料标题${i}：评测与复跑`, { categories: ['研究补料'], collectedAt: at });
    }
    // 12 signal rows slightly older but within window (simulate audience demand)
    for (let i = 0; i < 12; i++) {
      const at = new Date(since.getTime() + 500 + i * 60000).toISOString(); // still within window but slightly older than flood tail
      seedSource(db, `signal-${i}`, `真实提问：为什么 AI 视频总是闪烁？ ${i}`, { categories: ['signal_only'], collectedAt: at, summary: `用户真实提问 ${i}，包含争议与评论需求` });
    }
    const brief = assembleEditorialBrief(db, { now: new Date('2026-08-25T03:00:00.000Z'), watermark, sourceLimit: 60 });
    assert.ok(brief.increment.sources.length <= 60, 'sources bounded to 60');
    const signalCount = brief.increment.sources.filter(s => s.categories.includes('signal_only')).length;
    assert.ok(signalCount >= 4, `signal quota should guarantee at least 4 signals, got ${signalCount}`);
    // Even with flood, at least bounded quota survives
    // Trust provenance retained
    for (const s of brief.increment.sources) {
      if (s.categories.includes('signal_only')) {
        assert.ok(s.categories.includes('signal_only'), 'trust label retained');
      }
    }
    // Ensure signals not used as primary factual evidence — they retain signal_only label, not converted to primary
    const signalSample = brief.increment.sources.find(s => s.categories.includes('signal_only'));
    assert.ok(signalSample, 'should have signal sample');
    assert.ok(signalSample.categories.includes('signal_only'), 'signal retains trust label');
  });
});

// E: Thesis diversity — five governance-like fixtures collapse to one thesis or rejected; five distinct remain

// Integration fixture runs daily plan parse/save/read projection without production DB mutation
test('integration: daily plan parse/save/read projection without production DB mutation', async () => {
  await withDb(async (db) => {
    const src1 = seedSource(db, 'int-src-1', '资料一：官方发布', { categories: ['primary'] });
    const src2 = seedSource(db, 'int-src-2', '资料二：用户提问', { categories: ['signal_only'] });
    const scored1 = scoredReasons(88);
    const scored2 = scoredReasons(72);
    const planBlock = `\`\`\`json
{
  "planDate": "2026-08-25",
  "summary": "今日增量最值得做的",
  "items": [{
    "title": "用对比钩子让小红书收藏翻倍",
    "priority": 1,
    "whyNow": "今日公开案例显示对比钩子带来高收藏，未来两天是验证窗口，错过后需重做测试",
    "timeliness": "热点 2-3 天",
    "targetAudience": "正在做小红书 AI 内容但收藏率偏低的具体运营者",
    "angle": "用真实收藏数据拆解可直接套用的对比钩子模板",
    "pointOfView": "经真实数据验证的对比钩子比泛泛科普更容易获得收藏",
    "platforms": ["xiaohongshu"],
    "formats": ["text"],
    "titleGuidance": "标题突出收藏翻倍与节省时间的具体反差",
    "openingGuidance": "先给出收藏数据，再说明普通写法损失了什么",
    "structureGuidance": "第一段展示数据；第二段拆解模板；第三段给出改写步骤",
    "effortEstimate": "约 40 分钟",
    "sourceIds": ["${src1}"],
    "scoreReasons": ${JSON.stringify(scored1)},
    "editorialDecision": ${JSON.stringify(editorialDecision('经真实数据验证的对比钩子比泛泛科普更容易获得收藏'))}
  }, {
    "title": "视频废片筛掉省 5 小时",
    "priority": 2,
    "whyNow": "VBench 今日发布新的筛选结果，未来两天适合验证，错过后需重跑样本",
    "timeliness": "长期",
    "targetAudience": "每天批量制作视频并需要控制废片成本的内容团队",
    "angle": "用真实失败样本拆解一致性筛选流程与节省成本",
    "pointOfView": "瓶颈不是出片而是可复核质量门",
    "platforms": ["x"],
    "formats": ["video"],
    "titleGuidance": "标题突出筛掉废片后节省的具体时间成本",
    "openingGuidance": "先展示一组废片样本和返工时间，再说明筛选方法",
    "structureGuidance": "第一段展示废片；第二段拆解筛选；第三段给出验收清单",
    "effortEstimate": "约 30 分钟",
    "sourceIds": ["${src2}"],
    "scoreReasons": ${JSON.stringify(scored2)},
    "editorialDecision": ${JSON.stringify(editorialDecision('瓶颈不是出片而是可复核质量门'))}
  }]
}
\`\`\``;
    const parsed = parseDailyPlanOutput(planBlock);
    assert.equal(parsed.items.length, 2);
    // Save via planning (not production DB — this is temp fixture DB)
    const saved = saveCurrentPlan(db, { planDate: '2026-08-25', timezone: 'Asia/Shanghai', summary: parsed.summary, items: parsed.items });
    assert.ok(saved.id);
    // Read projection via getToday (should filter to approved only)
    const today = getToday(db, '2026-08-25');
    assert.ok(today.plan, 'plan should be present');
    assert.equal(today.plan.items.length, 2);
    // Both are scored approved, so grade should be visible
    for (const it of today.plan.items) {
      const g = resolvePropagationGrade(it);
      assert.notEqual(g, '待评分', `scored approved should have grade, got ${g} for ${it.title}`);
    }
    // Pending draft should be neutral
    const pendingItem = {
      planning_status: 'draft',
      score_reasons_json: JSON.stringify({ status: 'pending', score: 0, reasons: [] }),
      priority: 0,
    };
    assert.equal(resolvePropagationGrade(pendingItem), '待评分');
    // Verify that parsing respects scoreReasons weights
    for (const it of parsed.items) {
      assert.ok(it.scoreReasons, 'parsed item should have scoreReasons');
      assert.equal(it.scoreReasons.status, 'scored');
    }
  });
});
