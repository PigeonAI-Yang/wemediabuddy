// WMB-5237：网页/本地图片可追溯视觉理解管线（visual source lineage）聚焦测试。
// 覆盖（合同逐项）：迁移建表；入队身份（sourceId + sourceRevisionId + assetId + schemaVersion）；
// 同一三元组 + schemaVersion 幂等；不同 sourceRevisionId 产生新 run；失败保留错误可审计/重试
// （新 attempt 行、旧行保留、绝不伪造 observation）；执行成功输出不可变（model/provider/prompt
// 版本/observation/createdAt；DB 触发器禁改 completed 行）；模型不可用/解析失败 → 真实 failed；
// 网页远程图与本地图片统一落 asset；locator 绑定 assetId + sourceRevisionId（可解析回血缘）；
// completed run → compileSourceKnowledge 实编译，Evidence locator 含完整三段血缘。
// 运行（本批次不执行；由 Main 统一验证）：node --test --test-concurrency=1 tests/wmb-5237-visual-source-lineage.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { upsertSource } = await import('../src/main/sources.ts');
const { upsertKnowledgeTopic } = await import('../src/main/knowledge.ts');
const {
  VISUAL_OBSERVATION_MANIFEST_KEY,
  VISUAL_SCHEMA_VERSION,
  VISUAL_PROMPT_VERSION,
  enqueueVisualRun,
  getVisualRun,
  getLatestVisualRun,
  listVisualRuns,
  retryVisualRun,
  markVisualRunRunning,
  markVisualRunCompleted,
  markVisualRunFailed,
  executeVisualRun,
  ensureSourceImageAsset,
  visualEvidenceLocator,
  parseVisualEvidenceLocator,
  visualRunToKnowledgeInput,
  compileVisualRunKnowledge,
  visualRunPlanHash,
  VisualSourceError
} = await import('../src/main/visual-source-lineage.ts');

// ============ fixtures / helpers ============

async function makeRoot(prefix = 'wmb-5237-') {
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

async function seedTopic(database, title) {
  return upsertKnowledgeTopic(database, { title });
}

async function writeImage(root, fileName = 'shot.png', bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
  const filePath = path.join(root, fileName);
  await writeFile(filePath, bytes);
  return filePath;
}

function fenced(manifest) {
  return `\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\``;
}

function observationManifest({ items = null } = {}) {
  return {
    [VISUAL_OBSERVATION_MANIFEST_KEY]: {
      reason: 'fixture 视觉观察。',
      items: items ?? [
        { kind: 'claim', canonicalKey: 'vc-gpu-count', statement: '图中展示 8 块 GPU。', excerpt: '画面中央可见 8 块 GPU 模组。', valueRationale: '硬件规格可独立验证。' },
        { kind: 'insight', canonicalKey: 'vc-layout', statement: '机架布局为两列对称。', excerpt: '机架左右两列对称排列。', valueRationale: '影响后续布点判断。' }
      ]
    }
  };
}

/** 脚本化模型：成功返回确定性 manifest；fail 集合内 runId 抛错（模拟模型不可用）。 */
function modelOf({ bad = new Set() } = {}) {
  return async ({ imagePath, imageMimeType }) => {
    if (bad.has(imagePath)) throw new Error('VISION_MODEL_UNAVAILABLE');
    if (!imageMimeType.startsWith('image/')) throw new Error(`unexpected mime ${imageMimeType}`);
    return fenced(observationManifest());
  };
}

function stubFetch({ ok = true, status = 200, contentType = 'image/png', body = Buffer.from([0x89, 0x50, 0x4e, 0x47]) } = {}) {
  return async () => ({
    ok,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => new Uint8Array(body).buffer
  });
}

function count(database, table, where = '', params = []) {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}${where ? ` WHERE ${where}` : ''}`).get(...params).count);
}

async function seedCompletedRun(root, { revisionId = 'rev:fixture-1' } = {}) {
  const { database, workspaceId } = await makeDatabase(root);
  const source = seedSource(database, `视觉资料-${randomUUID().slice(0, 8)}`);
  const imagePath = await writeImage(root);
  const { asset } = await ensureSourceImageAsset(database, root, { sourceId: source.id, image: { kind: 'local', localPath: imagePath } });
  const { run } = enqueueVisualRun(database, { sourceId: source.id, sourceRevisionId: revisionId, assetId: asset.id });
  const completed = await executeVisualRun(database, run.id, { dataRoot: root, modelCall: modelOf() });
  return { database, workspaceId, source, asset, run: completed };
}

// ============ 1. 迁移建表 ============

test('WMB-5237 migration v59: knowledge_visual_runs with unique key and completed-immutable trigger', async () => {
  const root = await makeRoot();
  const { database } = await makeDatabase(root);
  const applied = new Set(database.prepare('SELECT version FROM schema_migrations').all().map((row) => Number(row.version)));
  assert.ok(applied.has(59), 'migration v59 必须已应用');
  const columns = database.prepare('PRAGMA table_info(knowledge_visual_runs)').all().map((row) => row.name);
  for (const name of ['id', 'source_id', 'source_revision_id', 'asset_id', 'schema_version', 'attempt', 'status',
    'model', 'provider', 'prompt_version', 'observation_json', 'error_code', 'error_message', 'created_at', 'started_at', 'completed_at']) {
    assert.ok(columns.includes(name), `列 ${name} 必须存在`);
  }
  const triggers = database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='knowledge_visual_runs'").all();
  assert.ok(triggers.some((row) => row.name === 'knowledge_visual_runs_completed_immutable'), 'completed 不可变触发器必须存在');
  database.close();
});

// ============ 2. 入队身份 ============

test('WMB-5237 enqueue: queued run carries full triple identity + defaults; rejects invalid inputs', async () => {
  const root = await makeRoot();
  const { database } = await makeDatabase(root);
  const source = seedSource(database, '入队-资料');
  const imagePath = await writeImage(root);
  const { asset } = await ensureSourceImageAsset(database, root, { sourceId: source.id, image: { kind: 'local', localPath: imagePath } });

  const { run, created } = enqueueVisualRun(database, {
    sourceId: source.id,
    sourceRevisionId: 'rev:enqueue-1',
    assetId: asset.id
  });
  assert.equal(created, true);
  assert.equal(run.status, 'queued');
  assert.equal(run.sourceId, source.id);
  assert.equal(run.sourceRevisionId, 'rev:enqueue-1');
  assert.equal(run.assetId, asset.id);
  assert.equal(run.schemaVersion, VISUAL_SCHEMA_VERSION);
  assert.equal(run.attempt, 1);
  assert.equal(run.promptVersion, VISUAL_PROMPT_VERSION);
  assert.equal(run.model, 'mimo-v2.5'); // WMB_VISION_MODEL 复用
  assert.equal(run.provider, 'wmb-api');
  assert.equal(run.observation, null);
  assert.equal(run.errorCode, null);
  assert.equal(run.errorMessage, null);
  assert.equal(run.completedAt, null);

  assert.throws(() => enqueueVisualRun(database, { sourceId: 'missing-source', sourceRevisionId: 'rev-1', assetId: asset.id }),
    (error) => error instanceof VisualSourceError && error.code === 'SOURCE_NOT_FOUND');
  assert.throws(() => enqueueVisualRun(database, { sourceId: source.id, sourceRevisionId: 'rev-1', assetId: 'missing-asset' }),
    (error) => error instanceof VisualSourceError && error.code === 'ASSET_NOT_FOUND');
  assert.throws(() => enqueueVisualRun(database, { sourceId: source.id, sourceRevisionId: '', assetId: asset.id }),
    (error) => error instanceof VisualSourceError && error.code === 'INPUT_INVALID');
  database.close();
});

// ============ 3. 幂等 / 不同 revision / 不同 schema 版本 ============

test('WMB-5237 idempotency: same triple + schemaVersion returns same run; new revision or schemaVersion creates new run', async () => {
  const root = await makeRoot();
  const { database } = await makeDatabase(root);
  const source = seedSource(database, '幂等-资料');
  const imagePath = await writeImage(root);
  const { asset } = await ensureSourceImageAsset(database, root, { sourceId: source.id, image: { kind: 'local', localPath: imagePath } });

  const first = enqueueVisualRun(database, { sourceId: source.id, sourceRevisionId: 'rev:same', assetId: asset.id });
  const second = enqueueVisualRun(database, { sourceId: source.id, sourceRevisionId: 'rev:same', assetId: asset.id });
  assert.equal(first.run.id, second.run.id);
  assert.equal(second.created, false);
  assert.equal(count(database, 'knowledge_visual_runs'), 1);

  // 不同 source revision → 新 run
  const otherRevision = enqueueVisualRun(database, { sourceId: source.id, sourceRevisionId: 'rev:different', assetId: asset.id });
  assert.notEqual(otherRevision.run.id, first.run.id);
  assert.equal(otherRevision.created, true);

  // 不同 schemaVersion → 新 run（默认 2；3 作为不同版本）
  const otherSchema = enqueueVisualRun(database, { sourceId: source.id, sourceRevisionId: 'rev:same', assetId: asset.id, schemaVersion: 3 });
  assert.notEqual(otherSchema.run.id, first.run.id);
  assert.equal(otherSchema.created, true);
  assert.equal(otherSchema.run.schemaVersion, 3);
  assert.equal(count(database, 'knowledge_visual_runs'), 3);
  database.close();
});

// ============ 4. 失败审计 / 重试（新 attempt 行；旧行保留；绝不伪造） ============

test('WMB-5237 failure & retry: model unavailable → real failed with error, no fake observation; retry creates attempt 2', async () => {
  const root = await makeRoot();
  const { database } = await makeDatabase(root);
  const source = seedSource(database, '失败重试-资料');
  const imagePath = await writeImage(root);
  const { asset } = await ensureSourceImageAsset(database, root, { sourceId: source.id, image: { kind: 'local', localPath: imagePath } });
  const { run } = enqueueVisualRun(database, { sourceId: source.id, sourceRevisionId: 'rev:fail-1', assetId: asset.id });

  const failed = await executeVisualRun(database, run.id, { dataRoot: root, modelCall: modelOf({ bad: new Set([path.join(root, asset.relativePath)]) }) });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'MODEL_CALL_FAILED');
  assert.match(failed.errorMessage, /VISION_MODEL_UNAVAILABLE/);
  assert.equal(failed.observation, null, '模型不可用绝不伪造 observation');

  // 无 retry 的重复入队：幂等返回 failed 行（不自动刷 attempt）
  const again = enqueueVisualRun(database, { sourceId: source.id, sourceRevisionId: 'rev:fail-1', assetId: asset.id });
  assert.equal(again.run.id, run.id);
  assert.equal(again.created, false);
  assert.equal(count(database, 'knowledge_visual_runs'), 1);

  // 显式 retry：新 attempt=2 行，旧 failed 行保留审计
  const retried = retryVisualRun(database, run.id);
  assert.equal(retried.created, true);
  assert.equal(retried.run.attempt, 2);
  assert.notEqual(retried.run.id, run.id);
  assert.equal(retried.run.status, 'queued');
  assert.equal(count(database, 'knowledge_visual_runs'), 2);
  const old = getVisualRun(database, run.id);
  assert.equal(old.status, 'failed');
  assert.equal(old.errorCode, 'MODEL_CALL_FAILED');
  database.close();
});

// ============ 5. 执行成功：输出不可变 ============

test('WMB-5237 execute success: completed run stores model/provider/promptVersion/observation/createdAt; immutable via app guard + DB trigger', async () => {
  const root = await makeRoot();
  const { database } = await makeDatabase(root);
  const source = seedSource(database, '成功-资料');
  const imagePath = await writeImage(root);
  const { asset } = await ensureSourceImageAsset(database, root, { sourceId: source.id, image: { kind: 'local', localPath: imagePath } });
  const { run } = enqueueVisualRun(database, { sourceId: source.id, sourceRevisionId: 'rev:ok-1', assetId: asset.id });

  const completed = await executeVisualRun(database, run.id, { dataRoot: root, modelCall: modelOf(), model: 'vision-probe', provider: 'probe-provider' });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.model, 'vision-probe');
  assert.equal(completed.provider, 'probe-provider');
  assert.equal(completed.promptVersion, VISUAL_PROMPT_VERSION);
  assert.ok(completed.startedAt && completed.completedAt);
  assert.ok(completed.createdAt <= completed.startedAt && completed.startedAt <= completed.completedAt);
  assert.ok(completed.observation, '成功必须保存结构化 observation');
  assert.equal(completed.observation.items.length, 2);
  assert.deepEqual(completed.observation.items.map((item) => item.canonicalKey), ['vc-gpu-count', 'vc-layout']);
  assert.equal(completed.errorCode, null);

  // 应用层状态门：completed 不可再转
  assert.throws(() => markVisualRunCompleted(database, run.id, { model: 'x', provider: 'x', promptVersion: 1, observation: completed.observation }),
    (error) => error.code === 'VISUAL_RUN_STATUS_INVALID');
  assert.throws(() => markVisualRunFailed(database, run.id, { errorCode: 'X', errorMessage: 'y' }),
    (error) => error.code === 'VISUAL_RUN_STATUS_INVALID');
  await assert.rejects(() => executeVisualRun(database, run.id, { dataRoot: root, modelCall: modelOf() }),
    (error) => error.code === 'VISUAL_RUN_STATUS_INVALID');

  // DB 触发器：completed 行禁止任何 UPDATE
  assert.throws(() => database.prepare("UPDATE knowledge_visual_runs SET status = 'running' WHERE id = ?").run(run.id),
    /VISUAL_RUN_COMPLETED_IMMUTABLE/);
  database.close();
});

// ============ 6. 解析失败 fail-closed ============

test('WMB-5237 execute parse failure: garbage / unknown key / multiple manifests → failed OBSERVATION_PARSE_FAILED, zero fabrication', async () => {
  const cases = [
    '这不是 JSON',
    fenced({ [VISUAL_OBSERVATION_MANIFEST_KEY]: { reason: 'r', items: [{ kind: 'claim', canonicalKey: 'k', statement: 's', excerpt: 'e', valueRationale: 'v', surprise: true }] } }),
    `${fenced(observationManifest())}\n${fenced(observationManifest())}`
  ];
  for (const badText of cases) {
    const root = await makeRoot();
    const { database } = await makeDatabase(root);
    const source = seedSource(database, `解析失败-${randomUUID().slice(0, 6)}`);
    const imagePath = await writeImage(root, `img-${randomUUID().slice(0, 6)}.png`);
    const { asset } = await ensureSourceImageAsset(database, root, { sourceId: source.id, image: { kind: 'local', localPath: imagePath } });
    const { run } = enqueueVisualRun(database, { sourceId: source.id, sourceRevisionId: `rev:bad-${randomUUID()}`, assetId: asset.id });
    const failed = await executeVisualRun(database, run.id, {
      dataRoot: root,
      modelCall: async () => badText
    });
    assert.equal(failed.status, 'failed', `bad text must fail: ${badText.slice(0, 40)}`);
    assert.equal(failed.errorCode, 'OBSERVATION_PARSE_FAILED');
    assert.ok(failed.errorMessage.length > 0);
    assert.equal(failed.observation, null);
    database.close();
  }
});

// ============ 7. 本地图片落 asset（去重） ============

test('WMB-5237 ensureSourceImageAsset local: imports file as asset; sha256 reuse; non-image rejected', async () => {
  const root = await makeRoot();
  const { database } = await makeDatabase(root);
  const source = seedSource(database, '本地图-资料');
  const imagePath = await writeImage(root);
  const first = await ensureSourceImageAsset(database, root, { sourceId: source.id, image: { kind: 'local', localPath: imagePath } });
  assert.equal(first.imported, true);
  assert.ok(first.asset.id);
  assert.equal(first.asset.mimeType, 'image/png');
  assert.equal(first.asset.origin, `source-visual:${source.id}`);
  const second = await ensureSourceImageAsset(database, root, { sourceId: source.id, image: { kind: 'local', localPath: imagePath } });
  assert.equal(second.imported, false);
  assert.equal(second.asset.id, first.asset.id, 'sha256 去重复用同一 asset');
  assert.equal(count(database, 'assets'), 1);

  const textPath = path.join(root, 'note.txt');
  await writeFile(textPath, 'not an image');
  await assert.rejects(() => ensureSourceImageAsset(database, root, { sourceId: source.id, image: { kind: 'local', localPath: textPath } }),
    (error) => error instanceof VisualSourceError && error.code === 'ASSET_NOT_IMAGE');
  database.close();
});

// ============ 8. 远程图片落 asset（与本地同一契约） ============

test('WMB-5237 ensureSourceImageAsset remote: fetches bytes → asset; HTTP failure → typed error, zero rows', async () => {
  const root = await makeRoot();
  const { database } = await makeDatabase(root);
  const source = seedSource(database, '远程图-资料');
  const remote = await ensureSourceImageAsset(database, root, {
    sourceId: source.id,
    image: { kind: 'remote', url: 'https://example.com/a/b.png' },
    fetchImpl: stubFetch()
  });
  assert.equal(remote.imported, true);
  assert.equal(remote.asset.mimeType, 'image/png');
  assert.equal(remote.asset.origin, `source-visual:${source.id}`);
  assert.equal(count(database, 'assets'), 1);

  await assert.rejects(() => ensureSourceImageAsset(database, root, {
    sourceId: source.id,
    image: { kind: 'remote', url: 'https://example.com/404.png' },
    fetchImpl: stubFetch({ ok: false, status: 404 })
  }), (error) => error instanceof VisualSourceError && error.code === 'IMAGE_FETCH_FAILED' && /404/.test(error.message));
  await assert.rejects(() => ensureSourceImageAsset(database, root, {
    sourceId: source.id,
    image: { kind: 'remote', url: 'https://example.com/empty.png' },
    fetchImpl: stubFetch({ body: Buffer.alloc(0) })
  }), (error) => error instanceof VisualSourceError && error.code === 'IMAGE_FETCH_FAILED');
  assert.equal(count(database, 'assets'), 1, '失败不得写入 asset');
  assert.equal(count(database, 'knowledge_visual_runs'), 0, '失败不得创建 run');
  database.close();
});

// ============ 9. locator 血缘绑定 ============

test('WMB-5237 locator: binds assetId + sourceRevisionId; strict parse round-trip; malformed → null', () => {
  const assetId = randomUUID();
  const locator = visualEvidenceLocator(assetId, 'rev:body-42');
  assert.equal(locator, `asset:${assetId}|sourceRevision:rev:body-42`);
  assert.deepEqual(parseVisualEvidenceLocator(locator), { assetId, sourceRevisionId: 'rev:body-42', region: null });
  for (const bad of ['', 'asset:x', 'sourceRevision:y', 'asset:x|rev:y', 'x:1|y:2', `asset:${assetId}|sourceRevision:`, 'asset:|sourceRevision:r']) {
    assert.equal(parseVisualEvidenceLocator(bad), null, `malformed locator must be null: ${bad}`);
  }
  assert.throws(() => visualEvidenceLocator(assetId, 'contains|pipe'), (error) => error.code === 'LOCATOR_INVALID');
});

// ============ 10. observation → 知识候选计划（血缘 + 状态机 + 确定性） ============

test('WMB-5237 visualRunToKnowledgeInput: completed → plan with bound locator; claim→unverified, insight→inference; non-completed rejected; hash stable', async () => {
  const root = await makeRoot();
  const { database, workspaceId, source, asset, run } = await seedCompletedRun(root);
  const topic = await seedTopic(database, '视觉主题');

  const result = visualRunToKnowledgeInput(database, run.id, { workspaceId, topicId: topic.id });
  assert.equal(result.ok, true);
  const plan = result.ok ? result.plan : null;
  assert.equal(plan.sourceId, source.id);
  assert.equal(plan.sourceRevision, source.revision);
  assert.equal(plan.requestId, `visual_source:${run.id}`);
  assert.equal(plan.notes.length, 2);
  for (const note of plan.notes) {
    const parsed = parseVisualEvidenceLocator(note.locator);
    assert.deepEqual(parsed, { assetId: asset.id, sourceRevisionId: run.sourceRevisionId, region: null }, '每个候选 locator 必须绑定 assetId + sourceRevisionId');
    assert.ok(note.excerpt, '候选必须携带视觉证据 excerpt');
  }
  const byKey = new Map(plan.notes.map((note) => [note.canonicalKey, note]));
  assert.equal(byKey.get('vc-gpu-count').conclusionStatus, 'unverified');
  assert.equal(byKey.get('vc-gpu-count').evidenceLevel, 'single');
  assert.equal(byKey.get('vc-layout').conclusionStatus, 'inference');
  assert.equal(visualRunPlanHash(plan), visualRunPlanHash(plan), '同计划字节稳定');

  // 未 completed → fail-closed
  const queued = enqueueVisualRun(database, { sourceId: source.id, sourceRevisionId: 'rev:queued-1', assetId: asset.id });
  const blocked = visualRunToKnowledgeInput(database, queued.run.id, { workspaceId, topicId: topic.id });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.error.code, 'VISUAL_RUN_NOT_COMPLETED');
  database.close();
});

// ============ 11. 实编译：Evidence 落库含完整三段血缘 ============

test('WMB-5237 compileVisualRunKnowledge: authorized compile writes evidence links with asset|revision locator; replay zero increment', async () => {
  const root = await makeRoot();
  const { database, workspaceId, source, asset, run } = await seedCompletedRun(root);
  const topic = await seedTopic(database, '编译主题');

  const result = compileVisualRunKnowledge(database, run.id, { workspaceId, topicId: topic.id });
  assert.equal(result.ok, true);
  assert.equal(result.replay, false);
  assert.equal(result.counts.notesCreated, 2);
  assert.equal(result.counts.evidenceLinks, 2);

  const evidenceRows = database.prepare('SELECT evidence_object_type AS evidenceObjectType, evidence_object_id AS evidenceObjectId, locator, excerpt FROM knowledge_evidence_links').all();
  assert.equal(evidenceRows.length, 2);
  for (const row of evidenceRows) {
    assert.equal(row.evidenceObjectType, 'source');
    assert.equal(row.evidenceObjectId, source.id);
    assert.equal(row.locator, `asset:${asset.id}|sourceRevision:${run.sourceRevisionId}`);
    assert.ok(row.excerpt, '证据必须带视觉 excerpt');
    assert.equal(parseVisualEvidenceLocator(row.locator).assetId, asset.id);
    assert.equal(parseVisualEvidenceLocator(row.locator).sourceRevisionId, run.sourceRevisionId);
  }

  // 同 run 重放 → 零增量（receipt 回放原计数；DB 层不新增任何版本/证据）
  const notesBefore = count(database, 'knowledge_notes');
  const versionsBefore = count(database, 'knowledge_note_versions');
  const replay = compileVisualRunKnowledge(database, run.id, { workspaceId, topicId: topic.id });
  assert.equal(replay.ok, true);
  assert.equal(replay.replay, true);
  assert.equal(count(database, 'knowledge_notes'), notesBefore);
  assert.equal(count(database, 'knowledge_note_versions'), versionsBefore);
  assert.equal(count(database, 'knowledge_evidence_links'), 2);
  database.close();
});

// ============ 12. 状态机守卫 / 列表查询 ============

test('WMB-5237 state machine guards and list filters', async () => {
  const root = await makeRoot();
  const { database } = await makeDatabase(root);
  const source = seedSource(database, '状态机-资料');
  const imagePath = await writeImage(root);
  const { asset } = await ensureSourceImageAsset(database, root, { sourceId: source.id, image: { kind: 'local', localPath: imagePath } });
  const { run } = enqueueVisualRun(database, { sourceId: source.id, sourceRevisionId: 'rev:sm-1', assetId: asset.id });

  const running = markVisualRunRunning(database, run.id);
  assert.equal(running.status, 'running');
  assert.throws(() => markVisualRunRunning(database, run.id), (error) => error.code === 'VISUAL_RUN_STATUS_INVALID');

  const failed = markVisualRunFailed(database, run.id, { errorCode: 'E1', errorMessage: 'm1' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'E1');
  assert.equal(failed.errorMessage, 'm1');
  assert.throws(() => markVisualRunFailed(database, run.id, { errorCode: 'E2', errorMessage: 'm2' }),
    (error) => error.code === 'VISUAL_RUN_STATUS_INVALID');

  const queued2 = enqueueVisualRun(database, { sourceId: source.id, sourceRevisionId: 'rev:sm-2', assetId: asset.id });
  assert.equal(queued2.run.status, 'queued');
  assert.equal(listVisualRuns(database, { sourceId: source.id }).length, 2);
  assert.equal(listVisualRuns(database, { status: 'failed' }).length, 1);
  assert.equal(listVisualRuns(database, { status: 'queued' }).length, 1);
  assert.equal(getLatestVisualRun(database, { sourceId: source.id, sourceRevisionId: 'rev:sm-2', assetId: asset.id, schemaVersion: VISUAL_SCHEMA_VERSION }).id, queued2.run.id);
  database.close();
});
