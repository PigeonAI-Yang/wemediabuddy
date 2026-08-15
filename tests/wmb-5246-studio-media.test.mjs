// WMB-5246 Studio 媒体工作流聚焦测试（StudioMediaWorkflow 所有）。
// 覆盖：
// - 共享绑定契约：mediaKind 默认 image / posterAssetId / clipRange（≤60s）/ durationMs 校验；
//   buildAssetIdsFromPlatformBindings 投影语义不变（derivedAssetId || assetId 按 ordinal）。
// - main 绑定读写：platform save 视频绑定写入 media_kind/poster/clip_range/duration_ms；
//   stagedClips 在保存事务内原子物化派生 Clip（asset + derived_clip 血缘 + 绑定回填 + 投影），
//   revision 冲突零写入（无孤儿 Clip）；旧图片项目行为不变（media_kind 默认 image）。
// - Studio 读模型：getContentProject.sourceMedia（来源图/视频/关键帧/Segment）+ mediaSuggestions
//   （直接证据 clip 建议 / 图片背景建议；restricted 不进入自动建议；表缺失防御降级为空）。
// - renderer：平台绑定草稿保留视频附件（sync 不因无正文引用而丢弃）、addVideoPlatformBinding、
//   setPlatformBindingClipRange/Poster、相等比较含新字段；StudioMediaSuggestions 渲染
//   建议卡片（理由/风险/关键帧/Segment；只读隐藏操作）。
// 数据测试全部使用真实 SQLite（migrateDatabase）+ production 函数，不做源码字符串断言。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { createContentProjectWithVersion, getContentProject, savePlatformVersion } from '../src/main/content.ts';
import { importAssetBytes, stageAssetBytes } from '../src/main/assets.ts';
import {
  buildAssetIdsFromPlatformBindings,
  isValidClipRange,
  normalizeContentMediaBindings,
  normalizePlatformMediaBindings
} from '../src/shared/media-bindings.ts';
import { sourceRevisionKey } from '../src/shared/media-candidates.ts';
import { readStudioMediaProjection } from '../src/main/studio-media-projection.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

const PNG_RED = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const FAKE_MP4 = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');
const shaOf = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function withDb(run) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'wmb-5246-studio-media-'));
  const database = migrateDatabase(path.join(rootDir, 'wmb.db'));
  try {
    await run(database, rootDir);
  } finally {
    database.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

async function addImageAsset(database, dataRoot, bytes = PNG_RED) {
  const result = await importAssetBytes(database, dataRoot, { bytes, fileName: 'img.png', mimeType: 'image/png', origin: 'test' });
  return result.id;
}

async function addVideoAsset(database, dataRoot, durationMs = 120_000) {
  const result = await importAssetBytes(database, dataRoot, { bytes: FAKE_MP4, fileName: 'clip.mp4', mimeType: 'video/mp4', origin: 'test' });
  database.prepare('UPDATE assets SET duration_ms = ? WHERE id = ?').run(durationMs, result.id);
  return result.id;
}

function insertSource(database, sourceId, title = '测试来源', revision = 1) {
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO source_items
    (id, original_url, canonical_url, title, collected_at, categories_json, keywords_json,
     recommended_platforms_json, recommended_formats_json, created_at, updated_at, revision)
    VALUES (?, ?, ?, ?, ?, '[]', '[]', '[]', '[]', ?, ?, ?)`)
    .run(sourceId, `https://example.com/${sourceId}`, `https://example.com/${sourceId}`, title, now, now, now, revision);
}

/** 插入 preserved 绑定（候选 + 绑定同 revision）；返回 bindingId。 */
function insertPreservedBinding(database, input) {
  const { sourceId, revisionKey, kind, ordinal, assetId, rightsStatus = 'unknown', riskFlags = [], caption = null } = input;
  const candidateId = `smc:${revisionKey}:${ordinal}:${kind}`;
  database.prepare(`INSERT INTO source_media_candidates
    (id, source_id, source_revision_key, kind, original_url, stable_remote_identity, channel, ordinal, status, discovered_at)
    VALUES (?, ?, ?, ?, ?, ?, 'research', ?, 'preserved', ?)`)
    .run(candidateId, sourceId, revisionKey, kind, `https://cdn.example.com/${ordinal}.jpg`, shaOf(`url-${ordinal}-${kind}`), ordinal, new Date().toISOString());
  const bindingId = `sbm:${candidateId}`;
  database.prepare(`INSERT INTO source_media_bindings
    (id, source_id, source_revision_key, candidate_id, asset_id, kind, ordinal, original_url, caption, sha256,
     captured_at, rights_status, risk_flags_json, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'test')`)
    .run(bindingId, sourceId, revisionKey, candidateId, assetId, kind, ordinal, `https://cdn.example.com/${ordinal}.jpg`,
      caption, shaOf(`asset-${assetId}`), new Date().toISOString(), rightsStatus, JSON.stringify(riskFlags), new Date().toISOString());
  return bindingId;
}

function insertVideoRun(database, input) {
  const { sourceId, revisionKey, assetId, status = 'completed', stage = 'summarize', keyframes, segments, probe } = input;
  database.prepare(`INSERT INTO video_understanding_runs
    (id, source_id, source_revision_key, asset_id, schema_version, attempt, status, stage, probe_json, keyframes_json, segments_json, created_at)
    VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?)`)
    .run(`vur:${revisionKey}:${assetId}:1:1`, sourceId, revisionKey, assetId, status, stage,
      probe ? JSON.stringify(probe) : null,
      keyframes ? JSON.stringify(keyframes) : null,
      segments ? JSON.stringify(segments) : null,
      new Date().toISOString());
}

function makeProject(database, sourceIds, body = '项目正文') {
  return createContentProjectWithVersion(database, {
    title: 'Studio 媒体测试项目',
    body,
    ...(sourceIds ? { sourceIds } : {})
  });
}

// ---------------------------------------------------------------------------
// 共享绑定契约：mediaKind / poster / clipRange / durationMs
// ---------------------------------------------------------------------------

test('WMB-5246 studio: shared normalizers default mediaKind to image and reject invalid values', () => {
  const imageDraft = normalizeContentMediaBindings([{ assetId: 'a', occurrence: 0, widthPreset: 'full', align: 'center' }]);
  assert.equal(imageDraft[0].mediaKind, 'image', '存量草稿缺省即图片语义');
  assert.throws(() => normalizeContentMediaBindings([{ assetId: 'a', occurrence: 0, widthPreset: 'full', align: 'center', mediaKind: 'audio' }]), /mediaKind 无效/);

  const platform = normalizePlatformMediaBindings([
    { assetId: 'video-a', ordinal: 0, mediaKind: 'video', posterAssetId: 'poster-1', clipRange: { startMs: 3000, endMs: 8000 }, durationMs: 5000 },
    { assetId: 'img-a', ordinal: 1 }
  ]);
  assert.equal(platform[0].mediaKind, 'video');
  assert.equal(platform[0].posterAssetId, 'poster-1');
  assert.deepEqual(platform[0].clipRange, { startMs: 3000, endMs: 8000 });
  assert.equal(platform[0].durationMs, 5000);
  assert.equal(platform[1].mediaKind, 'image', '未声明媒体种类默认图片');
});

test('WMB-5246 studio: isValidClipRange enforces ms integers, start<end and <=60s', () => {
  assert.equal(isValidClipRange({ startMs: 0, endMs: 60_000 }), true);
  assert.equal(isValidClipRange({ startMs: 1000, endMs: 61_000 }), true, '恰好 60 秒允许');
  assert.equal(isValidClipRange({ startMs: 1000, endMs: 61_001 }), false, '超过 60 秒拒绝');
  assert.equal(isValidClipRange({ startMs: 5000, endMs: 5000 }), false, 'end 必须大于 start');
  assert.equal(isValidClipRange({ startMs: -1, endMs: 5000 }), false, '负起始拒绝');
  assert.equal(isValidClipRange({ startMs: 1.5, endMs: 5000 }), false, '非整数毫秒拒绝');
  assert.equal(isValidClipRange(null), false);
});

test('WMB-5246 studio: platform normalizer rejects invalid clip/poster/duration and clip on non-video', () => {
  assert.throws(() => normalizePlatformMediaBindings([{ assetId: 'a', ordinal: 0, mediaKind: 'video', clipRange: { startMs: 0, endMs: 61_000 } }]), /clipRange 无效/);
  assert.throws(() => normalizePlatformMediaBindings([{ assetId: 'a', ordinal: 0, mediaKind: 'image', clipRange: { startMs: 0, endMs: 5000 } }]), /只能用于 video/);
  assert.throws(() => normalizePlatformMediaBindings([{ assetId: 'a', ordinal: 0, mediaKind: 'video', posterAssetId: '' }]), /posterAssetId 无效/);
  assert.throws(() => normalizePlatformMediaBindings([{ assetId: 'a', ordinal: 0, mediaKind: 'video', durationMs: 0 }]), /durationMs/);
  assert.throws(() => normalizePlatformMediaBindings([{ assetId: 'a', ordinal: 0, mediaKind: 'video', durationMs: 1.5 }]), /durationMs/);
});

test('WMB-5246 studio: asset_ids projection stays derivedAssetId || assetId by ordinal (video included)', () => {
  const ids = buildAssetIdsFromPlatformBindings([
    { assetId: 'video-a', ordinal: 1, derivedAssetId: 'clip-1', mediaKind: 'video' },
    { assetId: 'img-a', ordinal: 0, mediaKind: 'image' }
  ]);
  assert.deepEqual(ids, ['img-a', 'clip-1'], '投影取有效派生（clip）否则原 asset，按 ordinal');
});

// ---------------------------------------------------------------------------
// main：platform save 视频绑定写入 + stagedClips 原子物化 + 冲突零写
// ---------------------------------------------------------------------------

test('WMB-5246 studio: platform save writes video binding metadata and projection (no staged clips)', async () => {
  await withDb(async (database, dataRoot) => {
    const video = await addVideoAsset(database, dataRoot);
    const poster = await addImageAsset(database, dataRoot);
    const project = makeProject(database, []);
    const created = savePlatformVersion(database, {
      projectId: project.id,
      contentVersionId: project.contentVersionId,
      platform: 'x',
      format: 'text',
      body: '视频附件版本',
      mediaBindings: [
        { assetId: video, ordinal: 0, mediaKind: 'video', posterAssetId: poster, clipRange: { startMs: 10_000, endMs: 40_000 }, durationMs: 30_000 }
      ],
      transaction: true
    });
    assert.equal(created.ok, true);
    const row = database.prepare(`SELECT media_kind AS mediaKind, poster_asset_id AS posterAssetId,
      clip_range_json AS clipRangeJson, duration_ms AS durationMs FROM platform_media_bindings WHERE platform_version_id = ?`)
      .get(created.data.id);
    assert.equal(row.mediaKind, 'video');
    assert.equal(row.posterAssetId, poster);
    assert.equal(row.clipRangeJson, JSON.stringify({ startMs: 10_000, endMs: 40_000 }));
    assert.equal(row.durationMs, 30_000);
    const version = database.prepare('SELECT asset_ids_json AS assets FROM platform_versions WHERE id = ?').get(created.data.id);
    assert.deepEqual(JSON.parse(version.assets), [video], '视频绑定进入发布投影（无派生时取原 asset）');
    // 读模型回读
    const detail = getContentProject(database, project.id);
    const binding = detail.platformVersions.x[0].mediaBindings[0];
    assert.equal(binding.mediaKind, 'video');
    assert.equal(binding.posterAssetId, poster);
    assert.deepEqual(binding.clipRange, { startMs: 10_000, endMs: 40_000 });
    assert.equal(binding.durationMs, 30_000);
  });
});

test('WMB-5246 studio: platform save with stagedClips atomically materializes clip asset, provenance, binding and projection', async () => {
  await withDb(async (database, dataRoot) => {
    const video = await addVideoAsset(database, dataRoot);
    const project = makeProject(database, []);
    const staged = await stageAssetBytes(dataRoot, {
      // 与源视频字节不同，确保派生 Clip 注册为独立 asset（sha256 内容寻址，不误复用源视频）。
      bytes: Buffer.concat([FAKE_MP4, Buffer.from([7, 9])]), fileName: 'clip.mp4', mimeType: 'video/mp4', origin: 'test', durationMs: 5000
    });
    const stagedClip = {
      staged,
      sourceAssetId: video,
      startMs: 3000,
      endMs: 8000,
      codec: 'copy',
      copyOrTranscode: 'copy',
      durationMs: 5000,
      runtimeName: 'test-runtime',
      runtimeVersion: '1.0.0'
    };
    const created = savePlatformVersion(database, {
      projectId: project.id,
      contentVersionId: project.contentVersionId,
      platform: 'xiaohongshu',
      format: 'video',
      body: '视频片段版本',
      mediaBindings: [
        { assetId: video, ordinal: 0, mediaKind: 'video', clipRange: { startMs: 3000, endMs: 8000 }, durationMs: 5000 }
      ],
      stagedClips: [stagedClip],
      transaction: true
    });
    assert.equal(created.ok, true);
    const clipAssetId = stagedClip.staged.id;
    // 派生 asset + derived_clip 血缘（同事务）
    assert.ok(database.prepare('SELECT 1 FROM assets WHERE id = ?').get(clipAssetId), 'clip asset 注册');
    assert.ok(database.prepare("SELECT 1 FROM asset_provenance WHERE kind = 'derived_clip' AND source_asset_id = ? AND derived_asset_id = ?")
      .get(video, clipAssetId), 'derived_clip 血缘');
    // 绑定回填 derivedAssetId + 时长
    const row = database.prepare('SELECT derived_asset_id AS derivedAssetId, duration_ms AS durationMs, clip_range_json AS clipRangeJson FROM platform_media_bindings WHERE platform_version_id = ?')
      .get(created.data.id);
    assert.equal(row.derivedAssetId, clipAssetId);
    assert.equal(row.durationMs, 5000);
    assert.equal(row.clipRangeJson, JSON.stringify({ startMs: 3000, endMs: 8000 }));
    // 发布投影取派生 clip
    const version = database.prepare('SELECT asset_ids_json AS assets FROM platform_versions WHERE id = ?').get(created.data.id);
    assert.deepEqual(JSON.parse(version.assets), [clipAssetId]);
  });
});

test('WMB-5246 studio: platform save revision conflict with stagedClips writes nothing (no orphan clip)', async () => {
  await withDb(async (database, dataRoot) => {
    const video = await addVideoAsset(database, dataRoot);
    const project = makeProject(database, []);
    const first = savePlatformVersion(database, {
      projectId: project.id,
      contentVersionId: project.contentVersionId,
      platform: 'wechat',
      format: 'text',
      body: 'v1',
      mediaBindings: [{ assetId: video, ordinal: 0, mediaKind: 'video' }],
      transaction: true
    });
    assert.equal(first.ok, true);
    const clipAssetCountBefore = database.prepare('SELECT COUNT(*) AS count FROM assets').get().count;
    const staged = await stageAssetBytes(dataRoot, {
      bytes: FAKE_MP4, fileName: 'clip.mp4', mimeType: 'video/mp4', origin: 'test', durationMs: 5000
    });
    const conflict = savePlatformVersion(database, {
      projectId: project.id,
      contentVersionId: project.contentVersionId,
      platform: 'wechat',
      format: 'text',
      body: 'v2 冲突',
      id: first.data.id,
      expectedRevision: 999,
      mediaBindings: [
        { assetId: video, ordinal: 0, mediaKind: 'video', clipRange: { startMs: 3000, endMs: 8000 }, durationMs: 5000 }
      ],
      stagedClips: [{
        staged, sourceAssetId: video, startMs: 3000, endMs: 8000, codec: 'copy',
        copyOrTranscode: 'copy', durationMs: 5000, runtimeName: null, runtimeVersion: null
      }],
      transaction: true
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error.code, 'REVISION_CONFLICT');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM assets').get().count, clipAssetCountBefore, '冲突不产生孤儿 clip asset');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM asset_provenance WHERE kind = ?').get('derived_clip').count, 0);
    const binding = database.prepare('SELECT derived_asset_id AS derivedAssetId, clip_range_json AS clipRangeJson FROM platform_media_bindings WHERE platform_version_id = ?')
      .get(first.data.id);
    assert.equal(binding.derivedAssetId, null, '既有绑定未被部分写入');
    assert.equal(binding.clipRangeJson, null);
  });
});

test('WMB-5246 studio: legacy image-only project save keeps media_kind default image and projection unchanged', async () => {
  await withDb(async (database, dataRoot) => {
    const a = await addImageAsset(database, dataRoot, PNG_RED);
    const b = await addImageAsset(database, dataRoot, Buffer.concat([PNG_RED, Buffer.from([1])]));
    const project = makeProject(database, [], `![图A](wmb-asset://${a})\n\n![图B](wmb-asset://${b})`);
    const created = savePlatformVersion(database, {
      projectId: project.id,
      contentVersionId: project.contentVersionId,
      platform: 'x',
      format: 'image',
      body: '老图片项目',
      mediaBindings: [{ assetId: a, ordinal: 0, isCover: true }, { assetId: b, ordinal: 1 }],
      transaction: true
    });
    assert.equal(created.ok, true);
    const rows = database.prepare('SELECT asset_id AS assetId, ordinal, media_kind AS mediaKind FROM platform_media_bindings WHERE platform_version_id = ? ORDER BY ordinal')
      .all(created.data.id);
    assert.deepEqual(rows.map((row) => row.mediaKind), ['image', 'image'], '图片绑定默认 media_kind=image');
    const version = database.prepare('SELECT asset_ids_json AS assets FROM platform_versions WHERE id = ?').get(created.data.id);
    assert.deepEqual(JSON.parse(version.assets), [a, b], 'asset_ids 投影语义不变');
  });
});

// ---------------------------------------------------------------------------
// Studio 读模型：sourceMedia + mediaSuggestions（来源媒体 / 视频理解 / 建议）
// ---------------------------------------------------------------------------

test('WMB-5246 studio: getContentProject exposes sourceMedia with video keyframes/segments and revision keys', async () => {
  await withDb(async (database, dataRoot) => {
    const sourceId = 'src-1';
    insertSource(database, sourceId);
    const revisionKey = sourceRevisionKey(sourceId, 1);
    const imageAsset = await addImageAsset(database, dataRoot, PNG_RED);
    const videoAsset = await addVideoAsset(database, dataRoot, 120_000);
    const keyframeAsset = await addImageAsset(database, dataRoot, Buffer.concat([PNG_RED, Buffer.from([2])]));
    insertPreservedBinding(database, { sourceId, revisionKey, kind: 'image', ordinal: 0, assetId: imageAsset, caption: '基准成绩表' });
    insertPreservedBinding(database, { sourceId, revisionKey, kind: 'video', ordinal: 1, assetId: videoAsset, caption: '实测演示' });
    insertVideoRun(database, {
      sourceId, revisionKey, assetId: videoAsset,
      probe: { container: 'mp4', durationMs: 120_000, width: 1280, height: 720, frameRate: 30, rotation: null, videoCodec: 'h264', audioCodec: 'aac', hasAudio: true, subtitleTracks: [], chapters: [], runtimeManifestHash: 'abc' },
      keyframes: [{ timeMs: 0, width: 1280, height: 720, assetId: keyframeAsset, perceptionHash: null }],
      segments: [{
        index: 0, startMs: 3000, endMs: 8000, keyframeAssetId: keyframeAsset,
        transcript: [{ startMs: 3000, endMs: 8000, text: '实测结果明显领先', source: 'asr' }],
        transcriptSource: 'asr', ocrRegions: [], summary: '真实体验：实测结果明显领先', quoteRange: { startMs: 3000, endMs: 8000 },
        confidence: 0.9, warnings: []
      }]
    });
    const project = makeProject(database, [sourceId]);
    const detail = getContentProject(database, project.id);
    assert.equal(detail.sourceMedia.length, 2);
    const video = detail.sourceMedia.find((item) => item.kind === 'video');
    assert.ok(video, '视频绑定出现在 Studio 读模型');
    assert.equal(video.sourceRevisionKey, revisionKey, '媒体建议生成入参所需的 revision 键');
    assert.equal(video.video.runStatus, 'completed');
    assert.equal(video.video.keyframes.length, 1);
    assert.equal(video.video.keyframes[0].assetId, keyframeAsset);
    assert.equal(video.video.segments.length, 1);
    assert.equal(video.video.segments[0].summary, '真实体验：实测结果明显领先');
    assert.equal(video.video.segments[0].quoteRange.startMs, 3000);
  });
});

test('WMB-5246 studio: restricted media stays visible in read model (engine gates auto suggestions)', async () => {
  await withDb(async (database, dataRoot) => {
    const sourceId = 'src-restricted';
    insertSource(database, sourceId);
    const revisionKey = sourceRevisionKey(sourceId, 1);
    const imageAsset = await addImageAsset(database, dataRoot, PNG_RED);
    insertPreservedBinding(database, { sourceId, revisionKey, kind: 'image', ordinal: 0, assetId: imageAsset, rightsStatus: 'restricted', riskFlags: ['copyright'] });
    const projection = readStudioMediaProjection(database, { sourceIds: [sourceId] });
    assert.equal(projection.sourceMedia.length, 1, '受限媒体仍可在 Studio 展示为已保存素材（不进入自动建议由引擎保证）');
    assert.equal(projection.sourceMedia[0].rightsStatus, 'restricted');
    assert.deepEqual(projection.sourceMedia[0].riskFlags, ['copyright']);
  });
});

test('WMB-5246 studio: read model degrades to empty when media tables are missing (defensive)', async () => {
  await withDb(async (database, dataRoot) => {
    const sourceId = 'src-defensive';
    insertSource(database, sourceId);
    const imageAsset = await addImageAsset(database, dataRoot, PNG_RED);
    const revisionKey = sourceRevisionKey(sourceId, 1);
    insertPreservedBinding(database, { sourceId, revisionKey, kind: 'image', ordinal: 0, assetId: imageAsset });
    database.exec('DROP TABLE source_media_bindings');
    database.exec('DROP TABLE source_media_candidates');
    const project = makeProject(database, [sourceId]);
    const detail = getContentProject(database, project.id);
    assert.deepEqual(detail.sourceMedia, [], '表缺失 → 空数组，Studio 不崩');
  });
});

// ---------------------------------------------------------------------------
// renderer：平台绑定草稿保留视频附件 + 建议面板渲染（esbuild harness）
// ---------------------------------------------------------------------------

let tabs;
let suggestionsComponent;
let createElement;
let renderToStaticMarkup;
let harnessDir;

test.before(async () => {
  await mkdir(path.join(root, 'tmp'), { recursive: true });
  const dir = await mkdtemp(path.join(root, 'tmp', 'wmb-5246-harness-'));
  harnessDir = dir;
  const dompurifyStub = path.join(dir, 'dompurify-stub.mjs');
  await writeFile(dompurifyStub, 'export default { sanitize: (html) => html };\n', 'utf8');

  const tabsOut = path.join(dir, 'tabs.mjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'src/renderer/studio-platform-tabs.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: tabsOut,
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime'],
    logLevel: 'silent'
  });
  tabs = await import(pathToFileURL(tabsOut).href);

  const suggestionsOut = path.join(dir, 'suggestions.mjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'src/renderer/studio-media-suggestions.tsx')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: suggestionsOut,
    jsx: 'automatic',
    alias: { dompurify: dompurifyStub },
    external: ['react', 'react/jsx-runtime'],
    logLevel: 'silent'
  });
  suggestionsComponent = await import(pathToFileURL(suggestionsOut).href);

  ({ createElement } = await import('react'));
  ({ renderToStaticMarkup } = await import('react-dom/server'));
});

test.after(async () => {
  if (harnessDir) {
    await rm(harnessDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    harnessDir = null;
  }
});

const videoBinding = (overrides = {}) => ({
  assetId: 'video-a', ordinal: 0, caption: null, isCover: false, cropRegion: null, derivedAssetId: null,
  mediaKind: 'video', posterAssetId: null, clipRange: { startMs: 3000, endMs: 8000 }, durationMs: 5000,
  ...overrides
});

test('WMB-5246 studio: syncPlatformBindingsToRefs keeps video attachments and drops unreferenced images', () => {
  const refs = [{ assetId: 'img-a', occurrence: 0, alt: '图A', raw: '', start: 0, end: 0, altStart: 0, altEnd: 0 }];
  const current = [
    { assetId: 'img-gone', ordinal: 0, mediaKind: 'image' },
    videoBinding({ ordinal: 1 }),
    { assetId: 'img-a', ordinal: 2, mediaKind: 'image', isCover: true }
  ];
  const next = tabs.syncPlatformBindingsToRefs(current, refs);
  assert.deepEqual(next.map((binding) => binding.assetId), ['img-a', 'video-a'], '未引用的图片被移除，视频附件保留（数组顺序=正文序）');
  assert.equal(next.find((binding) => binding.assetId === 'img-a').isCover, true, '图片元数据保留');
  assert.equal(next.find((binding) => binding.assetId === 'video-a').clipRange.startMs, 3000, '视频时间段保留');
  // 发布序按 ordinal 稳定重排：video-a（原 ordinal 1）升到发布首位，img-a（原 ordinal 2）随后。
  assert.deepEqual([...next].sort((a, b) => a.ordinal - b.ordinal).map((binding) => binding.assetId), ['video-a', 'img-a'], '发布序稳定重排');
});

test('WMB-5246 studio: addVideoPlatformBinding appends/dedups and setPlatformBindingClipRange/Poster update only video', () => {
  const base = [{ assetId: 'img-a', ordinal: 0, mediaKind: 'image' }];
  const added = tabs.addVideoPlatformBinding(base, { assetId: 'video-a', posterAssetId: 'poster-1', clipRange: { startMs: 1000, endMs: 6000 } });
  assert.deepEqual(added.map((binding) => binding.assetId), ['img-a', 'video-a']);
  assert.equal(added[1].mediaKind, 'video');
  assert.equal(added[1].durationMs, 5000, 'append 自动补时长');
  // 幂等：同 asset 已存在 → 只更新元数据，不重复追加
  const again = tabs.addVideoPlatformBinding(added, { assetId: 'video-a', clipRange: { startMs: 2000, endMs: 7000 } });
  assert.equal(again.length, 2);
  assert.deepEqual(again[1].clipRange, { startMs: 2000, endMs: 7000 });
  // clip/poster 只作用 video 绑定
  const clip = tabs.setPlatformBindingClipRange(base, 'img-a', { startMs: 0, endMs: 5000 });
  assert.equal(clip[0].clipRange ?? null, null, '图片绑定不接受 clipRange');
  const poster = tabs.setPlatformBindingPoster(added, 'video-a', 'poster-2');
  assert.equal(poster[1].posterAssetId, 'poster-2');
});

test('WMB-5246 studio: platformMediaBindingsEqual detects poster/clip/kind changes', () => {
  const a = [videoBinding()];
  assert.equal(tabs.platformMediaBindingsEqual(a, [videoBinding()]), true);
  assert.equal(tabs.platformMediaBindingsEqual(a, [videoBinding({ posterAssetId: 'poster-x' })]), false);
  assert.equal(tabs.platformMediaBindingsEqual(a, [videoBinding({ clipRange: { startMs: 1000, endMs: 6000 } })]), false);
  assert.equal(tabs.platformMediaBindingsEqual(a, [videoBinding({ mediaKind: 'image' })]), false);
  assert.equal(tabs.platformMediaBindingsEqual(a, [videoBinding({ durationMs: 9000 })]), false);
});

test('WMB-5246 studio: StudioMediaSuggestions renders claims with rationale/risk/keyframes/segments and hides actions when readOnly', () => {
  const recommendation = {
    id: 'mrec:cv:1:0:c1:video-a:direct_evidence', contentVersionId: 'cv-1', projectId: 'p-1',
    claimKey: 'c1', claimExcerpt: '真实体验：实测结果明显领先', sourceId: 'src-1', sourceRevisionKey: 'source:src-1:r1',
    bindingId: 'sbm:1', assetId: 'video-a', mediaKind: 'video', purpose: 'direct_evidence', priority: 0,
    rationale: '该视频片段已完成时间轴理解，可引用。', caption: '实测演示',
    transform: { kind: 'clip', startMs: 3000, endMs: 8000 },
    provenance: 'asset:video-a|sourceRevision:source:src-1:r1|timeRange:3000-8000',
    rightsStatus: 'unknown', riskFlags: ['privacy', 'brand'],
    state: 'proposed', revision: 1, requestId: 'req-1',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    decidedAt: null, decidedBy: null, supersededAt: null, supersededBy: null
  };
  const readModel = {
    contentVersionId: 'cv-1', projectId: 'p-1',
    claims: [{ claimKey: 'c1', claimExcerpt: '真实体验：实测结果明显领先', suggestions: [recommendation] }],
    counts: { proposed: 1, accepted: 0, rejected: 0, superseded: 0 }
  };
  const sourceMedia = [{
    sourceId: 'src-1', sourceRevisionKey: 'source:src-1:r1', sourceTitle: 'DeepSeek 实测', bindingId: 'sbm:1', candidateId: 'smc:1', assetId: 'video-a',
    kind: 'video', ordinal: 0, originalUrl: 'https://x', caption: null, sha256: 'x', rightsStatus: 'unknown',
    riskFlags: ['privacy'], asset: { id: 'video-a', mimeType: 'video/mp4', byteCount: 1024, width: 1280, height: 720, durationMs: 120_000 },
    video: {
      runStatus: 'completed', stage: 'summarize', durationMs: 120_000, transcriptSource: 'asr',
      keyframes: [{ assetId: 'kf-1', timeMs: 3000, width: 1280, height: 720 }],
      segments: [{
        index: 0, startMs: 3000, endMs: 8000, keyframeAssetId: 'kf-1', summary: '实测结果明显领先',
        quoteRange: { startMs: 3000, endMs: 8000 }, confidence: 0.9, transcript: '实测结果明显领先',
        transcriptSource: 'asr', warnings: []
      }]
    }
  }];
  const element = createElement(suggestionsComponent.StudioMediaSuggestions, {
    readModel,
    sourceMedia,
    activePlatform: 'x',
    readOnlyVersion: true,
    busy: false,
    generating: false,
    onGenerate: () => {}, onAccept: () => {}, onReject: () => {}, onSeekVideo: () => {}
  });
  const html = renderToStaticMarkup(element);
  assert.ok(html.includes('直接证据'), '用途文案渲染');
  assert.ok(html.includes('该视频片段已完成时间轴理解'), '理由渲染');
  assert.ok(html.includes('隐私') && html.includes('品牌'), '风险标记渲染');
  assert.ok(html.includes('截取 0:03–0:08'), '建议变换（clip）渲染');
  assert.ok(html.includes('studio-suggestion-keyframe'), '关键帧渲染');
  assert.ok(!html.includes('>接受<'), '只读隐藏接受操作');
  assert.ok(!html.includes('>拒绝<'), '只读隐藏拒绝操作');
  assert.ok(html.includes('video'), '视频元素渲染');
});

test('WMB-5246 studio: StudioMediaSuggestions empty state offers generate button (editable only)', () => {
  const readModel = {
    contentVersionId: 'cv-1', projectId: 'p-1', claims: [],
    counts: { proposed: 0, accepted: 0, rejected: 0, superseded: 0 }
  };
  const editable = createElement(suggestionsComponent.StudioMediaSuggestions, {
    readModel, sourceMedia: [], activePlatform: null, readOnlyVersion: false, busy: false, generating: false,
    onGenerate: () => {}, onAccept: () => {}, onReject: () => {}, onSeekVideo: () => {}
  });
  assert.ok(renderToStaticMarkup(editable).includes('>生成建议<'), '可编辑态提供生成建议按钮');
  const readOnly = createElement(suggestionsComponent.StudioMediaSuggestions, {
    readModel, sourceMedia: [], activePlatform: null, readOnlyVersion: true, busy: false, generating: false,
    onGenerate: () => {}, onAccept: () => {}, onReject: () => {}, onSeekVideo: () => {}
  });
  assert.ok(!renderToStaticMarkup(readOnly).includes('>生成建议<'), '只读态隐藏生成建议按钮（提示文案保留）');
});
