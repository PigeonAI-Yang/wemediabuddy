import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { activatePiConfig, deletePiConfig, listPiModels, migratePiConfigToInstallation, readPiConfig, resolvePiConfig, savePiConfig } from '../src/main/pi-config.ts';
import { piModelsJson, WMB_VISION_MODEL } from '../src/main/pi-model.ts';
import { ensureOfficialWorkspaceProfile } from '../src/main/workspace-profiles.ts';

test('Pi API presets read, switch and delete without exposing keys', async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'wmb-pi-config-'));
  const configPath = path.join(rootPath, 'pi-api-config.json');
  try {
    await writeFile(configPath, JSON.stringify({ version: 1, state: {
        activeId: 'one',
        profiles: [
          { id: 'one', name: '主接口', baseUrl: 'https://one.test/v1', model: 'model-one', api: 'openai-responses', encryptedApiKey: 'secret-one' },
          { id: 'two', name: '备用接口', baseUrl: 'https://two.test/v1', model: 'model-two', api: 'openai-completions', thinking: 'high', contextWindow: 200000, maxTokens: 32000, encryptedApiKey: 'secret-two' }
        ]
      } }), 'utf8');

    const initial = readPiConfig(configPath);
    assert.equal(initial.profiles.length, 2);
    assert.equal(JSON.stringify(initial).includes('secret-'), false);
    assert.equal(initial.profiles[0].active, true);

    const switched = activatePiConfig('two', configPath);
    assert.equal(switched.activeId, 'two');
    assert.equal(switched.model, 'model-two');
    assert.equal(switched.profiles.find((profile) => profile.id === 'two').thinking, 'high');
    assert.equal(switched.profiles.find((profile) => profile.id === 'two').contextWindow, 200000);

    const remaining = deletePiConfig('two', configPath);
    assert.equal(remaining.activeId, 'one');
    assert.deepEqual(remaining.profiles.map((profile) => profile.name), ['主接口']);
  } finally {
    await rm(rootPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('Pi API model list uses the compatible models endpoint', async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'wmb-pi-models-'));
  const server = createServer((request, response) => {
    assert.equal(request.url, '/v1/models');
    assert.equal(request.headers.authorization, 'Bearer test-key');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'model-b', context_window: 200000, max_tokens: 32000 }, { id: 'model-a' }, { id: 'model-a' }, { id: 'deepseek-v4-flash' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const models = await listPiModels({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      api: 'openai-completions',
      apiKey: 'test-key'
    }, path.join(rootPath, 'pi-api-config.json'));
    assert.deepEqual(models, [
      { id: 'deepseek-v4-flash', contextWindow: 1000000, maxTokens: 384000 },
      { id: 'model-a', contextWindow: undefined, maxTokens: undefined },
      { id: 'model-b', contextWindow: 200000, maxTokens: 32000 }
    ]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(rootPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('Pi models.json uses per-model limits and leaves unknown models unlocked', () => {
  const known = piModelsJson({ baseUrl: 'https://opencode.ai/zen/go/v1', api: 'openai-completions', apiKey: '$WMB_PI_API_KEY', model: 'deepseek-v4-flash' });
  assert.equal(known.providers['wmb-api'].models[0].contextWindow, 1000000);
  assert.equal(known.providers['wmb-api'].models[0].maxTokens, 384000);
  assert.deepEqual(known.providers['wmb-api'].models[0].input, ['text']);
  assert.deepEqual(known.providers['wmb-api'].models[1], {
    id: WMB_VISION_MODEL,
    name: WMB_VISION_MODEL,
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  });
  const unknown = JSON.stringify(piModelsJson({ baseUrl: 'https://example.test/v1', api: 'openai-responses', apiKey: 'key', model: 'unknown' }));
  assert.equal(unknown.includes('contextWindow'), false);
  assert.equal(unknown.includes('maxTokens'), false);
});

test('Pi vision model remains a single multimodal registry entry when active', () => {
  const config = piModelsJson({ baseUrl: 'https://opencode.ai/zen/go/v1', api: 'openai-completions', apiKey: 'key', model: WMB_VISION_MODEL });
  assert.equal(config.providers['wmb-api'].models.length, 1);
  assert.deepEqual(config.providers['wmb-api'].models[0].input, ['text', 'image']);
});

test('unsupported Pi API protocol is rejected at every config boundary', async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'wmb-unsupported-pi-api-'));
  const configPath = path.join(rootPath, 'pi-api-config.json');
  try {
    await writeFile(configPath, JSON.stringify({ version: 1, state: {
        activeId: 'invalid',
        profiles: [{ id: 'invalid', name: '不支持', baseUrl: 'https://invalid.test/v1', model: 'invalid-model', api: 'anthropic-messages', encryptedApiKey: 'unused' }]
      } }), 'utf8');

    assert.throws(() => readPiConfig(configPath), /仅支持 OpenAI Responses 或 OpenAI Chat Completions/);
    assert.throws(() => resolvePiConfig(configPath), /仅支持 OpenAI Responses 或 OpenAI Chat Completions/);
    assert.throws(() => savePiConfig({
      name: '不支持', baseUrl: 'https://invalid.test/v1', model: 'invalid-model', api: 'anthropic-messages', apiKey: 'unused'
    }, configPath), /仅支持 OpenAI Responses 或 OpenAI Chat Completions/);
    await assert.rejects(() => listPiModels({
      baseUrl: 'https://invalid.test/v1', api: 'anthropic-messages', apiKey: 'unused'
    }, configPath), /仅支持 OpenAI Responses 或 OpenAI Chat Completions/);
  } finally {
    await rm(rootPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('official AI presets migrate once to the installation store shared by every workspace', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'wmb-global-pi-config-'));
  const configPath = path.join(parent, 'user-data', 'pi-api-config.json');
  const ai = await openDataRoot(path.join(parent, 'ai'));
  const uk = await openDataRoot(path.join(parent, 'uk'));
  try {
    const aiDb = migrateDatabase(path.join(ai.path, 'wmb.db'));
    const ukDb = migrateDatabase(path.join(uk.path, 'wmb.db'));
    const now = new Date().toISOString();
    ensureOfficialWorkspaceProfile(aiDb, 'official.ai');
    ensureOfficialWorkspaceProfile(ukDb, 'official.uk');
    aiDb.prepare('INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)').run('pi-api-config', JSON.stringify({ activeId: 'shared', profiles: [{ id: 'shared', name: '共享接口', baseUrl: 'https://shared.test/v1', model: 'shared-model', api: 'openai-responses', encryptedApiKey: 'encrypted' }] }), now, now);
    aiDb.close(); ukDb.close();

    const migrated = migratePiConfigToInstallation(configPath, [uk.path, ai.path]);
    assert.deepEqual(migrated, { migratedFrom: ai.path, profileCount: 1 });
    assert.equal(readPiConfig(configPath).model, 'shared-model');
    const ukRead = migrateDatabase(path.join(uk.path, 'wmb.db'));
    assert.equal(ukRead.prepare("SELECT value FROM app_meta WHERE key='pi-api-config'").get(), undefined);
    ukRead.close();

    const empty = deletePiConfig('shared', configPath);
    assert.equal(empty.configured, false);
    assert.deepEqual(migratePiConfigToInstallation(configPath, [ai.path, uk.path]), { migratedFrom: null, profileCount: 0 });
  } finally { await rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});

test('Pi config nativeSearch flag roundtrips and survives updates without the field', async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'wmb-pi-nativesearch-'));
  const configPath = path.join(rootPath, 'pi-api-config.json');
  try {
    await writeFile(configPath, JSON.stringify({ version: 1, state: {
        activeId: 'one',
        profiles: [
          { id: 'one', name: '主接口', baseUrl: 'https://one.test/v1', model: 'model-one', api: 'openai-responses', encryptedApiKey: 'secret-one' }
        ]
      } }), 'utf8');

    const saved = savePiConfig({ id: 'one', name: '主接口', baseUrl: 'https://one.test/v1', model: 'model-one', api: 'openai-responses', nativeSearch: true }, configPath);
    assert.equal(saved.profiles.find((profile) => profile.id === 'one').nativeSearch, true);
    assert.equal(readPiConfig(configPath).profiles.find((profile) => profile.id === 'one').nativeSearch, true);

    const updated = savePiConfig({ id: 'one', name: '主接口', baseUrl: 'https://one.test/v1', model: 'model-one', api: 'openai-responses' }, configPath);
    assert.equal(updated.profiles.find((profile) => profile.id === 'one').nativeSearch, true);
    assert.equal(readPiConfig(configPath).profiles.find((profile) => profile.id === 'one').nativeSearch, true);
  } finally {
    await rm(rootPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
