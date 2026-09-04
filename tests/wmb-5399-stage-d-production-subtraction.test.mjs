import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('WMB-5399 daily content projections no longer submit Stage D production', async () => {
  const [cycle, article, taskCommands, orchestration, mcpBusiness, grants, capabilities, runtime, stage0] = await Promise.all([
    read('src/main/daily-content-cycle.ts'),
    read('src/main/daily-content-article.ts'),
    read('src/main/agent-task-commands.ts'),
    read('src/main/daily-orchestration.ts'),
    read('src/main/mcp-business-commands.ts'),
    read('src/main/task-grants.ts'),
    read('src/shared/agent-capabilities.ts'),
    read('src/main/workspace-orchestrator-runtime.ts'),
    read('src/main/workspace-orchestrator-stage0.ts')
  ]);
  for (const source of [cycle, article, taskCommands, mcpBusiness, grants, capabilities, runtime, stage0]) {
    assert.doesNotMatch(source, /content-cycle\.successor|content_cycle_next_action|advanceApprovedPlanItem|handleReporterSuccessAndAdvance|plan_item\.advance|proposal\.plan-item-advance/);
  }
  assert.doesNotMatch(orchestration, /command: 'plan_item\.advance'|advanceApprovedPlanItem/);
  assert.match(orchestration, /生产仅由方案批准与自动调查推进/);
});
test('WMB-5399 Executor rejects legacy Stage D instead of freezing empty success', async () => {
  const executor = await read('src/main/workspace-orchestrator-executor.ts');
  const branch = executor.match(/if \(String\(intent\.requested_action\) === 'stage_d'\)[\s\S]*?\n  }/)?.[0] ?? '';
  assert.match(branch, /UNSUPPORTED_ACTION/);
  assert.doesNotMatch(branch, /status: 'succeeded'|targets: \[\]|effects: \[\]|freezeStageDTargetEffect/);
});
