import { chromium } from 'playwright-core';
import path from 'node:path';

const root = process.cwd();
const cdpPort = 9360;
const shots = { settled: path.join(root, '.ai', 'today-settled.png'), dismissed: path.join(root, '.ai', 'today-dismissed.png') };

async function wait(ms) { await new Promise((r) => setTimeout(r, ms)); }

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
const page = browser.contexts()[0]?.pages().find((p) => !p.url().startsWith('devtools://'));
if (!page) { console.log('no page'); process.exit(2); }
page.on('dialog', (dialog) => void dialog.accept());
page.on('pageerror', (err) => console.log('PAGEERROR', err.message));
await page.setViewportSize({ width: 1600, height: 960 });

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());

// 1. Wait for the running judgment to settle (write-guard fix proof).
let settled = null;
for (let i = 0; i < 72; i++) {
  await wait(5000);
  settled = await page.evaluate(async (businessDate) => {
    const rows = await window.wmb.getAgentTask ? await window.wmb.getAgentTask() : null;
    const data = await window.wmb.getToday(businessDate);
    return {
      planItems: data?.plan?.items?.length ?? null,
      planDate: data?.plan?.planDate ?? null,
      poolCount: (data?.pool ?? []).length,
      runningText: (document.querySelector('.today-command-state')?.textContent || '').trim().slice(0, 140)
    };
  }, today);
  const active = /正在启动|正在连接|正在生成|正在整理|正在核验|正在扫描/.test(settled.runningText);
  if (i % 6 === 0) console.log(`poll ${i * 5}s plan=${settled.planItems} pool=${settled.poolCount} :: ${settled.runningText.slice(0, 90)}`);
  if (!active) break;
}
await page.screenshot({ path: shots.settled });
console.log('settled:', JSON.stringify(settled, null, 2));

// 2. Dismiss the second pool card live and verify the pool shrinks.
const before = await page.evaluate(() => [...document.querySelectorAll('[data-opportunity-card] .opp-dismiss')].length);
if (before > 1) {
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('[data-opportunity-card] .opp-dismiss')];
    buttons[buttons.length - 1].click();
  });
  await wait(3000);
}
await page.screenshot({ path: shots.dismissed });
const after = await page.evaluate(async (businessDate) => {
  const data = await window.wmb.getToday(businessDate);
  return { pool: (data?.pool ?? []).map((item) => item.title.slice(0, 40)), dismissButtons: document.querySelectorAll('.opp-dismiss').length };
}, today);
console.log('dismiss:', JSON.stringify({ before, after }, null, 2));
await browser.close();
