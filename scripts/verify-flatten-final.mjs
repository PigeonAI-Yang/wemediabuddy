import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdirSync, writeFileSync, copyFileSync, existsSync, statSync } from "node:fs";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const harnessPath = path.join(repoRoot, "tests/e2e/harness.mjs");
const harness = await import(pathToFileURL(harnessPath).href);
const { launchApp, waitForAppReady, navigateTo, delay } = harness;
const REAL_DB = "J:/PigeonYang/WeMediaBuddyData/wmb.db";
const PACKAGED_APP_DIR = "J:/wmb-out/WeMediaBuddy-win32-x64";
const REPORT_DIR = path.join(repoRoot, ".ai", "frontend-debug-loop", "reports");
const SCREENSHOT_PATH = path.join(REPORT_DIR, "2026-08-24-studio-formatbar-flatten.png");
const PROJECT_ID = "6ce12d8a-d12d-449d-baca-fcdc55b0f3c8";
const WORKSPACE_ID = "a755adf2-4e8d-4abd-b616-4d7934f730f1";
mkdirSync(REPORT_DIR, {recursive:true});
async function seedFixture({dataRoot}){
  copyFileSync(REAL_DB, path.join(dataRoot, "wmb.db"));
  console.log(`[verify-flatten] copied DB to ${path.join(dataRoot,"wmb.db")}`);
}
console.log("[verify-flatten] launching PACKAGED app for final verification", PACKAGED_APP_DIR);
const {app, page, evidence} = await launchApp({
  appPath: PACKAGED_APP_DIR,
  workspaceId: WORKSPACE_ID,
  displayName: "AI",
  seedFixture,
  headless: false,
  artifactsDir: REPORT_DIR,
});
let dom=null;
let screenshotSize=0;
let consoleErrors=0;
try{
  await waitForAppReady(page);
  console.log("[verify-flatten] app ready");
  await page.setViewportSize({width:1568, height:941});
  console.log("[verify-flatten] viewport 1568x941 set");
  await delay(1500);
  await navigateTo(page, "studio");
  console.log("[verify-flatten] navigated to studio");
  await delay(1500);
  const storageKey = `wmb.workspace.${WORKSPACE_ID}.studioSelectedId`;
  await page.evaluate(({key,val})=> localStorage.setItem(key,val), {key:storageKey, val:PROJECT_ID});
  console.log(`[verify-flatten] set ${storageKey}=${PROJECT_ID}`);
  await page.reload({waitUntil:"domcontentloaded"});
  await waitForAppReady(page);
  await delay(2000);
  await navigateTo(page, "studio");
  await delay(1500);
  await page.waitForSelector(".studio-formatbar", {timeout:15000});
  await page.waitForSelector(".studio-document", {timeout:15000});
  await page.setViewportSize({width:1568, height:941});
  await delay(500);
  dom = await page.evaluate(()=>{
    const bar = document.querySelector(".studio-formatbar");
    const barRect = bar ? bar.getBoundingClientRect() : null;
    const barStyle = bar ? getComputedStyle(bar) : null;
    const dividerEls = document.querySelectorAll(".studio-divider");
    const groups = [...document.querySelectorAll(".studio-formatbar .studio-formatbar-group")];
    const groupStyles = groups.map(g=>{
      const s=getComputedStyle(g);
      return {label:g.getAttribute("aria-label")||"", display:s.display, marginLeft:s.marginLeft, borderLeftWidth:s.borderLeftWidth, borderLeftStyle:s.borderLeftStyle, width:g.getBoundingClientRect().width};
    });
    const groupRects = groups.map(g=>{ const r=g.getBoundingClientRect(); return {label:g.getAttribute("aria-label")||"", left:r.left, top:r.top, width:r.width, height:r.height}; });
    // controls in order
    const nodes = bar ? [...bar.querySelectorAll("select, button")] : [];
    const controls = nodes.map(n=>{
      const r=n.getBoundingClientRect();
      const s=getComputedStyle(n);
      return {
        tag:n.tagName,
        text:(n.textContent||"").trim() || (n.getAttribute("title")||"") || (n.getAttribute("aria-label")||""),
        title:n.getAttribute("title")||"",
        ariaLabel:n.getAttribute("aria-label")||"",
        left:r.left, top:r.top, right:r.right, width:r.width, height:r.height,
        visible: r.width>0 && r.height>0 && s.display!=="none"
      };
    }).filter(c=>c.visible);
    const visibleOrder = controls.map(c=> c.text);
    // divider count visible
    const dividerCount = [...dividerEls].filter(el=>{ const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0 && r.height>0 && s.display!=="none"; }).length;
    const borderLefts = groups.map(g=>{ const s=getComputedStyle(g); return s.borderLeftWidth+" "+s.borderLeftStyle+" "+s.borderLeftColor; });
    const hasBorderDivider = borderLefts.some(v=> !v.startsWith("0px"));
    // auto margin check: any group or illustration with marginLeft auto? also bar children
    const autoMargin = groups.some(g=>{
      const s=getComputedStyle(g);
      return s.marginLeft==="auto" || s.marginLeft.includes("auto");
    }) || (()=>{ const ill=document.querySelector(".studio-formatbar-illustration"); if(!ill) return false; const s=getComputedStyle(ill); return s.marginLeft==="auto"; })()
      || (()=>{ if(!bar) return false; const s=getComputedStyle(bar); return s.justifyContent==="space-between"; })();
    // row assignment by top
    const tops = [...new Set(controls.map(c=> c.top.toFixed(1)))].sort((a,b)=> parseFloat(a)-parseFloat(b));
    const rows = tops.map(t=> controls.filter(c=> c.top.toFixed(1)===t).map(c=> `${c.text}(${c.left.toFixed(0)},w${c.width.toFixed(0)})`));
    const rowAssignments = controls.map(c=> ({text:c.text, left:c.left, top:c.top, row: tops.indexOf(c.top.toFixed(1))+1, width:c.width}));
    // first row unused width
    const barInnerWidth = bar ? bar.clientWidth - 24 : null; // padding 12+12
    const firstRowTops = tops[0];
    const firstRowControls = controls.filter(c=> c.top.toFixed(1)===firstRowTops);
    const usedFirstRowWidth = firstRowControls.reduce((s,c,i)=> s + c.width + (i>0?4:0),0); // gap 4px
    const unusedFirstRowWidth = barInnerWidth!==null ? barInnerWidth - usedFirstRowWidth : null;
    // group-sized blank remainder check: previous unused was 93 with wrap of 240 group; now should be small
    // also compute gaps between controls
    const controlGaps=[];
    for(let i=0;i<controls.length-1;i++){
      const gap = controls[i+1].left - controls[i].right;
      controlGaps.push({pair:`${controls[i].text} -> ${controls[i+1].text}`, gap});
    }
    // groupGaps if any groups visible (display contents will have width 0, but we capture)
    const groupGaps=[];
    for(let i=0;i<groupRects.length-1;i++){
      const gap = groupRects[i+1].left - groupRects[i].right;
      groupGaps.push(gap);
    }
    // toolbar visible and body visible
    const toolbarVisible = !!(bar && bar.getBoundingClientRect().height>0 && getComputedStyle(bar).display!=="none");
    const canvas = document.querySelector(".studio-canvas");
    const paper = document.querySelector(".studio-paper");
    const bodyVisible = !!( (canvas && canvas.getBoundingClientRect().height>0) || (paper && paper.getBoundingClientRect().height>0) );
    // focused check: focus first select
    const first = bar ? bar.querySelector("select, button") : null;
    let focusedCheck="";
    if(first){
      first.focus();
      focusedCheck = `focused=${document.activeElement===first} tag=${document.activeElement?.tagName} text=${(document.activeElement?.textContent||"").trim().slice(0,30)}`;
    }
    // check divider count total
    const dividerElsTotal = dividerEls.length;
    // check if any control shrunk? ensure min-width 32 etc? we just ensure widths not 0
    return {
      barRect: barRect? {left:barRect.left, top:barRect.top, width:barRect.width, height:barRect.height, right:barRect.right, bottom:barRect.bottom}:null,
      barStyle: barStyle? {display:barStyle.display, flexWrap:barStyle.flexWrap, gap:barStyle.gap, padding:barStyle.padding, width:barStyle.width}:null,
      barInnerWidth,
      usedFirstRowWidth,
      unusedFirstRowWidth,
      dividerCount,
      dividerElsTotal,
      hasBorderDivider,
      borderLefts,
      groupStyles,
      groupRects,
      groupGaps,
      visibleOrder,
      controls,
      rowAssignments,
      tops,
      rows,
      firstRowControls: firstRowControls.map(c=>c.text),
      controlGaps,
      autoMargin,
      toolbarVisible,
      bodyVisible,
      focusedCheck
    };
  });
  console.log("[verify-flatten] dom", JSON.stringify(dom,null,2));
  consoleErrors = (evidence.pageerrors?.length||0) + (evidence.errors?.length||0);
  console.log(`[verify-flatten] consoleErrors ${consoleErrors} pageerrors`, evidence.pageerrors, "errors", evidence.errors);
  console.log("[verify-flatten] console logs", evidence.console?.slice(0,10));
  await page.screenshot({path: SCREENSHOT_PATH, fullPage:false});
  console.log(`[verify-flatten] screenshot saved ${SCREENSHOT_PATH} size ${statSync(SCREENSHOT_PATH).size}`);
  screenshotSize = statSync(SCREENSHOT_PATH).size;
  const result = {
    barRect: dom.barRect,
    barInnerWidth: dom.barInnerWidth,
    usedFirstRowWidth: dom.usedFirstRowWidth,
    unusedFirstRowWidth: dom.unusedFirstRowWidth,
    dividerCount: dom.dividerCount,
    hasBorderDivider: dom.hasBorderDivider,
    borderLefts: dom.borderLefts,
    groupStyles: dom.groupStyles,
    visibleOrder: dom.visibleOrder,
    rowAssignments: dom.rowAssignments,
    rows: dom.rows,
    tops: dom.tops,
    firstRowControls: dom.firstRowControls,
    controlGaps: dom.controlGaps,
    groupGaps: dom.groupGaps,
    autoMargin: dom.autoMargin,
    toolbarVisible: dom.toolbarVisible,
    bodyVisible: dom.bodyVisible,
    consoleErrors,
    focusedCheck: dom.focusedCheck,
    viewport: {width:1568, height:941},
    projectId: PROJECT_ID,
    workspaceId: WORKSPACE_ID
  };
  writeFileSync(path.join(REPORT_DIR, "verify-flatten-result.json"), JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
  // assertions per contract
  if(dom.dividerCount!==0) throw new Error(`dividerCount expected 0 got ${dom.dividerCount} total ${dom.dividerElsTotal}`);
  if(dom.hasBorderDivider) throw new Error(`hasBorderDivider true borderLefts=${JSON.stringify(dom.borderLefts)}`);
  if(dom.autoMargin) throw new Error(`autoMargin true groupStyles=${JSON.stringify(dom.groupStyles)}`);
  if(!dom.toolbarVisible) throw new Error("toolbar not visible");
  if(!dom.bodyVisible) throw new Error("body not visible");
  if(consoleErrors!==0) throw new Error(`consoleErrors ${consoleErrors}`);
  // order check: exact 17 controls in expected order
  const expected = ["正文","B","I","S","<>","• 列表","1. 列表","链接","代码块","表格","分割线","图片","清除","↶","↷","查找替换","标记"];
  // visibleOrder first entry is combined select text, map to 正文
  const normalized = dom.visibleOrder.map(v=> v.includes("正文") ? "正文" : v);
  if(normalized.length!==17) throw new Error(`visibleOrder length expected 17 got ${normalized.length} ${JSON.stringify(normalized)}`);
  for(let i=0;i<expected.length;i++){
    if(normalized[i]!==expected[i]) throw new Error(`order mismatch at ${i} expected ${expected[i]} got ${normalized[i]} full ${JSON.stringify(normalized)}`);
  }
  // first row must use available width: unused small < 40? previous 93 now should be less than 60 and not group-sized
  if(dom.unusedFirstRowWidth!==null && dom.unusedFirstRowWidth>50) {
    // allow up to 50 but previous was 93, so new should be <50 to show improvement; if >50, still fail as not filling
    throw new Error(`unusedFirstRowWidth too large ${dom.unusedFirstRowWidth} expected <50 to prove fill, used ${dom.usedFirstRowWidth} inner ${dom.barInnerWidth}`);
  }
  if(dom.unusedFirstRowWidth!==null && dom.unusedFirstRowWidth<0) throw new Error(`unused negative ${dom.unusedFirstRowWidth}`);
  // wrap must be between individual controls, not group-sized: check that second row first control is not the start of a group of 5 that wrapped together? For flatten, second row should have fewer than 5 controls if first row filled more. Previously second row had 5 (清除 group). Now with flatten, second row should have maybe 2-3 controls (since first row holds ~14-15). Let's check.
  if(dom.rows.length!==2) throw new Error(`expected 2 rows got ${dom.rows.length} rows ${JSON.stringify(dom.rows)}`);
  const firstRowCount = dom.rows[0].length;
  const secondRowCount = dom.rows[1].length;
  // first row should have more than 12 (previously 12) to prove fill; at least 13
  if(firstRowCount <= 12) throw new Error(`firstRowCount expected >12 to prove fill got ${firstRowCount} rows ${JSON.stringify(dom.rows)}`);
  // ensure gaps normal 4px except wrap
  const badGaps = dom.controlGaps.filter(c=> c.gap<-10 && c.gap>-630 || c.gap>10);
  // Actually we expect one large negative gap at wrap, others ~4
  const normalGaps = dom.controlGaps.filter(c=> Math.abs(c.gap - 4) < 0.5);
  if(normalGaps.length < 15) throw new Error(`normal gaps expected at least 15 with 4px got ${normalGaps.length} gaps ${JSON.stringify(dom.controlGaps)}`);
  console.log("VERIFICATION PASSED FLATTEN");
} finally {
  const { closeApp } = harness;
  try{ await closeApp(app, {timeoutMs:15000}); console.log("[verify-flatten] closed test app"); } catch(e){ console.log("[verify-flatten] closeApp error", e); }
}
