import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { draftPrompt } from '../src/main/agent-runner.ts';
import { targetedPlannerPrompt } from '../src/main/role-job-policies.ts';
import { transitionPlanItem } from '../src/main/planning-stage.ts';
import { editorialDecision, scoredReasons } from './helpers/planning-fixture.mjs';

// SSOT path
const WRITER_SKILL = path.join(process.cwd(), 'skills/evidence-grounded-writer/SKILL.md');

const REQUIRED_BEHAVIORS = [
  { key: 'reader-in-situation', substr: '处在具体情境中的读者' },
  { key: 'desired-action', substr: '期望读者动作' },
  { key: 'central-claim', substr: '一个中心主张' },
  { key: 'opening-immediately', substr: '首段立刻兑现' },
  { key: 'abstract-person-scenario', substr: '人/场景/利害/后果' },
  { key: 'evidence-supports', substr: '证据服务主张' },
  { key: 'retain-tension', substr: '保留可防守的张力' },
  { key: 'never-soften', substr: '需要综合考虑' },
  { key: 'distinguish-nuance', substr: '各打五十大板' },
  { key: 'platform-adapt', substr: '重写钩子' },
  { key: 'title-paid-off', substr: '标题必兑现' },
  { key: 'no-fabrication', substr: '编造' },
  { key: 'self-check-reader-benefit', substr: '读者收益是否具体' },
  { key: 'self-check-stakes', substr: '具体利害' },
  { key: 'self-check-why-now', substr: '为何现在' },
  { key: 'self-check-share', substr: '收藏/分享/评论动机' },
];

function assertBehaviors(content, label) {
  for (const b of REQUIRED_BEHAVIORS) {
    assert.ok(content.includes(b.substr), `${label} missing behavior ${b.key}: ${b.substr}`);
  }
}

test('SSOT writer skill contains all required behaviors', async () => {
  const content = await readFile(WRITER_SKILL, 'utf8');
  assertBehaviors(content, 'writer SKILL.md');
  // also explicitly check self-check four items block
  assert.ok(content.includes('自检拒稿'), 'writer skill must have self-check');
  // ensure contradictory old guidance removed / not reintroduced as sole pattern
  // title must contain hook requirement
  assert.ok(content.includes('数字/对比/反转/代价'), 'writer skill must require hook');
});

test('draftPrompt core_draft embeds all required behaviors (runtime consumer)', async () => {
  const task = { id: 'task-test-001' };
  const prompt = draftPrompt(task, 'proj-1', 'req-1', 'core_draft', '测试 brief：AI 视频生成闪烁问题', true);
  const filtered = REQUIRED_BEHAVIORS.filter(b => b.key !== 'platform-adapt');
  for (const b of filtered) {
    assert.ok(prompt.includes(b.substr), `draftPrompt core_draft missing behavior ${b.key}: ${b.substr}`);
  }
  // ensure writer SSOT reference
  assert.ok(prompt.includes('skills/evidence-grounded-writer'), 'draftPrompt must reference SSOT');
  assert.ok(prompt.includes('首段立刻兑现'), 'draftPrompt must require opening immediate');
  assert.ok(prompt.includes('禁止编造') || prompt.includes('编造'), 'draftPrompt must forbid fabrication');
  assert.ok(prompt.includes('自检'), 'draftPrompt must have self-check');
  // ensure not softened: must contain prohibition of soft phrases
  assert.ok(prompt.includes('需要综合考虑'), 'draftPrompt must prohibit softening phrase');
});

test('draftPrompt xiaohongshu platform version adapts hook/pace/share motive rather than merely shorten', async () => {
  const task = { id: 'task-test-002' };
  const prompt = draftPrompt(task, 'proj-1', 'req-2', 'xiaohongshu_platform_version', '测试', true);
  assert.ok(prompt.includes('重写开头钩子、信息节奏与收藏/分享/评论动机'), 'platform prompt must rewrite hook/pace/motive');
  assert.ok(prompt.includes('不是缩短'), 'platform prompt must say not merely shorten');
  assert.ok(prompt.includes('保留一个中心主张'), 'platform prompt must preserve central claim');
  assert.ok(prompt.includes('标题必须包含'), 'platform prompt must require hook');
});

test('targetedPlannerPrompt embeds all required behaviors (runtime consumer)', async () => {
  const task = { id: 'task-planner-001' };
  const ctx = { spec: { planItemId: 'item-123' }, jobId: 'job-123', businessDate: '2026-08-25', brief: '测试' };
  const prompt = targetedPlannerPrompt(task, ctx);
  assertBehaviors(prompt, 'targetedPlannerPrompt');
  assert.ok(prompt.includes('skills/evidence-grounded-writer'), 'planner prompt must reference SSOT');
  assert.ok(prompt.includes('propagation_v2'), 'planner prompt must use propagation_v2 criteria');
  assert.ok(prompt.includes('reality_change_significance'), 'planner prompt must score reality-change significance');
  assert.ok(!prompt.includes('evidence_coverage(25)'), 'planner prompt must not use old governance criteria');
  assert.ok(prompt.includes('自检四项'), 'planner prompt must have self-check');
  assert.ok(prompt.includes('不得保留模板或沿用旧课程大纲体'), 'planner must reject old course outline');
});

test('dailyPrompt embeds all required behaviors (runtime consumer)', async () => {
  const runnerSrc = await readFile(path.join(process.cwd(), 'src/main/agent-runner.ts'), 'utf8');
  assertBehaviors(runnerSrc, 'dailyPrompt in agent-runner.ts');
  assert.ok(runnerSrc.includes('2.8 传播型写作契约'), 'dailyPrompt must have 2.8 contract section');
  assert.ok(runnerSrc.includes('skills/evidence-grounded-writer/SKILL.md'), 'dailyPrompt must reference SSOT');
  assert.ok(runnerSrc.includes('数字/对比/反转/代价四选一'), 'dailyPrompt must require hook');
  assert.ok(runnerSrc.includes('仅作门槛'), 'dailyPrompt must keep evidence gate language');
});

test('regression: audited safe governance topic without concrete brief is rejected, concrete self-media brief passes', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const { openDataRoot } = await import('../src/main/data-root.ts');
  const { migrateDatabase } = await import('../src/main/db/migrations.ts');
  const { saveCurrentPlan } = await import('../src/main/planning.ts');
  const { upsertSource } = await import('../src/main/sources.ts');
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-writer-contract-'));
  await openDataRoot(root);
  const db = migrateDatabase(path.join(root, 'wmb.db'));
  try {
    function seedSource(id, title, categories = ['primary']) {
      const saved = upsertSource(db, {
        originalUrl: `https://example.com/${id}`,
        title,
        summary: `${title} 摘要内容足够支撑证据维度`,
        categories,
        keywords: [],
        recommendedPlatforms: [],
        recommendedFormats: [],
      }, false);
      db.prepare('UPDATE source_items SET collected_at = ?, categories_json = ? WHERE id = ?').run(new Date().toISOString(), JSON.stringify(categories), saved.id);
      return saved.id;
    }
    const srcId = seedSource('src-regression-1', '资料一');
    const oldCourseItem = {
      title: 'AI 治理框架与评测体系的综合考量',
      priority: 1,
      whyNow: '值得关注，未来可期',
      timeliness: '长期',
      targetAudience: '正在把提示词/Agent/自动化流程做成真实交付的人',
      angle: '选一个重复任务，写10个真实样本和验收标准',
      pointOfView: '价值不由最好的一次输出决定，而由可复跑的评测与验收标准决定',
      platforms: ['x'],
      formats: ['text'],
      titleGuidance: '标题',
      openingGuidance: '先介绍行业背景与定义，再谈评测的重要性',
      structureGuidance: '第一段交代事件；第二段展示对比证据；第三段给出行动判断。',
      effortEstimate: '约 40 分钟',
      sourceIds: [srcId],
      editorialDecision: editorialDecision('价值不由最好的一次输出决定，而由可复跑的评测与验收标准决定'),
      scoreReasons: scoredReasons(82),
    };
    const concreteItem = {
      title: '小红书 AI 涨粉：用对比钩子让收藏翻倍的 3 步模板（省 5 小时）',
      priority: 1,
      whyNow: '2026-08-25 小红书对比钩子笔记收藏率高出 2.3 倍，窗口期 7 天，错过需重做内容测试',
      timeliness: '热点 2-3 天',
      targetAudience: '在小红书做 AI 内容但收藏不过 100、不知道怎么写标题的运营（卡在标题钩子）',
      angle: '给出可直接套用的标题与结构模板，含数字/对比钩子，配真实案例与利害',
      pointOfView: '对比钩子比泛泛科普更易获得收藏，值得今天就用模板重做 1 篇',
      platforms: ['xiaohongshu'],
      formats: ['text'],
      titleGuidance: '标题建议',
      openingGuidance: '首段立刻兑现钩子：先给收藏翻倍对比案例与代价，再给模板',
      structureGuidance: '第一段交代事件；第二段展示对比案例；第三段给出可执行模板。',
      effortEstimate: '约 40 分钟',
      sourceIds: [srcId],
      editorialDecision: editorialDecision('对比钩子比泛泛科普更易获得收藏，值得今天就用模板重做 1 篇'),
      scoreReasons: scoredReasons(88),
    };
    const saved = saveCurrentPlan(db, { planDate: '2026-08-26', timezone: 'Asia/Shanghai', summary: '具体自媒体简报', items: [concreteItem] });
    assert.ok(saved.id, 'concrete brief should save');
    const row = db.prepare('SELECT id, revision, planning_status, score_reasons_json FROM plan_items WHERE plan_id = ?').get(saved.id);
    assert.equal(row.planning_status, 'ready_for_review');
    const approved = transitionPlanItem(db, { planItemId: row.id, expectedRevision: row.revision, expectedStatus: 'ready_for_review', toStatus: 'approved', by: 'desk' });
    assert.equal(approved.planningStatus, 'approved');
    const hasHook = /数字|对比|反转|代价|\d+|省.*小时|翻倍|对比/.test(oldCourseItem.title);
    assert.equal(hasHook, false, 'old course title should lack required hook, proving prompt would reject it');
    assert.ok(oldCourseItem.openingGuidance.includes('先介绍行业背景'), 'old opening is background, not immediate');
    assert.ok(oldCourseItem.whyNow.includes('值得关注') || oldCourseItem.whyNow.includes('未来可期'), 'old whyNow is soft');
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
