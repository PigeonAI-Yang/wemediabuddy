// WMB-5237 SourceMark 作者头像失败回落 —— renderer 聚焦合同测试。
// 覆盖：有效远程头像仍走作者头像分支；头像 img 加载 error 后，同一 SourceMark
// 实例确定性回落至 canonicalUrl 对应注册/平台标志（复用既有 registered/platform/
// fallback 分支，不新增占位或配色）；失败状态随 avatarUrl 更换复位；无头像行为
// 不变；API 兼容（props 不变）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const sourceMark = await readFile(new URL('../src/renderer/source-mark.tsx', import.meta.url), 'utf8');

test('WMB-5237 SourceMark: 有效远程头像仍展示作者头像', () => {
  assert.match(sourceMark, /source-mark-avatar/);
  // 头像分支只在 avatarUrl 为 http(s) 且未加载失败时渲染
  assert.match(sourceMark, /!avatarFailed && isHttpUrl\(avatarUrl\)/);
  assert.match(sourceMark, /src=\{avatarUrl\}/);
  assert.match(sourceMark, /title="作者头像"/);
});

test('WMB-5237 SourceMark: 头像加载 error 后同一实例回落至 canonicalUrl 标志', () => {
  // 头像 img 挂 onError → 同一实例置 avatarFailed，失败图不再持续渲染
  assert.match(sourceMark, /onError=\{\(\) => setAvatarFailed\(true\)\}/);
  // avatarFailed 门控头像分支：error 后跳过头像，直接落到 canonicalUrl 解析链
  const registeredStart = sourceMark.indexOf('const registered = aiSourcePresentation');
  assert.ok(registeredStart > 0, '头像分支之后必须直接衔接 registered 解析（同一回落链）');
  assert.match(sourceMark.slice(0, registeredStart), /!avatarFailed && isHttpUrl\(avatarUrl\)/);
  // 回落链复用既有 registered / platform / fallback 分支，全部按 canonicalUrl 解析
  assert.match(sourceMark, /findSourceLogo\(canonicalUrl, registeredSources\)/);
  assert.match(sourceMark, /platformIdFromUrl\(canonicalUrl\)/);
  assert.match(sourceMark, /source-mark-fallback/);
});

test('WMB-5237 SourceMark: 失败状态随 avatarUrl 更换而复位', () => {
  assert.match(sourceMark, /useEffect\(\(\) => \{/);
  assert.match(sourceMark, /setAvatarFailed\(false\)/);
  assert.match(sourceMark, /\}, \[avatarUrl\]\);/);
});

test('WMB-5237 SourceMark: 无头像行为不变、API 兼容、无新配色', () => {
  // props 原样：canonicalUrl / aiSourcePresentation / avatarUrl = null
  assert.match(sourceMark, /canonicalUrl: string \| null/);
  assert.match(sourceMark, /aiSourcePresentation: boolean/);
  assert.match(sourceMark, /avatarUrl\?: string \| null/);
  // 组件不新增任何颜色字面量
  assert.doesNotMatch(sourceMark, /#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)/);
});
