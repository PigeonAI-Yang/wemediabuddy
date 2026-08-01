// 截图验证 results-loop 设计稿（散点/增长带/热图 三形态）
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';

const br = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await br.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('file:///J:/PigeonYang/WeMediaBuddy/prototype/results-loop.html');
await page.waitForTimeout(800);
writeFileSync('.ai/results-loop-full.png', await page.screenshot({ fullPage: true }));
const state1 = await page.evaluate(() => ({
  dots: document.querySelectorAll('#chart circle').length,
  lines: document.querySelectorAll('#chart polyline').length,
  stats: [...document.querySelectorAll('.stat-strip .cell b')].map((b) => b.textContent),
  patterns: document.querySelectorAll('.pattern').length,
  findings: document.querySelectorAll('.finding').length,
  pending: document.querySelectorAll('.pending-row').length
}));
// 散点:吸附 → 钻取
const hz = await page.evaluate(() => { const r = document.querySelector('#hitzone').getBoundingClientRect(); return { x: r.left + r.width * 0.45, y: r.top + r.height * 0.5 }; });
await page.mouse.move(hz.x, hz.y);
await page.waitForTimeout(300);
writeFileSync('.ai/results-loop-hover.png', await page.screenshot());
const hlOn = await page.evaluate(() => !!document.querySelector('#hl *'));
await page.mouse.click(hz.x, hz.y);
await page.waitForTimeout(500);
writeFileSync('.ai/results-loop-drawer.png', await page.screenshot());
const drill = await page.evaluate(() => ({
  inChart: !!document.querySelector('#backToAgg'),
  title: document.querySelector('.drill-title')?.textContent ?? '',
  noDrawer: !document.querySelector('.drawer'),
  snapRows: document.querySelectorAll('.drill-detail .d-table tbody tr').length
}));
// 返回总览
await page.click('#backToAgg');
await page.waitForTimeout(300);
const backOk = await page.evaluate(() => !document.querySelector('#backToAgg') && document.querySelectorAll('#chart circle').length > 100);
// 增长形态(纯带) + 增速形态
await page.keyboard.press('Escape');
await page.click('#chartTabs button[data-tab="curve"]');
await page.waitForTimeout(400);
const bandLines = await page.evaluate(() => document.querySelectorAll('#chart polyline').length);
writeFileSync('.ai/results-loop-bands.png', await page.screenshot());
await page.click('.chart-opts [data-mode="norm"]');
await page.waitForTimeout(400);
writeFileSync('.ai/results-loop-norm.png', await page.screenshot());
// 热图
await page.click('#chartTabs button[data-tab="heat"]');
await page.waitForTimeout(400);
writeFileSync('.ai/results-loop-heat.png', await page.screenshot());
const heatCells = await page.evaluate(() => document.querySelectorAll('.hm-cell').length);
console.log(JSON.stringify({ ...state1, hlOn, ...drill, backOk, bandLines, heatCells, errors }));
await br.close();
process.exit(errors.length ? 1 : 0);
