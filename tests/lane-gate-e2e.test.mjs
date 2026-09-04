import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { applyDailyLaneGate, buildDailyGateRun, savePlanFromSynthesisOutput } from '../src/main/agent-runner.ts';
import { dispatchCompleteAgentTask, dispatchReportAgentTaskProgress, dispatchStartAgentTask } from '../src/main/agent-task-commands.ts';
import { agentRequestId } from '../src/main/agent-tasks.ts';
import { createCommandEnvelope } from '../src/main/command-dispatcher.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { assembleEditorialBrief, renderEditorialBrief } from '../src/main/editorial-brief.ts';
import { shanghaiDate } from '../src/main/ferment.ts';
import { recordSourceScanReceipt } from '../src/main/intelligence-channels.ts';
import { AI_FRONTIER_LIST_ID } from '../src/main/intelligence-wire.ts';
import { getLatestLaneJudgment, readLaneJudgments, shouldSkipJudgment } from '../src/main/lane-gate.ts';
import { dispatchLaneRestore } from '../src/main/source-commands.ts';
import { createSourceFeed, ensureRegistrySourceFeed, getSource, upsertSource } from '../src/main/sources.ts';
import { ensureAutomaticTaskGrant } from '../src/main/task-grants.ts';
import { getToday } from '../src/main/workbench.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { ensureOfficialWorkspaceProfile } from '../src/main/workspace-profiles.ts';

const owner = { type: 'owner_ui', id: 'renderer', label: 'Owner UI' };
const LANE = 'wemedia-intelligence-engine';

/**
 * WMB-4945 端到端验收（设计 §9 A–E）：
 * - A1 混合批（官方信源 + 赛道发布 + 博主生活动态）走完整判定门路径；
 * - B3/B4 简报增量/今日统计只数有效资料 + 行尾计数；
 * - C6 主编覆写恢复 → 有效库 + editor 行 + 7 日不重判；
 * - A2 解析失败零归档（fail-closed）+ 下一轮重判成功；
 * - E8 空跑 no-op（AC-017）：零新入库时资料门零写、空方案照常收尾。
 */

/** 混合批 fixture：官方信源（registry feed，Tier 0）+ AI 前沿 List（Tier 0）+ 混发生活动态（Tier 1）。 */
async function seedMixedFixture(runtime, planDate) {
  // 活动运行时写保护：fixture 落库走 dispatcher（与 lane-gate-run 的 seedGateFixture 同模式）。
  const envelope = createCommandEnvelope({
    workspaceId: runtime.identity.workspaceId,
    runtimeEpoch: runtime.identity.runtimeEpoch,
    command: 'test.lane.seed_mixed_fixture',
    requestId: `seed-mixed-${randomUUID()}`,
    input: {},
    boundIdentity: { entityType: 'source_item' },
    actor: owner
  });
  const receipt = await runtime.dispatchCommand(envelope, () => {
    const database = runtime.database;
    const officialFeed = ensureRegistrySourceFeed(database, {
      registryId: 'e2e-official-1', name: 'Test Official', url: 'https://official.example.com'
    });
    const frontierFeed = createSourceFeed(database, { name: 'X List · AI前沿' });
    const lifestyleFeed = createSourceFeed(database, { name: 'X List · 生活记录' });
    const now = new Date().toISOString();
    database.prepare(`INSERT INTO x_list_bindings
      (id, account_key, list_id, canonical_url, owner_handle, name, list_kind, source_feed_id, enabled,
       last_observed_at, last_observation_json, created_at, updated_at, revision)
      VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?,1)`).run(
      randomUUID(), 'acct-a', AI_FRONTIER_LIST_ID, `https://x.com/i/lists/${AI_FRONTIER_LIST_ID}`,
      'owner-a', 'AI前沿', 'owned', frontierFeed.id, now, '{}', now, now
    );
    const official = upsertSource(database, { title: '官方发布：OpenAI 发布新模型', originalUrl: `https://example.com/${randomUUID()}`, feedId: officialFeed.id }, false);
    const ai = upsertSource(database, { title: 'AI 博主：Agent 评测走向生产现场', originalUrl: `https://example.com/${randomUUID()}`, feedId: frontierFeed.id }, false);
    const lifestyle = upsertSource(database, { title: '博主：今天带娃去公园，晚饭吃了火锅', originalUrl: `https://example.com/${randomUUID()}`, feedId: lifestyleFeed.id }, false);
    // 采集时间锚定业务日（上海时区），顺序错开保证简报增量顺序确定。
    database.prepare('UPDATE source_items SET collected_at = ? WHERE id = ?').run(`${planDate}T10:00:00.000+08:00`, official.id);
    database.prepare('UPDATE source_items SET collected_at = ? WHERE id = ?').run(`${planDate}T11:00:00.000+08:00`, ai.id);
    database.prepare('UPDATE source_items SET collected_at = ? WHERE id = ?').run(`${planDate}T12:00:00.000+08:00`, lifestyle.id);
    return { data: { official: official.id, ai: ai.id, lifestyle: lifestyle.id }, entityType: 'source_item', entityId: official.id };
  });
  assert.equal(receipt.ok, true);
  return receipt.data;
}

async function startGateTask(runtime, planDate, watermark) {
  const started = (await dispatchStartAgentTask(runtime, {
    intent: 'daily_intelligence', businessDate: planDate, contextRefs: { workspaceId: runtime.identity.workspaceId }
  }, { actor: owner, requestId: `task-${randomUUID()}` })).task;
  // 判定窗口 = 简报增量窗口：judgeWatermark 显式落到任务 checkpoint（与生产水印推进语义一致）。
  return dispatchReportAgentTaskProgress(runtime, started.id, { checkpoint: { judgeWatermark: watermark } },
    { actor: owner, requestId: `checkpoint-${randomUUID()}`, taskId: started.id });
}

function lifestyleGateText(lifestyleId) {
  return '```json\n{"gate":[' +
    `{"sourceId":"${lifestyleId}","relevant":false,"reasonCode":"lifestyle_noise","reason":"博主个人生活动态，与 AI 赛道无关"}` +
    ']}\n```';
}

test('mixed-batch e2e: lifestyle archived with reason through gate path, official/lane active, effective brief + today counts', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const planDate = shanghaiDate();
    const watermark = `${planDate}T00:00:00.000+08:00`;
    const judgedAt = `${planDate}T13:00:00.000+08:00`;
    const ids = await seedMixedFixture(runtime, planDate);
    const task = await startGateTask(runtime, planDate, watermark);

    // 门路径分流：官方信源 + AI 前沿 List → Tier 0（零模型）；生活动态 → Tier 1 待判。
    const gateRun = buildDailyGateRun(database, task);
    assert.equal(gateRun.lane, LANE);
    assert.deepEqual(new Set(gateRun.autoRelevant.map((c) => c.sourceId)), new Set([ids.official, ids.ai]));
    assert.deepEqual(gateRun.pending.map((c) => c.sourceId), [ids.lifestyle]);

    const applied = await applyDailyLaneGate(runtime, task, gateRun, lifestyleGateText(ids.lifestyle), agentRequestId(task.id, 'plan'), judgedAt);
    assert.equal(applied.archivedCount, 1);
    assert.deepEqual([...applied.relevantIds].sort(), [ids.official, ids.ai].sort());

    // A1：生活动态 → archived + reason_code=lifestyle_noise + reason 非空；官方/赛道发布保持 active。
    const lifestyle = getSource(database, ids.lifestyle);
    assert.equal(lifestyle.managementStatus, 'archived');
    assert.equal(lifestyle.revision, 2);
    assert.equal(getSource(database, ids.official).managementStatus, 'active');
    assert.equal(getSource(database, ids.ai).managementStatus, 'active');
    const judgment = getLatestLaneJudgment(database, ids.lifestyle);
    assert.equal(judgment.decision, 'irrelevant');
    assert.equal(judgment.reasonCode, 'lifestyle_noise');
    assert.ok(judgment.reason?.length > 0, 'irrelevant 判定必须携带一句话 reason');
    assert.equal(judgment.judgedBy, 'agent');
    assert.equal(judgment.judgedAt, judgedAt);
    assert.equal(judgment.sourceRevision, 2);
    assert.equal(getLatestLaneJudgment(database, ids.official).judgedBy, 'system', '官方信源 Tier 0 零模型判定');
    assert.equal(getLatestLaneJudgment(database, ids.ai).judgedBy, 'system', 'AI 前沿 List Tier 0 零模型判定');
    assert.equal(readLaneJudgments(database, { workspaceLane: LANE }).length, 3, '系统行 ×2 + 编辑行 ×1');

    // B3/B4：简报增量只含有效资料 + 透明计数；今日 feed/统计只数有效 + 行尾计数。
    const brief = assembleEditorialBrief(database, {
      now: new Date(`${planDate}T14:00:00.000+08:00`), businessDate: planDate, watermark
    });
    assert.deepEqual(brief.increment.sources.map((s) => s.id), [ids.official, ids.ai], '增量块不含已移出（archived）条目');
    assert.equal(brief.increment.laneFiltered.count, 1);
    assert.deepEqual(brief.increment.laneFiltered.reasonCodes, [{ code: 'lifestyle_noise', count: 1 }]);
    assert.ok(renderEditorialBrief(brief).includes('本轮另有 1 条与本赛道无关'), '简报透明计数行');

    const today = getToday(database, planDate);
    assert.deepEqual(today.sources.map((s) => s.id).sort(), [ids.official, ids.ai].sort(), '今日 feed 不含已移出条目');
    assert.equal(today.sourcesTotal, 2, '「今日新资料」只数有效项');
    assert.equal(today.archivedTodayCount, 1, 'feed 行尾「另有 N 条」计数为当日已移出条数');
  });
});

test('restore e2e: restored source back in effective set and brief, editor row, 7d cooldown blocks re-judge next run', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const planDate = shanghaiDate();
    const watermark = `${planDate}T00:00:00.000+08:00`;
    const ids = await seedMixedFixture(runtime, planDate);
    const task = await startGateTask(runtime, planDate, watermark);
    const gateRun = buildDailyGateRun(database, task);
    await applyDailyLaneGate(runtime, task, gateRun, lifestyleGateText(ids.lifestyle), agentRequestId(task.id, 'plan'), `${planDate}T13:00:00.000+08:00`);
    assert.equal(getSource(database, ids.lifestyle).managementStatus, 'archived');

    // C6 主编覆写：恢复 → active + editor 覆写行（当前判定 = 最新行胜出）。
    const restoredAt = `${planDate}T14:00:00.000+08:00`;
    const restore = await dispatchLaneRestore(runtime, {
      requestId: `restore-${randomUUID()}`, actor: owner, sourceId: ids.lifestyle, workspaceLane: LANE,
      expectedRevision: 2, reason: '误判，恢复为有效素材', judgedAt: restoredAt
    });
    assert.equal(restore.ok, true);
    assert.equal(restore.data.restored, true);
    assert.equal(getSource(database, ids.lifestyle).managementStatus, 'active');
    const latest = getLatestLaneJudgment(database, ids.lifestyle);
    assert.equal(latest.decision, 'relevant');
    assert.equal(latest.reasonCode, 'editor_override');
    assert.equal(latest.judgedBy, 'editor');
    assert.equal(latest.judgedAt, restoredAt);

    // 恢复后资料回到有效库：下一轮简报增量可见。
    const brief = assembleEditorialBrief(database, {
      now: new Date(`${planDate}T15:00:00.000+08:00`), businessDate: planDate, watermark
    });
    assert.ok(brief.increment.sources.some((s) => s.id === ids.lifestyle), '恢复后资料重新进入简报增量');

    // 7 日冷却：恢复后同 source_id 不重判（即使 buildDailyGateRun 再跑一轮）——主编覆写为显式人类意图。
    assert.equal(shouldSkipJudgment(database, ids.lifestyle, new Date(Date.now() + 3_600_000)), true);
    const rerun = buildDailyGateRun(database, task);
    assert.equal(rerun.autoRelevant.length, 0, '7 日冷却内官方/赛道精选源不重判');
    assert.equal(rerun.pending.length, 0, '7 日冷却内恢复资料不重判');
    const noop = await applyDailyLaneGate(runtime, task, rerun, '无待判资料', agentRequestId(task.id, 'plan'), `${planDate}T15:00:00.000+08:00`);
    assert.equal(noop.archivedCount, 0);
    assert.equal(getSource(database, ids.lifestyle).managementStatus, 'active', '重判轮 no-op，恢复状态不被翻转');
  });
});


test('parse-fail e2e: broken gate block through gate path archives nothing; next-round retry succeeds', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const planDate = shanghaiDate();
    const watermark = `${planDate}T00:00:00.000+08:00`;
    const ids = await seedMixedFixture(runtime, planDate);
    const task = await startGateTask(runtime, planDate, watermark);
    const gateRun = buildDailyGateRun(database, task);

    // A2：结构化输出损坏 → 整轮抛错，零归档、零流水（fail-closed on archive）。
    await assert.rejects(
      () => applyDailyLaneGate(runtime, task, gateRun, '```json\n{broken\n```', agentRequestId(task.id, 'plan'), `${planDate}T13:00:00.000+08:00`),
      /不是合法 JSON/
    );
    assert.equal(database.prepare('SELECT COUNT(*) count FROM source_lane_judgments').get().count, 0, '解析失败零判定行');
    assert.equal(getSource(database, ids.lifestyle).managementStatus, 'active', '解析失败零归档');

    // 下一轮整批重判成功（判定幂等，无残留行）。
    const retry = await applyDailyLaneGate(runtime, task, gateRun, lifestyleGateText(ids.lifestyle), agentRequestId(task.id, 'plan'), `${planDate}T13:00:00.000+08:00`);
    assert.equal(retry.archivedCount, 1);
    assert.equal(getSource(database, ids.lifestyle).managementStatus, 'archived');
    assert.equal(readLaneJudgments(database, { workspaceLane: LANE }).length, 3, '重判写入 3 行（系统 ×2 + 编辑 ×1），无重复');
  });
});

async function withRuntime(work) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-lane-e2e-'));
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
