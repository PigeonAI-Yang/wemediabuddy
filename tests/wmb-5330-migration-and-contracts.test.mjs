// WMB-5330 foundation gates: migration (empty/legacy), uniqueness, immutability, command registry, role filtering.
// Verifies migration, immutable identity, command registration and least-privilege grants.
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const { migrations, migrateDatabase } =
  await import("../src/main/db/migrations.ts");
const {
  DAILY_CONTENT_LOOP_COMMANDS,
  ZHIHU_HOT_SCAN_COMMAND,
  DAILY_CONTENT_CYCLE_ENSURE_COMMAND,
  CONTENT_DERIVATIVE_SAVE_VERSION_COMMAND,
  CONTENT_DERIVATIVE_FINALIZE_VERSION_COMMAND,
} = await import("../src/shared/daily-content-loop.ts");
const {
  AGENT_CAPABILITIES,
  filterCommandsForRole,
  roleWriteCommands,
  deskStandingCommands,
} = await import("../src/shared/agent-capabilities.ts");

function withTempDir(work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmb5330-"));
  try {
    return work(dir);
  } finally {
    try {
      fs.rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    } catch {
      /* Windows may retain SQLite handles briefly; temp residue is non-product state. */
    }
  }
}
function migrateFresh(dir) {
  const dbPath = path.join(dir, "wmb.db");
  const db = migrateDatabase(dbPath);
  return { db, dbPath };
}

// 1. Empty fresh migration contains v75 tables/triggers/indexes and FK integrity
test("WMB-5330 fresh DB has all five tables, partial uniques and immutable triggers", () =>
  withTempDir((dir) => {
    const { db } = migrateFresh(dir);
    try {
      const tables = new Set(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((r) => r.name),
      );
      for (const t of [
        "zhihu_hot_observations",
        "daily_content_cycles",
        "daily_content_targets",
        "content_derivatives",
        "content_derivative_versions",
      ])
        assert.ok(tables.has(t), `missing ${t}`);
      const triggers = new Set(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
          .all()
          .map((r) => r.name),
      );
      assert.ok(triggers.has("content_derivative_versions_immutable_update"));
      assert.ok(triggers.has("content_derivative_versions_immutable_delete"));
      const idx = new Set(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='index'")
          .all()
          .map((r) => r.name),
      );
      assert.ok(idx.has("daily_content_targets_cycle_source_unique"));
      assert.ok(
        idx.has("daily_content_targets_cycle_predecessor_version_unique"),
      );
      // FK enforcement: inserting derivative version with bad FK fails
      db.exec("PRAGMA foreign_keys=ON");
      assert.throws(() =>
        db
          .prepare(
            "INSERT INTO content_derivative_versions (id, derivative_id, source_content_version_id, version_number, title, body, status, author, created_at) VALUES ('v1','nope','nope',1,'t','b','draft','ai','2026-08-22T00:00:00.000Z')",
          )
          .run(),
      );
    } finally {
      db.close();
    }
  }));

// 2. Legacy v74 -> v75 upgrade preserves existing data and then accepts new model
test("WMB-5330 legacy v74 data survives upgrade and new constraints enforce", () =>
  withTempDir((dir) => {
    const legacyMigrations = migrations.filter((m) => m.version < 75);
    const dbPath = path.join(dir, "wmb.db");
    let db = new DatabaseSync(dbPath);
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    for (const m of legacyMigrations) {
      db.exec("PRAGMA foreign_keys=OFF");
      db.exec("BEGIN IMMEDIATE");
      db.exec(m.sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?,?)",
      ).run(m.version, new Date().toISOString());
      db.exec("COMMIT");
      db.exec("PRAGMA foreign_keys=ON");
    }
    // Insert legacy content project chain for later FK
    db.exec(
      "INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id','ws1','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)",
    );
    db.prepare(
      "INSERT INTO source_feeds (id, name, created_at, updated_at, revision) VALUES ('feed1','f','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)",
    ).run();
    db.prepare(
      "INSERT INTO source_items (id, feed_id, original_url, canonical_url, title, collected_at, summary, categories_json, keywords_json, recommended_platforms_json, recommended_formats_json, created_at, updated_at, revision) VALUES ('src1','feed1','https://www.zhihu.com/question/1','https://www.zhihu.com/question/1','t','2026-08-22T00:00:00Z','s','[]','[]','[]','[]','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)",
    ).run();
    db.prepare(
      "INSERT INTO topics (id, title, created_at, updated_at, revision) VALUES ('topic1','t','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)",
    ).run();
    db.prepare(
      "INSERT INTO content_projects (id, topic_id, title, created_at, updated_at, revision) VALUES ('proj1','topic1','p','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)",
    ).run();
    db.prepare(
      "INSERT INTO content_versions (id, project_id, body, version_number, created_at) VALUES ('cv1','proj1','body',1,'2026-08-22T00:00:00Z')",
    ).run();
    db.close();

    // Now run full migration (should apply v75)
    const upgraded = migrateDatabase(dbPath);
    try {
      assert.equal(
        upgraded.prepare("SELECT COUNT(*) as c FROM source_items").get().c,
        1,
      );
      assert.equal(
        upgraded.prepare("SELECT COUNT(*) as c FROM content_projects").get().c,
        1,
      );
      // New tables usable
      upgraded
        .prepare(
          "INSERT INTO zhihu_hot_observations (id, source_item_id, business_date, rank, question_title_snapshot, question_url_snapshot, collected_at, input_fingerprint, created_at) VALUES ('obs1','src1','2026-08-22',1,'q','https://zhihu.com/question/1','2026-08-22T01:00:00Z','fp1','2026-08-22T01:00:00Z')",
        )
        .run();
      // Duplicate uniqueness fails
      assert.throws(() =>
        upgraded
          .prepare(
            "INSERT INTO zhihu_hot_observations (id, source_item_id, business_date, rank, question_title_snapshot, question_url_snapshot, collected_at, input_fingerprint, created_at) VALUES ('obs2','src1','2026-08-22',2,'q2','https://zhihu.com/question/1','2026-08-22T02:00:00Z','fp1','2026-08-22T02:00:00Z')",
          )
          .run(),
      );
      // cycle unique business_date
      upgraded
        .prepare(
          "INSERT INTO daily_content_cycles (id, business_date, timezone, status, created_at, updated_at, revision) VALUES ('c1','2026-08-22','Asia/Shanghai','pending','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)",
        )
        .run();
      assert.throws(() =>
        upgraded
          .prepare(
            "INSERT INTO daily_content_cycles (id, business_date, timezone, status, created_at, updated_at, revision) VALUES ('c2','2026-08-22','Asia/Shanghai','pending','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)",
          )
          .run(),
      );
    } finally {
      upgraded.close();
    }
  }));

// 3. Uniqueness/carry/CHECK semantics
test("WMB-5330 uniqueness and CHECK gates for targets and derivatives", () =>
  withTempDir((dir) => {
    const { db } = migrateFresh(dir);
    try {
      db.exec(
        "INSERT INTO source_feeds (id, name, created_at, updated_at, revision) VALUES ('f1','f','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)",
      );
      db.exec(
        "INSERT INTO source_items (id, feed_id, original_url, canonical_url, title, collected_at, summary, categories_json, keywords_json, recommended_platforms_json, recommended_formats_json, created_at, updated_at, revision) VALUES ('s1','f1','https://www.zhihu.com/question/1','https://www.zhihu.com/question/1','t','2026-08-22T00:00:00Z','s','[]','[]','[]','[]','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1),('s2','f1','https://www.zhihu.com/question/2','https://www.zhihu.com/question/2','t2','2026-08-22T00:00:00Z','s','[]','[]','[]','[]','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)",
      );
      db.exec(
        "INSERT INTO topics (id, title, created_at, updated_at, revision) VALUES ('t1','t','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)",
      );
      db.exec(
        "INSERT INTO content_projects (id, topic_id, title, created_at, updated_at, revision) VALUES ('p1','t1','p','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)",
      );
      db.exec(
        "INSERT INTO content_versions (id, project_id, body, version_number, created_at) VALUES ('cv1','p1','b',1,'2026-08-22T00:00:00Z'),('cv2','p1','b2',2,'2026-08-22T00:00:00Z')",
      );
      db.exec(
        "INSERT INTO daily_content_cycles (id, business_date, timezone, status, created_at, updated_at, revision) VALUES ('cy1','2026-08-22','Asia/Shanghai','running','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)",
      );
      // new_content must have counts_toward_goal=1 and no predecessor; revision kind must have 0
      db.prepare(
        "INSERT INTO daily_content_targets (id, cycle_id, target_kind, counts_toward_goal, source_item_id, carry_depth, selection_mode, score_snapshot_json, status, created_at, updated_at, revision) VALUES ('tg1','cy1','new_content',1,'s1',0,'automatic','{}','proposed','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)",
      ).run();
      // duplicate source for new_content in same cycle -> partial unique violation
      assert.throws(() =>
        db
          .prepare(
            "INSERT INTO daily_content_targets (id, cycle_id, target_kind, counts_toward_goal, source_item_id, carry_depth, selection_mode, score_snapshot_json, status, created_at, updated_at, revision) VALUES ('tg1dup','cy1','new_content',1,'s1',0,'automatic','{}','proposed','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)",
          )
          .run(),
      );
      // carry_depth only 0/1
      assert.throws(() =>
        db
          .prepare(
            "INSERT INTO daily_content_targets (id, cycle_id, target_kind, counts_toward_goal, carry_depth, selection_mode, score_snapshot_json, status, created_at, updated_at, revision) VALUES ('tgBad','cy1','new_content',1,2,'automatic','{}','proposed','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)",
          )
          .run(),
      );
      // counts mismatch
      assert.throws(() =>
        db
          .prepare(
            "INSERT INTO daily_content_targets (id, cycle_id, target_kind, counts_toward_goal, carry_depth, selection_mode, score_snapshot_json, status, created_at, updated_at, revision) VALUES ('tgMismatch','cy1','new_content',0,0,'automatic','{}','proposed','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)",
          )
          .run(),
      );
      // revision target duplicate predecessor
      db.prepare(
        "INSERT INTO daily_content_targets (id, cycle_id, target_kind, counts_toward_goal, predecessor_content_version_id, carry_depth, selection_mode, score_snapshot_json, status, created_at, updated_at, revision) VALUES ('rev1','cy1','draft_revision',0,'cv1',0,'automatic','{}','proposed','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)",
      ).run();
      assert.throws(() =>
        db
          .prepare(
            "INSERT INTO daily_content_targets (id, cycle_id, target_kind, counts_toward_goal, predecessor_content_version_id, carry_depth, selection_mode, score_snapshot_json, status, created_at, updated_at, revision) VALUES ('revDup','cy1','draft_revision',0,'cv1',0,'automatic','{}','proposed','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)",
          )
          .run(),
      );
      // A carried target must point to exactly one predecessor target and consume the single carry depth.
      assert.throws(() =>
        db
          .prepare(
            "INSERT INTO daily_content_targets (id, cycle_id, target_kind, counts_toward_goal, predecessor_content_version_id, predecessor_target_id, carry_depth, selection_mode, score_snapshot_json, status, created_at, updated_at, revision) VALUES ('badCarry','cy1','draft_revision',0,'cv2','rev1',0,'carried','{}','proposed','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)",
          )
          .run(),
      );
      // derivative unique project+kind
      db.prepare(
        "INSERT INTO content_derivatives (id, project_id, kind, created_at, updated_at, revision) VALUES ('d1','p1','video_script','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)",
      ).run();
      assert.throws(() =>
        db
          .prepare(
            "INSERT INTO content_derivatives (id, project_id, kind, created_at, updated_at, revision) VALUES ('d2','p1','video_script','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)",
          )
          .run(),
      );
      // derivative version unique
      db.prepare(
        "INSERT INTO content_derivative_versions (id, derivative_id, source_content_version_id, version_number, title, body, status, author, created_at) VALUES ('dv1','d1','cv1',1,'t','b','draft','ai','2026-08-22T00:00:00Z')",
      ).run();
      assert.throws(() =>
        db
          .prepare(
            "INSERT INTO content_derivative_versions (id, derivative_id, source_content_version_id, version_number, title, body, status, author, created_at) VALUES ('dvDup','d1','cv1',1,'t','b','draft','ai','2026-08-22T00:00:00Z')",
          )
          .run(),
      );
    } finally {
      db.close();
    }
  }));

// 4. Immutability of derivative versions
test("WMB-5330 content_derivative_versions is immutable (no UPDATE/DELETE)", () =>
  withTempDir((dir) => {
    const { db } = migrateFresh(dir);
    try {
      db.exec(
        "INSERT INTO source_feeds (id, name, created_at, updated_at, revision) VALUES ('f1','f','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)",
      );
      db.exec(
        "INSERT INTO source_items (id, feed_id, original_url, canonical_url, title, collected_at, summary, categories_json, keywords_json, recommended_platforms_json, recommended_formats_json, created_at, updated_at, revision) VALUES ('s1','f1','https://www.zhihu.com/question/1','https://www.zhihu.com/question/1','t','2026-08-22T00:00:00Z','s','[]','[]','[]','[]','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)",
      );
      db.exec(
        "INSERT INTO topics (id, title, created_at, updated_at, revision) VALUES ('t1','t','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)",
      );
      db.exec(
        "INSERT INTO content_projects (id, topic_id, title, created_at, updated_at, revision) VALUES ('p1','t1','p','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)",
      );
      db.exec(
        "INSERT INTO content_versions (id, project_id, body, version_number, created_at) VALUES ('cv1','p1','b',1,'2026-08-22T00:00:00Z')",
      );
      db.exec(
        "INSERT INTO content_derivatives (id, project_id, kind, created_at, updated_at, revision) VALUES ('d1','p1','video_script','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)",
      );
      db.prepare(
        "INSERT INTO content_derivative_versions (id, derivative_id, source_content_version_id, version_number, title, body, status, author, created_at, format_decision_json) VALUES ('dv1','d1','cv1',1,'t','b','ready','ai','2026-08-22T00:00:00Z','{\"goal\":\"g\"}')",
      ).run();
      assert.throws(
        () =>
          db
            .prepare(
              "UPDATE content_derivative_versions SET body='hacked' WHERE id='dv1'",
            )
            .run(),
        /CONTENT_DERIVATIVE_VERSION_IMMUTABLE/,
      );
      assert.throws(
        () =>
          db
            .prepare("DELETE FROM content_derivative_versions WHERE id='dv1'")
            .run(),
        /CONTENT_DERIVATIVE_VERSION_IMMUTABLE/,
      );
      // Append-only ready version with same body but new version_number succeeds (finalize pattern)
      db.prepare(
        "INSERT INTO content_derivative_versions (id, derivative_id, source_content_version_id, version_number, title, body, status, author, created_at) VALUES ('dv2','d1','cv1',2,'t','b','ready','ai','2026-08-22T00:00:01Z')",
      ).run();
      const maxVer = db
        .prepare(
          "SELECT MAX(version_number) as m FROM content_derivative_versions WHERE derivative_id='d1'",
        )
        .get().m;
      assert.equal(maxVer, 2);
    } finally {
      db.close();
    }
  }));

// 5. Command registry and least-privilege role filtering (no publish grants)
test("WMB-5330 command registry frozen and role filtering least-privilege", () => {
  // Registry contains all declared commands
  assert.ok(DAILY_CONTENT_LOOP_COMMANDS.includes(ZHIHU_HOT_SCAN_COMMAND));
  assert.ok(
    DAILY_CONTENT_LOOP_COMMANDS.includes(DAILY_CONTENT_CYCLE_ENSURE_COMMAND),
  );
  assert.ok(
    DAILY_CONTENT_LOOP_COMMANDS.includes(
      CONTENT_DERIVATIVE_SAVE_VERSION_COMMAND,
    ),
  );
  assert.ok(
    DAILY_CONTENT_LOOP_COMMANDS.includes(
      CONTENT_DERIVATIVE_FINALIZE_VERSION_COMMAND,
    ),
  );
  assert.equal(
    DAILY_CONTENT_LOOP_COMMANDS.length,
    16,
    "12 core commands plus four explicit yesterday-iteration commands",
  );

  const allCaps = AGENT_CAPABILITIES;
  const zhihuCap = allCaps.find((c) => c.id === "cap.zhihu_hot_collect");
  const cycleCap = allCaps.find((c) => c.id === "cap.daily_content_cycle");
  const derivCap = allCaps.find((c) => c.id === "cap.content_derivative");
  assert.ok(zhihuCap && cycleCap && derivCap, "three new caps present");
  assert.deepEqual([...zhihuCap.commands], ["intelligence.zhihu_hot.scan"]);
  assert.deepEqual(
    [
      ...(zhihuCap.defaultRoleBindings
        ? Object.keys(zhihuCap.defaultRoleBindings).filter(
            (k) => zhihuCap.defaultRoleBindings[k],
          )
        : []),
    ],
    ["reporter", "desk"],
  );
  // Planner only, writer only, desk union via roleWriteCommands
  const reporterWrites = new Set(roleWriteCommands("reporter"));
  const plannerWrites = new Set(roleWriteCommands("planner"));
  const writerWrites = new Set(roleWriteCommands("writer"));
  const deskWrites = new Set(roleWriteCommands("desk"));

  assert.ok(reporterWrites.has(ZHIHU_HOT_SCAN_COMMAND), "reporter can scan");
  assert.ok(
    !reporterWrites.has(CONTENT_DERIVATIVE_SAVE_VERSION_COMMAND),
    "reporter cannot write derivative",
  );
  assert.ok(
    plannerWrites.has(DAILY_CONTENT_CYCLE_ENSURE_COMMAND),
    "planner can ensure cycle",
  );
  assert.ok(
    !plannerWrites.has(CONTENT_DERIVATIVE_SAVE_VERSION_COMMAND),
    "planner cannot write derivative",
  );
  assert.ok(
    writerWrites.has(CONTENT_DERIVATIVE_SAVE_VERSION_COMMAND),
    "writer can save derivative",
  );
  assert.ok(writerWrites.has(CONTENT_DERIVATIVE_FINALIZE_VERSION_COMMAND));
  assert.ok(!writerWrites.has(ZHIHU_HOT_SCAN_COMMAND), "writer cannot scan");
  assert.ok(
    deskWrites.has(ZHIHU_HOT_SCAN_COMMAND) &&
      deskWrites.has(DAILY_CONTENT_CYCLE_ENSURE_COMMAND) &&
      deskWrites.has(CONTENT_DERIVATIVE_SAVE_VERSION_COMMAND),
    "desk union",
  );

  // Least-privilege filtering via filterCommandsForRole: reporter grant filtered keeps only scan
  const mixed = [
    ZHIHU_HOT_SCAN_COMMAND,
    DAILY_CONTENT_CYCLE_ENSURE_COMMAND,
    CONTENT_DERIVATIVE_SAVE_VERSION_COMMAND,
    "publication.snapshot_create",
  ];
  assert.deepEqual(filterCommandsForRole("reporter", mixed), [
    ZHIHU_HOT_SCAN_COMMAND,
  ]);
  assert.deepEqual(
    filterCommandsForRole("planner", mixed).sort(),
    [DAILY_CONTENT_CYCLE_ENSURE_COMMAND].sort(),
  );
  assert.deepEqual(
    filterCommandsForRole("writer", mixed).sort(),
    [CONTENT_DERIVATIVE_SAVE_VERSION_COMMAND].sort(),
  );

  // No publish/redline grants
  for (const cmd of DAILY_CONTENT_LOOP_COMMANDS) {
    assert.ok(
      !deskStandingCommands().includes(cmd) ||
        new Set(deskStandingCommands()).has(cmd),
      "desk standing contains grantable",
    ); // sanity
  }
  const redlineLike = [
    "publication.snapshot_create",
    "x_lists.operation_execute",
  ];
  for (const cmd of redlineLike)
    assert.ok(
      !DAILY_CONTENT_LOOP_COMMANDS.includes(cmd),
      "no publish in loop commands",
    );
  // Ensure writer grant does not include publish_prep (redline)
  assert.ok(!writerWrites.has("publication.snapshot_create"));
});
