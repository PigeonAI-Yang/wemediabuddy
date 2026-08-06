import { chromium } from 'playwright-core';
import path from 'node:path';

const root = process.cwd();
const cdpPort = 9360;
const shots = { cancelled: path.join(root, '.ai', 'today-cancelled.png'), running: path.join(root, '.ai', 'today-running.png'), final: path.join(root, '.ai', 'today-pool-final.png') };

async function wait(ms) { await new Promise((r) => setTimeout(r, ms)); }

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
const page = browser.contexts()[0]?.pages().find((p) => !p.url().startsWith('devtools://'));
if (!page) { console.log('no page'); process.exit(2); }
page.on('pageerror', (err) => console.log('PAGEERROR', err.message));
await page.setViewportSize({ width: 1600, height: 960 });
await wait(2000);

// 1. Cancel the phantom resume_pending task via IPC.
const cancelResult = await page.evaluate(async () => {
  try {
    const result = await window.wmb.controlDailyIntelligence({ id: 'c7ba40e1-97a7-4b89-993f-1b3eb443fe89', action: 'cancel' });
    return JSON.stringify(result).slice(0, 300);
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
});
console.log('cancel phantom:', cancelResult);
await wait(2000);
await page.screenshot({ path: shots.cancelled });

// 2. Start a fresh full run via IPC (scan + judge through the fixed pipeline).
const today = await page.evaluate(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()));
console.log('businessDate:', today);
const startResult = await page.evaluate(async (businessDate) => {
  try {
    const result = await window.wmb.startDailyIntelligence({ businessDate });
    return JSON.stringify({ ok: result?.ok, status: result?.data?.task?.status, phase: result?.data?.task?.phase, error: result?.error }).slice(0, 300);
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
}, today);
console.log('start:', startResult);
await wait(5000);
await page.screenshot({ path: shots.running });

// 3. Poll until the task settles.
let state = null;
for (let i = 0; i < 90; i++) {
  await wait(5000);
  state = await page.evaluate(async (businessDate) => {
    const data = await window.wmb.getToday(businessDate);
    const cards = [...document.querySelectorAll('[data-opportunity-card]')].map((el) => ({
      title: (el.querySelector('.opp-title, h2')?.textContent || '').trim().slice(0, 70),
      pills: [...el.querySelectorAll('.pill')].map((pill) => (pill.textContent || '').trim()),
      dismiss: Boolean(el.querySelector('.opp-dismiss'))
    }));
    return {
      pool: (data?.pool ?? []).map((item) => ({ title: item.title.slice(0, 50), class: item.timelinessClass, isNew: item.isNew, demoted: Boolean(item.demotion) })),
      planItems: data?.plan?.items?.length ?? null,
      cards,
      absentBanner: document.querySelector('.pool-absent-banner')?.textContent?.trim() ?? null,
      runningText: (document.querySelector('.today-command-state')?.textContent || '').trim().slice(0, 140)
    };
  }, today);
  const settled = state.cards.length > 0 || (!/正在|启动|等待/.test(state.runningText));
  if (i % 6 === 0) console.log(`poll ${i * 5}s cards=${state.cards.length} pool=${state.pool.length} :: ${state.runningText.slice(0, 80)}`);
  if (settled) break;
}
await page.screenshot({ path: shots.final });
console.log(JSON.stringify({ pool: state.pool, cards: state.cards, absentBanner: state.absentBanner, runningText: state.runningText }, null, 2));
await browser.close();
