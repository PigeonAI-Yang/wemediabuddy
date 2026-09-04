import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('WMB-5400 Owner and scheduler share the executable full-intent entry', async () => {
  const [index, today, proposals, automation, scheduler, ipc, preload, mcp] = await Promise.all([
    read('src/main/index.ts'),
    read('src/renderer/today-view.tsx'),
    read('src/renderer/proposals-view.tsx'),
    read('src/renderer/today-daily-cycle.tsx'),
    read('src/main/daily-orchestration-scheduler.ts'),
    read('src/main/ipc-daily-content-cycle.ts'),
    read('src/preload/preload.ts'),
    read('src/main/mcp.ts')
  ]);
  assert.match(index, /producerId: 'today\.agent-start-daily-intelligence'[\s\S]*?action: 'full'/);
  assert.match(today + proposals + automation, /startDailyIntelligence/);
  assert.match(scheduler, /producerId: "scheduler\.daily-0900"[\s\S]*?action: "full"/);
  assert.doesNotMatch([automation, ipc, preload, mcp].join('\n'), /orchestrateDailyContent|daily-orchestration:orchestrate|daily-cycle:ensure|daily\.orchestrate/);
});

test('WMB-5400 production has no Judge or Stage D proposal successor surface', async () => {
  const sources = await Promise.all([
    read('src/main/daily-content-cycle.ts'),
    read('src/main/daily-content-article.ts'),
    read('src/main/mcp-business-commands.ts'),
    read('src/main/workspace-orchestrator-stage0.ts'),
    read('src/renderer/proposals-view.tsx'),
    read('src/renderer/proposal-ledger.ts')
  ]);
  const product = sources.join('\n');
  assert.doesNotMatch(product, /content-cycle\.successor|plan_item\.advance|proposal\.plan-item-advance|plan-item:advance|action: 'judge'/);
  assert.match(product, /批准并开始创作/);
  assert.match(product, /打开创作项目/);
});
