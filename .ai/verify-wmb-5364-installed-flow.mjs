import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { launchApp, waitForAppReady, navigateTo, closeApp } from '../tests/e2e/harness.mjs';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { upsertSource } from '../src/main/sources.ts';
import { editorialDecision, scoredReasons } from '../tests/helpers/planning-fixture.mjs';

const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const thesis = '国产算力开始承接大规模公共 AI 服务，是比“免费是否值得用”更重要的产业信号。';
const title = '安装态验收：GLM-5.3 Flash 背后的国产算力商业化信号';
const launched = await launchApp({
  name: 'wmb-5364-installed-flow',
  appPath: 'C:/Users/yangda01/AppData/Local/WeMediaBuddy/app-0.3.0',
  headless: true,
  seedFixture: async ({ dataRoot }) => {
    const db = migrateDatabase(`${dataRoot}/wmb.db`);
    try {
      const source = upsertSource(db, {
        title: 'WMB-5364 安装态隔离验收来源',
        originalUrl: 'https://example.com/wmb-5364-installed-flow',
        summary: '仅用于验证新安装包的完整推荐卡、批准事务与中心主张锁。',
      }, false);
      saveCurrentPlan(db, {
        planDate: date,
        timezone: 'Asia/Shanghai',
        summary: 'WMB-5364 安装态隔离验收',
        items: [{
          title,
          priority: 1,
          whyNow: '模型身份、免费容量和国产芯片承载证据首次进入同一条可核验链路，产业判断窗口已经出现。',
          timeliness: 'today',
          targetAudience: '关心中国 AI 基础设施商业化进程的开发者与自媒体创作者',
          angle: '不把免费当主线，而是解释国产算力从实验能力跨到公共商业服务的现实变化。',
          pointOfView: thesis,
          platforms: ['wechat'],
          formats: ['article'],
          titleGuidance: '标题直接突出国产算力商业化，不退化为免费模型测评。',
          openingGuidance: '首段用 100T 服务规模和国产芯片承载事实兑现产业变化。',
          structureGuidance: '身份与容量事实→国产芯片承载证据→产业阶段变化→证据边界→对中国 AI 生态的意义。',
          effortEstimate: '60 分钟',
          sourceIds: [source.id],
          availableMaterials: ['模型身份', '100T 服务规模', '国产芯片承载证据'],
          missingMaterials: [],
          scoreReasons: scoredReasons(91),
          editorialDecision: editorialDecision(thesis),
        }],
      });
    } finally {
      db.close();
    }
  },
});

const { app, page, workspace } = launched;
try {
  await waitForAppReady(page);
  await navigateTo(page, 'today');
  const before = await page.evaluate(async (planDate) => window.wmb.getToday(planDate), date);
  const primary = before.recommendation.primary;
  assert.ok(primary, 'installed Today recommendation is missing');
  assert.equal(primary.title, title);
  assert.equal(primary.pointOfView, thesis);
  for (const field of ['whyNow', 'targetAudience', 'angle', 'pointOfView', 'structureGuidance']) {
    assert.ok(String(primary[field] ?? '').trim(), `installed recommendation is missing ${field}`);
  }
  const card = page.locator('[data-opportunity-card]').first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  const cardText = await card.innerText();
  for (const value of [primary.whyNow, primary.targetAudience, primary.angle, primary.pointOfView]) {
    assert.ok(cardText.includes(value), `installed card omitted detail: ${value}`);
  }
  await page.screenshot({ path: 'J:/wmb-out/wmb-5364-installed-flow-before.png', fullPage: true });

  await card.locator('button[aria-label="开始创作"]').click();
  await page.waitForTimeout(1_500);
  const after = await page.evaluate(async (planDate) => window.wmb.getToday(planDate), date);
  assert.equal(after.recommendation.primary, null);
  const projects = await page.evaluate(async (query) => window.wmb.listStudioProjects({ query, limit: 10, offset: 0 }), title);
  const projectId = projects.items?.[0]?.id;
  assert.ok(projectId, 'approval did not create a Studio project');
  await page.screenshot({ path: 'J:/wmb-out/wmb-5364-installed-flow-after.png', fullPage: true });
  await closeApp(app);

  const db = new DatabaseSync(`${workspace.dataRoot}/wmb.db`, { readOnly: true });
  const planItem = db.prepare(`SELECT id, planning_status AS planningStatus, planning_provenance_json AS provenance
    FROM plan_items WHERE title=?`).get(title);
  const project = db.prepare(`SELECT p.id, p.plan_item_id AS planItemId, count(v.id) AS versionCount,
    min(length(trim(v.body))) AS bodyLength, min(v.body) AS body
    FROM content_projects p LEFT JOIN content_versions v ON v.project_id=p.id
    WHERE p.id=? GROUP BY p.id`).get(projectId);
  db.close();
  const provenance = JSON.parse(planItem.provenance);
  assert.equal(planItem.planningStatus, 'approved');
  assert.equal(provenance.thesis_lock?.version, 'thesis_lock_v1');
  assert.equal(provenance.thesis_lock?.winnerThesis, thesis);
  assert.equal(project.planItemId, planItem.id);
  assert.equal(project.versionCount, 1);
  assert.ok(project.bodyLength > 0);
  assert.ok(project.body.includes('已批准中心主张'));
  assert.ok(project.body.includes(thesis));

  const evidence = {
    date,
    before: { title: primary.title, pointOfView: primary.pointOfView, scoreReasons: primary.scoreReasons },
    approval: { projectId, planItemId: planItem.id, planningStatus: planItem.planningStatus },
    thesisLock: provenance.thesis_lock,
    initialVersion: { versionCount: project.versionCount, bodyLength: project.bodyLength, containsApprovedThesis: true },
    after: { primary: after.recommendation.primary, counts: after.recommendation.counts, emptyReason: after.recommendation.emptyReason },
    screenshots: ['J:/wmb-out/wmb-5364-installed-flow-before.png', 'J:/wmb-out/wmb-5364-installed-flow-after.png'],
  };
  fs.writeFileSync('J:/wmb-out/wmb-5364-installed-flow.json', `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  await closeApp(app).catch(() => {});
  throw error;
}
