import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { draftPrompt } from '../src/main/agent-runner.ts';
import { evaluateCreationExperimentCohorts } from '../src/main/creation-experiment-observation.ts';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('WMB-5403 keeps approval as the only standard-path production decision', async () => {
  const [proposals, preload, globalTypes, ipc, ledger] = await Promise.all([
    read('src/renderer/proposals-view.tsx'),
    read('src/preload/preload.ts'),
    read('src/renderer/global.d.ts'),
    read('src/main/ipc-today-studio-business.ts'),
    read('src/renderer/proposal-ledger.ts')
  ]);
  assert.equal((proposals.match(/批准并开始创作/g) ?? []).length, 1);
  assert.match(proposals, /planningStatus === 'approved' && item\.adoptedProjectId/);
  assert.match(proposals, /打开创作项目/);
  assert.doesNotMatch([proposals, preload, globalTypes, ipc, ledger].join('\n'), /advancePlanItem|plan-item:advance|plan_item\.advance/);
});

test('WMB-5403 keeps the semantic comparison isolated from ordinary creation', () => {
  const ordinary = draftPrompt({ id: 'ordinary' }, 'project-ordinary', 'request-ordinary', 'core_draft', 'brief', true, 'prohibited', false);
  assert.doesNotMatch(ordinary, /creationExperiment|wmb_report_agent_progress/);

  const observation = evaluateCreationExperimentCohorts({
    experiment: [{ selectionMargin: 12, durationMs: 1000, articleSaved: true }],
    baseline: [{ durationMs: 1200, articleSaved: true }]
  });
  assert.equal(observation.status, 'observe');
  assert.ok(observation.reasons.some((reason) => reason.includes('样本不足')));
});
