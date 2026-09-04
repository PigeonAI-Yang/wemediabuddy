import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const harnessPath = path.join(repoRoot, "tests/e2e/harness.mjs");
const harness = await import(pathToFileURL(harnessPath).href);
const { launchApp, waitForAppReady, navigateTo, delay } = harness;
const REAL_DB = "J:/PigeonYang/WeMediaBuddyData/wmb.db";
const PACKAGED_APP_DIR = "J:/wmb-out/WeMediaBuddy-win32-x64";
const PROJECT_ID = "6ce12d8a-d12d-449d-baca-fcdc55b0f3c8";
const WORKSPACE_ID = "a755adf2-4e8d-4abd-b616-4d7934f730f1";
import { copyFileSync } from "node:fs";
async function seedFixture({dataRoot}){
  copyFileSync(REAL_DB, path.join(dataRoot, "wmb.db"));
}
console.log("[before] launching packaged app", PACKAGED_APP_DIR);
const {app, page} = await launchApp({
  appPath: PACKAGED_APP_DIR,
  workspaceId: WORKSPACE_ID,
  displayName: "AI",
  seedFixture,
  headless: false,
});
try{
  await waitForAppReady(page);
  await page.setViewportSize({width:1568, height:941});
  console.log("[before] viewport 1568x941");
  await delay(1500);
  await navigateTo(page, "studio");
  await delay(1500);
  const storageKey = `wmb.workspace.${WORKSPACE_ID}.studioSelectedId`;
  await page.evaluate(({key,val})=>localStorage.setItem(key,val), {key:storageKey, val:PROJECT_ID});
  await page.reload({waitUntil:"domcontentloaded"});
  await waitForAppReady(page);
  await delay(2000);
  await navigateTo(page, "studio");
  await delay(1500);
  await page.waitForSelector(".studio-formatbar", {timeout:15000});
  await page.setViewportSize({width:1568, height:941});
  await delay(500);
  const dom = await page.evaluate(()=>{
    const bar = document.querySelector(".studio-formatbar");
    const barRect = bar ? bar.getBoundingClientRect() : null;
    const barStyle = bar ? getComputedStyle(bar) : null;
    const groups = [...document.querySelectorAll(".studio-formatbar .studio-formatbar-group")];
    const groupRects = groups.map(g=> { const r=g.getBoundingClientRect(); const s=getComputedStyle(g); return {label:g.getAttribute("aria-label")||"", left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height, display:s.display, marginLeft:s.marginLeft, flex:s.flex}; });
    const barWidth = barRect ? barRect.width : 0;
    const groupsTotalWidth = groupRects.reduce((s,g)=> s+g.width,0) + (groups.length-1)*4; // gap 4
    const remaining = barWidth - groupsTotalWidth;
    // capture controls for row assignment
    const nodes = bar ? [...bar.querySelectorAll("select, button")] : [];
    const controls = nodes.map(n=> { const r=n.getBoundingClientRect(); return {text:(n.textContent||"").trim()||n.getAttribute("title")||"", tag:n.tagName, left:r.left, top:r.top, width:r.width, height:r.height}; }).filter(c=>c.width>0);
    // row assignment by top
    const tops = [...new Set(controls.map(c=> c.top.toFixed(1)))].sort((a,b)=> parseFloat(a)-parseFloat(b));
    const rows = tops.map(t=> controls.filter(c=> c.top.toFixed(1)===t).map(c=> `${c.text}(${c.left.toFixed(0)},w${c.width.toFixed(0)})` ));
    // unused first-row width: bar right - last control in first row right - padding? bar has padding 12px each side? Use barRect.right - lastFirstRow.right
    const firstRowTops = tops[0];
    const firstRowControls = controls.filter(c=> c.top.toFixed(1)===firstRowTops);
    const lastFirst = firstRowControls[firstRowControls.length-1];
    const unused = barRect ? (barRect.right - (lastFirst ? lastFirst.left+lastFirst.width : barRect.left) - 12) : null; // 12 padding right
    // alternative: bar inner width (clientWidth) - used
    const barInnerWidth = bar ? bar.clientWidth - 24 : null; // padding 12+12
    const usedFirstRowWidth = firstRowControls.reduce((s,c,i)=> s + c.width + (i>0?4:0),0); // gap 4
    const unusedPrecise = barInnerWidth !==null ? barInnerWidth - usedFirstRowWidth : null;
    return {barRect: barRect? {left:barRect.left, top:barRect.top, width:barRect.width, height:barRect.height, right:barRect.right}:null, barStyle: barStyle? {display:barStyle.display, flexWrap:barStyle.flexWrap, gap:barStyle.gap, padding:barStyle.padding, width:barStyle.width}:null, groupRects, groupsTotalWidth, remainingIfSingleRow: remaining, controls, tops, rows, firstRowControls: firstRowControls.map(c=>c.text), lastFirst, unused, barInnerWidth, usedFirstRowWidth, unusedPrecise, viewport: {width:1568, height:941}};
  });
  console.log("[before] dom", JSON.stringify(dom,null,2));
  // also write to file
  writeFileSync(path.join(repoRoot, ".ai/frontend-debug-loop/reports/before-flatten.json"), JSON.stringify(dom,null,2));
  // also capture for report
} finally {
  const { closeApp } = harness;
  try{ await closeApp(app, {timeoutMs:15000}); console.log("[before] closed"); } catch(e){ console.log(e); }
}
