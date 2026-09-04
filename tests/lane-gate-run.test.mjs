import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createCommandEnvelope } from '../src/main/command-dispatcher.ts';
import { applyDailyLaneGate, buildDailyGateRun, parseLaneGateOutput, savePlanFromSynthesisOutput } from '../src/main/agent-runner.ts';
import { agentRequestId, startAgentTask } from '../src/main/agent-tasks.ts';
import { dispatchStartAgentTask } from '../src/main/agent-task-commands.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { AI_FRONTIER_LIST_ID } from '../src/main/intelligence-wire.ts';
import { getLatestLaneJudgment, LANE_JUDGMENT_COOLDOWN_MS, readLaneJudgments } from '../src/main/lane-gate.ts';
import { dispatchLaneGate, dispatchSourceUpsertBatch } from '../src/main/source-commands.ts';
import { createSourceFeed, ensureRegistrySourceFeed, getSource, upsertSource } from '../src/main/sources.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { ensureOfficialWorkspaceProfile } from '../src/main/workspace-profiles.ts';
import { editorialDecision, scoredReasons } from './helpers/planning-fixture.mjs';

const owner = { type: 'owner_ui', id: 'renderer', label: 'Owner UI' };
const LANE = 'wemedia-intelligence-engine';
const scoreReasonsForTest = JSON.stringify(scoredReasons(82));
const editorialDecisionForTest = JSON.stringify(editorialDecision('p'));

async function seedGateFixture(runtime) {
  // 活动运行时写保护：fixture 落库走 test 命令（与 lane-gate-contract 的 archive_fixture 同模式）。
  const envelope = createCommandEnvelope({
    workspaceId: runtime.identity.workspaceId,
    runtimeEpoch: runtime.identity.runtimeEpoch,
    command: 'test.lane.seed_fixture',
    requestId: `seed-fixture-${randomUUID()}`,
    input: {},
    boundIdentity: { entityType: 'source_item' },
    actor: owner
  });
  const receipt = await runtime.dispatchCommand(envelope, () => {
    const database = runtime.database;
    const officialFeed = ensureRegistrySourceFeed(database, {
      registryId: 'test-official-1', name: 'Test Official', url: 'https://official.example.com'
    });
    const frontierFeed = createSourceFeed(database, { name: 'X List · AI前沿' });
    const now = new Date().toISOString();
    database.prepare(`INSERT INTO x_list_bindings
      (id, account_key, list_id, canonical_url, owner_handle, name, list_kind, source_feed_id, enabled,
       last_observed_at, last_observation_json, created_at, updated_at, revision)
      VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?,1)`).run(
      randomUUID(), 'acct-a', AI_FRONTIER_LIST_ID, `https://x.com/i/lists/${AI_FRONTIER_LIST_ID}`,
      'owner-a', 'AI前沿', 'owned', frontierFeed.id, now, '{}', now, now
    );
    const lifestyleFeed = createSourceFeed(database, { name: 'X List · 生活记录' });
    const genericFeed = createSourceFeed(database, { name: 'X List · 泛科技' });
    const official = upsertSource(database, { title: '官方发布：OpenAI 发布新模型', originalUrl: `https://example.com/${randomUUID()}`, feedId: officialFeed.id }, false);
    const ai = upsertSource(database, { title: 'AI 博主：Agent 评测走向生产现场', originalUrl: `https://example.com/${randomUUID()}`, feedId: frontierFeed.id }, false);
    const lifestyle = upsertSource(database, { title: '博主：今天带娃去公园，晚饭吃了火锅', originalUrl: `https://example.com/${randomUUID()}`, feedId: lifestyleFeed.id }, false);
    const generic = upsertSource(database, { title: '泛科技：某硬件厂商发布财报', originalUrl: `https://example.com/${randomUUID()}`, feedId: genericFeed.id }, false);
    return { data: { official: official.id, ai: ai.id, lifestyle: lifestyle.id, generic: generic.id }, entityType: 'source_item', entityId: official.id };
  });
  assert.equal(receipt.ok, true);
  return receipt.data;
}

test('Tier 0 official/lane-source pass classifies without model and writes system rows only', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const { official, ai, lifestyle, generic } = await seedGateFixture(runtime);
    const started = (await dispatchStartAgentTask(runtime, { intent: 'daily_intelligence', businessDate: '2026-08-07', contextRefs: { workspaceId: runtime.identity.workspaceId } }, { actor: owner, requestId: `task-${randomUUID()}` })).task;
    const gateRun = buildDailyGateRun(database, started);
    assert.equal(gateRun.lane, LANE);
    assert.deepEqual(new Set(gateRun.autoRelevant.map((c) => c.sourceId)), new Set([official, ai]), '官方信源（registry feed）+ AI 前沿 List（AI-only route）零模型直判相关');
    assert.deepEqual(new Set(gateRun.pending.map((c) => c.sourceId)), new Set([lifestyle, generic]), '其余渠道内容交 Tier 1 逐条判定');

    // 本轮只有 Tier 0 候选时的门路径：只落系统行，官方/赛道发布保持 active（judged_by=system 即无模型调用痕迹）。
    const receipt = await dispatchLaneGate(runtime, {
      requestId: 'gate-tier0-only', actor: owner, workspaceLane: LANE, judgedBy: 'system',
      judgments: gateRun.autoRelevant.map((c) => ({ sourceId: c.sourceId, decision: 'relevant', reasonCode: 'official_source', expectedRevision: c.revision }))
    });
    assert.equal(receipt.ok, true);
    assert.equal(receipt.data.written.length, 2);
    assert.equal(receipt.data.archived.length, 0);
    assert.equal(getSource(database, official).managementStatus, 'active');
    assert.equal(getSource(database, ai).managementStatus, 'active');
    const row = getLatestLaneJudgment(database, official);
    assert.equal(row.decision, 'relevant');
    assert.equal(row.reasonCode, 'official_source');
    assert.equal(row.judgedBy, 'system');
    assert.equal(row.sourceRevision, 1);
    assert.equal(getLatestLaneJudgment(database, ai).judgedBy, 'system');

  });
});

test('mixed batch A1: lifestyle archived with reason, official and lane post stay active, rows carry judged_by/at/revision', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const { official, ai, lifestyle } = await seedGateFixture(runtime);
    const started = (await dispatchStartAgentTask(runtime, { intent: 'daily_intelligence', businessDate: '2026-08-07', contextRefs: { workspaceId: runtime.identity.workspaceId } }, { actor: owner, requestId: `task-${randomUUID()}` })).task;
    const gateRun = buildDailyGateRun(database, started);
    assert.ok(gateRun.pending.some((c) => c.sourceId === lifestyle), '混发内容进入 Tier 1 待判清单；官方/AI 前沿由 Tier 0 直判');

    // 模拟模型一轮输出：只判待判清单（官方/AI 前沿已由 Tier 0 直判，不入模型）。
    const judgedAt = '2026-08-07T09:00:00.000Z';
    const gateText = '\`\`\`json\n{"gate":[\n' +
      `  {"sourceId":"${lifestyle}","relevant":false,"reasonCode":"lifestyle_noise","reason":"博主个人生活动态，与 AI 赛道无关"}\n` +
      ']}\n\`\`\`';
    const gate = parseLaneGateOutput(gateText);
    assert.equal(gate.gate.length, 1);
    assert.equal(gate.gate[0].sourceId, lifestyle);
    assert.equal(gate.gate[0].relevant, false);

    // 编排顺序与 applyDailyLaneGate 一致：先系统行（Tier 0），再编辑行（Tier 1）。
    const systemReceipt = await dispatchLaneGate(runtime, {
      requestId: 'mixed-gate-tier0', actor: owner, workspaceLane: LANE, judgedBy: 'system', judgedAt,
      judgments: gateRun.autoRelevant.map((c) => ({ sourceId: c.sourceId, decision: 'relevant', reasonCode: 'official_source', expectedRevision: c.revision }))
    });
    assert.equal(systemReceipt.ok, true);
    const agentReceipt = await dispatchLaneGate(runtime, {
      requestId: 'mixed-gate-tier1', actor: owner, workspaceLane: LANE, judgedBy: 'agent', judgedAt,
      judgments: [
        { sourceId: lifestyle, decision: 'irrelevant', reasonCode: 'lifestyle_noise', reason: '博主个人生活动态，与 AI 赛道无关', expectedRevision: 1 }
      ]
    });
    assert.equal(agentReceipt.ok, true);
    assert.equal(agentReceipt.data.archived.length, 1);
    assert.deepEqual(agentReceipt.data.archived[0], { sourceId: lifestyle, revision: 2 });

    const lifestyleSource = getSource(database, lifestyle);
    assert.equal(lifestyleSource.managementStatus, 'archived');
    assert.equal(lifestyleSource.revision, 2);
    assert.equal(getSource(database, official).managementStatus, 'active');
    assert.equal(getSource(database, ai).managementStatus, 'active');

    const lifestyleJudgment = getLatestLaneJudgment(database, lifestyle);
    assert.equal(lifestyleJudgment.decision, 'irrelevant');
    assert.equal(lifestyleJudgment.reasonCode, 'lifestyle_noise');
    assert.ok(lifestyleJudgment.reason?.length > 0);
    assert.equal(lifestyleJudgment.judgedBy, 'agent');
    assert.equal(lifestyleJudgment.judgedAt, judgedAt);
    assert.equal(lifestyleJudgment.sourceRevision, 2);
    assert.equal(getLatestLaneJudgment(database, ai).decision, 'relevant');
    assert.equal(getLatestLaneJudgment(database, ai).judgedBy, 'system');
    assert.equal(getLatestLaneJudgment(database, official).judgedBy, 'system');
    assert.equal(readLaneJudgments(database, { workspaceLane: LANE }).length, 3);
  });
});

test('parse failure fail-closed: garbage gate block throws before any write and a broken batch rolls back to zero archive', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const { official, ai, lifestyle } = await seedGateFixture(runtime);
    assert.throws(() => parseLaneGateOutput('```json\n{broken\n```'), /不是合法 JSON/);
    assert.throws(() => parseLaneGateOutput('没有任何代码块'), /未输出有效的 ```json 赛道判定块/);
    assert.throws(() => parseLaneGateOutput('```json\n{"summary":"今日","items":[]}\n```'), /结构不完整/, '方案块不是判定块');
    assert.throws(() => parseLaneGateOutput('```json\n{"gate":[{"sourceId":"x","relevant":false}]}\n```'), /缺 reasonCode/);
    assert.throws(() => parseLaneGateOutput('```json\n{"gate":[{"sourceId":"x","relevant":false,"reasonCode":"official_source","reason":"r"}]}\n```'), /系统 reasonCode/);
    assert.throws(() => parseLaneGateOutput('```json\n{"gate":[{"sourceId":"x","relevant":false,"reasonCode":"lifestyle_noise"}]}\n```'), /缺一句话 reason/);
    assert.throws(() => parseLaneGateOutput('```json\n{"gate":[{"sourceId":"x","relevant":true},{"sourceId":"x","relevant":true}]}\n```'), /重复出现/);
    assert.equal(database.prepare('SELECT COUNT(*) count FROM source_lane_judgments').get().count, 0, '解析失败零判定行');

    // 命令级 fail-closed：同一事务里一个非法判定（irrelevant 缺 reason）→ 整批回滚，合法的也不归档。
    const broken = await dispatchLaneGate(runtime, {
      requestId: 'mixed-broken-batch', actor: owner, workspaceLane: LANE, judgedBy: 'agent',
      judgments: [
        { sourceId: lifestyle, decision: 'irrelevant', reasonCode: 'lifestyle_noise', expectedRevision: 1 },
        { sourceId: ai, decision: 'relevant', reasonCode: 'lane_relevant', expectedRevision: 1 }
      ]
    });
    assert.equal(broken.ok, false);
    assert.equal(broken.error.code, 'LANE_JUDGMENT_INVALID');
    assert.equal(getSource(database, lifestyle).managementStatus, 'active', '整批回滚：不归档');
    assert.equal(getSource(database, lifestyle).revision, 1);
    assert.equal(database.prepare('SELECT COUNT(*) count FROM source_lane_judgments').get().count, 0, '整批回滚：零流水');
  });
});

test('orchestration: unknown ids ignored; missing pending default relevant', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const { official, ai, lifestyle } = await seedGateFixture(runtime);
    const started = (await dispatchStartAgentTask(runtime, { intent: 'daily_intelligence', businessDate: '2026-08-07', contextRefs: { workspaceId: runtime.identity.workspaceId } }, { actor: owner, requestId: `task-${randomUUID()}` })).task;
    const gateRun = buildDailyGateRun(database, started);
    const judgedAt = '2026-08-07T09:00:00.000Z';
    const apply = (sessionText) => applyDailyLaneGate(runtime, started, gateRun, sessionText, agentRequestId(started.id, 'plan'), judgedAt);

    // 漏判/脏 id：默认保留相关或忽略；完整写入见下方 full 用例。


    // 完整一轮（官方/AI 前沿 Tier 0 + 混发判不相关 + 泛科技判相关）→ 全量写入且 lifestyle 归档。
    const generic = gateRun.pending.find((c) => c.sourceId !== lifestyle).sourceId;
    const full = `\`\`\`json\n{"gate":[{"sourceId":"${lifestyle}","relevant":false,"reasonCode":"lifestyle_noise","reason":"博主个人生活动态，与 AI 赛道无关"},{"sourceId":"${generic}","relevant":true}]}\n\`\`\``;
    const applied = await apply(full);
    assert.equal(applied.archivedCount, 1);
    assert.deepEqual(new Set(applied.relevantIds), new Set([official, ai, generic]));
    assert.equal(getSource(database, lifestyle).managementStatus, 'archived');
    assert.equal(getLatestLaneJudgment(database, lifestyle).reasonCode, 'lifestyle_noise');
    assert.equal(database.prepare('SELECT COUNT(*) count FROM source_lane_judgments').get().count, 4, '系统行 ×2 + 编辑行 ×2（lifestyle + generic）');
  });
});

test('orchestration tolerates a non-material source revision bump after the gate snapshot', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const { lifestyle } = await seedGateFixture(runtime);
    const started = (await dispatchStartAgentTask(runtime, { intent: 'daily_intelligence', businessDate: '2026-08-07', contextRefs: { workspaceId: runtime.identity.workspaceId } }, { actor: owner, requestId: `task-${randomUUID()}` })).task;
    const gateRun = buildDailyGateRun(database, started);
    const candidate = gateRun.pending.find((item) => item.sourceId === lifestyle);
    assert.ok(candidate);
    const before = getSource(database, lifestyle);
    const bumped = await dispatchSourceUpsertBatch(runtime, {
      requestId: `bump-${randomUUID()}`, actor: owner,
      items: [{ title: before.title, originalUrl: before.canonicalUrl, summary: before.summary, expectedRevision: before.revision }]
    });
    assert.equal(bumped.ok, true);
    assert.equal(getSource(database, lifestyle).revision, before.revision + 1);
    const sessionText = `\`\`\`json\n{"gate":[{"sourceId":"${lifestyle}","relevant":false,"reasonCode":"lifestyle_noise","reason":"个人生活动态，与 AI 赛道无关"}]}\n\`\`\``;
    const applied = await applyDailyLaneGate(runtime, started, gateRun, sessionText, agentRequestId(started.id, 'plan'), '2026-08-07T09:00:00.000Z');
    assert.equal(applied.unresolved, false);
    assert.equal(getSource(database, lifestyle).managementStatus, 'archived');
  });
});

test('7-day cooldown honored on re-run: judged sources drop out of the gate run, expired cooldown re-includes them', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const { official, ai, lifestyle, generic } = await seedGateFixture(runtime);
    const started = (await dispatchStartAgentTask(runtime, { intent: 'daily_intelligence', businessDate: '2026-08-07', contextRefs: { workspaceId: runtime.identity.workspaceId } }, { actor: owner, requestId: `task-${randomUUID()}` })).task;
    const oldJudgedAt = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
    // 8 天前判过一轮：冷却已过期 → 未归档条目重新成为候选；archived 条目命中既有状态不进判定轮。
    await dispatchLaneGate(runtime, {
      requestId: 'cooldown-old', actor: owner, workspaceLane: LANE, judgedBy: 'agent', judgedAt: oldJudgedAt,
      judgments: [
        { sourceId: lifestyle, decision: 'irrelevant', reasonCode: 'lifestyle_noise', reason: '生活动态', expectedRevision: 1 },
        { sourceId: generic, decision: 'relevant', reasonCode: 'lane_relevant', expectedRevision: 1 }
      ]
    });
    const expired = buildDailyGateRun(database, started);
    assert.deepEqual(new Set(expired.autoRelevant.map((c) => c.sourceId)), new Set([official, ai]), '冷却过期后官方/赛道精选源重新入 Tier 0');
    assert.deepEqual(expired.pending.map((c) => c.sourceId), [generic], '冷却过期后未归档条目重新入判；archived 条目不进判定轮');
    assert.ok(Date.now() - Date.parse(oldJudgedAt) > LANE_JUDGMENT_COOLDOWN_MS);

    // 今天再判一轮：7 日冷却内 → 全部跳过，判定轮 no-op（零归档重判轮）。
    const freshJudgedAt = new Date().toISOString();
    await dispatchLaneGate(runtime, {
      requestId: 'cooldown-fresh', actor: owner, workspaceLane: LANE, judgedBy: 'system', judgedAt: freshJudgedAt,
      judgments: [
        { sourceId: official, decision: 'relevant', reasonCode: 'official_source', expectedRevision: 1 },
        { sourceId: ai, decision: 'relevant', reasonCode: 'official_source', expectedRevision: 1 },
        { sourceId: generic, decision: 'relevant', reasonCode: 'lane_relevant', expectedRevision: 1 }
      ]
    });
    const rerun = buildDailyGateRun(database, started);
    assert.equal(rerun.autoRelevant.length, 0, '官方/赛道精选源在 7 日冷却内不重判');
    assert.equal(rerun.pending.length, 0, '已判资料在 7 日冷却内不重判（零归档重判轮）');
  });
});


async function withRuntime(work) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-lane-run-'));
  let runtime;
  try {
    const database = migrateDatabase(path.join(root, 'wmb.db'));
    const now = new Date().toISOString();
    database.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)").run(`workspace-${randomUUID()}`, now, now);
    ensureOfficialWorkspaceProfile(database, 'official.ai');
    database.close();
    runtime = ActiveWorkspaceRuntime.open(root, { openDatabase: migrateDatabase, createEpoch: () => 'runtime-current' });
    await work({ root, runtime, database: runtime.database });
  } finally {
    await runtime?.stop({ drain: false });
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
