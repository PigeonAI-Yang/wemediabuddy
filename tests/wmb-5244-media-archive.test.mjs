// WMB-5244 渠道媒体冻结 —— 数据合同聚焦测试（MediaSchema 独占迁移 >=64）。
// 覆盖（共享合同）：
// - migration 64/65/66：候选/尝试/绑定表、provenance kind 扩展 + 绑定视频列、video_understanding_runs；
//   真实 v63 旧库升级（1..63 真实迁移 + 64..66 续跑）幂等且旧数据保留（图片语义不变）；
// - jobs kind 兼容：media_archive/media_discover 无 CHECK 拦截，dedupe 唯一；
// - store 原语：insertMediaCandidates（候选+初始 Attempt+Job 同调用、幂等复用）、
//   七态状态机、writeArchiveAttempt（attempt 新行不覆盖旧失败）、
//   completeMediaCandidatePreserved（Binding+Provenance+preserved 同事务；重放幂等）、
//   权利门（restricted 需显式确认）、read model 计数；
// - video_understanding_runs：身份唯一、stage checkpoint、completed 不可变
//   （store 双保险 + DB 触发器拒绝裸 SQL UPDATE）、重试新 attempt、latest-run 复用；
// - data-root-safe：store 原语零事务，调用方 BEGIN+ROLLBACK 可整体回滚。
// 数据测试全部使用真实 SQLite（migrateDatabase / migrations）+ production 函数。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { migrateDatabase, migrations } = await import('../src/main/db/migrations.ts');
const store = await import('../src/main/db/media-archive-store.ts');
const video = await import('../src/main/db/video-understanding-store.ts');
const shared = await import('../src/shared/media-candidates.ts');

const shaOf = (value) => createHash('sha256').update(value).digest('hex');

async function withDb(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-5244-'));
  try {
    const dbPath = path.join(directory, 'test.sqlite');
    const database = migrateDatabase(dbPath);
    try {
      await run(database, dbPath);
    } finally {
      try { database.close(); } catch { /* 测试回调可能已自行 close（reopen 场景） */ }
    }
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

/** 在干净事务里执行 fn 后回滚；断言 fn 内写入全部消失（data-root-safe / 调用方事务语义）。 */
async function withRollback(database, fn) {
  database.exec('BEGIN');
  const result = await fn();
  database.exec('ROLLBACK');
  return result;
}

function seedSource(database, overrides = {}) {
  const now = new Date().toISOString();
  const id = overrides.id ?? `src-${Math.random().toString(36).slice(2)}`;
  database
    .prepare(
      `INSERT INTO source_items (id, canonical_url, title, collected_at, categories_json, keywords_json,
        recommended_platforms_json, recommended_formats_json, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, '[]', '[]', '[]', '[]', ?, ?, 1)`
    )
    .run(id, overrides.url ?? `https://example.com/${id}`, overrides.title ?? 't', now, now, now);
  return id;
}

function seedAsset(database, bytes, mimeType = 'image/png') {
  const id = `ast-${shaOf(bytes).slice(0, 16)}`;
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO assets (id, relative_path, mime_type, byte_count, sha256, origin, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, 'test', ?, ?, 1)`
    )
    .run(id, `assets/${shaOf(bytes)}.png`, mimeType, bytes.byteLength, shaOf(bytes), now, now);
  return id;
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

// ---------------------------------------------------------------------------
// migration 64/65/66：新表、旧库升级幂等、旧数据保留、图片语义不变
// ---------------------------------------------------------------------------

test('WMB-5244 media: migrations 64-66 create tables and reopen is idempotent', async () => {
  await withDb(async (database, dbPath) => {
    const versions = database.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version);
    assert.ok(versions.includes(64) && versions.includes(65) && versions.includes(66), `missing 64-66: ${versions.join(',')}`);
    for (const table of ['source_media_candidates', 'media_archive_attempts', 'source_media_bindings', 'video_understanding_runs']) {
      const row = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      assert.ok(row, `table missing: ${table}`);
    }
    const trigger = database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'video_understanding_runs_completed_immutable'")
      .get();
    assert.ok(trigger, 'completed-immutable trigger missing');
    // 重新打开（migrateDatabase 再次执行）→ 版本集不变。
    database.close();
    const reopened = migrateDatabase(dbPath);
    const versionsAfter = reopened.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version);
    assert.deepEqual(versionsAfter, versions);
    reopened.close();
  });
});

test('WMB-5244 media: real v63 legacy DB upgrades to 66 preserving provenance rows and image binding semantics', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-5244-legacy-'));
  try {
    const dbPath = path.join(directory, 'legacy.sqlite');
    const now = new Date().toISOString();
    // 应用真实 1..63 迁移（含 v62 绑定/血缘表），模拟存量 v63 工作空间。
    {
      const legacy = new DatabaseSync(dbPath);
      legacy.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
      for (const m of migrations) {
        if (m.version > 63) continue;
        legacy.exec(m.sql);
        m.run?.(legacy);
        legacy.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, new Date().toISOString());
      }
      // 造存量数据：source + asset + imported provenance + derived_crop provenance + 平台绑定（图片语义）。
      const src = 'legacy-src';
      legacy
        .prepare(
          `INSERT INTO source_items (id, canonical_url, title, collected_at, categories_json, keywords_json,
            recommended_platforms_json, recommended_formats_json, created_at, updated_at, revision)
           VALUES (?, 'https://legacy.example.com/a', 'legacy', ?, '[]', '[]', '[]', '[]', ?, ?, 2)`
        )
        .run(src, now, now, now);
      legacy
        .prepare(
          `INSERT INTO assets (id, relative_path, mime_type, byte_count, sha256, origin, created_at, updated_at, revision)
           VALUES ('legacy-asset', 'assets/legacy.png', 'image/png', 10, ?, 'test', ?, ?, 1)`
        )
        .run(shaOf('legacy-bytes'), now, now);
      legacy
        .prepare(
          `INSERT INTO asset_provenance (id, asset_id, kind, origin, created_at)
           VALUES ('prov-imported', 'legacy-asset', 'imported', 'legacy', ?)`
        )
        .run(now);
      legacy
        .prepare(
          `INSERT INTO asset_provenance (id, asset_id, kind, origin, source_asset_id, derived_asset_id, transform_json, created_at)
           VALUES ('prov-crop', 'legacy-asset', 'derived_crop', 'legacy', 'legacy-asset', 'legacy-asset', '{"cropRegion":{"x":0}}', ?)`
        )
        .run(now);
      legacy
        .prepare(
          `INSERT INTO content_projects (id, title, created_at, updated_at, revision)
           VALUES ('proj1', 'p', ?, ?, 1)`
        )
        .run(now, now);
      legacy
        .prepare(
          `INSERT INTO content_versions (id, project_id, body, version_number, created_at)
           VALUES ('cv1', 'proj1', 'body', 1, ?)`
        )
        .run(now);
      legacy
        .prepare(
          `INSERT INTO platform_versions (id, project_id, content_version_id, platform, format, body, asset_ids_json, created_at, updated_at, revision)
           VALUES ('pv1', 'proj1', 'cv1', 'x', 'post', 'body', '[]', ?, ?, 1)`
        )
        .run(now, now);
      legacy
        .prepare(
          `INSERT INTO platform_media_bindings (id, platform_version_id, asset_id, ordinal, is_cover, created_at, updated_at)
           VALUES ('pmb1', 'pv1', 'legacy-asset', 0, 1, ?, ?)`
        )
        .run(now, now);
      legacy.close();
    }
    // 升级 64..66。
    const upgraded = migrateDatabase(dbPath);
    const versions = upgraded.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version);
    assert.ok(versions.includes(66), `upgrade missing 66: ${versions.join(',')}`);
    // 存量 provenance 行保留（imported + derived_crop），kind 约束已扩展。
    const kinds = upgraded.prepare('SELECT kind FROM asset_provenance ORDER BY id').all().map((r) => r.kind);
    assert.deepEqual(kinds.sort(), ['derived_crop', 'imported']);
    // 存量平台绑定图片语义：media_kind 默认 image，无 poster/clip 数据。
    const binding = upgraded
      .prepare('SELECT media_kind AS mediaKind, poster_asset_id AS posterAssetId, clip_range_json AS clipRangeJson, duration_ms AS durationMs FROM platform_media_bindings WHERE id = ?')
      .get('pmb1');
    assert.equal(binding.mediaKind, 'image');
    assert.equal(binding.posterAssetId, null);
    assert.equal(binding.clipRangeJson, null);
    assert.equal(binding.durationMs, null);
    // 新表可写：media_archive job kind 兼容。
    upgraded
      .prepare(
        `INSERT INTO jobs (id, kind, status, due_at, attempts, dedupe_key, payload_json, created_at, updated_at)
         VALUES ('job1', 'media_archive', 'pending', ?, 0, 'media:src1:r1:smc:x', '{}', ?, ?)`
      )
      .run(now, now, now);
    upgraded.close();
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

// ---------------------------------------------------------------------------
// 共享键与 URL 规范化
// ---------------------------------------------------------------------------

test('WMB-5244 media: sourceRevisionKey and URL normalization contract', () => {
  assert.equal(shared.sourceRevisionKey('abc', 3), 'source:abc:r3');
  // 小写 scheme/host、移除 fragment、保留 query 原顺序。
  assert.equal(shared.normalizeRemoteUrl('HTTPS://Example.COM/A?b=2&a=1#frag'), 'https://example.com/A?b=2&a=1');
  // 非 http(s) 原样返回（调用方据此拒绝 data:/blob:/file:/wmb-asset:）。
  assert.equal(shared.normalizeRemoteUrl('data:image/png;base64,xx'), 'data:image/png;base64,xx');
  assert.equal(shared.mediaArchiveDedupeKey('source:a:r1', 'c1'), 'media:source:a:r1:c1');
  assert.equal(shared.mediaDiscoverDedupeKey('source:a:r1'), 'media_discover:source:a:r1');
});

// ---------------------------------------------------------------------------
// insertMediaCandidates：候选 + 初始 Attempt + Job 原子落库，幂等复用
// ---------------------------------------------------------------------------

test('WMB-5244 media: insertMediaCandidates writes candidates, initial attempt and job idempotently', async () => {
  await withDb(async (database) => {
    const sourceId = seedSource(database);
    const revKey = shared.sourceRevisionKey(sourceId, 1);
    const input = {
      sourceId,
      sourceRevisionKey: revKey,
      channel: 'x_lists',
      requestId: 'req-1',
      discoveredAt: new Date().toISOString(),
      candidates: [
        { kind: 'image', originalUrl: 'https://pbs.twimg.com/media/A.png', ordinal: 0, postOrdinal: 0, ordinalInPost: 0 },
        { kind: 'video', originalUrl: 'https://video.twimg.com/ext.mp4', ordinal: 1, postOrdinal: 0, ordinalInPost: 1 },
        { kind: 'video_poster', originalUrl: 'https://pbs.twimg.com/ext_poster.jpg', ordinal: 2, postOrdinal: 0, ordinalInPost: 2, parentOrdinal: 1 }
      ]
    };
    const first = store.insertMediaCandidates(database, input);
    assert.equal(first.inserted.length, 3);
    assert.equal(first.reused.length, 0);
    assert.equal(first.candidateIds.length, 3);

    const rows = store.listMediaCandidatesForRevision(database, revKey);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.status), ['pending', 'pending', 'pending']);
    // 确定性 ID 契约。
    assert.equal(rows[0].id, `smc:${revKey}:0:image`);
    assert.equal(rows[2].id, `smc:${revKey}:2:video_poster`);
    // poster 父引用 → 视频候选。
    assert.equal(rows[2].parentCandidateId, `smc:${revKey}:1:video`);
    // 稳定远程身份。
    assert.equal(rows[0].stableRemoteIdentity, shaOf('https://pbs.twimg.com/media/A.png'));
    // 初始 Attempt（attempt=1 running）+ Job（dedupe 唯一）。
    for (const row of rows) {
      const attempts = store.listArchiveAttempts(database, row.id);
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].attempt, 1);
      assert.equal(attempts[0].status, 'running');
      const job = database.prepare('SELECT * FROM jobs WHERE dedupe_key = ?').get(shared.mediaArchiveDedupeKey(revKey, row.id));
      assert.ok(job, `job missing for ${row.id}`);
      assert.equal(job.kind, 'media_archive');
      const payload = JSON.parse(job.payload_json);
      assert.deepEqual(Object.keys(payload).sort(), ['candidateId', 'sourceId', 'sourceRevisionKey', 'workspaceId']);
    }
    // 幂等重放：复用，不新增 Attempt/Job。
    const second = store.insertMediaCandidates(database, input);
    assert.equal(second.inserted.length, 0);
    assert.equal(second.reused.length, 3);
    assert.equal(database.prepare('SELECT COUNT(*) AS c FROM media_archive_attempts').get().c, 3);
    assert.equal(database.prepare("SELECT COUNT(*) AS c FROM jobs WHERE kind = 'media_archive'").get().c, 3);
    // 同 revision 同 URL 不同 ordinal（主帖图 + 引用帖图）→ 独立候选。
    const quoteInput = {
      ...input,
      candidates: [{ kind: 'image', originalUrl: 'https://pbs.twimg.com/media/A.png', ordinal: 3, postOrdinal: 1, ordinalInPost: 0, postKind: 'quote' }]
    };
    const quote = store.insertMediaCandidates(database, quoteInput);
    assert.equal(quote.inserted.length, 1);
    assert.equal(store.listMediaCandidatesForRevision(database, revKey).length, 4);
  });
});

// ---------------------------------------------------------------------------
// 状态机 + Attempt 行语义
// ---------------------------------------------------------------------------

test('WMB-5244 media: candidate seven-state machine and attempt rows never overwrite old failures', async () => {
  await withDb(async (database) => {
    const sourceId = seedSource(database);
    const revKey = shared.sourceRevisionKey(sourceId, 1);
    const [candidate] = store.insertMediaCandidates(database, {
      sourceId,
      sourceRevisionKey: revKey,
      channel: 'official_web',
      requestId: 'r',
      discoveredAt: new Date().toISOString(),
      candidates: [{ kind: 'image', originalUrl: 'https://example.com/x.png', ordinal: 0 }]
    }).candidateIds;

    // pending → downloading → failed（合法）；failed → downloading（自动重试）。
    store.transitionMediaCandidate(database, { candidateId: candidate, to: 'downloading' });
    store.transitionMediaCandidate(database, { candidateId: candidate, to: 'failed', errorCode: 'HTTP_403', errorMessage: 'nope' });
    store.transitionMediaCandidate(database, { candidateId: candidate, to: 'downloading' });

    // 非法迁移：终态 unsupported 后不可迁移；preserved 只能经 complete 冻结（裸转被拒）。
    const illegal = (to) =>
      assert.throws(() => store.transitionMediaCandidate(database, { candidateId: candidate, to }), /状态迁移非法/);
    illegal('preserved'); // downloading→preserved 只能经 completeMediaCandidatePreserved（同事务写 Binding）
    // downloading → unsupported 合法；unsupported → 任何 非法。
    store.transitionMediaCandidate(database, { candidateId: candidate, to: 'unsupported', errorCode: 'UNSUPPORTED_STREAM' });
    assert.throws(() => store.transitionMediaCandidate(database, { candidateId: candidate, to: 'downloading' }), /状态迁移非法/);

    // 多 attempt：attempt=2 失败后 attempt=3 写入，旧行不被覆盖。
    const c2 = store.insertMediaCandidates(database, {
      sourceId,
      sourceRevisionKey: revKey,
      channel: 'research',
      requestId: 'r2',
      discoveredAt: new Date().toISOString(),
      candidates: [{ kind: 'video', originalUrl: 'https://example.com/v.mp4', ordinal: 1 }]
    }).candidateIds[0];
    const started = new Date().toISOString();
    store.writeArchiveAttempt(database, { candidateId: c2, attempt: 2, status: 'failed', startedAt: started, finishedAt: started, errorCode: 'TIMEOUT' });
    store.writeArchiveAttempt(database, { candidateId: c2, attempt: 3, status: 'failed', startedAt: started, finishedAt: started, errorCode: 'DNS' });
    const attempts = store.listArchiveAttempts(database, c2);
    assert.equal(attempts.length, 3); // 初始 1 + 2 + 3
    assert.equal(attempts[1].errorCode, 'TIMEOUT');
    assert.equal(attempts[2].errorCode, 'DNS');
    assert.equal(store.getMediaCandidate(database, c2).attemptCount, 3);
  });
});

test('WMB-5244 media: skipped_limit candidates persist without attempt or job (design §8)', async () => {
  await withDb(async (database) => {
    const sourceId = seedSource(database);
    const revKey = shared.sourceRevisionKey(sourceId, 1);
    const result = store.insertMediaCandidates(database, {
      sourceId,
      sourceRevisionKey: revKey,
      channel: 'official_web',
      requestId: 'r',
      discoveredAt: new Date().toISOString(),
      candidates: [
        { kind: 'image', originalUrl: 'https://example.com/within.png', ordinal: 0 },
        { kind: 'video', originalUrl: 'https://example.com/beyond.mp4', ordinal: 1, status: 'skipped_limit' }
      ]
    });
    assert.equal(result.inserted.length, 2);
    const rows = store.listMediaCandidatesForRevision(database, revKey);
    assert.deepEqual(rows.map((r) => r.status), ['pending', 'skipped_limit']);
    // 无 Attempt、无 Job。
    assert.equal(database.prepare('SELECT COUNT(*) AS c FROM media_archive_attempts').get().c, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS c FROM jobs WHERE kind = 'media_archive'").get().c, 1);
    const summary = store.mediaArchiveStatusSummary(database, revKey);
    assert.equal(summary.total, 2);
    assert.equal(summary.skippedLimit, 1);
    // 幂等重放：skipped_limit 行复用，不新增 Attempt/Job。
    const replay = store.insertMediaCandidates(database, {
      sourceId,
      sourceRevisionKey: revKey,
      channel: 'official_web',
      requestId: 'r',
      discoveredAt: new Date().toISOString(),
      candidates: [
        { kind: 'image', originalUrl: 'https://example.com/within.png', ordinal: 0 },
        { kind: 'video', originalUrl: 'https://example.com/beyond.mp4', ordinal: 1, status: 'skipped_limit' }
      ]
    });
    assert.equal(replay.inserted.length, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS c FROM media_archive_attempts').get().c, 1);
  });
});

test('WMB-5244 media: alternateUrls fallback chain is persisted and read back', async () => {
  await withDb(async (database) => {
    const sourceId = seedSource(database);
    const revKey = shared.sourceRevisionKey(sourceId, 1);
    store.insertMediaCandidates(database, {
      sourceId,
      sourceRevisionKey: revKey,
      channel: 'x_lists',
      requestId: 'r',
      discoveredAt: new Date().toISOString(),
      candidates: [
        {
          kind: 'image',
          originalUrl: 'https://pbs.twimg.com/A_orig.png',
          ordinal: 0,
          alternateUrls: ['https://pbs.twimg.com/A_medium.png', 'https://pbs.twimg.com/A_thumb.png']
        }
      ]
    });
    const [row] = store.listMediaCandidatesForRevision(database, revKey);
    assert.deepEqual(row.alternateUrls, ['https://pbs.twimg.com/A_medium.png', 'https://pbs.twimg.com/A_thumb.png']);
    const raw = database.prepare('SELECT alternate_urls_json AS j FROM source_media_candidates WHERE id = ?').get(row.id);
    assert.equal(raw.j, '["https://pbs.twimg.com/A_medium.png","https://pbs.twimg.com/A_thumb.png"]');
  });
});

// ---------------------------------------------------------------------------
// preserved：Binding + Provenance 同事务；重放幂等；UNIQUE 约束
// ---------------------------------------------------------------------------

test('WMB-5244 media: preserved freezes binding+provenance in one transaction, idempotent, invariant enforced', async () => {
  await withDb(async (database) => {
    const sourceId = seedSource(database);
    const revKey = shared.sourceRevisionKey(sourceId, 1);
    const assetId = seedAsset(database, PNG);
    const [candidate] = store.insertMediaCandidates(database, {
      sourceId,
      sourceRevisionKey: revKey,
      channel: 'x_lists',
      requestId: 'r',
      discoveredAt: new Date().toISOString(),
      candidates: [{ kind: 'image', originalUrl: 'https://example.com/x.png', ordinal: 0 }]
    }).candidateIds;
    store.transitionMediaCandidate(database, { candidateId: candidate, to: 'downloading' });

    const binding = store.completeMediaCandidatePreserved(database, {
      candidateId: candidate,
      sourceId,
      sourceRevisionKey: revKey,
      assetId,
      sha256: shaOf('bytes'),
      capturedAt: new Date().toISOString(),
      kind: 'image',
      ordinal: 0,
      originalUrl: 'https://example.com/x.png',
      createdBy: 'test',
      requestId: 'r'
    });
    assert.equal(binding.id, `sbm:${candidate}`);
    assert.equal(binding.rightsStatus, 'unknown');
    assert.equal(store.getMediaCandidate(database, candidate).status, 'preserved');
    // Provenance：独立 imported 血缘行。
    const provenance = database.prepare("SELECT * FROM asset_provenance WHERE id = 'smp:" + candidate + "'").get();
    assert.ok(provenance, 'provenance missing');
    assert.equal(provenance.kind, 'imported');
    // preserved 终态：重放幂等返回既有 binding；不能 failed。
    const replay = store.completeMediaCandidatePreserved(database, {
      candidateId: candidate,
      sourceId,
      sourceRevisionKey: revKey,
      assetId,
      sha256: shaOf('bytes'),
      capturedAt: new Date().toISOString(),
      kind: 'image',
      ordinal: 0,
      originalUrl: 'https://example.com/x.png',
      createdBy: 'test'
    });
    assert.equal(replay.id, binding.id);
    assert.throws(() => store.transitionMediaCandidate(database, { candidateId: candidate, to: 'failed' }), /状态迁移非法/);
    assert.equal(database.prepare('SELECT COUNT(*) AS c FROM source_media_bindings').get().c, 1);

    // 同 revision 同 asset 二次绑定 → UNIQUE(source_revision_key, asset_id) 拒绝（复用既有 binding）。
    const [candidate2] = store.insertMediaCandidates(database, {
      sourceId,
      sourceRevisionKey: revKey,
      channel: 'x_lists',
      requestId: 'r2',
      discoveredAt: new Date().toISOString(),
      candidates: [{ kind: 'image', originalUrl: 'https://other.example.com/x.png', ordinal: 1 }]
    }).candidateIds;
    store.transitionMediaCandidate(database, { candidateId: candidate2, to: 'downloading' });
    const sharedBinding = store.completeMediaCandidatePreserved(database, {
      candidateId: candidate2,
      sourceId,
      sourceRevisionKey: revKey,
      assetId,
      sha256: shaOf('bytes'),
      capturedAt: new Date().toISOString(),
      kind: 'image',
      ordinal: 1,
      originalUrl: 'https://other.example.com/x.png',
      createdBy: 'test'
    });
    assert.equal(sharedBinding.id, binding.id);
    assert.equal(store.getMediaCandidate(database, candidate2).status, 'preserved');
    assert.equal(database.prepare('SELECT COUNT(*) AS c FROM source_media_bindings').get().c, 1);

    // 失败候选不能冻结为 preserved。
    const [candidate3] = store.insertMediaCandidates(database, {
      sourceId,
      sourceRevisionKey: revKey,
      channel: 'x_lists',
      requestId: 'r3',
      discoveredAt: new Date().toISOString(),
      candidates: [{ kind: 'image', originalUrl: 'https://fail.example.com/x.png', ordinal: 2 }]
    }).candidateIds;
    store.transitionMediaCandidate(database, { candidateId: candidate3, to: 'failed', errorCode: 'HTTP_403' });
    assert.throws(
      () =>
        store.completeMediaCandidatePreserved(database, {
          candidateId: candidate3,
          sourceId,
          sourceRevisionKey: revKey,
          assetId,
          sha256: shaOf('bytes'),
          capturedAt: new Date().toISOString(),
          kind: 'image',
          ordinal: 2,
          originalUrl: 'https://fail.example.com/x.png',
          createdBy: 'test'
        }),
      /不允许冻结/
    );
  });
});

test('WMB-5244 media: rights gate blocks AI downgrade from restricted without confirmation', async () => {
  await withDb(async (database) => {
    const sourceId = seedSource(database);
    const revKey = shared.sourceRevisionKey(sourceId, 1);
    const assetId = seedAsset(database, PNG);
    const [candidate] = store.insertMediaCandidates(database, {
      sourceId,
      sourceRevisionKey: revKey,
      channel: 'research',
      requestId: 'r',
      discoveredAt: new Date().toISOString(),
      candidates: [{ kind: 'image', originalUrl: 'https://example.com/x.png', ordinal: 0 }]
    }).candidateIds;
    store.transitionMediaCandidate(database, { candidateId: candidate, to: 'downloading' });
    store.completeMediaCandidatePreserved(database, {
      candidateId: candidate,
      sourceId,
      sourceRevisionKey: revKey,
      assetId,
      sha256: shaOf('bytes'),
      capturedAt: new Date().toISOString(),
      kind: 'image',
      ordinal: 0,
      originalUrl: 'https://example.com/x.png',
      rightsStatus: 'restricted',
      riskFlags: ['copyright', 'paywalled'],
      createdBy: 'ai'
    });
    const binding = store.listSourceMediaBindings(database, revKey)[0];
    assert.equal(binding.rightsStatus, 'restricted');
    assert.deepEqual(JSON.parse(binding.riskFlagsJson), ['copyright', 'paywalled']);
    assert.throws(() => store.setBindingRightsStatus(database, binding.id, 'likely_reusable'), /RESTRICTED_BINDING_NEEDS_USER_CONFIRMATION/);
    const updated = store.setBindingRightsStatus(database, binding.id, 'likely_reusable', { requireUserConfirmation: true });
    assert.equal(updated.rightsStatus, 'likely_reusable');
  });
});

// ---------------------------------------------------------------------------
// video_understanding_runs：身份唯一、stage checkpoint、completed 不可变、重试
// ---------------------------------------------------------------------------

test('WMB-5244 media: video run lifecycle enforces completed immutability and per-attempt identity', async () => {
  await withDb(async (database) => {
    const sourceId = seedSource(database);
    const revKey = shared.sourceRevisionKey(sourceId, 1);
    const assetId = seedAsset(database, PNG, 'video/mp4');
    const identity = { sourceId, sourceRevisionKey: revKey, assetId, schemaVersion: 1, attempt: 1 };
    const run = video.createVideoRun(database, identity);
    assert.equal(run.status, 'queued');
    // 幂等：同身份重复创建返回既有行。
    assert.equal(video.createVideoRun(database, identity).id, run.id);
    assert.equal(database.prepare('SELECT COUNT(*) AS c FROM video_understanding_runs').get().c, 1);

    video.startVideoRun(database, run.id, { model: 'm', provider: 'p', runtimeManifestHash: 'h' });
    video.checkpointVideoStage(database, { runId: run.id, stage: 'probe', probeJson: JSON.stringify({ container: 'mp4', durationMs: 120_000 }) });
    video.checkpointVideoStage(database, { runId: run.id, stage: 'transcript', transcriptJson: JSON.stringify({ source: 'native' }) });
    video.checkpointVideoStage(database, {
      runId: run.id,
      stage: 'align',
      segmentsJson: JSON.stringify([{ index: 0, startMs: 0, endMs: 10_000, transcriptSource: 'native', transcript: [], ocrRegions: [], warnings: [] }])
    });
    const completed = video.completeVideoRun(database, run.id, { model: 'm', promptVersion: 2 });
    assert.equal(completed.status, 'completed');
    assert.ok(completed.completedAt);

    // store 双保险：completed 拒绝 checkpoint/fail/complete。
    assert.throws(() => video.checkpointVideoStage(database, { runId: run.id, stage: 'ocr' }), /VIDEO_RUN_COMPLETED_IMMUTABLE/);
    assert.throws(() => video.failVideoRun(database, run.id, { errorCode: 'X' }), /VIDEO_RUN_COMPLETED_IMMUTABLE/);
    // DB 触发器：裸 SQL UPDATE 也被拒绝。
    assert.throws(
      () => database.prepare('UPDATE video_understanding_runs SET stage = ? WHERE id = ?').run('ocr', run.id),
      /VIDEO_RUN_COMPLETED_IMMUTABLE/
    );

    // 重试：attempt=2 新行；latest 查询返回最大 attempt。
    const retry = video.createVideoRun(database, { ...identity, attempt: 2 });
    assert.notEqual(retry.id, run.id);
    assert.equal(database.prepare('SELECT COUNT(*) AS c FROM video_understanding_runs').get().c, 2);
    video.startVideoRun(database, retry.id);
    const latest = video.getLatestVideoRunForIdentity(database, { sourceId, sourceRevisionKey: revKey, assetId, schemaVersion: 1 });
    assert.equal(latest.id, retry.id);
    assert.equal(latest.status, 'running');
    assert.equal(video.listVideoRunsForRevision(database, revKey).length, 2);
    // 身份读取（精确 attempt）。
    assert.equal(video.getVideoRunForIdentity(database, identity).status, 'completed');
    // 结构化解析。
    const probe = video.parseProbeJson(video.getVideoRun(database, run.id));
    assert.equal(probe.container, 'mp4');
    const segments = video.parseSegmentsJson(video.getVideoRun(database, run.id));
    assert.equal(segments[0].transcriptSource, 'native');
  });
});

// ---------------------------------------------------------------------------
// data-root-safe：store 原语零事务，调用方 ROLLBACK 整体回滚
// ---------------------------------------------------------------------------

test('WMB-5244 media: store primitives are transaction-agnostic (caller ROLLBACK discards all)', async () => {
  await withDb(async (database) => {
    const sourceId = seedSource(database);
    const revKey = shared.sourceRevisionKey(sourceId, 1);
    const assetId = seedAsset(database, PNG);
    const captured = await withRollback(database, () => {
      const ids = store.insertMediaCandidates(database, {
        sourceId,
        sourceRevisionKey: revKey,
        channel: 'official_web',
        requestId: 'r',
        discoveredAt: new Date().toISOString(),
        candidates: [{ kind: 'image', originalUrl: 'https://example.com/x.png', ordinal: 0 }]
      }).candidateIds;
      store.transitionMediaCandidate(database, { candidateId: ids[0], to: 'downloading' });
      const binding = store.completeMediaCandidatePreserved(database, {
        candidateId: ids[0],
        sourceId,
        sourceRevisionKey: revKey,
        assetId,
        sha256: shaOf('bytes'),
        capturedAt: new Date().toISOString(),
        kind: 'image',
        ordinal: 0,
        originalUrl: 'https://example.com/x.png',
        createdBy: 'test'
      });
      return { candidateId: ids[0], bindingId: binding.id };
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS c FROM source_media_candidates').get().c, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS c FROM source_media_bindings').get().c, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS c FROM media_archive_attempts').get().c, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS c FROM jobs WHERE kind = 'media_archive'").get().c, 0);
    void captured;
  });
});
