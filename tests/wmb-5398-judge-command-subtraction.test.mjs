import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Clean cutover: executable full roots remain; standalone Judge control surfaces do not.

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('WMB-5398 product surfaces expose no standalone judge command', async () => {
  const [index, ipc, preload, globalTypes, proposals, mcp, mcpBusiness, manager, runtime, stage0, scheduler] = await Promise.all([
    read('src/main/index.ts'),
    read('src/main/ipc-today-studio-business.ts'),
    read('src/preload/preload.ts'),
    read('src/renderer/global.d.ts'),
    read('src/renderer/proposals-view.tsx'),
    read('src/main/mcp.ts'),
    read('src/main/mcp-business-commands.ts'),
    read('src/main/manager-orchestration.ts'),
    read('src/main/workspace-orchestrator-runtime.ts'),
    read('src/main/workspace-orchestrator-stage0.ts'),
    read('src/main/daily-scan-scheduler.ts')
  ]);

  const productSources = [index, ipc, preload, globalTypes, proposals, mcp, mcpBusiness, manager, runtime, stage0, scheduler].join('\n');
  for (const removed of [
    "action: 'judge'",
    'plan-item:request-planning',
    'plan_item.request_planning',
    'wmb_continue_after_scan',
    'mcp.daily-continue-after-scan',
    'scheduler.rolling-auto-judge',
    'proposal.plan-item-request-planning'
  ]) {
    assert.equal(productSources.includes(removed), false, `${removed} must be removed from product surfaces`);
  }

  assert.match(index, /producerId: 'today\.agent-start-daily-intelligence'[\s\S]*?action: 'full'/);
  assert.match(mcp, /stage: z\.enum\(\['scan', 'full'\]\)/);
  assert.doesNotMatch(scheduler, /onNewSources|triggerJudge|judgeRunning|judgeQueued/);
  assert.doesNotMatch(proposals, />派策划<|>重新策划</);
});

test('WMB-5398 Planner keeps one submit command but no request capability', async () => {
  const [capabilities, grants, ledger] = await Promise.all([
    read('src/shared/agent-capabilities.ts'),
    read('src/main/task-grants.ts'),
    read('src/renderer/proposal-ledger.ts')
  ]);
  for (const source of [capabilities, grants, ledger]) assert.doesNotMatch(source, /plan_item\.request_planning/);
  assert.match(capabilities, /commands: Object\.freeze\(\['plan_item\.submit'\]/);
  assert.match(grants, /plan_item\.submit/);
});
