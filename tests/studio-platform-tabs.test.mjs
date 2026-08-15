// WMB-5237 平台媒体投影：页签选择、平台草稿（标题/正文/assetIds/媒体绑定）基线与脏检测。
// studio-platform-tabs.ts 现在含运行时导入（shared media-token/media-bindings），
// 沿用 esbuild 打包模式（与 wmb-5237-studio-image-menu.test.mjs 一致）以支持直接断言纯函数。
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import esbuild from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));

let tabs;
let parseAssetImages;

test.before(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-platform-tabs-'));
  const outfile = path.join(dir, 'tabs.mjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'src/renderer/studio-platform-tabs.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent'
  });
  tabs = await import(pathToFileURL(outfile).href);
  const tokenOutfile = path.join(dir, 'token.mjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'src/shared/media-token.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: tokenOutfile,
    logLevel: 'silent'
  });
  const token = await import(pathToFileURL(tokenOutfile).href);
  parseAssetImages = token.parseAssetImages;
});

test('Studio platform tabs preserve one selected platform identity', () => {
  for (const platform of ['x', 'xiaohongshu', 'wechat', 'zhihu']) {
    const tab = tabs.studioPlatformTab(platform);
    assert.equal(tabs.studioPlatformFromTab(tab), platform);
  }
});

test('non-platform Studio tabs never select platform content', () => {
  for (const tab of ['core', 'versions', 'sources', 'assets', 'platform:unknown']) {
    assert.equal(tabs.studioPlatformFromTab(tab), null);
  }
});

test('Studio platform editor selects the requested version and falls back to latest', () => {
  const latest = { id: 'pv-latest', title: '最新', body: 'latest', assets: ['asset-a'] };
  const older = { id: 'pv-older', title: '旧版', body: 'older', assets: [] };
  const versions = [latest, older];
  assert.equal(tabs.selectStudioPlatformVersion(versions, older.id), older);
  assert.equal(tabs.selectStudioPlatformVersion(versions, 'stale-id'), latest);
  assert.equal(tabs.selectStudioPlatformVersion([], 'missing'), null);
});

test('Studio platform drafts preserve their baseline and detect human edits', () => {
  const version = { id: 'pv-1', title: '原标题', body: '原正文', assets: ['asset-a'] };
  const draft = tabs.createStudioPlatformDraft(version);
  assert.equal(tabs.studioPlatformDraftKey('xiaohongshu', version), 'pv-1');
  assert.equal(tabs.studioPlatformDraftKey('wechat', null), 'new:wechat');
  assert.equal(tabs.isStudioPlatformDraftDirty(draft), false);
  assert.equal(tabs.isStudioPlatformDraftDirty({ ...draft, body: '人工修改' }), true);
  assert.equal(tabs.isStudioPlatformDraftDirty({ ...draft, assetIds: [...draft.assetIds, 'asset-b'] }), true);
  assert.deepEqual(draft.baseAssetIds, ['asset-a']);
});

test('WMB-5237 platform draft: body references derive default bindings; no persisted field stays clean', () => {
  const version = { id: 'pv-1', title: 't', body: '![a](wmb-asset://A)\n\n![b](wmb-asset://B)\n', assets: ['A', 'B'] };
  const draft = tabs.createStudioPlatformDraft(version);
  assert.deepEqual(draft.mediaBindings.map((b) => `${b.assetId}:${b.ordinal}:${b.isCover}`), ['A:0:false', 'B:1:false']);
  // 旧 detail 无 mediaBindings 字段 → 推导默认绑定，且不脏
  assert.equal(tabs.isStudioPlatformDraftDirty(draft), false);
});

test('WMB-5237 platform draft: persisted bindings load with metadata preserved and stay clean', () => {
  const persisted = [
    { assetId: 'A', ordinal: 1, caption: 'capA', isCover: true, cropRegion: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 }, derivedAssetId: 'A2' },
    { assetId: 'B', ordinal: 0, caption: null, isCover: false, cropRegion: null, derivedAssetId: null }
  ];
  const draft = tabs.createStudioPlatformDraft({ id: 'pv-1', title: 't', body: '![a](wmb-asset://A)\n\n![b](wmb-asset://B)\n', assets: ['A2', 'B'], mediaBindings: persisted });
  // WMB-5246：读模型 → 草稿补齐 mediaKind（缺省 image）与视频附件字段（poster/clip/duration）。
  assert.deepEqual(draft.mediaBindings.find((b) => b.assetId === 'A'), {
    assetId: 'A', ordinal: 1, caption: 'capA', isCover: true, cropRegion: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
    derivedAssetId: 'A2', mediaKind: 'image', posterAssetId: null, clipRange: null, durationMs: null
  });
  assert.equal(tabs.isStudioPlatformDraftDirty(draft), false);
  // 加载到已有字段后不得无意清空：元数据保留在草稿与基线中
  assert.equal(tabs.platformMediaBindingsEqual(draft.mediaBindings, draft.baseMediaBindings), true);
});

test('WMB-5237 platform draft: replace/delete sync keeps cover and re-ranks ordinals', () => {
  const refs = (body) => parseAssetImages(body);
  const current = [
    { assetId: 'A', ordinal: 0, caption: 'capA', isCover: true, cropRegion: null, derivedAssetId: null },
    { assetId: 'B', ordinal: 1, caption: null, isCover: false, cropRegion: null, derivedAssetId: null }
  ];
  // 删除 B → A 保留封面，ordinal 重排为 0（WMB-5246 补齐 mediaKind/poster/clip/duration）
  const afterDelete = tabs.syncPlatformBindingsToRefs(current, refs('![a](wmb-asset://A)\n'));
  assert.deepEqual(afterDelete, [{
    assetId: 'A', ordinal: 0, caption: 'capA', isCover: true, cropRegion: null, derivedAssetId: null,
    mediaKind: 'image', posterAssetId: null, clipRange: null, durationMs: null
  }]);
  // 替换 A→C → 新 asset 用默认绑定（无 cover）
  const afterReplace = tabs.syncPlatformBindingsToRefs(current, refs('![c](wmb-asset://C)\n'));
  assert.deepEqual(afterReplace.map((b) => `${b.assetId}:${b.ordinal}:${b.isCover}`), ['C:0:false']);
});

test('WMB-5237 platform draft: X cover must be ordinal 0; single cover enforced on other platforms', () => {
  const base = ['A', 'B', 'C'].map((assetId, ordinal) => ({ assetId, ordinal, caption: null, isCover: false, cropRegion: null, derivedAssetId: null }));
  // X：设置 C 为封面自动移至发布序首位
  const x = tabs.setPlatformCover(base, 'C', true, 'x');
  assert.deepEqual(x.map((b) => `${b.assetId}:${b.ordinal}:${b.isCover}`), ['A:1:false', 'B:2:false', 'C:0:true']);
  // 小红书：封面可任意位置，同一版本至多一个（旧封面被清除）
  const xhs = tabs.setPlatformCover(base, 'B', true, 'xiaohongshu');
  assert.deepEqual(xhs.map((b) => `${b.assetId}:${b.ordinal}:${b.isCover}`), ['A:0:false', 'B:1:true', 'C:2:false']);
  // 取消封面
  assert.equal(tabs.setPlatformCover(xhs, 'B', false, 'xiaohongshu').some((b) => b.isCover), false);
});

test('WMB-5237 platform draft: publish order reorder swaps ordinals only', () => {
  const base = ['A', 'B', 'C'].map((assetId, ordinal) => ({ assetId, ordinal, caption: null, isCover: false, cropRegion: null, derivedAssetId: null }));
  const down = tabs.shiftPlatformBindingOrdinal(base, 'A', 1);
  assert.deepEqual(down.map((b) => `${b.assetId}:${b.ordinal}`), ['A:1', 'B:0', 'C:2']);
  const up = tabs.shiftPlatformBindingOrdinal(down, 'C', -1);
  assert.deepEqual(up.map((b) => `${b.assetId}:${b.ordinal}`), ['A:2', 'B:0', 'C:1']);
  // 边界：首位不能上移，末位不能下移
  assert.deepEqual(tabs.shiftPlatformBindingOrdinal(base, 'A', -1), base);
  assert.deepEqual(tabs.shiftPlatformBindingOrdinal(base, 'C', 1), base);
});

test('WMB-5237 platform draft: dirty reflects binding edits (cover/ordinal/caption/crop)', () => {
  const base = ['A', 'B'].map((assetId, ordinal) => ({ assetId, ordinal, caption: null, isCover: false, cropRegion: null, derivedAssetId: null }));
  const draft = { title: 't', body: 'b', assetIds: ['A', 'B'], mediaBindings: base, baseTitle: 't', baseBody: 'b', baseAssetIds: ['A', 'B'], baseMediaBindings: base.map((b) => ({ ...b })) };
  assert.equal(tabs.isStudioPlatformDraftDirty(draft), false);
  assert.equal(tabs.isStudioPlatformDraftDirty({ ...draft, mediaBindings: base.map((b) => (b.assetId === 'A' ? { ...b, isCover: true } : b)) }), true);
  assert.equal(tabs.isStudioPlatformDraftDirty({ ...draft, mediaBindings: base.map((b) => (b.assetId === 'A' ? { ...b, ordinal: 1 } : { ...b, ordinal: 0 })) }), true);
  assert.equal(tabs.isStudioPlatformDraftDirty({ ...draft, mediaBindings: base.map((b) => (b.assetId === 'A' ? { ...b, caption: 'cap' } : b)) }), true);
  assert.equal(tabs.isStudioPlatformDraftDirty({ ...draft, mediaBindings: base.map((b) => (b.assetId === 'A' ? { ...b, cropRegion: { x: 0, y: 0, width: 1, height: 1 } } : b)) }), true);
});
