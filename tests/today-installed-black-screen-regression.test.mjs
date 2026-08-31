import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

test('TodayView must import FermentingRail and TodaySourceDetail — packaged black screen regression (2026-08-25)', () => {
  const src = fs.readFileSync('J:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx', 'utf8');
  // The packaged 0.3.0 regression removed the FermentingRail/TodaySourceDetail import,
  // causing ReferenceError: FermentingRail is not defined at runtime and a completely black 今日 window (root emptied by React error boundary).
  assert.match(
    src,
    /import\s*\{\s*FermentingRail\s*,\s*TodaySourceDetail\s*\}\s*from\s*['"]\.\/today-view-panels['"]/,
    'today-view.tsx must import { FermentingRail, TodaySourceDetail } from ./today-view-panels'
  );
  // Also ensure they are actually used in the render path (prevents dead import removal)
  assert.match(src, /<FermentingRail\b/, 'TodayView must render <FermentingRail');
  assert.match(src, /<TodaySourceDetail\b/, 'TodayView must render <TodaySourceDetail');
  // Ensure no duplicate missing import path: the buggy file still referenced FermentingRail without importing it — grep would show usage without import
  const hasImport = /from\s+['"]\.\/today-view-panels['"]/.test(src);
  const hasUsage = /FermentingRail/.test(src);
  assert.ok(hasImport && hasUsage, 'both import and usage must coexist; otherwise packaged build throws ReferenceError');
});

test('today-view-panels exports FermentingRail and TodaySourceDetail', () => {
  const panels = fs.readFileSync('J:/PigeonYang/WeMediaBuddy/src/renderer/today-view-panels.tsx', 'utf8');
  assert.match(panels, /export\s+function\s+FermentingRail\b/, 'panels must export FermentingRail');
  assert.match(panels, /export\s+function\s+TodaySourceDetail\b/, 'panels must export TodaySourceDetail');
});
