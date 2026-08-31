import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const todayViewUrl = new URL('../src/renderer/today-view-parts.tsx', import.meta.url);
const xListsViewUrl = new URL('../src/renderer/x-lists-view.tsx', import.meta.url);

test('WMB-5346 Today X cards prefer a trusted handle before heartbeat labels', async () => {
  const source = await readFile(todayViewUrl, 'utf8');
  const xBranch = source.indexOf("const isX = host === 'x.com' || host === 'twitter.com'");
  const heartbeatBranch = source.indexOf('if (isHeartbeatSource(source as TodaySource))');

  assert.ok(xBranch >= 0, 'X source branch exists');
  assert.ok(heartbeatBranch > xBranch, 'X identity is resolved before heartbeat labels');
  assert.match(source, /if \(isX\) \{[\s\S]*normalizeXHandle\(author\)[\s\S]*if \(handle\) return handle;[\s\S]*return '账号暂不可见';[\s\S]*\}/);
  assert.doesNotMatch(source.slice(xBranch, heartbeatBranch), /return '巡检打卡'/);
});

test('WMB-5346 X list cards reject task labels and use an explicit unavailable identity', async () => {
  const source = await readFile(xListsViewUrl, 'utf8');

  assert.match(source, /function trustedXHandle[\s\S]*v\.includes\('巡检'\)[\s\S]*v\.includes\('打卡'\)[\s\S]*\^@\[A-Za-z0-9_\]\{1,15\}\$/);
  assert.match(source, /function handleLabelOf[\s\S]*trustedXHandle[\s\S]*账号暂不可见/);
  assert.match(source, /authorHandle: trustedXHandle\(item\.author \?\? null\)/);
  assert.match(source, /authorHandle: trustedXHandle\(post\.authorHandle \?\? null\)/);
  assert.doesNotMatch(source, /authorHandle\s*\?\?\s*['"]巡检打卡['"]/);
});

test('WMB-5346 existing Timeline and Quote cards consume the sanitized labels', async () => {
  const source = await readFile(xListsViewUrl, 'utf8');

  assert.match(source, /function QuoteCard[\s\S]*const handle = handleLabelOf\(post\);[\s\S]*const display = displayNameOf\(post\);/);
  assert.match(source, /function TimelineCard[\s\S]*const handle = handleLabelOf\(post\);[\s\S]*const display = displayNameOf\(post\);/);
  assert.match(source, /<strong>\{display\}<\/strong>\s*<span>\{handle\}<\/span>/);
});
