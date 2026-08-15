// WMB-5244 §7.4：Research/记者保存路径的媒体候选接线验收（研究专用）。
// 覆盖：可选结构化 mediaCandidates 的服务端校验（http(s) 身份、拒绝 file:/wmb-asset:/本地路径、
// 有界形状）；Source/Candidate/初始Attempt/media_archive Job 同事务原子落库；无候选时按原 URL
// 调度有界重发现（media_discover，每 revision 幂等）；无效候选 fail before writes（零写）；
// 重放幂等与异输入冲突；研究写回保持无 feedId 身份 + 读白名单不变。
// 不触碰 XHS/worker/通用 schema/renderer；权限文件零改动（sources.upsert_batch 既有 grant 不变）。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { register } from 'node:module';

// 同 command-dispatcher.test.mjs：bare Node 需要 .ts 解析 + electron 惰性桩。
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
  'export default { app, safeStorage };',
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
  '}',
].join('\n');
register('data:text/javascript,' + encodeURIComponent(HOOK_SOURCE), import.meta.url);

const { buildSaveSourcePayload, coreTools } = await import('../.pi/extensions/wmb-mcp/wmb-mcp-tools-core.ts');
const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { startMcp } = await import('../src/main/mcp.ts');
const { dispatchSourceUpsertBatch } = await import('../src/main/source-commands.ts');
const {
  deriveCandidateChannel,
  scheduleSourceMediaDiscovery,
  validateMediaCandidates,
  MediaCandidatesInvalidError,
  MEDIA_ARCHIVE_JOB_KIND,
  MEDIA_DISCOVER_JOB_KIND
} = await import('../src/main/source-media-candidates.ts');
const { createSourceFeed } = await import('../src/main/sources.ts');
const { ActiveWorkspaceRuntime } = await import('../src/main/workspace-runtime.ts');
const { ensureOfficialWorkspaceProfile } = await import('../src/main/workspace-profiles.ts');
const { dispatchStartAgentTask } = await import('../src/main/agent-task-commands.ts');
const { dispatchIssueTaskGrant } = await import('../src/main/task-grants.ts');
const { sourceRevisionKey } = await import('../src/shared/media-candidates.ts');

const owner = { type: 'owner_ui', id: 'renderer', label: 'Owner UI' };

function count(database, sql, ...params) {
  return Number(database.prepare(sql).get(...params).count);
}

function candidatesFor(database, sourceId) {
  return database.prepare(`
    SELECT id, source_id AS sourceId, source_revision_key AS sourceRevisionKey, kind,
      original_url AS originalUrl, stable_remote_identity AS stableIdentity, channel,
      post_kind AS postKind, parent_candidate_id AS parentCandidateId, post_ordinal AS postOrdinal,
      ordinal_in_post AS ordinalInPost, ordinal, caption_hint AS captionHint, status,
      attempt_count AS attemptCount, max_attempts AS maxAttempts, request_id AS requestId
    FROM source_media_candidates WHERE source_id = ? ORDER BY ordinal, id
  `).all(sourceId);
}

function archiveJobsFor(database, sourceId) {
  return database.prepare(`
    SELECT j.kind, j.dedupe_key AS dedupeKey, j.payload_json AS payloadJson, j.status
    FROM jobs j WHERE j.dedupe_key LIKE ?
  `).all(`media:source:${sourceId}:r%`);
}

function attemptsFor(database, sourceId) {
  return database.prepare(`
    SELECT a.candidate_id AS candidateId, a.attempt, a.status, a.started_at AS startedAt
    FROM media_archive_attempts a JOIN source_media_candidates c ON c.id = a.candidate_id
    WHERE c.source_id = ? ORDER BY a.candidate_id, a.attempt
  `).all(sourceId);
}

async function withRuntime(work) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5244-research-'));
  let runtime;
  try {
    const database = migrateDatabase(path.join(root, 'wmb.db'));
    const now = new Date().toISOString();
    database.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)").run(`workspace-${randomUUID()}`, now, now);
    ensureOfficialWorkspaceProfile(database, 'official.ai');
    database.close();
    runtime = ActiveWorkspaceRuntime.open(root, { openDatabase: migrateDatabase, createEpoch: () => 'runtime-5244' });
    await work({ root, runtime, database: runtime.database });
  } finally {
    await runtime?.stop({ drain: false });
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function request(url, method, params, sessionId) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params })
  });
  const body = await response.text();
  assert.equal(response.ok, true, body);
  const payload = response.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(body.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6))
    : JSON.parse(body);
  if (payload.error) throw new Error(payload.error.message);
  return { result: payload.result, sessionId: response.headers.get('mcp-session-id') || sessionId };
}

const RESEARCH_SAVE_BASE = {
  requestId: 'r1', taskId: 'task-1', grantId: 'grant-1', workerLeaseId: 'lease-1',
  title: 'T', originalUrl: 'https://a.example.com/p', summary: 'S', author: 'A',
  clientLabel: 'WMB research'
};

// ---------------------------------------------------------------------------
// A. wmb_save_source 载荷构造（纯函数）
// ---------------------------------------------------------------------------

test('WMB-5244: buildSaveSourcePayload passes mediaCandidates through and keeps research rules', () => {
  const withMedia = buildSaveSourcePayload({
    ...RESEARCH_SAVE_BASE,
    mediaCandidates: [
      { kind: 'image', url: 'https://cdn.example.com/a.png', captionHint: '图注' },
      { kind: 'video', url: 'https://cdn.example.com/a.mp4' },
      { kind: 'video_poster', url: 'https://cdn.example.com/a-poster.jpg', parentUrl: 'https://cdn.example.com/a.mp4' }
    ]
  });
  assert.deepEqual(withMedia.items[0].mediaCandidates, [
    { kind: 'image', url: 'https://cdn.example.com/a.png', captionHint: '图注' },
    { kind: 'video', url: 'https://cdn.example.com/a.mp4' },
    { kind: 'video_poster', url: 'https://cdn.example.com/a-poster.jpg', parentUrl: 'https://cdn.example.com/a.mp4' }
  ]);
  assert.deepEqual(withMedia.items[0].categories, ['研究补料']);
  assert.equal(withMedia.items[0].feedId, undefined, '研究写回不得携带 feedId');
  assert.equal(withMedia.items[0].clientLabel, 'WMB research');

  const plain = buildSaveSourcePayload({ requestId: 'r2', taskId: 't2', grantId: 'g2', title: 'T', originalUrl: 'https://a.example.com/p', summary: 'S' });
  assert.equal(plain.items[0].mediaCandidates, undefined, '无候选时不得注入空键');

  const emptyList = buildSaveSourcePayload({ ...RESEARCH_SAVE_BASE, mediaCandidates: [] });
  assert.equal(emptyList.items[0].mediaCandidates, undefined, '空数组按无候选处理');

  // 研究字段强制规则不因新增候选而放宽。
  assert.throws(() => buildSaveSourcePayload({ ...RESEARCH_SAVE_BASE, author: undefined }), /RESEARCH_EVIDENCE_FIELDS_REQUIRED/);
  assert.throws(() => buildSaveSourcePayload({ ...RESEARCH_SAVE_BASE, workerLeaseId: undefined }), /RESEARCH_ENVELOPE_REQUIRED/);

  const saveSource = coreTools.find((tool) => tool.name === 'wmb_save_source');
  assert.ok(saveSource, 'wmb_save_source registered');
  assert.ok(saveSource.parameters.properties.mediaCandidates, 'wmb_save_source 必须声明可选 mediaCandidates');
});

// ---------------------------------------------------------------------------
// B. 服务端校验（fail before writes；纯函数）
// ---------------------------------------------------------------------------

test('WMB-5244: validateMediaCandidates rejects non-http(s)/local/internal identities', () => {
  const rejects = (candidates, pattern) => {
    assert.throws(() => validateMediaCandidates(candidates), (error) => error instanceof MediaCandidatesInvalidError && pattern.test(error.message));
  };
  rejects([{ kind: 'image', url: 'file:///C:/x.png' }], /只允许 http\(s\)/);
  rejects([{ kind: 'image', url: 'wmb-asset://img/abc' }], /只允许 http\(s\)/);
  rejects([{ kind: 'image', url: 'data:image/png;base64,AA==' }], /只允许 http\(s\)/);
  rejects([{ kind: 'image', url: 'blob:https://example.com/uuid' }], /只允许 http\(s\)/);
  rejects([{ kind: 'image', url: 'ftp://example.com/x.png' }], /只允许 http\(s\)/);
  rejects([{ kind: 'image', url: 'javascript:alert(1)' }], /只允许 http\(s\)/);
  rejects([{ kind: 'image', url: 'C:\\Users\\x\\a.png' }], /不是合法 URL|只允许 http\(s\)/);
  rejects([{ kind: 'image', url: '/abs/path.png' }], /不是合法 URL|只允许 http\(s\)/);
  rejects([{ kind: 'image', url: '' }], /必须是非空 URL/);
  rejects([{ kind: 'image', url: 42 }], /必须是非空 URL/);
  rejects('not-an-array', /必须是数组/);
  rejects([42], /必须是对象/);
});

test('WMB-5244: validateMediaCandidates accepts http(s) and normalizes shape', () => {
  const ok = validateMediaCandidates([
    { kind: 'image', url: 'https://cdn.example.com/a.png', postKind: 'tweet', ordinal: 0, captionHint: 'x', surroundingText: 'y' },
    { kind: 'video', url: 'http://cdn.example.com/a.mp4' }
  ]);
  assert.equal(ok.length, 2);
  assert.equal(ok[0].kind, 'image');
  assert.equal(ok[1].url, 'http://cdn.example.com/a.mp4');
});

test('WMB-5244: validateMediaCandidates enforces bounded shape', () => {
  const rejects = (candidates, pattern) => {
    assert.throws(() => validateMediaCandidates(candidates), (error) => error instanceof MediaCandidatesInvalidError && pattern.test(error.message));
  };
  rejects([{ kind: 'gif', url: 'https://cdn.example.com/a.gif' }], /kind 非法/);
  rejects([{ kind: 'image', url: 'https://cdn.example.com/a.png', postKind: 'pin' }], /postKind 非法/);
  rejects([{ kind: 'image', url: 'https://cdn.example.com/a.png', ordinal: -1 }], /ordinal 必须为 0\.\.255/);
  rejects([{ kind: 'image', url: 'https://cdn.example.com/a.png', ordinal: 1.5 }], /ordinal 必须为 0\.\.255/);
  rejects([{ kind: 'image', url: 'https://cdn.example.com/a.png', captionHint: 'x'.repeat(501) }], /captionHint 超长/);
  rejects([{ kind: 'image', url: 'https://cdn.example.com/a.png', surroundingText: 'x'.repeat(2001) }], /surroundingText 超长/);
  rejects([{ kind: 'image', url: `https://cdn.example.com/${'x'.repeat(2049)}.png` }], /超长/);
  // 计数上限：21 图 / 5 视频 / 总数 25。
  rejects(Array.from({ length: 21 }, (_, i) => ({ kind: 'image', url: `https://cdn.example.com/img${i}.png` })), /图片候选超限/);
  rejects(Array.from({ length: 5 }, (_, i) => ({ kind: 'video', url: `https://cdn.example.com/v${i}.mp4` })), /视频候选超限/);
  rejects(
    [...Array.from({ length: 21 }, (_, i) => ({ kind: 'image', url: `https://cdn.example.com/i${i}.png` })),
     ...Array.from({ length: 4 }, (_, i) => ({ kind: 'video', url: `https://cdn.example.com/v${i}.mp4` }))],
    /总数超限/
  );
  // 同批 (ordinal, kind) 重复。
  rejects(
    [{ kind: 'image', url: 'https://cdn.example.com/a.png', ordinal: 0 }, { kind: 'image', url: 'https://cdn.example.com/b.png', ordinal: 0 }],
    /\(ordinal, kind\) 与同批已有候选重复/
  );
  // 同 URL 去重（保留首个），20 图 + 4 视频的合法上限通过。
  const bounded = validateMediaCandidates([
    { kind: 'image', url: 'https://cdn.example.com/same.png' },
    { kind: 'image', url: 'https://cdn.example.com/same.png' },
    { kind: 'image', url: 'https://cdn.example.com/same.png' }
  ]);
  assert.equal(bounded.length, 1);
  const maxImages = Array.from({ length: 20 }, (_, i) => ({ kind: 'image', url: `https://cdn.example.com/i${i}.png` }));
  const maxVideos = Array.from({ length: 4 }, (_, i) => ({ kind: 'video', url: `https://cdn.example.com/v${i}.mp4` }));
  assert.equal(validateMediaCandidates([...maxImages, ...maxVideos]).length, 24);
});

test('WMB-5244: validateMediaCandidates enforces poster→video parent linkage', () => {
  const rejects = (candidates, pattern) => {
    assert.throws(() => validateMediaCandidates(candidates), (error) => error instanceof MediaCandidatesInvalidError && pattern.test(error.message));
  };
  rejects([{ kind: 'video_poster', url: 'https://cdn.example.com/p.jpg' }], /video_poster 必须携带/);
  rejects(
    [{ kind: 'video_poster', url: 'https://cdn.example.com/p.jpg', parentUrl: 'https://cdn.example.com/missing.mp4' }],
    /parentUrl 必须指向同批/
  );
  rejects(
    [{ kind: 'image', url: 'https://cdn.example.com/a.png' }, { kind: 'video_poster', url: 'https://cdn.example.com/p.jpg', parentUrl: 'https://cdn.example.com/a.png' }],
    /必须指向同批 video/
  );
  const ok = validateMediaCandidates([
    { kind: 'video', url: 'https://cdn.example.com/a.mp4', ordinal: 1 },
    { kind: 'video_poster', url: 'https://cdn.example.com/p.jpg', parentUrl: 'https://cdn.example.com/a.mp4', ordinal: 1 }
  ]);
  assert.equal(ok.length, 2);
});

// ---------------------------------------------------------------------------
// C. 渠道推导（无 feedId ⇒ research；feed 归属 ⇒ official_web/x_lists）
// ---------------------------------------------------------------------------

test('WMB-5244: deriveCandidateChannel keeps research no-feed identity and resolves feed ownership', () => {
  const directory = path.join(os.tmpdir(), `wmb-5244-channel-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  try {
    assert.equal(deriveCandidateChannel(database, { clientLabel: 'WMB research' }), 'research');
    assert.equal(deriveCandidateChannel(database, {}), 'research');
    assert.equal(deriveCandidateChannel(database, { feedId: 'missing-feed' }), 'research');
    const feed = createSourceFeed(database, { name: '网站源', url: 'https://example.com' });
    assert.equal(deriveCandidateChannel(database, { feedId: feed.id }), 'research', 'feed 未被任何渠道表认领前按研究兜底');
    const now = new Date().toISOString();
    database.prepare(`INSERT INTO website_sources
      (id, source_feed_id, input_text, canonical_url, enabled, resolution_status, resolution_json, last_checked_at, created_at, updated_at, revision)
      VALUES (?, ?, ?, ?, 1, 'ready', '{}', ?, ?, ?, 1)`).run('ws-1', feed.id, '站点', 'https://example.com', now, now, now);
    assert.equal(deriveCandidateChannel(database, { feedId: feed.id }), 'official_web');
  } finally {
    database.close();
  }
});

// ---------------------------------------------------------------------------
// D. dispatcher 集成：同事务落库 / 无候选重发现 / 无效候选零写 / 重放幂等
// ---------------------------------------------------------------------------

test('WMB-5244: reporter/research save WITH candidates persists Source+Candidate+Attempt+Job atomically', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const receipt = await dispatchSourceUpsertBatch(runtime, {
      requestId: 'research-save-candidates', actor: owner,
      items: [{
        title: 'GLM-5.2 基准测试', originalUrl: 'https://zhipuai.cn/benchmark', summary: 'S', author: '智谱AI',
        clientLabel: 'WMB research',
        mediaCandidates: [
          { kind: 'image', url: 'https://cdn.zhipuai.cn/bench.png', captionHint: 'Benchmark 总表' },
          { kind: 'video', url: 'https://cdn.zhipuai.cn/bench.mp4' },
          { kind: 'video_poster', url: 'https://cdn.zhipuai.cn/bench-poster.jpg', parentUrl: 'https://cdn.zhipuai.cn/bench.mp4' }
        ]
      }]
    });
    assert.equal(receipt.ok, true, receipt.error?.message);
    const item = receipt.data.items[0];
    const revKey = sourceRevisionKey(item.id, item.revision);
    assert.deepEqual(item.media, {
      sourceRevisionKey: revKey,
      candidateCount: 3,
      archiveJobCount: 3,
      discoveryScheduled: false
    });
    assert.equal(receipt.data.sources[0].id, item.id);
    // 同事务：Source 一行 + 三候选 + 三 Attempt + 三 media_archive Job。
    assert.equal(count(database, `SELECT COUNT(*) count FROM source_items WHERE id = ?`, item.id), 1);
    const candidates = candidatesFor(database, item.id);
    assert.equal(candidates.length, 3);
    for (const candidate of candidates) {
      assert.equal(candidate.sourceRevisionKey, revKey);
      assert.equal(candidate.channel, 'research');
      assert.equal(candidate.postKind, null);
      assert.equal(candidate.status, 'pending');
      assert.equal(candidate.attemptCount, 0);
      assert.equal(candidate.maxAttempts, 3);
      assert.equal(candidate.requestId, 'research-save-candidates');
    }
    assert.equal(candidates[0].kind, 'image');
    assert.equal(candidates[0].ordinal, 0);
    assert.equal(candidates[1].kind, 'video');
    assert.equal(candidates[1].ordinal, 1);
    assert.equal(candidates[2].kind, 'video_poster');
    assert.equal(candidates[2].ordinal, 2);
    assert.equal(candidates[2].parentCandidateId, candidates[1].id, 'poster 父引用指向同批 video');
    // 初始 Attempt（attempt=1 running）。
    const attempts = attemptsFor(database, item.id);
    assert.equal(attempts.length, 3);
    for (const attempt of attempts) {
      assert.equal(attempt.attempt, 1);
      assert.equal(attempt.status, 'running');
      assert.ok(attempt.startedAt, '预建 attempt 记录开始时间');
    }
    // media_archive Job：dedupe_key 与 payload 精确契约。
    const jobs = archiveJobsFor(database, item.id);
    assert.equal(jobs.length, 3);
    for (const job of jobs) {
      assert.equal(job.kind, MEDIA_ARCHIVE_JOB_KIND);
      assert.equal(job.status, 'pending');
      const payload = JSON.parse(job.payloadJson);
      assert.deepEqual(Object.keys(payload).sort(), ['candidateId', 'sourceId', 'sourceRevisionKey', 'workspaceId']);
      assert.equal(payload.sourceId, item.id);
      assert.equal(payload.sourceRevisionKey, revKey);
      assert.ok(candidates.some((candidate) => candidate.id === payload.candidateId));
      assert.equal(job.dedupeKey, `media:${revKey}:${payload.candidateId}`);
    }
    // 无发现 job（有结构化候选）。
    assert.equal(count(database, `SELECT COUNT(*) count FROM jobs WHERE kind = ?`, MEDIA_DISCOVER_JOB_KIND), 0);
  });
});

test('WMB-5244: reporter/research save WITHOUT candidates schedules bounded rediscovery from originalUrl', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const receipt = await dispatchSourceUpsertBatch(runtime, {
      requestId: 'research-save-nocandidates', actor: owner,
      items: [{ title: '无候选研究页', originalUrl: 'https://example.com/page', summary: 'S', clientLabel: 'WMB research' }]
    });
    assert.equal(receipt.ok, true);
    const item = receipt.data.items[0];
    const revKey = sourceRevisionKey(item.id, item.revision);
    assert.deepEqual(item.media, { sourceRevisionKey: revKey, candidateCount: 0, archiveJobCount: 0, discoveryScheduled: true });
    assert.equal(candidatesFor(database, item.id).length, 0);
    assert.equal(archiveJobsFor(database, item.id).length, 0);
    const job = database.prepare(`SELECT kind, dedupe_key AS dedupeKey, payload_json AS payloadJson, status FROM jobs WHERE kind = ? AND dedupe_key = ?`)
      .get(MEDIA_DISCOVER_JOB_KIND, `media_discover:${revKey}`);
    assert.ok(job, '无候选保存必须调度 media_discover job');
    assert.equal(job.status, 'pending');
    assert.deepEqual(JSON.parse(job.payloadJson), {
      workspaceId: runtime.identity.workspaceId,
      sourceId: item.id,
      sourceRevisionKey: revKey,
      originalUrl: 'https://example.com/page'
    });
    // 有候选保存不调度发现；同 revision 重复调度幂等（仍只有一行）。
    await dispatchSourceUpsertBatch(runtime, {
      requestId: 'reporter-save-with-candidates', actor: owner,
      items: [{ title: '带候选页', originalUrl: 'https://example.com/media', mediaCandidates: [{ kind: 'image', url: 'https://cdn.example.com/m.png' }] }]
    });
    const withCandidates = count(database, `SELECT COUNT(*) count FROM jobs WHERE kind = ? AND dedupe_key LIKE ?`, MEDIA_DISCOVER_JOB_KIND, 'media_discover:%');
    assert.equal(withCandidates, 1, '有结构化候选的保存不触发重发现');
  });
});

test('WMB-5244: invalid candidates fail before writes — zero source/candidate/job rows', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const bad = await dispatchSourceUpsertBatch(runtime, {
      requestId: 'research-save-invalid', actor: owner,
      items: [{ title: 'Bad', originalUrl: 'https://example.com/bad', mediaCandidates: [{ kind: 'image', url: 'wmb-asset://img/1' }] }]
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, 'MEDIA_CANDIDATES_INVALID');
    assert.equal(count(database, `SELECT COUNT(*) count FROM source_items WHERE canonical_url = ?`, 'https://example.com/bad'), 0);
    assert.equal(count(database, `SELECT COUNT(*) count FROM source_media_candidates`), 0);
    assert.equal(count(database, `SELECT COUNT(*) count FROM media_archive_attempts`), 0);
    assert.equal(count(database, `SELECT COUNT(*) count FROM jobs WHERE kind IN (?, ?)`, MEDIA_ARCHIVE_JOB_KIND, MEDIA_DISCOVER_JOB_KIND), 0);
    // 批内任一候选非法 ⇒ 整批零写（第一条 URL 合法也不落库）。
    const partialBad = await dispatchSourceUpsertBatch(runtime, {
      requestId: 'research-save-partial-invalid', actor: owner,
      items: [{ title: 'PartialBad', originalUrl: 'https://example.com/partial-bad', mediaCandidates: [
        { kind: 'image', url: 'https://cdn.example.com/ok.png' },
        { kind: 'image', url: 'file:///C:/evil.png' }
      ] }]
    });
    assert.equal(partialBad.ok, false);
    assert.equal(partialBad.error.code, 'MEDIA_CANDIDATES_INVALID');
    assert.equal(count(database, `SELECT COUNT(*) count FROM source_items`), 0);
    assert.equal(count(database, `SELECT COUNT(*) count FROM source_media_candidates`), 0);
    assert.equal(count(database, `SELECT COUNT(*) count FROM jobs`), 0);
  });
});

test('WMB-5244: replay is idempotent — same requestId/input returns original receipt with zero duplicate rows', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const input = {
      requestId: 'research-save-replay', actor: owner,
      items: [{ title: 'Replay', originalUrl: 'https://example.com/replay', clientLabel: 'WMB research', mediaCandidates: [
        { kind: 'image', url: 'https://cdn.example.com/a.png' },
        { kind: 'video', url: 'https://cdn.example.com/a.mp4' }
      ] }]
    };
    const first = await dispatchSourceUpsertBatch(runtime, input);
    const replay = await dispatchSourceUpsertBatch(runtime, input);
    assert.deepEqual(replay, first, '重放返回原回执');
    const id = first.data.items[0].id;
    assert.equal(candidatesFor(database, id).length, 2);
    assert.equal(attemptsFor(database, id).length, 2);
    assert.equal(archiveJobsFor(database, id).length, 2);
    assert.equal(count(database, `SELECT COUNT(*) count FROM command_receipts WHERE request_id = ?`, 'research-save-replay'), 1);
    // 同 requestId 异输入（候选变化）→ 冲突。
    await assert.rejects(
      () => dispatchSourceUpsertBatch(runtime, { ...input, items: [{ ...input.items[0], mediaCandidates: [{ kind: 'image', url: 'https://cdn.example.com/b.png' }] }] }),
      { code: 'REQUEST_REPLAY_CONFLICT' }
    );
  });
});

test('WMB-5244: mediaCandidates are per source revision — re-save bumps revision and archives under the new key', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const first = await dispatchSourceUpsertBatch(runtime, {
      requestId: 'revision-first', actor: owner,
      items: [{ title: '版本一', originalUrl: 'https://example.com/rev', mediaCandidates: [{ kind: 'image', url: 'https://cdn.example.com/v1.png' }] }]
    });
    const second = await dispatchSourceUpsertBatch(runtime, {
      requestId: 'revision-second', actor: owner,
      items: [{ title: '版本二', originalUrl: 'https://example.com/rev', mediaCandidates: [{ kind: 'image', url: 'https://cdn.example.com/v2.png' }] }]
    });
    const id = first.data.items[0].id;
    assert.equal(second.data.items[0].id, id);
    assert.equal(second.data.items[0].revision, first.data.items[0].revision + 1);
    const firstKey = sourceRevisionKey(id, first.data.items[0].revision);
    const secondKey = sourceRevisionKey(id, second.data.items[0].revision);
    assert.notEqual(firstKey, secondKey);
    assert.equal(candidatesFor(database, id).length, 2, '两个 revision 各自保留候选');
    const revisions = database.prepare('SELECT DISTINCT source_revision_key AS key FROM source_media_candidates WHERE source_id = ? ORDER BY key').all(id).map((row) => row.key);
    assert.deepEqual(revisions, [firstKey, secondKey]);
  });
});

// ---------------------------------------------------------------------------
// E. MCP 边界（真实工具面）：mediaCandidates 通过 zod + 授权 + 持久化
// ---------------------------------------------------------------------------

test('WMB-5244: MCP sources.upsert_batch accepts mediaCandidates end-to-end with existing grant', async () => {
  await withRuntime(async ({ root, runtime, database }) => {
    const task = (await dispatchStartAgentTask(runtime, {
      intent: 'daily_intelligence', businessDate: '2026-08-14', contextRefs: { workspaceId: runtime.identity.workspaceId }
    }, { actor: owner, requestId: 'task-5244-mcp' })).task;
    const grantReceipt = await dispatchIssueTaskGrant(runtime, {
      requestId: 'grant-5244-mcp', taskId: task.id, ownerGoal: '验证媒体候选写回',
      allowedCommands: ['sources.upsert_batch'], workers: [{ type: 'external_agent', id: 'mcp' }],
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    assert.equal(grantReceipt.ok, true);
    const mcp = await startMcp(root, runtime.gate, undefined, runtime);
    try {
      const initialized = await request(mcp.url, 'initialize', {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wmb-5244-test', version: '1' }
      });
      const called = await request(mcp.url, 'tools/call', {
        name: 'sources.upsert_batch', arguments: {
          request_id: 'mcp-5244-media', task_id: task.id, grant_id: grantReceipt.data.id,
          items: [{
            title: 'MCP 媒体候选', originalUrl: 'https://example.com/mcp-media',
            mediaCandidates: [{ kind: 'image', url: 'https://cdn.example.com/mcp.png' }]
          }]
        }
      }, initialized.sessionId);
      const mcpReceipt = JSON.parse(called.result.content[0].text);
      assert.equal(mcpReceipt.ok, true, mcpReceipt.error?.message);
      assert.equal(mcpReceipt.actor.type, 'external_agent');
      const id = mcpReceipt.data.items[0].id;
      assert.equal(mcpReceipt.data.items[0].media.candidateCount, 1);
      const candidates = candidatesFor(database, id);
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].channel, 'research', '无 feedId 的记者保存按 research 兜底');
      // 非法候选在 MCP 边界即失败（zod 镜像 + dispatcher 校验），零写。
      const badCall = await request(mcp.url, 'tools/call', {
        name: 'sources.upsert_batch', arguments: {
          request_id: 'mcp-5244-bad', task_id: task.id, grant_id: grantReceipt.data.id,
          items: [{ title: 'MCP 非法候选', originalUrl: 'https://example.com/bad', mediaCandidates: [{ kind: 'image', url: 'wmb-asset://img/9' }] }]
        }
      }, initialized.sessionId);
      const badReceipt = JSON.parse(badCall.result.content[0].text);
      assert.equal(badReceipt.ok, false);
      assert.equal(badReceipt.error.code, 'MEDIA_CANDIDATES_INVALID');
      assert.equal(count(database, `SELECT COUNT(*) count FROM source_items WHERE canonical_url = ?`, 'https://example.com/bad'), 0);
    } finally {
      await mcp.close();
    }
  });
});

// ---------------------------------------------------------------------------
// F. 调度原语幂等（纯 DB 层）
// ---------------------------------------------------------------------------

test('WMB-5244: scheduleSourceMediaDiscovery is idempotent per source revision', async () => {
  const directory = path.join(os.tmpdir(), `wmb-5244-sched-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  try {
    const now = new Date().toISOString();
    database.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)").run('ws-sched', now, now);
    const first = scheduleSourceMediaDiscovery(database, {
      sourceId: 'src-1', sourceRevisionKey: 'source:src-1:r1', originalUrl: 'https://example.com/p', now
    });
    const again = scheduleSourceMediaDiscovery(database, {
      sourceId: 'src-1', sourceRevisionKey: 'source:src-1:r1', originalUrl: 'https://example.com/p', now
    });
    assert.deepEqual(first, { scheduled: true });
    assert.deepEqual(again, { scheduled: false });
    assert.equal(count(database, `SELECT COUNT(*) count FROM jobs WHERE kind = ?`, MEDIA_DISCOVER_JOB_KIND), 1);
    const next = scheduleSourceMediaDiscovery(database, {
      sourceId: 'src-1', sourceRevisionKey: 'source:src-1:r2', originalUrl: 'https://example.com/p', now
    });
    assert.deepEqual(next, { scheduled: true }, '新 revision 允许新发现 job');
    assert.equal(count(database, `SELECT COUNT(*) count FROM jobs WHERE kind = ?`, MEDIA_DISCOVER_JOB_KIND), 2);
  } finally {
    database.close();
  }
});
