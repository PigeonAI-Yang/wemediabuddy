// WMB-5246 非破坏派生（标注 / ≤60s 视频片段）—— 聚焦契约测试（Data agent 所有）。
// 覆盖（数据测试全部使用真实 SQLite migrateDatabase + production 函数，不做源码字符串断言）：
// - MediaSchema v64-66 消费：asset_provenance 派生 kind（derived_annotation/derived_keyframe/
//   derived_clip/derived_transcode）+ runtime_name/runtime_version；content/platform 绑定
//   media_kind / poster_asset_id / clip_range_json / duration_ms 可写；
// - 纯校验与命令构造：validateClipRange（负数/倒置/超 60s/越界/边界）、isAnnotationSpecValid、
//   buildClipCopyArgs / buildClipTranscodeArgs（确定性参数）、parseProbeJson（缺字段 fail-closed）；
// - materializeAnnotationAsset：原图字节不变、derived_annotation 血缘（transform 精确）、
//   同字节重放复用（reused=true、血缘不重复）、非法 spec 零写入；
// - materializeClipAsset（注入 MediaExecutor 桩）：copy 优先 → derived_clip 血缘
//   {startMs,endMs,codec:'copy',copyOrTranscode:'copy'} + 运行时身份；关键帧偏差超限回退
//   固定 H.264/AAC 转码 → derived_clip(copyOrTranscode:'transcode') + derived_transcode 血缘；
//   同输入重放复用；非法范围在任何写入（含 ffmpeg 调用）之前失败；时长缺失经 ffprobe 探测；
//   运行时缺失 MEDIA_RUNTIME_MISSING 且零写入；原视频字节不变；
// - 平台快照冻结派生字节：publication_snapshots.assets_json 冻结派生 Clip 的 id/sha256/字节，
//   原视频不在快照中；既有发布边界（asset_ids_json 投影 derivedAssetId || assetId）不变。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { registerStagedAsset, stageAssetBytes } from '../src/main/assets.ts';
import { createContentProjectWithVersion } from '../src/main/content.ts';
import { createPublicationSnapshot } from '../src/main/publication-operations.ts';
import {
  annotationKey, buildClipCopyArgs, buildClipTranscodeArgs, CLIP_COPY_DEVIATION_TOLERANCE_MS,
  clipKey, commitClipDerivation, insertDerivedProvenance, isAnnotationSpecValid,
  materializeAnnotationAsset, materializeClipAsset, MEDIA_RUNTIME_MISSING, mediaRuntimeVersion,
  parseProbeJson, stageClipAsset, validateClipRange
} from '../src/main/media-derivations.ts';

const shaOf = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** 确定性字节：同参数 → 同输出（模拟 ffmpeg 的确定性产物，供幂等重放断言）。 */
function deterministicBytes(args) {
  return Buffer.from(createHash('sha256').update(JSON.stringify(args)).digest());
}

async function withDb(run) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'wmb-5246-derive-'));
  const database = migrateDatabase(path.join(rootDir, 'wmb.db'));
  try {
    await run(database, rootDir);
  } finally {
    database.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

/** 构造视频源 Asset（sha256 命名、可设 durationMs），返回 {id, sha256, relativePath, bytes}。 */
async function addVideoAsset(database, dataRoot, { durationMs, mimeType = 'video/mp4' } = {}) {
  const bytes = Buffer.from(`video-bytes-${durationMs}-${Math.random()}`, 'utf8');
  const staged = await stageAssetBytes(dataRoot, { bytes, fileName: 'video.mp4', mimeType, origin: 'test', durationMs });
  const registered = registerStagedAsset(database, staged);
  return { id: registered.id, sha256: staged.sha256, relativePath: staged.relativePath, bytes };
}

function fakeRuntime(version = '8.1.2') {
  return {
    rootDir: '.',
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    manifest: {
      schemaVersion: 1,
      platform: 'win32-x64',
      cpu: true,
      components: [{ id: 'ffmpeg', version, sha256: `sha-${version}` }, { id: 'ffprobe', version }]
    },
    identity: `ffmpeg@${version}`
  };
}

/** MediaExecutor 桩：copy 输出起始偏差可配置；ffprobe 区分源/输出。 */
function fakeMediaExecutor({ sourcePath, sourceDurationMs, copyOutputStartMs = 0 }) {
  const calls = { ffmpeg: [], ffprobe: [] };
  return {
    calls,
    async ffmpeg(args) {
      calls.ffmpeg.push([...args]);
      const outPath = args[args.length - 1];
      await mkdir(path.dirname(outPath), { recursive: true });
      // 真实 ffmpeg（bitexact + 固定参数）输出字节只取决于输入与参数，不取决于随机 staging
      // 输出路径；桩必须排除末位输出路径再哈希，否则同参数重放会因 randomUUID 路径产生不同字节。
      await writeFile(outPath, deterministicBytes(args.slice(0, -1)));
      return { code: 0, stdout: '', stderr: '' };
    },
    async ffprobe(args) {
      calls.ffprobe.push([...args]);
      const target = args[args.length - 1];
      const isSource = target === sourcePath;
      const format = { duration: String(sourceDurationMs / 1000) };
      if (!isSource) format.start_time = String(copyOutputStartMs / 1000);
      return {
        code: 0,
        stdout: JSON.stringify({ format, streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' }] }),
        stderr: ''
      };
    }
  };
}

function countAssets(database) {
  return Number(database.prepare('SELECT COUNT(*) AS count FROM assets').get().count);
}

function countProvenance(database, kind) {
  return Number(database.prepare('SELECT COUNT(*) AS count FROM asset_provenance WHERE kind = ?').get(kind).count);
}

function provenanceRow(database, kind, sourceAssetId, derivedAssetId) {
  return database.prepare(`SELECT kind, source_asset_id AS sourceAssetId, derived_asset_id AS derivedAssetId,
    transform_json AS transformJson, origin, request_id AS requestId, runtime_name AS runtimeName, runtime_version AS runtimeVersion
    FROM asset_provenance WHERE kind = ? AND source_asset_id = ? AND derived_asset_id = ?`)
    .get(kind, sourceAssetId, derivedAssetId);
}

// ---------------------------------------------------------------------------
// 纯校验与命令构造
// ---------------------------------------------------------------------------

test('WMB-5246 derive: validateClipRange rejects negatives, inversion, >60s, out-of-range; accepts boundaries', () => {
  assert.equal(validateClipRange(5000, 20000, 30000), null, '合法范围');
  assert.equal(validateClipRange(0, 30000, 30000), null, 'end == duration 合法');
  assert.equal(validateClipRange(0, 60000, 60000), null, '恰好 60 秒合法');
  assert.match(validateClipRange(-1, 5000, 30000), /不能为负/);
  assert.match(validateClipRange(5000, 5000, 30000), /必须大于起始/);
  assert.match(validateClipRange(60000, 30000, 30000), /必须大于起始/);
  assert.match(validateClipRange(0, 60001, 60000), /不能超过 60 秒/);
  assert.match(validateClipRange(0, 61000, 30000), /不能超过 60 秒/);
  assert.match(validateClipRange(25000, 86000, 30000), /不能超过 60 秒/);
  assert.match(validateClipRange(5000, 35000, 30000), /超出原视频时长/);
  assert.match(validateClipRange(5000.5, 20000, 30000), /整数毫秒/);
});

test('WMB-5246 derive: isAnnotationSpecValid accepts valid spec, rejects malformed', () => {
  assert.equal(isAnnotationSpecValid({ annotationType: 'arrow', elements: [{ x: 0.5 }], width: 640, height: 360 }), true);
  assert.equal(isAnnotationSpecValid({ annotationType: '', elements: [], width: 1, height: 1 }), false);
  assert.equal(isAnnotationSpecValid({ annotationType: 'box', elements: 'not-array', width: 1, height: 1 }), false);
  assert.equal(isAnnotationSpecValid({ annotationType: 'box', elements: [], width: 0, height: 1 }), false);
  assert.equal(isAnnotationSpecValid({ annotationType: 'box', elements: [], width: 1.5, height: 1 }), false);
  assert.equal(isAnnotationSpecValid(null), false);
  assert.equal(isAnnotationSpecValid('arrow'), false);
});

test('WMB-5246 derive: clip commands are deterministic (copy: stream copy; transcode: fixed H.264/AAC, bitexact, threads 1)', () => {
  const copyArgs = buildClipCopyArgs({ sourcePath: 'src.mp4', startMs: 5000, durationMs: 10000, outputPath: 'out.mp4' });
  assert.equal(copyArgs.includes('-c'), true);
  assert.equal(copyArgs[copyArgs.indexOf('-c') + 1], 'copy', 'copy 模式必须 -c copy');
  assert.ok(copyArgs.includes('-ss') && copyArgs.includes('-t'));
  assert.ok(copyArgs.includes('+bitexact'), '确定性字节要求 bitexact');
  assert.ok(copyArgs.includes('-map_metadata'), '剥离容器元数据保证确定性');
  assert.deepEqual(copyArgs, buildClipCopyArgs({ sourcePath: 'src.mp4', startMs: 5000, durationMs: 10000, outputPath: 'out.mp4' }), '同参数逐字节同命令');

  const transcodeArgs = buildClipTranscodeArgs({ sourcePath: 'src.mp4', startMs: 5000, durationMs: 10000, outputPath: 'out.mp4' });
  assert.deepEqual(transcodeArgs, buildClipTranscodeArgs({ sourcePath: 'src.mp4', startMs: 5000, durationMs: 10000, outputPath: 'out.mp4' }));
  assert.ok(transcodeArgs.includes('libx264') && transcodeArgs.includes('aac'));
  assert.equal(transcodeArgs[transcodeArgs.indexOf('-threads') + 1], '1', '单线程保证 x264 位级确定');
  assert.ok(transcodeArgs.indexOf('-ss') > transcodeArgs.indexOf('-i'), '转码 -ss 在 -i 之后（帧精确）');
});

test('WMB-5246 derive: parseProbeJson fails closed on missing fields and invalid JSON', () => {
  assert.deepEqual(parseProbeJson(JSON.stringify({
    format: { duration: '12.345', start_time: '0.5' },
    streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' }]
  })), { durationMs: 12345, startMs: 500, videoStreams: [{ codecName: 'h264' }] });
  assert.equal(parseProbeJson('not-json').durationMs, null);
  assert.equal(parseProbeJson(JSON.stringify({ format: {} })).durationMs, null);
  assert.equal(parseProbeJson(JSON.stringify({ format: { duration: 'abc' } })).durationMs, null);
  assert.deepEqual(parseProbeJson(JSON.stringify({ streams: [] })).videoStreams, []);
  const audioOnly = parseProbeJson(JSON.stringify({ format: { duration: '5' }, streams: [{ index: 0, codec_type: 'audio' }] }));
  assert.equal(audioOnly.videoStreams.length, 0, '无视频轨如实为空');
});

test('WMB-5246 derive: runtime identity derives from lock ffmpeg component version', () => {
  assert.equal(mediaRuntimeVersion({ components: [{ id: 'ffmpeg', version: '8.1.2' }, { id: 'whisper-cli', version: 'v1.9.2' }] }), '8.1.2');
  assert.equal(mediaRuntimeVersion(null), null);
  assert.equal(mediaRuntimeVersion({ schemaVersion: 1 }), null);
  assert.equal(mediaRuntimeVersion({ components: [{ id: 'whisper-cli', version: 'v1.9.2' }] }), null);
});

// ---------------------------------------------------------------------------
// 标注派生
// ---------------------------------------------------------------------------

const PNG_RED = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
// 与 PNG_RED 字节不同的 1x1 蓝 PNG：标注输出字节必须与源字节不同，
// 否则 sha256 内容寻址会把派生直接映射回源 Asset（退化空变换路径，见 commit 内守卫）。
const PNG_BLUE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC',
  'base64'
);
const SPEC = { annotationType: 'arrow', elements: [{ x: 0.25, y: 0.5 }, { color: '#ff0000' }], width: 1, height: 1 };

test('WMB-5246 derive: annotation materializes derived asset + provenance, original bytes unchanged', async () => {
  await withDb(async (database, dataRoot) => {
    const sourceStaged = await stageAssetBytes(dataRoot, { bytes: PNG_RED, fileName: 'source.png', mimeType: 'image/png', origin: 'test' });
    const source = registerStagedAsset(database, sourceStaged);
    const sourcePath = path.join(dataRoot, ...sourceStaged.relativePath.split('/'));
    const before = await readFile(sourcePath);

    const result = await materializeAnnotationAsset(database, dataRoot, {
      sourceAssetId: source.id, annotationSpec: SPEC, bytes: PNG_BLUE, origin: 'studio-annotation', requestId: 'req-1'
    });
    assert.equal(result.reused, false);
    assert.equal(shaOf(PNG_BLUE), result.sha256);
    const derived = database.prepare('SELECT id, relative_path AS relativePath FROM assets WHERE id = ?').get(result.assetId);
    assert.ok(derived, '派生 asset 已注册');
    const prov = provenanceRow(database, 'derived_annotation', source.id, result.assetId);
    assert.ok(prov, 'derived_annotation 血缘行存在');
    const transform = JSON.parse(prov.transformJson);
    assert.deepEqual(transform, { annotationType: 'arrow', elements: SPEC.elements, width: 1, height: 1 });
    assert.equal(prov.requestId, 'req-1');
    assert.equal(prov.runtimeName, null);
    assert.equal(prov.runtimeVersion, null);
    assert.equal(await readFile(sourcePath).then((b) => b.equals(before)), true, '原图字节不变');
    assert.equal(await readFile(path.join(dataRoot, ...derived.relativePath.split('/'))).then((b) => b.equals(PNG_BLUE)), true, '派生字节与输入一致');
  });
});

test('WMB-5246 derive: annotation replay reuses asset and provenance idempotently', async () => {
  await withDb(async (database, dataRoot) => {
    const source = registerStagedAsset(database, await stageAssetBytes(dataRoot, { bytes: PNG_RED, fileName: 'source.png', mimeType: 'image/png', origin: 'test' }));
    const first = await materializeAnnotationAsset(database, dataRoot, { sourceAssetId: source.id, annotationSpec: SPEC, bytes: PNG_BLUE, origin: 'studio-annotation' });
    const second = await materializeAnnotationAsset(database, dataRoot, { sourceAssetId: source.id, annotationSpec: SPEC, bytes: PNG_BLUE, origin: 'studio-annotation' });
    assert.equal(second.assetId, first.assetId, '同字节重放复用同一派生 asset');
    assert.equal(second.reused, true);
    assert.equal(countProvenance(database, 'derived_annotation'), 1, '血缘行不重复');
    assert.equal(countAssets(database), 2, '源 + 派生恰两行');
  });
});

test('WMB-5246 derive: annotation identical-to-source bytes never write self-loop provenance', async () => {
  await withDb(async (database, dataRoot) => {
    const source = registerStagedAsset(database, await stageAssetBytes(dataRoot, { bytes: PNG_RED, fileName: 'source.png', mimeType: 'image/png', origin: 'test' }));
    const first = await materializeAnnotationAsset(database, dataRoot, { sourceAssetId: source.id, annotationSpec: SPEC, bytes: PNG_RED, origin: 'studio-annotation' });
    // 退化空变换：内容寻址命中源 Asset 自身；不写 derived_asset_id == source_asset_id 自环血缘。
    assert.equal(first.assetId, source.id, '同字节派生指向源 Asset');
    assert.equal(first.reused, true);
    assert.equal(countProvenance(database, 'derived_annotation'), 0, '不写自环血缘');
    assert.equal(countAssets(database), 1, '零新增 asset');
    const second = await materializeAnnotationAsset(database, dataRoot, { sourceAssetId: source.id, annotationSpec: SPEC, bytes: PNG_RED, origin: 'studio-annotation' });
    assert.equal(second.assetId, source.id, '重放同样幂等');
    assert.equal(countProvenance(database, 'derived_annotation'), 0);
    assert.equal(countAssets(database), 1);
  });
});

test('WMB-5246 derive: annotation invalid spec / non-image source fails before any write', async () => {
  await withDb(async (database, dataRoot) => {
    const source = registerStagedAsset(database, await stageAssetBytes(dataRoot, { bytes: PNG_RED, fileName: 'source.png', mimeType: 'image/png', origin: 'test' }));
    const beforeCount = countAssets(database);
    await assert.rejects(
      materializeAnnotationAsset(database, dataRoot, { sourceAssetId: source.id, annotationSpec: { annotationType: '', elements: [], width: 1, height: 1 }, bytes: PNG_BLUE, origin: 'studio-annotation' }),
      /annotationSpec 无效/
    );
    assert.equal(countAssets(database), beforeCount, '非法 spec 零新增 asset');
    assert.equal(countProvenance(database, 'derived_annotation'), 0);
    const video = registerStagedAsset(database, await stageAssetBytes(dataRoot, { bytes: Buffer.from('v'), fileName: 'v.mp4', mimeType: 'video/mp4', origin: 'test', durationMs: 10000 }));
    await assert.rejects(
      materializeAnnotationAsset(database, dataRoot, { sourceAssetId: video.id, annotationSpec: SPEC, bytes: PNG_BLUE, origin: 'studio-annotation' }),
      /源素材不是图片/
    );
    assert.equal(countAssets(database), beforeCount + 1, '非图片源零新增 asset（仅 fixture 视频一行）');
    assert.equal(countProvenance(database, 'derived_annotation'), 0);
  });
});

// ---------------------------------------------------------------------------
// Clip 派生：copy 优先 / 转码回退 / 幂等 / 非法输入零写 / 运行时缺失
// ---------------------------------------------------------------------------

test('WMB-5246 derive: clip prefers stream copy and records exact provenance with runtime identity', async () => {
  await withDb(async (database, dataRoot) => {
    const source = await addVideoAsset(database, dataRoot, { durationMs: 30_000 });
    const sourcePath = path.join(dataRoot, ...source.relativePath.split('/'));
    const before = await readFile(sourcePath);
    const executor = fakeMediaExecutor({ sourcePath, sourceDurationMs: 30_000, copyOutputStartMs: 5_000 });

    const result = await materializeClipAsset(database, dataRoot, {
      sourceAssetId: source.id, startMs: 5_000, endMs: 15_000, origin: 'studio-clip', requestId: 'clip-req-1'
    }, { executor, runtime: fakeRuntime() });

    assert.equal(result.copyOrTranscode, 'copy');
    assert.equal(result.codec, 'copy');
    assert.equal(result.durationMs, 10_000);
    assert.equal(executor.calls.ffmpeg.length, 1, 'copy 成功时不执行转码');
    assert.equal(executor.calls.ffmpeg[0].includes('libx264'), false);
    const prov = provenanceRow(database, 'derived_clip', source.id, result.assetId);
    assert.ok(prov, 'derived_clip 血缘行存在');
    assert.deepEqual(JSON.parse(prov.transformJson), { startMs: 5_000, endMs: 15_000, codec: 'copy', copyOrTranscode: 'copy' });
    assert.equal(prov.runtimeName, 'media-runtime');
    assert.equal(prov.runtimeVersion, '8.1.2');
    assert.equal(prov.requestId, 'clip-req-1');
    assert.equal(countProvenance(database, 'derived_transcode'), 0, 'copy 模式不写转码血缘');
    assert.equal(await readFile(sourcePath).then((b) => b.equals(before)), true, '原视频字节不变');
  });
});

test('WMB-5246 derive: clip falls back to deterministic transcode when copy misses keyframe boundary, provenance records both', async () => {
  await withDb(async (database, dataRoot) => {
    const source = await addVideoAsset(database, dataRoot, { durationMs: 60_000 });
    const sourcePath = path.join(dataRoot, ...source.relativePath.split('/'));
    const executor = fakeMediaExecutor({ sourcePath, sourceDurationMs: 60_000, copyOutputStartMs: 5_000 + CLIP_COPY_DEVIATION_TOLERANCE_MS + 2_000 });

    const result = await materializeClipAsset(database, dataRoot, {
      sourceAssetId: source.id, startMs: 5_000, endMs: 15_000, origin: 'studio-clip'
    }, { executor, runtime: fakeRuntime('test-2.0.0') });

    assert.equal(result.copyOrTranscode, 'transcode');
    assert.equal(result.codec, 'h264');
    assert.equal(executor.calls.ffmpeg.length, 2, 'copy 尝试 + 转码回退各一次');
    assert.equal(executor.calls.ffmpeg[1].includes('libx264'), true);
    const clipProv = provenanceRow(database, 'derived_clip', source.id, result.assetId);
    assert.deepEqual(JSON.parse(clipProv.transformJson), { startMs: 5_000, endMs: 15_000, codec: 'h264', copyOrTranscode: 'transcode' });
    const transcodeProv = provenanceRow(database, 'derived_transcode', source.id, result.assetId);
    assert.ok(transcodeProv, '转码血缘行存在');
    assert.deepEqual(JSON.parse(transcodeProv.transformJson), { codec: 'h264', bitrate: '128k', container: 'mp4' });
    assert.equal(transcodeProv.runtimeVersion, 'test-2.0.0');
  });
});

test('WMB-5246 derive: clip replay reuses asset and provenance (copy path)', async () => {
  await withDb(async (database, dataRoot) => {
    const source = await addVideoAsset(database, dataRoot, { durationMs: 30_000 });
    const sourcePath = path.join(dataRoot, ...source.relativePath.split('/'));
    const executor = fakeMediaExecutor({ sourcePath, sourceDurationMs: 30_000, copyOutputStartMs: 5_000 });
    const options = { executor, runtime: fakeRuntime() };
    const first = await materializeClipAsset(database, dataRoot, { sourceAssetId: source.id, startMs: 5_000, endMs: 15_000, origin: 'studio-clip' }, options);
    const second = await materializeClipAsset(database, dataRoot, { sourceAssetId: source.id, startMs: 5_000, endMs: 15_000, origin: 'studio-clip' }, options);
    assert.equal(second.assetId, first.assetId, '同输入重放复用同一派生 asset');
    assert.equal(second.reused, true);
    assert.equal(second.sha256, first.sha256);
    assert.equal(countProvenance(database, 'derived_clip'), 1, '血缘行不重复');
    assert.equal(countProvenance(database, 'derived_transcode'), 0);
  });
});

test('WMB-5246 derive: invalid clip ranges fail before any write or ffmpeg call', async () => {
  await withDb(async (database, dataRoot) => {
    const source = await addVideoAsset(database, dataRoot, { durationMs: 10_000 });
    const sourcePath = path.join(dataRoot, ...source.relativePath.split('/'));
    const executor = fakeMediaExecutor({ sourcePath, sourceDurationMs: 10_000 });
    const beforeCount = countAssets(database);
    const options = { executor, runtime: fakeRuntime() };
    const cases = [
      { startMs: -1, endMs: 5_000 },
      { startMs: 5_000, endMs: 5_000 },
      { startMs: 5_000, endMs: 3_000 },
      { startMs: 0, endMs: 10_001 },
      { startMs: 0, endMs: 61_000 },
      { startMs: 1.5, endMs: 5_000 }
    ];
    for (const input of cases) {
      await assert.rejects(
        materializeClipAsset(database, dataRoot, { sourceAssetId: source.id, ...input, origin: 'studio-clip' }, options),
        undefined,
        `范围应被拒绝: ${JSON.stringify(input)}`
      );
    }
    assert.equal(countAssets(database), beforeCount, '非法范围零新增 asset');
    assert.equal(countProvenance(database, 'derived_clip'), 0);
    assert.equal(countProvenance(database, 'derived_transcode'), 0);
    assert.equal(executor.calls.ffmpeg.length, 0, '校验在任何 ffmpeg 调用之前完成');
    assert.equal(executor.calls.ffprobe.length, 0, 'durationMs 已知时不触发探测');
  });
});

test('WMB-5246 derive: missing duration probes via ffprobe then validates (invalid range → zero write)', async () => {
  await withDb(async (database, dataRoot) => {
    const source = await addVideoAsset(database, dataRoot, { durationMs: null });
    const sourcePath = path.join(dataRoot, ...source.relativePath.split('/'));
    const executor = fakeMediaExecutor({ sourcePath, sourceDurationMs: 20_000 });
    const beforeCount = countAssets(database);
    await assert.rejects(
      materializeClipAsset(database, dataRoot, { sourceAssetId: source.id, startMs: 0, endMs: 25_000, origin: 'studio-clip' }, { executor, runtime: fakeRuntime() }),
      /超出原视频时长/
    );
    assert.equal(executor.calls.ffprobe.length, 1, '缺失时长时经 ffprobe 探测');
    assert.equal(executor.calls.ffmpeg.length, 0, '越界范围不触达 ffmpeg');
    assert.equal(countAssets(database), beforeCount);
    assert.equal(countProvenance(database, 'derived_clip'), 0);

    const valid = await materializeClipAsset(database, dataRoot, { sourceAssetId: source.id, startMs: 1_000, endMs: 5_000, origin: 'studio-clip' }, { executor, runtime: fakeRuntime() });
    assert.equal(valid.copyOrTranscode, 'copy');
    assert.equal(countProvenance(database, 'derived_clip'), 1);
  });
});

test('WMB-5246 derive: missing runtime is MEDIA_RUNTIME_MISSING with zero writes, no PATH fallback', async () => {
  const previous = process.env.WMB_MEDIA_RUNTIME_ROOT;
  process.env.WMB_MEDIA_RUNTIME_ROOT = path.join(os.tmpdir(), `wmb-no-runtime-${Date.now()}`);
  try {
    await withDb(async (database, dataRoot) => {
      const source = await addVideoAsset(database, dataRoot, { durationMs: 30_000 });
      const beforeCount = countAssets(database);
      const error = await materializeClipAsset(database, dataRoot, {
        sourceAssetId: source.id, startMs: 0, endMs: 5_000, origin: 'studio-clip'
      }).then(() => null, (e) => e);
      assert.ok(error, '必须抛出运行时缺失');
      assert.equal(error.code, MEDIA_RUNTIME_MISSING);
      assert.equal(countAssets(database), beforeCount, '运行时缺失零新增 asset');
      assert.equal(countProvenance(database, 'derived_clip'), 0);
      assert.equal(countProvenance(database, 'derived_transcode'), 0);
    });
  } finally {
    if (previous === undefined) delete process.env.WMB_MEDIA_RUNTIME_ROOT;
    else process.env.WMB_MEDIA_RUNTIME_ROOT = previous;
  }
});

test('WMB-5246 derive: stageClipAsset + commitClipDerivation split works for in-transaction accept flows', async () => {
  await withDb(async (database, dataRoot) => {
    const source = await addVideoAsset(database, dataRoot, { durationMs: 30_000 });
    const sourcePath = path.join(dataRoot, ...source.relativePath.split('/'));
    const executor = fakeMediaExecutor({ sourcePath, sourceDurationMs: 30_000, copyOutputStartMs: 2_000 });
    // staging（无 DB 写）
    const stagedClip = await stageClipAsset(database, dataRoot, { sourceAssetId: source.id, startMs: 2_000, endMs: 8_000, origin: 'studio-clip' }, { executor, runtime: fakeRuntime() });
    assert.equal(countAssets(database), 1, 'staging 阶段无 DB 写');
    assert.equal(countProvenance(database, 'derived_clip'), 0);
    assert.equal(stagedClip.copyOrTranscode, 'copy');
    // 调用方事务内提交
    database.exec('BEGIN IMMEDIATE');
    try {
      const committed = commitClipDerivation(database, stagedClip.staged, {
        sourceAssetId: source.id, startMs: 2_000, endMs: 8_000, origin: 'studio-clip', mode: stagedClip.copyOrTranscode,
        codec: stagedClip.codec, runtimeName: stagedClip.runtimeName, runtimeVersion: stagedClip.runtimeVersion
      });
      database.exec('COMMIT');
      assert.equal(committed.reused, false);
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    assert.equal(countAssets(database), 2);
    assert.equal(countProvenance(database, 'derived_clip'), 1);
  });
});

// ---------------------------------------------------------------------------
// 绑定列消费 + 平台快照冻结派生字节
// ---------------------------------------------------------------------------

test('WMB-5246 derive: binding schema accepts media_kind / poster_asset_id / clip_range_json / duration_ms', async () => {
  await withDb(async (database, dataRoot) => {
    const source = await addVideoAsset(database, dataRoot, { durationMs: 30_000 });
    const poster = registerStagedAsset(database, await stageAssetBytes(dataRoot, { bytes: PNG_RED, fileName: 'poster.png', mimeType: 'image/png', origin: 'test' }));
    const now = new Date().toISOString();
    const project = createContentProjectWithVersion(database, { title: 'clip 项目', body: '正文' });
    const contentVersionId = database.prepare('SELECT id FROM content_versions WHERE project_id = ? ORDER BY version_number DESC LIMIT 1').get(project.id).id;
    database.prepare(`INSERT INTO platform_versions (id, project_id, content_version_id, platform, format, title, body, asset_ids_json, created_at, updated_at, revision)
      VALUES (?, ?, ?, 'x', 'video', NULL, '', '[]', ?, ?, 1)`).run('pv-video', project.id, contentVersionId, now, now);
    database.prepare(`INSERT INTO content_media_bindings (id, content_version_id, asset_id, ordinal, occurrence, width_preset, align, caption, link_url, media_kind, created_at, updated_at)
      VALUES (?, ?, ?, 0, 0, 'full', 'center', NULL, NULL, 'video', ?, ?)`)
      .run(randomId(), contentVersionId, source.id, now, now);
    database.prepare(`INSERT INTO platform_media_bindings (id, platform_version_id, asset_id, ordinal, caption, is_cover, crop_region_json, derived_asset_id, media_kind, poster_asset_id, clip_range_json, duration_ms, created_at, updated_at)
      VALUES (?, ?, ?, 0, NULL, 0, NULL, NULL, 'video', ?, ?, 10000, ?, ?)`)
      .run(randomId(), 'pv-video', source.id, poster.id, JSON.stringify({ startMs: 2000, endMs: 12000 }), now, now);
    const contentRow = database.prepare('SELECT media_kind AS mediaKind FROM content_media_bindings WHERE asset_id = ?').get(source.id);
    assert.equal(contentRow.mediaKind, 'video');
    const platformRow = database.prepare(`SELECT media_kind AS mediaKind, poster_asset_id AS posterAssetId, clip_range_json AS clipRangeJson, duration_ms AS durationMs
      FROM platform_media_bindings WHERE platform_version_id = ?`).get('pv-video');
    assert.equal(platformRow.mediaKind, 'video');
    assert.equal(platformRow.posterAssetId, poster.id);
    assert.deepEqual(JSON.parse(platformRow.clipRangeJson), { startMs: 2000, endMs: 12000 });
    assert.equal(platformRow.durationMs, 10000);
  });
});

function randomId() {
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

test('WMB-5246 derive: publication snapshot freezes derived clip bytes; original video absent; publish boundary unchanged', async () => {
  await withDb(async (database, dataRoot) => {
    // 源视频 + 派生 Clip（copy 路径）
    const source = await addVideoAsset(database, dataRoot, { durationMs: 30_000 });
    const sourcePath = path.join(dataRoot, ...source.relativePath.split('/'));
    const executor = fakeMediaExecutor({ sourcePath, sourceDurationMs: 30_000, copyOutputStartMs: 5_000 });
    const clip = await materializeClipAsset(database, dataRoot, {
      sourceAssetId: source.id, startMs: 5_000, endMs: 15_000, origin: 'studio-clip'
    }, { executor, runtime: fakeRuntime() });
    const clipAsset = database.prepare('SELECT id, sha256, byte_count AS byteCount FROM assets WHERE id = ?').get(clip.assetId);
    const clipBytes = await readFile(path.join(dataRoot, ...database.prepare('SELECT relative_path AS relativePath FROM assets WHERE id = ?').get(clip.assetId).relativePath.split('/')));

    // 平台版本（视频附件绑定：asset_ids_json 投影 = derived clip id）
    const now = new Date().toISOString();
    const project = createContentProjectWithVersion(database, { title: '快照项目', body: '正文' });
    const contentVersionId = database.prepare('SELECT id FROM content_versions WHERE project_id = ? ORDER BY version_number DESC LIMIT 1').get(project.id).id;
    database.prepare(`INSERT INTO platform_versions (id, project_id, content_version_id, platform, format, title, body, asset_ids_json, created_at, updated_at, revision)
      VALUES (?, ?, ?, 'x', 'video', NULL, '', ?, ?, ?, 1)`).run('pv-clip', project.id, contentVersionId, JSON.stringify([clip.assetId]), now, now);
    database.prepare(`INSERT INTO platform_accounts (id, platform, account_key, display_name, login_state, evidence_url, created_at, updated_at, revision, browser_profile_id, browser_binding_revision)
      VALUES (?, 'x', '@test', 'Test', 'authenticated', NULL, ?, ?, 1, 'profile-1', 1)`)
      .run('acct-x', now, now);
    database.prepare(`INSERT INTO workspace_browser_bindings (id, profile_id, binding_revision, state, expected_account_snapshot_json, created_at, updated_at)
      VALUES ('effective', 'profile-1', 1, 'verified', ?, ?, ?)`)
      .run(JSON.stringify({ x: { accountKey: '@test', browserProfileId: 'profile-1', browserBindingRevision: 1, accountRevision: 1 } }), now, now);
    database.prepare(`INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', 'ws-test', ?, ?, 1)`).run(now, now);

    const outcome = createPublicationSnapshot(database, {
      platformVersionId: 'pv-clip',
      accountId: 'acct-x',
      browserProfileId: 'profile-1',
      browserBindingRevision: 1,
      workspaceId: 'ws-test',
      runtimeEpoch: 'epoch-1',
      payload: { title: null, body: '', assets: [{ id: clip.assetId, sha256: clip.sha256 }], sourceTitle: null, sourceBody: '' },
      causation: { actor: 'test' }
    });
    assert.equal(outcome.ok, true, `快照创建应成功: ${outcome.error?.message ?? ''}`);
    const snapshot = outcome.data.snapshot;
    assert.equal(snapshot.payload.format, 'video');
    assert.equal(snapshot.assets.length, 1, '快照只冻结派生附件');
    assert.equal(snapshot.assets[0].id, clip.assetId);
    assert.equal(snapshot.assets[0].sha256, clipAsset.sha256);
    assert.equal(snapshot.assets[0].byteCount, clipBytes.byteLength, '快照冻结派生字节数');
    assert.equal(snapshot.assets.some((asset) => asset.id === source.id), false, '原视频不在发布快照中');
    assert.equal(shaOf(clipBytes), clipAsset.sha256, '快照 sha256 与派生字节一致');
  });
});

test('WMB-5246 derive: derivation identity keys are deterministic; insertDerivedProvenance is idempotent', async () => {
  const spec = { annotationType: 'box', elements: [{ x: 0.1 }], width: 640, height: 360 };
  assert.equal(annotationKey('a1', spec), annotationKey('a1', spec));
  assert.notEqual(annotationKey('a1', spec), annotationKey('a2', spec));
  assert.notEqual(annotationKey('a1', spec), annotationKey('a1', { ...spec, annotationType: 'arrow' }));
  assert.equal(clipKey('a1', 1000, 5000), clipKey('a1', 1000, 5000));
  assert.notEqual(clipKey('a1', 1000, 5000), clipKey('a1', 1000, 5001));

  await withDb(async (database, dataRoot) => {
    const source = await addVideoAsset(database, dataRoot, { durationMs: 30_000 });
    const clip = await materializeClipAsset(database, dataRoot, {
      sourceAssetId: source.id, startMs: 1_000, endMs: 5_000, origin: 'studio-clip'
    }, { executor: fakeMediaExecutor({ sourcePath: path.join(dataRoot, ...source.relativePath.split('/')), sourceDurationMs: 30_000, copyOutputStartMs: 1_000 }), runtime: fakeRuntime() });
    // 直接重复调用同一 (kind, source, derived)：UNIQUE 保证第二行不落。
    insertDerivedProvenance(database, {
      kind: 'derived_clip', sourceAssetId: source.id, derivedAssetId: clip.assetId,
      transformJson: { startMs: 1_000, endMs: 5_000, codec: 'copy', copyOrTranscode: 'copy' }, origin: 'studio-clip'
    });
    assert.equal(countProvenance(database, 'derived_clip'), 1, '重复血缘写入被 UNIQUE 幂等吸收');
  });
});
