// WMB-1500 壳层视觉验证:隐藏真实 Electron + CDP 截图 + 溢出检查
import { spawn } from 'node:child_process';
import http from 'node:http';
import { chromium } from 'playwright-core';

const CDP = 9337;
const env = { ...process.env, WMB_ACCEPTANCE_CDP_PORT: String(CDP) };
delete env.WMB_ACCEPTANCE_HEADLESS;
const electronBin = new URL('../node_modules/electron/dist/electron.exe', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const child = spawn(electronBin, ['.'], { env, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
child.stderr.on('data', d => process.stderr.write(d));

const getJson = (path) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: CDP, path }, res => {
    let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
  }).on('error', reject);
});

async function waitCdp() {
  for (let i = 0; i < 240; i++) {
    try { return await getJson('/json/version'); } catch { await new Promise(r => setTimeout(r, 1000)); }
  }
  throw new Error('CDP not ready');
}

const cleanup = () => { try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch {} };
process.on('exit', cleanup);

let failed = null;
try {
  await waitCdp();
  console.log('CDP ready, connecting…');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`);
  const page = browser.contexts()[0].pages()[0];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.type(), m.text().slice(0, 300)); });
  page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 500)));
  await page.goto('file:///J:/PigeonYang/WeMediaBuddy/.vite/renderer/main_window/index.html');
  await page.waitForTimeout(2000);
  try {
    await page.waitForSelector('.sidebar button', { state: 'attached', timeout: 45000 });
  } catch (e) {
    const html = await page.evaluate(() => document.body.innerHTML.slice(0, 1200)).catch(() => '<evaluate failed>');
    console.log('BODY:', html);
    throw e;
  }
  await page.waitForTimeout(1500);
  console.log('shell rendered');

  const views = ['today', 'studio', 'publish', 'results', 'knowledge', 'library', 'canvas', 'settings'];
  const report = {};
  const pageSession = await page.context().newCDPSession(page);
  for (const size of [{ w: 1100, h: 700 }, { w: 1920, h: 900 }]) {
    await pageSession.send('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: 1, mobile: false });
    await page.waitForTimeout(500);
    for (const v of views) {
      await page.evaluate((title) => {
        const btn = Array.from(document.querySelectorAll('.sidebar button')).find(b => b.getAttribute('title') === title);
        btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }, { today: '今日', studio: '创作', publish: '发布', results: '结果', knowledge: '知识系统', library: '资料库', canvas: '关系画布', settings: '设置' }[v]);
      await page.waitForTimeout(700);
      const overflow = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        body: document.body.scrollWidth > document.body.clientWidth + 1
      }));
      report[`${v}@${size.w}`] = overflow;
      const shotBuf = await page.screenshot();
      const { writeFileSync } = await import('node:fs');
      writeFileSync(`.ai/wmb-1500-${v}-${size.w}.png`, shotBuf);
    }
  }
  console.log(JSON.stringify(report, null, 1));
  await browser.close();
} catch (error) {
  failed = error;
  console.error('CHECK FAILED:', error?.message || error);
} finally {
  cleanup();
  await new Promise(r => setTimeout(r, 1500));
  process.exit(failed ? 1 : 0);
}
