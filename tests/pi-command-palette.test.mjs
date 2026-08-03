import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { filterPiCommands, insertPiCommand } from '../src/renderer/pi-command-filter.ts';

test('Pi command palette filters and inserts native commands without sending', async () => {
  const commands = [
    { name: 'session-name', description: 'Rename this session', source: 'extension' },
    { name: 'skill:evidence-grounded-writer', description: 'Write verified content', source: 'skill' },
    { name: 'fix-tests', description: 'Repair the test suite', source: 'prompt' }
  ];
  assert.deepEqual(filterPiCommands(commands, '/skill').map((item) => item.name), ['skill:evidence-grounded-writer']);
  assert.deepEqual(filterPiCommands(commands, '/write').map((item) => item.name), ['skill:evidence-grounded-writer']);
  assert.equal(insertPiCommand(commands[1]), '/skill:evidence-grounded-writer ');

  const source = await readFile(new URL('../src/renderer/pi-composer.tsx', import.meta.url), 'utf8');
  for (const fragment of ['role="listbox"', 'role="option"', "event.key === 'ArrowDown'", "event.key === 'ArrowUp'", "event.key === 'Enter'", "event.key === 'Tab'", "event.key === 'Escape'"]) {
    assert.equal(source.includes(fragment), true, `missing ${fragment}`);
  }
  const choose = source.slice(source.indexOf('const chooseCommand'), source.indexOf('const sendCurrent'));
  assert.equal(choose.includes('onSend('), false);
});
