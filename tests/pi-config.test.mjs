import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { activatePiConfig, deletePiConfig, listPiModels, readPiConfig, resolvePiConfig, savePiConfig } from '../src/main/pi-config.ts';

test('Pi API presets read, switch and delete without exposing keys', async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'wmb-pi-config-'));
  const root = await openDataRoot(rootPath);
  const database = migrateDatabase(path.join(root.path, 'wmb.db'));
  try {
    const now = new Date().toISOString();
    database.prepare('INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)').run(
      'pi-api-config',
      JSON.stringify({
        activeId: 'one',
        profiles: [
          { id: 'one', name: '主接口', baseUrl: 'https://one.test/v1', model: 'model-one', api: 'openai-responses', encryptedApiKey: 'secret-one' },
          { id: 'two', name: '备用接口', baseUrl: 'https://two.test/v1', model: 'model-two', api: 'openai-completions', thinking: 'high', encryptedApiKey: 'secret-two' }
        ]
      }),
      now,
      now
    );

    const initial = readPiConfig(database);
    assert.equal(initial.profiles.length, 2);
    assert.equal(JSON.stringify(initial).includes('secret-'), false);
    assert.equal(initial.profiles[0].active, true);

    const switched = activatePiConfig(database, 'two');
    assert.equal(switched.activeId, 'two');
    assert.equal(switched.model, 'model-two');
    assert.equal(switched.profiles.find((profile) => profile.id === 'two').thinking, 'high');

    const remaining = deletePiConfig(database, 'two');
    assert.equal(remaining.activeId, 'one');
    assert.deepEqual(remaining.profiles.map((profile) => profile.name), ['主接口']);
  } finally {
    database.close();
    await rm(rootPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('Pi API model list uses the compatible models endpoint', async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'wmb-pi-models-'));
  const root = await openDataRoot(rootPath);
  const database = migrateDatabase(path.join(root.path, 'wmb.db'));
  const server = createServer((request, response) => {
    assert.equal(request.url, '/v1/models');
    assert.equal(request.headers.authorization, 'Bearer test-key');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-a' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const models = await listPiModels(database, {
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      api: 'openai-completions',
      apiKey: 'test-key'
    });
    assert.deepEqual(models, ['model-a', 'model-b']);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    database.close();
    await rm(rootPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('unsupported Pi API protocol is rejected at every config boundary', async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'wmb-unsupported-pi-api-'));
  const root = await openDataRoot(rootPath);
  const database = migrateDatabase(path.join(root.path, 'wmb.db'));
  try {
    const now = new Date().toISOString();
    database.prepare('INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)').run(
      'pi-api-config',
      JSON.stringify({
        activeId: 'invalid',
        profiles: [{ id: 'invalid', name: '不支持', baseUrl: 'https://invalid.test/v1', model: 'invalid-model', api: 'anthropic-messages', encryptedApiKey: 'unused' }]
      }),
      now,
      now
    );

    assert.throws(() => readPiConfig(database), /仅支持 OpenAI Responses 或 OpenAI Chat Completions/);
    assert.throws(() => resolvePiConfig(database), /仅支持 OpenAI Responses 或 OpenAI Chat Completions/);
    assert.throws(() => savePiConfig(database, {
      name: '不支持', baseUrl: 'https://invalid.test/v1', model: 'invalid-model', api: 'anthropic-messages', apiKey: 'unused'
    }), /仅支持 OpenAI Responses 或 OpenAI Chat Completions/);
    await assert.rejects(() => listPiModels(database, {
      baseUrl: 'https://invalid.test/v1', api: 'anthropic-messages', apiKey: 'unused'
    }), /仅支持 OpenAI Responses 或 OpenAI Chat Completions/);
  } finally {
    database.close();
    await rm(rootPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
