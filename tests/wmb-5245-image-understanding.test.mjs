// WMB-5245：图片理解生产接线 + region 支持聚焦测试（ImageUnderstanding slice）。
// 覆盖（合同逐项）：migration 69 region_json 列；region locator 严格解析且旧 locator 兼容；
// 非法 region fail-closed（入队抛错 / 解析 null）；preserved 图片自动入队一次（≤12/Source revision，
// 复用 binding asset_id 不二次下载）；超限图片保持已保存但显式未理解；attempt 历史读模型；
// completed 行不可变（DB 触发器 + 应用门）。
// 运行（本批次不执行；由 Main 统一验证）：node --test --test-concurrency=1 tests/wmb-5245-image-understanding.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { upsertSource } = await import('../src/main/sources.ts');
const {
  VISUAL_SCHEMA_VERSION,
  VISUAL_AUTO_ENQUEUE_LIMIT,
  enqueueVisualRun,
  getVisualRun,
  getLatestVisualRun,
  listVisualRuns,
  listVisualRunAttempts,
  retryVisualRun,
  executeVisualRun,
  ensureSourceImageAsset,
  visualEvidenceLocator,
  parseVisualEvidenceLocator,
  enqueuePreservedSourceImage,
  autoEnqueuePreservedSourceImages,
  readSourceRevisionVisualStatus,
  visualRunToKnowledgeInput,
  VisualSourceError
} = await import('../src/main/visual-source-lineage.ts');
const { insertMediaCandidates, completeMediaCandidatePreserved } = await import('../src/main/db/media-archive-store.ts');

async function makeRoot(prefix = 'wmb-5245-') {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function makeDatabase(root) {
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  const now = new Date().toISOString();
  const workspaceId = `ws-${randomUUID()}`;
  database.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', ?, ?, ?, 1)")
    .run(workspaceId, now, now);
  return { database, workspaceId };
}

function seedSource(database, title) {
  return upsertSource(database, {
    title,
    originalUrl: `https://example.com/${encodeURIComponent(title)}`,
    summary: `${title} 的摘要正文。`,
    priority: 1,
    verificationStatus: 'verified'
  });
}

async function writeImage(root, fileName = 'shot.png', bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
  const filePath = path.join(root, fileName);
  await writeFile(filePath, bytes);
  return filePath;
}

/** 每张图独立字节：不同 URL 的图片必须有不同字节，否则 sha256 去重会合并为同一 Asset
 *  （设计 §16-5：异 URL 同字节复用 Asset）→ 同 revision 同 asset 共享 Binding，不再是多张独立图。
 *  保留 PNG 签名（扩展名/mime 识别不受影响），尾部追加唯一 marker。 */
function pngBytesWithMarker(marker) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const markerBytes = Buffer.alloc(4);
  markerBytes.writeUInt32BE(marker, 0);
  return Buffer.concat([signature, markerBytes]);
}

function count(database, table, where = '', params = []) {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}${where ? ` WHERE ${where}` : ''}`).get(...params).count);
}

// ============ 1. migration 69：region_json 列 ============

test('WMB-5245 migration v69: knowledge_visual_runs.region_json nullable column exists', async () => {
  const root = await makeRoot();
  const { database } = await makeDatabase(root);
  const applied = new Set(database.prepare('SELECT version FROM schema_migrations').all().map((row) => Number(row.version)));
  assert.ok(applied.has(69), 'migration v69 必须已应用');
  const columns = database.prepare('PRAGMA table_info(knowledge_visual_runs)').all().map((row) => row.name);
  assert.ok(columns.includes('region_json'), 'region_json 列必须存在');
  assert.ok(columns.includes('observation_json'), '既有列必须保留');
  database.close();
});

// ============ 2. region locator：严格解析 + 旧兼容 + 非法 fail-closed ============

test('WMB-5245 region locator: old locator parses with region null; region locator round-trips; invalid region fails closed', () => {
  const assetId = randomUUID();
  const region = Object.freeze({ x: 0.1, y: 0.2, width: 0.5, height: 0.3 });

  // 旧格式（整图）逐字兼容
  const oldLocator = visualEvidenceLocator(assetId, 'source:rev-1');
  assert.equal(oldLocator, `asset:${assetId}|sourceRevision:source:rev-1`);
  assert.deepEqual(parseVisualEvidenceLocator(oldLocator), { assetId, sourceRevisionId: 'source:rev-1', region: null });

  // 区域格式
  const regionLocator = visualEvidenceLocator(assetId, 'source:rev-1', region);
  assert.equal(regionLocator, `asset:${assetId}|sourceRevision:source:rev-1|region={0.1,0.2,0.5,0.3}`);
  assert.deepEqual(parseVisualEvidenceLocator(regionLocator), { assetId, sourceRevisionId: 'source:rev-1', region });

  // 非法 region：入队构造抛错
  assert.throws(() => visualEvidenceLocator(assetId, 'r', { x: -0.1, y: 0, width: 0.5, height: 0.3 }), (e) => e.code === 'REGION_INVALID');
  assert.throws(() => visualEvidenceLocator(assetId, 'r', { x: 0, y: 0, width: 1.5, height: 0.3 }), (e) => e.code === 'REGION_INVALID');
  assert.throws(() => visualEvidenceLocator(assetId, 'r', { x: 0, y: 0, width: 0.5, height: 0.3, extra: 1 }), (e) => e.code === 'REGION_INVALID');
  assert.throws(() => visualEvidenceLocator(assetId, 'r', { x: 0.6, y: 0, width: 0.6, height: 0.3 }), (e) => e.code === 'REGION_INVALID'); // x+width>1

  // 非法 region 解析 → null（fail-closed）
  for (const bad of [
    `asset:${assetId}|sourceRevision:r|region={-0.1,0.2,0.5,0.3}`,
    `asset:${assetId}|sourceRevision:r|region={0.1,0.2,1.5,0.3}`,
    `asset:${assetId}|sourceRevision:r|region={0.1,0.2,0.5}`,
    `asset:${assetId}|sourceRevision:r|region={0.1,0.2,0.5,0.3,0.9}`,
    `asset:${assetId}|sourceRevision:r|region={0.1,abc,0.5,0.3}`,
    `asset:${assetId}|sourceRevision:r|region={0.1,0.2,0.5,0.3`,
    `asset:${assetId}|sourceRevision:r|region={,0.2,0.5,0.3}`,
    `asset:${assetId}|sourceRevision:r|region={0.1,,0.5,0.3}`,
    `asset:${assetId}|sourceRevision:r|region={0.1,0.2,0.5,}`,
    `asset:${assetId}|sourceRevision:r|region={NaN,0.2,0.5,0.3}`,
    `asset:${assetId}|sourceRevision:r|region={Infinity,0.2,0.5,0.3}`,
    `asset:${assetId}|sourceRevision:r|region={0.1,0.2,0.5,0.3}|extra`,
    `asset:${assetId}|sourceRevision:r|timeRange:0-100`
  ]) {
    assert.equal(parseVisualEvidenceLocator(bad), null, `invalid region locator must be null: ${bad}`);
  }
});

// ============ 3. 入队 region：run 携带 region；非法 fail-closed ============

test('WMB-5245 enqueue with region: run stores region; invalid region rejects; identity key excludes region', async () => {
  const root = await makeRoot();
  const { database } = await makeDatabase(root);
  const source = seedSource(database, '区域入队-资料');
  const imagePath = await writeImage(root);
  const { asset } = await ensureSourceImageAsset(database, root, { sourceId: source.id, image: { kind: 'local', localPath: imagePath } });

  const region = Object.freeze({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
  const { run, created } = enqueueVisualRun(database, {
    sourceId: source.id,
    sourceRevisionId: 'source:r1',
    assetId: asset.id,
    region
  });
  assert.equal(created, true);
  assert.equal(run.region.x, 0.25);
  assert.equal(run.schemaVersion, VISUAL_SCHEMA_VERSION);
  const reread = getVisualRun(database, run.id);
  assert.deepEqual(reread.region, region);

  // 非法 region → fail-closed（零写入）
  assert.throws(() => enqueueVisualRun(database, {
    sourceId: source.id, sourceRevisionId: 'source:r2', assetId: asset.id,
    region: { x: 2, y: 0, width: 0.5, height: 0.5 }
  }), (e) => e instanceof VisualSourceError && e.code === 'REGION_INVALID');
  assert.equal(count(database, 'knowledge_visual_runs'), 1);

  // 整图 run 与区域 run：identity 键（source/revision/asset/schemaVersion）相同 → 幂等（设计 §9 键不含 region）
  const whole = enqueueVisualRun(database, { sourceId: source.id, sourceRevisionId: 'source:r1', assetId: asset.id });
  assert.equal(whole.created, false);
  assert.equal(whole.run.id, run.id);
  assert.equal(count(database, 'knowledge_visual_runs'), 1);
  database.close();
});

// ============ 4. preserved 图片自动入队：一次 + ≤12 上限 + 超限保持未理解 ============

test('WMB-5245 auto-enqueue: preserved image enqueues once (reuse binding asset, no re-download); >12 stay saved-but-unprocessed', async () => {
  const root = await makeRoot();
  const { database } = await makeDatabase(root);
  const source = seedSource(database, '自动入队-资料');
  const revisionKey = `source:${source.id}:r${source.revision}`;

  // 构造 14 个 preserved 图片 binding + 各自 asset
  const assets = [];
  const bindings = [];
  for (let ordinal = 0; ordinal < 14; ordinal += 1) {
    const imagePath = await writeImage(root, `img-${ordinal}.png`, pngBytesWithMarker(ordinal));
    const { asset } = await ensureSourceImageAsset(database, root, { sourceId: source.id, image: { kind: 'local', localPath: imagePath } });
    assets.push(asset);
    const originalUrl = `https://example.com/img-${ordinal}.png`;
    const discoveredAt = new Date().toISOString();
    const inserted = insertMediaCandidates(database, {
      sourceId: source.id,
      sourceRevisionKey: revisionKey,
      channel: 'x_lists',
      requestId: `t-${ordinal}`,
      discoveredAt,
      candidates: [{ kind: 'image', originalUrl, ordinal, captionHint: null, surroundingText: null }]
    });
    const candidateId = inserted.candidateIds[0];
    const binding = completeMediaCandidatePreserved(database, {
      candidateId,
      sourceId: source.id,
      sourceRevisionKey: revisionKey,
      assetId: asset.id,
      sha256: '0'.repeat(64),
      capturedAt: discoveredAt,
      kind: 'image',
      ordinal,
      originalUrl,
      createdBy: 'test',
      requestId: `t-${ordinal}`
    });
    bindings.push(binding);
  }
  assert.equal(count(database, 'source_media_bindings'), 14);
  assert.equal(count(database, 'knowledge_visual_runs'), 0, '入队前零 run');

  // 逐个 hook 式入队：前 12 张自动入队，第 13/14 张超限跳过
  let enqueuedRuns = 0;
  for (const binding of bindings) {
    const result = enqueuePreservedSourceImage(database, {
      sourceId: source.id,
      sourceRevisionKey: revisionKey,
      assetId: binding.assetId,
      kind: binding.kind
    });
    if (result.enqueued) enqueuedRuns += 1;
  }
  assert.equal(enqueuedRuns, VISUAL_AUTO_ENQUEUE_LIMIT);
  assert.equal(count(database, 'knowledge_visual_runs'), VISUAL_AUTO_ENQUEUE_LIMIT);

  // 再次全量 hook：幂等零新增
  for (const binding of bindings) {
    enqueuePreservedSourceImage(database, {
      sourceId: source.id,
      sourceRevisionKey: revisionKey,
      assetId: binding.assetId,
      kind: binding.kind
    });
  }
  assert.equal(count(database, 'knowledge_visual_runs'), VISUAL_AUTO_ENQUEUE_LIMIT, '重复 hook 零新增（自动入队一次）');

  // 读模型：14 preserved，12 autoEnqueued，2 unprocessed（已保存、尚未理解）
  const status = readSourceRevisionVisualStatus(database, revisionKey, source.id);
  assert.equal(status.preservedImages, 14);
  assert.equal(status.autoEnqueued, 12);
  assert.equal(status.unprocessed, 2);
  assert.equal(status.limit, VISUAL_AUTO_ENQUEUE_LIMIT);
  const unprocessed = status.items.filter((item) => item.status === 'unprocessed');
  assert.equal(unprocessed.length, 2);
  assert.deepEqual(unprocessed.map((item) => item.ordinal).sort(), [12, 13]);
  assert.equal(unprocessed.every((item) => item.run === null), true, '超限图片 run 为 null（未理解）');
  database.close();
});

// ============ 5. 批量自动入队（autoEnqueuePreservedSourceImages 幂等补齐） ============

test('WMB-5245 autoEnqueuePreservedSourceImages: bounded batch fills missing runs; excess stays unprocessed', async () => {
  const root = await makeRoot();
  const { database } = await makeDatabase(root);
  const source = seedSource(database, '批量入队-资料');
  const revisionKey = `source:${source.id}:r${source.revision}`;

  for (let ordinal = 0; ordinal < 5; ordinal += 1) {
    const imagePath = await writeImage(root, `batch-${ordinal}.png`, pngBytesWithMarker(ordinal));
    const { asset } = await ensureSourceImageAsset(database, root, { sourceId: source.id, image: { kind: 'local', localPath: imagePath } });
    const discoveredAt = new Date().toISOString();
    const inserted = insertMediaCandidates(database, {
      sourceId: source.id,
      sourceRevisionKey: revisionKey,
      channel: 'research',
      requestId: `b-${ordinal}`,
      discoveredAt,
      candidates: [{ kind: 'image', originalUrl: `https://example.com/batch-${ordinal}.png`, ordinal, captionHint: null, surroundingText: null }]
    });
    completeMediaCandidatePreserved(database, {
      candidateId: inserted.candidateIds[0],
      sourceId: source.id,
      sourceRevisionKey: revisionKey,
      assetId: asset.id,
      sha256: '0'.repeat(64),
      capturedAt: discoveredAt,
      kind: 'image',
      ordinal,
      originalUrl: `https://example.com/batch-${ordinal}.png`,
      createdBy: 'test',
      requestId: `b-${ordinal}`
    });
  }

  const first = autoEnqueuePreservedSourceImages(database, { sourceId: source.id, sourceRevisionKey: revisionKey });
  assert.equal(first.enqueued.length, 5);
  assert.equal(first.skippedLimit, 0);
  assert.equal(count(database, 'knowledge_visual_runs'), 5);

  const second = autoEnqueuePreservedSourceImages(database, { sourceId: source.id, sourceRevisionKey: revisionKey });
  assert.equal(second.enqueued.length, 5, '幂等：补齐不重复');
  assert.equal(count(database, 'knowledge_visual_runs'), 5);
  database.close();
});

// ============ 6. attempt 历史读模型 ============

test('WMB-5245 listVisualRunAttempts: full attempt history per identity; old rows preserved', async () => {
  const root = await makeRoot();
  const { database } = await makeDatabase(root);
  const source = seedSource(database, '历史-资料');
  const imagePath = await writeImage(root);
  const { asset } = await ensureSourceImageAsset(database, root, { sourceId: source.id, image: { kind: 'local', localPath: imagePath } });

  const { run } = enqueueVisualRun(database, { sourceId: source.id, sourceRevisionId: 'source:h1', assetId: asset.id });
  await executeVisualRun(database, run.id, {
    dataRoot: root,
    modelCall: async () => '```json\n{"wmb_visual_observation":{"reason":"r","items":[]}}\n```'
  }).then((completed) => assert.equal(completed.status, 'completed'));

  // 失败一次再重试：attempt 1 completed → retry 幂等（不产生新行）；用新 revision 产生 failed→retry
  const failedRun = enqueueVisualRun(database, { sourceId: source.id, sourceRevisionId: 'source:h2', assetId: asset.id });
  await executeVisualRun(database, failedRun.run.id, { dataRoot: root, modelCall: async () => { throw new Error('boom'); } });
  const retried = retryVisualRun(database, failedRun.run.id);
  assert.equal(retried.run.attempt, 2);

  const history = listVisualRunAttempts(database, {
    sourceId: source.id, sourceRevisionId: 'source:h2', assetId: asset.id, schemaVersion: VISUAL_SCHEMA_VERSION
  });
  assert.equal(history.length, 2);
  assert.deepEqual(history.map((row) => row.attempt), [1, 2]);
  assert.equal(history[0].status, 'failed');
  assert.equal(history[0].errorCode, 'MODEL_CALL_FAILED');
  assert.equal(history[1].status, 'queued');
  database.close();
});

// ============ 7. completed 不可变（含 region run） ============

test('WMB-5245 completed run immutable: app guard + DB trigger reject UPDATE; region run included', async () => {
  const root = await makeRoot();
  const { database } = await makeDatabase(root);
  const source = seedSource(database, '不可变-资料');
  const imagePath = await writeImage(root);
  const { asset } = await ensureSourceImageAsset(database, root, { sourceId: source.id, image: { kind: 'local', localPath: imagePath } });

  const { run } = enqueueVisualRun(database, {
    sourceId: source.id,
    sourceRevisionId: 'source:imm',
    assetId: asset.id,
    region: { x: 0, y: 0, width: 0.5, height: 0.5 }
  });
  const completed = await executeVisualRun(database, run.id, {
    dataRoot: root,
    modelCall: async () => '```json\n{"wmb_visual_observation":{"reason":"r","items":[]}}\n```'
  });
  assert.equal(completed.status, 'completed');
  assert.throws(() => {
    database.prepare(`UPDATE knowledge_visual_runs SET observation_json = '{}' WHERE id = ?`).run(completed.id);
  }, /VISUAL_RUN_COMPLETED_IMMUTABLE|completed/i);
  const reread = getVisualRun(database, completed.id);
  assert.equal(reread.status, 'completed');
  assert.deepEqual(reread.region, { x: 0, y: 0, width: 0.5, height: 0.5 });
  database.close();
});

// ============ 8. 完成 region run → 知识候选 locator 携带 region ============

test('WMB-5245 completed region run → visualRunToKnowledgeInput locator carries region; whole-image locator stays old', async () => {
  const root = await makeRoot();
  const { database, workspaceId } = await makeDatabase(root);
  const source = seedSource(database, '区域知识-资料');
  const imagePath = await writeImage(root);
  const { asset } = await ensureSourceImageAsset(database, root, { sourceId: source.id, image: { kind: 'local', localPath: imagePath } });
  const { upsertKnowledgeTopic } = await import('../src/main/knowledge.ts');
  const topic = await upsertKnowledgeTopic(database, { title: '区域主题' });

  const region = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
  const { run } = enqueueVisualRun(database, {
    sourceId: source.id, sourceRevisionId: `source:${source.id}:r${source.revision}`, assetId: asset.id, region
  });
  await executeVisualRun(database, run.id, {
    dataRoot: root,
    modelCall: async () => '```json\n{"wmb_visual_observation":{"reason":"图表区域","items":[{"kind":"claim","canonicalKey":"chart-trend","statement":"曲线上升","excerpt":"x 轴 2026 年段上升","valueRationale":"可核对"}]}}\n```'
  });
  const result = visualRunToKnowledgeInput(database, run.id, { workspaceId, topicId: topic.id });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const note = result.plan.notes[0];
  const parsed = parseVisualEvidenceLocator(note.locator);
  assert.deepEqual(parsed, { assetId: asset.id, sourceRevisionId: `source:${source.id}:r${source.revision}`, region });
  database.close();
});
