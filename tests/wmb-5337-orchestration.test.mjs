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
