import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Settings owns the complete daily automation surface', async () => {
  const [settings, dailyCycle, today] = await Promise.all([
    read('src/renderer/settings-view.tsx'),
    read('src/renderer/today-daily-cycle.tsx'),
    read('src/renderer/today-view.tsx'),
  ]);

  assert.match(settings, /'daily-automation'/);
  assert.match(settings, /label: '每日自动化'/);
  assert.match(settings, /section === 'daily-automation'[\s\S]*?<TodayDailyCycle/);
  assert.match(settings, /target === 'browser' \|\| target === 'channels'/);
  assert.match(settings, /去浏览器与账号/);
  assert.match(settings, /去情报渠道/);

  assert.match(dailyCycle, /getDailyOrchestrationSchedule/);
  assert.match(dailyCycle, /setDailyOrchestrationSchedule/);
  assert.match(dailyCycle, /orchestrateDailyContent/);
  assert.match(dailyCycle, /最近结算/);

  assert.doesNotMatch(today, /<TodayDailyCycle/);
});
