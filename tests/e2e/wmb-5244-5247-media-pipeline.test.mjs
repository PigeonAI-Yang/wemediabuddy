// WMB-5244–5247 最终产品场景（设计 §17）：同一真实工作空间串行跑通
// 情报媒体资产化与创作调用链 —— 真实 Electron + 隔离 data-root + 确定性本地媒体 fixture。
//
// 形态（与 WMB-5241 同族 harness；runner --file 执行）：
//   Launch 1（真实 Electron）→ 种子研究 Source + 侧栏无新顶层路由 + 资料库媒体区空态 →
//   干净关闭进程
//   Window A（同一 data-root，应用已关闭）→ 生产模块直接执行媒体全链：
//     渠道候选冻结（persistSourceMediaCandidates 与 Source 同 revision）→
//     归档 worker（runDueMediaArchiveJobs direct-DB，fetch/resolveHost/probeDurationMs 注入缝
//     指向本地 fixture HTTP server）→ 图片理解（VisualModelCall stub）→
//     视频理解（VideoRuntimeAdapter fake：原生字幕优先、零 ASR/OCR）→
//     建议生成/接受两项拒绝一项 → 裁切派生 + Clip 物化（fake executor）→
//     GC 保护引用集 → 关闭 fixture server（断网）→ DB 快照
//   Launch 2（同一 userDataDir/dataRoot 重启，断网）→ SQLite 读回 preserved 媒体/派生/运行 +
//     UI 媒体区「媒体已全部保存」+ 零自动发布（publications/platform_versions 零行）
//
// 确定性：媒体字节全部来自 tests/fixtures（PNG/JPEG/MP4 真实 magic + 真实 mvhd 时长）；
// 下载走真实本地 HTTP（127.0.0.1 端口 0）但 SSRF 门仍真实执行（hostname=media-fixture.invalid
// 非环回、resolveHost 注入公网 IP）；视频管线不依赖任何真实二进制。
//
// 运行（由 Main 集中验收，本任务不执行）：
//   node tests/e2e/runner.mjs --file tests/e2e/wmb-5244-5247-media-pipeline.test.mjs --timeout 900
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import { helpers, launchApp } from './harness.mjs';
import { seedWorkflowBase } from './seed-workflow.mjs';

// 生产模块（Node 24 原生 .ts；与 WMB-5241 同族）
import { migrateDatabase } from '../../src/main/db/migrations.ts';
import { upsertSource } from '../../src/main/sources.ts';
import { sourceRevisionKey } from '../../src/shared/media-candidates.ts';
import { validateMediaCandidates, persistSourceMediaCandidates } from '../../src/main/source-media-candidates.ts';
import { runDueMediaArchiveJobs, getSourceMediaSummary } from '../../src/main/media-archive-worker.ts';
import { listSourceMediaBindings } from '../../src/main/db/media-archive-store.ts';
import { enqueuePreservedSourceImage, executeVisualRun } from '../../src/main/visual-source-lineage.ts';
import { enqueueVideoRun, executeVideoRun, parseSrtToSegments } from '../../src/main/video-understanding.ts';
import { parseTranscriptJson, parseSegmentsJson, parseKeyframesJson } from '../../src/main/db/video-understanding-store.ts';
import { generateMediaRecommendations, proposeMediaRecommendations, decideMediaRecommendation, readMediaRecommendations } from '../../src/main/media-recommendations.ts';
import { materializeAnnotationAsset, materializeClipAsset } from '../../src/main/media-derivations.ts';
import { collectProtectedAssetIds, planDerivedCacheGc } from '../../src/main/media-governance.ts';
import { subtitleSrt, jpegBytes, pngBytes, mp4Bytes } from '../fixtures/media-fixture-bytes.mjs';
import { startStandardFixtureServer, fixtureUrl, fixtureFetchImpl, publicResolveHost } from '../fixtures/media-http-fixture.mjs';

const { step, waitForAppReady, navigateTo, delay, openReadOnlyDb, captureEvidence, closeApp } = helpers;

const FIXED_PROBE = async () => ({ durationMs: 12000, runtimeName: 'wmb-test', runtimeVersion: '1' });
const OWNER = Object.freeze({ type: 'owner_ui', id: 'e2e-media', label: 'E2E 媒体验收' });

function count(db, table) {
  return Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c);
}

function row(db, sql, ...args) {
  return db.prepare(sql).get(...args);
}

function snapshotDb(artifactsDir, name, dataRoot) {
  const dest = path.join(artifactsDir, name);
  const { db } = openReadOnlyDb(dataRoot);
  try {
    if (typeof db.backup === 'function') {
      db.backup(dest);
    } else {
      db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    }
    return dest;
  } finally {
    db.close();
  }
}

function writeJson(artifactsDir, name, value) {
  writeFileSync(path.join(artifactsDir, name), `${JSON.stringify(value, null, 2)}\n`);
}

/** 30 天保留窗口下 GC 规划（只读；供保护断言）。 */
function governancePlan(db, dataRoot) {
  return planDerivedCacheGc(db, dataRoot, { retentionDays: 30 });
}

/** 视觉模型确定性缝：返回固定 wmb_visual_observation manifest（生产解析器校验）。 */
function stubVisionModel(statement) {
  const manifest = {
    wmb_visual_observation: {
      reason: 'E2E 视觉观察：Benchmark 总表匹配成绩段落。',
      items: [
        { kind: 'claim', canonicalKey: 'e2e-benchmark-score', statement, excerpt: statement.slice(0, 40), valueRationale: '总表可独立核对。' }
      ]
    }
  };
  return async () => `\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\``;
}

/** 视频理解 fake adapter：原生字幕优先（零 ASR/OCR）+ 镜头/关键帧确定性。 */
function fakeVideoRuntime() {
  const calls = { asr: 0, ocr: 0, subtitle: 0 };
  return {
    calls,
    adapter: {
      identity: 'e2e-fake-runtime',
      probe: async () => ({
        container: 'mp4', durationMs: 12000, width: 640, height: 360, frameRate: 30, rotation: null,
        videoCodec: 'h264', audioCodec: 'aac', hasAudio: true,
        subtitleTracks: [{ index: 0, language: 'zh', forced: false, default: true }], chapters: [],
        runtimeManifestHash: 'e2e-fake-runtime'
      }),
      extractSubtitles: async () => { calls.subtitle += 1; return parseSrtToSegments(subtitleSrt(), 'native'); },
      runAsr: async () => { calls.asr += 1; return []; },
      detectScenes: async () => [3000, 8000],
      extractKeyframe: async () => ({ bytes: jpegBytes(), width: 640, height: 360, phash: 'e2e-ph-1' }),
      runOcr: async () => { calls.ocr += 1; return []; }
    }
  };
}

export default [
  {
    id: 'WMB-5244-5247-media-pipeline-e2e',
    journeyIds: ['WMB-5244-5247-media-pipeline-e2e'],
    launch: {
      seedFixture: async (workspace) => {
        await seedWorkflowBase(workspace.dataRoot, workspace.workspaceId, { template: 'official.ai' });
        // 种子研究 Source（文字先行；媒体候选在 Window A 与同一 Source revision 同批冻结）
        const db = migrateDatabase(path.join(workspace.dataRoot, 'wmb.db'));
        try {
          return upsertSource(db, {
            originalUrl: 'https://example.com/deepseek-v4-pro-benchmark',
            title: 'DeepSeek-V4-Pro 基准测试性能的后续影响',
            summary: '成绩段落 + 边界说明 + 实测体验。',
            categories: ['research', 'media_pipeline_e2e'],
            clientLabel: 'WMB research',
            verificationStatus: 'pending',
            managementStatus: 'active',
            evidence: '{}'
          });
        } finally {
          db.close();
        }
      }
    },
    run: async ({ app, page, workspace, evidence, artifactsDir, runtimeDir }) => {
      const dataRoot = workspace.dataRoot;
      const startedAt = new Date().toISOString();
      const steps = [];
      let server = null;
      let sourceId = '';
      let sourceRevision = 1;
      let revKey = '';

      // ============ Launch 1：真实 Electron UI 面 ============
      await step(evidence, '启动就绪 + 侧栏无新顶层路由（§3 不新增顶层入口）', async () => {
        await waitForAppReady(page);
        const navTitles = await page.evaluate(() => [...document.querySelectorAll('aside.sidebar nav button')].map((b) => b.getAttribute('title')).filter(Boolean));
        const known = new Set(Object.values(helpers.VIEW_TITLES));
        assert(navTitles.every((t) => known.has(t)), `侧栏出现未知顶层视图：${navTitles.filter((t) => !known.has(t)).join(',')}`);
        const sidebar = await page.evaluate(() => document.querySelector('aside.sidebar')?.textContent ?? '');
        assert(sidebar.includes('资料库'), '侧栏应含资料库');
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'L1-shell' });
      });

      await step(evidence, '资料库：种子 Source + 媒体区空态', async () => {
        await navigateTo(page, 'library');
        await page.locator('.library-wiki-tools').first().waitFor({ state: 'visible', timeout: 20_000 });
        await page.waitForFunction(() => document.querySelectorAll('.lib-row').length >= 1, null, { timeout: 20_000 });
        await page.locator('.lib-row').first().click();
        await page.locator('.library-source-media').first().waitFor({ state: 'visible', timeout: 20_000 });
        const empty = await page.evaluate(() => document.querySelector('.library-source-media')?.textContent ?? '');
        assert(empty.includes('此资料暂无可保存的图片或视频'), '种子 Source 媒体区应为空态');
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'L1-source-media-empty' });
      });

      await step(evidence, '干净关闭（进入 Window A 前）', async () => {
        await closeApp(app, { timeoutMs: 30_000 });
      });

      // ============ Window A：同一 data-root 生产媒体全链（应用已关闭） ============
      await step(evidence, '窗口 A：启动本地 fixture server + 冻结媒体候选（与 Source 同 revision）', async () => {
        server = await startStandardFixtureServer();
        const db = migrateDatabase(path.join(dataRoot, 'wmb.db'));
        try {
          const source = row(db, 'SELECT id, revision FROM source_items ORDER BY created_at LIMIT 1');
          assert(source, '需要已存在的种子 Source');
          sourceId = String(source.id);
          sourceRevision = Number(source.revision);
          revKey = sourceRevisionKey(sourceId, sourceRevision);
          const candidates = validateMediaCandidates([
            { kind: 'image', url: fixtureUrl(server, '/img/bench.png'), captionHint: 'Benchmark 总表' },
            { kind: 'image', url: fixtureUrl(server, '/img/limits.png'), captionHint: '测试限制截图' },
            { kind: 'video', url: fixtureUrl(server, '/video/demo.mp4') }
          ]);
          const persisted = persistSourceMediaCandidates(db, {
            sourceId, sourceRevisionKey: revKey, channel: 'research', candidates, requestId: 'e2e-media-freeze'
          });
          assert.equal(persisted.inserted.length, 3);
          steps.push(`freeze:${persisted.inserted.length}`);
        } finally {
          db.close();
        }
      });

      await step(evidence, '窗口 A：归档 worker（注入缝：fixture fetch + 公网 resolveHost + 固定时长）', async () => {
        const db = migrateDatabase(path.join(dataRoot, 'wmb.db'));
        try {
          const run = await runDueMediaArchiveJobs(db, {
            deps: { fetchImpl: fixtureFetchImpl(server), resolveHost: publicResolveHost, probeDurationMs: FIXED_PROBE },
            dataRoot
          });
          assert.equal(run.preserved, 3, '3 个候选必须全部 preserved');
          const summary = getSourceMediaSummary(db, sourceId, revKey);
          assert.equal(summary.total, 3);
          assert.equal(summary.preserved, 3);
          assert.equal(count(db, 'source_media_bindings'), 3);
          steps.push(`archive:preserved=${summary.preserved}`);
        } finally {
          db.close();
        }
      });

      await step(evidence, '窗口 A：断网（关闭 fixture server）后本地 Asset 仍可逐字节读取（§2-2）', async () => {
        await server.close();
        server = null;
        const db = migrateDatabase(path.join(dataRoot, 'wmb.db'));
        try {
          const bindings = listSourceMediaBindings(db, revKey);
          assert.equal(bindings.length, 3);
          for (const binding of bindings) {
            const asset = row(db, 'SELECT relative_path AS p FROM assets WHERE id=?', binding.assetId);
            const local = readFileSync(path.join(dataRoot, asset.p));
            assert.ok(local.length > 0, '断网后本地 Asset 字节必须完整');
          }
        } finally {
          db.close();
        }
        steps.push('offline-read:ok');
      });

      await step(evidence, '窗口 A：图片理解（VisualModelCall stub；Benchmark 图→成绩段）', async () => {
        const db = migrateDatabase(path.join(dataRoot, 'wmb.db'));
        try {
          const benchBinding = listSourceMediaBindings(db, revKey).find((b) => b.originalUrl.endsWith('bench.png'));
          assert(benchBinding, 'Benchmark 图 binding 必须存在');
          const enqueued = enqueuePreservedSourceImage(db, { sourceId, sourceRevisionKey: revKey, assetId: benchBinding.assetId, kind: 'image' });
          assert.equal(enqueued.enqueued, true);
          const completed = await executeVisualRun(db, enqueued.run.id, {
            dataRoot,
            modelCall: stubVisionModel('DeepSeek-V4-Pro 基准测试成绩领先，MMLU-Pro 与 GPQA 上超过上一代。')
          });
          assert.equal(completed.status, 'completed');
          assert.ok(completed.observation?.items?.length > 0);
          steps.push('image-understanding:completed');
        } finally {
          db.close();
        }
      });

      await step(evidence, '窗口 A：视频理解（fake adapter：原生字幕优先、零 ASR/OCR、关键帧血缘）', async () => {
        const db = migrateDatabase(path.join(dataRoot, 'wmb.db'));
        try {
          const videoBinding = listSourceMediaBindings(db, revKey).find((b) => b.kind === 'video');
          assert(videoBinding, '视频 binding 必须存在');
          const { calls, adapter } = fakeVideoRuntime();
          const { run } = enqueueVideoRun(db, { sourceId, sourceRevisionKey: revKey, assetId: videoBinding.assetId });
          const summaryCall = async ({ segments }) => segments.map((s) => ({ index: s.index, summary: '实测视频体验：真实推理与响应速度', confidence: 0.9 }));
          const completed = await executeVideoRun(db, run.id, { dataRoot, runtime: adapter, summaryCall, sourceLanguage: 'zh' });
          assert.equal(completed.status, 'completed');
          assert.equal(calls.asr, 0, '有原生字幕时 ASR 必须零调用（§16-8）');
          assert.equal(calls.ocr, 0, '有原生字幕时 OCR 必须零调用（§16-8）');
          const transcript = parseTranscriptJson(completed);
          assert.equal(transcript.source, 'native', '字幕优先 → transcriptSource=native');
          const segments = parseSegmentsJson(completed);
          assert.ok(segments.length >= 1);
          for (const seg of segments) {
            assert.ok(seg.startMs >= 0 && seg.endMs > seg.startMs && seg.endMs <= 12000, 'Segment 时间必须合法');
          }
          const keyframes = parseKeyframesJson(completed);
          assert.ok(keyframes.length >= 1, '必须有关键帧');
          for (const kf of keyframes) {
            const prov = row(db, "SELECT 1 AS hit FROM asset_provenance WHERE derived_asset_id=? AND kind='derived_keyframe'", kf.assetId);
            assert.ok(prov, '关键帧必须有 derived_keyframe 血缘');
          }
          steps.push('video-understanding:completed');
        } finally {
          db.close();
        }
      });

      await step(evidence, '窗口 A：建议生成/接受两项拒绝一项（§16-16/17）', async () => {
        const db = migrateDatabase(path.join(dataRoot, 'wmb.db'));
        try {
          const projectId = `proj-${randomUUID()}`;
          const versionId = `cv-${randomUUID()}`;
          const now = new Date().toISOString();
          db.prepare('INSERT INTO content_projects (id, title, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)')
            .run(projectId, 'DeepSeek-V4-Pro 基准性能的后续影响', now, now);
          const body = [
            '# DeepSeek-V4-Pro 基准性能的后续影响',
            '## 成绩',
            'DeepSeek-V4-Pro 基准测试成绩领先，MMLU-Pro 与 GPQA 上超过上一代。',
            '## 边界',
            '测试限制条件需要注意，复现需按说明。',
            '## 体验',
            '实测视频体验：真实推理与响应速度。',
            '## 竞争格局',
            '竞品在同等参数规模下的表现缺少直接证据。'
          ].join('\n');
          db.prepare('INSERT INTO content_versions (id, project_id, body, version_number, created_at) VALUES (?, ?, ?, 1, ?)')
            .run(versionId, projectId, body, now);
          const drafts = generateMediaRecommendations(db, { contentVersionId: versionId, projectId, sourceRevisionKeys: [revKey] });
          assert.ok(drafts.length >= 3, `应生成 ≥3 条建议，实际 ${drafts.length}`);
          // 无合适素材的观点（竞争格局）零建议
          assert.ok(!drafts.some((d) => d.claimKey === 'c4'), '竞争格局无直接证据不得伪造建议');
          const proposed = proposeMediaRecommendations(db, { contentVersionId: versionId, projectId, requestId: 'e2e-propose', drafts });
          assert.ok(proposed.length >= 3);
          // 接受两项、拒绝一项
          const decided = [];
          const accepted = proposed.filter((_, i) => i < 2);
          const rejected = proposed.slice(2, 3);
          for (const rec of accepted) {
            const current = readMediaRecommendations(db, { contentVersionId: versionId }).claims.flatMap((c) => c.suggestions).find((s) => s.id === rec.id);
            decided.push(decideMediaRecommendation(db, { id: rec.id, expectedRevision: current.revision, decision: 'accept', decidedBy: 'e2e' }).state);
          }
          for (const rec of rejected) {
            const current = readMediaRecommendations(db, { contentVersionId: versionId }).claims.flatMap((c) => c.suggestions).find((s) => s.id === rec.id);
            decided.push(decideMediaRecommendation(db, { id: rec.id, expectedRevision: current.revision, decision: 'reject', decidedBy: 'e2e' }).state);
          }
          assert.deepEqual(decided.sort(), ['accepted', 'accepted', 'rejected']);
          // 拒绝零版本写（§16-17）：接受/拒绝本身不写 Content/Platform Binding（由 Studio 保存路径单独执行）
          assert.equal(count(db, 'content_media_bindings'), 0);
          assert.equal(count(db, 'platform_media_bindings'), 0);
          assert.equal(count(db, 'platform_versions'), 0);
          steps.push(`recommend:accept=2 reject=1`);
        } finally {
          db.close();
        }
      });

      await step(evidence, '窗口 A：非破坏派生（裁切 + Clip）原件不变 + 血缘可逆（§16-18）', async () => {
        const db = migrateDatabase(path.join(dataRoot, 'wmb.db'));
        try {
          const bindings = listSourceMediaBindings(db, revKey);
          const imageBinding = bindings.find((b) => b.originalUrl.endsWith('bench.png'));
          const videoBinding = bindings.find((b) => b.kind === 'video');
          const originalAsset = row(db, 'SELECT relative_path AS p, byte_count AS b FROM assets WHERE id=?', imageBinding.assetId);
          const originalBytes = readFileSync(path.join(dataRoot, originalAsset.p));

          const annotated = await materializeAnnotationAsset(db, dataRoot, {
            sourceAssetId: imageBinding.assetId,
            annotationSpec: { annotationType: 'rect', elements: [{ x: 0, y: 0, width: 200, height: 200 }], width: 640, height: 400 },
            bytes: pngBytes(320, 200, [200, 40, 40]),
            fileName: 'crop.png', mimeType: 'image/png', origin: 'e2e-derive'
          });
          assert.ok(annotated.assetId);
          const after = readFileSync(path.join(dataRoot, originalAsset.p));
          assert.deepEqual(after, originalBytes, '原件字节必须不变');

          // Clip 物化：fake executor（copy 成功）+ fake runtime
          const fakeExecutor = {
            async ffmpeg(args) {
              const outputPath = args[args.length - 1];
              writeFileSync(outputPath, mp4Bytes({ durationMs: 5000, variant: 42 }));
              return { code: 0, stdout: '', stderr: '' };
            },
            async ffprobe() {
              return { code: 0, stdout: JSON.stringify({
                format: { duration: '5.0', start_time: '0.0' },
                streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', start_time: '0.0' }]
              }), stderr: '' };
            }
          };
          const fakeRuntime = { rootDir: dataRoot, ffmpegPath: 'fake', ffprobePath: 'fake', manifest: null, identity: 'e2e-clip-runtime' };
          const clip = await materializeClipAsset(db, dataRoot, {
            sourceAssetId: videoBinding.assetId, startMs: 0, endMs: 5000, origin: 'e2e-derive'
          }, { executor: fakeExecutor, runtime: fakeRuntime });
          assert.equal(clip.copyOrTranscode, 'copy');
          const clipProv = row(db, "SELECT transform_json AS t FROM asset_provenance WHERE derived_asset_id=? AND kind='derived_clip'", clip.assetId);
          assert.ok(clipProv, 'Clip 必须有 derived_clip 血缘');
          const videoAfter = readFileSync(path.join(dataRoot, row(db, 'SELECT relative_path AS p FROM assets WHERE id=?', videoBinding.assetId).p));
          assert.ok(videoAfter.length > 0, '原视频必须保留');
          steps.push('derivations:crop+clip-ok');
        } finally {
          db.close();
        }
      });

      await step(evidence, '窗口 A：GC 保护（原始 Source 媒体受引用集保护；无引用派生可回收；§14/§16-20）', async () => {
        const db = migrateDatabase(path.join(dataRoot, 'wmb.db'));
        try {
          const protectedIds = collectProtectedAssetIds(db);
          const bindings = listSourceMediaBindings(db, revKey);
          for (const binding of bindings) {
            assert.ok(protectedIds.has(binding.assetId), `原始 Source 媒体 ${binding.assetId} 必须受 GC 保护`);
          }
          // 无引用派生（仅有自身身份血缘行）可被 GC 规划回收；原始 Source 媒体永不进入候选。
          const plan = governancePlan(db, dataRoot);
          const planIds = new Set(plan.candidates.map((c) => c.assetId));
          for (const binding of bindings) {
            assert.ok(!planIds.has(binding.assetId), `原始 Source 媒体 ${binding.assetId} 永不自动清理`);
          }
          steps.push(`gc-protection:originals-protected=${bindings.length} candidates=${plan.candidates.length}`);
        } finally {
          db.close();
        }
      });

      await step(evidence, '窗口 A：DB 快照 + 发布边界（零自动发布）', async () => {
        const db = migrateDatabase(path.join(dataRoot, 'wmb.db'));
        try {
          for (const table of ['publications', 'publication_snapshots', 'publication_metric_snapshots', 'platform_versions']) {
            assert.equal(count(db, table), 0, `${table} 必须零行（无自动发布）`);
          }
        } finally {
          db.close();
        }
        snapshotDb(artifactsDir, 'phase-window-a.db', dataRoot);
        writeJson(artifactsDir, 'steps-window-a.json', steps);
      });

      // ============ Launch 2：同一 userDataDir/dataRoot 重启（断网） ============
      await step(evidence, '重启恢复：断网重启 → SQLite 读回 preserved 媒体/派生/运行 + UI 媒体区', async () => {
        const relaunched = await launchApp({
          userDataDir: workspace.userDataDir,
          dataRoot,
          seed: false,
          name: 'wmb-5244-5247-restart',
          artifactsDir
        });
        const page2 = relaunched.page;
        try {
          await waitForAppReady(page2);
          // SQLite 读回（断网：fixture server 已关闭，本地字节仍完整）
          const db = migrateDatabase(path.join(dataRoot, 'wmb.db'));
          try {
            const summary = getSourceMediaSummary(db, sourceId, revKey);
            assert.equal(summary.total, 3, '重启后候选总数必须完整');
            assert.equal(summary.preserved, 3, '重启后 preserved 计数必须完整');
            assert.equal(count(db, 'source_media_bindings'), 3);
            assert.equal(count(db, 'knowledge_visual_runs'), 1, '图片理解 run 必须持久化');
            assert.equal(count(db, 'video_understanding_runs'), 1, '视频理解 run 必须持久化');
            const vid = row(db, "SELECT status FROM video_understanding_runs LIMIT 1");
            assert.equal(vid.status, 'completed');
            const vis = row(db, "SELECT status FROM knowledge_visual_runs LIMIT 1");
            assert.equal(vis.status, 'completed');
            // 断网离线读：本地字节
            for (const binding of listSourceMediaBindings(db, revKey)) {
              const asset = row(db, 'SELECT relative_path AS p FROM assets WHERE id=?', binding.assetId);
              const local = readFileSync(path.join(dataRoot, asset.p));
              assert.ok(local.length > 0, '断网重启后本地 Asset 仍可逐字节读取');
            }
            // 零自动发布
            for (const table of ['publications', 'publication_snapshots', 'publication_metric_snapshots', 'platform_versions']) {
              assert.equal(count(db, table), 0, `重启后 ${table} 必须零行`);
            }
          } finally {
            db.close();
          }
          // UI 读回：资料库媒体区「媒体已全部保存」
          await navigateTo(page2, 'library');
          await page2.locator('.library-wiki-tools').first().waitFor({ state: 'visible', timeout: 20_000 });
          await page2.waitForFunction(() => document.querySelectorAll('.lib-row').length >= 1, null, { timeout: 20_000 });
          await page2.locator('.lib-row').first().click();
          await page2.locator('.library-source-media').first().waitFor({ state: 'visible', timeout: 20_000 });
          await page2.waitForFunction(() => {
            const text = document.querySelector('.library-source-media')?.textContent ?? '';
            return text.includes('媒体已全部保存') || /媒体 \d+\/\d+ 已保存/.test(text);
          }, null, { timeout: 20_000 });
          const summaryText = await page2.evaluate(() => document.querySelector('.library-source-media-summary')?.textContent ?? '');
          assert(/媒体(已全部保存|\s\d+\/\d+\s已保存)/.test(summaryText), `媒体区应展示保存进度，实际 ${summaryText}`);
          await captureEvidence({ app: relaunched.app, page: page2, evidence: relaunched.evidence, artifactsDir, name: 'L2-restart-media-readback' });
        } finally {
          await closeApp(relaunched.app, { timeoutMs: 30_000 }).catch(() => {});
        }
      });

      // 最终证据
      snapshotDb(artifactsDir, 'phase-final.db', dataRoot);
      writeJson(artifactsDir, 'classification.json', {
        schema: 'wmb-5244-5247-media-pipeline-e2e.v1',
        outcome: 'passed',
        startedAt,
        finishedAt: new Date().toISOString(),
        dataRoot,
        workspaceId: workspace.workspaceId,
        sourceId,
        revKey,
        steps
      });
      return {
        surface: 'media-pipeline',
        journey: 'WMB-5244-5247-media-pipeline-e2e',
        outcome: 'passed',
        steps,
        evidenceDir: artifactsDir
      };
    }
  }
];
