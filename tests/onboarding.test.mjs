import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AI_TEST_TIMEOUT_MS,
  DEFAULT_WORKSPACE_DIR_NAME,
  createOnboardingManager,
  createOnboardingState,
  deriveCurrentStep,
  findVisionCapableModel,
  normalizeOnboardingState,
  readOnboardingState,
  runAiConnectionTest,
  writeOnboardingState
} from '../src/main/onboarding.ts';

const FIXED_NOW = '2026-08-09T00:00:00.000Z';
const EMPTY_REGISTRY = { version: 1, activeWorkspaceId: null, workspaces: [], switchJournal: null };
const NO_PI = { activeId: null, configured: false };

/** In-memory collaborators wired like Main will wire them (registry + pi config shared by reference). */
function fakeHarness(overrides = {}) {
  const { userDataPath = 'user-data', documentsPath = 'documents', registry: registryOverride, piConfig: piConfigOverride, chooser, savePiConfig, fetchImpl } = overrides;
  const registry = registryOverride ?? structuredClone(EMPTY_REGISTRY);
  const piConfig = piConfigOverride ?? { ...NO_PI };
  const opened = [];
  const refreshed = [];
  const enrolled = [];
  const savedKeys = [];
  let nextWorkspaceId = 0;
  const collaborators = {
    userDataPath: () => userDataPath,
    documentsPath: () => documentsPath,
    readWorkspaceRegistry: async () => structuredClone(registry),
    readPiConfig: () => ({ ...piConfig }),
    openDataRoot: async (rootPath) => { opened.push(rootPath); return { path: rootPath, isNew: true }; },
    enroll: async ({ rootPath, displayName }) => {
      const workspace = { id: `ws-${++nextWorkspaceId}`, displayName, rootPath };
      registry.workspaces.push(workspace);
      registry.activeWorkspaceId = workspace.id;
      enrolled.push(workspace);
      return workspace;
    },
    refresh: async (dataRoot) => { refreshed.push(dataRoot.path); },
    chooseWorkspaceDirectory: chooser ?? (async () => null),
    savePiConfig: savePiConfig ?? ((input) => {
      savedKeys.push(input.apiKey);
      piConfig.activeId = 'profile-1';
      piConfig.configured = true;
      return { activeId: 'profile-1', profiles: [], fallbackOrder: [], baseUrl: input.baseUrl, model: input.model, configured: true };
    }),
    now: () => FIXED_NOW,
    ...(fetchImpl ? { fetchImpl } : {})
  };
  const manager = createOnboardingManager(collaborators);
  return { manager, registry, piConfig, opened, refreshed, enrolled, savedKeys, userDataPath };
}
function markAiReady(h) {
  return h.manager.saveAiConfig(
    { name: '测试接口', baseUrl: 'https://api.example.test/v1', api: 'openai-responses', apiKey: 'k', model: 'm' },
    { api: 'openai-responses', model: 'm', latencyMs: 8, message: 'pong', testedAt: FIXED_NOW, visionModelId: null }
  );
}

/** Fake fetch routing by URL suffix; records calls for request-shape assertions. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url, method, headers: init.headers, body: init.body, signal: init.signal });
    const route = routes.find((r) => r.method === method && url.endsWith(r.url));
    if (route?.error) throw route.error;
    if (!route) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { impl, calls };
}

function withTempDir(name, fn) {
  return async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), name));
    try {
      await fn(parent);
    } finally {
      await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  };
}

test('fresh install starts at welcome and persists a restart-safe state file', withTempDir('wmb-onboarding-fresh-', async (parent) => {
  const userDataPath = path.join(parent, 'userData');
  const h = fakeHarness({ userDataPath, documentsPath: path.join(parent, 'Documents') });
  const status = await h.manager.inspectStatus();
  assert.equal(status.currentStep, 'welcome');
  assert.equal(status.completed, false);
  assert.equal(status.prerequisites.workspaceReady, false);
  assert.equal(status.prerequisites.aiReady, false);
  const raw = JSON.parse(await readFile(path.join(userDataPath, 'onboarding.json'), 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.state.currentStep, 'welcome');
  assert.equal(raw.state.startedAt, FIXED_NOW);
  const restarted = fakeHarness({ userDataPath, documentsPath: path.join(parent, 'Documents') });
  assert.equal((await restarted.manager.inspectStatus()).currentStep, 'welcome');
}));

test('wizard resumes at the interrupted step after a restart', withTempDir('wmb-onboarding-resume-', async (parent) => {
  const userDataPath = path.join(parent, 'userData');
  const registry = { version: 1, activeWorkspaceId: 'w1', workspaces: [{ id: 'w1', displayName: '已有', rootPath: 'existing-root' }], switchJournal: null };
  const h = fakeHarness({ userDataPath, registry });
  h.manager.recordStep('ai');
  assert.equal((await h.manager.inspectStatus()).currentStep, 'ai');
  const restarted = fakeHarness({ userDataPath, registry });
  assert.equal((await restarted.manager.inspectStatus()).currentStep, 'ai');
  markAiReady(restarted);
  const again = fakeHarness({ userDataPath, registry, piConfig: restarted.piConfig });
  assert.equal((await again.manager.inspectStatus()).currentStep, 'platforms');
}));

test('resume step is corrected from real prerequisites, never a cosmetic counter', withTempDir('wmb-onboarding-correct-', async (parent) => {
  const userDataPath = path.join(parent, 'userData');
  const registry = { version: 1, activeWorkspaceId: 'w1', workspaces: [{ id: 'w1', displayName: '已有', rootPath: 'existing-root' }], switchJournal: null };
  const piConfig = { activeId: 'p1', configured: true };
  const satisfied = { workspaceReady: true, aiReady: true };
  const table = [
    [{ currentStep: 'welcome', completedAt: null }, { workspaceReady: false, aiReady: false }, 'welcome'],
    [{ currentStep: 'ai', completedAt: null }, { workspaceReady: false, aiReady: true }, 'workspace'],
    [{ currentStep: 'complete', completedAt: FIXED_NOW }, { workspaceReady: true, aiReady: false }, 'ai'],
    [{ currentStep: 'platforms', completedAt: null }, { workspaceReady: true, aiReady: false }, 'ai'],
    [{ currentStep: 'welcome', completedAt: null }, satisfied, 'ai'],
    [{ currentStep: 'workspace', completedAt: null }, satisfied, 'ai'],
    [{ currentStep: 'ai', completedAt: null }, satisfied, 'ai'],
    [{ currentStep: 'platforms', completedAt: null }, satisfied, 'platforms'],
    [{ currentStep: 'complete', completedAt: FIXED_NOW }, satisfied, 'complete'],
    [{ currentStep: 'complete', completedAt: null }, satisfied, 'platforms']
  ];
  for (const [state, prereqs, expected] of table) {
    assert.equal(deriveCurrentStep(state, prereqs), expected, JSON.stringify({ state, prereqs }));
  }
  const h = fakeHarness({ userDataPath, registry, piConfig });
  writeOnboardingState(path.join(userDataPath, 'onboarding.json'), { ...createOnboardingState(FIXED_NOW), currentStep: 'complete' });
  markAiReady(h);
  assert.equal((await h.manager.inspectStatus()).currentStep, 'platforms', 'complete without completedAt must not stick');
  const done = await h.manager.completeOnboarding();
  assert.equal(done.completed, true);
  piConfig.activeId = null;
  piConfig.configured = false;
  assert.equal((await h.manager.inspectStatus()).currentStep, 'ai', 'completed wizard regresses when Pi is removed');
  registry.activeWorkspaceId = null;
  assert.equal((await h.manager.inspectStatus()).currentStep, 'workspace', 'completed wizard regresses when workspace is removed');
}));

test('default workspace is created under the Documents-based path through openDataRoot/enroll/refresh', withTempDir('wmb-onboarding-default-', async (parent) => {
  const userDataPath = path.join(parent, 'userData');
  const documentsPath = path.join(parent, 'Documents');
  const h = fakeHarness({ userDataPath, documentsPath });
  const { workspace, state } = await h.manager.createDefaultWorkspace();
  const expectedRoot = path.join(documentsPath, DEFAULT_WORKSPACE_DIR_NAME);
  assert.equal(workspace.rootPath, expectedRoot);
  assert.deepEqual(h.opened, [expectedRoot]);
  assert.deepEqual(h.refreshed, [expectedRoot]);
  assert.equal(h.enrolled.length, 1);
  assert.equal(h.enrolled[0].displayName, '我的工作空间');
  assert.equal(state.workspace.workspaceId, workspace.id);
  assert.equal(state.workspace.rootPath, expectedRoot);
  assert.equal(state.workspace.createdAt, FIXED_NOW);
  assert.equal(h.registry.activeWorkspaceId, workspace.id);
  const status = await h.manager.inspectStatus();
  assert.equal(status.currentStep, 'ai');
  assert.equal(status.prerequisites.workspaceReady, true);
  assert.equal(status.workspace.rootPath, expectedRoot);
}));

test('custom workspace uses the injected chooser and cancels cleanly', withTempDir('wmb-onboarding-custom-', async (parent) => {
  const userDataPath = path.join(parent, 'userData');
  const customRoot = path.join(parent, 'CustomWorkspace');
  const h = fakeHarness({ userDataPath, chooser: async () => customRoot });
  const { workspace } = await h.manager.chooseCustomWorkspace();
  assert.equal(workspace.rootPath, customRoot);
  assert.equal((await h.manager.inspectStatus()).workspace.rootPath, customRoot);
  const cancelled = fakeHarness({ userDataPath: path.join(parent, 'cancelledUserData'), chooser: async () => null });
  assert.equal(await cancelled.manager.chooseCustomWorkspace(), null);
  assert.equal((await cancelled.manager.inspectStatus()).workspace, null);
}));

test('AI test issues a minimal Responses request and reports latency/model/message', async () => {
  const fetch = fakeFetch([
    { method: 'GET', url: '/models', body: { data: [{ id: 'deepseek-v4-flash' }, { id: 'mimo-v2.5', input: ['text', 'image'] }] } },
    { method: 'POST', url: '/responses', body: { output: [{ content: [{ type: 'output_text', text: 'pong' }] }] } }
  ]);
  const result = await runAiConnectionTest({ baseUrl: 'https://api.example.test/v1', api: 'openai-responses', apiKey: 'key-1', model: 'deepseek-v4-flash', fetchImpl: fetch.impl, now: () => FIXED_NOW });
  assert.equal(result.ok, true);
  assert.equal(result.message, 'pong');
  assert.equal(result.model, 'deepseek-v4-flash');
  assert.equal(result.visionModelId, 'mimo-v2.5');
  assert.equal(typeof result.latencyMs, 'number');
  assert.ok(result.latencyMs >= 0);
  assert.equal(fetch.calls.length, 2);
  assert.equal(fetch.calls[0].url, 'https://api.example.test/v1/models');
  assert.equal(fetch.calls[0].headers.authorization, 'Bearer key-1');
  assert.ok(fetch.calls[0].signal instanceof AbortSignal);
  assert.equal(fetch.calls[1].method, 'POST');
  assert.equal(fetch.calls[1].url, 'https://api.example.test/v1/responses');
  assert.deepEqual(JSON.parse(fetch.calls[1].body), { model: 'deepseek-v4-flash', input: 'ping' });
});

test('AI test issues a minimal Chat Completions request', async () => {
  const fetch = fakeFetch([
    { method: 'GET', url: '/models', body: { data: [{ id: 'm' }] } },
    { method: 'POST', url: '/chat/completions', body: { choices: [{ message: { content: 'ok' } }] } }
  ]);
  const result = await runAiConnectionTest({ baseUrl: 'http://localhost:8000/v1', api: 'openai-completions', apiKey: 'k', model: 'm', fetchImpl: fetch.impl, now: () => FIXED_NOW });
  assert.equal(result.message, 'ok');
  assert.equal(result.visionModelId, null);
  assert.deepEqual(JSON.parse(fetch.calls[1].body), { model: 'm', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(fetch.calls[1].headers['content-type'], 'application/json');
});

test('AI test surfaces model-not-found, auth, timeout, network, and invalid-input errors', async () => {
  const timeoutError = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
  const cases = [
    {
      label: 'model not in list',
      routes: [{ method: 'GET', url: '/models', body: { data: [{ id: 'other' }] } }],
      expected: 'MODEL_NOT_FOUND'
    },
    {
      label: 'models auth failure',
      routes: [{ method: 'GET', url: '/models', status: 401 }],
      expected: 'AUTH_FAILED'
    },
    {
      label: 'text request auth failure',
      routes: [
        { method: 'GET', url: '/models', body: { data: [{ id: 'm' }] } },
        { method: 'POST', url: '/responses', status: 403 }
      ],
      expected: 'AUTH_FAILED'
    },
    {
      label: 'timeout on models',
      routes: [{ method: 'GET', url: '/models', error: timeoutError }],
      expected: 'TIMEOUT'
    },
    {
      label: 'network failure',
      routes: [{ method: 'GET', url: '/models', error: new TypeError('fetch failed') }],
      expected: 'NETWORK_ERROR'
    },
    {
      label: 'text request rejects',
      routes: [
        { method: 'GET', url: '/models', body: { data: [{ id: 'm' }] } },
        { method: 'POST', url: '/responses', error: Object.assign(new Error('down'), { name: 'TimeoutError' }) }
      ],
      expected: 'TIMEOUT'
    },
    {
      label: 'empty text reply',
      routes: [
        { method: 'GET', url: '/models', body: { data: [{ id: 'm' }] } },
        { method: 'POST', url: '/responses', body: { output: [] } }
      ],
      expected: 'TEXT_REQUEST_FAILED'
    }
  ];
  for (const { label, routes, expected } of cases) {
    const fetch = fakeFetch(routes);
    await assert.rejects(
      runAiConnectionTest({ baseUrl: 'https://api.example.test/v1', api: 'openai-responses', apiKey: 'k', model: 'm', fetchImpl: fetch.impl }),
      (error) => error.code === expected,
      label
    );
  }
  await assert.rejects(runAiConnectionTest({ baseUrl: 'ftp://invalid', api: 'openai-responses', apiKey: 'k', model: 'm', fetchImpl: fetchImplNoop }), (e) => e.code === 'INVALID_URL');
  await assert.rejects(runAiConnectionTest({ baseUrl: 'https://api.example.test/v1', api: 'openai-responses', apiKey: 'k', model: '  ', fetchImpl: fetchImplNoop }), (e) => e.code === 'INVALID_MODEL');
  await assert.rejects(runAiConnectionTest({ baseUrl: 'https://api.example.test/v1', api: 'openai-responses', apiKey: ' ', model: 'm', fetchImpl: fetchImplNoop }), (e) => e.code === 'AUTH_FAILED');
  await assert.rejects(runAiConnectionTest({ baseUrl: 'https://api.example.test/v1', api: 'bogus-api', apiKey: 'k', model: 'm', fetchImpl: fetchImplNoop }), (e) => e.code === 'INVALID_API');
});

const fetchImplNoop = async () => { throw new Error('must not fetch'); };

test('AI test applies a 15s timeout signal to every request', async () => {
  const fetch = fakeFetch([
    { method: 'GET', url: '/models', body: { data: [{ id: 'm' }] } },
    { method: 'POST', url: '/chat/completions', body: { choices: [{ message: { content: 'ok' } }] } }
  ]);
  await runAiConnectionTest({ baseUrl: 'http://localhost/v1', api: 'openai-completions', apiKey: 'k', model: 'm', fetchImpl: fetch.impl });
  for (const call of fetch.calls) {
    assert.ok(call.signal instanceof AbortSignal);
    assert.equal(typeof call.signal.aborted, 'boolean');
  }
  assert.equal(AI_TEST_TIMEOUT_MS, 15_000);
});

test('vision-capable model is reported from metadata without blocking completion', async () => {
  assert.equal(findVisionCapableModel({ data: [{ id: 'text-only' }] }), null);
  assert.equal(findVisionCapableModel({ data: [{ id: 'text-only', input: ['text'] }] }), null);
  assert.equal(findVisionCapableModel({ data: [{ id: 'mimo-v2.5' }, { id: 'text-only' }] }), 'mimo-v2.5');
  assert.equal(findVisionCapableModel({ data: [{ id: 'vision-a', input: ['text', 'image'] }] }), 'vision-a');
  assert.equal(findVisionCapableModel({ data: [{ id: 'vision-b', modalities: ['image', 'text'] }] }), 'vision-b');
  const fetch = fakeFetch([
    { method: 'GET', url: '/models', body: { data: [{ id: 'm' }] } },
    { method: 'POST', url: '/responses', body: { output_text: 'hello' } }
  ]);
  const result = await runAiConnectionTest({ baseUrl: 'http://localhost/v1', api: 'openai-responses', apiKey: 'k', model: 'm', fetchImpl: fetch.impl });
  assert.equal(result.ok, true);
  assert.equal(result.visionModelId, null);
});

test('saving AI delegates to the secure savePiConfig and never stores the key in onboarding.json', withTempDir('wmb-onboarding-secret-', async (parent) => {
  const userDataPath = path.join(parent, 'userData');
  const registry = { version: 1, activeWorkspaceId: 'w1', workspaces: [{ id: 'w1', displayName: '已有', rootPath: 'existing-root' }], switchJournal: null };
  const h = fakeHarness({ userDataPath, registry });
  const result = { api: 'openai-responses', model: 'deepseek-v4-flash', latencyMs: 42, message: 'pong', testedAt: '2026-08-09T00:00:01.000Z', visionModelId: null };
  const saved = h.manager.saveAiConfig({ name: '我的接口', baseUrl: 'https://api.example.test/v1/', api: 'openai-responses', apiKey: 'SUPER-SECRET-KEY', model: 'deepseek-v4-flash' }, result);
  assert.equal(saved.ai.profileId, 'profile-1');
  assert.equal(saved.ai.lastTest.latencyMs, 42);
  assert.deepEqual(h.savedKeys, ['SUPER-SECRET-KEY']);
  const raw = await readFile(path.join(userDataPath, 'onboarding.json'), 'utf8');
  assert.ok(!raw.includes('SUPER-SECRET-KEY'), 'api key must not appear in onboarding.json');
  const state = JSON.parse(raw).state;
  assert.equal(state.ai.lastTest.message, 'pong');
  assert.equal(state.ai.lastTest.api, 'openai-responses');
  assert.equal((await h.manager.inspectStatus()).currentStep, 'platforms');
}));

test('platform checks can be skipped, recorded, cleared, and still complete', withTempDir('wmb-onboarding-platforms-', async (parent) => {
  const userDataPath = path.join(parent, 'userData');
  const registry = { version: 1, activeWorkspaceId: 'w1', workspaces: [{ id: 'w1', displayName: '已有', rootPath: 'existing-root' }], switchJournal: null };
  const piConfig = { activeId: 'p1', configured: true };
  const h = fakeHarness({ userDataPath, registry, piConfig });
  markAiReady(h);
  assert.equal(h.manager.skipPlatform('x').x.status, 'skipped');
  assert.equal(h.manager.recordPlatformStatus('xiaohongshu', 'completed').xiaohongshu.status, 'completed');
  assert.equal(h.manager.recordPlatformStatus('wechat', 'skipped').wechat.status, 'skipped');
  assert.ok(!('x' in h.manager.clearPlatform('x')));
  const status = await h.manager.inspectStatus();
  assert.deepEqual(Object.keys(status.platforms).sort(), ['wechat', 'xiaohongshu']);
  assert.equal(status.platforms.wechat.updatedAt, FIXED_NOW);
  assert.throws(() => h.manager.recordPlatformStatus('', 'skipped'), (e) => e.code === 'INVALID_STATE');
  assert.throws(() => h.manager.recordStep('complete'), (e) => e.code === 'INVALID_STATE');
  const done = await h.manager.completeOnboarding();
  assert.equal(done.completed, true);
  assert.equal(done.currentStep, 'complete');
  assert.equal(done.completedAt, FIXED_NOW);
  const restarted = fakeHarness({ userDataPath, registry, piConfig });
  assert.equal((await restarted.manager.inspectStatus()).completed, true);
}));

test('completion is gated on workspace and active configured Pi profile', withTempDir('wmb-onboarding-gate-', async (parent) => {
  const userDataPath = path.join(parent, 'userData');
  const h = fakeHarness({ userDataPath });
  await assert.rejects(h.manager.completeOnboarding(), (e) => e.code === 'WORKSPACE_REQUIRED');
  const registry = { version: 1, activeWorkspaceId: 'w1', workspaces: [{ id: 'w1', displayName: '已有', rootPath: 'existing-root' }], switchJournal: null };
  const withoutPi = fakeHarness({ userDataPath, registry });
  await assert.rejects(withoutPi.manager.completeOnboarding(), (e) => e.code === 'AI_REQUIRED');
  const piConfig = { activeId: null, configured: true };
  const noActiveProfile = fakeHarness({ userDataPath, registry, piConfig });
  await assert.rejects(noActiveProfile.manager.completeOnboarding(), (e) => e.code === 'AI_REQUIRED');
  const ready = fakeHarness({ userDataPath, registry, piConfig: { activeId: 'p1', configured: true } });
  markAiReady(ready);
  const done = await ready.manager.completeOnboarding();
  assert.equal(done.completed, true);
  const restarted = fakeHarness({ userDataPath, registry, piConfig: { activeId: 'p1', configured: true } });
  assert.equal((await restarted.manager.inspectStatus()).currentStep, 'complete');
}));

test('state normalization tolerates corrupt or partial files and writes atomically', withTempDir('wmb-onboarding-normalize-', async (parent) => {
  const statePath = path.join(parent, 'onboarding.json');
  assert.equal(readOnboardingState(statePath, FIXED_NOW), null, 'missing file reads as no state');
  const fresh = normalizeOnboardingState('garbage', FIXED_NOW);
  assert.equal(fresh.currentStep, 'welcome');
  assert.equal(fresh.startedAt, FIXED_NOW);
  const envelope = normalizeOnboardingState({ version: 1, state: { currentStep: 'complete', completedAt: null } }, FIXED_NOW);
  assert.equal(envelope.currentStep, 'platforms', 'complete without completedAt degrades to platforms');
  const unsupported = normalizeOnboardingState({ version: 2, state: { currentStep: 'ai' } }, FIXED_NOW);
  assert.equal(unsupported.currentStep, 'welcome', 'unsupported version degrades to a fresh default');
  const partial = normalizeOnboardingState({ currentStep: 'ai', platforms: { x: { status: 'skipped', updatedAt: FIXED_NOW }, bad: { status: 'running' } } }, FIXED_NOW);
  assert.equal(partial.currentStep, 'ai');
  assert.deepEqual(partial.platforms, { x: { status: 'skipped', updatedAt: FIXED_NOW } });
  assert.equal(partial.ai, null);
  writeOnboardingState(statePath, createOnboardingState(FIXED_NOW));
  assert.deepEqual(await readdir(parent), ['onboarding.json'], 'atomic write leaves no temporary files');
  assert.equal(readOnboardingState(statePath, FIXED_NOW).currentStep, 'welcome');
  writeOnboardingState(statePath, { ...createOnboardingState(FIXED_NOW), currentStep: 'workspace' });
  const back = readOnboardingState(statePath, FIXED_NOW);
  assert.equal(back.currentStep, 'workspace');
  assert.equal(back.workspace, null);
}));
