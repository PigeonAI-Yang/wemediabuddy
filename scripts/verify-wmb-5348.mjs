import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { launchApp, waitForAppReady, navigateTo, captureEvidence, delay, openReadOnlyDb } from '../tests/e2e/harness.mjs';
import { seedWorkflowBase, seedStudioProject, openWriteDb } from '../tests/e2e/seed-workflow.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const evidenceDir = path.join(repoRoot, '.ai', 'wmb-5348-evidence');
mkdirSync(evidenceDir, { recursive: true });
async function seedFixture({ dataRoot, workspaceId }) {
  await seedWorkflowBase(dataRoot, workspaceId);
  const db = openWriteDb(dataRoot);
  try {
    seedStudioProject(db, {
      title: 'WMB-5348 密度验证项目',
      coreV1: '初稿正文',
      coreV2: '# WMB-5348 验证正文\n\n这是一段用于验证 Studio 信息密度的正文内容，包含多个段落以确保画布高度可测量。\n\n## 二级标题一\n\n正文段落内容足够长，以测试滚动和画布高度。\n\n## 二级标题二\n\n更多正文内容，验证编辑器与 canvas 的可视高度。\n\n- 列表项一\n- 列表项二\n',
    });
  } finally {
    db.close();
  }
}

async function measure(page, label) {
  return await page.evaluate((lbl) => {
    const summary = document.querySelector('.studio-illustration-summary-bar');
    const ledger = document.querySelector('.studio-dual-ledger');
    const ledgerRows = Array.from(document.querySelectorAll('.studio-dual-ledger-row'));
    const canvas = document.querySelector('.studio-canvas');
    const paper = document.querySelector('.studio-paper');
    const summaryRect = summary ? summary.getBoundingClientRect() : null;
    const ledgerRect = ledger ? ledger.getBoundingClientRect() : null;
    const canvasRect = canvas ? canvas.getBoundingClientRect() : null;
    const paperRect = paper ? paper.getBoundingClientRect() : null;
    const rowHeights = ledgerRows.map((r) => r.getBoundingClientRect().height);
    const overflowX = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth;
    const overflowYBody = document.body.scrollHeight - document.body.clientHeight;
    const title = document.getElementById('studio-title');
    const titleRect = title ? title.getBoundingClientRect() : null;
    return {
      label: lbl,
      summary: summaryRect ? { height: summaryRect.height, top: summaryRect.top, width: summaryRect.width, text: summary?.textContent?.slice(0, 120) } : null,
      ledger: ledgerRect ? { height: ledgerRect.height, width: ledgerRect.width, rows: ledgerRows.length } : null,
      ledgerRowHeights: rowHeights,
      canvas: canvasRect ? { height: canvasRect.height, top: canvasRect.top } : null,
      paper: paperRect ? { height: paperRect.height } : null,
      overflowX,
      overflowYBody,
      hasTitle: !!title,
      titleHeight: titleRect?.height ?? null,
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
      url: location.href,
      modalPresent: !!document.querySelector('.app-modal-root'),
    };
  }, label);
}

async function main() {
  let app, page, workspace, runtimeDir, artifactsDir, evidence;
  const results = [];
  const consoleLogs = [];
  try {
    console.log('Launching isolated Electron for WMB-5348...');
    const launched = await launchApp({
      name: 'wmb-5348',
      seedFixture,
      headless: false,
    });
    app = launched.app; page = launched.page; workspace = launched.workspace; runtimeDir = launched.runtimeDir; artifactsDir = launched.artifactsDir; evidence = launched.evidence;
    console.log('App launched, workspace', workspace.workspaceId);
    await waitForAppReady(page);
    console.log('App ready, evidence launch', evidence.launch);

    // Ensure we can see console errors
    page.on('console', (msg) => consoleLogs.push(`${msg.type()}: ${msg.text()}`));

    // Navigate to Studio
    await navigateTo(page, 'studio');
    await delay(1200);
    await page.waitForSelector('.studio-project-row:not(.head)', { timeout: 15000 }).catch(() => console.log('no project row found'));
    // open first project via its action button (matches studio.test helper)
    const opened = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.studio-project-row:not(.head)')];
      const row = rows[0];
      const btn = row?.querySelector('button.studio-row-action');
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!opened) console.log('openProjectByName fallback failed');
    await page.waitForSelector('.studio-editor-view', { timeout: 15000 }).catch(() => console.log('studio-editor-view not found'));
    await page.waitForSelector('.studio-illustration-summary-bar', { timeout: 10000 }).catch(() => console.log('summary bar not found'));
    await page.waitForSelector('.studio-canvas', { timeout: 10000 }).catch(() => console.log('canvas not found'));
    await delay(1000);

    // Measure at 1568x843
    await page.setViewportSize({ width: 1568, height: 843 });
    await delay(500);
    const m1568 = await measure(page, '1568x843');
    results.push(m1568);
    console.log('Measure 1568x843', JSON.stringify(m1568, null, 2));

    // Screenshot 1568
    const shot1568 = path.join(evidenceDir, 'studio-density-1568.png');
    await page.screenshot({ path: shot1568, fullPage: false });
    console.log('Screenshot 1568', shot1568);

    // Measure at 1366x768
    await page.setViewportSize({ width: 1366, height: 768 });
    await delay(500);
    const m1366 = await measure(page, '1366x768');
    results.push(m1366);
    console.log('Measure 1366x768', JSON.stringify(m1366, null, 2));
    const shot1366 = path.join(evidenceDir, 'studio-density-1366.png');
    await page.screenshot({ path: shot1366, fullPage: false });
    console.log('Screenshot 1366', shot1366);

    // Test summary bar details
    const summaryDetailTest = await page.evaluate(async () => {
      const summary = document.querySelector('.studio-illustration-summary-bar');
      if (!summary) return { ok: false, reason: 'no summary bar' };
      const height = summary.getBoundingClientRect().height;
      const countText = summary.querySelector('.studio-illustration-summary-count')?.textContent ?? '';
      const statusText = summary.querySelector('.studio-illustration-summary-status')?.textContent ?? '';
      const ratioSelect = summary.querySelector('select[aria-label="比例"]');
      const countInput = summary.querySelector('input[aria-label="生成张数"]');
      const startBtn = summary.querySelector('.studio-illustration-summary-start');
      const detailBtn = summary.querySelector('.studio-illustration-summary-detail');
      return {
        ok: true,
        height,
        countText,
        statusText,
        hasRatio: !!ratioSelect,
        hasCount: !!countInput,
        hasStart: !!startBtn,
        startDisabled: startBtn ? startBtn.disabled : null,
        hasDetail: !!detailBtn,
        summaryText: summary.textContent.slice(0, 200),
      };
    });
    console.log('SummaryDetail', summaryDetailTest);
    results.push({ summaryDetailTest });

    // Test ledger rows
    const ledgerTest = await page.evaluate(() => {
      const ledger = document.querySelector('.studio-dual-ledger');
      if (!ledger) return { ok: false, reason: 'no ledger' };
      const rows = Array.from(document.querySelectorAll('.studio-dual-ledger-row'));
      return {
        ok: true,
        ledgerHeight: ledger.getBoundingClientRect().height,
        rows: rows.length,
        rowHeights: rows.map((r) => r.getBoundingClientRect().height),
        rowTexts: rows.map((r) => r.textContent.slice(0, 120)),
        hasArticle: !!document.querySelector('.studio-dual-ledger-row[data-kind="article"]'),
        hasDerivative: !!document.querySelector('.studio-dual-ledger-row[data-kind="derivative"]'),
      };
    });
    console.log('LedgerTest', ledgerTest);
    results.push({ ledgerTest });

    // Test detail modal open/close for ledger (derivative row)
    let ledgerModalTest = { ok: false };
    try {
      const detailBtn = page.locator('.studio-dual-ledger-row[data-kind="derivative"] .studio-dual-ledger-action').first();
      if (await detailBtn.isVisible().catch(() => false)) {
        const beforeFocus = await page.evaluate(() => document.activeElement?.outerHTML?.slice(0, 200));
        await detailBtn.click();
        await page.waitForSelector('.app-modal-root', { timeout: 5000 });
        const modalText = await page.locator('.app-modal-root').first().textContent().catch(() => '');
        const hasVersions = modalText.includes('文章版本') || modalText.includes('视频文案版本');
        const hasStatus = modalText.includes('状态') || modalText.includes('就绪');
        // Press Escape
        await page.keyboard.press('Escape');
        await delay(500);
        const modalAfter = await page.locator('.app-modal-root').count();
        const focusAfter = await page.evaluate(() => document.activeElement?.outerHTML?.slice(0, 200) ?? document.activeElement?.tagName);
        ledgerModalTest = { ok: true, hasVersions, hasStatus, modalClosed: modalAfter === 0, beforeFocus, focusAfter };
      } else {
        ledgerModalTest = { ok: false, reason: 'detail btn not visible' };
      }
    } catch (e) {
      ledgerModalTest = { ok: false, error: String(e) };
    }
    console.log('LedgerModalTest', ledgerModalTest);
    results.push({ ledgerModalTest });

    // Test illustration detail modal if exists (requires runs >0)
    let illustrationModalTest = { ok: false, skipped: false };
    try {
      const illDetailBtn = page.locator('.studio-illustration-summary-detail').first();
      if (await illDetailBtn.isVisible().catch(() => false)) {
        await illDetailBtn.click();
        await page.waitForSelector('#studio-illustration-detail-modal-dialog', { timeout: 5000 }).catch(() => page.waitForSelector('.app-modal-root', { timeout: 5000 }));
        const illModalText = await page.locator('.app-modal-root').first().textContent().catch(() => '');
        const hasRatio = illModalText.includes('比例') || illModalText.includes('重新生成');
        await page.keyboard.press('Escape');
        await delay(500);
        const illClosed = await page.locator('#studio-illustration-detail-modal-dialog').count() === 0;
        illustrationModalTest = { ok: true, hasRatio, illClosed, textSnippet: illModalText.slice(0, 200) };
      } else {
        illustrationModalTest = { ok: true, skipped: true, reason: 'no illustration detail button (0 runs) — expected for empty state' };
      }
    } catch (e) {
      illustrationModalTest = { ok: false, error: String(e) };
    }
    console.log('IllustrationModalTest', illustrationModalTest);
    results.push({ illustrationModalTest });

    // Check overflow and pageerrors
    const finalMeasure = await measure(page, 'final');
    results.push(finalMeasure);

    // Evidence: console/pageerrors
    const evidenceSnapshot = {
      console: evidence.console?.slice(0, 20) ?? [],
      pageerrors: evidence.pageerrors ?? [],
      errors: evidence.errors ?? [],
      consoleLogs,
      measurements: results,
      workspace: workspace.workspaceId,
      runtimeDir,
    };
    writeFileSync(path.join(evidenceDir, 'measurements.json'), JSON.stringify(evidenceSnapshot, null, 2), 'utf8');

    // Capture final evidence via harness
    try {
      await captureEvidence({ app, page, evidence, artifactsDir, name: 'wmb-5348-final' });
    } catch (e) { console.log('captureEvidence error', e); }

    console.log('Evidence written to', evidenceDir);
    // Write simple markdown evidence for loop report
    const md = `# WMB-5348 Evidence

- Viewport 1568x843 summaryBarHeight: ${m1568.summary?.height ?? 'N/A'} (target ≤56)
- Ledger height: ${m1568.ledger?.height ?? 'N/A'} rows: ${m1568.ledgerRowHeights?.join(',') ?? ''} (target two rows total ≤104, each 40-48)
- Viewport 1366x768 summaryBarHeight: ${m1366.summary?.height ?? 'N/A'} ledger ${m1366.ledger?.height ?? 'N/A'} overflowX ${m1366.overflowX}
- OverflowX 1568:${m1568.overflowX} 1366:${m1366.overflowX} (target 0)
- Canvas height 1568:${m1568.canvas?.height} 1366:${m1366.canvas?.height}
- Has start/regen: summaryDetail ${JSON.stringify(summaryDetailTest)}
- Ledger rows: ${JSON.stringify(ledgerTest)}
- Ledger modal: ${JSON.stringify(ledgerModalTest)}
- Illustration modal: ${JSON.stringify(illustrationModalTest)}
- Pageerrors: ${JSON.stringify(evidence.pageerrors)}
- Console errors: ${JSON.stringify(evidence.errors?.slice(0,5))}
- Screenshots: studio-density-1568.png, studio-density-1366.png
- Viewport dpr: ${m1568.viewport?.dpr}
`;
    writeFileSync(path.join(evidenceDir, 'evidence.md'), md, 'utf8');
    console.log(md);

    // Close app and verify exit
    try {
      await app.close();
    } catch (e) { console.log('app.close error', e); }
    await delay(1000);
    let exited = false;
    try {
      exited = app.process() ? app.process().exitCode !== null || app.process().killed : true;
    } catch {}
    // Also check via harness evidence
    console.log('App process exited?', exited, 'exitCode', app.process()?.exitCode, 'killed', app.process()?.killed);

    return { ok: true, measurements: results, evidenceDir, exited };
  } catch (error) {
    console.error('Verification failed', error);
    writeFileSync(path.join(evidenceDir, 'error.json'), JSON.stringify({ error: String(error), stack: error.stack, consoleLogs, evidence: evidence?.pageerrors }, null, 2), 'utf8');
    try { if (app) await app.close(); } catch {}
    return { ok: false, error: String(error) };
  }
}

main().then((res) => {
  console.log('Done', res);
  process.exit(res.ok ? 0 : 1);
});
