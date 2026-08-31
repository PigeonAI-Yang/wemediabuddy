import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { upsertSource } from '../src/main/sources.ts';
import { getToday } from '../src/main/workbench.ts';
import { editorialDecision, scoredReasons } from './helpers/planning-fixture.mjs';

const BUSINESS_DATE = '2026-08-28';
const AS_OF = new Date('2026-08-28T08:00:00.000Z');

test('Today exposes a historical plan only when the authoritative projection has display items', () => {
  const source = readFileSync(new URL('../src/renderer/today-view.tsx', import.meta.url), 'utf8');
  assert.match(source, /hasRecentPlan:\s*!todayPlan\s*&&\s*displayItems\.length\s*>\s*0/);
  assert.doesNotMatch(source, /hasRecentPlan:\s*!todayPlan\s*&&\s*Boolean\(latestPlan\)/);
});

async function withDb(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-recommendation-'));
  await openDataRoot(root);
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  try { await run(database); }
  finally {
    database.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

function completeItem(title, sourceId, total, overrides = {}) {
  const item = {
    title, priority: 1,
    whyNow: '官方刚公布关键变化，当前两天是解释窗口，错过后读者注意力会明显下降。',
    timeliness: '热点 2-3 天',
    targetAudience: '正在选择 AI 工具并需要控制实际调用成本的个人开发者',
    angle: '用一次真实任务的额度、耗时与成功率对比切入，而不是复述参数。',
    pointOfView: '免费额度只有在真实任务可稳定完成时才具有商业价值。',
    platforms: ['xiaohongshu'], formats: ['carousel'],
    titleGuidance: '标题使用免费额度与真实交付成本之间的反差。',
    openingGuidance: '先给出一次真实调用回执，再解释免费数字为什么可能误导。',
    structureGuidance: '第一段交代事件与额度；第二段展示真实任务回执；第三段给出是否值得使用的判断清单。',
    effortEstimate: '90 分钟', sourceIds: [sourceId],
    availableMaterials: ['官方公告', '真实调用回执'], missingMaterials: [], ...overrides
  };
  return { ...item, scoreReasons: overrides.scoreReasons ?? scoredReasons(total, AS_OF.toISOString()), editorialDecision: overrides.editorialDecision ?? editorialDecision(item.pointOfView) };
}

function source(database, slug) {
  return upsertSource(database, {
    title: `资料 ${slug}`,
    originalUrl: `https://example.com/${slug}`,
    summary: `资料 ${slug} 的可核验摘要`
  }, false).id;
}

test('Recommendation Projection chooses the highest scored eligible item across today and carried dates', async () => {
  await withDb(async (database) => {
    const older = source(database, 'older');
    const today = source(database, 'today');
    saveCurrentPlan(database, {
      planDate: '2026-08-27', timezone: 'Asia/Shanghai', summary: '跨日方案',
      items: [completeItem('跨日高分选题', older, 92)]
    });
    saveCurrentPlan(database, {
      planDate: BUSINESS_DATE, timezone: 'Asia/Shanghai', summary: '今日方案',
      items: [completeItem('今日较低分选题', today, 84)]
    });

    const projection = getToday(database, BUSINESS_DATE, { now: AS_OF }).recommendation;
    assert.ok(projection, 'getToday must return one authoritative recommendation projection');
    assert.equal(projection.primary?.title, '跨日高分选题');
    assert.equal(projection.counts.todayReady, 1);
    assert.equal(projection.counts.carriedReady, 1);
  });
});

test('title-only shell is fail-closed and exposed as an actionable repairable item', async () => {
  await withDb(async (database) => {
    const sid = source(database, 'shell');
    saveCurrentPlan(database, {
      planDate: BUSINESS_DATE, timezone: 'Asia/Shanghai', summary: '空壳方案',
      items: [completeItem('只有标题的空壳选题', sid, 90, {
        whyNow: '窗口', targetAudience: '受众', angle: '角度', pointOfView: '观点',
        titleGuidance: '标题', openingGuidance: '开头', structureGuidance: '结构'
      })]
    });

    const projection = getToday(database, BUSINESS_DATE, { now: AS_OF }).recommendation;
    assert.equal(projection.primary, null);
    assert.equal(projection.counts.invalid, 1);
    assert.equal(projection.repairable[0]?.reasonCode, 'proposal_incomplete');
  });
});

test('decision is not truncated before evaluating more than 200 eligible candidates', async () => {
  await withDb(async (database) => {
    const bulkTitle = (index) => `候选 ${String.fromCodePoint(0x4e00 + index).repeat(8)} ${index}`;
    const sourceIds = [];
    for (let index = 0; index < 205; index += 1) {
      sourceIds.push(source(database, `bulk-${index}`));
    }
    const saved = saveCurrentPlan(database, {
      planDate: BUSINESS_DATE,
      timezone: 'Asia/Shanghai',
      summary: '大批量方案',
      items: [completeItem(bulkTitle(0), sourceIds[0], 70)]
    });
    const baseId = database.prepare('SELECT id FROM plan_items WHERE plan_id = ?').get(saved.id).id;
    const insertClone = database.prepare(`
      INSERT INTO plan_items (
        id, plan_id, topic_id, title, priority, why_now, timeliness, target_audience,
        angle, point_of_view, platforms_json, formats_json, title_guidance,
        opening_guidance, structure_guidance, effort_estimate, source_ids_json,
        available_materials_json, missing_materials_json, review_ids_json,
        method_finding_ids_json, sort_order, created_at, updated_at, revision,
        score_reasons_json, planning_status, planning_provenance_json
      )
      SELECT ?, plan_id, topic_id, ?, priority, why_now, timeliness, ?, ?, ?,
        platforms_json, formats_json, title_guidance, opening_guidance,
        structure_guidance, effort_estimate, ?, available_materials_json,
        missing_materials_json, review_ids_json, method_finding_ids_json, ?,
        created_at, updated_at, revision, ?, planning_status, ?
      FROM plan_items WHERE id = ?
    `);
    for (let index = 1; index < 205; index += 1) {
      const pointOfView = `第 ${index} 个案例证明对应工作流需要独立验收。`;
      insertClone.run(
        `bulk-plan-item-${index}`,
        bulkTitle(index),
        `第 ${index} 类具体用户正在处理第 ${index} 个真实任务`,
        `从第 ${index} 个独立案例与回执切入，解释不同的实际问题。`,
        pointOfView,
        JSON.stringify([sourceIds[index]]),
        index,
        JSON.stringify(scoredReasons(index === 204 ? 99 : 70, AS_OF.toISOString())),
        JSON.stringify({ origin: 'fixture', editorial_decision: editorialDecision(pointOfView) }),
        baseId
      );
    }
    const projection = getToday(database, BUSINESS_DATE, { now: AS_OF }).recommendation;
    assert.equal(projection.primary?.title, bulkTitle(204));
    assert.equal(projection.counts.todayReady, 205);
  });
});
