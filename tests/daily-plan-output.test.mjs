import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseDailyPlanOutput, readAssistantTexts } from '../src/main/agent-runner.ts';
import { editorialDecision, scoredReasons } from './helpers/planning-fixture.mjs';

const scoredReasonsFixture = scoredReasons(82);
const scoredReasonsJson = JSON.stringify(scoredReasonsFixture);
const editorialDecisionJson = JSON.stringify(editorialDecision('可靠性比分数重要'));
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
    "sourceIds": ["src-1"],
    "scoreReasons": ${scoredReasonsJson},
    "editorialDecision": ${editorialDecisionJson}
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

test('optional topicId accepts model null as an omitted topic binding', () => {
  const plan = parseDailyPlanOutput(validBlock.replace('"sourceIds": ["src-1"],', '"sourceIds": ["src-1"],\n    "topicId": null,'));
  assert.equal(plan.items[0].topicId, undefined);
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
