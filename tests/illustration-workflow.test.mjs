import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const ELECTRON_STUB = [
  'const noop = () => {};',
  'class BrowserWindow { static getAllWindows() { return []; } }',
  "const ipcMain = { handle: noop, on: noop, removeHandler: noop, removeAllListeners: noop };",
  "const app = { getAppPath: () => '', getPath: () => process.env.WMB_ILLUSTRATION_USER_DATA || '', whenReady: () => Promise.resolve(), on: noop };",
  'const safeStorage = { encryptString: (s) => Buffer.from(String(s), "utf8"), decryptString: (b) => String(b) };',
  'export { app, BrowserWindow, ipcMain, safeStorage };',
  'export default { app, safeStorage, ipcMain, BrowserWindow };'
].join('\n');
const HOOK_SOURCE = [
  "const { existsSync } = process.getBuiltinModule('node:fs');",
  "const path = process.getBuiltinModule('node:path');",
  "const { fileURLToPath, pathToFileURL } = process.getBuiltinModule('node:url');",
  'const ELECTRON_STUB = ' + JSON.stringify(ELECTRON_STUB) + ';',
  'export async function resolve(specifier, context, nextResolve) {',
  "  if (specifier === 'electron') return { url: 'data:text/javascript,' + encodeURIComponent(ELECTRON_STUB), shortCircuit: true };",
  "  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !path.extname(specifier)) {",
  '    const base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);',
  "    for (const ext of ['.ts', '.mts', '.cts']) {",
  '      const candidate = base + ext;',
  '      if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };',
  '    }',
  '  }',
  '  return nextResolve(specifier, context);',
  '}'
].join('\n');
register('data:text/javascript,' + encodeURIComponent(HOOK_SOURCE), import.meta.url);

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { openDataRoot } = await import('../src/main/data-root.ts');
const { createContentProjectWithVersion, saveCoreVersion, getContentProject } = await import('../src/main/content.ts');
const { upsertSource } = await import('../src/main/sources.ts');
const { stageAssetBytes, registerStagedAsset } = await import('../src/main/assets.ts');
const { insertMediaCandidates, completeMediaCandidatePreserved } = await import('../src/main/db/media-archive-store.ts');
const { sourceRevisionKey } = await import('../src/shared/media-candidates.ts');
const { IllustrationWorkflow, saveIllustrationImageConfig } = await import('../src/main/illustration-workflow.ts');
const { savePiConfig } = await import('../src/main/pi-config.ts');
const { enqueueVisualRun, markVisualRunRunning, markVisualRunCompleted, VISUAL_SCHEMA_VERSION } = await import('../src/main/visual-source-lineage.ts');

const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-illustration-contract-'));
  process.env.WMB_ILLUSTRATION_USER_DATA = root;
  await openDataRoot(root);
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  const dataRoot = { path: root, isNew: false };
  const commands = [];
  const runtime = {
    database,
    identity: { workspaceId: 'illustration-test-workspace', rootPath: root, runtimeEpoch: `epoch-${Date.now()}-${Math.random()}` },
    dispatchCommand: async (envelope, execute) => {
      commands.push(envelope);
      return { ok: true, data: execute(database).data, error: null };
    }
  };
  const dependencies = {
    loadSelectedDataRoot: async () => dataRoot,
    migrate: () => dataRoot,
    getActiveRuntime: () => runtime,
    getImageConfigPath: () => path.join(root, 'illustration-image-config.json')
  };
  return { root, database, runtime, dependencies, commands };

}

async function disposeFixture(fixture) {
  fixture.database.close();
  await rm(fixture.root, { recursive: true, force: true });
}

async function createProject(fixture, body, sourceIds = []) {
  return createContentProjectWithVersion(fixture.database, { title: '配图合同测试', body, sourceIds });
}

async function configureImageModel(fixture, profileId = 'image-profile') {
  savePiConfig({ id: profileId, name: 'Contract image provider', baseUrl: 'https://image.test/v1', model: 'image-default', api: 'openai-completions', apiKey: 'contract-secret', imageGeneration: true });
  return saveIllustrationImageConfig(fixture.dependencies, { profileId, model: 'image-default' });
}

function installProvider(responses, calls) {
  globalThis.fetch = async (_url, options = {}) => {
    const request = JSON.parse(String(options.body ?? '{}'));
    calls.push(request);
    const response = responses.shift() ?? { status: 500 };
    if (response.status && response.status >= 400) return { ok: false, status: response.status, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: (response.bytes ?? pngBytes).toString('base64') }] }) };
  };
}

async function addArchivedSourceMedia(fixture) {
  const source = upsertSource(fixture.database, { title: '已归档来源', originalUrl: 'https://source.test/article', summary: '来源摘要', verificationStatus: 'verified' }, false);
  const revisionKey = sourceRevisionKey(source.id, source.revision);
  const [candidateId] = insertMediaCandidates(fixture.database, {
    sourceId: source.id,
    sourceRevisionKey: revisionKey,
    channel: 'official_web',
    requestId: 'source-discovery-1',
    discoveredAt: new Date().toISOString(),
    candidates: [{ kind: 'image', originalUrl: 'https://source.test/image.png', ordinal: 1, postKind: 'web', surroundingText: '来源图证据' }]
  }).candidateIds;
  const staged = await stageAssetBytes(fixture.root, { bytes: pngBytes, fileName: 'source.png', mimeType: 'image/png', origin: 'source_media', width: 1200, height: 800 });
  registerStagedAsset(fixture.database, staged);
  const binding = completeMediaCandidatePreserved(fixture.database, {
    candidateId,
    sourceId: source.id,
    sourceRevisionKey: revisionKey,
    assetId: staged.id,
    sha256: staged.sha256,
    capturedAt: new Date().toISOString(),
    kind: 'image',
    ordinal: 1,
    originalUrl: 'https://source.test/image.png',
    caption: '来源图证据',
    rightsStatus: 'likely_reusable',
    createdBy: 'contract-test',
    requestId: 'source-discovery-1'
  });
  const visual = enqueueVisualRun(fixture.database, {
    sourceId: source.id,
    sourceRevisionId: revisionKey,
    assetId: staged.id,
    schemaVersion: VISUAL_SCHEMA_VERSION
  }).run;
  markVisualRunRunning(fixture.database, visual.id);
  markVisualRunCompleted(fixture.database, visual.id, {
    model: 'fixture-vision',
    provider: 'contract-test',
    promptVersion: 1,
    observation: {
      reason: '来源图片已完成理解。',
      items: [{ kind: 'claim', canonicalKey: 'source-paragraph', statement: '来源段落', excerpt: '来源段落', valueRationale: '直接证据' }]
    }
  });
  return { source, binding };
}

test('source media is consumed, fixed snapshots are read back, and start is idempotent', async () => {
  const fixture = await createFixture();
  try {
    const { source, binding } = await addArchivedSourceMedia(fixture);
    const project = await createProject(fixture, '# 标题\n\n来源段落。\n\n需要解释的第二段。', [source.id]);
    const workflow = new IllustrationWorkflow(fixture.dependencies);
    const first = await workflow.start({ projectId: project.id, requestId: 'source-run-1', expectedRevision: project.revision, ratio: '4:3', maxGenerated: 1 });
    await workflow.resume(first.id);
    const complete = workflow.read(first.id);
    assert.ok(complete);
    assert.equal(complete.sourceVersionId, project.contentVersionId);
    assert.deepEqual(complete.sourceIds, [source.id]);
    assert.deepEqual(complete.sourceRevisionKeys, [sourceRevisionKey(source.id, source.revision)]);
    assert.equal(complete.defaultRatio, '4:3');
    assert.ok(complete.items.some((item) => item.kind === 'source' && item.sourceBindingId === binding.id && item.sourceAssetId === binding.assetId));
    assert.ok(complete.items.some((item) => item.kind === 'generated'), 'a second claim should use the generated route');
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM media_recommendations').get().count > 0, true);
    const target = getContentProject(fixture.database, project.id).revisions[0];
    assert.ok(target.body.includes('wmb-asset://'), 'source and generated references must be inserted into a new body');
    assert.notEqual(target.id, project.contentVersionId);
    assert.equal(target.body.includes('AI 生成'), false);

    const assetCount = fixture.database.prepare('SELECT COUNT(*) AS count FROM assets').get().count;
    const versionCount = fixture.database.prepare('SELECT COUNT(*) AS count FROM content_versions').get().count;
    const replay = await workflow.start({ projectId: project.id, requestId: 'source-run-1', expectedRevision: project.revision + 1, ratio: '4:3', maxGenerated: 1 });
    assert.equal(replay.id, first.id);
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM assets').get().count, assetCount);
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM content_versions').get().count, versionCount);

    const restarted = new IllustrationWorkflow(fixture.dependencies);
    const readback = restarted.read(first.id);
    assert.deepEqual(readback, workflow.read(first.id));
  } finally {
    await disposeFixture(fixture);
  }
});

test('provider ratios are structured, generation is capped, and partial failure preserves success for retry', async () => {
  const fixture = await createFixture();
  const calls = [];
  try {
    await configureImageModel(fixture);
    installProvider([{ bytes: pngBytes }, { status: 500 }, { bytes: Buffer.from([1, 2, 3, 4]) }], calls);
    const project = await createProject(fixture, '# 标题\n\n第一段。\n\n第二段。\n\n第三段。');
    const workflow = new IllustrationWorkflow(fixture.dependencies);
    const started = await workflow.start({ projectId: project.id, requestId: 'generated-run-1', expectedRevision: project.revision, ratio: '21:9', maxGenerated: 2 });
    await workflow.resume(started.id);
    let run = workflow.read(started.id);
    assert.ok(run);
    assert.ok(calls.length > 0, `provider was not called: ${JSON.stringify(run)}`);
    assert.equal(run.items.filter((item) => item.kind === 'generated').length, 2);
    assert.equal(calls[0].ratio, '21:9');
    assert.equal(calls[0].aspect_ratio, '21:9');
    assert.equal(calls[0].size, '1536x658');
    assert.equal(run.items.filter((item) => item.state === 'completed').length, 1);
    const failed = run.items.find((item) => item.state === 'failed');
    assert.ok(failed);
    const success = run.items.find((item) => item.state === 'completed');
    assert.ok(success?.assetId);
    assert.equal(run.status, 'partial');
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM asset_provenance WHERE kind='generated'").get().count, 1);

    await workflow.retry({ runId: started.id, itemId: failed.id, requestId: 'generated-run-1:retry' });
    await workflow.resume(started.id);
    run = workflow.read(started.id);
    assert.equal(run.items.find((item) => item.id === failed.id)?.state, 'completed');
    assert.equal(run.items.filter((item) => item.state === 'completed').length, 2);
    assert.equal(calls[2].ratio, '21:9');
    assert.ok(run.targetVersionId);
    assert.equal(getContentProject(fixture.database, project.id).revisions[0].body.includes('wmb-asset://'), true);
  } finally {
    await disposeFixture(fixture);
  }
});
test('multiple failed items can be retried without reusing a finalize request identity', async () => {
  const fixture = await createFixture();
  const calls = [];
  try {
    await configureImageModel(fixture);
    installProvider([{ bytes: pngBytes }, { status: 500 }, { status: 500 }, { bytes: Buffer.from([1, 2, 3]) }, { bytes: Buffer.from([4, 5, 6]) }], calls);
    const project = await createProject(fixture, '# 标题\n\n第一段有效内容。\n\n第二段有效内容。');
    const workflow = new IllustrationWorkflow(fixture.dependencies);
    const started = await workflow.start({ projectId: project.id, requestId: 'multi-retry-run', expectedRevision: project.revision, maxGenerated: 3 });
    await workflow.resume(started.id);
    let run = workflow.read(started.id);
    const failed = run.items.filter((item) => item.state === 'failed');
    assert.equal(failed.length, 2, JSON.stringify(run));

    await workflow.retry({ runId: run.id, itemId: failed[0].id });
    await workflow.retry({ runId: run.id, itemId: failed[1].id });
    await workflow.resume(run.id);
    run = workflow.read(run.id);
    assert.equal(run.status, 'completed', JSON.stringify(run));
    assert.equal(run.items.every((item) => item.state === 'completed'), true);
    const finalizeIds = fixture.commands.filter((command) => command.command === 'illustration.finalize').map((command) => command.requestId);
    assert.equal(new Set(finalizeIds).size, finalizeIds.length, `finalize request IDs must be state-bound: ${JSON.stringify(finalizeIds)}`);
  } finally {
    await disposeFixture(fixture);
  }
});

test('restart recovers generating items and meaningless markdown does not become an illustration', async () => {
  const fixture = await createFixture();
  const calls = [];
  try {
    await configureImageModel(fixture);
    installProvider([{ bytes: pngBytes }, { bytes: Buffer.from([7, 8, 9]) }], calls);
    const project = await createProject(fixture, '####\n\n## 有意义的配图主题\n\n────────────────────────────────');
    const workflow = new IllustrationWorkflow(fixture.dependencies);
    const started = await workflow.start({ projectId: project.id, requestId: 'recover-run', expectedRevision: project.revision, maxGenerated: 6 });
    await workflow.resume(started.id);
    let run = workflow.read(started.id);
    assert.equal(run.items.length, 1, JSON.stringify(run.items));
    const item = run.items[0];
    fixture.database.prepare("UPDATE illustration_items SET state='generating', asset_id=NULL, content_version_id=NULL WHERE id=?").run(item.id);
    fixture.database.prepare("UPDATE illustration_runs SET status='running', target_version_id=NULL, completed_at=NULL WHERE id=?").run(run.id);
    fixture.database.prepare('DELETE FROM content_versions WHERE id=?').run(run.targetVersionId);

    const restarted = new IllustrationWorkflow(fixture.dependencies);
    await restarted.resume(run.id);
    run = restarted.read(run.id);
    assert.equal(run.status, 'completed', JSON.stringify(run));
    assert.equal(run.items[0].state, 'completed');
    assert.equal(run.items[0].attempt, 1);
    assert.equal(fixture.commands.some((command) => command.command === 'illustration.item.recover'), true);
  } finally {
    await disposeFixture(fixture);
  }
});


test('regeneration carries context, replaces in place, and undo restores without a provider call', async () => {
  const fixture = await createFixture();
  const calls = [];
  try {
    await configureImageModel(fixture);
    installProvider([{ bytes: pngBytes }, { bytes: Buffer.from([5, 6, 7, 8]) }], calls);
    const project = await createProject(fixture, '# 标题\n\n需要一张解释图。');
    const workflow = new IllustrationWorkflow(fixture.dependencies);
    const started = await workflow.start({ projectId: project.id, requestId: 'regenerate-run-1', expectedRevision: project.revision, ratio: '1:1', maxGenerated: 1 });
    await workflow.resume(started.id);
    let run = workflow.read(started.id);
    const item = run.items.find((candidate) => candidate.kind === 'generated');
    assert.ok(item?.assetId);
    const oldAssetId = item.assetId;
    const oldVersionId = run.targetVersionId;
    await workflow.regenerate({ runId: run.id, itemId: item.id, ratio: '9:21', request: '改成竖向构图', requestId: 'regenerate-run-1:regenerate' });
    await workflow.resume(run.id);
    run = workflow.read(run.id);
    const regenerated = run.items.find((candidate) => candidate.id === item.id);
    assert.ok(regenerated?.assetId);
    assert.notEqual(regenerated.assetId, oldAssetId);
    assert.equal(regenerated.ratio, '9:21');
    assert.equal(calls[1].ratio, '9:21');
    assert.equal(calls[1].prompt.includes('改成竖向构图'), true);
    assert.equal(calls[1].prompt.includes('文章标题：配图合同测试'), true);
    assert.notEqual(run.targetVersionId, oldVersionId);
    assert.equal(regenerated.previousAssetId, oldAssetId);

    const providerCallsBeforeUndo = calls.length;
    await workflow.undo({ runId: run.id, itemId: item.id, requestId: 'regenerate-run-1:undo' });
    run = workflow.read(run.id);
    const undone = run.items.find((candidate) => candidate.id === item.id);
    assert.equal(undone.assetId, oldAssetId);
    assert.equal(undone.previousAssetId, null);
    assert.equal(calls.length, providerCallsBeforeUndo);
    assert.notEqual(run.targetVersionId, oldVersionId);
  } finally {
    await disposeFixture(fixture);
  }
});

test('provider failures remain truthful and stale body changes cannot be overwritten', async () => {
  const fixture = await createFixture();
  const calls = [];
  try {
    await configureImageModel(fixture);
    installProvider([{ status: 503 }], calls);
    const project = await createProject(fixture, '# 标题\n\n原始段落。');
    const workflow = new IllustrationWorkflow(fixture.dependencies);
    const started = await workflow.start({ projectId: project.id, requestId: 'stale-run-1', expectedRevision: project.revision, ratio: '3:4', maxGenerated: 1 });
    await saveCoreVersion(fixture.database, { projectId: project.id, body: '# 新正文\n\n用户已修改。', expectedRevision: project.revision, author: 'user' });
    await workflow.resume(started.id);
    const run = workflow.read(started.id);
    assert.ok(run);
    assert.equal(run.status, 'conflicted', JSON.stringify(run));
    assert.equal(getContentProject(fixture.database, project.id).revisions[0].body, '# 新正文\n\n用户已修改。');
    assert.equal(calls.length <= 1, true);
  } finally {
    await disposeFixture(fixture);
  }
});
