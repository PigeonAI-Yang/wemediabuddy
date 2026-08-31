import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const { migrateDatabase } = await import("../src/main/db/migrations.ts");
const {
  buildDailyOrchestrationActorIntent,
  getDailyOrchestrationSchedule,
  orchestrateDailyContent,
  setDailyOrchestrationSchedule,
} = await import("../src/main/daily-orchestration.ts");
const { createProductionDailyHandlers } = await import('../src/main/daily-orchestration.ts');
const { getNextShanghaiTickMs } =
  await import("../src/main/daily-orchestration-scheduler.ts");

async function withDatabase(work) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmb5337-cutover-"));
  const database = migrateDatabase(path.join(directory, "wmb.db"));
  database
    .prepare(
      "INSERT INTO app_meta (key,value,created_at,updated_at,revision) VALUES ('workspace_id',?,'2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)",
    )
    .run("ws-5337");
  try {
    return await work(database);
  } finally {
    database.close();
    fs.rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
}

test("WMB-5337 legacy orchestration fails closed with an exact Actor intent for every producer", async () => {
  await withDatabase(async (database) => {
    const cases = [
      ["today", "today.daily-orchestration", "owner"],
      ["mcp", "mcp.daily-orchestrate", "owner"],
      ["scheduler", "scheduler.daily-0900", "scheduler"],
    ];
    for (const [source, producerId, rootMode] of cases) {
      await assert.rejects(
        orchestrateDailyContent({
          database,
          businessDate: "2026-08-22",
          workspaceId: "ws-5337",
          source,
        }),
        (error) => {
          assert.equal(error.code, "CUTOVER_REQUIRED");
          assert.equal(
            error.nextAction.kind,
            "submitWorkspaceOrchestratorIntent",
          );
          assert.equal(error.nextAction.producerId, producerId);
          assert.equal(error.nextAction.action, "stage_d");
          assert.equal(error.nextAction.rootMode, rootMode);
          assert.equal(error.nextAction.businessDate, "2026-08-22");
          assert.equal(error.nextAction.logicalInput.workspaceId, "ws-5337");
          return true;
        },
      );
    }
  });
});

test('Stage D advances only current-day explicitly Owner-approved plan items', async () => {
  await withDatabase(async (database) => {
    const now = '2026-09-01T00:00:00Z';
    const insertPlan = database.prepare(`INSERT INTO plans (id, plan_date, timezone, summary, is_current, created_at, updated_at, revision) VALUES (?, ?, 'Asia/Shanghai', ?, 1, ?, ?, 1)`);
    const insertItem = database.prepare(`
      INSERT INTO plan_items (
        id, plan_id, topic_id, title, priority, why_now, timeliness, target_audience, angle, point_of_view,
        platforms_json, formats_json, title_guidance, opening_guidance, structure_guidance, effort_estimate,
        source_ids_json, available_materials_json, missing_materials_json, review_ids_json, method_finding_ids_json,
        sort_order, created_at, updated_at, revision, score_reasons_json, planning_status, planning_provenance_json
      ) VALUES (?, ?, NULL, ?, 0, 'why', 'today', 'audience', 'angle', 'pov', '[]', '[]', '', '', '', '', '[]', '[]', '[]', '[]', '[]', 0, ?, ?, 1, '{}', 'approved', ?)
    `);
    insertPlan.run('plan-today', '2026-09-01', 'today', now, now);
    insertPlan.run('plan-old', '2026-08-31', 'old', now, now);
    const ownerProvenance = JSON.stringify({
      origin: 'daily_judge',
      transitions: [{ from: 'ready_for_review', to: 'approved', by: 'owner_ui', at: now }],
    });
    const systemProvenance = JSON.stringify({
      origin: 'migration',
      legacy: 'legacy_approved',
      transitions: [{ from: null, to: 'approved', by: 'system', at: now }],
    });
    insertItem.run('today-owner', 'plan-today', 'today owner', now, now, ownerProvenance);
    insertItem.run('today-system', 'plan-today', 'today system', now, now, systemProvenance);
    insertItem.run('old-owner', 'plan-old', 'old owner', now, now, ownerProvenance);

    const advanced = [];
    const handlers = createProductionDailyHandlers({
      advanceApprovedPlanItem: (_database, planItemId) => {
        advanced.push(planItemId);
        return { role: 'reporter', reusedJob: false, reusedProject: false };
      },
    });
    const result = await handlers.stageD(database, '2026-09-01');
    assert.deepEqual(advanced, ['today-owner']);
    assert.equal(result.status, 'completed');
    assert.equal(result.count, 1);
  });
});

test("WMB-5337 Actor intent identity is deterministic and source-bound", () => {
  const today = buildDailyOrchestrationActorIntent({
    businessDate: "2026-08-22",
    workspaceId: "ws-5337",
    source: "today",
  });
  const replay = buildDailyOrchestrationActorIntent({
    businessDate: "2026-08-22",
    workspaceId: "ws-5337",
    source: "today",
  });
  const scheduler = buildDailyOrchestrationActorIntent({
    businessDate: "2026-08-22",
    workspaceId: "ws-5337",
    source: "scheduler",
  });
  assert.deepEqual(replay, today);
  assert.notEqual(scheduler.requestId, today.requestId);
  assert.equal(scheduler.rootMode, "scheduler");
  assert.equal(today.rootMode, "owner");
  assert.doesNotMatch(JSON.stringify(today), /publication|publish/i);
});

test("WMB-5337 scheduler keeps Asia/Shanghai timing and persisted toggle", async () => {
  await withDatabase((database) => {
    assert.deepEqual(getDailyOrchestrationSchedule(database), {
      time: "09:00",
      autoEnabled: true,
    });
    assert.deepEqual(
      setDailyOrchestrationSchedule(database, {
        time: "07:30",
        autoEnabled: false,
      }),
      { time: "07:30", autoEnabled: false },
    );
    assert.deepEqual(
      setDailyOrchestrationSchedule(database, { autoEnabled: true }),
      { time: "07:30", autoEnabled: true },
    );
    assert.equal(
      getNextShanghaiTickMs(Date.UTC(2026, 7, 21, 22, 0, 0), "09:00"),
      Date.UTC(2026, 7, 22, 1, 0, 0),
    );
    assert.equal(
      getNextShanghaiTickMs(Date.UTC(2026, 7, 22, 2, 0, 0), "09:00"),
      Date.UTC(2026, 7, 23, 1, 0, 0),
    );
  });
});
