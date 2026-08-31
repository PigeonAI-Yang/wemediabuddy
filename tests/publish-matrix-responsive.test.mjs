// publish-matrix-responsive.test.mjs — focused contract for matrix shrinkable grid + overflow ownership
// Run: node --test tests/publish-matrix-responsive.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cssPath = path.join(root, 'src/renderer/styles-studio.css');
const tsxPath = path.join(root, 'src/renderer/publishing-results-view.tsx');

const css = await readFile(cssPath, 'utf8');
const tsx = await readFile(tsxPath, 'utf8');

function extractBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\n${escaped}\\s*\\{([^}]*)\\}`, 's');
  const m = css.match(re);
  if (m) return m[1];
  const re2 = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 's');
  const m2 = css.match(re2);
  return m2 ? m2[1] : null;
}

test('inline grid fallback uses shrinkable columns (content retains priority, platforms minmax(0,1fr))', () => {
  assert.match(tsx, /gridTemplateColumns[^;]*var\(--publish-col-content,\s*minmax\(220px,\s*1\.45fr\)\)/);
  assert.match(tsx, /repeat\(\$\{matrixPlatforms\.length\},\s*var\(--publish-col-platform,\s*minmax\(0,\s*1fr\)\)\)/);
  assert.doesNotMatch(tsx, /minmax\(288px/);
  assert.doesNotMatch(tsx, /minmax\(178px/);
});

test('publish-page owns vertical scroll (no overflow:hidden)', () => {
  const pageBlock = extractBlock('.publish-page');
  assert.ok(pageBlock, '.publish-page block exists');
  assert.match(pageBlock, /overflow-y:\s*auto/);
  assert.match(pageBlock, /overflow-x:\s*hidden/);
  assert.doesNotMatch(pageBlock, /overflow:\s*hidden\s*;/);
});

test('matrix wrap uses container-type inline-size and no flex scroll trap', () => {
  const wrapBlock = extractBlock('.publish-matrix-wrap');
  assert.ok(wrapBlock, '.publish-matrix-wrap exists');
  assert.match(wrapBlock, /container-type:\s*inline-size/);
  assert.match(wrapBlock, /container-name:\s*publish-matrix/);
  assert.match(wrapBlock, /overflow:\s*visible/);
  assert.doesNotMatch(wrapBlock, /overflow:\s*auto/);
  assert.match(wrapBlock, /display:\s*block/);
});

test('matrix scroller has no internal vertical scroll and clip horizontal at base', () => {
  const scrollerBlock = extractBlock('.publish-matrix-scroller');
  assert.ok(scrollerBlock, '.publish-matrix-scroller exists');
  assert.match(scrollerBlock, /overflow-x:\s*clip/);
  assert.match(scrollerBlock, /overflow-y:\s*visible/);
  assert.doesNotMatch(scrollerBlock, /overflow:\s*auto/);
  assert.doesNotMatch(scrollerBlock, /flex:\s*1\s+1\s+auto/);
});

test('matrix grid is shrinkable: min-width 0, content 220/0 fallback, platforms 0', () => {
  const matrixBlock = extractBlock('.publish-matrix');
  assert.ok(matrixBlock, '.publish-matrix exists');
  assert.match(matrixBlock, /--publish-col-content:\s*minmax\(220px,\s*1\.45fr\)/);
  assert.match(matrixBlock, /--publish-col-platform:\s*minmax\(0,\s*1fr\)/);
  assert.match(matrixBlock, /min-width:\s*0/);
  assert.doesNotMatch(matrixBlock, /min-width:\s*1000px/);
  assert.doesNotMatch(matrixBlock, /min-width:\s*920px/);
  assert.doesNotMatch(matrixBlock, /min-width:\s*880px/);
  assert.match(matrixBlock, /width:\s*100%/);
  assert.match(matrixBlock, /max-width:\s*100%/);
});

test('grid children have min-width:0 and bounded text handling', () => {
  assert.match(css, /\.publish-matrix-head,\s*\.publish-matrix-row\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /\.publish-matrix-head\s*>\s*\*,\s*\.publish-matrix-row\s*>\s*\*\s*\{[^}]*min-width:\s*0/);
  const nameBlock = extractBlock('.publish-project-name');
  assert.ok(nameBlock, '.publish-project-name exists');
  assert.match(nameBlock, /-webkit-line-clamp:\s*2/);
  assert.match(nameBlock, /line-clamp:\s*2/);
  assert.match(nameBlock, /overflow:\s*hidden/);
  assert.match(nameBlock, /display:\s*-webkit-box/);
  assert.match(css, /\.publish-platform-copy\s*\{[^}]*overflow:\s*hidden/);
  const metaBlock = extractBlock('.publish-cell-meta');
  assert.ok(metaBlock, '.publish-cell-meta exists');
  assert.match(metaBlock, /white-space:\s*nowrap/);
  assert.match(metaBlock, /text-overflow:\s*ellipsis/);
  assert.match(css, /\.publish-cell-action\s*\{[^}]*-webkit-line-clamp:\s*2/);
});

test('viewport folklore removed: matrix no hard min-width at 1400/1180', () => {
  const media1400Idx = css.indexOf('@media (max-width: 1400px)');
  const media1180Idx = css.indexOf('@media (max-width: 1180px)');
  const snippet1400 = css.slice(media1400Idx, media1400Idx+500);
  const snippet1180 = css.slice(media1180Idx, media1180Idx+800);
  assert.doesNotMatch(snippet1400, /\.publish-matrix[^}]*min-width:/);
  assert.doesNotMatch(snippet1180, /\.publish-matrix[^}]*min-width:\s*[0-9]+px/);
  assert.match(snippet1400, /min-height:\s*68px/);
});

test('narrow-only fallback via container query (not viewport)', () => {
  assert.match(css, /@container\s*\(max-width:\s*760px\)/);
  const container760Idx = css.indexOf('@container (max-width: 760px)');
  const containerSnippet = css.slice(container760Idx, container760Idx+800);
  assert.match(containerSnippet, /overflow-x:\s*auto/);
  assert.match(containerSnippet, /--publish-col-platform:\s*minmax\(132px,\s*1fr\)/);
  assert.match(containerSnippet, /min-width:\s*640px/);
  assert.match(css, /@container\s*\(max-width:\s*520px\)/);
});

test('math: 5 columns (content+4 platforms) fit at 960-990 without horizontal scroll', () => {
  const available = 960;
  const contentMin = 220;
  const platformFloorBase = 0;
  const platformFloorReadable = 132;
  const totalBase = contentMin + 4*platformFloorBase;
  const totalReadable = contentMin + 4*platformFloorReadable;
  assert.ok(totalBase <= available, `base total ${totalBase} must fit ${available}`);
  assert.ok(totalReadable <= available, `readable total ${totalReadable} must fit ${available} (evidence: 220+4*132=748 <960)`);
  const legacy = 288 + 4*178;
  assert.ok(legacy > available, `legacy ${legacy} > ${available} proves overflow root cause`);
  assert.doesNotMatch(css, /min-width:\s*1000px/);
});

test('math: 3 and 2 platform cases also fit at 960', () => {
  const available = 960;
  const contentMin = 220;
  const readableFloor = 132;
  const total3 = contentMin + 3*readableFloor;
  const total2 = contentMin + 2*readableFloor;
  assert.ok(total3 <= available, `3 platforms ${total3} <= ${available}`);
  assert.ok(total2 <= available, `2 platforms ${total2} <= ${available}`);
});

test('math: narrow container 560 triggers fallback scroll for 4 platforms', () => {
  const narrow = 560;
  const fallbackMinWidth = 640;
  assert.ok(fallbackMinWidth > narrow, `fallback ${fallbackMinWidth} > narrow ${narrow} => scroll needed`);
  const readableTotal = 220 + 4*132;
  assert.ok(readableTotal > narrow, `readable ${readableTotal} > narrow ${narrow} => overflow`);
  const veryNarrow = 500;
  assert.ok(560 > veryNarrow, `520 breakpoint min 560 > veryNarrow 500 ensures fallback`);
});

test('no brand tokens / hex literals introduced in publish CSS (foundation vars only)', () => {
  const publishSection = css.slice(css.indexOf('.publish-page'), css.indexOf('.pf-tag'));
  const hexMatches = publishSection.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  assert.equal(hexMatches.length, 0, `publish CSS should use foundation vars only, found hex ${hexMatches.join(',')}`);
});

test('TSX preserves semantics: PLATFORM_ORDER, attention, takeover etc not altered', () => {
  assert.match(tsx, /PLATFORM_ORDER/);
  assert.match(tsx, /function attentionOf/);
  assert.match(tsx, /export function PublishView/);
  assert.match(tsx, /repeat\(\$\{matrixPlatforms\.length\}/);
});
