import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudioPlatformDraft, isStudioPlatformDraftDirty, selectStudioPlatformVersion, studioPlatformDraftKey, studioPlatformFromTab, studioPlatformTab } from '../src/renderer/studio-platform-tabs.ts';

test('Studio platform tabs preserve one selected platform identity', () => {
  for (const platform of ['x', 'xiaohongshu', 'wechat']) {
    const tab = studioPlatformTab(platform);
    assert.equal(studioPlatformFromTab(tab), platform);
  }
});

test('non-platform Studio tabs never select platform content', () => {
  for (const tab of ['core', 'versions', 'sources', 'assets', 'platform:unknown']) {
    assert.equal(studioPlatformFromTab(tab), null);
  }
});

test('Studio platform editor selects the requested version and falls back to latest', () => {
  const latest = { id: 'pv-latest', title: '最新', body: 'latest', assets: ['asset-a'] };
  const older = { id: 'pv-older', title: '旧版', body: 'older', assets: [] };
  const versions = [latest, older];
  assert.equal(selectStudioPlatformVersion(versions, older.id), older);
  assert.equal(selectStudioPlatformVersion(versions, 'stale-id'), latest);
  assert.equal(selectStudioPlatformVersion([], 'missing'), null);
});

test('Studio platform drafts preserve their baseline and detect human edits', () => {
  const version = { id: 'pv-1', title: '原标题', body: '原正文', assets: ['asset-a'] };
  const draft = createStudioPlatformDraft(version);
  assert.equal(studioPlatformDraftKey('xiaohongshu', version), 'pv-1');
  assert.equal(studioPlatformDraftKey('wechat', null), 'new:wechat');
  assert.equal(isStudioPlatformDraftDirty(draft), false);
  assert.equal(isStudioPlatformDraftDirty({ ...draft, body: '人工修改' }), true);
  assert.equal(isStudioPlatformDraftDirty({ ...draft, assetIds: [...draft.assetIds, 'asset-b'] }), true);
  assert.deepEqual(draft.baseAssetIds, ['asset-a']);
});
