import { writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';

const mode = process.argv[2] ?? 'before';
const get = (pathname) => new Promise((resolve, reject) => http.get(`http://127.0.0.1:9371${pathname}`, (response) => {
  let body = ''; response.on('data', (chunk) => { body += chunk; }); response.on('end', () => resolve(JSON.parse(body)));
}).on('error', reject));
const version = await get('/json/version');
const browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl);
try {
  const page = browser.contexts()[0].pages()[0];
  await page.waitForSelector('.pi-conversation');
  const conversation = page.locator('.pi-conversation');
  await conversation.evaluate((node) => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll', { bubbles: true })); });
  await page.locator('.pi-jump-latest').waitFor();
  const frames = await page.evaluate(async () => {
    const conversation = document.querySelector('.pi-conversation');
    const sample = (frame) => { const button = document.querySelector('.pi-jump-latest'); const rect = button?.getBoundingClientRect(); return { frame, scrollTop: conversation.scrollTop, distance: conversation.scrollHeight - conversation.clientHeight - conversation.scrollTop, buttonMounted: Boolean(button), centerX: rect ? (rect.left + rect.right) / 2 : null, opacity: button ? getComputedStyle(button).opacity : null, className: button?.className ?? null }; };
    const result = [sample(0)];
    document.querySelector('.pi-jump-latest').click();
    for (let frame = 1; frame <= 240; frame += 1) { await new Promise(requestAnimationFrame); result.push(sample(frame)); if (!result.at(-1).buttonMounted && result.at(-1).distance <= 1) break; }
    return result;
  });
  await page.screenshot({ path: path.join(process.cwd(), '.ai', `wmb-4102-${mode}.png`), fullPage: true });
  const mounted = frames.filter((frame) => frame.buttonMounted);
  const centers = mounted.map((frame) => frame.centerX);
  const scrollValues = [...new Set(frames.map((frame) => Math.round(frame.scrollTop)))];
  const result = { title: await page.title(), frames, summary: { frameCount: frames.length, distinctScrollPositions: scrollValues.length, centerSpread: centers.length ? Math.max(...centers) - Math.min(...centers) : null, reachedBottomFrame: frames.findIndex((frame) => frame.distance <= 1), unmountedFrame: frames.findIndex((frame) => !frame.buttonMounted) } };
  writeFileSync(path.join(process.cwd(), '.ai', `wmb-4102-${mode}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result.summary, null, 2));
  if (mode === 'after' && (result.summary.distinctScrollPositions < 3 || result.summary.centerSpread > 1 || result.summary.reachedBottomFrame < 1 || result.summary.unmountedFrame <= result.summary.reachedBottomFrame)) process.exitCode = 1;
} finally { await browser.close(); }
