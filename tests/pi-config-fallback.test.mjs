import assert from 'node:assert/strict';
import test from 'node:test';
import { runPiPromptWithFallback, startPiRuntimeWithFallback } from '../src/main/pi-config-fallback.ts';
import { roleModelCandidateKey } from '../src/main/pi-config.ts';

function fakeRuntime(label, { failStart = false, failPrompt = false } = {}) {
  return {
    label,
    async start() {
      if (failStart) throw new Error('429 rate limit exceeded');
    },
    async stop() {},
    async promptUntilSettled() {
      if (failPrompt) throw new Error('503 service unavailable');
      return { text: `ok:${label}`, thinking: '', stopped: false };
    }
  };
}

const chain = [
  { id: 'one', name: '主接口', baseUrl: 'https://one.test/v1', model: 'model-one', api: 'openai-responses', apiKey: 'k1' },
  { id: 'two', name: '备用接口', baseUrl: 'https://two.test/v1', model: 'model-two', api: 'openai-completions', apiKey: 'k2' }
];

const snapshot = {
  revision: 7,
  roleId: 'reporter',
  profiles: chain.map(({ id, name, baseUrl, model, api }) => ({ profileId: id, profileName: name, baseUrl, model, api }))
};

function resolveChain(_roleId, _snapshot, _path, options = {}) {
  const skip = new Set(options.skipCandidateKeys ?? []);
  return chain.filter((item) => !skip.has(roleModelCandidateKey(item.id, item.model)));
}

test('startPiRuntimeWithFallback skips failing primary and lands on fallback profile', async () => {
  const events = [];
  const created = [];
  const result = await startPiRuntimeWithFallback({
    roleId: 'reporter',
    policySnapshot: snapshot,
    taskId: 'task-reporter',
    resolveChain,
    createRuntime: async (config) => {
      created.push(config.id);
      return fakeRuntime(config.id, { failStart: config.id === 'one' });
    },
    onEvent: (event) => events.push(event)
  });
  assert.deepEqual(created, ['one', 'two']);
  assert.equal(result.config.id, 'two');
  assert.equal(result.runtime.label, 'two');
  assert.equal(events.some((event) => event.type === 'fallback-try' && event.profileId === 'one'), true);
  assert.equal(events.every((event) => event.roleId === 'reporter' && event.policyRevision === 7 && event.taskId === 'task-reporter'), true);
  assert.equal(events.some((event) => event.type === 'fallback' && event.profileId === 'two'), true);
});

test('runPiPromptWithFallback retries prompt after provider failure', async () => {
  const events = [];
  const first = fakeRuntime('one', { failPrompt: true });
  const result = await runPiPromptWithFallback({
    roleId: 'reporter',
    policySnapshot: snapshot,
    resolveChain,
    initial: { runtime: first, config: chain[0] },
    createRuntime: async (config) => fakeRuntime(config.id),
    onEvent: (event) => events.push(event.type),
    run: async (runtime) => runtime.promptUntilSettled('hi')
  });
  assert.equal(result.config.id, 'two');
  assert.equal(result.result.text, 'ok:two');
  // first prompt fails => fallback-try; next runtime starts cleanly so no second 'fallback' event is required
  assert.equal(events[0], 'fallback-try');
  assert.equal(events.includes('fallback-try'), true);
});

test('fallback does not switch profiles for authentication failures', async () => {
  const created = [];
  await assert.rejects(
    startPiRuntimeWithFallback({
      roleId: 'reporter',
      policySnapshot: snapshot,
      resolveChain,
      createRuntime: async (config) => {
        created.push(config.id);
        return {
          ...fakeRuntime(config.id),
          async start() { throw Object.assign(new Error('401 unauthorized'), { code: 'AUTH_FAILED' }); }
        };
      }
    }),
    (error) => error?.code === 'ROLE_MODEL_AUTH_FAILED' && error?.details?.state === 'needs_user'
  );
  assert.deepEqual(created, ['one']);
});

test('prompt authentication failure becomes a stable needs_user error without fallback', async () => {
  const created = [];
  const initialRuntime = fakeRuntime('one');
  await assert.rejects(
    runPiPromptWithFallback({
      roleId: 'reporter',
      policySnapshot: snapshot,
      taskId: 'task-auth',
      initial: { runtime: initialRuntime, config: chain[0] },
      resolveChain,
      createRuntime: async (config) => {
        created.push(config.id);
        return fakeRuntime(config.id);
      },
      run: async () => { throw new Error('401 unauthorized'); }
    }),
    (error) => error?.code === 'ROLE_MODEL_AUTH_FAILED'
      && error?.details?.state === 'needs_user'
      && error?.details?.taskId === 'task-auth'
      && error?.details?.profileId === 'one'
  );
  assert.deepEqual(created, []);
});

test('exhausted role chain reports needs_user without crossing chains', async () => {
  const created = [];
  await assert.rejects(
    startPiRuntimeWithFallback({
      roleId: 'reporter',
      policySnapshot: snapshot,
      taskId: 'task-exhausted',
      resolveChain,
      createRuntime: async (config) => {
        created.push(config.id);
        return fakeRuntime(config.id, { failStart: true });
      }
    }),
    (error) => error?.code === 'ROLE_MODEL_CHAIN_EXHAUSTED'
      && error?.details?.state === 'needs_user'
      && error?.details?.roleId === 'reporter'
      && error?.details?.policyRevision === 7
      && error?.details?.failures?.length === 2
  );
  assert.deepEqual(created, ['one', 'two']);
});
test('fallback retries a second model on the same profile', async () => {
  const pairChain = [
    { ...chain[0], model: 'model-one' },
    { ...chain[0], model: 'model-one-alt' },
    chain[1]
  ];
  const pairSnapshot = { ...snapshot, profiles: pairChain.map(({ id, name, baseUrl, model, api }) => ({ profileId: id, profileName: name, baseUrl, model, api })) };
  const created = [];
  const result = await startPiRuntimeWithFallback({
    roleId: 'reporter',
    policySnapshot: pairSnapshot,
    resolveChain: (_roleId, _snapshot, _path, options = {}) => {
      const skip = new Set(options.skipCandidateKeys ?? []);
      return pairChain.filter((item) => !skip.has(roleModelCandidateKey(item.id, item.model)));
    },
    createRuntime: async (config) => {
      created.push(`${config.id}:${config.model}`);
      return fakeRuntime(config.model, { failStart: config.model === 'model-one' });
    }
  });
  assert.deepEqual(created, ['one:model-one', 'one:model-one-alt']);
  assert.equal(result.config.id, 'one');
  assert.equal(result.config.model, 'model-one-alt');
});
