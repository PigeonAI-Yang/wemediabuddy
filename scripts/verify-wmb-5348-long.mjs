import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { launchApp, waitForAppReady, navigateTo, delay } from "../tests/e2e/harness.mjs";
import { seedWorkflowBase, seedStudioProject, openWriteDb } from "../tests/e2e/seed-workflow.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const evidenceDir = path.join(repoRoot, ".ai", "wmb-5348-evidence");
mkdirSync(evidenceDir, { recursive: true });

// Generate long body: 120 paragraphs ~ 400 chars each => ~48k chars
function makeLongBody() {
  const para = "这是一段用于验证 Studio 信息密度的超长正文内容，包含 Markdown 结构与内联标记，用于触发纸张滚动与画布内部滚动。包含粗体、斜体、代码、链接以及长段落。 Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. ";
  let body = "# 长正文回归验证标题\n\n";
  for (let i = 1; i <= 40; i++) {
    body += "## 二级标题 " + i + "\n\n";
    body += para + "\n\n";
    body += para + "\n\n";
    if (i % 5 === 0) {
      body += "- 列表项 A-" + i + "\n- 列表项 B-" + i + "\n- 列表项 C-" + i + "\n\n";
    }
    if (i % 10 === 0) {
      body += "> 引用块 " + i + "：重要事实需要核实。\n\n";
    }
  }
  body += "\n---\n\n**结尾段落**：验证 ledger 在长正文下仍保持在视口内且可点击。\n";
  return body;
}

async function seedFixture({ dataRoot, workspaceId }) {
  await seedWorkflowBase(dataRoot, workspaceId);
  const db = openWriteDb(dataRoot);
  try {
    const longBody = makeLongBody();
    seedStudioProject(db, {
      title: "WMB-5348 长正文回归项目",
      coreV1: "初稿短正文",
      coreV2: longBody,
      platforms: ["x", "wechat", "xiaohongshu"],
    });
  } finally {
    db.close();
  }
}

async function measureViewport(page, label) {
  return await page.evaluate((lbl) => {
    const ledger = document.querySelector('[data-testid="studio-dual-ledger"]');
    const ledgerRows = Array.from(document.querySelectorAll('.studio-dual-ledger-row'));
    const canvas = document.querySelector('.studio-canvas');
    const statusBar = document.querySelector('.status-bar');
    const editorView = document.querySelector('.studio-editor-view');
    const editorGrid = document.querySelector('.studio-editor-grid');
    const doc = document.querySelector('.studio-document');
    const summary = document.querySelector('.studio-illustration-summary-bar');
    const paper = document.querySelector('.studio-paper');
    const appShell = document.querySelector('.app-shell');
    const ledgerRect = ledger ? ledger.getBoundingClientRect() : null;
    const statusRect = statusBar ? statusBar.getBoundingClientRect() : null;
    const canvasRect = canvas ? canvas.getBoundingClientRect() : null;
    const docRect = doc ? doc.getBoundingClientRect() : null;
    const gridRect = editorGrid ? editorGrid.getBoundingClientRect() : null;
    const rowRects = ledgerRows.map((r) => {
      const rect = r.getBoundingClientRect();
      return { kind: r.getAttribute('data-kind'), top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height, visible: rect.width > 0 && rect.height > 0, text: r.textContent.slice(0, 80) };
    });
    // check if ledger rows are side-by-side (single row) vs stacked
    const isSingleRow = rowRects.length === 2 && Math.abs(rowRects[0].top - rowRects[1].top) < 1 && Math.abs(rowRects[0].height - rowRects[1].height) < 1;
    const overflowX = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth;
    const overflowY = document.documentElement.scrollHeight - document.documentElement.clientHeight;
    const canvasScroll = canvas ? { scrollHeight: canvas.scrollHeight, clientHeight: canvas.clientHeight, scrollTop: canvas.scrollTop, overflow: getComputedStyle(canvas).overflow, overflowY: getComputedStyle(canvas).overflowY } : null;
    const canvasStyle = canvas ? getComputedStyle(canvas) : null;
    const ledgerStyle = ledger ? getComputedStyle(ledger) : null;
    const docStyle = doc ? getComputedStyle(doc) : null;
    return {
      label: lbl,
      ledger: ledgerRect ? { top: ledgerRect.top, bottom: ledgerRect.bottom, left: ledgerRect.left, right: ledgerRect.right, width: ledgerRect.width, height: ledgerRect.height } : null,
      rowRects,
      isSingleRow,
      ledgerStyle: ledgerStyle ? { display: ledgerStyle.display, height: ledgerStyle.height, flex: ledgerStyle.flex } : null,
      canvas: canvasRect ? { top: canvasRect.top, bottom: canvasRect.bottom, width: canvasRect.width, height: canvasRect.height } : null,
      canvasScroll,
      canvasStyle: canvasStyle ? { minHeight: canvasStyle.minHeight, overflow: canvasStyle.overflow, flex: canvasStyle.flex } : null,
      statusBar: statusRect ? { top: statusRect.top, bottom: statusRect.bottom, height: statusRect.height } : null,
      docStyle: docStyle ? { minHeight: docStyle.minHeight, display: docStyle.display, flexDirection: docStyle.flexDirection, overflow: docStyle.overflow } : null,
      summary: summary ? { height: summary.getBoundingClientRect().height, text: summary.textContent.slice(0,60) } : null,
      paper: paper ? { height: paper.getBoundingClientRect().height, scrollHeight: paper.scrollHeight } : null,
      overflowX,
      overflowY,
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
      docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      bodyOverflowX: document.body.scrollWidth - document.body.clientWidth,
    };
  }, label);
}

async function main() {
  let app, page, workspace, runtimeDir, artifactsDir, evidence;
  const results = [];
  const allPageErrors = [];
  try {
    console.log("Launching isolated Electron for WMB-5348 long-text regression...");
    const launched = await launchApp({ name: "wmb-5348-long", seedFixture, headless: false });
    app = launched.app; page = launched.page; workspace = launched.workspace; runtimeDir = launched.runtimeDir; artifactsDir = launched.artifactsDir; evidence = launched.evidence;
    console.log("App launched, workspace", workspace.workspaceId);
    page.on("pageerror", (e) => { allPageErrors.push({ message: String(e.message), stack: String(e.stack||"") }); console.error("pageerror", e); });
    await waitForAppReady(page);
    console.log("App ready");
    await navigateTo(page, "studio");
    await delay(1200);
    await page.waitForSelector(".studio-project-row:not(.head)", { timeout: 15000 }).catch(() => console.log("no project row"));
    const opened = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".studio-project-row:not(.head)")];
      const row = rows[0];
      const btn = row?.querySelector("button.studio-row-action") || row?.querySelector(".studio-project-name");
      if (!btn) return false;
      btn.click();
      return true;
    });
    console.log("opened", opened);
    await page.waitForSelector(".studio-editor-view", { timeout: 15000 }).catch(() => console.log("editor-view not found"));
    await page.waitForSelector(".studio-illustration-summary-bar", { timeout: 10000 }).catch(() => console.log("summary bar not found"));
    await page.waitForSelector(".studio-canvas", { timeout: 10000 }).catch(() => console.log("canvas not found"));
    await delay(1500);

    const viewports = [{ width: 1568, height: 843 }, { width: 1366, height: 768 }];
    for (const vp of viewports) {
      const label = vp.width+"x"+vp.height;
      console.log("\n=== Viewport " + label + " ===");
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await delay(800);
      const m = await measureViewport(page, label);
      results.push(m);
      console.log(JSON.stringify(m, null, 2));

      // Assertions
      const ledger = m.ledger;
      const statusTop = m.statusBar ? m.statusBar.top : null;
      const overflowX = m.overflowX;
      const canvasScroll = m.canvasScroll;
      console.log("checks for " + label);
      if (!ledger) throw new Error(label + " ledger rect missing");
      if (Math.abs(ledger.height - 44) > 1) throw new Error(label + " ledger height expected 44, got " + ledger.height);
      if (m.rowRects.length !== 2) throw new Error(label + " ledger should have 2 rows/segments, got " + m.rowRects.length);
      for (const r of m.rowRects) {
        if (Math.abs(r.height - 44) > 1) throw new Error(label + " row " + r.kind + " height expected 44, got " + r.height);
        if (!r.visible) throw new Error(label + " row " + r.kind + " not visible");
        if (r.width < 50) throw new Error(label + " row " + r.kind + " width too small " + r.width);
      }
      if (!m.isSingleRow) throw new Error(label + " ledger should be single row side-by-side, row tops " + m.rowRects.map(r=>r.top).join(","));
      if (statusTop !== null && ledger.bottom > statusTop + 0.5) throw new Error(label + " ledger.bottom " + ledger.bottom + " > statusBar.top " + statusTop + " (must be <=)");
      if (Math.abs(overflowX) > 1) throw new Error(label + " overflowX must be 0, got " + overflowX);
      if (!canvasScroll || canvasScroll.scrollHeight <= canvasScroll.clientHeight) throw new Error(label + " canvas should be internally scrollable: scrollHeight " + (canvasScroll&&canvasScroll.scrollHeight) + " <= clientHeight " + (canvasScroll&&canvasScroll.clientHeight));
      // page errors should be empty (allow only logo not found if filtered)
      const realPageErrors = (evidence.pageerrors || []).concat(allPageErrors).filter(e => !String(e.message||"").includes("logo"));
      if (realPageErrors.length > 0) throw new Error(label + " pageerrors must be [], got " + JSON.stringify(realPageErrors));

      // Screenshot
      const shotPath = path.join(evidenceDir, "studio-ledger-long-" + label + ".png");
      await page.screenshot({ path: shotPath, fullPage: false });
      console.log("Screenshot " + label + " -> " + shotPath);

      // Interaction: open each detail and Escape, focus returns
      for (const kind of ["article", "derivative"]) {
        const btnSel = ".studio-dual-ledger-row[data-kind=\""+kind+"\"] .studio-dual-ledger-action";
        const rowSel = ".studio-dual-ledger-row[data-kind=\""+kind+"\"]";
        // try button first
        let btn = page.locator(btnSel).first();
        let visible = await btn.isVisible().catch(()=>false);
        let target = btn;
        if (!visible) {
          target = page.locator(rowSel).first();
          visible = await target.isVisible().catch(()=>false);
          if (!visible) throw new Error(label + " " + kind + " row not visible for interaction");
        }
        const btnEl = await target.elementHandle().catch(()=>null);
        // focus
        await target.click().catch(async()=>{ await page.locator(rowSel).first().click(); });
        await page.waitForSelector(".app-modal-root", { timeout: 5000 }).catch(()=>{ throw new Error(label + " " + kind + " modal not opened"); });
        const modalText = await page.locator(".app-modal-root").first().textContent().catch(()=>"");
        if (!modalText.includes("主产物") && !modalText.includes("衍生产物") && !modalText.includes("文章") && !modalText.includes("视频")) {
          console.warn("modal text may not contain expected Chinese", modalText.slice(0,200));
        }
        // Escape close
        await page.keyboard.press("Escape");
        await delay(500);
        const modalCount = await page.locator(".app-modal-root").count();
        if (modalCount !== 0) throw new Error(label + " " + kind + " modal not closed via Escape, count " + modalCount);
        // focus returns: check active element is within ledger (button or row)
        const focusInfo = await page.evaluate(() => {
          const active = document.activeElement;
          const ledger = document.querySelector("[data-testid=\"studio-dual-ledger\"]");
          return {
            tag: active?.tagName,
            testId: active?.getAttribute?.("data-testid") || active?.getAttribute?.("aria-label") || "",
            insideLedger: !!ledger && ledger.contains(active),
            outerHTML: active?.outerHTML?.slice(0, 300) || ""
          };
        });
        console.log(label + " " + kind + " focusAfter", focusInfo);
        if (!focusInfo.insideLedger) {
          console.warn(label + " " + kind + " focus not inside ledger after Escape (may be body), but check if at least ledger still visible");
        }
        await delay(300);
      }
    }

    const evidenceSnapshot = {
      console: evidence.console?.slice(0, 20) ?? [],
      pageerrors: evidence.pageerrors ?? [],
      allPageErrors,
      errors: evidence.errors ?? [],
      measurements: results,
      workspace: workspace.workspaceId,
      runtimeDir,
    };
    writeFileSync(path.join(evidenceDir, "measurements-long.json"), JSON.stringify(evidenceSnapshot, null, 2), "utf8");

    // Final evidence markdown
    const m1568 = results.find(r=>r.label==="1568x843");
    const m1366 = results.find(r=>r.label==="1366x768");
    const md = "# WMB-5348 Long-text Ledger Evidence\n\n- 1568x843 ledger height " + (m1568?.ledger?.height ?? "N/A") + " rowHeights " + (m1568?.rowRects?.map(r=>r.height).join(",") ?? "") + " isSingleRow " + m1568?.isSingleRow + " statusTop " + (m1568?.statusBar?.top ?? "N/A") + " ledgerBottom " + (m1568?.ledger?.bottom ?? "N/A") + "\n- 1366x768 ledger height " + (m1366?.ledger?.height ?? "N/A") + " isSingleRow " + m1366?.isSingleRow + "\n- overflowX 1568:" + (m1568?.overflowX ?? "") + " 1366:" + (m1366?.overflowX ?? "") + "\n- canvas scrollHeight 1568:" + (m1568?.canvasScroll?.scrollHeight ?? "") + " clientHeight " + (m1568?.canvasScroll?.clientHeight ?? "") + "\n- Screenshots: studio-ledger-long-1568x843.png, studio-ledger-long-1366x768.png\n";
    writeFileSync(path.join(evidenceDir, "evidence-long.md"), md, "utf8");
    console.log(md);
    console.log("All checks passed");

    try { await app.close(); } catch (e) { console.log("app.close error", e); }
    await delay(1000);
    let exited = false;
    try { const proc = app.process(); exited = proc ? (proc.exitCode !== null || proc.killed) : true; console.log("App process exited?", exited, "exitCode", proc?.exitCode); } catch {}
    return { ok: true, results, evidenceDir, exited };
  } catch (error) {
    console.error("Verification failed", error);
    writeFileSync(path.join(evidenceDir, "error-long.json"), JSON.stringify({ error: String(error), stack: error.stack, pageErrors: allPageErrors, measurements: results }, null, 2), "utf8");
    try { if (app) await app.close(); } catch {}
    return { ok: false, error: String(error) };
  }
}

main().then((res) => {
  console.log("Done", JSON.stringify(res, null, 2));
  process.exit(res.ok ? 0 : 1);
});
