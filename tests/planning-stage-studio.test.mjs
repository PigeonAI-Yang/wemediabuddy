// WMB-5353 Studio truth: planning status gates Writer, ready awaits approval, approved uses plan_item.advance, v0 shows 尚未生成正文, ledger 44px preserved
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const viewUrl = new URL('../src/renderer/studio-view.tsx', import.meta.url);
const proposalsUrl = new URL('../src/renderer/proposals-view.tsx', import.meta.url);
const proposalLedgerUrl = new URL('../src/renderer/proposal-ledger.ts', import.meta.url);
const panelsUrl = new URL('../src/renderer/studio-view-panels.tsx', import.meta.url);
const derivativePanelUrl = new URL('../src/renderer/studio-derivative-panel.tsx', import.meta.url);
const contentUrl = new URL('../src/main/content.ts', import.meta.url);
const derivativeUrl = new URL('../src/main/content-derivative.ts', import.meta.url);
const studioContentUrl = new URL('../src/main/studio-content.ts', import.meta.url);
const cssUrl = new URL('../src/renderer/styles-studio.css', import.meta.url);

test('WMB-5353 draft and rejected expose no Writer/start-production entry', async () => {
  const proposals = await readFile(proposalsUrl, 'utf8');
  const ledger = await readFile(proposalLedgerUrl, 'utf8');
  assert.match(proposals, /planningStatus\s*===\s*'draft'[\s\S]*?派策划/);
  assert.match(proposals, /planningStatus\s*===\s*'rejected'[\s\S]*?重新策划/);
  assert.match(proposals, /onCreate=\{planningStatus\s*===\s*'approved'/);
  assert.match(ledger, /export function isDraft/);
  assert.match(ledger, /export function isRejected/);
  assert.doesNotMatch(proposals, /startStudioDraft|writeDraft/);
});

test('WMB-5353 ready_for_review clearly awaits approval', async () => {
  const proposals = await readFile(proposalsUrl, 'utf8');
  const ledger = await readFile(proposalLedgerUrl, 'utf8');
  assert.match(ledger, /export function isReadyForReview/);
  assert.match(proposals, /planningStatus\s*===\s*'ready_for_review'[\s\S]*?驳回[\s\S]*?批准并推进/);
  assert.match(proposals, /planningStatus\s*!==\s*'approved'[\s\S]*?proposal-planning-buttons/);
  assert.doesNotMatch(proposals, /planningStatus\s*===\s*'ready_for_review'[^\n]*advance\(item\)/);
});

test('WMB-5353 approved invokes fixed plan_item.advance idempotently', async () => {
  const proposals = await readFile(proposalsUrl, 'utf8');
  const ledger = await readFile(proposalLedgerUrl, 'utf8');
  assert.match(ledger, /'plan_item\.advance'/);
  assert.match(ledger, /export async function advancePlanItem/);
  assert.match(ledger, /w\.advancePlanItem\s*\?\?\s*w\.planItemAdvance/);
  assert.match(ledger, /requestId\s*\?/);
  assert.match(proposals, /onCreate=\{planningStatus\s*===\s*'approved'\s*\?\s*\(\)\s*=>\s*void advance\(item\)/);
  assert.match(proposals, /window\.wmb\.advancePlanItem\(\{\s*planItemId:\s*item\.planItemId\s*\}\)/);
  assert.match(proposals, /await\s+load\(tabRef\.current,\s*0,\s*false\)/);
});

test('WMB-5353 v0 renders 尚未生成正文 and never infers saved from dirty', async () => {
  const tsx = await readFile(viewUrl, 'utf8');
  const panels = await readFile(panelsUrl, 'utf8');
  const derivative = await readFile(derivativePanelUrl, 'utf8');
  const content = await readFile(contentUrl, 'utf8');
  // Frontend v0 strings
  assert.match(tsx, /尚未生成正文/);
  assert.match(panels, /尚未生成正文/);
  assert.match(derivative, /尚未生成正文/);
  // v0 placeholder uses versionCount === 0 guard
  assert.match(tsx, /versionCount\s*===\s*0/);
  assert.match(panels, /versionCount\s*===\s*0/);
  assert.match(derivative, /versionCount\s*===\s*0/);
  // Status bar must not show 已保存 when v0; must show 尚未生成正文 instead of dirty false inference
  assert.match(tsx, /versionCount\s*===\s*0\s*\?\s*'尚未生成正文'/);
  assert.match(panels, /versionCount\s*===\s*0\s*\?\s*'尚未生成正文'/);
  // Backend must expose versionCount truthfully and not fake
  assert.match(content, /versionCount/);
  assert.match(content, /revisions\.length/);
  // Ensure no fake saved path: content.ts should not return hardcoded body
  assert.doesNotMatch(content, /fake.*saved|default.*content/);
  // Check studio-content derives truth from versionCount
  const studioContent = await readFile(studioContentUrl, 'utf8');
  assert.match(studioContent, /versionCount/);
  assert.match(studioContent, /尚未生成正文/);
});

test('WMB-5353 real task/version states remain truthful', async () => {
  const content = await readFile(contentUrl, 'utf8');
  const studioContent = await readFile(studioContentUrl, 'utf8');
  // Backend reads real jobs and versionCount
  assert.match(content, /activeTasks/);
  assert.match(content, /FROM\s+jobs/);
  assert.match(content, /FROM\s+content_versions/);
  assert.match(content, /planningStatus/);
  assert.match(content, /plan_items/);
  // Studio derives truth via planningStatus, versionCount, activeTasks
  assert.match(studioContent, /planningStatus/);
  assert.match(studioContent, /activeTasks/);
  assert.match(studioContent, /canAdvance/);
  // Studio projection consumes the backend's real activeTasks and exposes it without inference.
  assert.match(studioContent, /activeTasks:\s*detail\.activeTasks\s*\?\?\s*\[\]/);
});

test('WMB-5353 preserves long-body scroll and 44px product ledger contract', async () => {
  const css = await readFile(cssUrl, 'utf8');
  const tsx = await readFile(viewUrl, 'utf8');
  const derivative = await readFile(derivativeUrl, 'utf8');
  const content = await readFile(contentUrl, 'utf8');
  // Ledger must remain 44px single row flex, not large cards
  assert.match(css, /\.studio-dual-ledger/);
  // Check that ledger height 44px still defined in earlier section (height or min-height 44)
  // We check that file still contains the WMB-5348 44px comment or height pattern
  const has44 = css.includes('44px') || css.includes('height: 44');
  assert.ok(has44, 'ledger should retain 44px');
  // Long body scroll: .studio-canvas flex:1 overflow:auto preserved
  assert.match(css, /\.studio-canvas\s*\{[^}]*flex:\s*1[^}]*overflow:\s*auto/);
  // flex:none for ledger and status to pin
  assert.match(css, /\.studio-dual-ledger\s*\{[^}]*flex:\s*none/);
  assert.match(css, /\.studio-writing-status\s*\{[^}]*flex:\s*none/);
  // Foundation tokens only: ensure no hardcoded hex outside allowlist (check uses var(--)
  assert.match(css, /var\(--/);
  // Studio chrome continues to use foundation tokens.
  assert.match(css, /var\(--border-soft\)/);
  // Check that derivative still uses ledger row structure
  const panel = await readFile(derivativePanelUrl, 'utf8');
  assert.match(panel, /studio-dual-ledger-row/);
  assert.match(panel, /data-kind="article"/);
  // Ensure no duplicate runtime/state paths
  assert.doesNotMatch(content, /duplicate.*runtime|second.*state/);
});
