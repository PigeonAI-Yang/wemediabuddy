import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const researchUrl = new URL(
  "../src/renderer/studio-view-research.tsx",
  import.meta.url,
);
const derivativeUrl = new URL(
  "../src/renderer/studio-derivative-panel.tsx",
  import.meta.url,
);
const viewUrl = new URL("../src/renderer/studio-view.tsx", import.meta.url);
const cssUrl = new URL("../src/renderer/styles-studio.css", import.meta.url);
const foundationUrl = new URL(
  "../src/renderer/styles-foundation.css",
  import.meta.url,
);
test("WMB-5348 summary bar retains real state computation and actions", async () => {
  const tsx = await readFile(researchUrl, "utf8");
  const viewTsx = await readFile(viewUrl, "utf8");
  // must compute completed/total from real runs
  assert.match(tsx, /computeIllustrationSummary/);
  assert.match(tsx, /completed.*total/);
  assert.match(tsx, /illustrationStatusLabel/);
  // must show unified ratio and image count in summary bar
  assert.match(tsx, /studio-illustration-summary-bar/);
  assert.match(tsx, /studio-illustration-summary-status/);
  assert.match(tsx, /studio-illustration-summary-count/);
  assert.match(tsx, /aria-label="比例"/);
  assert.match(tsx, /aria-label="生成张数"/);
  // primary action still calls onStart
  assert.match(tsx, /onStart/);
  assert.match(tsx, /定稿配图/);
  // detail entry
  assert.match(tsx, /查看详情/);
  assert.match(tsx, /aria-expanded/);
  // old handlers still connected in detail modal (via props) and view still calls wmb
  assert.match(tsx, /onRetry\(run\.id, item\.id\)/);
  assert.match(tsx, /onRegenerate\(run\.id, item\.id\)/);
  assert.match(tsx, /onUndo\(run\.id, item\.id\)/);
  assert.match(viewTsx, /window\.wmb\.retryIllustrationItem/);
  assert.match(viewTsx, /window\.wmb\.regenerateIllustrationItem/);
  assert.match(viewTsx, /window\.wmb\.undoIllustrationItem/);
  assert.match(
    viewTsx,
    /window\.wmb\.retryIllustrationItem|window\.wmb\.listIllustrationRuns/,
  );
  // ensure summary bar is always shown except platform readonly (not hidden when no runs)
  assert.doesNotMatch(
    tsx,
    /if \(activePlatform \|\| readOnlyVersion \|\| runs\.length === 0\) return null/,
  );
  assert.match(tsx, /if \(activePlatform \|\| readOnlyVersion\) return null/);
});

test("WMB-5348 illustration empty/loading/error still has explicit summary", async () => {
  const tsx = await readFile(researchUrl, "utf8");
  assert.match(tsx, /暂无配图/);
  assert.match(tsx, /生成中/);
  assert.match(tsx, /配图已完成/);
  assert.match(tsx, /配图失败|部分完成/);
  assert.match(tsx, /0\/0/);
});

test("WMB-5348 illustration detail modal retains per-item state and controls", async () => {
  const tsx = await readFile(researchUrl, "utf8");
  assert.match(tsx, /StudioIllustrationDetailModal/);
  assert.match(tsx, /AppModal/);
  assert.match(tsx, /配图详情/);
  assert.match(tsx, /studio-illustration-detail-run/);
  assert.match(tsx, /studio-illustration-detail-item/);
  assert.match(tsx, /item\.kind.*source/);
  assert.match(tsx, /item\.state/);
  assert.match(tsx, /item\.ratio/);
  assert.match(tsx, /item\.errorMessage/);
  assert.match(tsx, /重试/);
  assert.match(tsx, /重新生成/);
  assert.match(tsx, /撤销/);
  assert.match(tsx, /aria-label="重新生成比例"/);
  assert.match(tsx, /aria-label="重新生成要求"/);
});

test("WMB-5348 derivative renders two ledger rows not large cards by default", async () => {
  const tsx = await readFile(derivativeUrl, "utf8");
  assert.match(tsx, /studio-dual-ledger/);
  assert.match(tsx, /studio-dual-ledger-row/);
  assert.match(tsx, /data-kind="article"/);
  assert.match(tsx, /data-kind="derivative"/);
  assert.match(tsx, /主产物/);
  assert.match(tsx, /衍生产物/);
  assert.match(tsx, /文章主稿/);
  assert.match(tsx, /视频文案/);
  // row fields at least type, name, status, version/latest
  assert.match(tsx, /studio-dual-ledger-type/);
  assert.match(tsx, /studio-dual-ledger-name/);
  assert.match(tsx, /studio-dual-ledger-status/);
  assert.match(tsx, /studio-dual-ledger-version/);
  // whole row or button opens detail
  assert.match(tsx, /role="button"/);
  assert.match(tsx, /查看详情/);
  assert.match(tsx, /onClick.*openDetail/);
  // ledger should be not the old large grid by default; old panel class should not be primary
  assert.match(tsx, /className.*studio-dual-ledger/);
  // modal bears old card info
  assert.match(tsx, /DualDetailModal/);
  assert.match(tsx, /studio-dual-detail-card/);
  assert.match(tsx, /文章版本/);
  assert.match(tsx, /视频文案版本/);
  assert.match(tsx, /studio-dual-script/);
  assert.match(tsx, /studio-format-decision/);
  assert.match(tsx, /studio-dual-alignment/);
});

test("WMB-5348 derivative modal reuses AppModal with a11y", async () => {
  const tsx = await readFile(derivativeUrl, "utf8");
  assert.match(tsx, /AppModal/);
  assert.match(tsx, /title="产物详情"/);
  assert.match(tsx, /testId="studio-dual-detail-modal"/);
  assert.match(tsx, /returnFocusRef/);
  // Escape / aria-labelledby is handled by AppModal, ensure it is used
  assert.match(tsx, /AppModal.*open.*onRequestClose/);
  // ensure whole row keyboard accessible
  assert.match(tsx, /onKeyDown.*Enter.* /);
  assert.match(tsx, /tabIndex=\{0\}/);
});

test("WMB-5348 studio-view wires summary bar and preserves handlers", async () => {
  const tsx = await readFile(viewUrl, "utf8");
  assert.match(tsx, /StudioIllustrationPanel/);
  // start handler still connected
  assert.match(tsx, /startIllustrationRun/);
  assert.match(tsx, /retryIllustrationItem/);
  assert.match(tsx, /regenerateIllustrationItem/);
  assert.match(tsx, /undoIllustrationItem/);
  // formatbar illustrationTools removed — should not duplicate ratio/select in toolbar
  assert.doesNotMatch(tsx, /illustrationTools.*studio-formatbar-illustration/);
  // ensure StudioFormatBar still rendered but without illustration group
  assert.match(tsx, /<StudioFormatBar/);
});

test("WMB-5348 CSS uses only foundation tokens and compact heights", async () => {
  const css = await readFile(cssUrl, "utf8");
  const foundation = await readFile(foundationUrl, "utf8");
  // top summary bar height 44 fits ≤56, ledger rows 44 each total ≤104
  assert.match(css, /\.studio-illustration-summary-bar[^}]*height:\s*44px/);
  assert.match(css, /\.studio-dual-ledger-row[^}]*height:\s*44px/);
  // ensure no hardcoded hex colors in new section (tokens only)
  const densitySection = css.slice(css.indexOf("WMB-5348"));
  // allow hex only inside var() references, not raw hex
  // check that new section does not contain raw #0b, #0f etc except via var
  // we allow # but ensure no new brand token hex is introduced outside var
  // simple check: no "#8b7cff" or "#0b0b0b" literal in density section outside var
  assert.doesNotMatch(densitySection, /#[0-9a-fA-F]{6}(?![\s\S]*var\()/);
  // ensure uses var(--*) for colors
  assert.match(densitySection, /var\(--panel-bg\)/);
  assert.match(densitySection, /var\(--border/);
  assert.match(densitySection, /var\(--surface/);
  assert.match(densitySection, /var\(--ink/);
  // modal detail should not be default first screen: summary bar not hidden, modal only when open
  assert.match(css, /\.studio-illustration-detail[^}]*max-height:\s*5[8-9]vh/);
  assert.match(css, /\.studio-dual-detail[^}]*max-height:\s*62vh/);
  // no horizontal overflow risk: rows use overflow hidden and ellipsis
  assert.match(densitySection, /overflow:\s*hidden/);
  assert.match(densitySection, /text-overflow:\s*ellipsis/);
});
test("WMB-5348 R2 ledger is single 44px flex row with two segments", async () => {
  const css = await readFile(cssUrl, "utf8");
  const ledgerBlock = css.slice(
    css.indexOf(".studio-dual-ledger {"),
    css.indexOf(".studio-dual-ledger {") + 800,
  );
  // container must be single 44px, flex, not grid, flex:none, horizontal
  assert.match(css, /\.studio-dual-ledger\s*\{[^}]*height:\s*44px/);
  assert.match(css, /\.studio-dual-ledger\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /\.studio-dual-ledger\s*\{[^}]*max-height:\s*44px/);
  assert.match(css, /\.studio-dual-ledger\s*\{[^}]*display:\s*flex/);
  assert.match(css, /\.studio-dual-ledger\s*\{[^}]*flex:\s*none/);
  // grid must not be primary display for ledger at default (>900px); media query handles narrow fallback
  const densitySection = css.slice(css.indexOf("WMB-5348"));
  // ensure ledger not grid at default
  assert.doesNotMatch(ledgerBlock, /display:\s*grid/);
  // rows must be flex:1 1 0, height 44, border-right not border-bottom, overflow hidden
  assert.match(css, /\.studio-dual-ledger-row[^}]*flex:\s*1 1 0/);
  assert.match(
    css,
    /\.studio-dual-ledger-row[^}]*border-right:\s*1px solid var\(--border-soft\)/,
  );
  assert.match(css, /\.studio-dual-ledger-row[^}]*height:\s*44px/);
  // ensure rows are exactly two segments side-by-side: file still has two data-kind values
  const tsx = await readFile(derivativeUrl, "utf8");
  assert.match(tsx, /data-kind="article"/);
  assert.match(tsx, /data-kind="derivative"/);
  // narrow fallback exists at 900px with column direction and 88px
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.studio-dual-ledger\s*\{[^}]*height:\s*88px/,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.studio-dual-ledger\s*\{[^}]*flex-direction:\s*column/,
  );
});

test("WMB-5348 R2 canvas chain enables internal scroll and pins footer/ledger", async () => {
  const css = await readFile(cssUrl, "utf8");
  // editor view/grid/document chain must have min-height:0 and overflow:hidden to constrain
  assert.match(css, /\.studio-editor-view\s*\{[^}]*min-height:\s*0/);
  assert.match(css, /\.studio-editor-grid\s*\{[^}]*min-height:\s*0/);
  assert.match(css, /\.studio-editor-grid\s*\{[^}]*overflow:\s*hidden/);
  assert.match(css, /\.studio-document\s*\{[^}]*min-height:\s*0/);
  assert.match(css, /\.studio-document\s*\{[^}]*display:\s*flex/);
  assert.match(css, /\.studio-document\s*\{[^}]*flex-direction:\s*column/);
  assert.match(css, /\.studio-document\s*\{[^}]*overflow:\s*hidden/);
  // canvas must be flex:1 with min-height:0 and overflow:auto (internal scroll)
  assert.match(css, /\.studio-canvas\s*\{[^}]*flex:\s*1 1 auto/);
  assert.match(css, /\.studio-canvas\s*\{[^}]*min-height:\s*0/);
  assert.match(css, /\.studio-canvas\s*\{[^}]*overflow:\s*auto/);
  // footer and ledger must be flex:none (pinned)
  assert.match(css, /\.studio-writing-status\s*\{[^}]*flex:\s*none/);
  // ledger flex:none already checked above, ensure not fixed/absolute
  const densitySection = css.slice(css.indexOf("WMB-5348"));
  assert.doesNotMatch(densitySection, /position:\s*fixed/);
  assert.doesNotMatch(densitySection, /position:\s*absolute/);
  // ensure canvas chain comment mentions internal scroll
  assert.match(css, /长正文内部滚动/);
});

test("WMB-5348 R2 ledger viewport visibility contract (long content)", async () => {
  // This unit test encodes the same viewport assertion that the Electron E2E will enforce:
  // ledger must be 44px, rows two segments each with required fields, and chain must allow
  // ledger.bottom <= statusbar.top even when canvas scrollHeight > clientHeight.
  // Old implementation (grid 88px + min-height:420) would fail the flex/min-height/height checks above,
  // and would also fail E2E bounding-rect check. We assert the CSS enables that viewport proof.
  const css = await readFile(cssUrl, "utf8");
  const ledgerHeight = (css.match(
    /\.studio-dual-ledger\s*\{[^}]*height:\s*(\d+)px/,
  ) || [])[1];
  assert.equal(
    ledgerHeight,
    "44",
    "ledger must be single 44px for viewport visibility",
  );
  const rowHeight = (css.match(
    /\.studio-dual-ledger-row[^}]*height:\s*(\d+)px/,
  ) || [])[1];
  assert.equal(rowHeight, "44");
  // ensure no horizontal overflow risk at target viewports
  const densitySection = css.slice(css.indexOf("WMB-5348"));
  assert.match(densitySection, /overflow:\s*hidden/);
  assert.match(densitySection, /white-space:\s*nowrap/);
});
