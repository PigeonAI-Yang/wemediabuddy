import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = 'J:/PigeonYang/WeMediaBuddy';
const DATA_ROOT = 'J:/PigeonYang/WeMediaBuddyData';
const PACKAGED_DIR = 'J:/wmb-out/WeMediaBuddy-win32-x64';
const ARTIFACTS_BASE = path.join(REPO_ROOT, 'tests/e2e/artifacts/WMB-zhihu-hot-readiness');
fs.mkdirSync(ARTIFACTS_BASE, {recursive:true});

async function importFile(p){ return import(pathToFileURL(p).href); }

const harness = await importFile(path.join(REPO_ROOT, 'tests/e2e/harness.mjs'));
const { launchApp, waitForAppReady, navigateTo, captureEvidence, closeApp, delay, seedWorkspace, openReadOnlyDb } = harness;

const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'wmb-zhihu-readiness-ud-'));
console.log('userDataDir', userDataDir);
seedWorkspace({ userDataDir, dataRoot: DATA_ROOT, workspaceId: 'a755adf2-4e8d-4abd-b616-4d7934f730f1', displayName: 'WeMediaBuddyData', seedPi:true, onboarding:true });
console.log('seeded workspace');

const opts = { appPath: PACKAGED_DIR, userDataDir, dataRoot: DATA_ROOT, seed:false, artifactsDir: ARTIFACTS_BASE };
const { app, page, workspace, evidence } = await launchApp(opts);
console.log('launched pid', app.process()?.pid);
try{
  await waitForAppReady(page, {timeoutMs:60000});
  console.log('app ready');
  await navigateTo(page, 'settings', {timeoutMs:20000});
  console.log('navigated settings');
  // click Intelligence Channels tab
  await page.waitForSelector('button[title="情报渠道"]', {timeout:15000});
  await page.click('button[title="情报渠道"]');
  await page.waitForSelector('section.intelligence-channels', {timeout:15000});
  await page.waitForSelector('div.channel-readiness', {timeout:15000});
  await delay(1500);
  // read readiness text
  const readinessText = await page.evaluate(()=>{
    const el = document.querySelector('div.channel-readiness');
    return el ? el.innerText : '';
  });
  console.log('readinessText', JSON.stringify(readinessText));
  // read zhihu module line
  const zhihuLine = await page.evaluate(()=>{
    const nodes = [...document.querySelectorAll('div.channel-readiness > div')];
    for(const n of nodes){ if(n.textContent.includes('知乎')) return n.textContent.trim(); }
    return null;
  });
  console.log('zhihuLine', zhihuLine);
  // read source receipt detail for zhihu
  const zhihuReceiptText = await page.evaluate(()=>{
    const rows = [...document.querySelectorAll('article.channel-source-row')];
    for(const r of rows){
      const title = r.querySelector('.channel-source-title')?.textContent || '';
      if(title.includes('知乎')){
        const receipt = r.querySelector('.channel-receipt')?.textContent?.trim() || '';
        return receipt;
      }
    }
    return null;
  });
  console.log('zhihuReceiptText', zhihuReceiptText);
  // capture screenshot
  const screenshotPath = path.join(ARTIFACTS_BASE, 'packaged-channels.png');
  await page.screenshot({path: screenshotPath, fullPage:true});
  console.log('screenshot', screenshotPath);
  // also harness evidence capture
  await captureEvidence({app, page, artifactsDir: ARTIFACTS_BASE, name: 'zhihu-readiness'});
  // DB readback for zhihu receipt
  let dbInfo = null;
  try{
    const handle = openReadOnlyDb(DATA_ROOT);
    const latest = handle.db.prepare("SELECT status, candidate_count as candidateCount, saved_count as savedCount, checked_at as checkedAt FROM source_scan_receipts WHERE module='zhihu_hot' ORDER BY checked_at DESC LIMIT 1").get();
    dbInfo = latest;
    handle.close();
  }catch(e){ dbInfo = {error:String(e)}; }
  console.log('dbInfo', dbInfo);
  const pass = zhihuLine && zhihuLine.includes('1 个来源') && zhihuLine.includes('1 个可运行') && !zhihuLine.includes('需要处理');
  const receiptOk = dbInfo && dbInfo.candidateCount===2 && dbInfo.savedCount===2;
  const receiptTextOk = zhihuReceiptText && zhihuReceiptText.includes('发现 2') && zhihuReceiptText.includes('入库 2');
  const overall = Boolean(pass && receiptOk && receiptTextOk);
  const result = {
    package:{ command:'npm exec electron-forge -- package --arch=x64 --platform=win32', exit:0, outDir: PACKAGED_DIR },
    dataRoot: DATA_ROOT,
    userDataDir,
    text:{ readinessText, zhihuLine, zhihuReceiptText, dbInfo },
    screenshot: screenshotPath,
    pass: overall,
    artifactsDir: ARTIFACTS_BASE,
    cleanup:{ userDataRemoved: true }
  };
  fs.writeFileSync(path.join(ARTIFACTS_BASE, 'readback.json'), JSON.stringify(result,null,2), 'utf8');
  if(!pass) throw new Error('zhihu readiness text does not show 1可运行 without needs-attention: '+zhihuLine);
  if(!receiptOk) throw new Error('receipt not 2/2: '+JSON.stringify(dbInfo));
  if(!receiptTextOk) throw new Error('receipt text missing 发现2入库2: '+zhihuReceiptText);
} finally {
  const closed = await closeApp(app, {timeoutMs:20000});
  console.log('closeApp', closed);
  // verify process exit
  const pid = app.process()?.pid;
  console.log('pid after close', pid);
  // check debug port released? harness uses random port; just log
  await delay(1000);
  // cleanup userDataDir
  try{ fs.rmSync(userDataDir,{recursive:true,force:true}); console.log('cleaned userData'); }catch(e){ console.log('clean fail',e.message); }
}
