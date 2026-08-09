import assert from 'node:assert/strict';
import test from 'node:test';
import { runPiPromptWithFallback, startPiRuntimeWithFallback } from '../src/main/pi-config-fallback.ts';

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

function resolveChain(_path, options = {}) {
  const skip = new Set(options.skipProfileIds ?? []);
  return chain.filter((item) => !skip.has(item.id));
}

test('startPiRuntimeWithFallback skips failing primary and lands on fallback profile', async () => {
  const events = [];
  const created = [];
  const result = await startPiRuntimeWithFallback({
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
  assert.equal(events.some((event) => event.type === 'fallback' && event.profileId === 'two'), true);
});

test('runPiPromptWithFallback retries prompt after provider failure', async () => {
  const events = [];
  const first = fakeRuntime('one', { failPrompt: true });
  const result = await runPiPromptWithFallback({
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
