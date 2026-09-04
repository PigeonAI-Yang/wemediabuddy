import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const DEBUG_PORT = 9322;
const SCREENSHOT = 'J:/wmb-out/installed-today-verify.png';
const REJECTED_TITLES = [
  'AI 服务先交付一张客户会反复打开的结果页',
  'AI 生成的图，为什么更适合交付成 HTML',
  '团队用 AI 开发，先把需求讲到不用问 AI',
  '让 AI 代填表之前，先把任务切成可检查的低风险步骤',
  '一个抠图工具，怎样变成能交付的轻量服务',
  '工具调用失败时，先查参数和停止条件，不要急着换模型',
  '先用“五要素”判断一项工作值不值得做成 AI Agent',
  '国家数字图书馆应该成为内容获取流程的第一步',
  '服装店尺码问答库，先交付一份能直接回复顾客的建议包',
];

async function getWsUrl() {
  for (let i=0;i<30;i++) {
    try {
      const data = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${DEBUG_PORT}/json`, res => {
          let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(d));
        }).on('error', reject);
      });
      const arr = JSON.parse(data);
      // find page with index.html
      const page = arr.find(e=> e.url && e.url.includes('index.html')) || arr[0];
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
async function getWsUrl() {
  for (let i=0;i<30;i++) {
    try {
      const data = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${DEBUG_PORT}/json`, res => {
          let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(d));
        }).on('error', reject);
      });
      const arr = JSON.parse(data);
      const page = arr.find(e=> e.url && e.url.includes('index.html')) || arr[0];
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await new Promise(r=>setTimeout(r,1000));
  }
  throw new Error('CDP not ready');
}

async function run() {
  // use endpointURL for playwright
  let browser;
  for (let i=0;i<10;i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
      break;
    } catch (e) {
      console.log('connect retry', i, e.message);
      await new Promise(r=>setTimeout(r,1000));
    }
  }
  if (!browser) throw new Error('failed to connectOverCDP');
  const context = browser.contexts()[0];
  const page = context.pages()[0];
  if (!page) throw new Error('no page found');
  console.log('page url', page.url());
  });
  page.on('pageerror', err => pageErrors.push(String(err)));
  // wait for app shell
  await page.waitForTimeout(2000);
  // try to click Today nav
  // find nav items: look for text 今日
  const navSelectors = ['text=今日', '[data-testid="nav-today"]', 'a:has-text("今日")', 'button:has-text("今日")', 'nav >> text=今日'];
  let clicked = false;
  for (const sel of navSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0) {
        console.log('clicking', sel);
        await el.click({ timeout: 2000 });
        clicked = true;
        break;
      }
    } catch {}
  }
  if (!clicked) console.log('no Today nav found via selectors, checking current view');
  await page.waitForTimeout(1500);
  // wait for today layout
  try {
    await page.waitForSelector('.today-layout', { timeout: 10000 });
    console.log('today-layout found');
  } catch { console.log('today-layout NOT found'); }
  try {
    await page.waitForSelector('.today-overview', { timeout: 5000 });
    console.log('today-overview found');
  } catch { console.log('today-overview NOT found'); }
  try {
    await page.waitForSelector('.app-shell', { timeout: 5000 });
    console.log('app-shell found');
  } catch { console.log('app-shell NOT found'); }
  // check Pi dock: look for pi-dock or similar
  const piSelectors = ['.pi-dock', '[data-testid="pi-dock"]', 'text=Pi', '.pi-open'];
  for (const sel of piSelectors) {
    try {
      const c = await page.locator(sel).count();
      console.log(`pi selector ${sel} count ${c}`);
    } catch {}
  }
  // check fermenting rail
  const fermentingText = await page.textContent('body').catch(()=> '');
  // check specific
  const hasFermentingHeader = fermentingText.includes('持续关注 · 主题 · 0');
  const hasEmpty = fermentingText.includes('没有需要持续关注的主题。');
  console.log('hasFermentingHeader', hasFermentingHeader);
  console.log('hasEmpty', hasEmpty);
  // check shell/Today/Pi visible via evaluate
  const domChecks = await page.evaluate(() => {
    const bodyText = document.body.innerText || '';
    const hasHeader = bodyText.includes('持续关注 · 主题 · 0');
    const hasEmpty = bodyText.includes('没有需要持续关注的主题。');
    const appShell = !!document.querySelector('.app-shell');
    const todayLayout = !!document.querySelector('.today-layout');
    const todayOverview = !!document.querySelector('.today-overview');
    const piDock = !!document.querySelector('.pi-dock') || !!document.querySelector('[data-testid="pi-dock"]') || document.body.innerText.includes('Pi');
    const piOpen = document.querySelector('.app-shell')?.classList.contains('pi-open');
    return { hasHeader, hasEmpty, appShell, todayLayout, todayOverview, piDock, piOpen, bodySnippet: bodyText.slice(0,2000) };
  });
  console.log('domChecks', domChecks);
  // check rejected titles
  const foundRejected = [];
  for (const t of REJECTED_TITLES) {
    if (fermentingText.includes(t)) foundRejected.push(t);
  }
  console.log('foundRejected', foundRejected);
  // check page errors via evaluate
  await page.waitForTimeout(1000);
  console.log('consoleErrors', consoleErrors);
  console.log('pageErrors', pageErrors);
  // screenshot
  await page.screenshot({ path: SCREENSHOT, fullPage: true });
  console.log('screenshot saved', SCREENSHOT, fs.statSync(SCREENSHOT).size);
  // also evaluate for any other errors
  const errors = { consoleErrors, pageErrors, hasFermentingHeader, hasEmpty, foundRejected, domChecks };
  fs.writeFileSync('J:/wmb-out/verify-result.json', JSON.stringify(errors, null, 2));
  console.log('verify done');
  await browser.close();
}

run().catch(e=>{ console.error(e); process.exit(1); });
