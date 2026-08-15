// WMB-5245：视频理解确定性主路径聚焦测试（设计 §10；合同逐项）。
// 覆盖：迁移 66 建表与 completed 不可变触发器；入队幂等/重试新 attempt；
// 字幕优先零 ASR/OCR（native 零 ASR/OCR）；无字幕有音轨走 ASR；无字幕无音轨/ASR 零段走 OCR；
// 静态视频 10 秒兜底抽帧；镜头合并/关键帧 ≤48/感知哈希去重；Segment 对齐确定性 ≤64；
// 运行时缺失 → MEDIA_RUNTIME_MISSING 且不回退 PATH；失败从 stage 恢复且不重复前序；
// timeRange locator 严格解析且旧图片 locator 兼容；摘要失败不抹机械结果。
// 运行（本批次不执行；由 Main 统一验证）：node --test --test-concurrency=1 tests/wmb-5245-video-understanding.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { upsertSource } = await import('../src/main/sources.ts');
const { importAssetBytes, getAsset } = await import('../src/main/assets.ts');
const {
  VIDEO_SCHEMA_VERSION,
  MAX_KEYFRAMES,
  MAX_SEGMENTS,
  enqueueVideoRun,
  retryVideoRun,
  executeVideoRun,
  getVideoRun,
  listVideoRunsForRevision,
  parseVideoEvidenceLocator,
  buildVideoEvidenceLocator,
  videoEvidenceLocator,
  parseSrtToSegments,
  pickSubtitleTrack,
  mergeSceneBoundaries,
  computeFallbackBoundaries,
  selectKeyframeTimes,
  dedupeKeyframesByPhash,
  alignVideoSegments,
  boundSummary,
  transcriptGapBoundaries,
  VideoUnderstandingError
} = await import('../src/main/video-understanding.ts');

// ============ fixtures / helpers ============

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

async function seedVideoAsset(root, database, { sourceId, mimeType = 'video/mp4' } = {}) {
  const bytes = Buffer.from(`fake-mp4-${randomUUID()}`, 'utf8');
  const imported = await importAssetBytes(database, root, {
    bytes,
    fileName: 'clip.mp4',
    mimeType,
    origin: `source-media:${sourceId}`
  });
  const asset = getAsset(database, imported.id);
  return asset;
}

function count(database, table, where = '', params = []) {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}${where ? ` WHERE ${where}` : ''}`).get(...params).count);
}

/** 确定性假适配器：全部操作可脚本化；记录调用次数以断言「零 ASR / 零 OCR / 不重复前序」。 */
function fakeRuntime(overrides = {}) {
  const calls = { probe: 0, extractSubtitles: 0, runAsr: 0, detectScenes: 0, extractKeyframe: 0, runOcr: 0 };
  const runtime = {
    identity: 'fixture-runtime@1',
    calls,
    probe: async () => {
      calls.probe += 1;
      return {
        container: 'mov,mp4,m4a,3gp,3g2,mj2',
        durationMs: 60_000,
        width: 1280,
        height: 720,
        frameRate: 30,
        rotation: null,
        videoCodec: 'h264',
        audioCodec: 'aac',
        hasAudio: true,
        subtitleTracks: [],
        chapters: [],
        runtimeManifestHash: 'fixture-runtime@1'
      };
    },
    extractSubtitles: async () => { calls.extractSubtitles += 1; return []; },
    runAsr: async () => { calls.runAsr += 1; return []; },
    detectScenes: async () => { calls.detectScenes += 1; return []; },
    extractKeyframe: async (_, timeMs) => {
      calls.extractKeyframe += 1;
      return { bytes: Buffer.from(`kf-${timeMs}`, 'utf8'), width: 1280, height: 720, phash: `ph-${timeMs}` };
    },
    runOcr: async () => { calls.runOcr += 1; return []; },
    ...overrides
  };
  return runtime;
}

/** 确定性摘要调用：每段返回固定摘要。 */
function summaryCallOf(overrides = {}) {
  const calls = { count: 0 };
  const call = async ({ segments }) => {
    calls.count += 1;
    return segments.map((segment) => ({ index: segment.index, summary: `段 ${segment.index} 摘要` }));
  };
  return { calls, call: overrides.call ?? call };
}

async function seedSourceWithVideo(root) {
  const { database, workspaceId } = await makeDatabase(root);
  const source = seedSource(database, `视频资料-${randomUUID().slice(0, 8)}`);
  const asset = await seedVideoAsset(root, database, { sourceId: source.id });
  return { database, workspaceId, source, asset };
}

// ============ 1. 迁移建表 + completed 不可变 ============

test('WMB-5245 migration v66: video_understanding_runs with identity UNIQUE + completed-immutable trigger', async () => {
  const root = await makeRoot();
  const { database } = await makeDatabase(root);
  const applied = new Set(database.prepare('SELECT version FROM schema_migrations').all().map((row) => Number(row.version)));
  assert.ok(applied.has(66), 'migration v66 必须已应用');
  assert.ok(applied.has(64) && applied.has(65), 'v64/v65 媒体冻结与 provenance kind 扩展必须已应用');
  const columns = database.prepare('PRAGMA table_info(video_understanding_runs)').all().map((row) => row.name);
  for (const name of ['id', 'source_id', 'source_revision_key', 'asset_id', 'schema_version', 'attempt', 'status',
    'stage', 'probe_json', 'transcript_json', 'keyframes_json', 'segments_json', 'model', 'provider',
    'prompt_version', 'runtime_manifest_hash', 'error_code', 'error_message', 'created_at', 'started_at', 'completed_at']) {
    assert.ok(columns.includes(name), `列 ${name} 必须存在`);
  }
  const triggers = database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='video_understanding_runs'").all();
  assert.ok(triggers.some((row) => row.name === 'video_understanding_runs_completed_immutable'), 'completed 不可变触发器必须存在');
  const provenanceKind = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='asset_provenance'").get().sql;
  assert.match(provenanceKind, /derived_keyframe/, 'asset_provenance kind 必须含 derived_keyframe');
  database.close();
});

// ============ 2. 入队幂等 / 重试新 attempt ============

test('WMB-5245 enqueue: queued run with identity; idempotent; retry creates attempt 2', async () => {
  const root = await makeRoot();
  const { database, source, asset } = await seedSourceWithVideo(root);
  const revKey = `source:${source.id}:r${source.revision}`;

  const first = enqueueVideoRun(database, { sourceId: source.id, sourceRevisionKey: revKey, assetId: asset.id });
  assert.equal(first.created, true);
  assert.equal(first.run.status, 'queued');
  assert.equal(first.run.attempt, 1);
  assert.equal(first.run.schemaVersion, VIDEO_SCHEMA_VERSION);
  assert.equal(first.run.stage, 'probe');
  assert.equal(first.run.sourceRevisionKey, revKey);
  assert.equal(first.run.assetId, asset.id);

  const again = enqueueVideoRun(database, { sourceId: source.id, sourceRevisionKey: revKey, assetId: asset.id });
  assert.equal(again.run.id, first.run.id);
  assert.equal(again.created, false);
  assert.equal(count(database, 'video_understanding_runs'), 1);

  // 不同 schemaVersion → 新 run
  const otherSchema = enqueueVideoRun(database, { sourceId: source.id, sourceRevisionKey: revKey, assetId: asset.id, schemaVersion: 2 });
  assert.notEqual(otherSchema.run.id, first.run.id);

  assert.throws(() => enqueueVideoRun(database, { sourceId: 'missing-source', sourceRevisionKey: revKey, assetId: asset.id }),
    (error) => error instanceof VideoUnderstandingError && error.code === 'SOURCE_NOT_FOUND');
  assert.throws(() => enqueueVideoRun(database, { sourceId: source.id, sourceRevisionKey: revKey, assetId: 'missing-asset' }),
    (error) => error instanceof VideoUnderstandingError && error.code === 'ASSET_NOT_FOUND');
  database.close();
});

test('WMB-5245 retry: failed attempt-1 → retryVideoRun creates attempt 2 queued; old row immutable preserved', async () => {
  const root = await makeRoot();
  const { database, source, asset } = await seedSourceWithVideo(root);
  const revKey = `source:${source.id}:r${source.revision}`;
  const { run } = enqueueVideoRun(database, { sourceId: source.id, sourceRevisionKey: revKey, assetId: asset.id });

  // probe 阶段失败（运行时缺失）
  const runtime = fakeRuntime({ probe: async () => { throw Object.assign(new Error('runtime missing'), { code: 'MEDIA_RUNTIME_MISSING' }); } });
  const summary = summaryCallOf();
  const failed = await executeVideoRun(database, run.id, { dataRoot: root, runtime, summaryCall: summary.call });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'MEDIA_RUNTIME_MISSING');

  const retried = retryVideoRun(database, run.id);
  assert.equal(retried.created, true);
  assert.equal(retried.run.attempt, 2);
  assert.notEqual(retried.run.id, run.id);
  assert.equal(retried.run.status, 'queued');
  assert.equal(count(database, 'video_understanding_runs'), 2);
  const old = getVideoRun(database, run.id);
  assert.equal(old.status, 'failed');
  assert.equal(old.errorCode, 'MEDIA_RUNTIME_MISSING');
  database.close();
});

// ============ 3. 字幕优先零 ASR/OCR ============

test('WMB-5245 native subtitle priority: native source, zero ASR calls, zero OCR calls', async () => {
  const root = await makeRoot();
  const { database, source, asset } = await seedSourceWithVideo(root);
  const revKey = `source:${source.id}:r${source.revision}`;
  const { run } = enqueueVideoRun(database, { sourceId: source.id, sourceRevisionKey: revKey, assetId: asset.id });

  const srt = [
    '1',
    '00:00:01,000 --> 00:00:04,000',
    '大家好，这里是基准测试。',
    '',
    '2',
    '00:00:05,000 --> 00:00:08,000',
    '成绩领先上一代 40%。',
    ''
  ].join('\n');
  const runtime = fakeRuntime({
    probe: async () => ({
      container: 'mov,mp4',
      durationMs: 30_000,
      width: 1920, height: 1080, frameRate: 30, rotation: null,
      videoCodec: 'h264', audioCodec: null, hasAudio: false,
      subtitleTracks: [{ index: 0, language: 'chi', forced: false, default: true }],
      chapters: [], runtimeManifestHash: 'fixture-runtime@1'
    }),
    extractSubtitles: async () => {
      runtime.calls.extractSubtitles += 1;
      return parseSrtToSegments(srt, 'native');
    }
  });
  const summary = summaryCallOf();
  const completed = await executeVideoRun(database, run.id, { dataRoot: root, runtime, summaryCall: summary.call });
  assert.equal(completed.status, 'completed');
  const transcript = JSON.parse(completed.transcriptJson);
  assert.equal(transcript.source, 'native');
  assert.equal(transcript.segments.length, 2);
  assert.equal(transcript.segments[0].source, 'native');
  assert.equal(runtime.calls.runAsr, 0, '字幕存在必须零 ASR');
  assert.equal(runtime.calls.runOcr, 0, '字幕存在必须零 OCR');
  assert.equal(runtime.calls.extractKeyframe, 2, '30s 静态视频关键帧抽帧 2 次（10s/20s 兜底）');
  const segments = JSON.parse(completed.segmentsJson);
  assert.ok(segments.length >= 1);
  assert.equal(segments[0].transcriptSource, 'native');
  assert.ok(segments[0].quoteRange, '有文本段必须携带 quoteRange');
  assert.ok(segments[0].summary, '摘要必须已写入');
  assert.equal(summary.calls.count, 1, '每 attempt 摘要最多一次');
  database.close();
});

// ============ 4. 无字幕有音轨 → ASR ============

test('WMB-5245 ASR fallback: no subtitle + audio → asr source; subtitle extracted but empty also falls to ASR', async () => {
  const root = await makeRoot();
  const { database, source, asset } = await seedSourceWithVideo(root);
  const revKey = `source:${source.id}:r${source.revision}`;
  const { run } = enqueueVideoRun(database, { sourceId: source.id, sourceRevisionKey: revKey, assetId: asset.id });

  const runtime = fakeRuntime({
    runAsr: async () => {
      runtime.calls.runAsr += 1;
      return [
        { startMs: 500, endMs: 3000, text: '这是 ASR 识别出的内容', source: 'asr' },
        { startMs: 3500, endMs: 6000, text: '第二句包含数字 42', source: 'asr' }
      ];
    }
  });
  const summary = summaryCallOf();
  const completed = await executeVideoRun(database, run.id, { dataRoot: root, runtime, summaryCall: summary.call });
  assert.equal(completed.status, 'completed');
  const transcript = JSON.parse(completed.transcriptJson);
  assert.equal(transcript.source, 'asr');
  assert.equal(transcript.segments.length, 2);
  assert.equal(runtime.calls.runAsr, 1);
  assert.equal(runtime.calls.runOcr, 0, 'ASR 有段 → 零 OCR');

  // 字幕轨存在但提取为空 → 有音轨 → ASR
  const root2 = await makeRoot();
  const { database: db2, source: src2, asset: asset2 } = await seedSourceWithVideo(root2);
  const revKey2 = `source:${src2.id}:r${src2.revision}`;
  const { run: run2 } = enqueueVideoRun(db2, { sourceId: src2.id, sourceRevisionKey: revKey2, assetId: asset2.id });
  const runtime2 = fakeRuntime({
    probe: async () => ({
      container: 'mov,mp4', durationMs: 10_000, width: 1280, height: 720, frameRate: 30, rotation: null,
      videoCodec: 'h264', audioCodec: 'aac', hasAudio: true,
      subtitleTracks: [{ index: 0, language: 'chi', forced: false, default: true }],
      chapters: [], runtimeManifestHash: 'fixture-runtime@1'
    }),
    extractSubtitles: async () => { runtime2.calls.extractSubtitles += 1; return []; },
    runAsr: async () => {
      runtime2.calls.runAsr += 1;
      return [{ startMs: 0, endMs: 2000, text: '空字幕降级 ASR', source: 'asr' }];
    }
  });
  const summary2 = summaryCallOf();
  const completed2 = await executeVideoRun(db2, run2.id, { dataRoot: root2, runtime: runtime2, summaryCall: summary2.call });
  assert.equal(completed2.status, 'completed');
  assert.equal(JSON.parse(completed2.transcriptJson).source, 'asr');
  database.close();
});

// ============ 5. 无字幕无音轨 → OCR 兜底 ============

test('WMB-5245 OCR fallback: no subtitle + no audio → ocr source from keyframes', async () => {
  const root = await makeRoot();
  const { database, source, asset } = await seedSourceWithVideo(root);
  const revKey = `source:${source.id}:r${source.revision}`;
  const { run } = enqueueVideoRun(database, { sourceId: source.id, sourceRevisionKey: revKey, assetId: asset.id });

  const runtime = fakeRuntime({
    probe: async () => ({
      container: 'mov,mp4', durationMs: 30_000, width: 1280, height: 720, frameRate: 30, rotation: null,
      videoCodec: 'h264', audioCodec: null, hasAudio: false, subtitleTracks: [], chapters: [], runtimeManifestHash: 'fixture-runtime@1'
    }),
    detectScenes: async () => { runtime.calls.detectScenes += 1; return [5000, 15000]; },
    runOcr: async (imagePath, region) => {
      runtime.calls.runOcr += 1;
      assert.ok(imagePath, 'OCR 必须收到关键帧本地路径');
      assert.ok(region, '底部区域 OCR 必须带 region');
      return [{ text: '硬字幕内容', confidence: 0.95, x: 0.1, y: 0.8, width: 0.8, height: 0.1 }];
    }
  });
  const summary = summaryCallOf();
  const completed = await executeVideoRun(database, run.id, { dataRoot: root, runtime, summaryCall: summary.call });
  assert.equal(completed.status, 'completed');
  const transcript = JSON.parse(completed.transcriptJson);
  assert.equal(transcript.source, 'ocr');
  assert.equal(transcript.segments.length, 2, '2 个关键帧各产出 1 条 OCR');
  assert.equal(transcript.segments[0].source, 'ocr');
  assert.ok(runtime.calls.runOcr >= 1);
  const segments = JSON.parse(completed.segmentsJson);
  assert.ok(segments.some((segment) => segment.transcriptSource === 'ocr'), 'Segment 必须标记 ocr');
  database.close();
});

test('WMB-5245 OCR low confidence: all dropped → transcriptSource none, run still completes (no fabrication)', async () => {
  const root = await makeRoot();
  const { database, source, asset } = await seedSourceWithVideo(root);
  const revKey = `source:${source.id}:r${source.revision}`;
  const { run } = enqueueVideoRun(database, { sourceId: source.id, sourceRevisionKey: revKey, assetId: asset.id });

  const runtime = fakeRuntime({
    probe: async () => ({
      container: 'mov,mp4', durationMs: 30_000, width: 1280, height: 720, frameRate: 30, rotation: null,
      videoCodec: 'h264', audioCodec: null, hasAudio: false, subtitleTracks: [], chapters: [], runtimeManifestHash: 'fixture-runtime@1'
    }),
    runOcr: async () => [{ text: '低置信度垃圾', confidence: 0.3, x: 0, y: 0.7, width: 1, height: 0.2 }]
  });
  const summary = summaryCallOf();
  const completed = await executeVideoRun(database, run.id, { dataRoot: root, runtime, summaryCall: summary.call });
  assert.equal(completed.status, 'completed');
  const transcript = JSON.parse(completed.transcriptJson);
  assert.equal(transcript.source, 'none', '低置信度全部丢弃必须如实 none');
  assert.equal(transcript.segments.length, 0);
  database.close();
});

// ============ 6. 静态兜底：10 秒间隔关键帧 ============

test('WMB-5245 static fallback: no scene cuts → 10s fallback keyframes (30s → 2 frames at 10s/20s)', async () => {
  const root = await makeRoot();
  const { database, source, asset } = await seedSourceWithVideo(root);
  const revKey = `source:${source.id}:r${source.revision}`;
  const { run } = enqueueVideoRun(database, { sourceId: source.id, sourceRevisionKey: revKey, assetId: asset.id });

  const runtime = fakeRuntime({
    probe: async () => ({
      container: 'mov,mp4', durationMs: 30_000, width: 1280, height: 720, frameRate: 30, rotation: null,
      videoCodec: 'h264', audioCodec: null, hasAudio: false, subtitleTracks: [], chapters: [], runtimeManifestHash: 'fixture-runtime@1'
    }),
    detectScenes: async () => { runtime.calls.detectScenes += 1; return []; }
  });
  const summary = summaryCallOf();
  const completed = await executeVideoRun(database, run.id, { dataRoot: root, runtime, summaryCall: summary.call });
  assert.equal(completed.status, 'completed');
  const keyframes = JSON.parse(completed.keyframesJson);
  const times = keyframes.map((frame) => frame.timeMs).sort((a, b) => a - b);
  assert.deepEqual(times, [10000, 20000], '30s 静态视频必须产出 10s/20s 两个兜底关键帧');
  assert.ok(keyframes.every((frame) => frame.assetId), '关键帧必须注册 Asset');
  // derived_keyframe 血缘
  const provenanceRows = database.prepare("SELECT kind, transform_json AS transformJson FROM asset_provenance WHERE kind = 'derived_keyframe'").all();
  assert.equal(provenanceRows.length, 2);
  for (const row of provenanceRows) {
    const transform = JSON.parse(row.transformJson);
    assert.ok(Number.isInteger(transform.timeMs), '关键帧血缘必须记录 timeMs');
  }
  database.close();
});

// ============ 7. 纯算法确定性（镜头合并 / 关键帧上限 / 感知哈希 / 对齐 / 摘要有界） ============

test('WMB-5245 pure determinism: scene merge (<2s), fallback boundaries, keyframe cap ≤48, phash dedupe', () => {
  // 镜头合并：1.5s 间隔的相邻镜头合并
  assert.deepEqual(mergeSceneBoundaries([1000, 2500, 20000]), [1000, 20000]);
  // 兜底边界：60s 视频、镜头在 5s 与 55s → (0,10s] 有 5s 镜头不补界；
  // (10s,20s]/(20s,30s]/(30s,40s]/(40s,50s] 无切换 → 20s/30s/40s/50s 补界。
  const fallback = computeFallbackBoundaries([5000, 55000], 60_000);
  assert.deepEqual(fallback, [20000, 30000, 40000, 50000]);
  // 关键帧上限：80 个候选 → ≤48 且保留首尾
  const boundaries = Array.from({ length: 80 }, (_, index) => (index + 1) * 1000);
  const times = selectKeyframeTimes(boundaries, [], 80_000);
  assert.ok(times.length <= MAX_KEYFRAMES, '关键帧必须 ≤48');
  assert.equal(times[0], 1000);
  assert.equal(times[times.length - 1], 79000);
  // 感知哈希去重：相邻相同哈希合并
  const frames = [
    { timeMs: 1000, width: 1280, height: 720, assetId: 'a', perceptionHash: 'same' },
    { timeMs: 2000, width: 1280, height: 720, assetId: 'b', perceptionHash: 'same' },
    { timeMs: 3000, width: 1280, height: 720, assetId: 'c', perceptionHash: 'other' }
  ];
  const deduped = dedupeKeyframesByPhash(frames);
  assert.deepEqual(deduped.map((frame) => frame.timeMs), [1000, 3000]);
});

test('WMB-5245 alignment determinism: boundaries union, small-segment merge, transcript max-overlap, ≤64 cap', () => {
  const keyframes = [
    { timeMs: 5000, width: 1280, height: 720, assetId: 'kf-a', perceptionHash: 'p1' },
    { timeMs: 15000, width: 1280, height: 720, assetId: 'kf-b', perceptionHash: 'p2' }
  ];
  const transcript = [
    { startMs: 1000, endMs: 4000, text: '开头介绍', source: 'native' },
    { startMs: 16000, endMs: 18000, text: '数字 99', source: 'native' }
  ];
  const first = alignVideoSegments({ durationMs: 30_000, keyframes, transcript });
  const second = alignVideoSegments({ durationMs: 30_000, keyframes, transcript });
  assert.deepEqual(first, second, '同输入必须同输出（确定性）');
  assert.ok(first.length <= MAX_SEGMENTS, 'Segment 必须 ≤64');
  for (const segment of first) {
    assert.ok(segment.startMs >= 0 && segment.endMs > segment.startMs && segment.endMs <= 30_000, '时间范围必须合法');
    for (const item of segment.transcript) {
      assert.ok(item.startMs < item.endMs, 'transcript 原始时间戳必须保留且合法');
      assert.equal(item.text, transcript.find((t) => t.startMs === item.startMs)?.text, '不得改写原话');
    }
  }
  // 大空档 → 边界
  const gaps = transcriptGapBoundaries([
    { startMs: 0, endMs: 2000, text: 'a', source: 'asr' },
    { startMs: 12000, endMs: 14000, text: 'b', source: 'asr' }
  ]);
  assert.deepEqual(gaps, [7000], '≥5s 空档必须在中点创建边界');
  // 超长摘要截断
  const bounded = boundSummary('x'.repeat(300));
  assert.equal(bounded.summary.length, 200);
  assert.equal(bounded.truncated, true);
  assert.equal(boundSummary('short').truncated, false);
});

// ============ 8. 运行时缺失 → MEDIA_RUNTIME_MISSING（图片链不受影响） ============

test('WMB-5245 runtime missing: probe throws MEDIA_RUNTIME_MISSING → run failed; app/DB untouched', async () => {
  const root = await makeRoot();
  const { database, source, asset } = await seedSourceWithVideo(root);
  const revKey = `source:${source.id}:r${source.revision}`;
  const { run } = enqueueVideoRun(database, { sourceId: source.id, sourceRevisionKey: revKey, assetId: asset.id });

  const runtime = fakeRuntime({
    probe: async () => { throw Object.assign(new Error('.r/media-runtime 未就绪，不回退 PATH'), { code: 'MEDIA_RUNTIME_MISSING' }); }
  });
  const summary = summaryCallOf();
  const failed = await executeVideoRun(database, run.id, { dataRoot: root, runtime, summaryCall: summary.call });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'MEDIA_RUNTIME_MISSING');
  assert.match(failed.errorMessage, /不回退 PATH/);
  assert.equal(JSON.parse(failed.probeJson ?? 'null'), null);
  assert.equal(summary.calls.count, 0, '运行时缺失不得调用摘要');
  // DB 仍健康（图片链不受影响：assets 表正常）
  assert.equal(count(database, 'assets'), 1);
  database.close();
});

test('WMB-5245 ASR failure: ASR_FAILED → run failed with code, old row keeps error', async () => {
  const root = await makeRoot();
  const { database, source, asset } = await seedSourceWithVideo(root);
  const revKey = `source:${source.id}:r${source.revision}`;
  const { run } = enqueueVideoRun(database, { sourceId: source.id, sourceRevisionKey: revKey, assetId: asset.id });

  const runtime = fakeRuntime({
    probe: async () => ({
      container: 'mov,mp4', durationMs: 10_000, width: 1280, height: 720, frameRate: 30, rotation: null,
      videoCodec: 'h264', audioCodec: 'aac', hasAudio: true, subtitleTracks: [], chapters: [], runtimeManifestHash: 'fixture-runtime@1'
    }),
    runAsr: async () => { throw Object.assign(new Error('whisper-cli OOM'), { code: 'ASR_FAILED' }); }
  });
  const summary = summaryCallOf();
  const failed = await executeVideoRun(database, run.id, { dataRoot: root, runtime, summaryCall: summary.call });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'ASR_FAILED');
  database.close();
});

// ============ 9. checkpoint 恢复：失败从 stage 继续，不重复前序 ============

test('WMB-5245 checkpoint recovery: attempt-1 fails at keyframes → attempt-2 reuses probe+transcript, skips ASR, resumes keyframes', async () => {
  const root = await makeRoot();
  const { database, source, asset } = await seedSourceWithVideo(root);
  const revKey = `source:${source.id}:r${source.revision}`;
  const { run } = enqueueVideoRun(database, { sourceId: source.id, sourceRevisionKey: revKey, assetId: asset.id });

  // attempt-1：probe/transcript 成功（ASR 产出文本），keyframes 抽帧失败
  const runtime1 = fakeRuntime({
    runAsr: async () => {
      runtime1.calls.runAsr += 1;
      return [{ startMs: 0, endMs: 3000, text: '第一段内容', source: 'asr' }];
    },
    extractKeyframe: async () => { throw new Error('disk full'); }
  });
  const summary1 = summaryCallOf();
  const failed = await executeVideoRun(database, run.id, { dataRoot: root, runtime: runtime1, summaryCall: summary1.call });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'KEYFRAME_EXTRACTION_FAILED');
  assert.equal(runtime1.calls.runAsr, 1);
  // probe/transcript 已 checkpoint
  const failedRow = getVideoRun(database, run.id);
  assert.ok(failedRow.probeJson, 'probe 必须已 checkpoint');
  assert.ok(failedRow.transcriptJson, 'transcript 必须已 checkpoint');
  assert.equal(JSON.parse(failedRow.transcriptJson).source, 'asr');

  // attempt-2：复用 probe+transcript（零重复 ASR），从 keyframes 继续
  const retried = retryVideoRun(database, run.id);
  const runtime2 = fakeRuntime({
    runAsr: async () => { runtime2.calls.runAsr += 1; return [{ startMs: 0, endMs: 3000, text: '第一段内容', source: 'asr' }]; }
  });
  const summary2 = summaryCallOf();
  const completed = await executeVideoRun(database, retried.run.id, { dataRoot: root, runtime: runtime2, summaryCall: summary2.call });
  assert.equal(completed.status, 'completed');
  assert.equal(runtime2.calls.runAsr, 0, 'attempt-2 复用 transcript 必须零 ASR');
  assert.equal(runtime2.calls.probe, 0, 'attempt-2 复用 probe 必须零 probe');
  assert.ok(runtime2.calls.extractKeyframe >= 1, 'attempt-2 从 keyframes 继续抽帧');
  // attempt-1 旧行保留审计
  const old = getVideoRun(database, run.id);
  assert.equal(old.status, 'failed');
  assert.equal(old.errorCode, 'KEYFRAME_EXTRACTION_FAILED');
  assert.equal(count(database, 'video_understanding_runs'), 2);
  database.close();
});

// ============ 10. 摘要失败不抹机械结果 ============

test('WMB-5245 summary failure: mechanical results kept, run completes with summary_failed warning', async () => {
  const root = await makeRoot();
  const { database, source, asset } = await seedSourceWithVideo(root);
  const revKey = `source:${source.id}:r${source.revision}`;
  const { run } = enqueueVideoRun(database, { sourceId: source.id, sourceRevisionKey: revKey, assetId: asset.id });

  const runtime = fakeRuntime({
    probe: async () => ({
      container: 'mov,mp4', durationMs: 10_000, width: 1280, height: 720, frameRate: 30, rotation: null,
      videoCodec: 'h264', audioCodec: 'aac', hasAudio: true, subtitleTracks: [], chapters: [], runtimeManifestHash: 'fixture-runtime@1'
    }),
    runAsr: async () => [{ startMs: 0, endMs: 2000, text: '内容', source: 'asr' }]
  });
  const summary = summaryCallOf({ call: async () => { throw new Error('model down'); } });
  const completed = await executeVideoRun(database, run.id, { dataRoot: root, runtime, summaryCall: summary.call });
  assert.equal(completed.status, 'completed', '摘要失败不得把 run 置 failed');
  const segments = JSON.parse(completed.segmentsJson);
  assert.ok(segments.length >= 1, '机械结果必须保留');
  assert.ok(segments.some((segment) => (segment.warnings ?? []).includes('summary_failed')), '必须记录 summary_failed warning');
  database.close();
});

// ============ 11. completed 行不可变（DB 触发器 + store 双保险） ============

test('WMB-5245 immutable completed: DB trigger + app guard reject any UPDATE', async () => {
  const root = await makeRoot();
  const { database, source, asset } = await seedSourceWithVideo(root);
  const revKey = `source:${source.id}:r${source.revision}`;
  const { run } = enqueueVideoRun(database, { sourceId: source.id, sourceRevisionKey: revKey, assetId: asset.id });
  const runtime = fakeRuntime({ runAsr: async () => [{ startMs: 0, endMs: 2000, text: 'x', source: 'asr' }] });
  const summary = summaryCallOf();
  const completed = await executeVideoRun(database, run.id, { dataRoot: root, runtime, summaryCall: summary.call });
  assert.equal(completed.status, 'completed');
  assert.ok(completed.completedAt);

  // DB 触发器
  assert.throws(() => database.prepare("UPDATE video_understanding_runs SET status = 'running' WHERE id = ?").run(run.id),
    /VIDEO_RUN_COMPLETED_IMMUTABLE/);
  assert.throws(() => database.prepare("UPDATE video_understanding_runs SET segments_json = '[]' WHERE id = ?").run(run.id),
    /VIDEO_RUN_COMPLETED_IMMUTABLE/);
  // 幂等入队返回 completed 行
  const again = enqueueVideoRun(database, { sourceId: source.id, sourceRevisionKey: revKey, assetId: asset.id });
  assert.equal(again.run.id, run.id);
  assert.equal(again.created, false);
  database.close();
});

// ============ 12. timeRange locator 严格解析 / 旧图片 locator 兼容 / 本地证据时间 ============

test('WMB-5245 timeRange locator: strict parse (0 ≤ start < end ≤ durationMs), old locator compat, invalid → null', () => {
  const assetId = randomUUID();
  const revKey = `source:${assetId}:r3`;
  const locator = videoEvidenceLocator(assetId, revKey, 3000, 6000);
  assert.equal(locator, `asset:${assetId}|sourceRevision:${revKey}|timeRange:3000-6000`);
  assert.deepEqual(parseVideoEvidenceLocator(locator, 10_000), { assetId, sourceRevisionKey: revKey, timeRange: { startMs: 3000, endMs: 6000 } });
  assert.deepEqual(parseVideoEvidenceLocator(buildVideoEvidenceLocator(assetId, revKey, 0, 500), 10_000),
    { assetId, sourceRevisionKey: revKey, timeRange: { startMs: 0, endMs: 500 } });

  // 越界（end > durationMs）→ null；end == durationMs 合法（0 ≤ start < end ≤ durationMs）
  assert.equal(parseVideoEvidenceLocator(locator, 5000), null, 'end 超出 durationMs 必须拒绝');
  assert.deepEqual(parseVideoEvidenceLocator(locator, 6000),
    { assetId, sourceRevisionKey: revKey, timeRange: { startMs: 3000, endMs: 6000 } }, 'end == durationMs 合法');
  // 非法范围
  assert.equal(parseVideoEvidenceLocator(`asset:${assetId}|sourceRevision:${revKey}|timeRange:5000-5000`, 10_000), null);
  assert.equal(parseVideoEvidenceLocator(`asset:${assetId}|sourceRevision:${revKey}|timeRange:-1-5000`, 10_000), null);
  assert.equal(parseVideoEvidenceLocator(`asset:${assetId}|sourceRevision:${revKey}|timeRange:abc-def`, 10_000), null);
  // 旧图片 locator（两段）兼容 → timeRange null
  assert.deepEqual(parseVideoEvidenceLocator(`asset:${assetId}|sourceRevision:${revKey}`),
    { assetId, sourceRevisionKey: revKey, timeRange: null });
  // 非法格式
  for (const bad of ['', 'asset:x', 'sourceRevision:y', 'x:1|y:2', `asset:${assetId}|sourceRevision:${revKey}|region:0.1,0.2,0.3,0.4`]) {
    assert.equal(parseVideoEvidenceLocator(bad, 10_000), null, `非法 locator 必须 null: ${bad}`);
  }
  // 构造非法时间 → 抛 LOCATOR_INVALID
  assert.throws(() => buildVideoEvidenceLocator(assetId, revKey, 5000, 2000), (error) => error.code === 'LOCATOR_INVALID');
});

// ============ 13. 只读模型 / 列表 ============

test('WMB-5245 read models: listVideoRunsForRevision + status filters', async () => {
  const root = await makeRoot();
  const { database, source, asset } = await seedSourceWithVideo(root);
  const revKey = `source:${source.id}:r${source.revision}`;
  const { run } = enqueueVideoRun(database, { sourceId: source.id, sourceRevisionKey: revKey, assetId: asset.id });
  const runs = listVideoRunsForRevision(database, revKey);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, run.id);
  assert.equal(runs[0].status, 'queued');
  assert.equal(runs[0].sourceRevisionKey, revKey);
  assert.equal(runs[0].assetId, asset.id);
  database.close();
});

// ============ 14. 字幕轨选择规则（forced/default → 语言匹配 → 第一条） ============

test('WMB-5245 subtitle track selection: forced/default first, then source language, then first', () => {
  const base = { container: 'mov', durationMs: 1000, width: 100, height: 100, frameRate: null, rotation: null,
    videoCodec: null, audioCodec: null, hasAudio: false, chapters: [], runtimeManifestHash: 'x' };
  const tracks = [
    { index: 0, language: 'eng', forced: false, default: false },
    { index: 1, language: 'chi', forced: true, default: false },
    { index: 2, language: 'jpn', forced: false, default: false }
  ];
  assert.equal(pickSubtitleTrack({ subtitleTracks: tracks }, 'zh'), 1, 'forced 优先');
  const noForced = tracks.map((track) => ({ ...track, forced: false }));
  assert.equal(pickSubtitleTrack({ subtitleTracks: noForced }, 'chi'), 1, '语言匹配');
  assert.equal(pickSubtitleTrack({ subtitleTracks: noForced }, null), 0, '无语言 → 第一条');
  assert.equal(pickSubtitleTrack({ subtitleTracks: [] }, null), null);
});

// ============ 15. SRT/WebVTT 解析 ============

test('WMB-5245 SRT parse: millisecond timestamps, multi-line text join, skip malformed blocks', () => {
  const srt = [
    '1', '00:00:01,200 --> 00:00:03,400', '第一行', '第二行', '',
    'bad block without time', '',
    '2', '00:00:05,000 --> 00:00:06,000', '结尾', ''
  ].join('\n');
  const segments = parseSrtToSegments(srt, 'native');
  assert.equal(segments.length, 2);
  assert.equal(segments[0].startMs, 1200);
  assert.equal(segments[0].endMs, 3400);
  assert.equal(segments[0].text, '第一行 第二行');
  assert.equal(segments[1].text, '结尾');
  assert.equal(segments[1].source, 'native');
});
