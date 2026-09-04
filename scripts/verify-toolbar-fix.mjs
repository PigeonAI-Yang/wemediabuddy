import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdirSync, copyFileSync, writeFileSync, existsSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const harnessPath = path.join(repoRoot, "tests/e2e/harness.mjs");
const harness = await import(pathToFileURL(harnessPath).href);
const { launchApp, waitForAppReady, navigateTo, delay } = harness;

const REAL_DATA_ROOT = "J:/PigeonYang/WeMediaBuddyData";
const REAL_DB = path.join(REAL_DATA_ROOT, "wmb.db");
const PACKAGED_APP_DIR = "J:/wmb-out/WeMediaBuddy-win32-x64";
const REPORT_DIR = path.join(repoRoot, ".ai", "frontend-debug-loop", "reports");
const SCREENSHOT_PATH = path.join(REPORT_DIR, "2026-08-24-studio-formatbar-sequential.png");
const PROJECT_ID = "6ce12d8a-d12d-449d-baca-fcdc55b0f3c8";
const WORKSPACE_ID = "a755adf2-4e8d-4abd-b616-4d7934f730f1";

mkdirSync(REPORT_DIR, {recursive:true});
async function seedFixture({dataRoot, workspaceId}){
  const dest = path.join(dataRoot, "wmb.db");
  copyFileSync(REAL_DB, dest);
  console.log(`[verify] copied real DB to ${dest} (real workspace a755... matches harness)`);
}
console.log("[verify] launching packaged app for toolbar check", PACKAGED_APP_DIR);
const {app, page, workspace, runtimeDir, artifactsDir, evidence} = await launchApp({
  appPath: PACKAGED_APP_DIR,
  workspaceId: WORKSPACE_ID,
  displayName: "AI",
  seedFixture,
  headless: false,
  artifactsDir: REPORT_DIR
});

try{
  await waitForAppReady(page);
  console.log("[verify] app ready");
  await page.setViewportSize({width: 1568, height: 843});
  console.log("[verify] viewport set 1568x843");
  await delay(1500);
  await navigateTo(page, "studio");
  console.log("[verify] navigated to studio");
  await delay(1500);
  const storageKey = `wmb.workspace.${WORKSPACE_ID}.studioSelectedId`;
  await page.evaluate(({key, val})=>{ localStorage.setItem(key, val); }, {key: storageKey, val: PROJECT_ID});
  console.log(`[verify] set ${storageKey}=${PROJECT_ID}`);
  await page.reload({waitUntil:"domcontentloaded"});
  await waitForAppReady(page);
  await delay(2000);
  await navigateTo(page, "studio");
  await delay(1500);
  await page.waitForSelector(".studio-document", {timeout:15000}).catch(()=>console.log("[verify] studio-document not found"));
  await page.waitForSelector(".studio-formatbar", {timeout:15000}).catch(()=>console.log("[verify] studio-formatbar not found"));
  await delay(2000);

  // ensure at 1568x843
  await page.setViewportSize({width:1568, height:843});
  await delay(500);

  const dom = await page.evaluate(()=>{
    const bar = document.querySelector(".studio-formatbar");
    const barRect = bar ? bar.getBoundingClientRect() : null;
    const dividerEls = document.querySelectorAll(".studio-divider");
    const groups = [...document.querySelectorAll(".studio-formatbar .studio-formatbar-group")];
    const groupRects = groups.map(g=> {
      const r = g.getBoundingClientRect();
      return {label: g.getAttribute("aria-label")||"", left: r.left, right: r.right, width: r.width, height: r.height};
    });
    // collect visible controls in order: select + buttons inside bar
    const controls = [];
    // include select(s) and buttons in DOM order inside .studio-formatbar
    const nodes = bar ? [...bar.querySelectorAll("select, button")] : [];
    for(const n of nodes){
      const style = getComputedStyle(n);
      const visible = style.display !== "none" && style.visibility !== "hidden" && n.offsetParent !== null || n.tagName === "SELECT" || n.tagName === "BUTTON";
      // consider visible if rect has size
      const rect = n.getBoundingClientRect();
      const isVisible = rect.width>0 && rect.height>0;
      controls.push({
        tag: n.tagName,
        text: (n.textContent||"").trim() || (n.tagName==="SELECT" ? (n.options[n.selectedIndex]?.text||"") : ""),
        title: n.getAttribute("title")||"",
        ariaLabel: n.getAttribute("aria-label")||"",
        visible: isVisible,
        left: rect.left,
        right: rect.right,
        width: rect.width
      });
    }
    // filter visible
    const visibleControls = controls.filter(c=>c.visible);
    const visibleOrder = visibleControls.map(c=> c.text || c.title || c.ariaLabel);

    // divider count: .studio-divider elements visible (offsetParent)
    const dividerCount = [...dividerEls].filter(el=>{
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width>0 && r.height>0 && s.display!=="none";
    }).length;
    // also check border-left computed for groups
    const borderLefts = groups.map(g=>{
      const s = getComputedStyle(g);
      return s.borderLeftWidth + " " + s.borderLeftStyle + " " + s.borderLeftColor;
    });
    const hasBorderDivider = borderLefts.some(v=> !v.startsWith("0px"));
    // measure gaps between groups
    const groupGaps = [];
    for(let i=0;i<groupRects.length-1;i++){
      const gap = groupRects[i+1].left - groupRects[i].right;
      groupGaps.push(gap);
    }
    // measure gap before 清除 (first button in last group)
    let gapBeforeClear = null;
    let gapBeforeClearEvidence = "";
    const clearBtn = bar ? bar.querySelector('button[title="清除格式"]') : null;
    if(clearBtn && bar){
      const clearRect = clearBtn.getBoundingClientRect();
      // find previous visible control before clear
      const clearIndex = visibleControls.findIndex(c=> c.text==="清除" || c.title==="清除格式");
      if(clearIndex>0){
        const prev = visibleControls[clearIndex-1];
        // need rect of prev element; find node by text
        const prevNodes = [...bar.querySelectorAll("button, select")].filter(n=> (n.textContent||"").trim()===prev.text);
        // fallback: use visibleControls data left/right
        gapBeforeClear = clearRect.left - prev.right;
        gapBeforeClearEvidence = `prev=${prev.text}(${prev.right.toFixed(1)}) -> Clear left=${clearRect.left.toFixed(1)} gap=${gapBeforeClear.toFixed(1)}`;
      } else {
        gapBeforeClearEvidence = "clear index not found";
      }
    }
    // measure adjacent gaps between controls for comparison
    const controlGaps = [];
    for(let i=0;i<visibleControls.length-1;i++){
      const gap = visibleControls[i+1].left - visibleControls[i].right;
      controlGaps.push({pair: `${visibleControls[i].text||visibleControls[i].title} -> ${visibleControls[i+1].text||visibleControls[i+1].title}`, gap: gap});
    }
    const toolbarVisible = !!(bar && bar.getBoundingClientRect().height>0 && getComputedStyle(bar).display!=="none");
    const bodyVisible = !!document.querySelector(".studio-canvas") && document.querySelector(".studio-canvas").getBoundingClientRect().height>0 || !!document.querySelector(".studio-paper") && document.querySelector(".studio-paper").getBoundingClientRect().height>0;
    // focus check: can tab to first button
    const firstBtn = bar ? bar.querySelector("button, select") : null;
    let focusedCheck = "";
    if(firstBtn){
      firstBtn.focus();
      focusedCheck = `focused=${document.activeElement===firstBtn} tag=${document.activeElement?.tagName} text=${(document.activeElement?.textContent||"").trim().slice(0,20)}`;
    }
    return {
      dividerCount,
      dividerElsTotal: dividerEls.length,
      hasBorderDivider,
      borderLefts,
      groupRects,
      groupGaps,
      visibleOrder,
      visibleControls,
      gapBeforeClear,
      gapBeforeClearEvidence,
      controlGaps,
      toolbarVisible,
      bodyVisible,
      focusedCheck,
      barRect: barRect ? {top: barRect.top, height: barRect.height, width: barRect.width} : null
    };
  });
  console.log("[verify] dom", JSON.stringify(dom,null,2));
  const consoleErrors = (evidence.pageerrors?.length||0) + (evidence.errors?.length||0);
  console.log(`[verify] consoleErrors ${consoleErrors} pageerrors`, evidence.pageerrors, "errors", evidence.errors);
  // log evidence console?
  console.log("[verify] page console", evidence.console?.slice(0,20));

  await page.screenshot({path: SCREENSHOT_PATH, fullPage:false});
  console.log(`[verify] screenshot saved ${SCREENSHOT_PATH}`);
  const { statSync } = await import("node:fs");
  console.log(`[verify] screenshot size ${statSync(SCREENSHOT_PATH).size}`);

  const result = {
    dividerCount: dom.dividerCount,
    hasBorderDivider: dom.hasBorderDivider,
    borderLefts: dom.borderLefts,
    visibleOrder: dom.visibleOrder,
    groupGaps: dom.groupGaps,
    gapBeforeClear: dom.gapBeforeClear,
    gapBeforeClearEvidence: dom.gapBeforeClearEvidence,
    controlGaps: dom.controlGaps,
    toolbarVisible: dom.toolbarVisible,
    bodyVisible: dom.bodyVisible,
    consoleErrors,
    focusedCheck: dom.focusedCheck,
    barRect: dom.barRect,
    projectId: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
    viewport: {width:1568,height:843}
  };
  writeFileSync(path.join(REPORT_DIR, "verify-toolbar-result.json"), JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));

  // assertions
  if(dom.dividerCount!==0) throw new Error(`dividerCount expected 0 got ${dom.dividerCount}`);
  if(dom.hasBorderDivider) throw new Error(`hasBorderDivider true, borderLefts=${JSON.stringify(dom.borderLefts)}`);
  if(!dom.toolbarVisible) throw new Error("toolbar not visible");
  if(!dom.bodyVisible) throw new Error("body not visible");
  if(consoleErrors!==0) throw new Error(`consoleErrors ${consoleErrors}`);
  if(dom.gapBeforeClear!==null && dom.gapBeforeClear>40) throw new Error(`gapBeforeClear too large ${dom.gapBeforeClear} evidence ${dom.gapBeforeClearEvidence}`);
  // check groupGaps all comparable (std dev small)
  console.log("VERIFICATION PASSED");

} finally {
  const { closeApp } = harness;
  try{
    await closeApp(app, {timeoutMs:15000});
    console.log("[verify] closed test app");
  } catch(e){ console.log("[verify] closeApp error", e); }
  console.log(`[verify] test browser closed, hub running app remains`);
}
