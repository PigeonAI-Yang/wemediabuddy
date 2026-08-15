// WMB-5246：创作媒体建议服务聚焦测试（MediaRecommendations slice）。
// 覆盖（合同逐项）：
// - 迁移 68：media_recommendations 表（审计状态 proposed/accepted/rejected/superseded + UNIQUE 幂等键）；
// - splitContentClaims 确定性切分（同正文恒同输出）；
// - 引擎（固定 contentVersion + sourceRevisionKeys + completed 理解）：
//   DeepSeek fixture —— Benchmark 图 →「成绩领先」段、测试限制图 →「复现边界」段、
//   实测视频 Segment（03:18–03:46）→「真实体验」段；「竞争格局」无直接证据 → 零建议；
// - restricted 不进入自动建议；未理解媒体绝不声称其内容（零建议）；
// - unsupported/failed/无文本视频段不产生建议（不虚构）；
// - 持久化：propose 幂等重放（同 requestId+输入 → 同行）；新提案 supersede 旧 proposed；
//   已 accepted/rejected 行绝不被新提案覆盖；decide accept/reject 乐观锁 revision 冲突零写入；
// - 接受 = 独立 Studio 保存边界：accept 只记录审计状态，不写 Content/Platform Binding；
// - restricted 建议接受必须 confirmedByOwner=true。
// 运行（本批次不执行；由 Main 统一验证）：node --test --test-concurrency=1 tests/wmb-5246-media-recommendations.test.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { upsertSource } = await import('../src/main/sources.ts');
const { importAssetBytes, getAsset } = await import('../src/main/assets.ts');
const { createContentProjectWithVersion } = await import('../src/main/content.ts');
const { insertMediaCandidates, completeMediaCandidatePreserved } = await import('../src/main/db/media-archive-store.ts');
const {
  VISUAL_SCHEMA_VERSION,
  enqueueVisualRun,
  markVisualRunRunning,
  markVisualRunCompleted
} = await import('../src/main/visual-source-lineage.ts');
const {
  VIDEO_SCHEMA_VERSION
} = await import('../src/main/video-understanding.ts');
const {
  createVideoRun,
  startVideoRun,
  checkpointVideoStage,
  completeVideoRun
} = await import('../src/main/db/video-understanding-store.ts');
const { sourceRevisionKey } = await import('../src/shared/media-candidates.ts');
const {
  splitContentClaims,
  claimExcerptOf,
  MAX_RECOMMENDATIONS_PER_CLAIM,
  MEDIA_RECOMMENDATION_PURPOSE_PRIORITY
} = await import('../src/shared/media-recommendations.ts');
const {
  generateMediaRecommendations,
  proposeMediaRecommendations,
  decideMediaRecommendation,
  readMediaRecommendations,
  supersedeProposedRecommendations,
  MediaRecommendationError
} = await import('../src/main/media-recommendations.ts');

// ============ fixtures / helpers ============

async function makeRoot(prefix = 'wmb-5246-') {
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

async function addAsset(root, database, { mimeType = 'image/png', fileName = 'img.png', bytes = null, sourceId = 'fixture' } = {}) {
  const body = bytes ?? Buffer.from(`fixture-bytes-${randomUUID()}`, 'utf8');
  const imported = await importAssetBytes(database, root, { bytes: body, fileName, mimeType, origin: `source-media:${sourceId}` });
  return getAsset(database, imported.id);
}

function count(database, table, where = '', params = []) {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}${where ? ` WHERE ${where}` : ''}`).get(...params).count);
}

/** 冻结一个候选为 preserved 绑定（设计 §6.3：Binding 存在才叫 preserved）。 */
function preserveCandidate(database, input) {
  const candidate = input.candidateIds[0];
  completeMediaCandidatePreserved(database, {
    candidateId: candidate,
    sourceId: input.sourceId,
    sourceRevisionKey: input.revisionKey,
    assetId: input.asset.id,
    sha256: input.asset.sha256,
    capturedAt: new Date().toISOString(),
    kind: input.kind,
    ordinal: input.ordinal,
    originalUrl: `https://example.com/media-${input.ordinal}`,
    caption: input.caption ?? null,
    rightsStatus: input.rightsStatus ?? 'unknown',
    riskFlags: input.riskFlags ?? [],
    createdBy: 'test'
  });
}

async function seedBinding(root, database, { sourceId, revisionKey, kind, ordinal, rightsStatus = 'unknown', riskFlags = [], caption = null, mimeType, fileName, bytes = null }) {
  const asset = await addAsset(root, database, { mimeType, fileName, bytes, sourceId });
  const inserted = insertMediaCandidates(database, {
    sourceId,
    sourceRevisionKey: revisionKey,
    channel: 'research',
    requestId: `req-${randomUUID()}`,
    discoveredAt: new Date().toISOString(),
    candidates: [{ kind, originalUrl: `https://example.com/media-${ordinal}`, ordinal, captionHint: caption }]
  });
  preserveCandidate(database, {
    candidateIds: inserted.candidateIds,
    sourceId,
    revisionKey,
    asset,
    kind,
    ordinal,
    caption,
    rightsStatus,
    riskFlags
  });
  return { asset, candidateId: inserted.candidateIds[0] };
}

/** DeepSeek fixture：一个含 Benchmark 图、测试限制图、实测视频的 Source revision。 */
async function seedDeepSeekSource(root, database, { withRestricted = false } = {}) {
  const source = seedSource(database, 'DeepSeek-V4-Pro 基准测试发布');
  const revisionKey = sourceRevisionKey(source.id, 1);

  // Benchmark 总表图（未理解先占位，随后由理解测试补充 run；此处为已完成理解版本）。
  const benchmark = await seedBinding(root, database, {
    sourceId: source.id, revisionKey, kind: 'image', ordinal: 0,
    mimeType: 'image/png', fileName: 'benchmark.png', caption: 'Benchmark 总分对比'
  });
  const limitations = await seedBinding(root, database, {
    sourceId: source.id, revisionKey, kind: 'image', ordinal: 1,
    mimeType: 'image/png', fileName: 'limitations.png', caption: '测试限制说明'
  });
  const video = await seedBinding(root, database, {
    sourceId: source.id, revisionKey, kind: 'video', ordinal: 2,
    mimeType: 'video/mp4', fileName: 'demo.mp4', caption: '实测视频'
  });
  return { source, revisionKey, benchmark, limitations, video };
}

/** 完成 Benchmark 图理解（观察：总分对比、成绩领先）。 */
function completeBenchmarkRun(database, source, revisionKey, asset) {
  const { run } = enqueueVisualRun(database, {
    sourceId: source.id, sourceRevisionId: revisionKey, assetId: asset.id, schemaVersion: VISUAL_SCHEMA_VERSION
  });
  markVisualRunRunning(database, run.id);
  markVisualRunCompleted(database, run.id, {
    model: 'fixture-vision', provider: 'wmb-api', promptVersion: 1,
    observation: {
      reason: 'Benchmark 图表观察。',
      items: [
        {
          kind: 'claim', canonicalKey: 'benchmark-score-lead', statement: 'Benchmark 总分对比显示 DeepSeek-V4-Pro 成绩领先',
          excerpt: '总分柱状图，DeepSeek-V4-Pro 位列第一', valueRationale: '直接证据'
        }
      ]
    }
  });
}

/** 完成测试限制图理解（观察：单次运行、复现边界）。 */
function completeLimitationsRun(database, source, revisionKey, asset) {
  const { run } = enqueueVisualRun(database, {
    sourceId: source.id, sourceRevisionId: revisionKey, assetId: asset.id, schemaVersion: VISUAL_SCHEMA_VERSION
  });
  markVisualRunRunning(database, run.id);
  markVisualRunCompleted(database, run.id, {
    model: 'fixture-vision', provider: 'wmb-api', promptVersion: 1,
    observation: {
      reason: '测试限制截图观察。',
      items: [
        {
          kind: 'claim', canonicalKey: 'benchmark-limitation', statement: '测试限制说明：单次运行存在复现边界',
          excerpt: '截图注明仅单次运行，复现边界受环境限制', valueRationale: '边界说明'
        }
      ]
    }
  });
}

/** 完成实测视频理解：03:18–03:46 段摘要为真实体验。 */
function completeExperienceVideoRun(database, source, revisionKey, asset) {
  const run = createVideoRun(database, {
    sourceId: source.id, sourceRevisionKey: revisionKey, assetId: asset.id,
    schemaVersion: VIDEO_SCHEMA_VERSION, attempt: 1
  });
  startVideoRun(database, run.id, { model: 'fixture-asr', provider: 'wmb-api', promptVersion: 1 });
  checkpointVideoStage(database, {
    runId: run.id,
    stage: 'align',
    probeJson: JSON.stringify({ container: 'mp4', durationMs: 240_000, width: 1280, height: 720, frameRate: 30, rotation: null, videoCodec: 'h264', audioCodec: 'aac', hasAudio: true, subtitleTracks: [], chapters: [], runtimeManifestHash: 'fixture' }),
    transcriptJson: JSON.stringify({ source: 'asr', segments: [{ startMs: 198_000, endMs: 226_000, text: '这个模型实测生成速度很快，体验非常稳定', source: 'asr' }] }),
    segmentsJson: JSON.stringify([
      {
        index: 0, startMs: 198_000, endMs: 226_000, keyframeAssetId: null,
        transcript: [{ startMs: 198_000, endMs: 226_000, text: '这个模型实测生成速度很快，体验非常稳定', source: 'asr' }],
        transcriptSource: 'asr', ocrRegions: [],
        summary: '实测视频展示了生成速度与稳定性，真实体验出色',
        quoteRange: { startMs: 198_000, endMs: 226_000 }, confidence: 0.9, warnings: []
      }
    ])
  });
  completeVideoRun(database, run.id, { model: 'fixture-asr', provider: 'wmb-api', promptVersion: 1 });
}

/** DeepSeek 正文：成绩领先 / 复现边界 / 真实体验 / 竞争格局（无证据）。 */
const DEEPSEEK_BODY = `# DeepSeek-V4-Pro 基准测试的后续影响

## 成绩领先
DeepSeek-V4-Pro 在基准测试中成绩领先，总分表现突出。

## 复现边界
测试限制说明：单次运行存在复现边界，结果受环境限制。

## 真实体验
实测视频展示了生成速度与稳定性，真实体验出色。

## 竞争格局
竞争格局分析：市场参与者与产品定位。`;

// ============ 1. 迁移 68：表 + 审计状态 + 幂等键 ============

test('WMB-5246 migration v68: media_recommendations table with audit states and UNIQUE idempotency key', async () => {
  const root = await makeRoot();
  const { database } = await makeDatabase(root);
  const applied = new Set(database.prepare('SELECT version FROM schema_migrations').all().map((row) => Number(row.version)));
  assert.ok(applied.has(68), 'migration v68 必须已应用');
  const columns = database.prepare('PRAGMA table_info(media_recommendations)').all().map((row) => row.name);
  for (const name of ['id', 'content_version_id', 'claim_key', 'asset_id', 'purpose', 'state', 'revision', 'request_id', 'provenance', 'rights_status', 'risk_flags_json']) {
    assert.ok(columns.includes(name), `列 ${name} 必须存在`);
  }
  const unique = database.prepare('PRAGMA index_list(media_recommendations)').all().map((row) => row.name);
  assert.ok(unique.some((name) => /sqlite_autoindex/.test(name)), 'UNIQUE 幂等键存在');
  database.close();
});

// ============ 2. splitContentClaims 确定性 ============

test('WMB-5246 splitContentClaims: deterministic claim keys c0..cN and stable excerpts', () => {
  const once = splitContentClaims(DEEPSEEK_BODY);
  const twice = splitContentClaims(DEEPSEEK_BODY);
  assert.deepEqual(once, twice, '同正文恒同输出');
  assert.deepEqual(once.map((claim) => claim.key), ['c0', 'c1', 'c2', 'c3', 'c4'], '稳定键 c0..cN');
  assert.equal(once[1].heading, '成绩领先');
  assert.ok(once[1].text.includes('基准测试'));
  assert.ok(once[1].excerpt.length > 0);
  assert.ok(once[1].excerpt.length <= 81, '摘录有界');
  assert.equal(claimExcerptOf('a'.repeat(200)).length, 81, '超长摘录截断加省略号');
  assert.deepEqual(splitContentClaims(''), [], '空正文零段');
});

// ============ 3. 引擎：DeepSeek fixture 正确映射 ============

test('WMB-5246 engine: benchmark image→result claim, limitations image→boundary claim, video segment→experience claim; no-fit claim zero', async () => {
  const root = await makeRoot();
  const { database } = await makeDatabase(root);
  const { source, revisionKey, benchmark, limitations, video } = await seedDeepSeekSource(root, database);
  completeBenchmarkRun(database, source, revisionKey, benchmark.asset);
  completeLimitationsRun(database, source, revisionKey, limitations.asset);
  completeExperienceVideoRun(database, source, revisionKey, video.asset);

  const project = createContentProjectWithVersion(database, { title: 'DeepSeek 后续影响', body: DEEPSEEK_BODY, sourceIds: [source.id] });
  const drafts = generateMediaRecommendations(database, {
    contentVersionId: project.contentVersionId,
    projectId: project.id,
    sourceRevisionKeys: [revisionKey]
  });

  const forClaim = (claimKey, assetId) => drafts.find((draft) => draft.claimKey === claimKey && draft.assetId === assetId);
  // Benchmark 图 →「成绩领先」（c1）
  const result = forClaim('c1', benchmark.asset.id);
  assert.ok(result, 'Benchmark 图必须建议到成绩领先段');
  assert.equal(result.purpose, 'direct_evidence', '直接证据优先');
  assert.equal(result.provenance, `asset:${benchmark.asset.id}|sourceRevision:${revisionKey}`, '图片 locator 整图');
  assert.ok(result.rationale.includes('成绩领先'), '理由引用理解内容');
  assert.ok(result.caption.length > 0, '建议图注存在');
  assert.equal(result.rightsStatus, 'unknown');

  // 测试限制图 →「复现边界」（c2）
  const boundary = forClaim('c2', limitations.asset.id);
  assert.ok(boundary, '限制图必须建议到复现边界段');
  assert.equal(boundary.purpose, 'direct_evidence');

  // 实测视频段 →「真实体验」（c3）；transform 建议 clip 03:18–03:46；provenance 带 timeRange
  const experience = forClaim('c3', video.asset.id);
  assert.ok(experience, '视频必须建议到真实体验段');
  assert.equal(experience.mediaKind, 'video');
  assert.equal(experience.purpose, 'direct_evidence');
  assert.deepEqual(experience.transform, { kind: 'clip', startMs: 198_000, endMs: 226_000 }, '建议 03:18–03:46 片段');
  assert.equal(experience.provenance, `asset:${video.asset.id}|sourceRevision:${revisionKey}|timeRange:198000-226000`, '视频 timeRange locator');

  // 「竞争格局」（c4）无直接证据 → 零建议
  assert.ok(!drafts.some((draft) => draft.claimKey === 'c4'), '竞争格局段无证据不得虚构建议');
  database.close();
});

// ============ 4. restricted 不进入自动建议 ============

test('WMB-5246 engine: restricted binding never auto-proposed (no asset emitted)', async () => {
  const root = await makeRoot();
  const { database } = await makeDatabase(root);
  const source = seedSource(database, '受限资料');
  const revisionKey = sourceRevisionKey(source.id, 1);
  const { asset } = await seedBinding(root, database, {
    sourceId: source.id, revisionKey, kind: 'image', ordinal: 0, rightsStatus: 'restricted', riskFlags: ['copyright']
  });
  completeBenchmarkRun(database, source, revisionKey, asset);
  const project = createContentProjectWithVersion(database, { title: '受限项目', body: '## 成绩领先\n基准测试成绩领先。', sourceIds: [source.id] });
  const drafts = generateMediaRecommendations(database, {
    contentVersionId: project.contentVersionId, projectId: project.id, sourceRevisionKeys: [revisionKey]
  });
  assert.equal(drafts.length, 0, 'restricted 绑定不产生任何自动建议');
  database.close();
});

// ============ 5. 未理解 / unsupported / 无文本媒体绝不虚构 ============

test('WMB-5246 engine: ununderstood media, unsupported candidate, and text-less video segment never fabricated', async () => {
  const root = await makeRoot();
  const { database } = await makeDatabase(root);
  const source = seedSource(database, '未理解资料');
  const revisionKey = sourceRevisionKey(source.id, 1);
  // 图片已保存但未入队理解（ununderstood）→ 不声称其内容
  await seedBinding(root, database, { sourceId: source.id, revisionKey, kind: 'image', ordinal: 0, mimeType: 'image/png', fileName: 'unread.png' });
  // 视频已保存但理解 run 失败（failed，非 completed）→ 不声称其内容
  const video = await seedBinding(root, database, { sourceId: source.id, revisionKey, kind: 'video', ordinal: 1, mimeType: 'video/mp4', fileName: 'failed.mp4' });
  const run = createVideoRun(database, {
    sourceId: source.id, sourceRevisionKey: revisionKey, assetId: video.asset.id,
    schemaVersion: VIDEO_SCHEMA_VERSION, attempt: 1
  });
  startVideoRun(database, run.id, { model: 'fixture', provider: 'wmb-api', promptVersion: 1 });
  checkpointVideoStage(database, { runId: run.id, stage: 'align', segmentsJson: JSON.stringify([]) });
  database.prepare("UPDATE video_understanding_runs SET status = 'failed', error_code = 'ASR_FAILED', completed_at = NULL WHERE id = ?").run(run.id);

  const project = createContentProjectWithVersion(database, { title: '未理解项目', body: '## 真实体验\n实测体验很好。', sourceIds: [source.id] });
  const drafts = generateMediaRecommendations(database, {
    contentVersionId: project.contentVersionId, projectId: project.id, sourceRevisionKeys: [revisionKey]
  });
  assert.equal(drafts.length, 0, '未理解媒体不产生建议（零虚构）');

  // 文本为空（transcriptSource none）的视频段也不匹配
  const video2 = await seedBinding(root, database, { sourceId: source.id, revisionKey, kind: 'video', ordinal: 2, mimeType: 'video/mp4', fileName: 'silent.mp4' });
  const run2 = createVideoRun(database, {
    sourceId: source.id, sourceRevisionKey: revisionKey, assetId: video2.asset.id,
    schemaVersion: VIDEO_SCHEMA_VERSION, attempt: 1
  });
  startVideoRun(database, run2.id, { model: 'fixture', provider: 'wmb-api', promptVersion: 1 });
  checkpointVideoStage(database, {
    runId: run2.id, stage: 'align',
    segmentsJson: JSON.stringify([{ index: 0, startMs: 0, endMs: 1000, keyframeAssetId: null, transcript: [], transcriptSource: 'none', ocrRegions: [], summary: null, quoteRange: null, confidence: null, warnings: [] }])
  });
  completeVideoRun(database, run2.id, { model: 'fixture', provider: 'wmb-api', promptVersion: 1 });
  const drafts2 = generateMediaRecommendations(database, {
    contentVersionId: project.contentVersionId, projectId: project.id, sourceRevisionKeys: [revisionKey]
  });
  assert.equal(drafts2.length, 0, '无文本段不参与观点匹配');
  database.close();
});

// ============ 6. 持久化：propose 幂等 / supersede / 决定 / 零部分写 ============

test('WMB-5246 propose: idempotent replay, supersedes prior proposed, accepted/rejected never overwritten', async () => {
  const root = await makeRoot();
  const { database } = await makeDatabase(root);
  const { source, revisionKey, benchmark, limitations, video } = await seedDeepSeekSource(root, database);
  completeBenchmarkRun(database, source, revisionKey, benchmark.asset);
  completeLimitationsRun(database, source, revisionKey, limitations.asset);
  completeExperienceVideoRun(database, source, revisionKey, video.asset);
  const project = createContentProjectWithVersion(database, { title: 'DeepSeek 后续影响', body: DEEPSEEK_BODY, sourceIds: [source.id] });

  const drafts = generateMediaRecommendations(database, {
    contentVersionId: project.contentVersionId, projectId: project.id, sourceRevisionKeys: [revisionKey]
  });
  const requestId = 'propose-1';

  // 首次 propose：全 proposed
  const first = proposeMediaRecommendations(database, {
    contentVersionId: project.contentVersionId, projectId: project.id, requestId, drafts
  });
  assert.ok(first.length >= 3, '三条建议落库');
  assert.ok(first.every((row) => row.state === 'proposed' && row.requestId === requestId));

  // 同 requestId 同输入重放 → 幂等（同 id 同 revision，不新增行）
  const before = count(database, 'media_recommendations');
  const replay = proposeMediaRecommendations(database, {
    contentVersionId: project.contentVersionId, projectId: project.id, requestId, drafts
  });
  assert.equal(count(database, 'media_recommendations'), before, '重放不新增行');
  assert.deepEqual(replay.map((row) => row.id), first.map((row) => row.id), '重放返回同 id');
  assert.deepEqual(replay.map((row) => row.revision), first.map((row) => row.revision), '重放不递增 revision（幂等）');

  // 用户接受成绩领先、拒绝复现边界
  const result = first.find((row) => row.claimKey === 'c1');
  const boundary = first.find((row) => row.claimKey === 'c2');
  assert.ok(result && boundary, 'propose 必须包含 c1/c2');
  const accepted = decideMediaRecommendation(database, { id: result.id, expectedRevision: result.revision, decision: 'accept', confirmedByOwner: false, decidedBy: 'owner_ui' });
  assert.equal(accepted.state, 'accepted');
  assert.equal(accepted.decidedBy, 'owner_ui');
  const rejected = decideMediaRecommendation(database, { id: boundary.id, expectedRevision: boundary.revision, decision: 'reject', decidedBy: 'owner_ui' });
  assert.equal(rejected.state, 'rejected');

  // 新提案 run（新 requestId）：旧 proposed 全部 superseded；已决定行不被覆盖
  const secondRequest = 'propose-2';
  const superseded = supersedeProposedRecommendations(database, { contentVersionId: project.contentVersionId, requestId: secondRequest });
  assert.ok(superseded >= 1, '旧 proposed 置 superseded');
  proposeMediaRecommendations(database, {
    contentVersionId: project.contentVersionId, projectId: project.id, requestId: secondRequest, drafts
  });
  // 已决定行（accepted/rejected）保持终态且 revision 不变；新提案只替换 proposed 行
  const modelAfter = readMediaRecommendations(database, { contentVersionId: project.contentVersionId });
  assert.equal(modelAfter.counts.accepted, 1, 'accepted 行绝不被新提案覆盖');
  assert.equal(modelAfter.counts.rejected, 1, 'rejected 行绝不被新提案覆盖');
  const acceptedAfter = modelAfter.claims.find((claim) => claim.claimKey === 'c1')?.suggestions[0];
  const rejectedAfter = modelAfter.claims.find((claim) => claim.claimKey === 'c2')?.suggestions[0];
  assert.equal(acceptedAfter?.state, 'accepted');
  assert.equal(rejectedAfter?.state, 'rejected');
  assert.equal(acceptedAfter?.revision, accepted.revision, 'accepted 行 revision 不变');

  // 读模型分组 + 计数
  assert.equal(modelAfter.counts.accepted, 1);
  assert.equal(modelAfter.counts.rejected, 1);
  assert.ok(modelAfter.claims.length >= 1);
  const resultClaim = modelAfter.claims.find((claim) => claim.claimKey === 'c1');
  assert.equal(resultClaim?.suggestions[0]?.state, 'accepted');
  database.close();
});

// ============ 7. decide 乐观锁：revision 冲突零写入；restricted 接受需确认 ============

test('WMB-5246 decide: revision conflict writes nothing; restricted accept requires confirmedByOwner', async () => {
  const root = await makeRoot();
  const { database } = await makeDatabase(root);
  const { source, revisionKey, benchmark } = await seedDeepSeekSource(root, database);
  completeBenchmarkRun(database, source, revisionKey, benchmark.asset);
  const project = createContentProjectWithVersion(database, { title: '决定测试', body: '## 成绩领先\n基准测试成绩领先。', sourceIds: [source.id] });
  const drafts = generateMediaRecommendations(database, {
    contentVersionId: project.contentVersionId, projectId: project.id, sourceRevisionKeys: [revisionKey]
  });
  const proposed = proposeMediaRecommendations(database, {
    contentVersionId: project.contentVersionId, projectId: project.id, requestId: 'req-decide', drafts
  });
  const row = proposed[0];
  assert.ok(row, 'propose 必须返回至少一行');

  // 乐观锁：expectedRevision 过期 → 抛错且零写入
  assert.throws(
    () => decideMediaRecommendation(database, { id: row.id, expectedRevision: row.revision + 5, decision: 'reject' }),
    (error) => error instanceof MediaRecommendationError && error.code === 'RECOMMENDATION_REVISION_CONFLICT'
  );
  assert.equal(getRow(database, row.id).revision, row.revision, 'revision 未变（零写入）');
  assert.equal(getRow(database, row.id).state, 'proposed', '状态未变（零写入）');

  // 已决定行不可再次决定
  decideMediaRecommendation(database, { id: row.id, expectedRevision: row.revision, decision: 'accept', decidedBy: 'owner_ui' });
  assert.throws(
    () => decideMediaRecommendation(database, { id: row.id, expectedRevision: row.revision, decision: 'reject' }),
    (error) => error instanceof MediaRecommendationError && error.code === 'RECOMMENDATION_ALREADY_DECIDED'
  );

  // restricted 建议（手工插入模拟）：accept 必须 confirmedByOwner=true
  const restrictedProject = createContentProjectWithVersion(database, { title: '受限决定', body: '## 复现边界\n测试限制说明。', sourceIds: [source.id] });
  const baseDraft = drafts[0];
  assert.ok(baseDraft, 'engine 必须返回草稿');
  const restrictedDraft = {
    ...baseDraft,
    claimKey: 'c1',
    claimExcerpt: '测试限制说明。',
    rightsStatus: 'restricted',
    riskFlags: ['copyright'],
    purpose: 'direct_evidence',
    priority: 0
  };
  proposeMediaRecommendations(database, {
    contentVersionId: restrictedProject.contentVersionId, projectId: restrictedProject.id, requestId: 'req-restricted', drafts: [restrictedDraft]
  });
  const restrictedRow = readMediaRecommendations(database, { contentVersionId: restrictedProject.contentVersionId }).claims[0]?.suggestions[0];
  assert.equal(restrictedRow?.rightsStatus, 'restricted');
  assert.throws(
    () => decideMediaRecommendation(database, { id: restrictedRow.id, expectedRevision: restrictedRow.revision, decision: 'accept' }),
    (error) => error instanceof MediaRecommendationError && error.code === 'RIGHTS_RESTRICTED_OVERRIDE_REQUIRED'
  );
  const forced = decideMediaRecommendation(database, {
    id: restrictedRow.id, expectedRevision: restrictedRow.revision, decision: 'accept', confirmedByOwner: true, decidedBy: 'owner_ui'
  });
  assert.equal(forced.state, 'accepted');
  database.close();
});

// ============ 8. 接受 = 独立 Studio 保存边界（accept 不写 Content/Platform Binding） ============

test('WMB-5246 acceptance boundary: decide accept records audit state only, zero Content/Platform binding writes', async () => {
  const root = await makeRoot();
  const { database } = await makeDatabase(root);
  const { source, revisionKey, benchmark } = await seedDeepSeekSource(root, database);
  completeBenchmarkRun(database, source, revisionKey, benchmark.asset);
  const project = createContentProjectWithVersion(database, { title: '保存边界', body: '## 成绩领先\n基准测试成绩领先。', sourceIds: [source.id] });
  const drafts = generateMediaRecommendations(database, {
    contentVersionId: project.contentVersionId, projectId: project.id, sourceRevisionKeys: [revisionKey]
  });
  const proposed = proposeMediaRecommendations(database, {
    contentVersionId: project.contentVersionId, projectId: project.id, requestId: 'req-accept', drafts
  });
  const beforeCore = count(database, 'content_media_bindings');
  const beforePlatform = count(database, 'platform_media_bindings');
  decideMediaRecommendation(database, { id: proposed[0].id, expectedRevision: proposed[0].revision, decision: 'accept', decidedBy: 'owner_ui' });
  assert.equal(count(database, 'content_media_bindings'), beforeCore, 'accept 不写核心绑定');
  assert.equal(count(database, 'platform_media_bindings'), beforePlatform, 'accept 不写平台绑定');
  database.close();
});

function getRow(database, id) {
  return database.prepare('SELECT * FROM media_recommendations WHERE id = ?').get(id);
}

// ============ 9. 确定性上限与优先级排序 ============

test('WMB-5246 engine: per-claim cap and purpose priority ordering are deterministic', () => {
  assert.equal(MAX_RECOMMENDATIONS_PER_CLAIM, 3, '每 claim 最多 3 条建议');
  assert.ok(MEDIA_RECOMMENDATION_PURPOSE_PRIORITY.direct_evidence < MEDIA_RECOMMENDATION_PURPOSE_PRIORITY.demonstration, '直接证据 > 演示');
  assert.ok(MEDIA_RECOMMENDATION_PURPOSE_PRIORITY.demonstration < MEDIA_RECOMMENDATION_PURPOSE_PRIORITY.comparison, '演示 > 比较');
  assert.ok(MEDIA_RECOMMENDATION_PURPOSE_PRIORITY.comparison < MEDIA_RECOMMENDATION_PURPOSE_PRIORITY.background, '比较 > 背景');
  assert.ok(MEDIA_RECOMMENDATION_PURPOSE_PRIORITY.background < MEDIA_RECOMMENDATION_PURPOSE_PRIORITY.cover, '背景 > 封面');
  assert.ok(MEDIA_RECOMMENDATION_PURPOSE_PRIORITY.cover < MEDIA_RECOMMENDATION_PURPOSE_PRIORITY.decoration, '封面 > 装饰');
});
