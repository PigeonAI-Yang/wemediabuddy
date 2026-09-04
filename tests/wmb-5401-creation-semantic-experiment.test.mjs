import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { getAgentTask, reportAgentTaskProgress, startAgentTask } from '../src/main/agent-tasks.ts';
import {
  normalizeCreationExperiment,
  normalizeCreationExperimentCheckpoint,
  requireCreationExperimentBeforeCoreSave
} from '../src/main/mcp-business-commands.ts';
import { claimCreationExperiment, draftPrompt, shouldRunCreationExperiment } from '../src/main/agent-runner.ts';

const projectId = 'project-semantic-experiment';
const experiment = {
  version: 'v1',
  projectId,
  variants: [
    { id: 'A', semanticDirection: '解释事件本身发生了什么以及直接影响', evidenceFit: 80, insightNovelty: 60, audienceValue: 70 },
    { id: 'B', semanticDirection: '解释变化如何重写读者的实际决策顺序', evidenceFit: 90, insightNovelty: 80, audienceValue: 85 }
  ],
  selectedVariantId: 'B'
};

function withDatabase(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmb-5401-'));
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  try { return run(database); }
  finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

test('WMB-5401 computes a quantitative winner and rejects a lower-scoring selection', () => {
  const normalized = normalizeCreationExperiment(experiment);
  assert.equal(normalized.variants.find((variant) => variant.id === 'B')?.weightedScore, 85.8);
  assert.equal(normalized.variants.find((variant) => variant.id === 'A')?.weightedScore, 71.5);
  assert.match(normalized.quantitativeConclusion, /领先次优 14\.3 分/);
  assert.throws(
    () => normalizeCreationExperiment({ ...experiment, selectedVariantId: 'A' }),
    (error) => error?.code === 'CREATION_EXPERIMENT_INVALID' && String(error.message).includes('selected_variant_not_highest')
  );
});

test('WMB-5401 atomically assigns the semantic experiment to one core draft only', () => withDatabase((database) => {
  const first = startAgentTask(database, {
    intent: 'studio_draft', businessDate: '2026-09-04',
    contextRefs: { roleId: 'writer', writerTask: 'core_draft', projectId: 'project-first', creationExperiment: false }
  });
  const second = startAgentTask(database, {
    intent: 'studio_draft', businessDate: '2026-09-05',
    contextRefs: { roleId: 'writer', writerTask: 'core_draft', projectId: 'project-second', creationExperiment: false }
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(claimCreationExperiment(database, first.data.id), true);
  assert.equal(claimCreationExperiment(database, second.data.id), false);
  assert.equal(getAgentTask(database, first.data.id)?.contextRefs.creationExperiment, true);
  assert.equal(getAgentTask(database, second.data.id)?.contextRefs.creationExperiment, false);
  assert.equal(shouldRunCreationExperiment(database), false);
}));

test('WMB-5401 persists the experiment checkpoint before the core-save gate opens', () => withDatabase((database) => {
  assert.equal(shouldRunCreationExperiment(database), true);
  const started = startAgentTask(database, {
    intent: 'studio_draft',
    businessDate: '2026-09-04',
    contextRefs: { roleId: 'writer', writerTask: 'core_draft', projectId, creationExperiment: true }
  });
  assert.equal(shouldRunCreationExperiment(database), false);
  assert.equal(started.ok, true);
  const taskId = started.data.id;
  assert.throws(
    () => requireCreationExperimentBeforeCoreSave(database, taskId, projectId),
    (error) => error?.code === 'CREATION_EXPERIMENT_REQUIRED'
  );

  const checkpoint = normalizeCreationExperimentCheckpoint(database, taskId, { creationExperiment: experiment });
  const reported = reportAgentTaskProgress(database, taskId, { phase: 'experiment_complete', checkpoint });
  assert.equal(reported.ok, true);
  const persisted = getAgentTask(database, taskId)?.checkpoint.creationExperiment;
  assert.equal(persisted.selectedVariantId, 'B');
  assert.match(persisted.quantitativeConclusion, /加权分 85\.8/);
  assert.doesNotThrow(() => requireCreationExperimentBeforeCoreSave(database, taskId, projectId));
}));

test('WMB-5401 writer prompt orders experiment persistence before article persistence', () => {
  const prompt = draftPrompt({ id: 'task-5401' }, projectId, 'request-5401', 'core_draft', 'brief', true, 'prohibited', true);
  const experimentIndex = prompt.indexOf('wmb_report_agent_progress');
  const saveIndex = prompt.indexOf('wmb_save_core_version');
  assert.ok(experimentIndex >= 0 && saveIndex > experimentIndex);
  assert.match(prompt, /证据贴合 45%、洞察新意 30%、读者价值 25%/);
});
