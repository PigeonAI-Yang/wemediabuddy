import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { activatePiConfig, deletePiConfig, listPiModels, migratePiConfigToInstallation, readPiConfig, resolvePiConfig, resolveRoleModelPolicySnapshot, savePiConfig, saveRoleModelPolicies } from '../src/main/pi-config.ts';
import { piModelsJson } from '../src/main/pi-model.ts';
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

test('v1 fallback chain migrates to v3 pair candidates and role policies save atomically', async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'wmb-pi-role-policy-'));
  const configPath = path.join(rootPath, 'pi-api-config.json');
  try {
    await writeFile(configPath, JSON.stringify({ version: 1, state: {
      activeId: 'one',
      fallbackOrder: ['three', 'one', 'two', 'missing'],
      profiles: [
        { id: 'one', name: '主接口', baseUrl: 'https://one.test/v1', model: 'model-one', api: 'openai-responses', thinking: 'low', encryptedApiKey: 'secret-one' },
        { id: 'two', name: '备用甲', baseUrl: 'https://two.test/v1', model: 'model-two', api: 'openai-completions', thinking: 'medium', encryptedApiKey: 'secret-two' },
        { id: 'three', name: '备用乙', baseUrl: 'https://three.test/v1', model: 'model-three', api: 'openai-responses', encryptedApiKey: 'secret-three' }
      ]
    } }), 'utf8');

    const migrated = readPiConfig(configPath);
    assert.equal(migrated.version, 3);
    assert.equal(migrated.modelPolicyRevision, 1);
    for (const roleId of ['desk', 'reporter', 'planner', 'writer', 'librarian']) {
      assert.deepEqual(migrated.roleModelPolicies[roleId].candidates, [
        { profileId: 'one', model: 'model-one' },
        { profileId: 'three', model: 'model-three' },
        { profileId: 'two', model: 'model-two' }
      ]);
    }

    const nextPolicies = Object.fromEntries(
      Object.keys(migrated.roleModelPolicies).map((roleId) => [roleId, {
        candidates: roleId === 'writer'
          ? [
            { profileId: 'two', model: 'writer-model-a', thinking: 'high' },
            { profileId: 'two', model: 'writer-model-b', thinking: 'off' },
            { profileId: 'one', model: 'model-one' }
          ]
          : roleId === 'reporter'
            ? [{ profileId: 'one', model: 'model-one', thinking: 'xhigh' }]
            : [{ profileId: 'one', model: 'model-one' }]
      }])
    );
    const saved = saveRoleModelPolicies({ roleModelPolicies: nextPolicies, expectedRevision: migrated.modelPolicyRevision }, configPath);
    assert.equal(saved.modelPolicyRevision, 2);
    assert.deepEqual(saved.roleModelPolicies.writer.candidates, nextPolicies.writer.candidates);
    assert.deepEqual(saved.roleModelPolicies.reporter.candidates, [{ profileId: 'one', model: 'model-one', thinking: 'xhigh' }]);

    const snapshot = resolveRoleModelPolicySnapshot('writer', configPath);
    assert.deepEqual(snapshot.profiles.map((profile) => [profile.profileId, profile.model, profile.thinking]), [
      ['two', 'writer-model-a', 'high'], ['two', 'writer-model-b', 'off'], ['one', 'model-one', 'low']
    ]);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.profiles[0]), true);
    assert.equal(resolveRoleModelPolicySnapshot('reporter', configPath).profiles[0].thinking, 'xhigh');

    assert.throws(
      () => saveRoleModelPolicies({ roleModelPolicies: { ...nextPolicies, planner: { candidates: [{ profileId: 'one', model: 'model-one', thinking: 'invalid' }] } }, expectedRevision: saved.modelPolicyRevision }, configPath),
      (error) => error?.code === 'ROLE_MODEL_CONFIG_INVALID'
    );
    assert.throws(
      () => saveRoleModelPolicies({ roleModelPolicies: { ...nextPolicies, planner: { candidates: [{ profileId: 'one', model: 'model-one', thinking: 'high' }, { profileId: 'one', model: 'model-one', thinking: 'off' }] } }, expectedRevision: saved.modelPolicyRevision }, configPath),
      (error) => error?.code === 'ROLE_MODEL_CONFIG_INVALID'
    );

    assert.throws(
      () => saveRoleModelPolicies({ roleModelPolicies: { ...nextPolicies, reporter: { candidates: [{ profileId: 'one', model: '' }] } }, expectedRevision: saved.modelPolicyRevision }, configPath),
      (error) => error?.code === 'ROLE_MODEL_PROFILE_MISSING'
    );
    const unchanged = readPiConfig(configPath);
    assert.equal(unchanged.modelPolicyRevision, 2);
    assert.deepEqual(unchanged.roleModelPolicies.reporter.candidates, [{ profileId: 'one', model: 'model-one', thinking: 'xhigh' }]);
  } finally {
    await rm(rootPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
test('v2 profile-id policies migrate using each profile current model', async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'wmb-pi-v2-migration-'));
  const configPath = path.join(rootPath, 'pi-api-config.json');
  try {
    const profiles = [
      { id: 'shared', name: '共享预设', baseUrl: 'https://shared.test/v1', model: 'current-shared', api: 'openai-responses', encryptedApiKey: 'secret-shared' },
      { id: 'other', name: '备用预设', baseUrl: 'https://other.test/v1', model: 'current-other', api: 'openai-completions', encryptedApiKey: 'secret-other' }
    ];
    const roleModelPolicies = Object.fromEntries(['desk', 'reporter', 'planner', 'writer', 'librarian'].map((roleId) => [roleId, { profileIds: roleId === 'writer' ? ['shared', 'other'] : ['shared'] }]));
    await writeFile(configPath, JSON.stringify({ version: 2, activeId: 'shared', profiles, modelPolicyRevision: 9, roleModelPolicies }), 'utf8');
    const migrated = readPiConfig(configPath);
    assert.equal(migrated.version, 3);
    assert.equal(migrated.modelPolicyRevision, 9);
    assert.deepEqual(migrated.roleModelPolicies.writer.candidates, [
      { profileId: 'shared', model: 'current-shared' },
      { profileId: 'other', model: 'current-other' }
    ]);
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

test('Pi models.json uses per-model limits and registers only a multimodal primary', () => {
  const known = piModelsJson({ baseUrl: 'https://opencode.ai/zen/go/v1', api: 'openai-completions', apiKey: '$WMB_PI_API_KEY', model: 'deepseek-v4-flash' });
  const knownModels = known.providers['wmb-api'].models;
  assert.equal(knownModels.length, 1);
  assert.equal(knownModels[0].contextWindow, 1000000);
  assert.equal(knownModels[0].maxTokens, 384000);
  assert.deepEqual(knownModels[0].input, ['text', 'image']);
  const unknown = piModelsJson({ baseUrl: 'https://example.test/v1', api: 'openai-responses', apiKey: 'key', model: 'unknown' });
  const unknownModels = unknown.providers['wmb-api'].models;
  assert.equal(unknownModels.length, 1);
  assert.equal(unknownModels[0].id, 'unknown');
  assert.deepEqual(unknownModels[0].input, ['text', 'image']);
  const unknownJson = JSON.stringify(unknown);
  assert.equal(unknownJson.includes('contextWindow'), false);
  assert.equal(unknownJson.includes('maxTokens'), false);
});

test('Pi models.json keeps the configured primary as the sole multimodal entry', () => {
  const config = piModelsJson({ baseUrl: 'https://opencode.ai/zen/go/v1', api: 'openai-completions', apiKey: 'key', model: 'configured-primary' });
  assert.deepEqual(config.providers['wmb-api'].models.map((model) => ({ id: model.id, input: model.input })), [
    { id: 'configured-primary', input: ['text', 'image'] }
  ]);
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

    assert.deepEqual(migratePiConfigToInstallation(configPath, [ai.path, uk.path]), { migratedFrom: null, profileCount: 1 });
    assert.equal(readPiConfig(configPath).configured, true);
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
