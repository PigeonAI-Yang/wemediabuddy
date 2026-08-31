import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { createPlanningDraftFromTarget, submitPlanItemForReview, transitionPlanItem } from '../src/main/planning-stage.ts';
import { approvePlanItemAndCreateProject } from '../src/main/plan-item-approval.ts';
import {
  assertPlanItemContentCreateAllowed,
  saveCoreVersion,
  updateContentProject,
} from '../src/main/content.ts';
import { resolvePropagationGrade } from '../src/shared/propagation.ts';
import { editorialDecision, scoredReasons } from './helpers/planning-fixture.mjs';

const NOW = new Date('2026-08-29T08:00:00.000Z');

const LEGACY_SCORE = {
  status: 'scored',
  score: 87,
  scoredAt: '2026-08-29T07:00:00.000Z',
  reasons: [
    ['reader_immediacy_benefit', 20, 18],
    ['tension_curiosity_gap', 20, 18],
    ['why_now_window', 20, 19],
    ['save_share_comment_motive', 20, 17],
    ['evidence_credibility', 15, 10],
    ['account_fit', 5, 5],
  ].map(([criterion, weight, score]) => ({ criterion, weight, score, reason: 'legacy v1' })),
};

async function withDb(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5364-boundary-'));
  await openDataRoot(root);
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  try {
    await run(database);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

function planInput(sourceId, winner = '国产算力开始承接大规模公共 AI 服务是最重要的产业信号') {
  return {
    title: 'GLM-5.3 Flash 背后的国产算力商业化信号',
    priority: 1,
    whyNow: '模型身份、免费容量和国产芯片承载证据首次进入同一条可核验链路，产业判断窗口已经出现。',
    timeliness: '热点 2-3 天',
    targetAudience: '关心中国 AI 基础设施商业化进程的开发者与自媒体创作者',
    angle: '从公共商业服务的算力承载能力切入，解释免费额度背后的产业变化。',
    pointOfView: winner,
    platforms: ['x'],
    formats: ['text'],
    titleGuidance: '突出免费额度与国产算力商业化之间的反差。',
    openingGuidance: '首段先给出可核验的承载事实，再解释它为什么改变判断。',
    structureGuidance: '事件与窗口；承载证据；产业判断与行动建议',
    effortEstimate: '90 分钟',
    sourceIds: [sourceId],
    scoreReasons: scoredReasons(80, NOW.toISOString()),
    editorialDecision: editorialDecision(winner),
  };
}

function createPlan(database, { winner, scoreReasons, editorial = true } = {}) {
  const source = upsertSource(database, {
    originalUrl: `https://example.com/wmb-5364-${Math.random()}`,
    title: 'WMB-5364 测试来源',
    summary: '用于验证审批与主张锁边界的来源。',
  });
  const item = planInput(source.id, winner);
  if (scoreReasons !== undefined) item.scoreReasons = scoreReasons;
  if (!editorial) delete item.editorialDecision;
  const plan = saveCurrentPlan(database, {
    planDate: '2026-08-29', timezone: 'Asia/Shanghai', summary: 'WMB-5364 边界测试', items: [item],
  });
  return database.prepare('SELECT id, revision, planning_status AS planningStatus FROM plan_items WHERE plan_id=?').get(plan.id);
}

test('WMB-5364 legacy v1 score never produces a current propagation grade', () => {
  assert.equal(resolvePropagationGrade({
    planning_status: 'approved',
    score_reasons_json: JSON.stringify(LEGACY_SCORE),
  }), '待评分');
});

test('WMB-5364 rejects a truth-gate claim that cites a source outside the plan', async () => {
  await withDb(async (database) => {
    const source = upsertSource(database, {
      originalUrl: 'https://example.com/wmb-5364-plan-source',
      title: '计划真实来源',
      summary: '该来源属于当前选题。',
    });
    const item = planInput(source.id);
    item.scoreReasons = scoredReasons(80, NOW.toISOString());
    item.scoreReasons.truthGate.claims = [{
      text: '国产芯片已经承载该公共服务',
      type: 'fact',
      status: 'supported',
      sourceIds: ['forged-source-id'],
    }];

    assert.throws(
      () => saveCurrentPlan(database, {
        planDate: '2026-08-29', timezone: 'Asia/Shanghai', summary: '伪造 claim 来源复现', items: [item],
      }),
      (error) => error?.code === 'validation_failed' && error?.errors?.includes('truth_gate_source_out_of_scope'),
    );
  });
});

test('WMB-5364 approval fails closed when a cited plan source was archived after scoring', async () => {
  await withDb(async (database) => {
    const item = createPlan(database);
    const sourceId = JSON.parse(database.prepare('SELECT source_ids_json FROM plan_items WHERE id=?').get(item.id).source_ids_json)[0];
    database.prepare("UPDATE source_items SET management_status='archived', revision=revision+1 WHERE id=?").run(sourceId);

    assert.throws(
      () => approvePlanItemAndCreateProject(database, {
        planItemId: item.id,
        expectedRevision: item.revision,
        by: 'owner',
        now: NOW,
      }),
      (error) => error?.code === 'validation_failed' && error?.errors?.includes('source_unavailable'),
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM content_projects WHERE plan_item_id=?').get(item.id).count, 0);
  });
});

test('WMB-5364 targeted Planner submission rejects an out-of-plan truth-gate source', async () => {
  await withDb(async (database) => {
    const source = upsertSource(database, {
      originalUrl: 'https://example.com/wmb-5364-targeted-source',
      title: '定向策划真实来源',
      summary: '用于验证单项提交来源边界。',
    });
    const draft = createPlanningDraftFromTarget(database, {
      title: 'GLM 定向策划草稿', sourceIds: [source.id], planDate: '2026-08-29',
    });
    const item = planInput(source.id);
    item.scoreReasons = scoredReasons(80, NOW.toISOString());
    item.scoreReasons.truthGate.claims = [{
      text: '国产芯片已经承载该公共服务', type: 'fact', status: 'supported', sourceIds: ['forged-source-id'],
    }];

    assert.throws(
      () => submitPlanItemForReview(database, {
        planItemId: draft.planItemId, expectedRevision: draft.revision, item, by: 'planner',
      }),
      (error) => error?.code === 'validation_failed' && error?.errors?.includes('truth_gate_source_out_of_scope'),
    );
    assert.equal(database.prepare('SELECT planning_status FROM plan_items WHERE id=?').get(draft.planItemId).planning_status, 'draft');
  });
});

test('WMB-5364 snake-case score aliases cannot bypass truth-gate source validation', async () => {
  await withDb(async (database) => {
    const source = upsertSource(database, {
      originalUrl: 'https://example.com/wmb-5364-snake-score', title: '蛇形评分来源', summary: '真实计划来源。',
    });
    const item = planInput(source.id);
    const score = scoredReasons(80, NOW.toISOString());
    score.truthGate.claims = [{ text: '伪造事实', type: 'fact', status: 'supported', sourceIds: ['forged-source-id'] }];
    delete item.scoreReasons;
    item.score_reasons_json = JSON.stringify(score);

    assert.throws(
      () => saveCurrentPlan(database, {
        planDate: '2026-08-29', timezone: 'Asia/Shanghai', summary: '蛇形评分旁路复现', items: [item],
      }),
      (error) => error?.code === 'validation_failed' && error?.errors?.includes('truth_gate_source_out_of_scope'),
    );
  });
});

test('WMB-5364 an unscored draft cannot cite an archived source', async () => {
  await withDb(async (database) => {
    const source = upsertSource(database, {
      originalUrl: 'https://example.com/wmb-5364-archived-draft', title: '归档来源', summary: '即将归档。',
    });
    database.prepare("UPDATE source_items SET management_status='archived' WHERE id=?").run(source.id);
    const item = planInput(source.id);
    delete item.scoreReasons;
    delete item.editorialDecision;

    assert.throws(
      () => saveCurrentPlan(database, {
        planDate: '2026-08-29', timezone: 'Asia/Shanghai', summary: '无评分归档来源复现', items: [item],
      }),
      (error) => error?.code === 'validation_failed' && error?.errors?.includes('source_unavailable'),
    );
  });
});

test('WMB-5364 targeted submission persists the same normalized source_ids_json it validated', async () => {
  await withDb(async (database) => {
    const source = upsertSource(database, {
      originalUrl: 'https://example.com/wmb-5364-source-json', title: 'JSON 来源', summary: '用于字段别名回归。',
    });
    const draft = createPlanningDraftFromTarget(database, {
      title: '字段别名草稿', sourceIds: [source.id], planDate: '2026-08-29',
    });
    const item = planInput(source.id);
    delete item.sourceIds;
    item.source_ids_json = JSON.stringify([source.id]);
    const submitted = submitPlanItemForReview(database, {
      planItemId: draft.planItemId, expectedRevision: draft.revision, item, by: 'planner',
    });

    assert.equal(submitted.planningStatus, 'ready_for_review');
    assert.deepEqual(JSON.parse(database.prepare('SELECT source_ids_json FROM plan_items WHERE id=?').get(draft.planItemId).source_ids_json), [source.id]);
  });
});

test('WMB-5364 direct approval transition cannot bypass source availability checks', async () => {
  await withDb(async (database) => {
    const item = createPlan(database);
    const sourceId = JSON.parse(database.prepare('SELECT source_ids_json FROM plan_items WHERE id=?').get(item.id).source_ids_json)[0];
    database.prepare("UPDATE source_items SET management_status='archived' WHERE id=?").run(sourceId);

    assert.throws(
      () => transitionPlanItem(database, {
        planItemId: item.id, expectedRevision: item.revision, expectedStatus: 'ready_for_review', toStatus: 'approved', by: 'owner',
      }),
      (error) => error?.code === 'validation_failed' && error?.errors?.includes('source_unavailable'),
    );
    assert.equal(database.prepare('SELECT planning_status FROM plan_items WHERE id=?').get(item.id).planning_status, 'ready_for_review');
  });
});

test('WMB-5364 approval fails closed when a cited source loses its canonical URL after scoring', async () => {
  await withDb(async (database) => {
    const item = createPlan(database);
    const sourceId = JSON.parse(database.prepare('SELECT source_ids_json FROM plan_items WHERE id=?').get(item.id).source_ids_json)[0];
    database.prepare("UPDATE source_items SET canonical_url='', revision=revision+1 WHERE id=?").run(sourceId);

    assert.throws(
      () => approvePlanItemAndCreateProject(database, {
        planItemId: item.id, expectedRevision: item.revision, by: 'owner', now: NOW,
      }),
      (error) => error?.code === 'validation_failed' && error?.errors?.includes('source_canonical_url_required'),
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM content_projects WHERE plan_item_id=?').get(item.id).count, 0);
  });
});

test('WMB-5364 plan-bound content creation requires an approved item and thesis lock', async () => {
  await withDb(async (database) => {
    const draft = createPlan(database);
    assert.throws(
      () => assertPlanItemContentCreateAllowed(database, draft.id),
      (error) => error?.code === 'PLAN_ITEM_NOT_APPROVED',
    );

    const approvedWithoutLock = createPlan(database, { winner: '第二个不同的产业主张，避免计划内重复。' });
    const transitioned = transitionPlanItem(database, {
      planItemId: approvedWithoutLock.id,
      expectedRevision: approvedWithoutLock.revision,
      expectedStatus: 'ready_for_review',
      toStatus: 'approved',
      by: 'owner',
    });
    assert.equal(transitioned.id, approvedWithoutLock.id);
    assert.throws(
      () => assertPlanItemContentCreateAllowed(database, approvedWithoutLock.id),
      (error) => error?.code === 'THESIS_LOCK_REQUIRED',
    );
  });
});

test('WMB-5364 Writer cannot save or complete content that drops the locked thesis', async () => {
  await withDb(async (database) => {
    const item = createPlan(database);
    database.exec('BEGIN IMMEDIATE');
    const approved = approvePlanItemAndCreateProject(database, {
      planItemId: item.id,
      expectedRevision: item.revision,
      by: 'owner',
      now: NOW,
    });
    database.exec('COMMIT');

    const offTopic = '本文只讨论免费额度和调用成本，不讨论国产算力商业化。';
    const saved = saveCoreVersion(database, {
      projectId: approved.projectId,
      body: offTopic,
      expectedRevision: approved.projectRevision,
    });
    assert.equal(saved.ok, false);
    assert.equal(saved.error.code, 'THESIS_LOCK_VIOLATION');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM content_versions WHERE project_id=?').get(approved.projectId).count, 1);

    const completed = updateContentProject(database, {
      projectId: approved.projectId,
      expectedRevision: approved.projectRevision,
      status: 'completed',
    });
    assert.equal(completed.ok, true, 'the valid initial version remains completable');
  });
});
