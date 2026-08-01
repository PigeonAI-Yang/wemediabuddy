// 原型对照基准截图:prototype :7100 的 8 个视图 × 1920×900 与 1100×700
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';

const browser = await chromium.launch({ channel: 'chrome', headless: true }).catch(() => null) ?? await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:7100/', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const views = ['today', 'studio', 'publish', 'results', 'knowledge', 'library', 'canvas', 'settings'];
for (const size of [{ w: 1920, h: 900 }, { w: 1100, h: 700 }]) {
  await page.setViewportSize({ width: size.w, height: size.h });
  await page.waitForTimeout(300);
  for (const view of views) {
    await page.evaluate((id) => {
      document.querySelectorAll('.view').forEach((el) => el.classList.remove('active'));
      document.getElementById(`view-${id}`)?.classList.add('active');
    }, view);
    await page.waitForTimeout(400);
    writeFileSync(`.ai/proto-${view}-${size.w}.png`, await page.screenshot());
  }
}
await browser.close();
console.log('proto shots done');
