import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const cdpPort = 9360;
const shots = { cancelled: path.join(root, '.ai', 'today-pool-idle.png'), running: path.join(root, '.ai', 'today-pool-running.png'), final: path.join(root, '.ai', 'today-pool-final.png') };

async function wait(ms) { await new Promise((r) => setTimeout(r, ms)); }

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
const page = browser.contexts()[0]?.pages().find((p) => !p.url().startsWith('devtools://'));
if (!page) { console.log('no page'); process.exit(2); }
page.on('dialog', (dialog) => void dialog.accept());
page.on('pageerror', (err) => console.log('PAGEERROR', err.message));

await page.setViewportSize({ width: 1600, height: 960 });

// 1. Cancel the stalled task if the cancel action exists.
const cancelled = await page.evaluate(async () => {
  const buttons = [...document.querySelectorAll('button')];
  const cancel = buttons.find((el) => (el.textContent || '').trim() === '取消任务');
  if (cancel) { cancel.click(); return 'clicked-cancel'; }
  return 'no-cancel-button';
});
console.log('cancel:', cancelled);
await wait(2500);
await page.screenshot({ path: shots.cancelled });

// 2. Start a fresh daily run (full coordinator: scan + judge).
const started = await page.evaluate(async () => {
  const buttons = [...document.querySelectorAll('button')];
  const start = buttons.find((el) => /开始今日情报|继续今日情报|重新侦察/.test((el.textContent || '').trim()));
  if (start) { start.click(); return (start.textContent || '').trim(); }
  return null;
});
console.log('start:', started);
await wait(4000);
await page.screenshot({ path: shots.running });

// 3. Wait for the task to settle (scan + judge, up to 6 minutes), then read the pool.
let final = null;
for (let i = 0; i < 72; i++) {
  await wait(5000);
  final = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-opportunity-card]')].map((el) => ({
      title: (el.querySelector('.opp-title, h2')?.textContent || '').trim().slice(0, 60),
      pills: [...el.querySelectorAll('.pill')].map((pill) => (pill.textContent || '').trim()),
      dismiss: Boolean(el.querySelector('.opp-dismiss'))
    }));
    const runningText = document.querySelector('.today-command-state')?.textContent || '';
    return {
      cards,
      running: /正在|等待/.test(runningText) && !/已完成|部分完成/.test(runningText),
      runningText: runningText.trim().slice(0, 120),
      absentBanner: document.querySelector('.pool-absent-banner')?.textContent?.trim() ?? null
    };
  });
  if (!final.running) break;
  if (i % 6 === 0) console.log(`waiting ${i * 5}s…`, final.runningText.slice(0, 80));
}
await page.screenshot({ path: shots.final });
console.log(JSON.stringify(final, null, 2));
await browser.close();
