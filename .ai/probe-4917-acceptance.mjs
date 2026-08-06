import { chromium } from 'playwright-core';
import path from 'node:path';

const root = process.cwd();
const cdpPort = 9360;
const shot = path.join(root, '.ai', 'wmb-4917-acceptance.png');

async function wait(ms) { await new Promise((r) => setTimeout(r, ms)); }

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
const page = browser.contexts()[0]?.pages().find((p) => !p.url().startsWith('devtools://'));
if (!page) { console.log('no page'); process.exit(2); }
page.on('pageerror', (err) => console.log('PAGEERROR', err.message));
await page.setViewportSize({ width: 1600, height: 960 });

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
let state = null;
let inactiveStreak = 0;
for (let i = 0; i < 150; i++) {
  await wait(5000);
  state = await page.evaluate(async (businessDate) => {
    const data = await window.wmb.getToday(businessDate);
    return {
      planItems: data?.plan?.items?.length ?? null,
      planSummary: (data?.plan?.summary || '').slice(0, 100),
      planItemSample: (data?.plan?.items ?? []).slice(0, 3).map((item) => ({
        title: item.title.slice(0, 50),
        whyNow: (item.whyNow || '').slice(0, 80),
        angle: (item.angle || '').slice(0, 60),
        pointOfView: (item.pointOfView || '').slice(0, 60),
        sources: item.sourceIds.length
      })),
      pool: (data?.pool ?? []).map((item) => ({ title: item.title.slice(0, 45), class: item.timelinessClass, isNew: item.isNew })),
      runningText: (document.querySelector('.today-command-state')?.textContent || '').trim().slice(0, 140)
    };
  }, today);
  const active = /正在生成|正在整理|正在核验|正在扫描|正在连接|正在启动/.test(state.runningText);
  inactiveStreak = active ? 0 : inactiveStreak + 1;
  if (i % 6 === 0) console.log(`poll ${i * 5}s plan=${state.planItems} pool=${state.pool.length} :: ${state.runningText.slice(0, 90)}`);
  if (inactiveStreak >= 3 && i > 6) break;
}
await page.screenshot({ path: shot });
console.log(JSON.stringify(state, null, 2));
await browser.close();
