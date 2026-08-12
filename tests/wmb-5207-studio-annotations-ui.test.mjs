// WMB-5207 Studio 正文批注 —— UI 切片聚焦合同测试（只写不跑；由主 Agent 集成后统一执行）。
// 覆盖：纯逻辑（选择校验/增量迁移/指纹/上下文/scope 键）与渲染层合同（preload 六方法、
// onFocusChange 扩展、marker 不污染正文、scope 隔离、可访问名称、主题 token、reduced-motion）。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  annotationContextAround,
  annotationScopeKey,
  computeBodyFingerprint,
  containsHeadingLine,
  leadingTitleLength,
  longestCommonPrefix,
  longestCommonSuffix,
  normalizeBodyWhitespace,
  shiftAnnotationRanges,
  trimToNonWhitespace,
  validateAnnotationSelection
} from '../src/renderer/studio-annotations.ts';

const row = (overrides) => ({
  projectId: 'p1', documentKind: 'core', documentId: 'v1', platform: null,
  id: 'a1', startOffset: 0, endOffset: 0, quotedText: '', prefixContext: '', suffixContext: '',
  bodyFingerprint: 'x', note: null, status: 'open', resolvedReason: null,
  createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z',
  resolvedAt: null, revision: 1, ...overrides
});

// ---------------------------------------------------------------------------
// 纯逻辑：选择归一化与校验
// ---------------------------------------------------------------------------

test('WMB-5207 UI: leading title prefix length matches display stripping', () => {
  assert.equal(leadingTitleLength('# Foo\n\n正文'), '# Foo\n\n'.length);
  assert.equal(leadingTitleLength('# Foo\r\n\r\n正文'), '# Foo\r\n\r\n'.replace(/\r/g, '').length);
  assert.equal(leadingTitleLength('正文开头'), 0);
  assert.equal(leadingTitleLength(''), 0);
});

test('WMB-5207 UI: source/text selections trim to non-whitespace body offsets', () => {
  const body = '今天天气很好，适合写作。';
  assert.deepEqual(trimToNonWhitespace(body, 0, 5), { start: 0, end: 5 });
  assert.deepEqual(trimToNonWhitespace(body, 0, 6), { start: 0, end: 6 });
  assert.equal(trimToNonWhitespace(body, 3, 3), null);
  assert.equal(trimToNonWhitespace(body, 4, 3), null);
  assert.equal(trimToNonWhitespace(body, -1, 3), null);
  assert.equal(trimToNonWhitespace(body, 0, 999), null);
  assert.equal(trimToNonWhitespace('   ', 0, 3), null);
  assert.deepEqual(trimToNonWhitespace('\n\nabc\n\n', 0, 7), { start: 2, end: 5 });
});

test('WMB-5207 UI: selection validation rejects empty/whitespace/heading/overlap/out-of-bounds', () => {
  const body = '第一段正文。\n\n## 小标题\n\n第二段正文。';
  assert.deepEqual(validateAnnotationSelection(body, 0, 5, []), { ok: true });
  assert.deepEqual(validateAnnotationSelection(body, 5, 5, []), { ok: false, reason: 'empty' });
  assert.deepEqual(validateAnnotationSelection(body, 6, 8, []), { ok: false, reason: 'empty' });
  assert.deepEqual(validateAnnotationSelection(body, 0, 200, []), { ok: false, reason: 'out_of_bounds' });
  assert.deepEqual(validateAnnotationSelection(body, -2, 3, []), { ok: false, reason: 'out_of_bounds' });
  // 标题行不可批注
  const headingStart = body.indexOf('## 小标题');
  assert.deepEqual(validateAnnotationSelection(body, headingStart, headingStart + 5, []), { ok: false, reason: 'heading' });
  // 与未解决批注重叠拒绝
  assert.deepEqual(validateAnnotationSelection(body, 0, 5, [row({ startOffset: 2, endOffset: 6 })]), { ok: false, reason: 'overlap' });
  assert.deepEqual(validateAnnotationSelection(body, 0, 5, [row({ startOffset: 5, endOffset: 9 })]), { ok: true });
  assert.deepEqual(validateAnnotationSelection(body, 0, 5, [row({ startOffset: 4, endOffset: 9 })]), { ok: false, reason: 'overlap' });
});

test('WMB-5207 UI: heading detection works for indented and nested headings', () => {
  assert.equal(containsHeadingLine('## 小标题'), true);
  assert.equal(containsHeadingLine('普通文字'), false);
  assert.equal(containsHeadingLine('第一行\n# 第二行是标题'), true);
  assert.equal(containsHeadingLine('#'), false);
  assert.equal(containsHeadingLine('###'), false);
});

// ---------------------------------------------------------------------------
// 纯逻辑：增量锚点迁移（设计 §7.1）
// ---------------------------------------------------------------------------

test('WMB-5207 UI: edits before a mark shift offsets by net character delta', () => {
  const prev = 'abcdefghij';
  const next = 'abcXXdefghij'; // 插入 2 字符于位置 3
  const rows = [
    row({ id: 'before', startOffset: 6, endOffset: 9, status: 'open' }),
    row({ id: 'at-start', startOffset: 3, endOffset: 6, status: 'open' })
  ];
  const shifted = shiftAnnotationRanges(rows, prev, next, '2026-08-12T00:00:00.000Z');
  assert.deepEqual(shifted[0], { ...rows[0], startOffset: 8, endOffset: 11 });
  assert.equal(shifted[1].status, 'resolved');
  assert.equal(shifted[1].resolvedReason, 'edited');
});

test('WMB-5207 UI: edits after a mark keep offsets unchanged', () => {
  const prev = 'abcdefghij';
  const next = 'abcdefghijZZ'; // 末尾追加
  const shifted = shiftAnnotationRanges([row({ id: 'a', startOffset: 1, endOffset: 4 })], prev, next, '2026-08-12T00:00:00.000Z');
  assert.deepEqual(shifted[0].startOffset, 1);
  assert.deepEqual(shifted[0].endOffset, 4);
});

test('WMB-5207 UI: edits intersecting a mark resolve it with reason edited', () => {
  const prev = 'abcdefghij';
  const next = 'abXYefghij'; // 删除 c、d 并插入 XY，覆盖标记 [2,5)
  const shifted = shiftAnnotationRanges([row({ id: 'a', startOffset: 2, endOffset: 5 })], prev, next, '2026-08-12T10:00:00.000Z');
  assert.equal(shifted[0].status, 'resolved');
  assert.equal(shifted[0].resolvedReason, 'edited');
  assert.equal(shifted[0].resolvedAt, '2026-08-12T10:00:00.000Z');
});

test('WMB-5207 UI: insertion at a mark end boundary resolves it', () => {
  const prev = 'abcdefghij';
  const next = 'abcdeXfghij';
  const shifted = shiftAnnotationRanges([row({ id: 'a', startOffset: 2, endOffset: 5 })], prev, next, '2026-08-12T10:00:00.000Z');
  assert.equal(shifted[0].status, 'resolved');
  assert.equal(shifted[0].resolvedReason, 'edited');
});

test('WMB-5207 UI: independent marks migrate independently; resolved rows stay untouched', () => {
  const prev = 'aaaa bbbb cccc dddd';
  const next = 'aaaa xxbbbb cccc dddd'; // 在位置 5 插入 xx（标记 A 之后、B/C 之前）
  const rows = [
    row({ id: 'A', startOffset: 0, endOffset: 4, status: 'open' }),
    row({ id: 'B', startOffset: 6, endOffset: 10, status: 'open' }),
    row({ id: 'C', startOffset: 12, endOffset: 16, status: 'open' }),
    row({ id: 'D', startOffset: 3, endOffset: 7, status: 'resolved', resolvedReason: 'user_removed', resolvedAt: '2026-08-12T00:00:00.000Z' })
  ];
  const shifted = shiftAnnotationRanges(rows, prev, next, '2026-08-12T00:00:00.000Z');
  assert.deepEqual(shifted[0].startOffset, 0); // 变更完全在 A 之后
  assert.deepEqual(shifted[1].startOffset, 8); // 平移 +2
  assert.deepEqual(shifted[2].startOffset, 14); // 平移 +2
  assert.equal(shifted[3].status, 'resolved');
  assert.deepEqual(shifted[3].startOffset, 3);
});

test('WMB-5207 UI: LCP/LCS helpers agree on common prefix/suffix', () => {
  assert.equal(longestCommonPrefix('abcdef', 'abcXYZ'), 3);
  assert.equal(longestCommonSuffix('abcdef', 'XYcdef'), 4);
  assert.equal(longestCommonPrefix('', 'x'), 0);
  assert.equal(longestCommonSuffix('x', ''), 0);
});

// ---------------------------------------------------------------------------
// 纯逻辑：指纹 / 上下文 / scope 键 / 空白归一化
// ---------------------------------------------------------------------------

test('WMB-5207 UI: body fingerprint is stable and content-sensitive', () => {
  const one = computeBodyFingerprint('今天天气很好。');
  assert.equal(computeBodyFingerprint('今天天气很好。'), one);
  assert.notEqual(computeBodyFingerprint('今天天气很好。改'), one);
  assert.match(one, /^[0-9a-f]{8}$/);
});

test('WMB-5207 UI: annotation context windows quote prefix and suffix', () => {
  const body = '前缀文字'.repeat(20) + '目标内容' + '后缀文字'.repeat(20);
  const start = body.indexOf('目标内容');
  const end = start + '目标内容'.length;
  const { prefixContext, suffixContext } = annotationContextAround(body, start, end, 8);
  assert.equal(prefixContext, body.slice(start - 8, start));
  assert.equal(suffixContext, body.slice(end, end + 8));
});

test('WMB-5207 UI: scope keys isolate core vs each platform version', () => {
  const core = { projectId: 'p1', documentKind: 'core', documentId: 'v1', platform: null };
  const coreNoVersion = { projectId: 'p1', documentKind: 'core', documentId: null, platform: null };
  const xhsV2 = { projectId: 'p1', documentKind: 'platform', documentId: 'pv2', platform: 'xiaohongshu' };
  const xV2 = { projectId: 'p1', documentKind: 'platform', documentId: 'pv2', platform: 'x' };
  assert.notEqual(annotationScopeKey(core), annotationScopeKey(coreNoVersion));
  assert.notEqual(annotationScopeKey(core), annotationScopeKey(xhsV2));
  assert.notEqual(annotationScopeKey(xhsV2), annotationScopeKey(xV2));
  assert.equal(annotationScopeKey(xhsV2), annotationScopeKey({ ...xhsV2 }));
});

test('WMB-5207 UI: whitespace normalization collapses newline runs and trims', () => {
  assert.equal(normalizeBodyWhitespace('a\n\n\n\nb\n\n\n'), 'a\n\nb');
  assert.equal(normalizeBodyWhitespace('  abc  '), 'abc');
});

// ---------------------------------------------------------------------------
// 渲染层合同（源码级断言）
// ---------------------------------------------------------------------------

const studioView = await readFile(new URL('../src/renderer/studio-view.tsx', import.meta.url), 'utf8');
const panels = await readFile(new URL('../src/renderer/studio-view-panels.tsx', import.meta.url), 'utf8');
const layer = await readFile(new URL('../src/renderer/studio-annotation-layer.tsx', import.meta.url), 'utf8');
const helpers = await readFile(new URL('../src/renderer/studio-annotations.ts', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/renderer/styles-studio.css', import.meta.url), 'utf8');
const wmbTypes = await readFile(new URL('../src/renderer/global.d.ts', import.meta.url), 'utf8');

test('WMB-5207 UI: preload annotation methods consumed by exact contract names', () => {
  for (const method of [
    'listStudioAnnotations',
    'createStudioAnnotation',
    'updateStudioAnnotation',
    'resolveStudioAnnotation',
    'reopenStudioAnnotation',
    'reconcileStudioAnnotations'
  ]) {
    assert.match(studioView, new RegExp(`window\\.wmb\\.${method}\\(`), `studio-view calls ${method}`);
    assert.match(wmbTypes, new RegExp(`${method}\\(`), `global.d.ts declares ${method}`);
  }
  assert.match(studioView, /mode: 'incremental' \| 'replacement'/);
  assert.match(studioView, /syncAnnotationsToBody\(scope, scopeKey, editorBody, 'replacement'\)/);
  assert.match(studioView, /reason: 'user_removed'/);
});

test('WMB-5207 UI: creation never injects marker syntax into the body', () => {
  // 创建路径只传 body/startOffset/endOffset/note，不传 quotedText，也不改写正文
  assert.match(studioView, /createStudioAnnotation\(\{\s*\.\.\.annotationScope,\s*body: editorBody,\s*startOffset: snapshot\.start,\s*endOffset: snapshot\.end,\s*note:/s);
  assert.doesNotMatch(studioView, /createStudioAnnotation[\s\S]{0,400}quotedText/);
  // 装饰层与正文分离：富文本用独立 wrap + 绝对定位层，源码用镜像层
  assert.match(studioView, /studio-rich-annotate-wrap/);
  assert.match(studioView, /studio-source-annotate-wrap/);
  assert.match(layer, /className="studio-annotation-mirror"/);
  assert.match(layer, /className="studio-annotation-layer"/);
  // 正文编辑路径（changeBody / htmlToMarkdown）不产生任何批注字符
  assert.doesNotMatch(studioView, /changeBody\([^)]*annotation/i);
  assert.doesNotMatch(layer, /execCommand/);
});

test('WMB-5207 UI: onFocusChange publishes current draft and open annotations', () => {
  assert.match(studioView, /studioDocument: annotationScope \? \{/);
  assert.match(studioView, /projectId: selected\.id/);
  assert.match(studioView, /documentKind: annotationScope\.documentKind/);
  assert.match(studioView, /currentBody: editorBody/);
  assert.match(studioView, /bodyFingerprint: computeBodyFingerprint\(editorBody\)/);
  assert.match(studioView, /dirty\s*$/m);
  assert.match(studioView, /openAnnotations: rowsCurrent \? openAnnotationRows\.map/);
  assert.match(studioView, /quotedText: row\.quotedText/);
  assert.match(studioView, /prefixContext: context\.prefixContext/);
  // 始终反映当前可编辑草稿：焦点效果依赖 editorBody/editorTitle/dirty
  assert.match(studioView, /editorBody, editorTitle, dirty, annotationScopeKeyValue, openAnnotationRows\]/);
});

test('WMB-5207 UI: read-only history, title and preview are annotation-disabled', () => {
  assert.match(studioView, /annotationsEditable = Boolean\(selected && annotationScope && !readOnlyVersion && !busy\)/);
  assert.match(studioView, /if \(!annotationsEditable\) return null;/);
  assert.match(studioView, /if \(!annotationsEditable \|\| !annotationScope\) return;/);
  // 只读历史不渲染装饰层
  assert.match(studioView, /!readOnlyVersion && <StudioAnnotationOverlay/);
});

test('WMB-5207 UI: scope isolation covers core and every platform version', () => {
  assert.match(studioView, /documentKind: 'platform'/);
  assert.match(studioView, /documentId: activePlatformVersion\?\.id \?\? activePlatformVersion\?\.contentVersionId \?\? latest\?\.id/);
  assert.match(studioView, /documentKind: 'core'/);
  assert.match(studioView, /platform: activePlatform/);
});

test('WMB-5207 UI: keyboard toolbar and accessible names', () => {
  assert.match(panels, /aria-label="标记所选文字为有问题"/);
  assert.match(panels, /title="把所选文字标记为有问题"/);
  assert.match(layer, /aria-label=\{row\.note \? `问题标记：\$\{row\.note\}` : '问题标记：仅标记'\}/);
  assert.match(layer, /role="menu"/);
  assert.match(layer, /role="menuitem"/);
  assert.match(layer, /role="dialog"/);
  assert.match(studioView, /标记为有问题/);
  assert.match(studioView, /标记并说明…/);
  assert.match(layer, /编辑说明|添加说明/);
  assert.match(layer, /移除标记/);
  assert.match(layer, /重新打开/);
  assert.match(layer, /和 Pi 讨论这 \$\{openRows\.length\} 处/);
  assert.match(layer, /aria-label=\{`定位正文：\$\{row\.quotedText\}`\}/);
  // 键盘可达：ContextMenu / Shift+F10 打开批注菜单
  assert.match(layer, /event\.key === 'ContextMenu' \|\| \(event\.shiftKey && event\.key === 'F10'\)/);
});

test('WMB-5207 UI: reduced motion honored for locate and transitions', () => {
  assert.match(studioView, /prefers-reduced-motion: reduce/);
  assert.match(studioView, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches \? 'auto' : 'smooth'/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test('WMB-5207 UI: annotation styles use theme tokens without hardcoded color bypass', () => {
  assert.match(css, /--wmb-annotation-bg:/);
  assert.match(css, /--wmb-annotation-bg-strong:/);
  assert.match(css, /--wmb-annotation-line: var\(--amber\)/);
  assert.match(css, /:root\[data-theme="light"\]\s*\{[\s\S]*?--wmb-annotation-bg:/);
  // 批注视觉规则不出现裸色值旁路
  const annotationRules = css.slice(css.indexOf('/* ============ WMB-5207'));
  assert.doesNotMatch(annotationRules, /#[0-9a-fA-F]{3,6}/);
  assert.doesNotMatch(annotationRules, /rgb\(\s*\d+\s+\d+\s+\d+\s*\)/);
});

test('WMB-5207 UI: optimistic incremental migration stays a pure local function', () => {
  assert.match(helpers, /export function shiftAnnotationRanges/);
  assert.match(helpers, /status: 'resolved', resolvedReason: 'edited'/);
  assert.match(studioView, /shiftAnnotationRanges\(rows, previous, basis\)/);
  assert.match(studioView, /syncAnnotationsToBody\(scope, scopeKey, editorBody, 'incremental'\)/);
  // 保存先等待权威增量同步，避免防抖或在途 reconcile 与正文事务竞态。
  assert.match(studioView, /await syncAnnotationsToBody\(annotationScope, annotationScopeKeyValue, editorBody, 'incremental'\)/);
  assert.match(studioView, /setMessage\('批注同步失败，正文尚未保存，请重试'\)/);
  // 外部替换只接受后端权威 reconcile。
  assert.match(studioView, /syncAnnotationsToBody\(scope, scopeKey, editorBody, 'replacement'\)/);
});
