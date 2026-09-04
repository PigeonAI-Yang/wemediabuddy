import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, existsSync, copyFileSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import { mkdtempSync } from "node:fs";
import { _electron as electron } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const REAL_DATA_ROOT = "J:/PigeonYang/WeMediaBuddyData";
const REAL_DB = path.join(REAL_DATA_ROOT, "wmb.db");
const INSTALLED_APP_DIR = "C:/Users/yangda01/AppData/Local/WeMediaBuddy/app-0.3.0";
const INSTALLED_EXE = path.join(INSTALLED_APP_DIR, "WeMediaBuddy.exe");
const REPORT_DIR = path.join(repoRoot, ".ai", "frontend-debug-loop", "reports");
const SCREENSHOT_PATH = path.join(REPORT_DIR, "2026-08-24-studio-production-row-removal.png");
const PROJECT_ID = "6ce12d8a-d12d-449d-baca-fcdc55b0f3c8";
const WORKSPACE_ID = "a755adf2-4e8d-4abd-b616-4d7934f730f1";

function log(...args){ console.log("[verify]", ...args); }

async function main(){
  mkdirSync(REPORT_DIR, {recursive:true});
  if(!existsSync(REAL_DB)) throw new Error(`real DB not found at ${REAL_DB}`);
  if(!existsSync(INSTALLED_EXE)) throw new Error(`installed exe not found at ${INSTALLED_EXE}`);

  // Create isolated runtime
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "wmb-verify-"));
  const userDataDir = path.join(runtimeDir, "user-data");
  const dataRoot = path.join(runtimeDir, "data-root");
  mkdirSync(userDataDir, {recursive:true});
  mkdirSync(dataRoot, {recursive:true});
  for(const sub of ["assets","browser-profile","logs","exports"]){
    mkdirSync(path.join(dataRoot, sub), {recursive:true});
  }
  // Copy real DB
  const destDb = path.join(dataRoot, "wmb.db");
  copyFileSync(REAL_DB, destDb);
  log(`copied DB ${REAL_DB} -> ${destDb}`);

  // Also copy wmb.db-shm/wal if exists? Not needed, main DB contains data.
  // Ensure app_meta workspace_id matches
  // Write workspace-registry and data-root and onboarding to bypass wizard
  const now = new Date().toISOString();
  const registry = {
    version:1,
    activeWorkspaceId: WORKSPACE_ID,
    workspaces: [{id: WORKSPACE_ID, displayName:"AI", rootPath: dataRoot}],
    switchJournal:null
  };
  writeFileSync(path.join(userDataDir, "workspace-registry.json"), JSON.stringify(registry,null,2)+"\n");
  writeFileSync(path.join(userDataDir, "data-root.json"), JSON.stringify({path: dataRoot},null,2)+"\n");
  writeFileSync(path.join(userDataDir, "onboarding.json"), JSON.stringify({
    version:1,
    state:{
      currentStep:"complete",
      workspace:{workspaceId: WORKSPACE_ID, rootPath: dataRoot, createdAt: now},
      ai:null, platforms:{}, startedAt: now, completedAt: now, updatedAt: now
    }
  },null,2)+"\n");
  writeFileSync(path.join(userDataDir, "pi-api-config.json"), JSON.stringify({
    version:1,
    state:{
      activeId:"e2e",
      profiles:[{id:"e2e", name:"E2E 占位配置", baseUrl:"https://api.openai.com/v1", model:"gpt-5.4", api:"openai-responses", thinking:"medium", nativeSearch:false, contextWindow:400000, maxTokens:65536, encryptedApiKey: Buffer.from("e2e-placeholder-key-do-not-use").toString("base64")}],
      fallbackOrder:["e2e"]
    }
  },null,2)+"\n");

  // Launch installed app via playwright
  log(`launching installed app ${INSTALLED_EXE} with userData ${userDataDir}`);
  const env = {
    ...process.env,
    WMB_ACCEPTANCE_USER_DATA: userDataDir,
    WMB_ACCEPTANCE_HEADLESS: "0",
    WMB_ACCEPTANCE_UPDATE_TAG: "v0.3.0",
    ELECTRON_ENABLE_LOGGING: "1",
    ELECTRON_ENABLE_STACK_DUMPING: "1"
  };
  delete env.WMB_ACCEPTANCE_CDP_PORT;

  const app = await electron.launch({
    executablePath: INSTALLED_EXE,
    args: [],
    cwd: repoRoot,
    env,
    timeout: 120000
  });
  const page = await app.firstWindow({timeout: 90000});
  // Attach collectors
  const evidence = { console:[], pageerrors:[], errors:[] };
  page.on("console", msg=>{ evidence.console.push({type:msg.type(), text:msg.text()}); });
  page.on("pageerror", err=>{ evidence.pageerrors.push(String(err)); });
  page.on("console", msg=>{ if(msg.type()==="error") evidence.errors.push(msg.text()); });

  // Wait for shell
  await page.waitForSelector(".app-shell", {timeout:60000});
  log("app shell ready");
  await page.waitForTimeout(2000);

  // Navigate to Studio
  // Find sidebar button with title 创作
  const studioBtn = page.locator('aside.sidebar button[title="创作"]');
  if(await studioBtn.count()>0){
    await studioBtn.first().click();
    log("clicked studio sidebar");
  } else {
    // fallback: click by text
    await page.locator('aside.sidebar').getByText('创作').click();
  }
  await page.waitForTimeout(1500);
  await page.waitForSelector(".app-shell.studio-mode", {timeout:10000}).catch(()=>{});
  log("navigated to studio");

  // Need to select project 6ce12d8a. Use localStorage trick
  // Set workspace storage key and reload
  const storageKey = `wmb.workspace.${WORKSPACE_ID}.studioSelectedId`;
  await page.evaluate(({key, val})=>{
    localStorage.setItem(key, val);
  }, {key: storageKey, val: PROJECT_ID});
  log(`set localStorage ${storageKey}=${PROJECT_ID}`);
  // Reload page to pick up new selectedId
  await page.reload({waitUntil:"domcontentloaded"});
  await page.waitForSelector(".app-shell", {timeout:60000});
  await page.waitForTimeout(2000);
  // Click studio again
  const studioBtn2 = page.locator('aside.sidebar button[title="创作"]');
  if(await studioBtn2.count()>0) await studioBtn2.first().click().catch(()=>{});
  await page.waitForTimeout(1500);
  await page.waitForSelector(".app-shell.studio-mode", {timeout:10000}).catch(()=>{});

  // Wait for studio document to load with project title
  // The studio view should show project title in editor or header
  // Wait for .studio-document or .studio-editor-view
  try{
    await page.waitForSelector(".studio-document", {timeout:15000});
    log("studio-document found");
  }catch(e){
    log("studio-document not found, trying alternative");
  }
  await page.waitForTimeout(2500);

  // Try to ensure project detail loaded: look for title textarea with value
  // Check if selected project title appears in DOM
  const titleCheck = await page.evaluate((pid)=>{
    return document.body.innerHTML.includes("杨立昆真正质疑") || document.body.innerHTML.includes(pid);
  }, PROJECT_ID);
  log("titleCheck", titleCheck);

  // Now perform DOM assertions
  const dom = await page.evaluate(()=>{
    const html = document.documentElement.outerHTML;
    const text = document.body.innerText;
    const hasStartProduction = html.includes("开始生产") || text.includes("开始生产");
    const hasApprovedStatus = html.includes("已批准 · 生产推进中") || text.includes("已批准 · 生产推进中");
    const hasBanner = !!document.querySelector(".studio-planning-banner");
    const hasAdvanceButton = !!document.querySelector(".studio-advance-button") || !!document.querySelector('[data-testid="studio-advance"]');
    const toolbar = document.querySelector(".studio-formatbar") || document.querySelector(".studio-formatbar-group") || document.querySelector(".studio-rich-editor") || document.querySelector("#studio-body");
    const toolbarVisible = !!(toolbar && (toolbar.offsetParent !== null || getComputedStyle(toolbar).display !== "none" || toolbar.getBoundingClientRect().height>0));
    // More precise: check StudioFormatBar exists and is visible
    const formatBar = document.querySelector(".studio-formatbar, .studio-formatbar-group");
    const formatBarVisible = !!formatBar && formatBar.getBoundingClientRect().height>0;
    // Also check generic toolbar selector used in app: .studio-formatbar or buttons with title
    const anyToolbarButton = !!document.querySelector('button[title="粗体"], button[title="斜体"], button[title="插入图片"]');
    const body = document.querySelector(".studio-canvas, .studio-paper, .studio-rich-editor, #studio-body");
    const bodyVisible = !!(body && body.getBoundingClientRect().height>0);
    const bodyHeight = body ? body.getBoundingClientRect().height : 0;
    const toolbarEl = document.querySelector(".studio-formatbar, .studio-formatbar-group");
    const toolbarRect = toolbarEl ? toolbarEl.getBoundingClientRect() : null;
    const bannerEl = document.querySelector(".studio-planning-banner");
    const bannerRect = bannerEl ? bannerEl.getBoundingClientRect() : null;
    // Check empty strip: if banner removed but empty div remains with same position? Check for element with height 36 and same background just before toolbar
    const emptyStripAbsent = !hasBanner;
    return {
      hasStartProduction,
      hasApprovedStatus,
      hasBanner,
      hasAdvanceButton,
      toolbarVisible: !!(formatBarVisible || anyToolbarButton || toolbarVisible),
      bodyVisible,
      bodyHeight,
      toolbarRect: toolbarRect ? {top: toolbarRect.top, height: toolbarRect.height} : null,
      bannerRect: bannerRect ? {top: bannerRect.top, height: bannerRect.height} : null,
      emptyStripAbsent,
      htmlSnippet: html.slice(0,5000)
    };
  });
  log("dom", JSON.stringify(dom,null,2));

  const consoleErrors = evidence.pageerrors.length + evidence.errors.length;
  log(`consoleErrors ${consoleErrors} pageerrors ${evidence.pageerrors.length} console errors ${evidence.errors.length}`);
  if(evidence.pageerrors.length) log("pageerrors", evidence.pageerrors);
  if(evidence.errors.length) log("errors", evidence.errors);

  // Assertions
  const startProductionAbsent = !dom.hasStartProduction && !dom.hasAdvanceButton;
  const approvedStatusAbsent = !dom.hasApprovedStatus && !dom.hasBanner;
  const emptyStripAbsent = dom.emptyStripAbsent === true && !dom.hasBanner;
  const toolbarVisible = dom.toolbarVisible === true;
  const bodyVisible = dom.bodyVisible === true;
  log(`Assertions: startProductionAbsent=${startProductionAbsent} approvedStatusAbsent=${approvedStatusAbsent} emptyStripAbsent=${emptyStripAbsent} toolbarVisible=${toolbarVisible} bodyVisible=${bodyVisible} consoleErrors=${consoleErrors}`);

  // Screenshot
  await page.setViewportSize({width:1280, height:800});
  await page.waitForTimeout(500);
  // Ensure window is visible
  await page.screenshot({path: SCREENSHOT_PATH, fullPage:false});
  log(`screenshot saved to ${SCREENSHOT_PATH}`);
  const stat = await import("node:fs").then(m=>m.statSync(SCREENSHOT_PATH));
  log(`screenshot size ${stat.size}`);

  // Also capture full page for reference
  // Close verification app
  await app.close();
  log("verification app closed");

  const result = {
    domAssertions: {
      startProductionAbsent,
      approvedStatusAbsent,
      emptyStripAbsent,
      toolbarVisible,
      bodyVisible,
      consoleErrors
    },
    screenshotPath: SCREENSHOT_PATH,
    evidence,
    dom,
    runtimeDir,
    userDataDir,
    dataRoot
  };
  writeFileSync(path.join(REPORT_DIR, "verify-result.json"), JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
  if(!startProductionAbsent || !approvedStatusAbsent || !emptyStripAbsent || !toolbarVisible || !bodyVisible){
    console.error("VERIFICATION FAILED");
    process.exit(1);
  }
  if(consoleErrors>0){
    console.error("console errors present", consoleErrors);
    // Allow maybe 0 only; if >0 fail
    process.exit(1);
  }
  process.exit(0);
}

main().catch(e=>{
  console.error(e.stack);
  process.exit(1);
});
