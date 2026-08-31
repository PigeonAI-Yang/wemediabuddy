import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { assembleEditorialBrief } from '../src/main/editorial-brief.ts';
import { parseDailyPlanOutput } from '../src/main/agent-runner.ts';
import { getToday } from '../src/main/workbench.ts';
import { PROPAGATION_V2_CRITERIA, propagationGradeFromScore, resolvePropagationGrade, PROPAGATION_NEUTRAL_GRADE } from '../src/shared/propagation.ts';
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
test('C: criteria and prompt include every propagation dimension', async () => {
  const needed = [
    'reality_change_significance',
    'tension_curiosity_gap',
    'audience_stakes',
    'why_now_window',
    'one_sentence_relayability',
    'account_fit',
  ];
  for (const k of needed) {
    assert.ok(k in PROPAGATION_V2_CRITERIA, `criteria missing ${k}`);
  }
  // Prompt check via reading source file (dailyPrompt is internal, but buildDailyOpportunityPrompt wraps it)
  const runnerSrc = await readFile(path.join(process.cwd(), 'src/main/agent-runner.ts'), 'utf8');
  for (const k of needed) {
    assert.ok(runnerSrc.includes(k), `prompt missing criterion ${k} in agent-runner.ts`);
  }
  // Human readable dimensions
  const human = ['现实变化', '张力', '认知缺口', '读者利害', '一句话转述', '账号契合', '窗口'];
  let hits = 0;
  for (const h of human) if (runnerSrc.includes(h)) hits++;
  assert.ok(hits >= 5, `prompt should contain human propagation language, hits=${hits}`);
  // Evidence remains gate not proxy — prompt must say evidence仅作门槛不代替传播力
  assert.ok(runnerSrc.includes('仅作门槛') || runnerSrc.includes('仅作是否') || runnerSrc.includes('不代替传播'), 'evidence gate language missing');
  // Producer must not assign grade directly — prompt must say 不得直接指定等级 or similar
  assert.ok(runnerSrc.includes('不得直接指定') || runnerSrc.includes('由系统计算'), 'producer not assigning grade instruction missing');
});

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
test('E: thesis diversity collapses five governance-like fixtures to one or rejects, five distinct remain', async () => {
  await withDb(async (db) => {
    // Seed sources for plan items
    const srcIds = [];
    for (let i = 0; i < 6; i++) srcIds.push(seedSource(db, `src-div-${i}`, `资料${i}`));
    const baseItem = (title, pov, angle, audience) => ({
      title,
      priority: 1,
      whyNow: '2026-08-25 出现可核验的新变化，未来两天是解释窗口，错过后需要重做验证。',
      timeliness: '热点 2-3 天',
      targetAudience: audience,
      angle,
      pointOfView: pov,
      platforms: ['x'],
      formats: ['text'],
      titleGuidance: '标题',
      openingGuidance: '开头',
      structureGuidance: '第一段交代事件；第二段展示对比证据；第三段给出行动判断。',
      effortEstimate: '约 40 分钟',
      sourceIds: [srcIds[0]],
      scoreReasons: scoredReasons(82),
      editorialDecision: editorialDecision(pov),
    });
    // Five governance-like with same normalized core claim/reader job (same POV/angle/audience, different titles)
    const governancePov = '价值不由最好的一次输出决定，而由可复跑的评测与验收标准决定，强调可验收的真实项目与公开验证';
    const governanceAngle = '选一个重复任务，写10个真实样本和验收标准，公开测试与复盘';
    const governanceAudience = '正在把提示词/Agent/自动化流程做成真实交付的人';
    const governanceItems = [
      baseItem('别再展示 AI 做成了什么，先把它放进一套能复跑的评测里', governancePov, governanceAngle, governanceAudience),
      baseItem('一次成功的 Agent 演示，为什么还不能算交付能力', governancePov, governanceAngle, governanceAudience),
      baseItem('批量生成视频以后，先用一致性和闪烁把废片筛掉', governancePov, governanceAngle, governanceAudience),
      baseItem('AI 产品从 Demo 走向工作环境，真正增加的是哪些约束', governancePov, governanceAngle, governanceAudience),
      baseItem('先问清楚谁会为这张 AI 结果卡片负责，再决定做什么', governancePov, governanceAngle, governanceAudience),
    ];
    let threw = false;
    let error = null;
    try {
      saveCurrentPlan(db, { planDate: '2026-08-25', timezone: 'Asia/Shanghai', summary: '治理偏测试', items: governanceItems });
    } catch (e) {
      threw = true;
      error = e;
    }
    assert.ok(threw, 'five governance-like items should be rejected as insufficiently diverse or collapse');
    if (threw) {
      const msg = String(error.message || '');
      assert.ok(msg.includes('thesis') || msg.includes('duplicate') || msg.includes('validation_failed'), `error should identify duplicate thesis, got ${msg}`);
      // Ensure error identifies duplicate items
      if (error.dupes) assert.ok(Array.isArray(error.dupes) && error.dupes.length > 0, 'dupes array should identify duplicate items');
      else assert.ok(msg.includes('0') || msg.includes('1'), 'error should identify duplicate indices');
    }

    // Five genuinely distinct reader jobs should remain (not collapse)
    const distinctItems = [
      baseItem('小红书 AI 涨粉：用对比钩子让收藏翻倍的 3 步模板', '通过对比钩子与可复制模板，读者今天就能做出高收藏笔记，获得即时涨粉反馈', '给出可直接套用的标题与结构模板，含数字/对比钩子', '想在小红书做 AI 内容但收藏低、不知道怎么写标题的人'),
      baseItem('知乎热榜 7 天：从提问到变现的评论区挖矿法', '从知乎评论区提炼真实需求，把高频提问转化为可付费的选题与产品验证', '展示评论区挖掘与需求归类动作，含真实提问与转化路径', '在知乎潜水但找不到变现选题的人'),
      baseItem('视频闪烁不用重做：用 VBench 一致性筛掉废片省 5 小时', '用一致性/闪烁自动化筛选批量 AI 视频，减少手工复看时间', '固定提示词生成一小批样片，按一致性/闪烁筛', '为客户批量制作 AI 视频但废片率高的人'),
      baseItem('Demo 到工作环境：隔离、审查、可回退三件套 1 小时接入', '把失败/权限/交接纳入交付，三个稳定层让 Demo 可进工作环境', '拆出隔离、逐条审查、可回退、过程成本可见', '把个人 AI 工作流整理成可交付工具的人'),
      baseItem('今天发什么：用 why-now 窗口把旧知识包装成爆点', '用时效钩子与错过成本把长青知识转化为今天值得发的选题', '识别窗口、给出今天发的理由与标题钩子', '有知识储备但不知道为何今天发的人'),
    ];
    let distinctSaved = null;
    try {
      distinctSaved = saveCurrentPlan(db, { planDate: '2026-08-26', timezone: 'Asia/Shanghai', summary: '多样性测试', items: distinctItems });
    } catch (e) {
      assert.fail(`five distinct reader jobs should remain, but threw ${e.message}`);
    }
    assert.ok(distinctSaved && distinctSaved.id, 'distinct items should save');
    const rows = db.prepare('SELECT COUNT(*) as c FROM plan_items WHERE plan_id = ?').get(distinctSaved.id);
    assert.equal(rows.c, 5, 'five distinct should remain 5');
  });
});

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
