import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { getProposalLedger } from '../src/main/proposals.ts';
import { upsertSource } from '../src/main/sources.ts';
import { buildTodayRecommendationProjection } from '../src/main/today-recommendation.ts';
import { editorialDecision, scoredReasons } from './helpers/planning-fixture.mjs';

const BUSINESS_DATE = '2026-08-28';
const AS_OF = new Date('2026-08-28T08:00:00.000Z');

async function withDb(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-repairable-'));
  await openDataRoot(root);
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  try { await run(database); }
  finally {
    database.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

function source(database, slug) {
  return upsertSource(database, {
    title: `资料 ${slug}`,
    originalUrl: `https://example.com/${slug}`,
    summary: `资料 ${slug} 的可核验摘要`
  }, false).id;
}

function completeItem(title, sourceId, thesis) {
  return {
    title,
    priority: 1,
    whyNow: '官方今天公布关键变化，未来两天是解释窗口，错过后需要重新核对事实。',
    timeliness: '热点 2-3 天',
    targetAudience: thesis.targetAudience,
    angle: thesis.angle,
    pointOfView: thesis.pointOfView,
    platforms: ['x'],
    formats: ['text'],
    titleGuidance: '标题突出事件变化与读者实际成本之间的反差。',
    openingGuidance: '首段先给出一条可核验事实，再说明它为什么影响当前选择。',
    structureGuidance: '第一段交代事件；第二段展示证据；第三段给出行动判断。',
    effortEstimate: '30m',
    sourceIds: [sourceId],
    scoreReasons: scoredReasons(80, AS_OF.toISOString()), editorialDecision: editorialDecision(thesis.pointOfView)
  };
}

function readState(database) {
  return database.prepare(`
    SELECT id, planning_status AS status, revision, why_now AS whyNow,
      score_reasons_json AS scoreReasonsJson
    FROM plan_items ORDER BY id
  `).all();
}

test('repairable projection is actionable, ledger-aligned, read-only, and never revives approved shells', async () => {
  await withDb(async (database) => {
    const invalidSource = source(database, 'invalid');
    const pendingSource = source(database, 'pending');
    const approvedSource = source(database, 'approved');
    const plan = saveCurrentPlan(database, {
      planDate: BUSINESS_DATE,
      timezone: 'Asia/Shanghai',
      summary: '修复投影夹具',
      items: [
        completeItem('非法待修复项', invalidSource, {
          targetAudience: '今天要核验旧方案字段是否足以批准的内容主编',
          angle: '检查 why-now 与完整结构缺口，定位不可批准原因',
          pointOfView: '缺少完整方案字段的候选必须先修复，不能乐观批准'
        }),
        completeItem('仍在待评分项', pendingSource, {
          targetAudience: '等待六维评分完成后再安排产能的项目负责人',
          angle: '读回当前评分阶段与缺失维度，给出继续评分入口',
          pointOfView: '评分未完成时必须显示原因，不能伪装成今日可批'
        }),
        completeItem('遗留已批准空壳', approvedSource, {
          targetAudience: '正在清理历史批准异常但不能批量改库的维护人员',
          angle: '区分历史批准状态与真实项目落成结果',
          pointOfView: '已批准但没有项目的遗留记录不能重新进入首页推荐'
        })
      ]
    });
    const ids = new Map(database.prepare('SELECT id, title FROM plan_items WHERE plan_id=?').all(plan.id).map((row) => [row.title, row.id]));
    database.prepare("UPDATE plan_items SET why_now='窗口', planning_status='ready_for_review' WHERE id=?").run(ids.get('非法待修复项'));
    database.prepare("UPDATE plan_items SET planning_status='draft', score_reasons_json=? WHERE id=?")
      .run(JSON.stringify({ status: 'pending', score: 0, reasons: [], scoredAt: null }), ids.get('仍在待评分项'));
    database.prepare("UPDATE plan_items SET planning_status='approved' WHERE id=?").run(ids.get('遗留已批准空壳'));

    const before = readState(database);
    const projection = buildTodayRecommendationProjection(database, BUSINESS_DATE, { now: AS_OF });
    const ledger = getProposalLedger(database, { planDate: BUSINESS_DATE, tab: 'scoring_pending', now: AS_OF });
    const after = readState(database);

    assert.equal(projection.primary, null);
    assert.equal(projection.eligible.some((item) => item.planItemId === ids.get('遗留已批准空壳')), false);
    assert.equal(projection.counts.scoringPending, 1);
    assert.equal(projection.counts.invalid, 2);
    assert.equal(projection.repairable.length, 3);
    for (const item of projection.repairable) {
      assert.ok(item.planItemId);
      assert.equal(Number.isInteger(item.revision), true);
      assert.ok(item.reasonCode);
      assert.ok(item.reason);
    }
    assert.equal(ledger.total, 1);
    assert.deepEqual(ledger.items.map((item) => item.planItemId), [ids.get('仍在待评分项')]);
    assert.equal(ledger.items.some((item) => item.planItemId === ids.get('遗留已批准空壳')), false);
    assert.ok(ledger.items.every((item) => item.repairReasonCode && item.repairReason));
    assert.deepEqual(after, before, 'projection and ledger reads must not rewrite legacy rows');
  });
});
