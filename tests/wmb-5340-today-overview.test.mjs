import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { getTodayOverviewMetrics } = await import('../src/main/workbench.ts');

function withTempDir(work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmb5340-'));
  try { return work(dir); } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
}
function exec(db, sql, params=[]) { return db.prepare(sql).run(...params); }

test('WMB-5340 overview semantics: zero vs unknown vs denominator-zero vs insufficient-series', () => withTempDir((dir) => {
  const dbPath = path.join(dir, 'wmb.db'); const db = migrateDatabase(dbPath);
  try {
    // empty DB => all metrics zero not unknown; trend insufficient handling checked via series length
    const m = getTodayOverviewMetrics(db, '2026-08-23');
    assert.equal(m.sources.value, 0);
    assert.equal(m.sources.changeText, '—');
    assert.equal(m.sources.series.length, 7);
    assert.equal(m.opportunities.value, 0);
    assert.equal(m.opportunities.changeText, '—');
    assert.equal(m.projects.value, 0);
    assert.equal(m.publications.value, 0);
    // denominator-zero: insert 2 sources today, none yesterday => change should be 新增 2
    db.prepare("INSERT INTO source_feeds (id, name, created_at, updated_at, revision) VALUES ('f1','f','2026-08-23T00:00:00Z','2026-08-23T00:00:00Z',1)").run();
    db.prepare("INSERT INTO source_items (id, feed_id, canonical_url, title, collected_at, summary, categories_json, keywords_json, recommended_platforms_json, recommended_formats_json, created_at, updated_at, revision) VALUES ('s1','f1','https://example.com/1','t1','2026-08-23T06:00:00Z','s','[]','[]','[]','[]','2026-08-23T06:00:00Z','2026-08-23T06:00:00Z',1)").run();
    db.prepare("INSERT INTO source_items (id, feed_id, canonical_url, title, collected_at, summary, categories_json, keywords_json, recommended_platforms_json, recommended_formats_json, created_at, updated_at, revision) VALUES ('s2','f1','https://example.com/2','t2','2026-08-23T07:00:00Z','s','[]','[]','[]','[]','2026-08-23T07:00:00Z','2026-08-23T07:00:00Z',1)").run();
    const m2 = getTodayOverviewMetrics(db, '2026-08-23');
    assert.equal(m2.sources.value, 2);
    assert.match(m2.sources.changeText, /新增 2/);
    assert.equal(m2.sources.series.filter((v) => v != null).length >= 1, true);
    // insufficient series: publications with no data => series all 0 (2+ valid points exist, but we treat 7 zeros as valid; line would be flat - spec allows)
    assert.equal(m2.publications.series.length, 7);
  } finally { db.close(); }
}));

test('WMB-5340 TodayView no longer references relocated components and single overview container', () => {
  const todayView = fs.readFileSync('J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx', 'utf8');
  assert.doesNotMatch(todayView, /TodayDailyCycle/);
  assert.doesNotMatch(todayView, /TodayYesterdayIteration/);
  assert.match(todayView, /daily-automation/);
  assert.match(todayView, /getTodayOverviewMetrics/);
  const commandBar = fs.readFileSync('J:/PigeonYang/WeMediaBuddy/src/renderer/today-command-bar.tsx', 'utf8');
  assert.match(commandBar, /today-overview/);
  assert.match(commandBar, /今日经营概况/);
  assert.match(commandBar, /MicroTrend|today-metric/);
  assert.match(commandBar, /重新侦察/);
  assert.match(commandBar, /查看资料/);
  assert.match(commandBar, /去创作/);
  assert.match(commandBar, /label: '今日新增来源'/);
  assert.match(commandBar, /新收集的来源记录，不是已选选题/);
  assert.match(todayView, /最多显示 500 条来源记录/);
  assert.doesNotMatch(todayView, /X 未接入|本次判断未包含 X|pool-absent-banner/, '渠道提示只归顶部状态组件，不得插入首条选题上方');
  const workflowCss = fs.readFileSync('J:/PigeonYang/WeMediaBuddy/src/renderer/styles-workflow-today.css', 'utf8');
  assert.doesNotMatch(workflowCss, /pool-absent-banner/, '删除废弃提示卡样式，避免再次占用内容首屏');
});

test('WMB-5340 responsive and accessible contract', () => {
  const css = fs.readFileSync('J:/PigeonYang/WeMediaBuddy/src/renderer/styles-today-overview.css', 'utf8');
  assert.match(css, /grid-template-columns:repeat\(4/);
  assert.match(css, /@media.*1100px.*repeat\(2/);
  assert.match(css, /@media.*640px/);
  const bar = fs.readFileSync('J:/PigeonYang/WeMediaBuddy/src/renderer/today-command-bar.tsx', 'utf8');
  assert.match(bar, /aria-label/);
  assert.match(bar, /role="img"/);
});
