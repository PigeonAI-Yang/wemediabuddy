import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createContentProject } from '../src/main/content.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import {
  createPiImageBatch,
  piImageBatchInputHash,
  preparePiImageAttachments,
  readPiImageBatchByRequest,
  validatePiImagePlacement
} from '../src/main/pi-image-batch.ts';

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
