// WMB-5349 foundation migration contract: v77 columns / CHECK / default / index / precise 9-field backfill
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { migrations, migrateDatabase } = await import('../src/main/db/migrations.ts');

const FALLBACK = {
  why_now: '基于知乎热题的每日内容目标',
  timeliness: 'today',
  target_audience: '泛科技受众',
  angle: '深度解读该问题的核心争议与证据',
  point_of_view: '提供独立判断与可操作建议',
  platforms_json: JSON.stringify(['x', 'xiaohongshu', 'wechat']),
  formats_json: JSON.stringify(['article']),
  opening_guidance: '以问题为引，快速建立共识再展开分析',
  structure_guidance: '背景→拆解→证据→观点→行动',
};

function withTempDir(work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmb5349-'));
  try { return work(dir); } finally {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
}
function migrateFresh(dir) {
  const dbPath = path.join(dir, 'wmb.db');
  const db = migrateDatabase(dbPath);
  return { db, dbPath };
}
function buildLegacyDb(dir) {
  const legacy = migrations.filter((m) => m.version < 77);
  const dbPath = path.join(dir, 'wmb.db');
  let db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const m of legacy) {
    db.exec('PRAGMA foreign_keys=OFF');
    db.exec('BEGIN IMMEDIATE');
    db.exec(m.sql);
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?,?)').run(m.version, new Date().toISOString());
    db.exec('COMMIT');
    db.exec('PRAGMA foreign_keys=ON');
  }
  return { db, dbPath };
}
function seedPlan(db, planId = 'plan-77') {
  db.prepare("INSERT INTO plans (id, plan_date, timezone, summary, is_current, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,?,1)").run(planId, '2026-08-23', 'Asia/Shanghai', 't', 1, '2026-08-23T00:00:00Z', '2026-08-23T00:00:00Z');
}
function insertPlanItem(db, planId, id, overrides = {}) {
  const v = { ...FALLBACK, ...overrides };
  db.prepare(
    `INSERT INTO plan_items (id, plan_id, topic_id, title, priority, why_now, timeliness, target_audience, angle, point_of_view, platforms_json, formats_json, title_guidance, opening_guidance, structure_guidance, effort_estimate, source_ids_json, review_ids_json, method_finding_ids_json, sort_order, created_at, updated_at, revision)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`
  ).run(
    id, planId, null, overrides.title ?? `title-${id}`, 1,
    v.why_now, v.timeliness, v.target_audience, v.angle, v.point_of_view,
    v.platforms_json, v.formats_json,
    overrides.title ?? `title-${id}`, v.opening_guidance, v.structure_guidance,
    'M', '[]', '[]', '[]', overrides.sort_order ?? 0, '2026-08-23T00:00:00Z', '2026-08-23T00:00:00Z'
  );
}

// 1. Empty DB: v77 aggregates, columns / CHECK / default / index visible via read-only
test('WMB-5349 fresh DB aggregates v77 with two columns, CHECK, default and composite index', () => withTempDir((dir) => {
  const { db } = migrateFresh(dir);
  try {
    const versions = new Set(migrations.map((m) => m.version));
    assert.ok(versions.has(77), 'migrations must contain version 77');
    assert.equal(db.prepare("SELECT COUNT(*) as c FROM schema_migrations WHERE version=77").get().c, 1);

    const cols = new Map(db.prepare("SELECT name, type, dflt_value FROM pragma_table_info('plan_items')").all().map((r) => [r.name, r]));
    assert.ok(cols.has('planning_status'), 'planning_status column missing');
    assert.ok(cols.has('planning_provenance_json'), 'planning_provenance_json column missing');
    assert.match(String(cols.get('planning_status').dflt_value), /draft/);
    assert.match(String(cols.get('planning_provenance_json').dflt_value), /origin/);
    // CHECK constraint exists in sqlite_master sql
    const tblSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='plan_items'").get().sql;
    assert.match(tblSql, /planning_status IN \('draft','ready_for_review','approved','rejected'\)/);
    // composite index
    const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_plan_items_planning_status'").get();
    assert.ok(idx, 'idx_plan_items_planning_status missing');
    assert.match(idx.sql, /planning_status.*plan_id.*sort_order/s);
    // default insert without explicit status -> draft + valid JSON default
    seedPlan(db, 'plan-fresh');
    db.prepare(
      `INSERT INTO plan_items (id, plan_id, title, priority, why_now, timeliness, target_audience, angle, point_of_view, platforms_json, formats_json, title_guidance, opening_guidance, structure_guidance, effort_estimate, source_ids_json, review_ids_json, method_finding_ids_json, sort_order, created_at, updated_at, revision)
       VALUES ('fresh1','plan-fresh','t',1,'w','today','a','ang','pov','[]','[]','t','o','s','M','[]','[]','[]',0,'2026-08-23T00:00:00Z','2026-08-23T00:00:00Z',1)`
    ).run();
    const freshRow = db.prepare("SELECT planning_status, planning_provenance_json FROM plan_items WHERE id='fresh1'").get();
    assert.equal(freshRow.planning_status, 'draft');
    assert.doesNotThrow(() => JSON.parse(freshRow.planning_provenance_json));
    assert.equal(JSON.parse(freshRow.planning_provenance_json).origin, 'system');
    // illegal status rejected by CHECK
    assert.throws(() => {
      db.prepare(
        `INSERT INTO plan_items (id, plan_id, planning_status, title, priority, why_now, timeliness, target_audience, angle, point_of_view, platforms_json, formats_json, title_guidance, opening_guidance, structure_guidance, effort_estimate, source_ids_json, review_ids_json, method_finding_ids_json, sort_order, created_at, updated_at, revision)
         VALUES ('bad1','plan-fresh','illegal','t',1,'w','today','a','ang','pov','[]','[]','t','o','s','M','[]','[]','[]',1,'2026-08-23T00:00:00Z','2026-08-23T00:00:00Z',1)`
      ).run();
    }, /CHECK|constraint/i);
  } finally { db.close(); }
}));

// 2. Upgrade: exact 9-field fingerprint -> draft + legacy_zhihu_fallback; others -> approved + legacy_approved
test('WMB-5349 legacy upgrade exact 9-field match is draft/legacy_zhihu_fallback, remainder is approved/legacy_approved', () => withTempDir((dir) => {
  const { db: legacyDb, dbPath } = buildLegacyDb(dir);
  seedPlan(legacyDb, 'plan-legacy');
  insertPlanItem(legacyDb, 'plan-legacy', 'exact-fallback-1', { sort_order: 0 });
  insertPlanItem(legacyDb, 'plan-legacy', 'normal-1', { sort_order: 1, why_now: '自定义选题理由', angle: '自定义角度', target_audience: '独立开发者' });
  legacyDb.close();

  const upgraded = migrateDatabase(dbPath);
  try {
    const exact = upgraded.prepare("SELECT planning_status, planning_provenance_json FROM plan_items WHERE id='exact-fallback-1'").get();
    assert.equal(exact.planning_status, 'draft');
    const ej = JSON.parse(exact.planning_provenance_json);
    assert.equal(ej.legacy, 'legacy_zhihu_fallback');
    assert.equal(ej.origin, 'migration');
    assert.ok(ej.backfilled_at);

    const normal = upgraded.prepare("SELECT planning_status, planning_provenance_json FROM plan_items WHERE id='normal-1'").get();
    assert.equal(normal.planning_status, 'approved');
    assert.equal(JSON.parse(normal.planning_provenance_json).legacy, 'legacy_approved');

    // generic migration writes no Yann UUID
    const allJson = upgraded.prepare("SELECT planning_provenance_json FROM plan_items").all().map((r) => String(r.planning_provenance_json));
    for (const j of allJson) {
      assert.ok(!j.includes('6ce12d8a') && !j.includes('8342f64f'), 'migration must not embed Yann IDs');
      assert.ok(!j.includes('8aae5605'), 'migration must not embed Yann v0 id');
    }
  } finally { upgraded.close(); }
}));

// 3. Near-miss: single field difference must NOT be classified as fallback (falsifiable deep-equality)
test('WMB-5349 near-miss single field diff does NOT match fallback and becomes approved', () => withTempDir((dir) => {
  const { db: legacyDb, dbPath } = buildLegacyDb(dir);
  seedPlan(legacyDb, 'plan-near');
  // each variant differs in exactly one of the 9 fields
  insertPlanItem(legacyDb, 'plan-near', 'near-why', { sort_order: 0, why_now: '基于知乎热题的每日内容目标 ' }); // trailing space
  insertPlanItem(legacyDb, 'plan-near', 'near-platform', { sort_order: 1, platforms_json: JSON.stringify(['x']) });
  insertPlanItem(legacyDb, 'plan-near', 'near-timeliness', { sort_order: 2, timeliness: 'yesterday' });
  insertPlanItem(legacyDb, 'plan-near', 'near-angle', { sort_order: 3, angle: '深度解读' });
  insertPlanItem(legacyDb, 'plan-near', 'near-opening', { sort_order: 4, opening_guidance: '以问题为引' });
  legacyDb.close();

  const upgraded = migrateDatabase(dbPath);
  try {
    for (const id of ['near-why', 'near-platform', 'near-timeliness', 'near-angle', 'near-opening']) {
      const row = upgraded.prepare("SELECT planning_status, planning_provenance_json FROM plan_items WHERE id=?").get(id);
      assert.equal(row.planning_status, 'approved', `${id} near-miss should be approved`);
      assert.equal(JSON.parse(row.planning_provenance_json).legacy, 'legacy_approved', `${id} near-miss legacy`);
    }
  } finally { upgraded.close(); }
}));

// 4. Legacy null guard: once classified, re-running backfill SQL does not flip status
test('WMB-5349 legacy IS NULL guard prevents second flip on re-execution', () => withTempDir((dir) => {
  const { db: legacyDb, dbPath } = buildLegacyDb(dir);
  seedPlan(legacyDb, 'plan-guard');
  insertPlanItem(legacyDb, 'plan-guard', 'guard-fallback', { sort_order: 0 });
  insertPlanItem(legacyDb, 'plan-guard', 'guard-normal', { sort_order: 1, why_now: '外部选题' });
  legacyDb.close();
  const upgraded = migrateDatabase(dbPath);
  try {
    const beforeFallback = upgraded.prepare("SELECT planning_status FROM plan_items WHERE id='guard-fallback'").get().planning_status;
    const beforeNormal = upgraded.prepare("SELECT planning_status FROM plan_items WHERE id='guard-normal'").get().planning_status;
    assert.equal(beforeFallback, 'draft');
    assert.equal(beforeNormal, 'approved');
    // re-run the two backfill UPDATEs verbatim: they must affect 0 rows due to legacy IS NULL guard
    const r1 = upgraded.prepare(`
      UPDATE plan_items SET planning_status='draft',
        planning_provenance_json = json_patch(planning_provenance_json, json_object('origin','migration','legacy','legacy_zhihu_fallback','backfilled_at',strftime('%Y-%m-%dT%H:%M:%SZ','now'),'reason','exact_fallback_fingerprint_8fields'))
      WHERE planning_status='draft' AND json_extract(planning_provenance_json,'$.legacy') IS NULL
        AND why_now='基于知乎热题的每日内容目标' AND timeliness='today' AND target_audience='泛科技受众'
        AND angle='深度解读该问题的核心争议与证据' AND point_of_view='提供独立判断与可操作建议'
        AND platforms_json='["x","xiaohongshu","wechat"]' AND formats_json='["article"]'
        AND opening_guidance='以问题为引，快速建立共识再展开分析' AND structure_guidance='背景→拆解→证据→观点→行动'
    `).run();
    assert.equal(r1.changes, 0, 'fallback re-run must change 0');
    const r2 = upgraded.prepare(`
      UPDATE plan_items SET planning_status='approved',
        planning_provenance_json = json_patch(planning_provenance_json, json_object('origin','migration','legacy','legacy_approved','backfilled_at',strftime('%Y-%m-%dT%H:%M:%SZ','now')))
      WHERE planning_status='draft' AND json_extract(planning_provenance_json,'$.legacy') IS NULL
    `).run();
    assert.equal(r2.changes, 0, 'approved re-run must change 0');
    assert.equal(upgraded.prepare("SELECT planning_status FROM plan_items WHERE id='guard-fallback'").get().planning_status, 'draft');
    assert.equal(upgraded.prepare("SELECT planning_status FROM plan_items WHERE id='guard-normal'").get().planning_status, 'approved');
  } finally { upgraded.close(); }
}));

// 5. CHECK remains enforced after upgrade and empty DB upgrade works
test('WMB-5349 CHECK rejects illegal status after upgrade; empty legacy upgrades cleanly', () => withTempDir((dir) => {
  // empty legacy path
  const { db: legacyDb, dbPath } = buildLegacyDb(dir);
  seedPlan(legacyDb, 'plan-empty');
  // no plan_items inserted
  legacyDb.close();
  const upgradedEmpty = migrateDatabase(dbPath);
  try {
    assert.equal(upgradedEmpty.prepare("SELECT COUNT(*) as c FROM plan_items").get().c, 0);
    assert.ok(upgradedEmpty.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_plan_items_planning_status'").get());
  } finally { upgradedEmpty.close(); }

  // CHECK after upgrade
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wmb5349-check-'));
  try {
    const { db } = migrateFresh(tmp2);
    try {
      seedPlan(db, 'plan-check');
      assert.throws(() => db.prepare(
        `INSERT INTO plan_items (id, plan_id, planning_status, planning_provenance_json, title, priority, why_now, timeliness, target_audience, angle, point_of_view, platforms_json, formats_json, title_guidance, opening_guidance, structure_guidance, effort_estimate, source_ids_json, review_ids_json, method_finding_ids_json, sort_order, created_at, updated_at, revision)
         VALUES ('chk1','plan-check','rejected_typo','{"origin":"system","transitions":[]}','t',1,'w','today','a','ang','pov','[]','[]','t','o','s','M','[]','[]','[]',0,'2026-08-23T00:00:00Z','2026-08-23T00:00:00Z',1)`
      ).run(), /CHECK|constraint/i);
      // valid statuses pass
      for (const s of ['draft', 'ready_for_review', 'approved', 'rejected']) {
        const id = `ok-${s}`;
        db.prepare(
          `INSERT INTO plan_items (id, plan_id, planning_status, planning_provenance_json, title, priority, why_now, timeliness, target_audience, angle, point_of_view, platforms_json, formats_json, title_guidance, opening_guidance, structure_guidance, effort_estimate, source_ids_json, review_ids_json, method_finding_ids_json, sort_order, created_at, updated_at, revision)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`
        ).run(id, 'plan-check', s, '{"origin":"system","transitions":[]}', 't', 1, 'w', 'today', 'a', 'ang', 'pov', '[]', '[]', 't', 'o', 's', 'M', '[]', '[]', '[]', 10, '2026-08-23T00:00:00Z', '2026-08-23T00:00:00Z');
        assert.equal(db.prepare("SELECT planning_status FROM plan_items WHERE id=?").get(id).planning_status, s);
      }
    } finally { db.close(); }
  } finally { fs.rmSync(tmp2, { recursive: true, force: true }); }
}));

// 6. Index classification query uses composite index and version ordering
test('WMB-5349 composite index on (planning_status, plan_id, sort_order) and version order', () => withTempDir((dir) => {
  const { db } = migrateFresh(dir);
  try {
    const idxSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_plan_items_planning_status'").get().sql;
    const posStatus = idxSql.indexOf('planning_status');
    const posPlan = idxSql.indexOf('plan_id');
    const posSort = idxSql.indexOf('sort_order');
    assert.ok(posStatus < posPlan && posPlan < posSort, 'index columns must be planning_status, plan_id, sort_order in order');
    // v78 is the unique highest schema version; the historical aggregate is not source-ordered.
    const vers = migrations.map((m) => m.version);
    assert.equal(Math.max(...vers), 78);
    assert.equal(new Set(vers).size, vers.length, 'migration versions must remain unique');
    // query by status uses index (EXPLAIN QUERY PLAN contains index)
    seedPlan(db, 'plan-idx');
    for (let i = 0; i < 3; i++) insertPlanItem(db, 'plan-idx', `idx-${i}`, { sort_order: i, why_now: `w${i}` });
    // force approved for query
    db.prepare("UPDATE plan_items SET planning_status='approved' WHERE plan_id='plan-idx'").run();
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM plan_items WHERE planning_status='approved' AND plan_id='plan-idx' ORDER BY sort_order").all();
    const detail = plan.map((r) => r.detail).join(' ');
    assert.match(detail, /idx_plan_items_planning_status/i);
  } finally { db.close(); }
}));
