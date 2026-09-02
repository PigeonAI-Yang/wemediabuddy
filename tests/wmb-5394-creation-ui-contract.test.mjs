import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('WMB-5394 Proposals owns the single production authorization and Today deep-links the exact item', async () => {
  const [today, proposals, main] = await Promise.all([
    read('src/renderer/today-view.tsx'),
    read('src/renderer/proposals-view.tsx'),
    read('src/renderer/main.tsx')
  ]);
  assert.match(proposals, />批准并开始创作</);
  assert.doesNotMatch(proposals, /批准并推进/);
  assert.match(today, /openProposals\?\.\(item\.id\)/);
  assert.doesNotMatch(today.match(/const create = \(item: TodayPlanItem\)[\s\S]*?\n  \};/)?.[0] ?? '', /approvePlanItem|openStudio/);
  assert.match(main, /setProposalFocusId\(planItemId \?\? null\)/);
  assert.match(proposals, /getProposalDetail\(focusPlanItemId\)/);
  assert.match(proposals, /setDetailId\(focusPlanItemId\)/);
});

test('WMB-5394 Studio defaults to writing and exposes production evidence as progressive detail', async () => {
  const [view, panels, investigation, styles] = await Promise.all([
    read('src/renderer/studio-view.tsx'),
    read('src/renderer/studio-view-panels.tsx'),
    read('src/renderer/studio-investigation-panel.tsx'),
    read('src/renderer/styles-studio.css')
  ]);
  assert.match(view, /useState<StudioTab>\('core'\)/);
  assert.match(panels, />依据与进度</);
  assert.match(investigation, /investigation-evidence-details/);
  assert.match(investigation, /查看完整依据与调查记录/);
  assert.match(investigation, /case 'research_review':\s*return null/);
  assert.match(investigation, /case 'ready_to_write':\s*return null/);
  assert.doesNotMatch(investigation.match(/case 'ready_to_write':[\s\S]*?case 'failed'/)?.[0] ?? '', /start-writer|开始写作/);
  assert.match(styles, /\.investigation-evidence-details/);
  assert.doesNotMatch(styles.match(/\.investigation-evidence-details[\s\S]*?\.investigation-section/)?.[0] ?? '', /#[0-9a-f]{3,8}|rgb\(|hsl\(/i);
});
