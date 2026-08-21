import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('Settings exposes one installation-level Pi Skills manager with protected states and CRUD', async () => {
  const [settings, component, preload] = await Promise.all([
    readFile('src/renderer/settings-view.tsx', 'utf8'),
    readFile('src/renderer/pi-skills-settings.tsx', 'utf8'),
    readFile('src/preload/preload.ts', 'utf8')
  ]);
  assert.match(settings, /id: 'skills', label: 'Pi Skills'/);
  assert.match(settings, /section === 'skills' && <PiSkillsSettings/);
  assert.match(component, /只读/);
  assert.match(component, /可编辑/);
  assert.match(component, /新建/);
  assert.match(component, /window\.wmb\.savePiSkill/);
  assert.match(component, /window\.wmb\.deletePiSkill/);
  assert.match(preload, /pi-skills:list/);
  assert.match(preload, /pi-skills:save/);
  assert.match(preload, /pi-skills:delete/);
});
