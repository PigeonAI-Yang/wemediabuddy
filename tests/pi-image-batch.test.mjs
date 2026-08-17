import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { register } from 'node:module';
import { createContentProject, createContentProjectWithVersion } from '../src/main/content.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { openDataRoot } from '../src/main/data-root.ts';
import {
  createPiImageBatch,
  piImageBatchInputHash,
  preparePiImageAttachments,
  readPiImageBatchByRequest,
  validatePiImagePlacement
} from '../src/main/pi-image-batch.ts';
const ELECTRON_STUB = [
  'const noop = () => {};',
  'class BrowserWindow { static getAllWindows() { return []; } }',
  "const ipcMain = { handle: noop, on: noop, removeHandler: noop, removeAllListeners: noop };",
  'const app = { getAppPath: () => "", whenReady: () => Promise.resolve(), on: noop };',
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
const { runPiImageBatch } = await import('../src/main/ipc-pi-dock.ts');

const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const inputFor = (projectId, requestId = 'request-1') => ({
  message: '',
  requestId,
  projectId,
  attachments: [{
    fileName: '../cover.png',
    mimeType: 'image/png',
    bytesBase64: pngBytes.toString('base64'),
    byteCount: pngBytes.byteLength,
    width: 1200,
    height: 800
  }]
});

async function withDatabase(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-pi-image-batch-'));
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  try { await run(database); } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
}

test('migration 73 creates image batch tables after all prior migrations', async () => {
  await withDatabase((database) => {
    const applied = database.prepare('SELECT version FROM schema_migrations WHERE version = 73').get();
    assert.equal(applied?.version, 73);
    const names = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'pi_image_batch%'").all().map((row) => row.name).sort();
    assert.deepEqual(names, ['pi_image_batch_attachments', 'pi_image_batches']);
  });
});

test('batch preparation validates bytes and request identity is idempotent', async () => {
  await withDatabase((database) => {
    const project = createContentProject(database, { title: '排图测试' });
    const input = inputFor(project.id);
    const attachments = preparePiImageAttachments(input);
    assert.equal(attachments[0].sourceFileName, '.._cover.png');
    const inputHash = piImageBatchInputHash({ projectId: project.id, userMessage: input.message, attachments });
    const createInput = { requestId: input.requestId, projectId: project.id, userMessage: input.message, expectedRevision: project.revision, baselineVersionId: null, inputHash, attachments };
    const first = createPiImageBatch(database, createInput);
    const retry = createPiImageBatch(database, createInput);
    assert.equal(retry.id, first.id);
    assert.equal(readPiImageBatchByRequest(database, project.id, input.requestId)?.attachments.length, 1);
    assert.throws(() => createPiImageBatch(database, { ...createInput, inputHash: 'f'.repeat(64) }), /同一 requestId/);
  });
});

test('batch preparation rejects forged image MIME content', () => {
  const input = inputFor('project-1');
  input.attachments[0].bytesBase64 = Buffer.from('not a png').toString('base64');
  input.attachments[0].byteCount = Buffer.from('not a png').byteLength;
  assert.throws(() => preparePiImageAttachments(input), /无法按 image\/png 解码/);
});

test('placement accepts standalone image insertion but rejects article rewrites', () => {
  const attachment = { ordinal: 0, assetId: 'asset-1' };
  const batch = { requestId: 'request-1', projectId: 'project-1', attachments: [attachment] };
  const baseline = { versionId: 'version-1', expectedRevision: 2, body: '# 标题\n\n原正文。', bindings: [] };
  const decision = { order: 0, assetId: 'asset-1', decision: 'used', alt: '配图', caption: null, widthPreset: 'medium', align: 'center' };
  const mediaBindings = [{ assetId: 'asset-1', occurrence: 0, widthPreset: 'medium', align: 'center', caption: null }];
  const valid = { requestId: 'request-1', projectId: 'project-1', baselineVersionId: 'version-1', expectedRevision: 2, body: '# 标题\n\n![配图](wmb-asset://asset-1)\n\n原正文。', decisions: [decision], mediaBindings };
  assert.equal(validatePiImagePlacement(valid, { batch, baseline }).body, valid.body);
  assert.throws(() => validatePiImagePlacement({ ...valid, body: '# 被改写\n\n![配图](wmb-asset://asset-1)\n\n原正文。' }, { batch, baseline }), /只能插入图片/);
});
async function withBatchFixture(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-pi-image-routing-'));
  const dataRoot = await openDataRoot(directory);
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  try {
    const project = createContentProjectWithVersion(database, { title: '视觉排图', body: '# 标题\n\n原正文。' });
    await run({ directory, dataRoot, database, projectId: project.id });
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function fakeBatchRuntime(database, commands, rootPath) {
  return {
    database,
    identity: { workspaceId: 'workspace-routing', rootPath, runtimeEpoch: 'epoch-routing' },
    dispatchCommand: async (_envelope, handler) => {
      const result = handler();
      commands.push({ kind: 'database', data: result.data });
      return { ok: true, data: result.data, error: null };
    }
  };
}

function fakeBatchPi(commands, options = {}) {
  const original = options.original ?? { provider: 'wmb-api', modelId: 'text-only' };
  let current = { ...original };
  return {
    async getModel() {
      commands.push({ kind: 'state' });
      return { ...current };
    },
    async setModel(provider, modelId) {
      commands.push({ kind: 'set_model', provider, modelId });
      current = { provider, modelId };
    },
    async promptUntilSettled(prompt, { images }) {
      commands.push({ kind: 'prompt', prompt, images: images.map((image) => ({ ...image })) });
      if (options.throwOnPrompt) throw new Error('vision analysis failed');
      const assetIds = [...new Set([...prompt.matchAll(/"assetId":"([^"]+)"/g)].map((match) => match[1]))];
      const requestId = /requestId=([^\n]*)/.exec(prompt)?.[1] ?? '';
      const projectId = /projectId=([^\n]*)/.exec(prompt)?.[1] ?? '';
      const baselineVersionId = /baselineVersionId=([^\n]*)/.exec(prompt)?.[1] || null;
      const expectedRevision = Number(/expectedRevision=(\d+)/.exec(prompt)?.[1]);
      const body = `# 标题\n\n${assetIds.map((assetId) => `![配图](wmb-asset://${assetId})`).join('\n\n')}\n\n原正文。`;
      return {
        text: `\`\`\`json\n${JSON.stringify({ wmb_pi_image_placement: {
          requestId, projectId, baselineVersionId, expectedRevision, body,
          decisions: assetIds.map((assetId, order) => ({ order, assetId, decision: 'used', alt: '配图', caption: null, widthPreset: 'medium', align: 'center' })),
          mediaBindings: assetIds.map((assetId) => ({ assetId, occurrence: 0, widthPreset: 'medium', align: 'center', caption: null }))
        } })}\n\`\`\``,
        thinking: 'vision',
        stopped: false
      };
    }
  };
}

test('image batch uses the active configured wmb-api model without switching', async () => {
  await withBatchFixture(async ({ directory, dataRoot, database, projectId }) => {
    const first = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    const second = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    const input = {
      message: '请按正文配图',
      requestId: 'routing-success',
      projectId,
      attachments: [
        { fileName: 'one.png', mimeType: 'image/png', bytesBase64: first.toString('base64'), byteCount: first.byteLength },
        { fileName: 'two.png', mimeType: 'image/png', bytesBase64: second.toString('base64'), byteCount: second.byteLength }
      ]
    };
    const commands = [];
    const pi = fakeBatchPi(commands, { original: { provider: 'wmb-api', modelId: 'configured-primary' } });
    const outcome = await runPiImageBatch(dataRoot, fakeBatchRuntime(database, commands, directory), pi, input);
    const piCommands = commands.filter((command) => command.kind !== 'database');
    assert.deepEqual(piCommands.map((command) => command.kind), ['state', 'prompt']);
    assert.equal(piCommands.filter((command) => command.kind === 'set_model').length, 0);
    assert.equal(piCommands[1].images.length, input.attachments.length);
    assert.deepEqual(piCommands[1].images.map((image) => Buffer.from(image.data, 'base64')), [first, second]);
    assert.equal(outcome.batch.status, 'completed', outcome.batch.failureMessage ?? undefined);
    assert.equal(outcome.batch.usedCount, 2);
  });
});

test('image batch preserves an active-model prompt failure without switching models', async () => {
  await withBatchFixture(async ({ directory, dataRoot, database, projectId }) => {
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 2]);
    const input = {
      message: '请分析图片',
      requestId: 'routing-failure',
      projectId,
      attachments: [{ fileName: 'failed.png', mimeType: 'image/png', bytesBase64: bytes.toString('base64'), byteCount: bytes.byteLength }]
    };
    const commands = [];
    const pi = fakeBatchPi(commands, { throwOnPrompt: true, original: { provider: 'wmb-api', modelId: 'configured-primary' } });
    const outcome = await runPiImageBatch(dataRoot, fakeBatchRuntime(database, commands, directory), pi, input);
    const piCommands = commands.filter((command) => command.kind !== 'database');
    assert.deepEqual(piCommands.map((command) => command.kind), ['state', 'prompt']);
    assert.equal(piCommands.filter((command) => command.kind === 'set_model').length, 0);
    assert.equal(outcome.batch.status, 'failed_analysis');
    assert.match(outcome.batch.failureMessage, /vision analysis failed/);
  });
});

test('image batch fails honestly when the active provider is not wmb-api', async () => {
  await withBatchFixture(async ({ directory, dataRoot, database, projectId }) => {
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 3]);
    const input = {
      message: '请分析图片',
      requestId: 'routing-provider-failure',
      projectId,
      attachments: [{ fileName: 'provider.png', mimeType: 'image/png', bytesBase64: bytes.toString('base64'), byteCount: bytes.byteLength }]
    };
    const commands = [];
    const pi = fakeBatchPi(commands, { original: { provider: 'custom-provider', modelId: 'custom-text' } });
    const outcome = await runPiImageBatch(dataRoot, fakeBatchRuntime(database, commands, directory), pi, input);
    const piCommands = commands.filter((command) => command.kind !== 'database');
    assert.deepEqual(piCommands.map((command) => command.kind), ['state']);
    assert.equal(piCommands.filter((command) => command.kind === 'set_model').length, 0);
    assert.equal(piCommands.filter((command) => command.kind === 'prompt').length, 0);
    assert.equal(outcome.batch.status, 'failed_analysis');
    assert.match(outcome.batch.failureMessage, /custom-provider/);
    assert.match(outcome.batch.failureMessage, /wmb-api/);
    assert.doesNotMatch(outcome.batch.failureMessage, /vision analysis failed/);
  });
});
