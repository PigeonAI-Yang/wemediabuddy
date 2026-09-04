import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { launchApp, waitForAppReady, navigateTo, closeApp } from '../tests/e2e/harness.mjs';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { upsertSource } from '../src/main/sources.ts';

const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const scoredAt = new Date().toISOString();
const scoreReasons = {
  status: 'scored', score: 91, scoredAt,
  reasons: [
    ['reader_immediacy_benefit', 20, 19], ['tension_curiosity_gap', 20, 18],
    ['why_now_window', 20, 19], ['save_share_comment_motive', 20, 18],
    ['evidence_credibility', 15, 12], ['account_fit', 5, 5]
  ].map(([criterion, weight, score]) => ({ criterion, weight, score, reason: `${criterion} 有隔离验收来源支持` }))
};

const launched = await launchApp({
  name: 'today-remediation-installed',
  appPath: 'C:/Users/yangda01/AppData/Local/WeMediaBuddy/app-0.3.0',
  headless: true,
  seedFixture: async ({ dataRoot }) => {
    const db = migrateDatabase(`${dataRoot}/wmb.db`);
    try {
      const source = upsertSource(db, { title: '隔离验收来源', originalUrl: 'https://example.com/installed-acceptance', summary: '用于验证安装态批准闭环，不进入真实业务库。' }, false);
      saveCurrentPlan(db, { planDate: date, timezone: 'Asia/Shanghai', summary: '安装态批准闭环', items: [{
        title: '安装态验收：完整选题批准闭环', priority: 1,
        whyNow: '新安装包刚完成，必须立即验证批准事务与页面跳转使用同一项目身份。', timeliness: 'today',
        targetAudience: '负责验收 WeMediaBuddy 推荐与创作闭环的产品负责人',
        angle: '从真实安装态点击和数据库读回交叉验证，不以单元测试代替。',
        pointOfView: '只有批准、项目、初始版本和 carry 同时成立，批准才算真正完成。',
        platforms: ['wechat'], formats: ['article'],
        titleGuidance: '标题直接说明安装态闭环验收。', openingGuidance: '先给点击前后的对象身份。',
        structureGuidance: '第一部分核对主推荐完整字段；第二部分记录批准回执、项目和初始版本；第三部分确认原项退出并进入递补或明确空态。', effortEstimate: '15 分钟',
        sourceIds: [source.id], availableMaterials: ['安装包哈希', '隔离数据库'], missingMaterials: [], scoreReasons
      }] });
    } finally { db.close(); }
  }
});

const { app, page, workspace } = launched;
try {
  await waitForAppReady(page);
  await navigateTo(page, 'today');
  const before = await page.evaluate(async (d) => window.wmb.getToday(d), date);
  if (!before.recommendation.primary) {
    throw new Error(`isolated primary missing: ${JSON.stringify({ recommendation: before.recommendation, plan: before.plan, latestPlan: before.latestPlan, sameDayTasks: before.sameDayTasks })}`);
  }
  await page.waitForSelector('[data-opportunity-card]', { state: 'visible', timeout: 10_000 });
  assert.equal(before.recommendation.primary?.title, '安装态验收：完整选题批准闭环');
  for (const value of ['whyNow', 'targetAudience', 'angle', 'pointOfView', 'structureGuidance']) assert.ok(before.recommendation.primary?.[value]);
  await page.screenshot({ path: 'J:/wmb-out/today-remediation-isolated-before.png', fullPage: true });
  await page.locator('button[aria-label="开始创作"]').first().click();
  await page.waitForTimeout(1500);
  const after = await page.evaluate(async (d) => window.wmb.getToday(d), date);
  assert.equal(after.recommendation.primary, null);
  const projects = await page.evaluate(async () => window.wmb.listStudioProjects({ query: '安装态验收：完整选题批准闭环', limit: 10, offset: 0 }));
  const projectId = projects.items?.[0]?.id;
  assert.ok(projectId);
  await page.screenshot({ path: 'J:/wmb-out/today-remediation-isolated-after.png', fullPage: true });
  await closeApp(app);
  const db = new DatabaseSync(`${workspace.dataRoot}/wmb.db`, { readOnly: true });
  const readback = db.prepare(`SELECT p.id project_id, p.plan_item_id, count(v.id) version_count, min(v.id) content_version_id, min(length(trim(v.body))) body_length FROM content_projects p LEFT JOIN content_versions v ON v.project_id=p.id WHERE p.id=? GROUP BY p.id`).get(projectId);
  const carry = db.prepare(`SELECT state FROM work_carry_items WHERE object_type='plan_item' AND object_id=?`).get(before.recommendation.primary.planItemId);
  db.close();
  assert.equal(readback.version_count, 1);
  assert.ok(readback.body_length > 0);
  assert.equal(carry.state, 'done');
  console.log(JSON.stringify({ date, before: { primary: before.recommendation.primary.title, counts: before.recommendation.counts }, approval: { projectId, contentVersionId: readback.content_version_id, carryState: carry.state }, after: { primary: after.recommendation.primary, counts: after.recommendation.counts, emptyReason: after.recommendation.emptyReason }, readback, carry, screenshots: ['J:/wmb-out/today-remediation-isolated-before.png', 'J:/wmb-out/today-remediation-isolated-after.png'] }, null, 2));
} catch (error) {
  await closeApp(app).catch(() => {});
  throw error;
}
