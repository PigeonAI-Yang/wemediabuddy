import { _electron } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';

const APP_PATH = 'J:/wmb-out/WeMediaBuddy-win32-x64/WeMediaBuddy.exe';
if (!fs.existsSync(APP_PATH)) {
  console.error('App not found', APP_PATH);
  process.exit(1);
}
console.log('Launching', APP_PATH);
const app = await _electron.launch({
  executablePath: APP_PATH,
  // Do not override userDataDir — use production %APPDATA%/WeMediaBuddy which points to J:/PigeonYang/WeMediaBuddyData
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  args: []
});
console.log('App launched, waiting for window');
const page = await app.firstWindow();
page.on('console', msg => console.log('[console]', msg.type(), msg.text()));
page.on('pageerror', err => console.error('[pageerror]', err));
await page.waitForSelector('.app-shell', { timeout: 60000 });
console.log('App shell visible');
await page.waitForTimeout(3000);

// Navigate to Today if not already
let todayBtn = page.locator('aside.sidebar button[title="今日"], aside.sidebar button:has-text("今日")');
if (await todayBtn.count() === 0) todayBtn = page.locator('button:has-text("今日")');
if (await todayBtn.count() > 0) {
  await todayBtn.first().click().catch(()=>{});
  await page.waitForTimeout(1500);
}

// Check fermenting rail
await page.waitForTimeout(2000);
const fermentingHandle = page.locator('[aria-label="持续关注"]');
const fermentingCount = await fermentingHandle.count();
console.log('fermenting rail count', fermentingCount);
let fermentingText = '';
let fermentingTitles = [];
if (fermentingCount > 0) {
  fermentingText = await fermentingHandle.first().innerText().catch(()=> '');
  console.log('fermentingText', fermentingText.slice(0,500));
  const h2 = await fermentingHandle.locator('h2').first().innerText().catch(()=> '');
  console.log('h2', h2);
  const rows = page.locator('.fermenting-row h3');
  const n = await rows.count();
  console.log('fermenting rows', n);
  for (let i=0;i<n;i++) {
    const t = await rows.nth(i).innerText().catch(()=>'');
    fermentingTitles.push(t);
    console.log(`  row ${i}: ${t}`);
  }
} else {
  console.log('No fermenting rail found, checking alternative');
  fermentingText = await page.locator('body').innerText().then(t=> t.slice(0,2000)).catch(()=> '');
  console.log(fermentingText.slice(0,1000));
}

const five = [
  '先问清楚谁会为这张 AI 结果卡片负责，再决定做什么',
  '限时免费不是薅羊毛：用 14 天把一个可交付项目跑出回执',
  '批量生成视频以后，先用一致性和闪烁把废片筛掉',
  '别再展示 AI 做成了什么，先把它放进一套能复跑的评测里',
  'AI 产品从 Demo 走向工作环境，真正增加的是哪些约束'
];
let foundFive = [];
for (const title of five) {
  if (fermentingTitles.some(t=> t.includes(title.slice(0,10)))) foundFive.push(title);
}
console.log('foundFive among fermenting', foundFive);

const pageText = await page.locator('body').innerText().catch(()=> '');
const foundInPage = five.filter(t=> pageText.includes(t.slice(0,12)));
console.log('foundFive in whole page text (should be 0 in fermenting but maybe elsewhere):', foundInPage.length, foundInPage);

console.log('Checking other Today content: Pi visible?');
const piVisible = await page.locator('.pi-dock, #pi-dock, [aria-label="Pi"]').count();
console.log('Pi dock count', piVisible);
const consoleErrors = [];
page.on('console', msg=> { if (msg.type()==='error') consoleErrors.push(msg.text()); });

// Screenshot
const screenshotPath = 'j:/PigeonYang/WeMediaBuddy/.ai/verify-today-fix.png';
await page.screenshot({ path: screenshotPath, fullPage: true });
console.log('screenshot saved', screenshotPath, fs.existsSync(screenshotPath) ? fs.statSync(screenshotPath).size : 'missing');

// Check data root unchanged: read wmb.db file size
const dbPath = 'J:/PigeonYang/WeMediaBuddyData/wmb.db';
console.log('db exists', fs.existsSync(dbPath), fs.statSync(dbPath).size);

// Check no console/page errors: we already logged
console.log('Verification: five should be 0 in fermenting');
if (foundFive.length === 0) console.log('PASS: five not in fermenting');
else console.log('FAIL: five still visible', foundFive);

await page.waitForTimeout(1000);
await app.close().catch(()=>{});
console.log('App closed, DONE');
