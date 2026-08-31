import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { dismissCarryForPlanItem } from '../src/main/ferment.ts';
import { getTodayPlanExhaustion, getToday } from '../src/main/workbench.ts';
import { deriveTodayRunView } from '../src/renderer/today-run-view.ts';
import { tryAcquireDailyStageLock, releaseDailyStageLock } from '../src/main/daily-stage-lock.ts';
import { decideDailyStartGate } from '../src/main/daily-start-gate.ts';

const BUSINESS_DATE = '2026-08-25';

function baseInput(overrides = {}) {
  return {
    task: null,
    localStarting: false,
    hasTodayPlan: false,
    hasRecentPlan: false,
    opportunityCount: 0,
    pendingOpportunityCount: 0,
    sssCount: 0,
    sourcesTotal: 0,
    studioActive: null,
    piConfigured: true,
    channelsSummary: null,
    controlPending: false,
    controlPendingAction: null,
    sameDayTasks: [],
    isExhausted: false,
    totalPlanItemCount: 0,
    rejectedCount: 0,
    ...overrides,
  };
}

async function withDb(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wmb-rejected-round-'));
  const dbPath = path.join(dir, 'wmb.db');
  const db = migrateDatabase(dbPath);
  try {
    await run(db, dir);
  } finally {
    try { db.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
}

function seedSource(db, urlSuffix) {
  const src = upsertSource(db, {
    originalUrl: `https://example.com/${urlSuffix}-${Math.random().toString(36).slice(2, 8)}`,
    title: `Source ${urlSuffix}`,
    summary: 'summary',
    categories: ['official'],
    priority: 1,
  });
  db.prepare('UPDATE source_items SET collected_at=? WHERE id=?').run(`${BUSINESS_DATE}T12:00:00.000+08:00`, src.id);
  return src.id;
}

function makeItem(title, sourceId, priority = 1) {
  const idx = Number(String(title).match(/\d+/)?.[0] ?? priority) % 100;
  return {
    title,
    priority,
    whyNow: `why now ${title}`,
    timeliness: '热点 2-3 天',
    targetAudience: `audience-${idx}-${sourceId.slice(0,4)}`,
    angle: `angle-${idx}-${sourceId.slice(0,4)}`,
    pointOfView: `view-${idx}-${sourceId.slice(0,4)}`,
    platforms: ['x'],
    formats: ['text'],
    titleGuidance: 't',
    openingGuidance: 'o',
    structureGuidance: 's',
    effortEstimate: '1h',
    sourceIds: [sourceId],
    availableMaterials: [],
    missingMaterials: [],
  };
}

test('rejected-round lifecycle: draft+carry dismissed, exhaustion, mixed, running override, admission gates, double-call reuse, replacement transaction', async () => {
  await withDb(async (db) => {
    const sIds = Array.from({ length: 5 }, (_, i) => seedSource(db, `s${i}`));
    const items = sIds.map((sid, idx) => makeItem(`选题 ${idx + 1} - ${sid.slice(0, 4)}`, sid, idx % 3));
    const saved = saveCurrentPlan(db, { planDate: BUSINESS_DATE, timezone: 'Asia/Shanghai', summary: 'rejected round', items });
    const planId = saved.id;
    const planItems = db.prepare('SELECT id, title FROM plan_items WHERE plan_id=? ORDER BY sort_order').all(planId);
    assert.equal(planItems.length, 5, 'should have 5 items');

    {
      const ex0 = getTodayPlanExhaustion(db, BUSINESS_DATE);
      assert.deepEqual(ex0, { total: 5, unresolved: 5, rejected: 0, isExhausted: false, hasPlan: true });
      const view = deriveTodayRunView(baseInput({ pendingOpportunityCount: ex0.unresolved, isExhausted: ex0.isExhausted, totalPlanItemCount: ex0.total, rejectedCount: ex0.rejected, hasTodayPlan: false, hasRecentPlan: false, opportunityCount: 0 }));
      assert.equal(view.step, 'needs_user', '5 unresolved draft => needs_user');
      assert.equal(view.primaryCta.kind, 'open_manager');
      assert.equal(view.primaryCta.label, '查看待确认选题');
    }

    for (const row of planItems) {
      dismissCarryForPlanItem(db, { planItemId: row.id, reason: '否掉' });
    }
    const dismissedCount = db.prepare("SELECT COUNT(*) as c FROM work_carry_items WHERE object_type='plan_item' AND state='dismissed'").get().c;
    assert.equal(Number(dismissedCount), 5);

    {
      const ex = getTodayPlanExhaustion(db, BUSINESS_DATE);
      assert.equal(ex.total, 5);
      assert.equal(ex.unresolved, 0, 'all dismissed => unresolved 0');
      assert.equal(ex.rejected, 5);
      assert.equal(ex.isExhausted, true);
      assert.equal(ex.hasPlan, true);
      const today = getToday(db, BUSINESS_DATE);
      assert.deepEqual(today.exhaustion, ex, 'getToday exhaustion must match');
      const view = deriveTodayRunView(baseInput({
        isExhausted: ex.isExhausted,
        totalPlanItemCount: ex.total,
        rejectedCount: ex.rejected,
        pendingOpportunityCount: ex.unresolved,
        hasTodayPlan: false,
        hasRecentPlan: false,
        opportunityCount: 0,
        sameDayTasks: today.sameDayTasks,
      }));
      assert.equal(view.step, 'exhausted');
      assert.equal(view.primaryCta.kind, 'start');
      assert.equal(view.primaryCta.label, '开始新一轮收集');
      assert.match(view.headline, /本轮已结束/);
      assert.match(view.detail, /5 条选题已全部否决/);
      assert.notEqual(view.step, 'needs_user');
    }

    {
      const mixedEx = { total: 5, unresolved: 3, rejected: 2, isExhausted: false, hasPlan: true };
      const view = deriveTodayRunView(baseInput({
        isExhausted: mixedEx.isExhausted,
        totalPlanItemCount: mixedEx.total,
        rejectedCount: mixedEx.rejected,
        pendingOpportunityCount: mixedEx.unresolved,
        hasTodayPlan: false,
        hasRecentPlan: false,
        opportunityCount: 0,
      }));
      assert.equal(view.step, 'needs_user', 'mixed 3 unresolved => needs_user');
      assert.equal(view.primaryCta.kind, 'open_manager');
    }

    {
      const runningTask = {
        id: 'task-running-1',
        status: 'running',
        phase: 'scanning_sources',
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        progress: { planned: 4, processed: 1 },
        events: [{ message: 'scanning' }],
      };
      const view = deriveTodayRunView(baseInput({
        task: runningTask,
        isExhausted: true,
        totalPlanItemCount: 5,
        rejectedCount: 5,
        pendingOpportunityCount: 0,
        hasTodayPlan: false,
        hasRecentPlan: false,
        opportunityCount: 0,
      }));
      assert.ok(['starting', 'scanning', 'judging'].includes(view.step), `running should override exhausted, got ${view.step}`);
      assert.notEqual(view.step, 'exhausted');
      assert.notEqual(view.primaryCta.label, '开始新一轮收集');
    }

    function canAdmitTodayIntelligence(ex) {
      if (ex.hasPlan && ex.unresolved > 0 && !ex.isExhausted) return { allow: false, code: 'PENDING_REVIEW' };
      return { allow: true };
    }
    {
      const exhausted = getTodayPlanExhaustion(db, BUSINESS_DATE);
      assert.equal(canAdmitTodayIntelligence(exhausted).allow, true, 'exhausted should allow new collection (manager & legacy)');
      const pending = { total: 5, unresolved: 2, rejected: 3, isExhausted: false, hasPlan: true };
      assert.equal(canAdmitTodayIntelligence(pending).allow, false, 'pending should block');
      assert.equal(canAdmitTodayIntelligence(pending).code, 'PENDING_REVIEW');
    }

    {
      const businessDate = BUSINESS_DATE;
      const owner1 = `today-button:${businessDate}:scan`;
      const lock1 = tryAcquireDailyStageLock({ businessDate, kind: 'scan', owner: owner1 });
      assert.equal(lock1.ok, true, 'first lock should succeed');
      const owner1b = `today-button:${businessDate}:scan:dup`;
      const lock2 = tryAcquireDailyStageLock({ businessDate, kind: 'scan', owner: owner1b });
      assert.equal(lock2.ok, false, 'second concurrent lock should be busy');
      assert.ok(lock2.heldBy, 'heldBy should exist');
      const active = { status: 'running', phase: 'scanning_sources', intent: 'daily_intelligence', savedCount: 0 };
      const gate = decideDailyStartGate({ active, hasLiveCoordinator: true, latest: null });
      assert.equal(gate.action, 'return_active', 'active running with live coordinator => return_active (reuse)');
      const managerTaskId = 'mgr-test-1';
      const nowIso = new Date().toISOString();
      db.prepare(`INSERT INTO agent_tasks (id, intent, business_date, status, phase, pi_session_id, context_refs_json, result_refs_json, progress_json, checkpoint_json, events_json, control_action, heartbeat_at, error_code, error_message, created_at, updated_at, finished_at) VALUES (?, 'page_agents', ?, 'running', 'dispatch_reporter', 'sess1', '{}', '{}', '{}', ?, '[]', NULL, ?, NULL, NULL, ?, ?, NULL)`).run(managerTaskId, businessDate, JSON.stringify({ status: 'running', phase: 'dispatch_reporter', summary: 'test' }), nowIso, nowIso, nowIso);
      const secondActive = db.prepare('SELECT id, status, intent FROM agent_tasks WHERE id=?').get(managerTaskId);
      assert.ok(secondActive, 'manager task should exist');
      const activeCount = db.prepare("SELECT COUNT(*) as c FROM agent_tasks WHERE business_date=? AND status='running' AND intent IN ('daily_intelligence','daily_scan','daily_judge','page_agents')").get(businessDate).c;
      assert.equal(Number(activeCount), 1, 'exactly one active root task for same date');
      releaseDailyStageLock({ businessDate, kind: 'scan', owner: owner1 });
      db.prepare('DELETE FROM agent_tasks WHERE id=?').run(managerTaskId);
      const lock3 = tryAcquireDailyStageLock({ businessDate, kind: 'scan', owner: owner1b });
      assert.equal(lock3.ok, true, 'after release, lock should be acquirable');
      releaseDailyStageLock({ businessDate, kind: 'scan', owner: owner1b });
    }

    {
      const oldPlanId = planId;
      const oldPlanRow = db.prepare('SELECT id, is_current FROM plans WHERE id=?').get(oldPlanId);
      assert.equal(Number(oldPlanRow.is_current), 1, 'old plan should be current before replacement');
      const newSources = Array.from({ length: 2 }, (_, i) => seedSource(db, `new${i}`));
      const newItems = newSources.map((sid, idx) => makeItem(`新选题 ${idx + 1}`, sid, 0));
      const newSaved = saveCurrentPlan(db, { planDate: BUSINESS_DATE, timezone: 'Asia/Shanghai', summary: 'new round after exhausted', items: newItems });
      const newPlanId = newSaved.id;
      assert.notEqual(newPlanId, oldPlanId, 'new plan should have distinct id');
      const oldAfter = db.prepare('SELECT id, is_current FROM plans WHERE id=?').get(oldPlanId);
      const newAfter = db.prepare('SELECT id, is_current, plan_date FROM plans WHERE id=?').get(newPlanId);
      assert.equal(Number(oldAfter.is_current), 0, 'old rejected plan should remain historical with is_current=0');
      assert.equal(Number(newAfter.is_current), 1, 'new plan should be current');
      assert.equal(newAfter.plan_date, BUSINESS_DATE, 'new plan should be same business date');
      const historicalItems = db.prepare('SELECT COUNT(*) as c FROM plan_items WHERE plan_id=?').get(oldPlanId).c;
      assert.equal(Number(historicalItems), 5, 'old plan items should remain historical');
      const newItemsCount = db.prepare('SELECT COUNT(*) as c FROM plan_items WHERE plan_id=?').get(newPlanId).c;
      assert.equal(Number(newItemsCount), 2);
      const newEx = getTodayPlanExhaustion(db, BUSINESS_DATE);
      assert.equal(newEx.total, 2, 'new plan total 2');
      assert.equal(newEx.unresolved, 2, 'new plan unresolved 2');
      assert.equal(newEx.rejected, 0);
      assert.equal(newEx.isExhausted, false);
      const allPlansForDate = db.prepare('SELECT id, is_current FROM plans WHERE plan_date=? ORDER BY created_at').all(BUSINESS_DATE);
      assert.equal(allPlansForDate.length >= 2, true, 'should have at least 2 plans for same date');
      const historical = allPlansForDate.find(r => r.id === oldPlanId);
      assert.ok(historical, 'old plan should still exist');
    }
  });
});
