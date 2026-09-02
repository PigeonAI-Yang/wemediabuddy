import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('WMB-5393 normal review freezes direction and continues writer without Owner middle approval', async () => {
  const [domain, ipc, automation] = await Promise.all([
    read('src/main/project-investigation.ts'),
    read('src/main/ipc-project-investigation.ts'),
    read('src/main/project-investigation-automation.ts')
  ]);
  assert.match(domain, /status: 'ready_to_write', direction_version: nextVersion/);
  assert.match(domain, /VALUES \(\?, \?, \?, \?, 'approved', \?, \?\)/);
  assert.doesNotMatch(domain.match(/if \(input\.decision === 'accept'\)[\s\S]*?return success/)?.[0] ?? '', /direction_pending_approval/);
  assert.match(ipc, /input\.decision === 'accept'[\s\S]*?continueAutomaticInvestigation/);
  assert.match(ipc, /decidedBy: 'owner'/);
  assert.match(automation, /status='ready_to_write'/);
});

test('WMB-5393 exception state exposes four explicit fail-closed recovery choices', async () => {
  const [panel, prompt] = await Promise.all([
    read('src/renderer/studio-investigation-panel.tsx'),
    read('src/main/project-investigation.ts')
  ]);
  for (const label of ['按当前证据收窄写作', '补查关键事实', '调整核心方向', '停止项目']) {
    assert.match(panel, new RegExp(label));
  }
  assert.match(panel, /外部权限或费用边界/);
  assert.match(panel, /系统已停止自动推进/);
  assert.match(prompt, /核心主张发生实质变化/);
  assert.match(prompt, /needs_user/);
  assert.match(prompt, /不得伪造方向/);
});
