import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const { migrateDatabase } = await import("../src/main/db/migrations.ts");
const {
  getDailyOrchestrationSchedule,
  setDailyOrchestrationSchedule,
  createProductionDailyHandlers,
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


test('Stage D reports production ownership without advancing approved plans', async () => {
  await withDatabase(async (database) => {
    const handlers = createProductionDailyHandlers();
    const result = await handlers.stageD(database, '2026-09-01');
    assert.equal(result.status, 'skipped');
    assert.equal(result.count, 0);
    assert.match(result.detail, /方案批准与自动调查/);
  });
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
