import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Discover shows content while Settings owns channel configuration', async () => {
  const discover = await readFile(new URL('../src/renderer/discover-view.tsx', import.meta.url), 'utf8');
  const settings = await readFile(new URL('../src/renderer/settings-view.tsx', import.meta.url), 'utf8');
  const prd = await readFile(new URL('../PRD.md', import.meta.url), 'utf8');
  const spec = await readFile(new URL('../SPEC.md', import.meta.url), 'utf8');
  assert.doesNotMatch(discover, /IntelligenceChannelsView|情报渠道|List 管理/);
  assert.match(discover, /rankingsEnabled && <nav[\s\S]*?AI 榜单[\s\S]*?X Lists/);
  assert.match(discover, /!rankingsEnabled && section === 'rankings' \? 'lists'/);
  assert.match(settings, /section === 'channels'[\s\S]*?<IntelligenceChannelsView settingsMode/);
  assert.match(prd, /Discover 只展示榜单、所选 List 动态/);
  assert.match(spec, /Discover is a content-discovery surface/);
});
