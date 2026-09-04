import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdirSync, existsSync, copyFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
const { launchApp, waitForAppReady, navigateTo, delay } = harness;

const REAL_DATA_ROOT = "J:/PigeonYang/WeMediaBuddyData";
const REAL_DB = path.join(REAL_DATA_ROOT, "wmb.db");
const INSTALLED_APP_DIR = "C:/Users/yangda01/AppData/Local/WeMediaBuddy/app-0.3.0";
const PACKAGED_APP_DIR = "J:/wmb-out/WeMediaBuddy-win32-x64";
const REPORT_DIR = path.join(repoRoot, ".ai", "frontend-debug-loop", "reports");
const SCREENSHOT_PATH = path.join(REPORT_DIR, "2026-08-24-studio-production-row-removal.png");
const PROJECT_ID = "6ce12d8a-d12d-449d-baca-fcdc55b0f3c8";
const WORKSPACE_ID = "a755adf2-4e8d-4abd-b616-4d7934f730f1";

mkdirSync(REPORT_DIR, {recursive:true});

async function seedFixture({dataRoot, workspaceId}){
  // dataRoot already has wmb.db created by harness seedWorkspace (fresh). Replace with real DB
  const dest = path.join(dataRoot, "wmb.db");
  // Need to close DB? harness already closed it. So we can overwrite.
  // Copy real DB
  copyFileSync(REAL_DB, dest);
  console.log(`[verify] copied real DB to ${dest}`);
  // Ensure app_meta workspace_id matches workspaceId (real DB already has a755... so ok)
  // If mismatch, fix:
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dest);
  try{
    const row = db.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get();
    if(!row || row.value !== workspaceId){
      console.log(`[verify] fixing workspace_id from ${row?.value} to ${workspaceId}`);
      db.exec(`DELETE FROM app_meta WHERE key='workspace_id'`);
      const now = new Date().toISOString();
      db.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', ?, ?, ?, 1)").run(workspaceId, now, now);
    }
  } finally { db.close(); }
}

console.log("[verify] launching app via harness, appPath", PACKAGED_APP_DIR);
// Use packaged dir for verification (identical to installed)
const {app, page, workspace, runtimeDir, artifactsDir, evidence} = await launchApp({
  appPath: PACKAGED_APP_DIR,
  workspaceId: WORKSPACE_ID,
  displayName: "AI",
  seedFixture,
  headless: false, // show window
  artifactsDir: REPORT_DIR
});

try{
  await waitForAppReady(page);
  console.log("[verify] app ready");
  await delay(2000);
  // Navigate to studio
  await navigateTo(page, "studio");
  console.log("[verify] navigated to studio");
  await delay(1500);
  // Set studioSelectedId via localStorage and reload
  const storageKey = `wmb.workspace.${WORKSPACE_ID}.studioSelectedId`;
  await page.evaluate(({key, val})=>{ localStorage.setItem(key, val); }, {key: storageKey, val: PROJECT_ID});
  console.log(`[verify] set ${storageKey}=${PROJECT_ID}`);
  await page.reload({waitUntil:"domcontentloaded"});
  await waitForAppReady(page);
  await delay(2000);
  await navigateTo(page, "studio");
  await delay(1500);
  // Wait for studio-document
  await page.waitForSelector(".studio-document", {timeout:15000}).catch(()=>console.log("[verify] studio-document not found"));
  await delay(2500);

  // DOM assertions
  const dom = await page.evaluate(()=>{
    const html = document.documentElement.outerHTML;
    const text = document.body.innerText;
    const hasStartProduction = html.includes("开始生产") || text.includes("开始生产");
    const hasApprovedStatus = html.includes("已批准 · 生产推进中") || text.includes("已批准 · 生产推进中");
    const hasBanner = !!document.querySelector(".studio-planning-banner");
    const hasAdvanceButton = !!document.querySelector(".studio-advance-button") || !!document.querySelector('[data-testid="studio-advance"]');
    const formatBar = document.querySelector(".studio-formatbar, .studio-formatbar-group");
    const anyToolbarButton = !!document.querySelector('button[title="粗体"], button[title="斜体"], button[title="插入图片"], button[title="清除格式"]');
    const formatBarVisible = !!formatBar && formatBar.getBoundingClientRect().height>0;
    const toolbarVisible = !!(formatBarVisible || anyToolbarButton);
    const body = document.querySelector(".studio-canvas, .studio-paper, .studio-rich-editor, #studio-body");
    const bodyVisible = !!(body && body.getBoundingClientRect().height>0);
    const bannerEl = document.querySelector(".studio-planning-banner");
    return {
      hasStartProduction, hasApprovedStatus, hasBanner, hasAdvanceButton,
      toolbarVisible, bodyVisible,
      bannerExists: hasBanner,
      htmlSnippet: html.slice(0,3000)
    };
  });
  console.log("[verify] dom", JSON.stringify(dom,null,2));
  const consoleErrors = (evidence.pageerrors?.length||0) + (evidence.errors?.length||0);
  console.log(`[verify] consoleErrors ${consoleErrors} pageerrors`, evidence.pageerrors, "errors", evidence.errors);

  const startProductionAbsent = !dom.hasStartProduction && !dom.hasAdvanceButton;
  const approvedStatusAbsent = !dom.hasApprovedStatus && !dom.hasBanner;
  const emptyStripAbsent = !dom.hasBanner;
  const toolbarVisible = dom.toolbarVisible;
  const bodyVisible = dom.bodyVisible;
  console.log(`[verify] assertions: startProductionAbsent=${startProductionAbsent} approvedStatusAbsent=${approvedStatusAbsent} emptyStripAbsent=${emptyStripAbsent} toolbarVisible=${toolbarVisible} bodyVisible=${bodyVisible} consoleErrors=${consoleErrors}`);

  await page.setViewportSize({width:1280, height:800});
  await delay(500);
  await page.screenshot({path: SCREENSHOT_PATH, fullPage:false});
  console.log(`[verify] screenshot saved to ${SCREENSHOT_PATH}`);
  const { statSync } = await import("node:fs");
  console.log(`[verify] screenshot size ${statSync(SCREENSHOT_PATH).size}`);

  const result = {
    domAssertions: { startProductionAbsent, approvedStatusAbsent, emptyStripAbsent, toolbarVisible, bodyVisible, consoleErrors },
    screenshotPath: SCREENSHOT_PATH,
    dom,
    evidence
  };
  writeFileSync(path.join(REPORT_DIR, "verify-result.json"), JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));

  if(!startProductionAbsent || !approvedStatusAbsent || !emptyStripAbsent || !toolbarVisible || !bodyVisible){
    console.error("VERIFICATION FAILED");
    process.exit(1);
  }
  if(consoleErrors>0){
    console.error("console errors", consoleErrors);
    process.exit(1);
  }
  console.log("VERIFICATION PASSED");
} finally {
  await harness.closeApp(app).catch(()=>{});
  console.log("[verify] closed app");
}
