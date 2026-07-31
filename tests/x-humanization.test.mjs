import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBrowserLaunchArgs,
  resolveBrowserLaunchMode
} from '../src/main/browser.ts';
import {
  X_HUMANIZATION,
  chooseReadPlan,
  computeCooldownMs,
  nextActionDelayMs
} from '../src/main/platforms/x-humanization.ts';

const pyaireader = {
  id: 'edge:pyaireader-default',
  label: 'Edge · Pyaireader 独立登录态',
  executablePath: 'msedge.exe',
  userDataDir: 'C:/tmp/pyai',
  profileDirectory: 'Default',
  cdpUrl: 'http://127.0.0.1:9334'
};

const generic = {
  id: 'edge:Default',
  label: 'Edge',
  executablePath: 'msedge.exe',
  userDataDir: 'C:/tmp/edge',
  profileDirectory: 'Default'
};

test('Pyaireader defaults to quiet headed launch, not true headless', () => {
  assert.equal(resolveBrowserLaunchMode(pyaireader), 'quiet');
  assert.equal(resolveBrowserLaunchMode(generic), 'visible');
  assert.equal(resolveBrowserLaunchMode(pyaireader, { mode: 'visible' }), 'visible');
  assert.equal(resolveBrowserLaunchMode(pyaireader, { mode: 'headless' }), 'headless');
});

test('quiet launch args keep a real window and avoid headless flags', () => {
  const quiet = buildBrowserLaunchArgs(pyaireader, { mode: 'quiet', port: 9334 });
  assert.ok(quiet.includes('--start-minimized'));
  assert.ok(quiet.includes('--window-size=1440,900'));
  assert.ok(quiet.includes('--lang=zh-CN'));
  assert.equal(quiet.includes('--headless=new'), false);
  assert.equal(quiet.includes('--disable-gpu'), false);

  const headless = buildBrowserLaunchArgs(pyaireader, { mode: 'headless', port: 9334 });
  assert.ok(headless.includes('--headless=new'));
});

test('humanization budgets and delays stay conservative', () => {
  assert.ok(X_HUMANIZATION.minActionGapMs >= 10_000);
  assert.ok(X_HUMANIZATION.hourlyActionBudget <= 120);
  assert.ok(X_HUMANIZATION.dailyActionBudget <= 400);
  const delay = nextActionDelayMs(1_000, 0, { sensitiveHour: false });
  assert.ok(delay >= 0);
  assert.ok(delay <= X_HUMANIZATION.minActionGapMs + X_HUMANIZATION.actionJitterMs + 12_000);
  const plan = chooseReadPlan();
  assert.ok(plan.scrolls >= 1);
  assert.equal(plan.distances.length, plan.scrolls);
  assert.ok(computeCooldownMs(1) >= X_HUMANIZATION.baseCooldownMs);
  assert.ok(computeCooldownMs(3, true) > computeCooldownMs(3, false));
  assert.ok(computeCooldownMs(10) <= X_HUMANIZATION.maxCooldownMs);
});
