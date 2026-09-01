import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildDailyOpportunityPrompt, buildPlannerSourceBoundary, cancelDailyIntelligenceIfRequested, draftPrompt, savePlanFromSynthesisOutput } from '../src/main/agent-runner.ts';
import { agentRequestId, getAgentTask, reportAgentTaskProgress, requestAgentTaskControl, startAgentTask } from '../src/main/agent-tasks.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { updateKnowledgeSource } from '../src/main/knowledge.ts';
import { createTopic, saveCurrentPlan } from '../src/main/planning.ts';
import { applyLaneGateBatch } from '../src/main/lane-gate.ts';
import { piTaskAuthorityPrompt } from '../src/main/pi-operator-skill.ts';
import { upsertSource } from '../src/main/sources.ts';
import { getToday } from '../src/main/workbench.ts';
import { ensureOfficialWorkspaceProfile } from '../src/main/workspace-profiles.ts';
import { approvePlanItems, editorialDecision, scoredReasons } from './helpers/planning-fixture.mjs';

test('daily synthesis keeps watching and fermenting context while a cancel request wins over partial recovery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-agent-runner-'));
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  try {
    const source = upsertSource(database, { originalUrl: 'https://example.com/watching', title: '长期观察资料', priority: 1 });
    updateKnowledgeSource(database, { id: source.id, expectedRevision: source.revision, managementStatus: 'watching' });
    const topicId = createTopic(database, '跨日发酵机会').id;
    const savedPlan = saveCurrentPlan(database, {
      planDate: '2026-08-02', timezone: 'Asia/Shanghai', summary: '昨日方案', items: [{
        title: '跨日发酵机会', priority: 1, whyNow: '仍有余波', timeliness: '本周', targetAudience: '受众', angle: '解释影响', pointOfView: '持续跟进',
        platforms: ['x'], formats: ['text'], titleGuidance: '标题', openingGuidance: '开头', structureGuidance: '结构', effortEstimate: '30m', sourceIds: [source.id], topicId, editorialDecision: editorialDecision('持续跟进'), scoreReasons: scoredReasons()
      }]
    });
    approvePlanItems(database, [database.prepare('SELECT id FROM plan_items WHERE plan_id=?').get(savedPlan.id).id]);
    const started = startAgentTask(database, { intent: 'daily_intelligence', businessDate: '2026-08-03' });
    assert.equal(started.ok, true);
    const prompt = buildDailyOpportunityPrompt(database, started.data, agentRequestId(started.data.id, 'plan'));
    assert.match(prompt, /【编辑简报/);
    assert.match(prompt, /业务日期 2026-08-03/);
    assert.match(prompt, /■ 身份/);
    assert.match(prompt, /■ 历史/);
    assert.match(prompt, /■ 存量/);
    assert.match(prompt, /■ 增量/);
    assert.match(prompt, /长期观察资料/);
    assert.match(prompt, /跨日发酵机会/);
    assert.match(prompt, /为什么是现在/);
    assert.match(prompt, /五维/);
    assert.match(prompt, /六栏目/);
    // 新身份：以方向与真实项目描述受众，不把身份标签锚定成标题素材
    assert.match(prompt, /正在寻找 AI 商业化方向、愿意完成真实项目并获取反馈的人/);
    assert.match(prompt, /受众描述只用于内部判断，不是标题素材/);
    assert.match(prompt, /内部生成至少三个不同切口的候选/);
    assert.match(prompt, /不得使用「普通人」等万能受众标签/);
    for (const dimension of ['时代认知', '个人方向', 'AI 实践', '公开验证', '产品化']) assert.match(prompt, new RegExp(dimension), `missing dimension ${dimension}`);
    for (const column of ['迷茫诊断', '经典方法', 'AI 实战', '项目日志', '方向判断', '商业化实验']) assert.match(prompt, new RegExp(column), `missing column ${column}`);
    assert.doesNotMatch(prompt, /内容→信任→付费/);
    assert.doesNotMatch(prompt, /认知\/技能\/表达/);
    assert.doesNotMatch(prompt, /实验日志/);
    assert.doesNotMatch(prompt, /原则卡/);
    // 旧运营安全门保持不变
    assert.match(prompt, /仅可调用 wmb_get_knowledge_context/);
    assert.match(prompt, /尤其禁止 wmb_get_workbench/);
    assert.match(prompt, /收尾只输出一个 ```json 代码块/);
    assert.match(prompt, /"planDate": "2026-08-03"/);
    assert.doesNotMatch(prompt, /先调用 wmb_get_workbench/);
    assert.match(prompt, /禁止为此另行扫描新来源/);
    assert.doesNotMatch(prompt, /sources_request_id=/);
    assert.doesNotMatch(prompt, /官方产品与模型发布/);
    assert.doesNotMatch(prompt, /共享渠道模块完成真实扫描/);
    const withWatermark = { ...started.data, checkpoint: { judgeWatermark: '2026-08-05T02:00:00.000Z' } };
    const scopedPrompt = buildDailyOpportunityPrompt(database, withWatermark, agentRequestId(withWatermark.id, 'plan'));
    assert.match(scopedPrompt, /最终方案是该业务日期的完整当前方案/);
    assert.match(scopedPrompt, /水印 2026-08-02T15:59:59.999Z 之后/, 'planner scope starts at the business-day boundary, not the incremental judge watermark');

    const fresh = startAgentTask(database, { intent: 'daily_intelligence', businessDate: '2026-08-04' });
    assert.equal(fresh.ok, true);
    reportAgentTaskProgress(database, withWatermark.id, { checkpoint: { judgeWatermark: '2026-08-05T02:00:00.000Z' } });
    const inheritedPrompt = buildDailyOpportunityPrompt(database, fresh.data, agentRequestId(fresh.data.id, 'plan'));
    assert.match(inheritedPrompt, /水印 2026-08-03T15:59:59.999Z 之后/, 'fresh task plans across its full business day even when incremental judgment inherits a later watermark');

    const withSearch = buildDailyOpportunityPrompt(database, fresh.data, agentRequestId(fresh.data.id, 'plan'), { nativeSearch: true });
    assert.match(withSearch, /模型自带的联网搜索补充证据/);
    const withoutSearch = buildDailyOpportunityPrompt(database, fresh.data, agentRequestId(fresh.data.id, 'plan'), { nativeSearch: false });
    assert.match(withoutSearch, /未开启自带搜索/);
    assert.doesNotMatch(withoutSearch, /模型自带的联网搜索补充证据/);

    // 赛道门（Tier 1 判定）提示词沿用新身份与降权口径；旧「宏大综述/躺赚毒鸡汤」措辞不再出现
    ensureOfficialWorkspaceProfile(database, 'official.ai');
    const gated = buildDailyOpportunityPrompt(database, fresh.data, agentRequestId(fresh.data.id, 'plan'));
    assert.match(gated, /第一关：赛道相关性判定/);
    assert.match(gated, /五维=时代认知\/个人方向\/AI 实践\/公开验证\/产品化/);
    assert.match(gated, /纯模型公告、对目标读者没有可执行意义的参数\/价格新闻/);
    assert.doesNotMatch(gated, /宏大行业综述/);
    assert.doesNotMatch(gated, /躺赚毒鸡汤/);

    const requested = requestAgentTaskControl(database, started.data.id, 'cancel');
    assert.equal(requested.ok, true);
    const cancelled = cancelDailyIntelligenceIfRequested(database, getAgentTask(database, started.data.id));
    assert.equal(cancelled?.status, 'cancelled');
    assert.equal(cancelled?.errorCode, 'CANCELLED');
    assert.equal(getAgentTask(database, started.data.id)?.status, 'cancelled');
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('planner sees every effective source from the business day after an incremental watermark', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-agent-runner-day-scope-'));
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  try {
    ensureOfficialWorkspaceProfile(database, 'official.ai');
    const earlier = upsertSource(database, { originalUrl: 'https://example.com/earlier', title: '今日较早但仍应参与最终策划' });
    const latest = upsertSource(database, { originalUrl: 'https://example.com/latest', title: '水位线后的新增资料' });
    database.prepare('UPDATE source_items SET collected_at=? WHERE id=?').run('2026-08-05T01:00:00.000Z', earlier.id);
    database.prepare('UPDATE source_items SET collected_at=? WHERE id=?').run('2026-08-05T05:00:00.000Z', latest.id);
    applyLaneGateBatch(database, {
      workspaceLane: 'wemedia-intelligence-engine', judgedBy: 'agent', judgedAt: '2026-08-05T02:00:00.000Z',
      judgments: [{ sourceId: earlier.id, decision: 'relevant', reasonCode: 'lane_relevant', reason: '属于今日有效资料', expectedRevision: earlier.revision }]
    });
    const started = startAgentTask(database, { intent: 'daily_judge', businessDate: '2026-08-05' });
    assert.equal(started.ok, true);
    const task = { ...started.data, checkpoint: { judgeWatermark: '2026-08-05T04:00:00.000Z' } };

    const prompt = buildDailyOpportunityPrompt(database, task, agentRequestId(task.id, 'plan'));
    assert.match(prompt, /今日较早但仍应参与最终策划/);
    assert.match(prompt, /水位线后的新增资料/);

    const boundary = buildPlannerSourceBoundary(database, task, new Set([latest.id]));
    assert.deepEqual(boundary.candidateIds, new Set([earlier.id, latest.id]));
    assert.deepEqual(boundary.allowedIds, new Set([earlier.id, latest.id]));
    const makeItem = (sourceId, title, pointOfView, priority) => ({
      title: `${title}：完整方案`, priority, whyNow: '今日发生且仍在有效窗口', timeliness: '热点 2-3 天',
      targetAudience: '正在推进真实 AI 项目的创作者', angle: `从第 ${priority + 1} 个独立角度分析`, pointOfView,
      platforms: ['x'], formats: ['text'], titleGuidance: '直接点出冲突', openingGuidance: '首段兑现冲突',
      structureGuidance: '方向判断：为何现在→强观点→来源', effortEstimate: '约 40 分钟', sourceIds: [sourceId],
      availableMaterials: [], missingMaterials: [], editorialDecision: editorialDecision(pointOfView), scoreReasons: scoredReasons(80 - priority)
    });
    const output = {
      planDate: task.businessDate,
      summary: '今日全部有效资料形成的完整方案',
      items: [
        makeItem(earlier.id, '今日较早但仍应参与最终策划', '较早资料仍然构成今日重要机会', 0),
        makeItem(latest.id, '水位线后的新增资料', '新增资料构成另一个独立机会', 1)
      ],
      sourceDecisions: [
        { sourceId: earlier.id, decision: 'selected', reasonCode: 'selected_full_day', reason: '较早资料仍在今日有效范围内' },
        { sourceId: latest.id, decision: 'selected', reasonCode: 'selected_increment', reason: '新增资料达到选题标准' }
      ]
    };
    const sessionFile = path.join(root, 'planner-session.jsonl');
    await writeFile(sessionFile, `${JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(output)}\n\`\`\`` }] } })}\n`, 'utf8');
    const saved = await savePlanFromSynthesisOutput(database, task, sessionFile, agentRequestId(task.id, 'plan'), undefined, undefined, 0, boundary.allowedIds, boundary.candidateIds);
    assert.equal(saved.itemCount, 2);
    assert.deepEqual(getToday(database, task.businessDate).plan.items.map((item) => item.title), [
      '今日较早但仍应参与最终策划：完整方案',
      '水位线后的新增资料：完整方案'
    ]);
  } finally {

    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('writer prompts keep audience identity out of core and platform titles', () => {
  const task = { id: 'task-title-test' };
  // core_draft 默认 researchReady=false 时为外部研究前置交接（不含标题约束）；真实写作需 researchReady=true
  const core = draftPrompt(task, 'project-1', 'request-1', 'core_draft', '', true);
  assert.match(core, /标题围绕该题材独有的对象、问题、动作或证据/);
  assert.match(core, /不自动添加「普通人」等万能受众标签/);
  assert.match(core, /不写来源未支持的数字、结果或因果/);

  const xhs = draftPrompt(task, 'project-1', 'request-2', 'xiaohongshu_platform_version');
  assert.match(xhs, /标题围绕该题材独有的对象、问题、动作或证据/);
  assert.match(xhs, /不自动添加「普通人」等万能受众标签/);
});

test('daily IPC submits one typed owner intent and does not create legacy tasks or run caches', async () => {
  const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  const start = source.indexOf("ipcMain.handle('agent:start-daily-intelligence'");
  const end = source.indexOf("ipcMain.handle('agent:start-studio-draft'", start);
  assert.ok(start >= 0 && end > start);
  const handler = source.slice(start, end);
  assert.match(handler, /submitWorkspaceOrchestratorIntent\(runtime/);
  assert.match(handler, /producerId: 'today\.agent-start-daily-intelligence'/);
  assert.match(handler, /action: 'full'/);
  assert.match(handler, /rootMode: 'owner'/);
  assert.doesNotMatch(handler, /startWorkspaceDailyIntelligence|startAgentTask|resolveAgentPiPrerequisite|dailyRuns/);
});

test('Pi task authority prompt carries exact automatic task, grant and lease values', () => {
  const prompt = piTaskAuthorityPrompt({
    taskId: 'task-exact', grantId: 'grant-exact', workerLeaseId: 'lease-exact', context: '当前赛道为测试赛道。'
  });
  assert.match(prompt, /taskId=task-exact/);
  assert.match(prompt, /grantId=grant-exact/);
  assert.match(prompt, /workerLeaseId=lease-exact/);
  assert.match(prompt, /当前赛道为测试赛道/);
  assert.match(prompt, /无需用户额外授权/);
  assert.doesNotMatch(prompt, /Owner 已签发|Owner 必须|另行授权/);
  assert.throws(() => piTaskAuthorityPrompt({ taskId: 'task-exact', grantId: null, workerLeaseId: 'lease-exact' }), /PI_TASK_AUTHORITY_REQUIRED/);
  assert.throws(() => piTaskAuthorityPrompt({ taskId: 'task-exact', grantId: 'grant-exact' }), /PI_TASK_AUTHORITY_REQUIRED/);
});
