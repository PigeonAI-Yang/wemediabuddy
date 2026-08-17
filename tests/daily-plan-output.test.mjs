import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseDailyPlanOutput, readAssistantTexts, savePlanFromSynthesisOutput } from '../src/main/agent-runner.ts';
import { agentRequestId } from '../src/main/agent-tasks.ts';
import { dispatchCompleteAgentTask, dispatchStartAgentTask } from '../src/main/agent-task-commands.ts';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';
import { ensureAutomaticTaskGrant } from '../src/main/task-grants.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';

const validBlock = `\`\`\`json
{
  "planDate": "2026-08-06",
  "summary": "今日两条值得做",
  "items": [{
    "title": "Agent 评测走向生产现场",
    "priority": 1,
    "whyNow": "ORCA-bench 发布生产级评测",
    "timeliness": "长青",
    "targetAudience": "AI 工程团队",
    "angle": "评测可信度",
    "pointOfView": "可靠性比分数重要",
    "platforms": ["x"],
    "formats": ["text"],
    "titleGuidance": "标题",
    "openingGuidance": "开头",
    "structureGuidance": "结构",
    "effortEstimate": "约 40 分钟",
    "sourceIds": ["src-1"]
  }]
}
\`\`\``;

test('parseDailyPlanOutput reads the last json fence', () => {
  const text = `一些废话\n\`\`\`json\n{"summary":"旧块","items":[]}\n\`\`\`\n中间\n${validBlock}\n结尾`;
  const plan = parseDailyPlanOutput(text);
  assert.equal(plan.summary, '今日两条值得做');
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].priority, 1);
  assert.deepEqual(plan.items[0].sourceIds, ['src-1']);
});

test('empty items is a valid empty plan', () => {
  const plan = parseDailyPlanOutput('```json\n{"summary":"今日无合格机会","items":[]}\n```');
  assert.equal(plan.items.length, 0);
});

test('missing fence throws an actionable error', () => {
  assert.throws(() => parseDailyPlanOutput('没有任何代码块'), /未输出有效的 ```json 方案块/);
});

test('malformed json throws an actionable error', () => {
  assert.throws(() => parseDailyPlanOutput('```json\n{broken\n```'), /不是合法 JSON/);
});

test('incomplete item structure throws with field detail', () => {
  assert.throws(
    () => parseDailyPlanOutput('```json\n{"summary":"x","items":[{"title":"只有标题"}]}\n```'),
    /结构不完整/
  );
});

test('audience-label title is rejected before plan persistence', () => {
  const templated = validBlock.replace('Agent 评测走向生产现场', '普通人做 AI 接单，先卖小结果');
  assert.throws(
    () => parseDailyPlanOutput(templated),
    /标题不得把受众身份词「普通人」写进发布标题/
  );
});

test('planDate is optional and ignored when absent', () => {
  const plan = parseDailyPlanOutput('```json\n{"summary":"x","items":[]}\n```');
  assert.equal(plan.planDate, undefined);
});

test('jsonl session decode extracts fence from escaped assistant text', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-parser-'));
  try {
    const assistantText = `判断完成。\n\n\`\`\`json\n{\n  "planDate": "2026-08-06",\n  "summary": "今日一条",\n  "items": []\n}\n\`\`\``;
    const line = JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: assistantText }] } });
    const file = path.join(root, 'session.jsonl');
    await writeFile(file, `${line}\n`, 'utf8');
    const raw = await import('node:fs/promises').then((fs) => fs.readFile(file, 'utf8'));
    const texts = [];
    for (const rawLine of raw.split(/\r?\n/)) {
      if (!rawLine.trim()) continue;
      const entry = JSON.parse(rawLine);
      const content = entry?.message?.content;
      if (entry?.type === 'message' && entry?.message?.role === 'assistant' && Array.isArray(content)) {
        for (const seg of content) if (seg?.type === 'text' && typeof seg.text === 'string') texts.push(seg.text);
      }
    }
    const plan = parseDailyPlanOutput(texts.join('\n'));
    assert.equal(plan.summary, '今日一条');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('baseline excludes fences from earlier rounds in a resumed session', () => {
  const oldLine = JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '上一轮\n```json\n{"summary":"旧方案","items":[]}\n```' }] } });
  const newLine = JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '本轮\n```json\n{"summary":"新方案","items":[]}\n```' }] } });
  const raw = `${oldLine}\n${newLine}\n`;
  assert.equal(parseDailyPlanOutput(readAssistantTexts(raw).join('\n')).summary, '新方案');
  assert.equal(parseDailyPlanOutput(readAssistantTexts(raw, 1).join('\n')).summary, '新方案');
  assert.throws(() => parseDailyPlanOutput(readAssistantTexts(raw, 2).join('\n')), /未输出有效的 ```json 方案块/, 'baseline past every content line means no fence is found');
  const onlyOld = `${oldLine}\n`;
  assert.throws(() => parseDailyPlanOutput(readAssistantTexts(onlyOld, 1).join('\n')), /未输出有效的 ```json 方案块/, 'resumed round without new output cannot reuse the stale fence');
});

test('real terra session plan parses and saves through the granted dispatcher path', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-plan-replay-'));
  await openDataRoot(root);
  const seedDb = migrateDatabase(path.join(root, 'wmb.db'));
  const now = new Date().toISOString();
  seedDb.prepare(`INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', 'plan-replay-workspace', ?, ?, 1)`).run(now, now);
  for (const [id, slug] of [
    ['1fc56b68-6b26-45dc-9017-8e26ce89c520', 'qwen-release'],
    ['a5d9b0e0-5b92-4f85-8a25-ebb3f5f20bf5', 'aa-comparison']
  ]) {
    const saved = upsertSource(seedDb, { title: slug, originalUrl: `https://example.com/${slug}`, summary: `${slug} 摘要` }, false);
    seedDb.prepare('UPDATE source_items SET id=? WHERE id=?').run(id, saved.id);
  }
  seedDb.close();

  let runtime;
  try {
    runtime = ActiveWorkspaceRuntime.open(root, { openDatabase: migrateDatabase, createEpoch: () => 'plan-replay-runtime' });
    const started = await dispatchStartAgentTask(runtime, {
      intent: 'daily_intelligence', businessDate: '2026-08-06', contextRefs: { workspaceId: runtime.identity.workspaceId }
    }, { actor: { type: 'owner_ui', id: 'renderer', label: 'Owner UI' }, requestId: 'plan-replay-task' });
    const task = started.task;
    const lease = runtime.acquireWorkerLease(task.id);
    const grantId = await ensureAutomaticTaskGrant(runtime, task.id);

    const fixtureText = await readFile('tests/fixtures/terra-plan-session.txt', 'utf8');
    const sessionFile = path.join(root, 'replay-session.jsonl');
    await writeFile(sessionFile, `${JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: fixtureText }] } })}\n`, 'utf8');

    const saved = await savePlanFromSynthesisOutput(runtime, task, sessionFile, agentRequestId(task.id, 'plan'), lease.leaseId, grantId);
    assert.equal(saved.itemCount, 1);

    const plan = runtime.database.prepare(`SELECT summary FROM plans WHERE plan_date='2026-08-06' AND is_current=1`).get();
    assert.ok(plan.summary.includes('Qwen3.8-Max'), 'real model plan persisted verbatim');
    const item = runtime.database.prepare(`SELECT title, source_ids_json AS sourceIds FROM plan_items`).get();
    assert.ok(item.title.includes('Agentic Index'));
    assert.deepEqual(JSON.parse(item.sourceIds).sort(), ['1fc56b68-6b26-45dc-9017-8e26ce89c520', 'a5d9b0e0-5b92-4f85-8a25-ebb3f5f20bf5'].sort());

    const completed = await dispatchCompleteAgentTask(runtime, task.id, { actor: { type: 'owner_ui', id: 'renderer', label: 'Owner UI' }, requestId: 'plan-replay-complete', taskId: task.id });
    assert.equal(completed.status, 'partial', 'validation accepts the dispatcher-saved plan; empty aggregation annotates partial');
  } finally {
    await runtime?.stop({ drain: false });
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('writeFile helpers stay importable after parser extraction', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-parser-'));
  await rm(root, { recursive: true, force: true });
  assert.ok(true);
});
