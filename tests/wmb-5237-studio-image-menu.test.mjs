// WMB-5237 正式 Studio「本文图片 N 张」菜单 —— 聚焦合同测试。
// 覆盖：helpers 纯函数（解析 / 精确文本变换 / figure 提升 / 富文本回写契约）、
// 核心与平台菜单接线（changeBody 通路、平台 assetIds 去旧增新、只读历史只允许定位）、
// 禁用结构词（候选素材栏 / 版本结构检查 / 平台提醒 / 就绪度 / 冻结版本 / 图片工作台）。
// helpers 含 react/TSX 依赖不便直接导入：沿用 esbuild 打包 + dompurify 桩的测试模式。
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import esbuild from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));

let helpers;

test.before(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wmb-5237-studio-image-menu-'));
  const stub = path.join(dir, 'dompurify-stub.mjs');
  await writeFile(stub, 'export default { sanitize: (html) => html };\n', 'utf8');
  const outfile = path.join(dir, 'helpers.mjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'src/renderer/studio-view-helpers.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    alias: { dompurify: stub },
    logLevel: 'silent'
  });
  helpers = await import(pathToFileURL(outfile).href);
});

// ---------------------------------------------------------------------------
// 解析：token 识别、occurrence 序号、转义 alt、title、围栏跳过、外链忽略
// ---------------------------------------------------------------------------

test('WMB-5237 menu: parse lists every wmb-asset image token with offsets and occurrence', () => {
  const body = '第一段\n\n![图A](wmb-asset://aaa)\n\n文字 ![图B](wmb-asset://bbb) 行内\n\n![图A2](wmb-asset://aaa)\n\n# 标题 ![标题图](wmb-asset://ccc)';
  const refs = helpers.parseAssetImages(body);
  assert.equal(refs.length, 4);
  assert.equal(refs[0].assetId, 'aaa');
  assert.equal(refs[0].alt, '图A');
  assert.equal(refs[0].occurrence, 0);
  assert.equal(refs[1].assetId, 'bbb');
  assert.equal(refs[1].raw, '![图B](wmb-asset://bbb)');
  // 相同 asset 多次出现：occurrence 递增，token 区间精确
  assert.equal(refs[2].assetId, 'aaa');
  assert.equal(refs[2].occurrence, 1);
  assert.equal(refs[2].raw, '![图A2](wmb-asset://aaa)');
  assert.equal(body.slice(refs[2].start, refs[2].end), '![图A2](wmb-asset://aaa)');
  assert.equal(refs[3].assetId, 'ccc');
  assert.equal(body.slice(refs[1].start, refs[1].end), '![图B](wmb-asset://bbb)');
});

test('WMB-5237 menu: parse handles escaped alt brackets and nested brackets losslessly', () => {
  const escaped = helpers.parseAssetImages('![a \\[b\\] c](wmb-asset://1)');
  assert.equal(escaped[0].alt, 'a [b] c');
  assert.equal(escaped[0].raw, '![a \\[b\\] c](wmb-asset://1)');
  const nested = helpers.parseAssetImages('![a [b] c](wmb-asset://1)');
  assert.equal(nested[0].alt, 'a [b] c');
  const parenAlt = helpers.parseAssetImages('![a (b)](wmb-asset://1)');
  assert.equal(parenAlt[0].alt, 'a (b)');
});

test('WMB-5237 menu: parse preserves optional title inside the token span', () => {
  const refs = helpers.parseAssetImages('![a](wmb-asset://1 "标题")');
  assert.equal(refs[0].raw, '![a](wmb-asset://1 "标题")');
  assert.equal(refs[0].assetId, '1');
  assert.equal(refs[0].alt, 'a');
  assert.equal(refs[0].end - refs[0].start, '![a](wmb-asset://1 "标题")'.length);
});

test('WMB-5237 menu: parse skips code fences, ignores external images and empty body', () => {
  const fenced = helpers.parseAssetImages('para\n\n```\n![x](wmb-asset://1)\n```\n\n![y](wmb-asset://2)');
  assert.deepEqual(fenced.map((ref) => ref.assetId), ['2']);
  assert.equal(helpers.parseAssetImages('![p](https://x.com/a.png)').length, 0);
  assert.equal(helpers.parseAssetImages('![p](data:image/png;base64,xx)').length, 0);
  assert.equal(helpers.parseAssetImages('纯文本').length, 0);
  assert.equal(helpers.parseAssetImages('').length, 0);
});

test('WMB-5237 menu: parse handles empty alt and CRLF bodies', () => {
  assert.equal(helpers.parseAssetImages('![](wmb-asset://9)')[0].alt, '');
  const crlf = helpers.parseAssetImages('a\r\n\r\n![x](wmb-asset://1)\r\n\r\n![y](wmb-asset://2 "t")');
  assert.deepEqual(crlf.map((ref) => ref.assetId), ['1', '2']);
  assert.equal(crlf[1].raw, '![y](wmb-asset://2 "t")');
});

// ---------------------------------------------------------------------------
// 精确文本变换：编辑图注 / 替换 / 移出（occurrence 级，缺省 ref 不变更）
// ---------------------------------------------------------------------------

test('WMB-5237 menu: update alt rewrites only the alt segment, re-escapes, keeps title', () => {
  const next = helpers.updateAssetImageAlt('![a [b]](wmb-asset://1 "t")', '1', 0, '新 [图] 注 \\ 文');
  assert.equal(next, '![新 \\[图\\] 注 \\\\ 文](wmb-asset://1 "t")');
  // 回读仍是无损的原始图注
  assert.equal(helpers.parseAssetImages(next)[0].alt, '新 [图] 注 \\ 文');
  // occurrence 精确定位第二个同 asset token
  assert.equal(helpers.updateAssetImageAlt('![a](wmb-asset://1)\n\n![b](wmb-asset://1)', '1', 1, 'B'), '![a](wmb-asset://1)\n\n![B](wmb-asset://1)');
  // 找不到或值未变 → 原样返回
  assert.equal(helpers.updateAssetImageAlt('![a](wmb-asset://1)', 'nope', 0, 'x'), '![a](wmb-asset://1)');
  assert.equal(helpers.updateAssetImageAlt('![a](wmb-asset://1)', '1', 0, 'a'), '![a](wmb-asset://1)');
});

test('WMB-5237 menu: replace swaps the exact token in place without inserting a new one', () => {
  const next = helpers.replaceAssetImageToken('![a](wmb-asset://1)\n\n![b](wmb-asset://2)', '1', 0, '![c](wmb-asset://3)');
  assert.equal(next, '![c](wmb-asset://3)\n\n![b](wmb-asset://2)');
  // 同 token 或找不到 → 原样返回
  assert.equal(helpers.replaceAssetImageToken('![a](wmb-asset://1)', '2', 0, '![x](wmb-asset://9)'), '![a](wmb-asset://1)');
  assert.equal(helpers.replaceAssetImageToken('![a](wmb-asset://1)', '1', 0, '![a](wmb-asset://1)'), '![a](wmb-asset://1)');
});

test('WMB-5237 menu: remove deletes one occurrence and tidies blank lines or inline space', () => {
  // 独立成段：只收掉一个空行，段落分隔保留
  assert.equal(helpers.removeAssetImageToken('a\n\n![x](wmb-asset://1)\n\nb', '1', 0), 'a\n\nb');
  // CRLF 同规则
  assert.equal(helpers.removeAssetImageToken('a\r\n\r\n![x](wmb-asset://1)\r\n\r\nb', '1', 0), 'a\r\n\r\nb');
  // 重复 occurrence：只移除指定的那一个
  assert.equal(helpers.removeAssetImageToken('![x](wmb-asset://1)\n\n![x](wmb-asset://1)', '1', 0), '![x](wmb-asset://1)');
  // 行内：收掉一个空格
  assert.equal(helpers.removeAssetImageToken('a ![x](wmb-asset://1) b', '1', 0), 'a b');
  // 文末 / 全文唯一 / 找不到
  assert.equal(helpers.removeAssetImageToken('a\n\n![x](wmb-asset://1)', '1', 0), 'a');
  assert.equal(helpers.removeAssetImageToken('![x](wmb-asset://1)\n\n', '1', 0), '');
  assert.equal(helpers.removeAssetImageToken('x ![y](wmb-asset://2) y ![x](wmb-asset://1) y', '2', 0), 'x y ![x](wmb-asset://1) y');
});

test('WMB-5237 menu: referencedAssetIds dedupes so repeated occurrences never delete the asset id', () => {
  assert.deepEqual(helpers.referencedAssetIds('![a](wmb-asset://1) ![b](wmb-asset://2) ![a2](wmb-asset://1)'), ['1', '2']);
  assert.deepEqual(helpers.referencedAssetIds('![a](wmb-asset://1)'), ['1']);
  assert.deepEqual(helpers.referencedAssetIds('no images'), []);
  // 平台 assetIds 合并语义：去旧增新（旧 id 仍被引用则保留，新 id 进入）
  const referenced = helpers.referencedAssetIds('![old](wmb-asset://a)\n\n![new](wmb-asset://b)');
  const base = ['a', 'gone'];
  const next = [...new Set([...base.filter((id) => referenced.includes(id)), ...referenced])];
  assert.deepEqual(next, ['a', 'b']);
});

test('WMB-5237 menu: token builder and size formatter are stable pure helpers', () => {
  assert.equal(helpers.assetImageToken('a [b]', 'x1'), '![a \\[b\\]](wmb-asset://x1)');
  assert.equal(helpers.escapeAssetAlt('图注'), '图注');
  assert.equal(helpers.formatAssetSize(512), '512 B');
  assert.equal(helpers.formatAssetSize(2048), '2 KB');
  assert.equal(helpers.formatAssetSize(3 * 1024 * 1024), '3.0 MB');
  assert.equal(helpers.formatAssetSize(0), '—');
});

// ---------------------------------------------------------------------------
// 渲染管线：wmb-asset 图片提升为 figure（可见图注不进入 DOM 文本），外链语义不变
// ---------------------------------------------------------------------------

test('WMB-5237 menu: hoist wraps standalone asset image paragraphs into figure with caption attr', () => {
  const html = helpers.hoistAssetFigures('<p><img src="wmb-asset://abc" alt="图 &amp; 注"></p>\n');
  assert.equal(html, '<figure class="studio-figure" data-wmb-asset="abc" data-wmb-occurrence="0"><img src="wmb-asset://abc" alt="图 &amp; 注"><figcaption data-wmb-caption="图 &amp; 注"></figcaption></figure>\n');
  // 空 alt：不渲染 figcaption，回写仍为空 alt
  assert.equal(helpers.hoistAssetFigures('<p><img src="wmb-asset://abc" alt=""></p>\n'), '<figure class="studio-figure" data-wmb-asset="abc" data-wmb-occurrence="0"><img src="wmb-asset://abc" alt=""></figure>\n');
  // 同一 assetId 重复出现：occurrence 递增（正文内图片点击选中 / 布局投影的 renderer key 依据）
  assert.equal(helpers.hoistAssetFigures('<p><img src="wmb-asset://abc" alt="a"></p>\n<p><img src="wmb-asset://abc" alt="b"></p>\n'),
    '<figure class="studio-figure" data-wmb-asset="abc" data-wmb-occurrence="0"><img src="wmb-asset://abc" alt="a"><figcaption data-wmb-caption="a"></figcaption></figure>\n<figure class="studio-figure" data-wmb-asset="abc" data-wmb-occurrence="1"><img src="wmb-asset://abc" alt="b"><figcaption data-wmb-caption="b"></figcaption></figure>\n');
  // title 保留
  assert.match(helpers.hoistAssetFigures('<p><img src="wmb-asset://1" alt="a" title="t"></p>\n'), /<img src="wmb-asset:\/\/1" alt="a" title="t">/);
});

test('WMB-5237 menu: hoist leaves external, inline and multi-image paragraphs untouched', () => {
  assert.equal(helpers.hoistAssetFigures('<p><img src="https://x.com/a.png" alt="p"></p>\n'), '<p><img src="https://x.com/a.png" alt="p"></p>\n');
  assert.equal(helpers.hoistAssetFigures('<p>text <img src="wmb-asset://1" alt="a"> more</p>\n'), '<p>text <img src="wmb-asset://1" alt="a"> more</p>\n');
  assert.equal(helpers.hoistAssetFigures('<p><img src="wmb-asset://1" alt="a"> <img src="wmb-asset://2" alt="b"></p>\n'), '<p><img src="wmb-asset://1" alt="a"> <img src="wmb-asset://2" alt="b"></p>\n');
  assert.equal(helpers.hoistAssetFigures('no figure'), 'no figure');
});

test('WMB-5237 menu: renderMarkdown end-to-end emits figures for asset images and plain img for external', () => {
  const rendered = helpers.renderMarkdown('![图A](wmb-asset://aaa)\n\n普通段落 ![外链](https://x.com/p.png)');
  assert.match(rendered, /<figure class="studio-figure" data-wmb-asset="aaa" data-wmb-occurrence="0"><img src="wmb-asset:\/\/aaa" alt="图A"><figcaption data-wmb-caption="图A"><\/figcaption><\/figure>/);
  assert.match(rendered, /<img src="https:\/\/x.com\/p.png" alt="外链">/);
  assert.equal(helpers.renderMarkdown(''), '');
});

// ---------------------------------------------------------------------------
// 渲染层合同（源码级断言，与 WMB-5207 UI 测试同一模式）
// ---------------------------------------------------------------------------

const helpersSource = await readFile(path.join(root, 'src/renderer/studio-view-helpers.ts'), 'utf8');
const studioViewSource = await readFile(path.join(root, 'src/renderer/studio-view.tsx'), 'utf8');
const imageHandlersSource = await readFile(path.join(root, 'src/renderer/studio-view-image-handlers.tsx'), 'utf8');
const studioViewPlusImageHandlers = studioViewSource + imageHandlersSource;
const cssSource = await readFile(path.join(root, 'src/renderer/styles-studio.css'), 'utf8');

test('WMB-5237 menu: htmlToMarkdown returns a single image token from figure and never copies figcaption', () => {
  // FIGURE 分支只取 :scope > img，图注文本（data-wmb-caption 属性）不会进入回写文本
  assert.match(helpersSource, /node\.tagName === 'FIGURE'/);
  assert.match(helpersSource, /querySelector\(':scope > img'\)/);
  // 资产图片回写时转义 alt 保证无损；外链分支保持原语义
  assert.match(helpersSource, /const altText = src\.startsWith\('wmb-asset:\/\/'\) \? escapeAssetAlt\(alt\) : alt;/);
  assert.match(helpersSource, /`!\[\$\{altText\}\]\(\$\{src\}\)\\n\\n`/);
});

test('WMB-5237 menu: renderMarkdown hoists figures only for the asset scheme', () => {
  assert.match(helpersSource, /hoistAssetFigures\(repairCjkEmphasis\(sanitized\)\)/);
  assert.match(helpersSource, /wmb-asset:\/\/[^"]*"/);
  assert.doesNotMatch(helpersSource, /figcaption\s*\}\)/);
});

test('WMB-5237 menu: status bar projects only the current version body via parseAssetImages', () => {
  // 计数来自当前版本正文（editorBody / 只读历史 displayBody），不是 selected.assets 全量
  assert.match(studioViewSource, /parseAssetImages\(displayBody\)/);
  assert.match(studioViewSource, /本文图片 \{assetImageRefs\.length\} 张/);
  // 正文无图片、无来源媒体且无素材建议时不可展开（WMB-5246 共享菜单：图片/视频附件/建议均可展开）
  assert.match(studioViewSource, /if \(assetImageRefs\.length === 0 && \(selected\?\.sourceMedia\.length \?\? 0\) === 0 && mediaRecommendations == null\) return;/);
});

test('WMB-5237 menu: mutations always route through changeBody (dirty/history/批注迁移/版本保存)', () => {
  assert.match(studioViewPlusImageHandlers, /const next = replaceAssetImageToken\(editorBody, pending\.assetId, pending\.occurrence, result\.markdown\);/);
  assert.match(studioViewPlusImageHandlers, /const next = removeAssetImageToken\(editorBody, ref\.assetId, ref\.occurrence\);/);
  assert.match(studioViewPlusImageHandlers, /const next = updateAssetImageAlt\(editorBody, ref\.assetId, ref\.occurrence, alt\);/);
  // 三种修改路径都经过 changeBody
  const bodies = studioViewPlusImageHandlers.match(/changeBody\(next\)/g) ?? [];
  assert.ok(bodies.length >= 3, `changeBody(next) should appear in replace/remove/caption flows, got ${bodies.length}`);
});

test('WMB-5237 menu: replace imports independently via importStudioImage and swaps in place (no extra insert)', () => {
  assert.match(studioViewPlusImageHandlers, /window\.wmb\.importStudioImage\(\{/);
  // 替换路径不调用 insertMarkdown（插入入口只在原格式栏）
  const replaceBlock = studioViewPlusImageHandlers.slice(studioViewPlusImageHandlers.indexOf('const replaceAssetImage ='), studioViewPlusImageHandlers.indexOf('const removeAssetImage ='));
  assert.ok(!replaceBlock.includes('insertMarkdown'), 'replace must not insert a new token');
  assert.ok(replaceBlock.includes('replaceImageInput'), 'replace must use its own hidden file input');
});

test('WMB-5237 menu: platform bindings + assetIds derive only from body references; core untouched', () => {
  // 平台草稿绑定由正文引用对账：去旧增新，重复 occurrence 不误删（seenAssets 去重，元数据保留）
  assert.match(studioViewPlusImageHandlers, /const refs = parseAssetImages\(nextBody\);/);
  assert.match(studioViewPlusImageHandlers, /syncPlatformBindingsToRefs\(base, refs\)/);
  assert.match(studioViewPlusImageHandlers, /buildAssetIdsFromPlatformBindings\(mediaBindings\)/);
  // 同步只对平台生效（核心正文不维护绑定投影）
  assert.match(studioViewSource, /if \(!activePlatform\) return;/);
  // 保存仍走现有 saveStudioPlatform（assetIds 来自草稿或版本；mediaBindings 完整传递）
  assert.match(studioViewPlusImageHandlers, /assetIds: activePlatformDraft\?\.assetIds \?\? activePlatformVersion\?\.assets \?\? \[\]/);
  assert.match(studioViewPlusImageHandlers, /mediaBindings: savedBindings/);
});

test('WMB-5237 menu: read-only history can view and locate but cannot modify', () => {
  assert.match(studioViewSource, /!readOnlyVersion && <>[\s\S]*?移出/);
  assert.match(studioViewPlusImageHandlers, /<button type="button" onClick=\{\(\) => locateAssetImage\(ref\)\}>定位<\/button>/);
  // 只读版本禁止替换入口
  assert.match(studioViewSource, /if \(readOnlyVersion \|\| busy\) return;/);
});

test('WMB-5237 menu: locate selects the token in source and the Nth matching figure in rich mode', () => {
  assert.match(studioViewPlusImageHandlers, /textarea\.setSelectionRange\(ref\.start, ref\.end\)/);
  assert.match(studioViewPlusImageHandlers, /figure\[data-wmb-asset\]/);
  assert.match(studioViewPlusImageHandlers, /getAttribute\('data-wmb-asset'\) === ref\.assetId\)\[ref\.occurrence\]/);
  assert.match(studioViewPlusImageHandlers, /scrollIntoView\(\{ block: 'center', behavior \}\)/);
  assert.match(studioViewPlusImageHandlers, /prefers-reduced-motion/);
});

test('WMB-5237 menu: popup closes on Escape and outside clicks', () => {
  assert.match(studioViewSource, /event\.key === 'Escape'/);
  assert.match(studioViewSource, /imageMenuRef\.current\?\.contains\(target\)/);
  assert.match(studioViewSource, /imageMenuButtonRef\.current\?\.contains\(target\)/);
});

test('WMB-5237 menu: no forbidden structure words in the studio surface', () => {
  for (const word of ['候选素材', '版本结构', '平台提醒', '就绪度', '冻结版本', '图片工作台']) {
    assert.ok(!studioViewSource.includes(word), `studio-view.tsx must not contain ${word}`);
    assert.ok(!helpersSource.includes(word), `studio-view-helpers.ts must not contain ${word}`);
    assert.ok(!cssSource.includes(word), `styles-studio.css must not contain ${word}`);
  }
});

test('WMB-5237 menu: styles reuse tokens, bound the menu height, scroll horizontally, focus-visible and reduced-motion complete', () => {
  assert.match(cssSource, /\.studio-image-menu \{/);
  // 高度有界：WMB-5246 共享菜单容纳视频/建议卡片后改为视口响应式上限
  assert.match(cssSource, /max-height: min\(560px, calc\(100vh - 120px\)\)/);
  assert.match(cssSource, /overflow-x: auto/);
  assert.match(cssSource, /\.studio-image-actions button:focus-visible/);
  assert.match(cssSource, /content: attr\(data-wmb-caption\)/);
  assert.match(cssSource, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.studio-figure\.studio-figure-flash/);
  // 全部使用 token 变量，无硬编码色值
  for (const declaration of cssSource.split('}')) {
    if (!declaration.includes('studio-image-') && !declaration.includes('studio-figure')) continue;
    const hex = declaration.match(/#[0-9a-fA-F]{3,8}\b/);
    assert.equal(hex, null, `no raw hex in studio image styles: ${hex?.[0]}`);
  }
});
