// WMB-5244–5247 情报媒体资产化与创作调用链 —— 统一聚焦验收（设计 §16 验收矩阵）。
//
// 形态：单文件、离线、确定性；无真实 Electron、无互联网、无可变第三方资源。
// - 渠道冻结（X/官网/Research）→ 归档 worker → 图片/视频理解 → 建议 → 接受/拒绝 →
//   非破坏派生 → GC 保护 → 工作空间隔离/重启/零自动发布 全链在同一个临时工作空间串行验证；
// - 下载经 fixture HTTP server（127.0.0.1 端口 0）+ fetchImpl/resolveHost/probeDurationMs 注入缝
//   （media-archive-fetch.ts 官方缝），SSRF 门仍真实执行（hostname 级检查）；
// - 视频管线经 VideoRuntimeAdapter 注入缝（probe/extractSubtitles/runAsr/detectScenes/
//   extractKeyframe/runOcr 全部假实现 + 调用计数），证明字幕优先零 ASR/OCR、stage 恢复不重复；
// - 图片理解经 VisualModelCall 注入缝（stub manifest，生产解析器校验）。
//
// 旧行为下失败点（实现前不存在）：64-69 迁移、四张新表、候选七态、media_discover job、
// video locator、derived_clip/annotation 血缘、media_rights_overrides、media_recommendations、
// GC 引用集 —— 任何 import 或表断言都会在旧代码上失败。
//
// 运行（由 Main 集中验收，本任务不执行）：
//   node --test --test-concurrency=1 tests/wmb-5244-5247-media-acceptance.test.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { register } from 'node:module';

// ---- 测试本地 ESM 解析钩子（同 command-dispatcher.test.mjs）：electron → 惰性桩；相对无扩展名补 .ts ----
const ELECTRON_STUB = [
  'const noop = () => {};',
  'class BrowserWindow {',
  '  static getAllWindows() { return []; }',
  '  loadURL() { return Promise.resolve(); }',
  '  loadFile() { return Promise.resolve(); }',
  '}',
  "const app = { getAppPath: () => '', whenReady: () => Promise.resolve(), on: noop };",
  'const ipcMain = { handle: noop, on: noop, removeHandler: noop, removeAllListeners: noop };',
  "const safeStorage = { encryptString: (s) => Buffer.from(String(s), 'utf8'), decryptString: (b) => String(b) };",
  'export { app, BrowserWindow, ipcMain, safeStorage };',
  'export default { app, safeStorage };'
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

// ============================================================
// fixtures（离线字节 + 本地 HTTP）
// ============================================================
import {
  pngBytes, jpegBytes, webpBytes, gifBytes, mp4Bytes, webmBytes,
  subtitleSrt, webPageFixture, xTimelineFixture, sniffMediaType as fixtureSniff
} from './fixtures/media-fixture-bytes.mjs';
import {
  startStandardFixtureServer, fixtureUrl, fixtureFetchImpl, publicResolveHost, FIXTURE_HOST
} from './fixtures/media-http-fixture.mjs';

// ============================================================
// 生产模块（全部已落地；旧代码上 import 即失败）
// ============================================================
const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { ActiveWorkspaceRuntime } = await import('../src/main/workspace-runtime.ts');
const { ensureOfficialWorkspaceProfile } = await import('../src/main/workspace-profiles.ts');
const { upsertSource, createSourceFeed } = await import('../src/main/sources.ts');
const { dispatchSourceUpsertBatch } = await import('../src/main/source-commands.ts');
const { createCommandEnvelope } = await import('../src/main/command-dispatcher.ts');

const mediaCandidatesShared = await import('../src/shared/media-candidates.ts');
const { MEDIA_LIMITS_DEFAULT } = await import('../src/shared/media-limits.ts');
const store = await import('../src/main/db/media-archive-store.ts');
const worker = await import('../src/main/media-archive-worker.ts');
const fetchGuard = await import('../src/main/media-archive-fetch.ts');
const xWiring = await import('../src/main/x-media-wiring.ts');
const researchWiring = await import('../src/main/source-media-candidates.ts');
const websiteDiscovery = await import('../src/main/website-media-discovery.ts');
const visual = await import('../src/main/visual-source-lineage.ts');
const video = await import('../src/main/video-understanding.ts');
const videoStore = await import('../src/main/db/video-understanding-store.ts');
const derivations = await import('../src/main/media-derivations.ts');
const recommendations = await import('../src/main/media-recommendations.ts');
const governance = await import('../src/main/media-governance.ts');
const rights = await import('../src/main/media-rights.ts');

// ============================================================
// harness
// ============================================================
const owner = Object.freeze({ type: 'owner_ui', id: 'acceptance', label: 'acceptance' });

async function withMediaDb(work, { fixture = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-media-accept-'));
  let server = null;
  try {
    const db = migrateDatabase(path.join(root, 'wmb.db'));
    const workspaceId = `workspace-${randomUUID()}`;
    const now = new Date().toISOString();
    db.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)").run(workspaceId, now, now);
    ensureOfficialWorkspaceProfile(db, 'official.ai');
    if (fixture) server = await startStandardFixtureServer();
    try {
      await work({ root, db, server, dataRoot: root, workspaceId });
    } finally {
      db.close();
    }
  } finally {
    if (server) await server.close().catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function withMediaRuntime(work, { fixture = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-media-runtime-'));
  let server = null;
  let runtime = null;
  try {
    const db = migrateDatabase(path.join(root, 'wmb.db'));
    const workspaceId = `workspace-${randomUUID()}`;
    const now = new Date().toISOString();
    db.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)").run(workspaceId, now, now);
    ensureOfficialWorkspaceProfile(db, 'official.ai');
    db.close();
    runtime = ActiveWorkspaceRuntime.open(root, { openDatabase: migrateDatabase, createEpoch: () => 'runtime-current' });
    if (fixture) server = await startStandardFixtureServer();
    try {
      await work({ root, runtime, db: runtime.database, server, dataRoot: root, workspaceId });
    } finally {
      await runtime?.stop({ drain: false });
    }
  } finally {
    if (server) await server.close().catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function dispatch(runtime, command, requestId, input, execute) {
  const envelope = createCommandEnvelope({
    workspaceId: runtime.identity.workspaceId,
    runtimeEpoch: runtime.identity.runtimeEpoch,
    command,
    requestId,
    actor: owner,
    input,
    boundIdentity: { entityType: 'media_acceptance' }
  });
  return runtime.dispatchCommand(envelope, () => execute(runtime.database, envelope.input));
}

function count(db, table) {
  return Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c);
}

function rows(db, sql, ...args) {
  return db.prepare(sql).all(...args);
}

function row(db, sql, ...args) {
  return db.prepare(sql).get(...args);
}

/** 固定 probeDurationMs 注入：12s（视频时长上限 30min 之内）。 */
const FIXED_PROBE = async () => ({ durationMs: 12000, runtimeName: 'wmb-test', runtimeVersion: '1' });

/** worker 直接模式依赖：fixture 服务器 + 公网 resolveHost + 固定时长。 */
function workerDeps(server, probe = FIXED_PROBE) {
  return { fetchImpl: fixtureFetchImpl(server), resolveHost: publicResolveHost, probeDurationMs: probe };
}

/** 每候选 media_archive job 的 dedupe key（与 worker claim 口径一致）。 */
const archiveJobDedupe = (revKey, candidateId) => mediaCandidatesShared.mediaArchiveDedupeKey(revKey, candidateId);

function seedResearchSource(db, overrides = {}) {
  return upsertSource(db, {
    originalUrl: overrides.originalUrl ?? `https://example.com/research/${randomUUID()}`,
    title: overrides.title ?? 'DeepSeek-V4-Pro 基准测试性能的后续影响',
    summary: overrides.summary ?? '成绩段落 + 边界说明 + 实测体验。',
    categories: ['research', 'media_acceptance'],
    clientLabel: 'WMB research',
    verificationStatus: 'pending',
    managementStatus: 'active',
    evidence: '{}',
    ...overrides
  });
}

// ============================================================
// A. 迁移与身份（§6）
// ============================================================

test('A1 迁移 64-69 落地：候选/attempt/binding/video 表 + provenance kinds + binding video 列', async () => {
  await withMediaDb(async ({ db }) => {
    const versions = rows(db, 'SELECT version FROM schema_migrations ORDER BY version').map((r) => Number(r.version));
    for (const v of [64, 65, 66, 67, 68, 69]) assert.ok(versions.includes(v), `迁移版本 ${v} 必须存在`);

    // §6.1/6.2/6.3 四张新表 + 关键列
    for (const table of ['source_media_candidates', 'media_archive_attempts', 'source_media_bindings', 'video_understanding_runs']) {
      const exists = row(db, `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, table);
      assert.ok(exists, `表 ${table} 必须存在`);
    }
    const candCols = rows(db, 'PRAGMA table_info(source_media_candidates)').map((c) => c.name);
    for (const col of ['source_revision_key', 'kind', 'original_url', 'stable_remote_identity', 'channel', 'post_kind', 'parent_candidate_id', 'post_ordinal', 'ordinal_in_post', 'ordinal', 'status', 'error_code', 'attempt_count', 'max_attempts', 'request_id', 'alternate_urls_json']) {
      assert.ok(candCols.includes(col), `source_media_candidates 缺少列 ${col}`);
    }
    const attemptCols = rows(db, 'PRAGMA table_info(media_archive_attempts)').map((c) => c.name);
    for (const col of ['candidate_id', 'attempt', 'status', 'runtime_name', 'runtime_version', 'parameter_hash']) {
      assert.ok(attemptCols.includes(col), `media_archive_attempts 缺少列 ${col}`);
    }
    const bindingCols = rows(db, 'PRAGMA table_info(source_media_bindings)').map((c) => c.name);
    for (const col of ['candidate_id', 'asset_id', 'kind', 'ordinal', 'original_url', 'sha256', 'rights_status', 'risk_flags_json', 'archived_at', 'archived_reason']) {
      assert.ok(bindingCols.includes(col), `source_media_bindings 缺少列 ${col}`);
    }
    const videoCols = rows(db, 'PRAGMA table_info(video_understanding_runs)').map((c) => c.name);
    for (const col of ['source_revision_key', 'asset_id', 'schema_version', 'attempt', 'status', 'stage', 'probe_json', 'transcript_json', 'keyframes_json', 'segments_json', 'runtime_manifest_hash', 'completed_at']) {
      assert.ok(videoCols.includes(col), `video_understanding_runs 缺少列 ${col}`);
    }

    // §6.5 provenance kinds 扩展
    const provSql = row(db, "SELECT sql FROM sqlite_master WHERE type='table' AND name='asset_provenance'").sql;
    for (const kind of ['imported', 'generated', 'derived_crop', 'derived_annotation', 'derived_keyframe', 'derived_clip', 'derived_transcode']) {
      assert.ok(provSql.includes(kind), `asset_provenance kind 必须包含 ${kind}`);
    }
    // §12.3 binding 视频列
    const contentBindingSql = row(db, "SELECT sql FROM sqlite_master WHERE type='table' AND name='content_media_bindings'").sql;
    assert.ok(contentBindingSql.includes('media_kind'), 'content_media_bindings 必须含 media_kind');
    const platformBindingSql = row(db, "SELECT sql FROM sqlite_master WHERE type='table' AND name='platform_media_bindings'").sql;
    for (const col of ['media_kind', 'poster_asset_id', 'clip_range_json', 'duration_ms']) {
      assert.ok(platformBindingSql.includes(col), `platform_media_bindings 必须含 ${col}`);
    }
  });
});

test('A2 身份键与 locator 格式（revision key / dedupe / video locator / 候选 id）', async () => {
  await withMediaDb(async ({ db }) => {
    assert.equal(mediaCandidatesShared.sourceRevisionKey('s1', 3), 'source:s1:r3');
    assert.equal(mediaCandidatesShared.mediaArchiveDedupeKey('source:s1:r3', 'smc:x'), 'media:source:s1:r3:smc:x');
    assert.equal(mediaCandidatesShared.mediaDiscoverDedupeKey('source:s1:r3'), 'media_discover:source:s1:r3');
    const loc = mediaCandidatesShared.videoEvidenceLocator('a1', 'source:s1:r3', 1000, 4000);
    assert.equal(loc, 'asset:a1|sourceRevision:source:s1:r3|timeRange:1000-4000');
    const parsed = video.parseVideoEvidenceLocator(loc, 12000);
    assert.equal(parsed.assetId, 'a1');
    assert.equal(parsed.sourceRevisionKey, 'source:s1:r3');
    assert.deepEqual(parsed.timeRange, { startMs: 1000, endMs: 4000 });
    // 非法时间范围 → null（fail-closed）
    assert.equal(video.parseVideoEvidenceLocator('asset:a1|sourceRevision:source:s1:r3|timeRange:4000-1000', 12000), null);
    assert.equal(video.parseVideoEvidenceLocator('asset:a1|sourceRevision:source:s1:r3|timeRange:1000-99999', 12000), null);
    // 旧图片 locator 逐字兼容 + 区域后缀
    const visualLoc = visual.visualEvidenceLocator('img1', 'source:s1:r3');
    assert.equal(visualLoc, 'asset:img1|sourceRevision:source:s1:r3');
    const parsedVisual = visual.parseVisualEvidenceLocator(visualLoc);
    assert.deepEqual(parsedVisual, { assetId: 'img1', sourceRevisionId: 'source:s1:r3', region: null });
    const regionLoc = visual.visualEvidenceLocator('img1', 'source:s1:r3', { x: 0, y: 0, width: 0.5, height: 0.5 });
    assert.ok(regionLoc.endsWith('|region={0,0,0.5,0.5}'));
    assert.deepEqual(visual.parseVisualEvidenceLocator(regionLoc).region, { x: 0, y: 0, width: 0.5, height: 0.5 });
    // 候选确定性 id：smc:<revKey>:<ordinal>:<kind>
    const source = seedResearchSource(db);
    const revKey = mediaCandidatesShared.sourceRevisionKey(source.id, source.revision);
    const result = store.insertMediaCandidates(db, {
      sourceId: source.id, sourceRevisionKey: revKey, channel: 'research', requestId: 'r-a2',
      discoveredAt: new Date().toISOString(),
      candidates: [
        { kind: 'image', originalUrl: 'https://cdn.example.com/a.png', ordinal: 0 },
        { kind: 'video', originalUrl: 'https://cdn.example.com/v.mp4', ordinal: 1 },
        { kind: 'video_poster', originalUrl: 'https://cdn.example.com/p.jpg', ordinal: 1, parentOrdinal: 1 }
      ]
    });
    assert.deepEqual(result.candidateIds, [
      `smc:${revKey}:0:image`, `smc:${revKey}:1:video`, `smc:${revKey}:1:video_poster`
    ]);
    // skipped_limit 候选不建 Attempt/Job（§8）
    const limited = store.insertMediaCandidates(db, {
      sourceId: source.id, sourceRevisionKey: revKey, channel: 'research', requestId: 'r-a2b',
      discoveredAt: new Date().toISOString(),
      candidates: [{ kind: 'image', originalUrl: 'https://cdn.example.com/skip.png', ordinal: 9, status: 'skipped_limit' }]
    });
    assert.equal(limited.inserted.length, 1);
    assert.equal(count(db, 'media_archive_attempts'), 3, 'skipped_limit 候选不得建 Attempt');
    assert.equal(count(db, 'jobs'), 3, 'skipped_limit 候选不得建 Job');
  });
});

// ============================================================
// B. 渠道同事务冻结（§7）
// ============================================================

test('B1 X Lists：单帖多图 + 视频 + poster + 引用帖媒体父子关系与顺序（§7.2）', async () => {
  await withMediaDb(async ({ db }) => {
    const source = seedResearchSource(db, { originalUrl: `https://x.com/list-${randomUUID()}` });
    const revKey = mediaCandidatesShared.sourceRevisionKey(source.id, source.revision);
    const post = {
      url: 'https://x.com/a/status/1', authorHandle: 'alice', displayName: 'Alice', avatarUrl: null,
      text: 'DeepSeek-V4-Pro 基准测试成绩领先，实测视频见下方。', postedAt: new Date().toISOString(),
      images: [`${FIXTURE_HOST}/img/x-bench-1.png`, `${FIXTURE_HOST}/img/x-bench-2.png`],
      imageThumbs: [],
      hasVideo: true,
      videoPoster: `${FIXTURE_HOST}/img/x-demo-poster.jpg`,
      videoUrl: `${FIXTURE_HOST}/video/x-demo.mp4`,
      postKind: 'tweet',
      quotedPost: {
        url: 'https://x.com/b/status/2', authorHandle: 'bob', displayName: 'Bob', avatarUrl: null,
        text: '复现边界说明', postedAt: new Date().toISOString(),
        images: [`${FIXTURE_HOST}/img/x-quoted-chart.png`], imageThumbs: [],
        hasVideo: false, videoPoster: null, videoUrl: null, postKind: 'tweet', quotedPost: null,
        metrics: { replies: 0, reposts: 0, likes: 0, bookmarks: 0, views: 0 }
      },
      metrics: { replies: 0, reposts: 0, likes: 0, bookmarks: 0, views: 0 }
    };
    const frozen = xWiring.freezeXTimelineMediaCandidates(db, {
      sourceId: source.id, sourceRevision: source.revision, post, postOrdinal: 0,
      requestId: 'x-obs-1', discoveredAt: new Date().toISOString()
    });
    assert.equal(frozen.inserted.length, 5, '主帖 2 图 + 视频 + poster + 引用帖 1 图 = 5 候选');
    const candidates = store.listMediaCandidatesForRevision(db, revKey);
    // 顺序：主帖图片(0,1) → 视频(2)+poster(2 共享 ordinal) → 引用帖图片(3)
    assert.deepEqual(candidates.map((c) => [c.ordinal, c.kind]), [
      [0, 'image'], [1, 'image'], [2, 'video'], [2, 'video_poster'], [3, 'image']
    ]);
    const poster = candidates.find((c) => c.kind === 'video_poster');
    const videoCand = candidates.find((c) => c.kind === 'video');
    assert.equal(poster.parentCandidateId, videoCand.id, 'poster 父引用必须指向视频候选');
    const quoted = candidates[4];
    assert.equal(quoted.postKind, 'quote', '引用帖媒体必须保留 post_kind=quote');
    assert.equal(count(db, 'media_archive_attempts'), 5, '每候选初始 Attempt');
    assert.equal(count(db, 'jobs'), 5, '每候选 media_archive Job');
    for (const c of candidates) {
      const job = row(db, 'SELECT dedupe_key AS dk FROM jobs WHERE dedupe_key=?', archiveJobDedupe(revKey, c.id));
      assert.ok(job, `候选 ${c.id} 必须有 job`);
    }
  });
});

test('B2 Research：结构化候选校验拒绝 file:/wmb-asset:/本地路径 + 同事务持久化', async () => {
  await withMediaDb(async ({ db, server }) => {
    const source = seedResearchSource(db);
    const revKey = mediaCandidatesShared.sourceRevisionKey(source.id, source.revision);
    // §7.4 服务端重新验证：拒绝本地/内部身份
    for (const bad of [
      'file:///C:/secret.png', 'wmb-asset://local/a.png', 'C:\\local\\a.png', 'data:image/png;base64,xxx', 'blob:https://x/a'
    ]) {
      assert.throws(() => researchWiring.validateMediaCandidates([{ kind: 'image', url: bad }]), (e) => {
        assert.equal(e.code, 'MEDIA_CANDIDATES_INVALID');
        return true;
      }, `必须拒绝 ${bad}`);
    }
    // 枚举/限额/重复 (ordinal, kind) 拒绝
    assert.throws(() => researchWiring.validateMediaCandidates([{ kind: 'gif', url: 'https://a.com/x.png' }]), /kind 非法/);
    assert.throws(() => researchWiring.validateMediaCandidates([{ kind: 'image', url: 'https://a.com/1.png', ordinal: 0 }, { kind: 'image', url: 'https://a.com/2.png', ordinal: 0 }]), /\(ordinal, kind\) 与同批已有候选重复/);
    // 合法候选同事务持久化（候选 + Attempt + Job）
    const candidates = researchWiring.validateMediaCandidates([
      { kind: 'image', url: fixtureUrl(server, '/img/bench.png'), captionHint: 'Benchmark 总表' },
      { kind: 'video', url: fixtureUrl(server, '/video/demo.mp4') },
      { kind: 'video_poster', url: fixtureUrl(server, '/img/og-chart.png'), parentUrl: fixtureUrl(server, '/video/demo.mp4') }
    ]);
    assert.equal(candidates.length, 3);
    const persisted = researchWiring.persistSourceMediaCandidates(db, {
      sourceId: source.id, sourceRevisionKey: revKey, channel: 'research', candidates, requestId: 'r-b2'
    });
    assert.equal(persisted.inserted.length, 3);
    assert.equal(count(db, 'source_media_candidates'), 3);
    assert.equal(count(db, 'media_archive_attempts'), 3);
    assert.equal(count(db, 'jobs'), 3);
    // 重放幂等：同 revision 再存 → 复用既有候选，不重复 Attempt/Job
    const replay = researchWiring.persistSourceMediaCandidates(db, {
      sourceId: source.id, sourceRevisionKey: revKey, channel: 'research', candidates, requestId: 'r-b2'
    });
    assert.equal(replay.reused.length, 3);
    assert.equal(count(db, 'media_archive_attempts'), 3, '重放不得新增 Attempt');
    assert.equal(count(db, 'jobs'), 3, '重放不得新增 Job');
  });
});

test('B3 官网：srcset/相对 URL/OG 兜底/tracking pixel 过滤 + 同事务冻结（§7.3）', async () => {
  await withMediaDb(async ({ db, server }) => {
    const source = seedResearchSource(db, { originalUrl: server.url('/') });
    const revKey = mediaCandidatesShared.sourceRevisionKey(source.id, source.revision);
    const html = webPageFixture({ baseUrl: server.url(''), hasTrackingPixel: true });
    const discovered = websiteDiscovery.discoverWebsiteMedia({ html, baseUrl: server.url('/') });
    // 正文：bench-small(320w srcset) + bench-large(1280w srcset) + relative-test-limits + og-chart 兜底
    const urls = discovered.map((d) => d.url);
    assert.ok(urls.includes(`${server.url('/')}bench-small.png`), 'srcset 首候选必须解析');
    assert.ok(urls.includes(`${server.url('/')}bench-large.png`), 'srcset 第二候选必须解析');
    assert.ok(urls.includes(`${server.url('/')}relative-test-limits.png`), '相对 URL 必须按规范 URL 解析');
    assert.ok(!urls.includes(server.url('/tracking-pixel.gif')), 'tracking pixel(<64px) 必须过滤');
    assert.ok(!urls.includes(server.url('/favicon.ico')), 'favicon 必须过滤');
    assert.ok(urls.some((u) => u.endsWith('og-chart.png')), 'OG 图必须在正文无同 URL 时补入');
    const videoSlot = discovered.find((d) => d.kind === 'video');
    assert.ok(videoSlot, '直接视频必须发现');
    const poster = discovered.find((d) => d.kind === 'video_poster');
    assert.ok(poster, 'video poster 必须发现');
    assert.equal(poster.parentOrdinal, videoSlot.ordinal, 'poster 父引用同 ordinal');

    const persisted = websiteDiscovery.persistWebsiteMediaCandidates(db, {
      sourceId: source.id, sourceRevisionKey: revKey, requestId: 'r-b3',
      discoveredAt: new Date().toISOString(), html, baseUrl: server.url('/')
    });
    assert.equal(persisted.inserted.length, discovered.length);
    assert.equal(persisted.archiveJobCount, discovered.length);
    // 超 Source 策略（skipped_limit）不建 Attempt/Job：直接塞满图片配额
    const many = Array.from({ length: MEDIA_LIMITS_DEFAULT.maxImagesPerRevision + 3 }, (_, i) => ({
      kind: 'image', originalUrl: `${FIXTURE_HOST}/img/bench.png`, ordinal: 100 + i
    }));
    const over = store.insertMediaCandidates(db, {
      sourceId: source.id, sourceRevisionKey: revKey, channel: 'official_web', requestId: 'r-b3b',
      discoveredAt: new Date().toISOString(), candidates: many.map((m) => ({ ...m, status: 'skipped_limit' }))
    });
    assert.equal(over.inserted.length, many.length);
  });
});

test('B4 Source/Candidate/Job 同事务：崩溃后候选不丢（§7.1/§16-4）', async () => {
  await withMediaDb(async ({ db, server }) => {
    const source = seedResearchSource(db);
    const revKey = mediaCandidatesShared.sourceRevisionKey(source.id, source.revision);
    const candidates = researchWiring.validateMediaCandidates([
      { kind: 'image', url: fixtureUrl(server, '/img/bench.png') }
    ]);
    researchWiring.persistSourceMediaCandidates(db, {
      sourceId: source.id, sourceRevisionKey: revKey, channel: 'research', candidates, requestId: 'r-b4'
    });
    assert.equal(count(db, 'source_media_candidates'), 1);
    assert.equal(count(db, 'jobs'), 1);
    assert.equal(store.getMediaCandidate(db, store.listMediaCandidatesForRevision(db, revKey)[0].id).requestId, 'r-b4');
    // X Source 无正文 revision 也必须可冻结媒体（§4 不变量 4）
    const noBody = upsertSource(db, { originalUrl: `https://x.com/no-body-${randomUUID()}`, title: 'X 快照', summary: 'x', clientLabel: 'WMB research' });
    const revKey2 = mediaCandidatesShared.sourceRevisionKey(noBody.id, noBody.revision);
    const frozen = xWiring.freezeXTimelineMediaCandidates(db, {
      sourceId: noBody.id, sourceRevision: noBody.revision,
      post: {
        url: 'https://x.com/nb/1', authorHandle: null, displayName: null, avatarUrl: null, text: 'x',
        postedAt: null, images: [`${FIXTURE_HOST}/img/tiny.jpg`], imageThumbs: [], hasVideo: false,
        videoPoster: null, videoUrl: null, metrics: { replies: 0, reposts: 0, likes: 0, bookmarks: 0, views: 0 }
      },
      postOrdinal: 0, requestId: 'x-no-body', discoveredAt: new Date().toISOString()
    });
    assert.equal(frozen.inserted.length, 1);
    assert.equal(count(db, 'source_media_candidates'), 2);
  });
});

// ============================================================
// C. 归档 worker（§8）
// ============================================================

test('C1 preserved：下载→校验→Asset+Binding+Provenance 同事务；离线字节可读（§16-2/5）', async () => {
  await withMediaDb(async ({ db, server, dataRoot }) => {
    const source = seedResearchSource(db);
    const revKey = mediaCandidatesShared.sourceRevisionKey(source.id, source.revision);
    const candidates = researchWiring.validateMediaCandidates([
      { kind: 'image', url: fixtureUrl(server, '/img/bench.png'), captionHint: 'Benchmark 总表' },
      { kind: 'video', url: fixtureUrl(server, '/video/demo.mp4') }
    ]);
    researchWiring.persistSourceMediaCandidates(db, {
      sourceId: source.id, sourceRevisionKey: revKey, channel: 'research', candidates, requestId: 'r-c1'
    });
    const run = await worker.runDueMediaArchiveJobs(db, { deps: workerDeps(server), dataRoot });
    assert.equal(run.preserved, 2, '两候选必须 preserved');
    const summary = worker.getSourceMediaSummary(db, source.id, revKey);
    assert.equal(summary.total, 2);
    assert.equal(summary.preserved, 2);
    const bindings = store.listSourceMediaBindings(db, revKey);
    assert.equal(bindings.length, 2);
    for (const binding of bindings) {
      assert.equal(binding.sha256.length, 64, 'binding 必须带 SHA-256 快照');
      assert.equal(binding.rightsStatus, 'unknown', '默认 rights_status=unknown');
      const asset = row(db, 'SELECT relative_path AS p, mime_type AS m, byte_count AS b, sha256 AS s FROM assets WHERE id=?', binding.assetId);
      assert.ok(asset, 'preserved 候选必须有 Asset');
      assert.equal(asset.s, binding.sha256, 'binding.sha256 必须等于 asset.sha256');
      // 同事务独立 imported Provenance（§6.5）
      const prov = row(db, "SELECT kind FROM asset_provenance WHERE asset_id=? AND source_revision_id=?", binding.assetId, revKey);
      assert.equal(prov?.kind, 'imported');
      // 候选终态 preserved
      assert.equal(store.getMediaCandidate(db, binding.candidateId).status, 'preserved');
      // 失败候选不创建假 Binding 的不变量：binding 行 = preserved 数
      assert.equal(count(db, 'source_media_bindings'), 2);
    }
    // 远程失效后本地仍可逐字节读取（§2-2/§16-2）
    await server.close();
    for (const binding of bindings) {
      const asset = row(db, 'SELECT relative_path AS p, byte_count AS b FROM assets WHERE id=?', binding.assetId);
      const local = await readFile(path.join(dataRoot, asset.p));
      assert.equal(local.length, asset.b, '本地字节必须完整');
      assert.equal(store.getMediaCandidate(db, binding.candidateId).status, 'preserved', '离线后状态不变');
    }
  });
});

test('C2 同 URL 同字节零重复；同 URL 内容变化新 Asset；异 URL 同字节复用 Asset 独立血缘（§16-5）', async () => {
  await withMediaDb(async ({ db, server, dataRoot }) => {
    const source = seedResearchSource(db);
    const revKey = mediaCandidatesShared.sourceRevisionKey(source.id, source.revision);
    // 四个候选：A/B 同 URL 同字节（重复）、C/D 同 URL 内容变化（mutable）。
    // validateMediaCandidates 会按稳定身份去重，重复 URL 候选必须直接构造描述符。
    const candidates = [
      { kind: 'image', url: fixtureUrl(server, '/img/tiny.jpg'), ordinal: 0 },
      { kind: 'image', url: fixtureUrl(server, '/img/tiny.jpg'), ordinal: 1 }, // 同 URL 同字节 → 复用
      { kind: 'image', url: fixtureUrl(server, '/edge/mutable.png'), ordinal: 2 }, // 每次内容变化
      { kind: 'image', url: fixtureUrl(server, '/edge/mutable.png'), ordinal: 3 }
    ];
    researchWiring.persistSourceMediaCandidates(db, {
      sourceId: source.id, sourceRevisionKey: revKey, channel: 'research', candidates, requestId: 'r-c2'
    });
    const run = await worker.runDueMediaArchiveJobs(db, { deps: workerDeps(server), dataRoot, limit: 10 });
    assert.equal(run.preserved, 4);
    // 同 URL 同字节：两个候选均 preserved，但按设计 §16-5 零重复 ——
    // source_media_bindings UNIQUE(source_revision_key, asset_id)：同 revision 同字节共享一个
    // Binding + 一个 Asset（见 wmb-5244-media-archive.test.mjs 的 UNIQUE 复用验收）。
    const saved = store.listMediaCandidatesForRevision(db, revKey).sort((a, b) => a.ordinal - b.ordinal);
    assert.equal(saved.length, 4);
    const tinyPair = saved.filter((c) => c.originalUrl.endsWith('/img/tiny.jpg'));
    assert.equal(tinyPair.length, 2);
    assert.ok(tinyPair.every((c) => c.status === 'preserved'), '同 URL 同字节两候选必须 preserved');
    const bindings = store.listSourceMediaBindings(db, revKey).sort((a, b) => a.ordinal - b.ordinal);
    assert.equal(bindings.length, 3, '同 URL 同字节共享 Binding，不产生重复 Binding');
    assert.equal(count(db, 'assets'), 3, '同 URL 同字节只登记一个 Asset（零重复）');
    const tinyBinding = bindings.find((b) => b.originalUrl.endsWith('/img/tiny.jpg'));
    const sameShaAssets = rows(db, 'SELECT id FROM assets WHERE sha256=?', tinyBinding.sha256);
    assert.equal(sameShaAssets.length, 1, '同字节只登记一个 Asset');
    // 候选 2/3（mutable，内容变化）各自新 Asset
    const mutableBindings = bindings.filter((b) => b.originalUrl.endsWith('/edge/mutable.png')).sort((a, b) => a.ordinal - b.ordinal);
    assert.equal(mutableBindings.length, 2);
    assert.notEqual(mutableBindings[0].assetId, mutableBindings[1].assetId, '同 URL 内容变化必须新 Asset');
    // 血缘：每个登记 Binding 一行独立 imported Provenance（共享 Binding 不重复行）
    const provRows = rows(db, 'SELECT asset_id AS a FROM asset_provenance WHERE source_revision_id=?', revKey);
    assert.equal(provRows.length, 3, '每登记 Binding 一行独立 Provenance');
  });
});

test('C3 状态分类：HEAD 超限/流式越限/时长超限 → needs_user；错 MIME → unsupported（§8/§16-6/7）', async () => {
  await withMediaDb(async ({ db, server, dataRoot }) => {
    const source = seedResearchSource(db);
    const revKey = mediaCandidatesShared.sourceRevisionKey(source.id, source.revision);
    // 六个状态分类场景超单批视频上限（>4），且本测试验证的是 worker 状态分类而非校验：
    // 直接构造描述符（validateMediaCandidates 会先按稳定身份去重并按 maxVideosPerRevision 拒绝）。
    const candidates = [
      { kind: 'video', url: fixtureUrl(server, '/edge/head-over-limit.mp4'), ordinal: 0 },
      { kind: 'image', url: fixtureUrl(server, '/edge/stream-over-limit.png'), ordinal: 1 },
      { kind: 'video', url: fixtureUrl(server, '/edge/wrong-mime.mp4'), ordinal: 2 },
      { kind: 'video', url: fixtureUrl(server, '/edge/forbidden.mp4'), ordinal: 3 },
      { kind: 'video', url: fixtureUrl(server, '/edge/stream.m3u8'), ordinal: 4 },
      { kind: 'video', url: fixtureUrl(server, '/video/demo.mp4'), ordinal: 5 }
    ];
    researchWiring.persistSourceMediaCandidates(db, {
      sourceId: source.id, sourceRevisionKey: revKey, channel: 'research', candidates, requestId: 'r-c3'
    });
    // 时长超限：注入 31min probe（demo.mp4 字节本身合法 → 下载成功后才按时长拒绝）
    const longProbe = async () => ({ durationMs: 31 * 60 * 1000, runtimeName: 'wmb-test', runtimeVersion: '1' });
    const run = await worker.runDueMediaArchiveJobs(db, {
      deps: { ...workerDeps(server), probeDurationMs: longProbe }, dataRoot, limit: 10
    });
    const byUrl = new Map(store.listMediaCandidatesForRevision(db, revKey).map((c) => [c.originalUrl, c.status]));
    assert.equal(byUrl.get(fixtureUrl(server, '/edge/head-over-limit.mp4')), 'needs_user', 'HEAD 声明超限 → needs_user');
    assert.equal(byUrl.get(fixtureUrl(server, '/edge/stream-over-limit.png')), 'needs_user', '流式越限 → needs_user');
    assert.equal(byUrl.get(fixtureUrl(server, '/edge/wrong-mime.mp4')), 'unsupported', '错误 MIME → unsupported');
    assert.equal(byUrl.get(fixtureUrl(server, '/edge/forbidden.mp4')), 'failed', '403 → failed（临时，可重试）');
    assert.equal(byUrl.get(fixtureUrl(server, '/edge/stream.m3u8')), 'unsupported', 'm3u8 → unsupported');
    assert.equal(byUrl.get(fixtureUrl(server, '/video/demo.mp4')), 'needs_user', '时长超限 → needs_user');
    assert.equal(count(db, 'assets'), 0, '失败路径零假 Asset');
    assert.equal(count(db, 'source_media_bindings'), 0, '失败路径零 Binding');
  });
});

test('C4 失败回退/重试耗尽：403 退避重排，3 次耗尽终态 failed，attempt 行逐次保留（§8/§16-6）', async () => {
  await withMediaDb(async ({ db, server, dataRoot }) => {
    const source = seedResearchSource(db);
    const revKey = mediaCandidatesShared.sourceRevisionKey(source.id, source.revision);
    const candidates = researchWiring.validateMediaCandidates([
      { kind: 'video', url: fixtureUrl(server, '/edge/forbidden.mp4') }
    ]);
    researchWiring.persistSourceMediaCandidates(db, {
      sourceId: source.id, sourceRevisionKey: revKey, channel: 'research', candidates, requestId: 'r-c4'
    });
    const candidateId = store.listMediaCandidatesForRevision(db, revKey)[0].id;
    const jobId = row(db, 'SELECT id FROM jobs WHERE dedupe_key=?', archiveJobDedupe(revKey, candidateId)).id;

    // 第一次 claim+execute+finish：403 retryable → 候选 failed + job pending（退避重排）
    let claim = worker.claimMediaArchiveJob(db, jobId, 0, { requestId: 'c4-1' });
    assert.equal(claim.claimed, true);
    const exec1 = await worker.executeMediaArchiveCandidate(db, candidateId, claim.attemptNumber, dataRoot, workerDeps(server));
    assert.equal(exec1.outcome, 'failed');
    const finish1 = worker.finishMediaArchiveJob(db, { jobId, expectedAttempts: claim.job.attempts, result: exec1 });
    assert.equal(finish1.jobStatus, 'pending', '临时失败必须退避重排');
    assert.equal(store.getMediaCandidate(db, candidateId).status, 'failed');
    assert.equal(count(db, 'media_archive_attempts'), 1);
    // 退避重排后 due_at 在未来；测试直接拨回过去以驱动下一次 claim（验证重试链本身）。
    db.prepare("UPDATE jobs SET due_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), jobId);

    // 第二次：job.attempts=1 → 顺延 attempt 2
    claim = worker.claimMediaArchiveJob(db, jobId, 1, { requestId: 'c4-2' });
    assert.equal(claim.claimed, true, 'attempt 2 必须可 claim');
    assert.equal(claim.attemptNumber, 2);
    const exec2 = await worker.executeMediaArchiveCandidate(db, candidateId, claim.attemptNumber, dataRoot, workerDeps(server));
    worker.finishMediaArchiveJob(db, { jobId, expectedAttempts: claim.job.attempts, result: exec2 });
    assert.equal(count(db, 'media_archive_attempts'), 2);
    db.prepare("UPDATE jobs SET due_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), jobId);

    // 第三次：耗尽 → 终态 failed，job failed
    claim = worker.claimMediaArchiveJob(db, jobId, 2, { requestId: 'c4-3' });
    assert.equal(claim.claimed, true, 'attempt 3 必须可 claim');
    assert.equal(claim.attemptNumber, 3);
    const exec3 = await worker.executeMediaArchiveCandidate(db, candidateId, claim.attemptNumber, dataRoot, workerDeps(server));
    const finish3 = worker.finishMediaArchiveJob(db, { jobId, expectedAttempts: claim.job.attempts, result: exec3 });
    assert.equal(finish3.jobStatus, 'failed', 'attempt 耗尽后 job 必须 failed');
    assert.match(store.getMediaCandidate(db, candidateId).errorCode, /RETRY_EXHAUSTED/);
    assert.equal(count(db, 'media_archive_attempts'), 3, '每次执行一行，旧失败不覆盖');
    // 用户重试：failed → pending 重新武装生命周期
    const retry = worker.retryMediaArchiveCandidate(db, candidateId);
    assert.equal(retry.ok, true);
    assert.equal(store.getMediaCandidate(db, candidateId).status, 'pending');
  });
});

test('C5 SSRF/DNS rebinding：环回/私网/保留主机名/每跳重解析全部拒绝（§8/§16-6）', async () => {
  await withMediaDb(async ({ db, dataRoot, server }) => {
    // 环回/私网主机名与 IP 字面量
    for (const url of ['http://localhost:1234/x.png', 'http://127.0.0.1:1234/x.png', 'http://10.0.0.5:1234/x.png', 'http://169.254.169.254:1234/x.png']) {
      const result = await fetchGuard.fetchWithMediaGuard({ url, mode: 'image', limits: MEDIA_LIMITS_DEFAULT, dataRoot });
      assert.equal(result.ok, false, `必须拒绝 ${url}`);
      assert.equal(result.error.code, 'SSRF_BLOCKED');
    }
    // 注入 resolveHost 返回私网 → 拒绝
    const privateDns = await fetchGuard.fetchWithMediaGuard({
      url: `http://${FIXTURE_HOST}/img/tiny.jpg`, mode: 'image', limits: MEDIA_LIMITS_DEFAULT, dataRoot,
      resolveHost: async () => ['192.168.1.10']
    });
    assert.equal(privateDns.ok, false);
    assert.equal(privateDns.error.code, 'SSRF_BLOCKED');
    // DNS rebinding：首跳公网、二跳私网 → 每跳重新解析拒绝（fetch 经 fixture 服务器真实执行）
    let calls = 0;
    const rebinding = await fetchGuard.fetchWithMediaGuard({
      url: `http://${FIXTURE_HOST}/edge/redirect-1.mp4`, mode: 'video', limits: MEDIA_LIMITS_DEFAULT, dataRoot,
      fetchImpl: fixtureFetchImpl(server),
      resolveHost: async () => {
        calls += 1;
        return calls === 1 ? ['93.184.216.34'] : ['10.0.0.5'];
      }
    });
    assert.equal(rebinding.ok, false);
    assert.equal(rebinding.error.code, 'SSRF_BLOCKED');
    assert.ok(calls >= 2, '重定向后必须重新解析 DNS');
  });
});

test('C6 启动恢复：孤儿 downloading/running >15min → DOWNLOAD_INTERRUPTED（§6.4/§16-4）', async () => {
  await withMediaDb(async ({ db, server }) => {
    const source = seedResearchSource(db);
    const revKey = mediaCandidatesShared.sourceRevisionKey(source.id, source.revision);
    const candidates = researchWiring.validateMediaCandidates([{ kind: 'image', url: fixtureUrl(server, '/img/tiny.jpg') }]);
    researchWiring.persistSourceMediaCandidates(db, {
      sourceId: source.id, sourceRevisionKey: revKey, channel: 'research', candidates, requestId: 'r-c6'
    });
    const candidateId = store.listMediaCandidatesForRevision(db, revKey)[0].id;
    const jobId = row(db, 'SELECT id FROM jobs WHERE dedupe_key=?', archiveJobDedupe(revKey, candidateId)).id;
    // 认领后"崩溃"：claim 真实置 job running + 候选 downloading + attempt 1（模拟进程崩溃现场）。
    const claim = worker.claimMediaArchiveJob(db, jobId, 0, { requestId: 'crash' });
    assert.equal(claim.claimed, true, '崩溃前必须可认领');
    // 模拟 20 分钟前崩溃（updated_at 回拨到过去）。
    const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    db.prepare('UPDATE jobs SET updated_at=? WHERE id=?').run(old, jobId);
    const recovered = worker.recoverInterruptedMediaArchiveJobs(db, { staleAfterMs: 15 * 60 * 1000 });
    assert.equal(recovered.recovered, 1);
    const cand = store.getMediaCandidate(db, candidateId);
    assert.equal(cand.status, 'failed');
    assert.equal(cand.errorCode, 'DOWNLOAD_INTERRUPTED');
    const job = row(db, 'SELECT status FROM jobs WHERE dedupe_key=?', archiveJobDedupe(revKey, candidateId));
    assert.equal(job.status, 'pending', '可重试 → job 回 pending');
    const attempt = store.listArchiveAttempts(db, candidateId);
    assert.equal(attempt[attempt.length - 1].status, 'failed');
    assert.equal(attempt[attempt.length - 1].errorCode, 'DOWNLOAD_INTERRUPTED');
  });
});

test('C7 全局暂停：停止 claim 新 job（§6.4）', async () => {
  await withMediaDb(async ({ db, server, dataRoot }) => {
    const source = seedResearchSource(db);
    const revKey = mediaCandidatesShared.sourceRevisionKey(source.id, source.revision);
    const candidates = researchWiring.validateMediaCandidates([{ kind: 'image', url: fixtureUrl(server, '/img/tiny.jpg') }]);
    researchWiring.persistSourceMediaCandidates(db, {
      sourceId: source.id, sourceRevisionKey: revKey, channel: 'research', candidates, requestId: 'r-c7'
    });
    worker.setMediaArchivePaused(db, true);
    const run = await worker.runDueMediaArchiveJobs(db, { deps: workerDeps(server), dataRoot });
    assert.equal(run.processed, 0, '暂停时必须不处理任何 job');
    assert.equal(store.getMediaCandidate(db, store.listMediaCandidatesForRevision(db, revKey)[0].id).status, 'pending');
    worker.setMediaArchivePaused(db, false);
    const resumed = await worker.runDueMediaArchiveJobs(db, { deps: workerDeps(server), dataRoot });
    assert.equal(resumed.preserved, 1);
  });
});

// ============================================================
// D. 图片理解（§9）
// ============================================================

test('D1 preserved 图片自动入队 ≤12/Source revision；超限显式 unprocessed（§9/§16-15）', async () => {
  await withMediaDb(async ({ db, server, dataRoot }) => {
    const source = seedResearchSource(db);
    const revKey = mediaCandidatesShared.sourceRevisionKey(source.id, source.revision);
    // 15 张图（各自独立字节 → 独立 Asset；validateMediaCandidates 会按稳定身份去重，
    // 重复 URL 候选必须直接构造描述符）→ 自动理解 ≤12
    const candidates = [];
    for (let i = 0; i < 15; i += 1) {
      const route = `/img/d1-${i}.png`;
      server.static(route, pngBytes(64, 64, [10 + i * 7, 20, 30]), { mimeType: 'image/png' });
      candidates.push({ kind: 'image', url: fixtureUrl(server, route), ordinal: i });
    }
    researchWiring.persistSourceMediaCandidates(db, {
      sourceId: source.id, sourceRevisionKey: revKey, channel: 'research', candidates, requestId: 'r-d1'
    });
    assert.equal(count(db, 'source_media_candidates'), 15, '15 个候选行必须全部落库');
    const run = await worker.runDueMediaArchiveJobs(db, { deps: workerDeps(server), dataRoot, limit: 20 });
    assert.equal(run.preserved, 15);
    assert.equal(count(db, 'assets'), 15, '15 个独立字节必须 15 个 Asset');
    const auto = visual.autoEnqueuePreservedSourceImages(db, { sourceId: source.id, sourceRevisionKey: revKey });
    assert.equal(auto.enqueued.length, visual.VISUAL_AUTO_ENQUEUE_LIMIT, '自动入队必须 ≤12');
    assert.equal(auto.skippedLimit, 3, '超限图片必须跳过');
    const status = visual.readSourceRevisionVisualStatus(db, revKey, source.id);
    assert.equal(status.preservedImages, 15);
    assert.equal(status.autoEnqueued, 12);
    assert.equal(status.unprocessed, 3, '超限图片显式 unprocessed（已保存、尚未理解）');
    // kind 门：视频 binding 不入队
    const videoCand = researchWiring.validateMediaCandidates([{ kind: 'video', url: fixtureUrl(server, '/video/demo.mp4') }]);
    researchWiring.persistSourceMediaCandidates(db, {
      sourceId: source.id, sourceRevisionKey: revKey, channel: 'research', candidates: videoCand, requestId: 'r-d1b'
    });
    await worker.runDueMediaArchiveJobs(db, { deps: workerDeps(server), dataRoot });
    const videoBinding = store.listSourceMediaBindings(db, revKey).find((b) => b.kind === 'video');
    const gate = visual.enqueuePreservedSourceImage(db, { sourceId: source.id, sourceRevisionKey: revKey, assetId: videoBinding.assetId, kind: 'video' });
    assert.equal(gate.enqueued, false);
    assert.equal(gate.reason, 'not_image');
  });
});

test('D2 region 校验 fail-closed + locator 兼容（§9/§16-15）', async () => {
  await withMediaDb(async ({ db, server, dataRoot }) => {
    const source = seedResearchSource(db);
    const revKey = mediaCandidatesShared.sourceRevisionKey(source.id, source.revision);
    const candidates = researchWiring.validateMediaCandidates([{ kind: 'image', url: fixtureUrl(server, '/img/bench.png') }]);
    researchWiring.persistSourceMediaCandidates(db, {
      sourceId: source.id, sourceRevisionKey: revKey, channel: 'research', candidates, requestId: 'r-d2'
    });
    await worker.runDueMediaArchiveJobs(db, { deps: workerDeps(server), dataRoot });
    const binding = store.listSourceMediaBindings(db, revKey)[0];
    // 非法 region 入队必须 fail-closed
    for (const bad of [
      { x: 0, y: 0, width: 2, height: 1 }, { x: -0.1, y: 0, width: 1, height: 1 },
      { x: 0, y: 0, width: 0, height: 1 }, { x: 0, y: 0, width: 1, height: NaN }
    ]) {
      assert.throws(() => visual.enqueueVisualRun(db, {
        sourceId: source.id, sourceRevisionId: revKey, assetId: binding.assetId, region: bad
      }), (e) => e.code === 'REGION_INVALID', `非法 region 必须拒绝: ${JSON.stringify(bad)}`);
    }
    assert.equal(count(db, 'knowledge_visual_runs'), 0, 'fail-closed 零入队');
    // 合法 region + 整图幂等（region 不参与幂等键）
    const withRegion = visual.enqueueVisualRun(db, { sourceId: source.id, sourceRevisionId: revKey, assetId: binding.assetId, region: { x: 0, y: 0, width: 0.5, height: 0.5 } });
    assert.equal(withRegion.created, true);
    const whole = visual.enqueueVisualRun(db, { sourceId: source.id, sourceRevisionId: revKey, assetId: binding.assetId });
    assert.equal(whole.created, false, '同 (source,revision,asset,schemaVersion) 幂等');
  });
});

test('D3 图片理解执行：stub model → completed + observation（§9）', async () => {
  await withMediaDb(async ({ db, server, dataRoot }) => {
    const source = seedResearchSource(db);
    const revKey = mediaCandidatesShared.sourceRevisionKey(source.id, source.revision);
    const candidates = researchWiring.validateMediaCandidates([{ kind: 'image', url: fixtureUrl(server, '/img/bench.png') }]);
    researchWiring.persistSourceMediaCandidates(db, {
      sourceId: source.id, sourceRevisionKey: revKey, channel: 'research', candidates, requestId: 'r-d3'
    });
    await worker.runDueMediaArchiveJobs(db, { deps: workerDeps(server), dataRoot });
    const binding = store.listSourceMediaBindings(db, revKey)[0];
    const { run } = visual.enqueueVisualRun(db, { sourceId: source.id, sourceRevisionId: revKey, assetId: binding.assetId });
    const stubModel = async () => `\`\`\`json\n${JSON.stringify({
      wmb_visual_observation: {
        reason: '验收：Benchmark 总表匹配成绩段落。',
        items: [
          { kind: 'claim', canonicalKey: 'benchmark-score', statement: 'DeepSeek-V4-Pro 基准测试成绩领先。', excerpt: 'MMLU-Pro 与 GPQA 领先。', valueRationale: '总表可独立核对。' }
        ]
      }
    })}\n\`\`\``;
    const completed = await visual.executeVisualRun(db, run.id, { dataRoot, modelCall: stubModel });
    assert.equal(completed.status, 'completed');
    assert.ok(completed.observation?.items?.length > 0);
    // 图片 chain 与视频运行时缺失解耦：视觉 run 无需 media runtime
    const loc = visual.visualEvidenceLocator(binding.assetId, revKey);
    assert.equal(loc, `asset:${binding.assetId}|sourceRevision:${revKey}`);
  });
});

// ============================================================
// E. 视频理解（§10）
// ============================================================

test('E1 字幕轨选择规则：forced/default → 语言匹配 → 第一条（§10.5）', () => {
  const probe = (tracks) => ({ subtitleTracks: tracks });
  // forced/default 优先
  assert.equal(video.pickSubtitleTrack(probe([{ index: 0, language: 'en', forced: false, default: true }]), 'zh'), 0);
  assert.equal(video.pickSubtitleTrack(probe([{ index: 1, language: 'en', forced: true, default: false }, { index: 0, language: 'zh', forced: false, default: false }]), 'zh'), 1);
  // 语言匹配优先于第一条
  assert.equal(video.pickSubtitleTrack(probe([{ index: 0, language: 'en', forced: false, default: false }, { index: 1, language: 'zh', forced: false, default: false }]), 'zh'), 1);
  // 无匹配 → 第一条
  assert.equal(video.pickSubtitleTrack(probe([{ index: 2, language: 'en', forced: false, default: false }]), 'zh'), 2);
  // 无字幕轨 → null（走 ASR/OCR）
  assert.equal(video.pickSubtitleTrack(probe([]), 'zh'), null);
});

test('E2 执行管线：原生字幕优先且零 ASR/OCR；无字幕有音轨走 ASR（§10.5/§16-8/9）', async () => {
  await withMediaDb(async ({ db, server, dataRoot }) => {
    const source = seedResearchSource(db);
    const revKey = mediaCandidatesShared.sourceRevisionKey(source.id, source.revision);
    const candidates = researchWiring.validateMediaCandidates([{ kind: 'video', url: fixtureUrl(server, '/video/demo.mp4') }]);
    researchWiring.persistSourceMediaCandidates(db, {
      sourceId: source.id, sourceRevisionKey: revKey, channel: 'research', candidates, requestId: 'r-e2'
    });
    await worker.runDueMediaArchiveJobs(db, { deps: workerDeps(server), dataRoot });
    const binding = store.listSourceMediaBindings(db, revKey)[0];
    const asset = row(db, 'SELECT relative_path AS p FROM assets WHERE id=?', binding.assetId);
    assert.ok(asset, '视频 Asset 必须存在');

    const calls = { asr: 0, ocr: 0, probe: 0, subtitle: 0 };
    const runtimeAdapter = {
      identity: 'fake-runtime-1',
      probe: async () => { calls.probe += 1; return {
        container: 'mp4', durationMs: 12000, width: 640, height: 360, frameRate: 30, rotation: null,
        videoCodec: 'h264', audioCodec: 'aac', hasAudio: true,
        subtitleTracks: [{ index: 0, language: 'zh', forced: false, default: true }], chapters: [],
        runtimeManifestHash: 'fake-runtime-1'
      }; },
      extractSubtitles: async () => { calls.subtitle += 1; return video.parseSrtToSegments(subtitleSrt(), 'native'); },
      runAsr: async () => { calls.asr += 1; return [{ startMs: 1000, endMs: 3000, text: 'ASR 不应被调用', source: 'asr' }]; },
      detectScenes: async () => [3000, 8000],
      extractKeyframe: async () => ({ bytes: jpegBytes(), width: 640, height: 360, phash: 'ph-1' }),
      runOcr: async () => { calls.ocr += 1; return []; }
    };
    const { run } = video.enqueueVideoRun(db, { sourceId: source.id, sourceRevisionKey: revKey, assetId: binding.assetId });
    const summaryCall = async ({ segments }) => segments.map((s) => ({ index: s.index, summary: '实测视频体验', confidence: 0.9 }));
    const completed = await video.executeVideoRun(db, run.id, { dataRoot, runtime: runtimeAdapter, summaryCall, sourceLanguage: 'zh' });
    assert.equal(completed.status, 'completed');
    assert.equal(calls.asr, 0, '有原生字幕时 ASR 必须零调用');
    assert.equal(calls.ocr, 0, '有原生字幕时 OCR 必须零调用');
    const transcript = videoStore.parseTranscriptJson(completed);
    assert.equal(transcript.source, 'native', '字幕优先 → transcriptSource=native');
    assert.ok(transcript.segments.length >= 3, 'SRT 全部段必须解析');
    const segments = videoStore.parseSegmentsJson(completed);
    assert.ok(segments.length >= 1);
    for (const seg of segments) {
      assert.ok(Number.isInteger(seg.startMs) && Number.isInteger(seg.endMs));
      assert.ok(seg.startMs >= 0 && seg.endMs > seg.startMs && seg.endMs <= 12000, '时间范围必须合法');
    }
    // 关键帧注册为 derived_keyframe Asset（§10.6/§16-18）
    const keyframes = videoStore.parseKeyframesJson(completed);
    assert.ok(keyframes.length >= 1);
    for (const kf of keyframes) {
      const prov = row(db, "SELECT transform_json AS t FROM asset_provenance WHERE derived_asset_id=? AND kind='derived_keyframe'", kf.assetId);
      assert.ok(prov, '关键帧必须有 derived_keyframe 血缘');
      const transform = JSON.parse(prov.t);
      assert.equal(transform.timeMs, kf.timeMs);
    }
  });
});

test('E3 ASR 路径 + ASR 失败新 attempt 旧行不变（§10.5/§16-9）', async () => {
  await withMediaDb(async ({ db, server, dataRoot }) => {
    const source = seedResearchSource(db);
    const revKey = mediaCandidatesShared.sourceRevisionKey(source.id, source.revision);
    const candidates = researchWiring.validateMediaCandidates([{ kind: 'video', url: fixtureUrl(server, '/video/demo.mp4') }]);
    researchWiring.persistSourceMediaCandidates(db, {
      sourceId: source.id, sourceRevisionKey: revKey, channel: 'research', candidates, requestId: 'r-e3'
    });
    await worker.runDueMediaArchiveJobs(db, { deps: workerDeps(server), dataRoot });
    const binding = store.listSourceMediaBindings(db, revKey)[0];

    const failing = {
      identity: 'fake-runtime-2', probe: async () => ({
        container: 'mp4', durationMs: 12000, width: 640, height: 360, frameRate: 30, rotation: null,
        videoCodec: 'h264', audioCodec: 'aac', hasAudio: true, subtitleTracks: [], chapters: [], runtimeManifestHash: 'fake-runtime-2'
      }),
      extractSubtitles: async () => [],
      runAsr: async () => { throw Object.assign(new Error('ASR_FAILED: whisper OOM'), { code: 'ASR_FAILED' }); },
      detectScenes: async () => [],
      extractKeyframe: async () => ({ bytes: jpegBytes(), width: 640, height: 360, phash: 'ph-2' }),
      runOcr: async () => []
    };
    const summaryCall = async ({ segments }) => segments.map((s) => ({ index: s.index, summary: 'x', confidence: 0.9 }));
    const { run: run1 } = video.enqueueVideoRun(db, { sourceId: source.id, sourceRevisionKey: revKey, assetId: binding.assetId });
    const failedRun = await video.executeVideoRun(db, run1.id, { dataRoot, runtime: failing, summaryCall });
    assert.equal(failedRun.status, 'failed');
    assert.equal(failedRun.errorCode, 'ASR_FAILED');

    // 重试 → 新 attempt（旧行不可变保留）
    const retried = video.retryVideoRun(db, run1.id);
    assert.equal(retried.created, true);
    assert.ok(retried.run.attempt > run1.attempt);
    const oldRow = videoStore.getVideoRun(db, run1.id);
    assert.equal(oldRow.status, 'failed');
    assert.equal(oldRow.errorCode, 'ASR_FAILED');
    assert.equal(videoStore.getVideoRun(db, retried.run.id).attempt, 2);
  });
});

test('E4 镜头/兜底/关键帧纯函数：2s 合并、10s 兜底、≤48 帧、感知哈希去重（§10.6/§16-11）', () => {
  // <2s 相邻镜头合并
  assert.deepEqual(video.mergeSceneBoundaries([1000, 2500, 9000]), [1000, 9000]);
  // 任意 10s 窗口无镜头 → 窗口末尾兜底边界
  assert.deepEqual(video.computeFallbackBoundaries([], 30000, 10000), [10000, 20000]);
  assert.deepEqual(video.computeFallbackBoundaries([15000], 30000, 10000), [10000], '窗口 0-10s 无镜头 → 10000；10-20s 含 15000 镜头不兜底');
  // 关键帧选择 ≤48 且保留首尾
  const boundaries = Array.from({ length: 200 }, (_, i) => (i + 1) * 500);
  const times = video.selectKeyframeTimes(boundaries, [], 100000, 48);
  assert.ok(times.length <= 48, '关键帧必须 ≤48');
  assert.equal(times[0], 500);
  // 感知哈希去重（比较哈希，不比较字节）
  const frames = [
    { timeMs: 0, width: 100, height: 100, assetId: 'a', perceptionHash: 'same' },
    { timeMs: 1000, width: 100, height: 100, assetId: 'b', perceptionHash: 'same' },
    { timeMs: 2000, width: 100, height: 100, assetId: 'c', perceptionHash: 'diff' }
  ];
  const deduped = video.dedupeKeyframesByPhash(frames);
  assert.deepEqual(deduped.map((f) => f.assetId), ['a', 'c']);
  // 摘要 ≤200 字
  assert.equal(video.boundSummary('x'.repeat(150)).truncated, false);
  assert.equal(video.boundSummary('x'.repeat(250)).truncated, true);
  assert.equal(video.boundSummary('x'.repeat(250)).summary.length, 200);
});

test('E5 Segment 对齐确定性：≤64、时间合法、无文本段 transcriptSource=none、数字段不丢（§10.7/§16-12）', () => {
  const keyframes = Array.from({ length: 100 }, (_, i) => ({ timeMs: i * 600, width: 100, height: 100, assetId: `kf${i}`, perceptionHash: `h${i}` }));
  const transcript = [
    { startMs: 100, endMs: 500, text: '含数字 123 的段不可合并', source: 'native', confidence: 0.9 },
    { startMs: 700, endMs: 1100, text: '第二段', source: 'native', confidence: 0.9 }
  ];
  const input = { durationMs: 60000, keyframes, transcript };
  const first = video.alignVideoSegments(input);
  const second = video.alignVideoSegments(input);
  assert.deepEqual(first, second, '对齐必须确定性');
  assert.ok(first.length <= 64, `Segment 必须 ≤64（实际 ${first.length}）`);
  for (const seg of first) {
    assert.ok(seg.startMs >= 0 && seg.endMs > seg.startMs && seg.endMs <= 60000);
    for (const t of seg.transcript) {
      assert.ok(t.startMs >= seg.startMs && t.endMs <= seg.endMs, 'Transcript 段必须保留原始时间戳并落在 Segment 内');
    }
  }
  // 含数字的段不得因合并丢失
  const allText = first.flatMap((s) => s.transcript.map((t) => t.text)).join(' ');
  assert.ok(allText.includes('123'), '数字段文本不得丢失');
  // 无文本段保留关键帧 + transcriptSource=none
  const noneSegment = first.find((s) => s.transcriptSource === 'none');
  if (noneSegment) assert.ok(noneSegment.keyframeAssetId, '无文本段必须保留关键帧');
});

test('E6 stage 恢复：新 attempt 复用 probe/transcript checkpoint，不重复下载/ASR（§10.3/§16-14）', async () => {
  await withMediaDb(async ({ db, server, dataRoot }) => {
    const source = seedResearchSource(db);
    const revKey = mediaCandidatesShared.sourceRevisionKey(source.id, source.revision);
    const candidates = researchWiring.validateMediaCandidates([{ kind: 'video', url: fixtureUrl(server, '/video/demo.mp4') }]);
    researchWiring.persistSourceMediaCandidates(db, {
      sourceId: source.id, sourceRevisionKey: revKey, channel: 'research', candidates, requestId: 'r-e6'
    });
    await worker.runDueMediaArchiveJobs(db, { deps: workerDeps(server), dataRoot });
    const binding = store.listSourceMediaBindings(db, revKey)[0];

    const calls = { probe: 0, subtitle: 0, keyframe: 0, asr: 0 };
    let failKeyframes = true;
    const adapter = {
      identity: 'fake-runtime-3', probe: async () => { calls.probe += 1; return {
        container: 'mp4', durationMs: 12000, width: 640, height: 360, frameRate: 30, rotation: null,
        videoCodec: 'h264', audioCodec: 'aac', hasAudio: true,
        subtitleTracks: [{ index: 0, language: 'zh', forced: false, default: true }], chapters: [], runtimeManifestHash: 'fake-runtime-3'
      }; },
      extractSubtitles: async () => { calls.subtitle += 1; return video.parseSrtToSegments(subtitleSrt(), 'native'); },
      runAsr: async () => { calls.asr += 1; return []; },
      detectScenes: async () => [3000, 8000],
      extractKeyframe: async () => {
        calls.keyframe += 1;
        if (failKeyframes) throw new Error('KEYFRAME_EXTRACTION_FAILED: disk full');
        return { bytes: jpegBytes(), width: 640, height: 360, phash: 'ph-3' };
      },
      runOcr: async () => { calls.ocr += 1; return []; }
    };
    const summaryCall = async ({ segments }) => segments.map((s) => ({ index: s.index, summary: 'x', confidence: 0.9 }));
    const { run: run1 } = video.enqueueVideoRun(db, { sourceId: source.id, sourceRevisionKey: revKey, assetId: binding.assetId });
    const failedRun = await video.executeVideoRun(db, run1.id, { dataRoot, runtime: adapter, summaryCall });
    assert.equal(failedRun.status, 'failed');
    assert.equal(failedRun.stage, 'keyframes');
    assert.ok(calls.probe >= 1 && calls.subtitle >= 1, 'attempt 1 必须执行 probe+字幕');

    // attempt 2：抽帧恢复成功 → probe/transcript 不重复
    failKeyframes = false;
    const retried = video.retryVideoRun(db, run1.id);
    const completedRun = await video.executeVideoRun(db, retried.run.id, { dataRoot, runtime: adapter, summaryCall });
    assert.equal(completedRun.status, 'completed');
    assert.equal(calls.probe, 1, 'stage 恢复不得重复 probe');
    assert.equal(calls.subtitle, 1, 'stage 恢复不得重复字幕提取/ASR');
  });
});

test('E7 completed 行不可更新：DB 触发器 + store 双保险（§10.3/§16-14）', async () => {
  await withMediaDb(async ({ db, server, dataRoot }) => {
    const source = seedResearchSource(db);
    const revKey = mediaCandidatesShared.sourceRevisionKey(source.id, source.revision);
    const candidates = researchWiring.validateMediaCandidates([{ kind: 'video', url: fixtureUrl(server, '/video/demo.mp4') }]);
    researchWiring.persistSourceMediaCandidates(db, {
      sourceId: source.id, sourceRevisionKey: revKey, channel: 'research', candidates, requestId: 'r-e7'
    });
    await worker.runDueMediaArchiveJobs(db, { deps: workerDeps(server), dataRoot });
    const binding = store.listSourceMediaBindings(db, revKey)[0];
    const adapter = {
      identity: 'fake-runtime-4', probe: async () => ({
        container: 'mp4', durationMs: 12000, width: 640, height: 360, frameRate: 30, rotation: null,
        videoCodec: 'h264', audioCodec: 'aac', hasAudio: true, subtitleTracks: [], chapters: [], runtimeManifestHash: 'fake-runtime-4'
      }),
      extractSubtitles: async () => [], runAsr: async () => [], detectScenes: async () => [],
      extractKeyframe: async () => ({ bytes: jpegBytes(), width: 640, height: 360, phash: 'ph-4' }), runOcr: async () => []
    };
    const summaryCall = async ({ segments }) => segments.map((s) => ({ index: s.index, summary: 'x', confidence: 0.9 }));
    const { run } = video.enqueueVideoRun(db, { sourceId: source.id, sourceRevisionKey: revKey, assetId: binding.assetId });
    const completed = await video.executeVideoRun(db, run.id, { dataRoot, runtime: adapter, summaryCall });
    assert.equal(completed.status, 'completed');
    // store 层拒绝
    assert.throws(() => videoStore.checkpointVideoStage(db, { runId: run.id, stage: 'align', segmentsJson: '[]' }), /VIDEO_RUN_COMPLETED_IMMUTABLE/);
    // DB 触发器拒绝直接 UPDATE
    assert.throws(() => db.prepare('UPDATE video_understanding_runs SET error_code=? WHERE id=?').run('hack', run.id), (e) =>
      String(e.message).includes('VIDEO_RUN_COMPLETED_IMMUTABLE'));
  });
});

test('E8 运行时缺失：视频 run 明确 MEDIA_RUNTIME_MISSING，图片链不受影响（§10.2/§16-13）', async () => {
  await withMediaDb(async ({ db, server, dataRoot }) => {
    const source = seedResearchSource(db);
    const revKey = mediaCandidatesShared.sourceRevisionKey(source.id, source.revision);
    const candidates = researchWiring.validateMediaCandidates([
      { kind: 'video', url: fixtureUrl(server, '/video/demo.mp4'), ordinal: 0 },
      { kind: 'image', url: fixtureUrl(server, '/img/tiny.jpg'), ordinal: 1 }
    ]);
    researchWiring.persistSourceMediaCandidates(db, {
      sourceId: source.id, sourceRevisionKey: revKey, channel: 'research', candidates, requestId: 'r-e8'
    });
    await worker.runDueMediaArchiveJobs(db, { deps: workerDeps(server), dataRoot });
    const bindings = store.listSourceMediaBindings(db, revKey);
    const videoBinding = bindings.find((b) => b.kind === 'video');
    const imageBinding = bindings.find((b) => b.kind === 'image');
    // 运行时缺失的 adapter：probe 抛 MEDIA_RUNTIME_MISSING
    const missingRuntimeError = () => Object.assign(new Error('媒体运行时不可用（.r/media-runtime 未就绪，且不回退系统 PATH）。'), { code: 'MEDIA_RUNTIME_MISSING' });
    const missing = {
      identity: 'missing', probe: async () => { throw missingRuntimeError(); },
      extractSubtitles: async () => [], runAsr: async () => [], detectScenes: async () => [],
      extractKeyframe: async () => ({}), runOcr: async () => []
    };
    const { run } = video.enqueueVideoRun(db, { sourceId: source.id, sourceRevisionKey: revKey, assetId: videoBinding.assetId });
    const failedRun = await video.executeVideoRun(db, run.id, { dataRoot, runtime: missing, summaryCall: async () => [] });
    assert.equal(failedRun.status, 'failed');
    assert.equal(failedRun.errorCode, 'MEDIA_RUNTIME_MISSING');
    // 图片链不受影响：图片理解仍可入队 + 执行
    const visualRun = visual.enqueueVisualRun(db, { sourceId: source.id, sourceRevisionId: revKey, assetId: imageBinding.assetId });
    assert.equal(visualRun.created, true, '运行时缺失时图片链必须正常');
    const completed = await visual.executeVisualRun(db, visualRun.run.id, {
      dataRoot,
      modelCall: async () => `\`\`\`json\n${JSON.stringify({ wmb_visual_observation: { reason: 'x', items: [{ kind: 'claim', canonicalKey: 'k', statement: 's', excerpt: 'e', valueRationale: 'v' }] } })}\n\`\`\``
    });
    assert.equal(completed.status, 'completed');
  });
});

// ============================================================
// F. 建议与接受/拒绝（§11/§12）
// ============================================================

function seedContentVersion(db, workspaceId, body) {
  const projectId = `proj-${randomUUID()}`;
  const versionId = `cv-${randomUUID()}`;
  const now = new Date().toISOString();
  db.prepare('INSERT INTO content_projects (id, title, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)')
    .run(projectId, 'DeepSeek-V4-Pro 基准性能的后续影响', now, now);
  db.prepare('INSERT INTO content_versions (id, project_id, body, version_number, created_at) VALUES (?, ?, ?, 1, ?)')
    .run(versionId, projectId, body, now);
  return { projectId, versionId };
}

test('F1 建议生成：Benchmark 图→成绩段、限制图→边界段、实测 Segment→体验段；无合适素材返回空（§11/§16-16）', async () => {
  await withMediaDb(async ({ db, server, dataRoot }) => {
    const source = seedResearchSource(db);
    const revKey = mediaCandidatesShared.sourceRevisionKey(source.id, source.revision);
    const candidates = researchWiring.validateMediaCandidates([
      { kind: 'image', url: fixtureUrl(server, '/img/bench.png'), captionHint: 'Benchmark 总表' },
      { kind: 'image', url: fixtureUrl(server, '/img/limits.png'), captionHint: '测试限制截图' },
      { kind: 'video', url: fixtureUrl(server, '/video/demo.mp4') }
    ]);
    researchWiring.persistSourceMediaCandidates(db, {
      sourceId: source.id, sourceRevisionKey: revKey, channel: 'research', candidates, requestId: 'r-f1'
    });
    await worker.runDueMediaArchiveJobs(db, { deps: workerDeps(server), dataRoot });
    const bindings = store.listSourceMediaBindings(db, revKey);
    const benchBinding = bindings.find((b) => b.originalUrl.endsWith('bench.png'));
    const limitsBinding = bindings.find((b) => b.originalUrl.endsWith('limits.png'));
    const videoBinding = bindings.find((b) => b.kind === 'video');

    // 图片理解：Benchmark 总表 + 测试限制（匹配不同观点）
    const benchRun = visual.enqueueVisualRun(db, { sourceId: source.id, sourceRevisionId: revKey, assetId: benchBinding.assetId });
    await visual.executeVisualRun(db, benchRun.run.id, {
      dataRoot,
      modelCall: async () => `\`\`\`json\n${JSON.stringify({ wmb_visual_observation: { reason: 'r', items: [
        { kind: 'claim', canonicalKey: 'benchmark-score', statement: 'DeepSeek-V4-Pro 基准测试成绩领先，MMLU-Pro 与 GPQA 上超过上一代。', excerpt: '成绩领先', valueRationale: '总表可核对。' }
      ] } })}\n\`\`\``
    });
    const limitsRun = visual.enqueueVisualRun(db, { sourceId: source.id, sourceRevisionId: revKey, assetId: limitsBinding.assetId });
    await visual.executeVisualRun(db, limitsRun.run.id, {
      dataRoot,
      modelCall: async () => `\`\`\`json\n${JSON.stringify({ wmb_visual_observation: { reason: 'r', items: [
        { kind: 'claim', canonicalKey: 'limits', statement: '测试限制条件见截图，复现边界需注意环境。', excerpt: '测试限制', valueRationale: '截图可核对。' }
      ] } })}\n\`\`\``
    });
    // 视频理解：03:18-03:46 实测体验段（摘要含体验）
    const adapter = {
      identity: 'fake-f1', probe: async () => ({
        container: 'mp4', durationMs: 12000, width: 640, height: 360, frameRate: 30, rotation: null,
        videoCodec: 'h264', audioCodec: 'aac', hasAudio: true,
        subtitleTracks: [{ index: 0, language: 'zh', forced: false, default: true }], chapters: [], runtimeManifestHash: 'fake-f1'
      }),
      extractSubtitles: async () => video.parseSrtToSegments(subtitleSrt(), 'native'),
      runAsr: async () => [], detectScenes: async () => [],
      extractKeyframe: async () => ({ bytes: jpegBytes(), width: 640, height: 360, phash: 'ph-f1' }), runOcr: async () => []
    };
    const { run: vRun } = video.enqueueVideoRun(db, { sourceId: source.id, sourceRevisionKey: revKey, assetId: videoBinding.assetId });
    await video.executeVideoRun(db, vRun.id, {
      dataRoot, runtime: adapter, sourceLanguage: 'zh',
      summaryCall: async ({ segments }) => segments.map((s) => ({ index: s.index, summary: '实测视频体验：真实推理与响应速度', confidence: 0.9 }))
    });

    // 内容版本：三个观点 + 一个无证据观点
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
    const { projectId, versionId } = seedContentVersion(db, 'ignored', body);
    const drafts = recommendations.generateMediaRecommendations(db, {
      contentVersionId: versionId, projectId, sourceRevisionKeys: [revKey]
    });
    const byClaim = new Map();
    for (const draft of drafts) {
      const list = byClaim.get(draft.claimKey) ?? [];
      list.push(draft);
      byClaim.set(draft.claimKey, list);
    }
    const scoreSuggestions = byClaim.get('c1') ?? [];
    assert.ok(scoreSuggestions.length >= 1, '成绩段必须有建议');
    assert.equal(scoreSuggestions[0].purpose, 'direct_evidence');
    assert.ok(scoreSuggestions.some((d) => d.assetId === benchBinding.assetId), 'Benchmark 图必须匹配成绩段');
    const boundarySuggestions = byClaim.get('c2') ?? [];
    assert.ok(boundarySuggestions.some((d) => d.assetId === limitsBinding.assetId), '限制图必须匹配边界段');
    const experienceSuggestions = byClaim.get('c3') ?? [];
    const clipDraft = experienceSuggestions.find((d) => d.transform.kind === 'clip');
    assert.ok(clipDraft, '体验段必须建议 Clip（含 timeRange）');
    assert.ok(clipDraft.transform.startMs >= 0 && clipDraft.transform.endMs > clipDraft.transform.startMs);
    assert.ok(experienceSuggestions.some((d) => d.assetId === videoBinding.assetId), '实测 Segment 必须匹配体验段');
    // 无合适素材 → 该观点零建议
    assert.equal(byClaim.get('c4')?.length ?? 0, 0, '竞争格局无直接证据不得伪造建议');
  });
});

test('F2 restricted 不进入自动建议；接受/拒绝状态机（§11.8/§13/§16-16/17）', async () => {
  await withMediaDb(async ({ db, server, dataRoot }) => {
    const source = seedResearchSource(db);
    const revKey = mediaCandidatesShared.sourceRevisionKey(source.id, source.revision);
    const candidates = researchWiring.validateMediaCandidates([{ kind: 'image', url: fixtureUrl(server, '/img/tiny.jpg') }]);
    researchWiring.persistSourceMediaCandidates(db, {
      sourceId: source.id, sourceRevisionKey: revKey, channel: 'research', candidates, requestId: 'r-f2'
    });
    await worker.runDueMediaArchiveJobs(db, { deps: workerDeps(server), dataRoot });
    const binding = store.listSourceMediaBindings(db, revKey)[0];
    const run = visual.enqueueVisualRun(db, { sourceId: source.id, sourceRevisionId: revKey, assetId: binding.assetId });
    await visual.executeVisualRun(db, run.run.id, {
      dataRoot, modelCall: async () => `\`\`\`json\n${JSON.stringify({ wmb_visual_observation: { reason: 'r', items: [
        { kind: 'claim', canonicalKey: 'score', statement: 'DeepSeek-V4-Pro 基准测试成绩领先。', excerpt: '成绩领先', valueRationale: 'x' }
      ] } })}\n\`\`\``
    });
    const body = '# x\n## 成绩\nDeepSeek-V4-Pro 基准测试成绩领先。\n## 成绩复述\nDeepSeek-V4-Pro 基准测试成绩领先。\n';
    const { projectId, versionId } = seedContentVersion(db, 'ignored', body);

    // restricted 绑定不进入自动建议
    store.setBindingRightsStatus(db, binding.id, 'restricted');
    const restrictedDrafts = recommendations.generateMediaRecommendations(db, { contentVersionId: versionId, projectId, sourceRevisionKeys: [revKey] });
    assert.equal(restrictedDrafts.length, 0, 'restricted 不得自动建议');
    // 还原为 unknown（用户显式确认；与 §13 AI 不能自行改授权一致）
    store.setBindingRightsStatus(db, binding.id, 'unknown', { requireUserConfirmation: true });

    // 生成 + 提案 + 决定
    const drafts = recommendations.generateMediaRecommendations(db, { contentVersionId: versionId, projectId, sourceRevisionKeys: [revKey] });
    assert.ok(drafts.length >= 1);
    const proposed = recommendations.proposeMediaRecommendations(db, { contentVersionId: versionId, projectId, requestId: 'f2-propose', drafts });
    assert.ok(proposed.length >= 1);
    const first = recommendations.getMediaRecommendation(db, proposed[0].id);
    assert.equal(first.state, 'proposed');
    // 拒绝 → 零版本写（§16-17）
    const decidedReject = recommendations.decideMediaRecommendation(db, { id: first.id, expectedRevision: first.revision, decision: 'reject', decidedBy: 'acceptance' });
    assert.equal(decidedReject.state, 'rejected');
    assert.equal(count(db, 'content_media_bindings'), 0, '拒绝必须零 Content Binding 写');
    assert.equal(count(db, 'platform_media_bindings'), 0, '拒绝必须零 Platform Binding 写');
    assert.equal(count(db, 'platform_versions'), 0, '拒绝必须零平台版本写');
    // 接受 → 状态 accepted（Binding 写入由 Studio 保存路径单独执行，这里只验证状态机）
    const second = recommendations.getMediaRecommendation(db, proposed[1].id);
    const decidedAccept = recommendations.decideMediaRecommendation(db, { id: second.id, expectedRevision: second.revision, decision: 'accept', decidedBy: 'acceptance' });
    assert.equal(decidedAccept.state, 'accepted');
    // §11.9：用户决定是终态。新提案（新 requestId）不得覆盖 accepted/rejected 行。
    const reProposed = recommendations.proposeMediaRecommendations(db, { contentVersionId: versionId, projectId, requestId: 'f2-propose-2', drafts });
    assert.equal(recommendations.getMediaRecommendation(db, first.id).state, 'rejected', '用户决定 rejected 是终态，不得被新提案覆盖');
    assert.equal(recommendations.getMediaRecommendation(db, second.id).state, 'accepted', '用户决定 accepted 是终态，不得被新提案覆盖');
    // 显式 supersede 只作用于仍 proposed 的行（本次没有残留 → 0）
    const supersededCount = recommendations.supersedeProposedRecommendations(db, { contentVersionId: versionId, requestId: 'f2-propose-3' });
    assert.equal(supersededCount, 0, '无残留 proposed 行时 supersede 应为 0');
    assert.equal(recommendations.getMediaRecommendation(db, first.id).state, 'rejected');
    assert.equal(recommendations.getMediaRecommendation(db, second.id).state, 'accepted');
  });
});

// ============================================================
// G. 派生（§10.9）
// ============================================================

test('G1 Clip 范围校验：≤60s、时间合法、边界越界拒绝（§10.9/§16-18）', () => {
  assert.equal(derivations.validateClipRange(0, 60001, 120000), 'clip 时长不能超过 60 秒。');
  assert.equal(derivations.validateClipRange(-1, 1000, 120000), 'clip 起始时间不能为负。');
  assert.equal(derivations.validateClipRange(5000, 5000, 120000), 'clip 结束时间必须大于起始时间。');
  // 结束越界（clip 时长本身 ≤60s，避免触发 60s 上限先于边界检查的优先级）
  assert.equal(derivations.validateClipRange(0, 50000, 40000), 'clip 结束时间超出原视频时长。');
  assert.equal(derivations.validateClipRange(1000, 4000, 120000), null);
  assert.equal(derivations.validateClipRange(0, 60000, 120000), null, '恰好 60s 合法');
});

test('G2 裁切/标注派生：原件不变 + derived_annotation 血缘可逆（§12/§16-18）', async () => {
  await withMediaDb(async ({ db, server, dataRoot }) => {
    const source = seedResearchSource(db);
    const revKey = mediaCandidatesShared.sourceRevisionKey(source.id, source.revision);
    const candidates = researchWiring.validateMediaCandidates([{ kind: 'image', url: fixtureUrl(server, '/img/bench.png') }]);
    researchWiring.persistSourceMediaCandidates(db, {
      sourceId: source.id, sourceRevisionKey: revKey, channel: 'research', candidates, requestId: 'r-g2'
    });
    await worker.runDueMediaArchiveJobs(db, { deps: workerDeps(server), dataRoot });
    const binding = store.listSourceMediaBindings(db, revKey)[0];
    const original = row(db, 'SELECT relative_path AS p, byte_count AS b FROM assets WHERE id=?', binding.assetId);
    const originalBytes = await readFile(path.join(dataRoot, original.p));
    const annotated = await derivations.materializeAnnotationAsset(db, dataRoot, {
      sourceAssetId: binding.assetId,
      annotationSpec: { annotationType: 'rect', elements: [{ x: 10, y: 10, width: 100, height: 100 }], width: 640, height: 400 },
      bytes: pngBytes(320, 200, [255, 0, 0]),
      fileName: 'annotation.png', mimeType: 'image/png', origin: 'acceptance-test'
    });
    assert.ok(annotated.assetId);
    const prov = row(db, 'SELECT kind, transform_json AS t FROM asset_provenance WHERE derived_asset_id=?', annotated.assetId);
    assert.equal(prov?.kind, 'derived_annotation');
    assert.equal(JSON.parse(prov.t).annotationType, 'rect');
    // 原件不变
    const after = await readFile(path.join(dataRoot, original.p));
    assert.deepEqual(after, originalBytes, '原件字节必须不变');
    assert.equal(store.getMediaCandidate(db, binding.candidateId).status, 'preserved');
    // 同字节派生重放 → 复用（sha256 幂等）
    const replay = await derivations.materializeAnnotationAsset(db, dataRoot, {
      sourceAssetId: binding.assetId,
      annotationSpec: { annotationType: 'rect', elements: [{ x: 10, y: 10, width: 100, height: 100 }], width: 640, height: 400 },
      bytes: pngBytes(320, 200, [255, 0, 0]),
      fileName: 'annotation.png', mimeType: 'image/png', origin: 'acceptance-test'
    });
    assert.equal(replay.reused, true);
  });
});

test('G3 Clip 物化：copy 优先/转码回退、血缘完整、原视频不变（§10.9/§16-18）', async () => {
  await withMediaDb(async ({ db, server, dataRoot }) => {
    const source = seedResearchSource(db);
    const revKey = mediaCandidatesShared.sourceRevisionKey(source.id, source.revision);
    const candidates = researchWiring.validateMediaCandidates([{ kind: 'video', url: fixtureUrl(server, '/video/demo.mp4') }]);
    researchWiring.persistSourceMediaCandidates(db, {
      sourceId: source.id, sourceRevisionKey: revKey, channel: 'research', candidates, requestId: 'r-g3'
    });
    await worker.runDueMediaArchiveJobs(db, { deps: workerDeps(server), dataRoot });
    const binding = store.listSourceMediaBindings(db, revKey)[0];
    const original = row(db, 'SELECT relative_path AS p, byte_count AS b FROM assets WHERE id=?', binding.assetId);
    const originalBytes = await readFile(path.join(dataRoot, original.p));

    // fake executor：copy 命令成功（写输出文件）+ ffprobe 返回合法时长
    const fakeExecutor = {
      async ffmpeg(args) {
        const outputPath = args[args.length - 1];
        await writeFile(outputPath, mp4Bytes({ durationMs: 5000, variant: 7 }));
        return { code: 0, stdout: '', stderr: '' };
      },
      async ffprobe(args) {
        const inputPath = args[args.length - 1];
        void inputPath;
        return { code: 0, stdout: JSON.stringify({
          format: { duration: '5.0', start_time: '0.0' },
          streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', start_time: '0.0' }]
        }), stderr: '' };
      }
    };
    const fakeRuntime = { rootDir: dataRoot, ffmpegPath: 'fake', ffprobePath: 'fake', manifest: null, identity: 'fake-clip-runtime' };
    const clip = await derivations.materializeClipAsset(db, dataRoot, {
      sourceAssetId: binding.assetId, startMs: 0, endMs: 5000, origin: 'acceptance-test'
    }, { executor: fakeExecutor, runtime: fakeRuntime });
    assert.equal(clip.copyOrTranscode, 'copy');
    assert.equal(clip.durationMs, 5000);
    const clipProv = row(db, "SELECT kind, transform_json AS t FROM asset_provenance WHERE derived_asset_id=? AND kind='derived_clip'", clip.assetId);
    assert.equal(clipProv?.kind, 'derived_clip');
    assert.deepEqual(JSON.parse(clipProv.t), { startMs: 0, endMs: 5000, codec: 'copy', copyOrTranscode: 'copy' });
    const after = await readFile(path.join(dataRoot, original.p));
    assert.deepEqual(after, originalBytes, '原视频必须不变');
  });
});

// ============================================================
// H. GC 与权利（§13/§14）
// ============================================================

test('H1 权利门：restricted 禁止自动建议 + 显式确认证据（§13/§16-16）', async () => {
  await withMediaDb(async ({ db, server, dataRoot }) => {
    const source = seedResearchSource(db);
    const revKey = mediaCandidatesShared.sourceRevisionKey(source.id, source.revision);
    const candidates = researchWiring.validateMediaCandidates([
      { kind: 'image', url: fixtureUrl(server, '/img/tiny.jpg'), ordinal: 0, surroundingText: '转发第三方' },
      { kind: 'image', url: fixtureUrl(server, '/img/bench.png'), ordinal: 1 }
    ]);
    researchWiring.persistSourceMediaCandidates(db, {
      sourceId: source.id, sourceRevisionKey: revKey, channel: 'research', candidates, requestId: 'r-h1'
    });
    await worker.runDueMediaArchiveJobs(db, { deps: workerDeps(server), dataRoot });
    const bindings = store.listSourceMediaBindings(db, revKey);
    const first = bindings[0];
    // AI 不能把 restricted 改成已授权
    store.setBindingRightsStatus(db, first.id, 'restricted');
    assert.throws(() => store.setBindingRightsStatus(db, first.id, 'likely_reusable'), /RESTRICTED_BINDING_NEEDS_USER_CONFIRMATION/);
    assert.equal(rights.canAutoSuggestMedia('restricted'), false);
    assert.equal(rights.canAutoSuggestMedia('unknown'), true);
    const gate = rights.canAcceptMediaBinding(db, first.id, { confirmedByOwner: false });
    assert.equal(gate.allowed, false);
    assert.equal(gate.code, 'RIGHTS_RESTRICTED');
    // 显式确认 → 允许
    assert.throws(() => rights.requireRestrictedOverride(db, first.id), (e) => e.code === 'RIGHTS_RESTRICTED_OVERRIDE_REQUIRED');
    const override = rights.recordRestrictedOverride(db, { bindingId: first.id, reason: '用户明确要求采用该素材', confirmedBy: 'acceptance', requestId: 'h1-override' });
    assert.equal(override.bindingId, first.id);
    rights.requireRestrictedOverride(db, first.id);
    assert.equal(rights.canAcceptMediaBinding(db, first.id, { confirmedByOwner: true }).allowed, true);
  });
});

test('H2 GC：完整引用集保护；无引用派生超 30 天可回收；原始 Source 媒体永不自动清理（§14/§16-20）', async () => {
  await withMediaDb(async ({ db, server, dataRoot }) => {
    const source = seedResearchSource(db);
    const revKey = mediaCandidatesShared.sourceRevisionKey(source.id, source.revision);
    const candidates = researchWiring.validateMediaCandidates([
      { kind: 'image', url: fixtureUrl(server, '/img/bench.png'), ordinal: 0 },
      { kind: 'image', url: fixtureUrl(server, '/img/limits.png'), ordinal: 1 }
    ]);
    researchWiring.persistSourceMediaCandidates(db, {
      sourceId: source.id, sourceRevisionKey: revKey, channel: 'research', candidates, requestId: 'r-h2'
    });
    await worker.runDueMediaArchiveJobs(db, { deps: workerDeps(server), dataRoot });
    const bindings = store.listSourceMediaBindings(db, revKey);
    const originalAsset = bindings[0].assetId;

    // 原始 Source 媒体在受保护集（binding 引用）
    const protectedIds = governance.collectProtectedAssetIds(db);
    assert.ok(protectedIds.has(originalAsset), '原始 Source 媒体必须受保护');

    // 派生标注：无引用 + 40 天前 → 候选
    const annotated = await derivations.materializeAnnotationAsset(db, dataRoot, {
      sourceAssetId: originalAsset,
      annotationSpec: { annotationType: 'rect', elements: [], width: 64, height: 64 },
      bytes: pngBytes(64, 64, [1, 2, 3]), fileName: 'stale.png', mimeType: 'image/png', origin: 'gc-test'
    });
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE assets SET created_at=? WHERE id=?').run(old, annotated.assetId);
    const plan = governance.planDerivedCacheGc(db, dataRoot, { retentionDays: 30 });
    assert.ok(plan.candidates.some((c) => c.assetId === annotated.assetId), '无引用派生超 30 天必须可回收');
    assert.ok(!plan.candidates.some((c) => c.assetId === originalAsset), '原始 Source 媒体永不自动清理');
    // 被引用派生受保护：标注派生被证据 locator 引用后不回收
    const executed = governance.executeDerivedCacheGc(db, plan, 'gc-h2');
    assert.ok(executed.deleted.some((d) => d.assetId === annotated.assetId));
    const gone = row(db, 'SELECT id FROM assets WHERE id=?', annotated.assetId);
    assert.equal(gone, undefined, '回收后 Asset 行必须删除');
    // 原件仍在
    assert.ok(row(db, 'SELECT id FROM assets WHERE id=?', originalAsset));
  });
});

test('H3 删除门：有引用 Source 删除被阻止（§13/§16-20）', async () => {
  await withMediaDb(async ({ db, server, dataRoot }) => {
    const source = seedResearchSource(db);
    const revKey = mediaCandidatesShared.sourceRevisionKey(source.id, source.revision);
    const candidates = researchWiring.validateMediaCandidates([{ kind: 'image', url: fixtureUrl(server, '/img/tiny.jpg') }]);
    researchWiring.persistSourceMediaCandidates(db, {
      sourceId: source.id, sourceRevisionKey: revKey, channel: 'research', candidates, requestId: 'r-h3'
    });
    await worker.runDueMediaArchiveJobs(db, { deps: workerDeps(server), dataRoot });
    // 真实外部引用：preserved 图片入队视觉理解（knowledge_visual_runs）→ 删除门必须阻止。
    const binding = store.listSourceMediaBindings(db, revKey)[0];
    const enqueued = visual.enqueueVisualRun(db, { sourceId: source.id, sourceRevisionId: revKey, assetId: binding.assetId });
    assert.equal(enqueued.created, true);
    const gate = governance.sourceDeleteGate(db, source.id);
    assert.equal(gate.allowed, false);
    assert.match(gate.blockedReason, /SOURCE_DELETE_BLOCKED_REFERENCED_ASSETS/);
    const forced = governance.sourceDeleteGate(db, source.id, { forceReferencedDelete: true });
    assert.equal(forced.allowed, true, '显式确认后可删除（关系删除不删字节）');
  });
});

// ============================================================
// I. 工作空间隔离 + 重启 + 零自动发布
// ============================================================

test('I1 工作空间隔离：跨 workspace dispatcher 拒绝 + data-root 隔离（§16-21）', async () => {
  await withMediaRuntime(async ({ root, runtime, server, dataRoot, workspaceId }) => {
    // 媒体管线经独立 raw 连接执行（运行时 write-guard 只在 dispatch 内放行写；
    // 这里用与 WMB-5241 Window A 相同的“应用关闭 + 生产模块直连”形态）。
    const raw = migrateDatabase(path.join(root, 'wmb.db'));
    try {
      const source = seedResearchSource(raw);
      const revKey = mediaCandidatesShared.sourceRevisionKey(source.id, source.revision);
      const candidates = researchWiring.validateMediaCandidates([{ kind: 'image', url: fixtureUrl(server, '/img/tiny.jpg') }]);
      researchWiring.persistSourceMediaCandidates(raw, {
        sourceId: source.id, sourceRevisionKey: revKey, channel: 'research', candidates, requestId: 'r-i1'
      });
      await worker.runDueMediaArchiveJobs(raw, { deps: workerDeps(server), dataRoot });
      assert.equal(worker.getSourceMediaSummary(raw, source.id, revKey).preserved, 1);
    } finally {
      raw.close();
    }
    // 跨 workspace envelope → WORKSPACE_STALE
    const foreign = createCommandEnvelope({
      workspaceId: 'foreign-workspace', runtimeEpoch: runtime.identity.runtimeEpoch,
      command: 'media_acceptance.test', requestId: 'i1-foreign', input: { x: 1 },
      boundIdentity: { entityType: 'media_acceptance' }, actor: owner
    });
    await assert.rejects(() => runtime.dispatchCommand(foreign, () => ({ data: {}, entityType: 'media_acceptance' })), { code: 'WORKSPACE_STALE' });
    // 第二个独立 data-root 看不到第一个工作空间的媒体
    const root2 = await mkdtemp(path.join(os.tmpdir(), 'wmb-media-iso-'));
    try {
      const db2 = migrateDatabase(path.join(root2, 'wmb.db'));
      const ws2 = `workspace-${randomUUID()}`;
      const now = new Date().toISOString();
      db2.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)").run(ws2, now, now);
      ensureOfficialWorkspaceProfile(db2, 'official.ai');
      assert.equal(count(db2, 'source_media_candidates'), 0, '工作空间 B 不得看到 A 的候选');
      assert.equal(count(db2, 'assets'), 0, '工作空间 B 不得看到 A 的 Asset');
      db2.close();
    } finally {
      await rm(root2, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

test('I2 重启：同一 data-root 重新打开后媒体/血缘/运行完整可用（§15/§16-21）', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-media-restart-'));
  let server = null;
  try {
    server = await startStandardFixtureServer();
    // 第一次打开：冻结 + 归档 + 视频理解
    {
      const db = migrateDatabase(path.join(root, 'wmb.db'));
      const workspaceId = `workspace-${randomUUID()}`;
      const now = new Date().toISOString();
      db.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)").run(workspaceId, now, now);
      ensureOfficialWorkspaceProfile(db, 'official.ai');
      const source = seedResearchSource(db);
      const revKey = mediaCandidatesShared.sourceRevisionKey(source.id, source.revision);
      const candidates = researchWiring.validateMediaCandidates([
        { kind: 'image', url: fixtureUrl(server, '/img/bench.png'), ordinal: 0 },
        { kind: 'video', url: fixtureUrl(server, '/video/demo.mp4'), ordinal: 1 }
      ]);
      researchWiring.persistSourceMediaCandidates(db, {
        sourceId: source.id, sourceRevisionKey: revKey, channel: 'research', candidates, requestId: 'r-i2'
      });
      await worker.runDueMediaArchiveJobs(db, { deps: workerDeps(server), dataRoot: root });
      db.close();
    }
    // 断网（服务器关闭）后重启：数据完整
    await server.close();
    server = null;
    {
      const db = migrateDatabase(path.join(root, 'wmb.db'));
      const sources = rows(db, 'SELECT id, revision FROM source_items');
      assert.equal(sources.length, 1);
      const revKey = mediaCandidatesShared.sourceRevisionKey(sources[0].id, sources[0].revision);
      const summary = worker.getSourceMediaSummary(db, sources[0].id, revKey);
      assert.equal(summary.total, 2);
      assert.equal(summary.preserved, 2, '重启后 preserved 计数必须完整');
      const bindings = store.listSourceMediaBindings(db, revKey);
      for (const binding of bindings) {
        const asset = row(db, 'SELECT relative_path AS p FROM assets WHERE id=?', binding.assetId);
        const local = await readFile(path.join(root, asset.p));
        assert.ok(local.length > 0, '断网后本地 Asset 仍可逐字节读取');
      }
      assert.equal(count(db, 'source_media_bindings'), 2);
      assert.equal(count(db, 'source_media_candidates'), 2);
      db.close();
    }
  } finally {
    if (server) await server.close().catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('I3 零自动发布：全链后 publications/platform_versions 零写，最终发布边界不变（§3/§16-19）', async () => {
  await withMediaDb(async ({ db, server, dataRoot }) => {
    const source = seedResearchSource(db);
    const revKey = mediaCandidatesShared.sourceRevisionKey(source.id, source.revision);
    const candidates = researchWiring.validateMediaCandidates([
      { kind: 'image', url: fixtureUrl(server, '/img/bench.png'), ordinal: 0 },
      { kind: 'video', url: fixtureUrl(server, '/video/demo.mp4'), ordinal: 1 }
    ]);
    researchWiring.persistSourceMediaCandidates(db, {
      sourceId: source.id, sourceRevisionKey: revKey, channel: 'research', candidates, requestId: 'r-i3'
    });
    await worker.runDueMediaArchiveJobs(db, { deps: workerDeps(server), dataRoot });
    const bindings = store.listSourceMediaBindings(db, revKey);
    const imageBinding = bindings.find((b) => b.kind === 'image');
    const videoBinding = bindings.find((b) => b.kind === 'video');
    const visRun = visual.enqueueVisualRun(db, { sourceId: source.id, sourceRevisionId: revKey, assetId: imageBinding.assetId });
    await visual.executeVisualRun(db, visRun.run.id, {
      dataRoot, modelCall: async () => `\`\`\`json\n${JSON.stringify({ wmb_visual_observation: { reason: 'r', items: [
        { kind: 'claim', canonicalKey: 'score', statement: 'DeepSeek-V4-Pro 基准测试成绩领先。', excerpt: '成绩领先', valueRationale: 'x' }
      ] } })}\n\`\`\``
    });
    const { run: vRun } = video.enqueueVideoRun(db, { sourceId: source.id, sourceRevisionKey: revKey, assetId: videoBinding.assetId });
    await video.executeVideoRun(db, vRun.id, {
      dataRoot,
      runtime: {
        identity: 'fake-i3', probe: async () => ({
          container: 'mp4', durationMs: 12000, width: 640, height: 360, frameRate: 30, rotation: null,
          videoCodec: 'h264', audioCodec: 'aac', hasAudio: true,
          subtitleTracks: [{ index: 0, language: 'zh', forced: false, default: true }], chapters: [], runtimeManifestHash: 'fake-i3'
        }),
        extractSubtitles: async () => video.parseSrtToSegments(subtitleSrt(), 'native'),
        runAsr: async () => [], detectScenes: async () => [],
        extractKeyframe: async () => ({ bytes: jpegBytes(), width: 640, height: 360, phash: 'ph-i3' }), runOcr: async () => []
      },
      summaryCall: async ({ segments }) => segments.map((s) => ({ index: s.index, summary: '体验', confidence: 0.9 }))
    });
    // 全链完成：仍零自动发布
    for (const table of ['publications', 'publication_snapshots', 'publication_metric_snapshots', 'platform_versions']) {
      assert.equal(count(db, table), 0, `${table} 必须零行（无自动发布）`);
    }
    assert.equal(count(db, 'content_versions'), 0, '全链不得自动创建内容版本');
  });
});
