// WMB-5237 发布前正文编译 —— 聚焦合同测试（ImplementPublicationCompile 最终 API）。
// 覆盖（共享合同）：
// - X / 小红书：移除全部 wmb-asset 图片 token（独立成段连同相邻空行收敛，行内 token 移除保留文字），
//   规范空行，编译后正文不得残留任何内部 markdown token；图片只进附件（bindings 冻结顺序，
//   derivedAssetId || assetId 按 ordinal 投影）；无 token 纯文本逐字节不变；
// - 微信：token 编译为真实图片表示 `<img src="wmb-asset://…">`（inlineImages=true），
//   绝不发布字面 token；当前纯文本适配器无法投递正文图片时 fail-closed（中文错误，不静默删图）；
// - 通道门纯函数（containsInternalMediaToken / hasInlineAssetImageElement / assert*）；
// - 微信适配器在触碰编辑器前调用 fail-closed 门（浏览器模块无法 headless 执行，
//   沿用既有 esbuild/结构断言模式，语义级、不依赖行号）。
// 全部行为断言基于 production 纯函数，不做源码字符串断言（浏览器适配器结构除外）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertInlineAssetImageDeliverable,
  assertNoInternalMediaToken,
  compilePlatformBody,
  containsInternalMediaToken,
  hasInlineAssetImageElement
} from '../src/main/platform-body-compile.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

/** 构造最小 PlatformMediaBinding 读模型（字段名与 shared/media-bindings.ts 一致）。 */
function binding(assetId, ordinal, options = {}) {
  return {
    id: `b-${assetId}-${ordinal}`,
    platformVersionId: 'pv-1',
    assetId,
    ordinal,
    caption: null,
    isCover: false,
    cropRegion: null,
    derivedAssetId: options.derivedAssetId ?? null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
}

// ---------------------------------------------------------------------------
// X / 小红书：token 段移除 + 空行规范；图片只进附件顺序
// ---------------------------------------------------------------------------

test('WMB-5237 publish: X strips standalone token paragraphs, converges blank lines and never leaves internal tokens', () => {
  const result = compilePlatformBody({
    platform: 'x',
    body: '第一段\n\n![图A](wmb-asset://a)\n\n![图B](wmb-asset://b)\n\n结尾',
    bindings: [binding('a', 0), binding('b', 1)]
  });
  assert.equal(result.body, '第一段\n\n结尾', '独立 token 段连同相邻空行收敛为一个段落分隔');
  assert.ok(!result.body.includes('wmb-asset'), '编译后不得残留内部 token');
  assert.ok(!result.body.includes('!['), '不得残留任何 markdown 图片语法');
  assert.equal(result.imageTokens, 2);
  assert.equal(result.inlineImages, false);
  assert.deepEqual(result.assetIds, ['a', 'b'], '附件顺序 = bindings 按 ordinal 冻结');
});

test('WMB-5237 publish: X removes inline tokens but keeps surrounding text', () => {
  const result = compilePlatformBody({
    platform: 'x',
    body: '文字 ![图](wmb-asset://a) 继续',
    bindings: [binding('a', 0)]
  });
  assert.equal(result.body, '文字 继续');
  assert.equal(result.imageTokens, 1);
  assert.ok(!result.body.includes('!['));
});

test('WMB-5237 publish: Xiaohongshu follows the same token-strip and blank-line contract', () => {
  const result = compilePlatformBody({
    platform: 'xiaohongshu',
    body: '开头\n\n![图A](wmb-asset://a)\n\n中间\n\n\n\n![图B](wmb-asset://b)\n\n结尾',
    bindings: [binding('a', 0), binding('b', 1)]
  });
  assert.ok(!result.body.includes('wmb-asset'));
  assert.ok(!result.body.includes('!['));
  assert.equal(result.inlineImages, false);
  assert.equal(result.imageTokens, 2);
  assert.ok(!/\n{3,}/.test(result.body), '规范空行：段落间至多一个空行');
  assert.ok(result.body.includes('开头') && result.body.includes('中间') && result.body.includes('结尾'));
  assert.deepEqual(result.assetIds, ['a', 'b']);
});

test('WMB-5237 publish: assetIds projection uses derivedAssetId || assetId by ordinal, independent of body order', () => {
  const result = compilePlatformBody({
    platform: 'x',
    body: '![图B](wmb-asset://b)\n\n![图A](wmb-asset://a)',
    bindings: [
      binding('a', 1, { derivedAssetId: 'd-a' }),
      binding('b', 0)
    ]
  });
  assert.deepEqual(result.assetIds, ['b', 'd-a']);
});

test('WMB-5237 publish: pure text without tokens is byte-identical and deterministic', () => {
  const body = '纯文本正文\n\n第二段，无图片';
  const first = compilePlatformBody({ platform: 'x', body, bindings: [] });
  assert.equal(first.body, body);
  assert.equal(first.imageTokens, 0);
  assert.equal(first.inlineImages, false);
  assert.deepEqual(first.assetIds, []);
  const second = compilePlatformBody({ platform: 'wechat', body, bindings: [] });
  assert.equal(second.body, body, '微信纯文本同样逐字节不变');
  assert.deepEqual(first, second);
  assert.equal(compilePlatformBody({ platform: 'x', body: '', bindings: [] }).body, '');
});

// ---------------------------------------------------------------------------
// 微信：token → 真实图片表示；适配器 fail-closed 且绝不发布字面 token
// ---------------------------------------------------------------------------

test('WMB-5237 publish: WeChat compiles tokens into real img HTML with inlineImages=true', () => {
  const result = compilePlatformBody({
    platform: 'wechat',
    body: '第一段\n\n![图A](wmb-asset://a)\n\n结尾',
    bindings: [binding('a', 0)]
  });
  assert.match(result.body, /<p><img src="wmb-asset:\/\/a" alt="图A"><\/p>/);
  assert.ok(!result.body.includes('!['), '绝不发布字面 markdown token');
  assert.ok(!result.body.includes('](wmb-asset://'), 'token 语法必须被编译为实际图片表示');
  assert.equal(result.inlineImages, true);
  assert.equal(result.imageTokens, 1);
  assert.deepEqual(result.assetIds, ['a']);
});

test('WMB-5237 publish: WeChat compiles inline tokens to inline img and escapes alt attributes', () => {
  const inline = compilePlatformBody({
    platform: 'wechat',
    body: '文字 ![图](wmb-asset://a) 继续',
    bindings: [binding('a', 0)]
  });
  assert.match(inline.body, /文字 <img src="wmb-asset:\/\/a" alt="图"> 继续/);

  const escaped = compilePlatformBody({
    platform: 'wechat',
    body: '![a"b<&>](wmb-asset://1)',
    bindings: [binding('1', 0)]
  });
  assert.match(escaped.body, /alt="a&quot;b&lt;&amp;&gt;"/);
  assert.equal(escaped.inlineImages, true);
});

test('WMB-5237 publish: internal-token and inline-image channel gates behave fail-closed', () => {
  assert.equal(containsInternalMediaToken('![a](wmb-asset://1)'), true);
  assert.equal(containsInternalMediaToken('<img src="wmb-asset://1" alt="x">'), false);
  assert.equal(containsInternalMediaToken('纯文本'), false);

  assert.equal(hasInlineAssetImageElement('<img src="wmb-asset://1" alt="x">'), true);
  assert.equal(hasInlineAssetImageElement('![a](wmb-asset://1)'), false);
  assert.equal(hasInlineAssetImageElement('纯文本'), false);

  assert.throws(() => assertNoInternalMediaToken('![a](wmb-asset://1)'), /内部图片标记/);
  assert.doesNotThrow(() => assertNoInternalMediaToken('纯文本'));
  assert.throws(() => assertInlineAssetImageDeliverable('<img src="wmb-asset://1" alt="x">'), /仅支持纯文本/);
  assert.doesNotThrow(() => assertInlineAssetImageDeliverable('纯文本'));
});

test('WMB-5237 publish: wechat adapter fails closed before touching the editor (never silently drops images)', async () => {
  // 浏览器适配器无法在 Node 中 headless 执行：语义级结构断言（既有 harness 模式，不依赖行号）。
  const wechatSource = await readFile(path.join(root, 'src/main/platforms/wechat.ts'), 'utf8');
  assert.match(wechatSource, /assertNoInternalMediaToken\(body\)/, '发布前必须拒绝残留内部 token');
  assert.match(wechatSource, /assertInlineAssetImageDeliverable\(body\)/, '发布前必须按投递能力 fail-closed');
  // fail-closed 门必须发生在触碰编辑器之前（限定在 prepareWechatArticle 函数体内比对）。
  const prepareSection = wechatSource.slice(wechatSource.indexOf('export async function prepareWechatArticle'));
  assert.ok(
    prepareSection.indexOf('assertNoInternalMediaToken(body)') < prepareSection.indexOf('await connect'),
    'fail-closed 门必须发生在触碰编辑器之前'
  );
  // fail-closed 错误文案为中文且明确说明停止原因（绝不静默删图）。
  const compileSource = await readFile(path.join(root, 'src/main/platform-body-compile.ts'), 'utf8');
  assert.match(compileSource, /发布正文仍包含内部图片标记，发布通道拒绝执行/);
  assert.match(compileSource, /仅支持纯文本编辑器填充，无法投递正文图片/);
  assert.match(compileSource, /绝不把字面 token 发布，也绝不静默删图/);
});
