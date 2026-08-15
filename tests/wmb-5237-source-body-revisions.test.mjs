// WMB-5237（Source 正文不可变 revision 历史）聚焦测试。
// 覆盖：migration 61 建表/触发器/删除闸门、存量 cache 基线回填（含 sha256 与幂等）、
// writeSourceBodyCache 追加/幂等/失败保留、历史不可 update/delete、purge 授权窗口、
// 只读 API（latest / byId / 分页）、source 删除生命周期、旧公开 API 向后兼容。
// 运行：node --test --test-concurrency=1 tests/wmb-5237-source-body-revisions.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { upsertSource } = await import('../src/main/sources.ts');
const {
  writeSourceBodyCache,
  getSourceBodyCache,
  listSourceBodyCaches,
  backfillSourceBodyRevisionBaselines,
  purgeSourceBodyHistory,
  getLatestSourceBodyRevision,
  getSourceBodyRevision,
  listSourceBodyRevisions,
  bodyHashOf
} = await import('../src/main/source-body-cache.ts');
const { deleteKnowledgeSource } = await import('../src/main/knowledge.ts');

// ============ fixtures / helpers ============

function makeDatabase() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wmb-5237-revisions-'));
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  const now = new Date().toISOString();
  const workspaceId = `ws-${createHash('sha256').update(root).digest('hex').slice(0, 16)}`;
  database.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', ?, ?, ?, 1)")
    .run(workspaceId, now, now);
  return { database, root };
}

function seedSource(database, title = '示例资料', originalUrl = 'https://example.com/article/1') {
  return upsertSource(database, { originalUrl, title });
}

function seedRawCacheRow(database, sourceId, overrides = {}) {
  // 模拟 migration 61 之前由旧版 writeSourceBodyCache 写入的存量 cache 行。
  database.prepare(`INSERT INTO source_body_cache (
      source_id, url, status, content_type, extracted_text, extracted_chars, error_message, fetched_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sourceId,
    overrides.url ?? 'https://example.com/article/1',
    overrides.status ?? 'ready',
    overrides.contentType ?? 'text/html',
    overrides.extractedText ?? '旧版缓存正文基线。',
    overrides.extractedChars ?? (overrides.extractedText ?? '旧版缓存正文基线。').length,
    overrides.errorMessage ?? null,
    overrides.fetchedAt ?? '2026-08-01T00:00:00.000Z',
    overrides.updatedAt ?? '2026-08-01T00:00:00.000Z'
  );
}

function readyRecord(sourceId, text, url = 'https://example.com/article/1', at = '2026-08-13T08:00:00.000Z') {
  return {
    sourceId, url, status: 'ready', contentType: 'text/html', extractedText: text,
    extractedChars: text.length, errorMessage: null, fetchedAt: at, updatedAt: at
  };
}

function failedRecord(sourceId, message, url = 'https://example.com/article/1', at = '2026-08-13T09:00:00.000Z') {
  return {
    sourceId, url, status: 'failed', contentType: null, extractedText: '', extractedChars: 0,
    errorMessage: message, fetchedAt: at, updatedAt: at
  };
}

function revisionCount(database, sourceId) {
  return Number(database.prepare('SELECT COUNT(*) AS n FROM source_body_revisions WHERE source_id = ?').get(sourceId).n);
}

function allRevisions(database, sourceId) {
  return database.prepare(`
    SELECT id AS revisionId, source_id AS sourceId, url, status, body_hash AS bodyHash,
      error_message AS errorMessage, previous_revision_id AS previousRevisionId
    FROM source_body_revisions WHERE source_id = ? ORDER BY rowid
  `).all(sourceId);
}

// ============ A. migration 61：表/触发器/删除闸门 ============

test('WMB-5237 migration 61: revisions table + immutable triggers + purge gate live on migrated connection', () => {
  const { database } = makeDatabase();
  const applied = database.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version);
  assert.ok(applied.includes(61), 'migration 61 应已应用');
  const source = seedSource(database, '触发测试', 'https://example.com/t1');
  writeSourceBodyCache(database, readyRecord(source.id, '正文 A'));

  // UPDATE 永远被拒（immutable_update 触发器）。
  assert.throws(() => database.prepare('UPDATE source_body_revisions SET extracted_text = ? WHERE source_id = ?').run('篡改', source.id),
    /SOURCE_BODY_REVISION_IMMUTABLE/);
  // DELETE 在闸门关闭时被拒（immutable_delete 触发器 + 闸门 UDF 已注册，报错应为不可变而非 no such function）。
  assert.throws(() => database.prepare('DELETE FROM source_body_revisions WHERE source_id = ?').run(source.id),
    /SOURCE_BODY_REVISION_IMMUTABLE/);
  // 闸门打开时（purge 授权窗口）允许删除。
  purgeSourceBodyHistory(database, source.id);
  assert.equal(revisionCount(database, source.id), 0);
  database.close();
});

// ============ B. 存量 cache 基线回填 ============

test('WMB-5237 baseline backfill: old cache rows become traceable revisions, sha256 hash, idempotent', () => {
  const { database } = makeDatabase();
  const a = seedSource(database, '存量 A', 'https://example.com/old-a');
  const b = seedSource(database, '存量 B', 'https://example.com/old-b');
  const aText = '存量 A 正文。';
  const bText = '';
  seedRawCacheRow(database, a.id, { extractedText: aText });
  seedRawCacheRow(database, b.id, { status: 'failed', extractedText: bText, errorMessage: '旧失败' });

  const created = backfillSourceBodyRevisionBaselines(database);
  assert.equal(created, 2, '两条存量 cache 行应生成两条基线');
  assert.equal(backfillSourceBodyRevisionBaselines(database), 0, '重复回填幂等');

  const ra = allRevisions(database, a.id);
  assert.equal(ra.length, 1);
  assert.equal(ra[0].revisionId, `baseline-${a.id}`, '基线 ID 稳定且可追溯');
  assert.equal(ra[0].status, 'ready');
  assert.equal(ra[0].bodyHash, bodyHashOf(aText), '正文 sha256 正确');
  assert.equal(ra[0].previousRevisionId, null, '基线无前一 revision');

  const rb = allRevisions(database, b.id);
  assert.equal(rb.length, 1);
  assert.equal(rb[0].status, 'failed');
  assert.equal(rb[0].bodyHash, bodyHashOf(''), '空正文失败行的 hash 为 sha256("")');
  assert.equal(rb[0].errorMessage, '旧失败');

  // 存量行后续被写入时，链应接在基线上。
  const latest = getLatestSourceBodyRevision(database, a.id);
  assert.ok(latest && latest.revisionId === `baseline-${a.id}`);
  const next = writeSourceBodyCache(database, readyRecord(a.id, '新正文 A'));
  assert.ok(next);
  const chain = allRevisions(database, a.id);
  assert.equal(chain.length, 2);
  assert.equal(chain[1].previousRevisionId, `baseline-${a.id}`, '新 revision 链回基线');
  database.close();
});

// ============ C. writeSourceBodyCache：追加 / 幂等 / 链 ============

test('WMB-5237 write path: first write appends, identical body idempotent, changed body chains', () => {
  const { database } = makeDatabase();
  const source = seedSource(database, '正文链', 'https://example.com/chain');

  writeSourceBodyCache(database, readyRecord(source.id, '正文 V1', 'https://example.com/chain', '2026-08-13T08:00:00.000Z'));
  assert.equal(revisionCount(database, source.id), 1);
  const first = getLatestSourceBodyRevision(database, source.id);
  assert.ok(first && first.previousRevisionId === null);

  // 相同正文重复写入：幂等，不产生新 revision；latest 投影抓取时间刷新。
  writeSourceBodyCache(database, readyRecord(source.id, '正文 V1', 'https://example.com/chain', '2026-08-13T10:00:00.000Z'));
  assert.equal(revisionCount(database, source.id), 1, '相同正文不产生新 revision');
  const projection = getSourceBodyCache(database, source.id);
  assert.equal(projection?.fetchedAt, '2026-08-13T10:00:00.000Z', '幂等成功仍刷新 latest 投影抓取时间');
  assert.equal(getLatestSourceBodyRevision(database, source.id)?.revisionId, first.revisionId);

  // 正文变化：追加 revision 并更新 latest 投影。
  writeSourceBodyCache(database, readyRecord(source.id, '正文 V2', 'https://example.com/chain', '2026-08-13T12:00:00.000Z'));
  assert.equal(revisionCount(database, source.id), 2);
  const latest = getLatestSourceBodyRevision(database, source.id);
  assert.ok(latest);
  assert.equal(latest.extractedText, '正文 V2');
  assert.equal(latest.previousRevisionId, first.revisionId, '有序链：V2 -> V1');
  assert.equal(getSourceBodyCache(database, source.id)?.extractedText, '正文 V2');

  // URL 变化（即使正文相同）视为新身份 → 新 revision。
  writeSourceBodyCache(database, readyRecord(source.id, '正文 V2', 'https://example.com/chain-moved', '2026-08-13T13:00:00.000Z'));
  assert.equal(revisionCount(database, source.id), 3, 'url 变化产生新 revision');
  assert.equal(getLatestSourceBodyRevision(database, source.id)?.url, 'https://example.com/chain-moved');
  database.close();
});

// ============ D. failed/empty 不覆盖最后成功正文 ============

test('WMB-5237 failure handling: failed fetch never clobbers last success; failure recorded in history', () => {
  const { database } = makeDatabase();
  const source = seedSource(database, '失败保留', 'https://example.com/fail');
  writeSourceBodyCache(database, readyRecord(source.id, '成功正文', 'https://example.com/fail'));

  writeSourceBodyCache(database, failedRecord(source.id, 'HTTP 500', 'https://example.com/fail', '2026-08-13T10:00:00.000Z'));
  const projection = getSourceBodyCache(database, source.id);
  assert.equal(projection?.status, 'ready', 'failed 抓取不得覆盖最后成功正文');
  assert.equal(projection?.extractedText, '成功正文');
  assert.equal(getLatestSourceBodyRevision(database, source.id)?.extractedText, '成功正文', 'latest 成功 revision 不变');
  assert.equal(revisionCount(database, source.id), 2, '失败尝试仍记入历史（可追溯）');
  const latestRev = database.prepare(`SELECT id, status, error_message AS errorMessage, previous_revision_id AS previousRevisionId
    FROM source_body_revisions WHERE source_id = ? ORDER BY rowid DESC LIMIT 1`).get(source.id);
  assert.equal(latestRev.status, 'failed');
  assert.equal(latestRev.errorMessage, 'HTTP 500');
  assert.ok(latestRev.previousRevisionId, '失败 revision 链回上次成功');

  // 无成功基线时 failed 写入应进入投影（保持旧行为）。
  const fresh = seedSource(database, '全新失败', 'https://example.com/fail-fresh');
  writeSourceBodyCache(database, failedRecord(fresh.id, '网络错误', 'https://example.com/fail-fresh'));
  assert.equal(getSourceBodyCache(database, fresh.id)?.status, 'failed');
  assert.equal(getLatestSourceBodyRevision(database, fresh.id), null, '无成功则 latest 成功为 null');

  // empty 同理。
  const emptySrc = seedSource(database, '空页', 'https://example.com/empty');
  writeSourceBodyCache(database, readyRecord(emptySrc.id, '有正文', 'https://example.com/empty'));
  writeSourceBodyCache(database, {
    ...failedRecord(emptySrc.id, '页面没有提取到可读正文。', 'https://example.com/empty', '2026-08-13T11:00:00.000Z'),
    status: 'empty'
  });
  assert.equal(getSourceBodyCache(database, emptySrc.id)?.status, 'ready', 'empty 不覆盖成功正文');
  database.close();
});

// ============ E. 只读 API：latest / byId / 分页 ============

test('WMB-5237 read API: latest success, by id, paginated list (newest first, keyset cursor)', () => {
  const { database } = makeDatabase();
  const source = seedSource(database, '分页', 'https://example.com/page');
  const ids = [];
  for (let i = 1; i <= 5; i += 1) {
    writeSourceBodyCache(database, readyRecord(source.id, `正文 ${i}`, 'https://example.com/page', `2026-08-13T0${i}:00:00.000Z`));
    ids.push(getLatestSourceBodyRevision(database, source.id).revisionId);
  }

  // byId
  const rev = getSourceBodyRevision(database, ids[2]);
  assert.ok(rev && rev.extractedText === '正文 3' && rev.sourceId === source.id);
  assert.equal(getSourceBodyRevision(database, 'no-such-id'), null);
  // latest 成功
  assert.equal(getLatestSourceBodyRevision(database, source.id)?.revisionId, ids[4]);
  assert.equal(getLatestSourceBodyRevision(database, 'no-such-source'), null);

  // 分页：新→旧，cursor 翻页
  const page1 = listSourceBodyRevisions(database, { sourceId: source.id, limit: 2 });
  assert.deepEqual(page1.revisions.map((r) => r.revisionId), [ids[4], ids[3]]);
  assert.equal(page1.nextCursor, ids[3], '有下一页时 cursor 为末条 revisionId');
  const page2 = listSourceBodyRevisions(database, { sourceId: source.id, limit: 2, cursor: page1.nextCursor });
  assert.deepEqual(page2.revisions.map((r) => r.revisionId), [ids[2], ids[1]]);
  assert.equal(page2.nextCursor, ids[1]);
  const page3 = listSourceBodyRevisions(database, { sourceId: source.id, limit: 2, cursor: page2.nextCursor });
  assert.deepEqual(page3.revisions.map((r) => r.revisionId), [ids[0]]);
  assert.equal(page3.nextCursor, null, '末页无 cursor');
  // limit 钳制
  assert.ok(listSourceBodyRevisions(database, { sourceId: source.id, limit: 0 }).revisions.length >= 1);
  assert.equal(listSourceBodyRevisions(database, { sourceId: 'no-such-source' }).revisions.length, 0);
  database.close();
});

// ============ F. purge 授权窗口 + source 删除生命周期 ============

test('WMB-5237 lifecycle: purgeSourceBodyHistory is the only delete gate; deleteKnowledgeSource purges cleanly', () => {
  const { database } = makeDatabase();
  const source = seedSource(database, '删除生命周期', 'https://example.com/del');
  writeSourceBodyCache(database, readyRecord(source.id, '要删除的正文', 'https://example.com/del'));

  // 闸门关闭：任何直接 DELETE 被拒（含跨 source）。
  assert.throws(() => database.prepare('DELETE FROM source_body_revisions WHERE source_id = ?').run(source.id),
    /SOURCE_BODY_REVISION_IMMUTABLE/);

  // purge 授权窗口：允许删除。
  purgeSourceBodyHistory(database, source.id);
  assert.equal(revisionCount(database, source.id), 0);

  // 端到端：deleteKnowledgeSource 应清空 revision 历史 + 投影 + source，且不因 FK cascade 触发 DELETE 守卫。
  writeSourceBodyCache(database, readyRecord(source.id, '删除后再写', 'https://example.com/del'));
  assert.equal(revisionCount(database, source.id), 1);
  const deleted = deleteKnowledgeSource(database, { id: source.id, expectedRevision: source.revision }, true, false);
  assert.equal(deleted.deleted, true);
  assert.equal(revisionCount(database, source.id), 0);
  assert.equal(getSourceBodyCache(database, source.id), null);
  assert.equal(getLatestSourceBodyRevision(database, source.id), null);
  database.close();
});

// ============ G. 旧公开 API 向后兼容 ============

test('WMB-5237 compat: get/list body cache still expose latest projection with legacy shape', () => {
  const { database } = makeDatabase();
  const a = seedSource(database, '兼容 A', 'https://example.com/ca');
  const b = seedSource(database, '兼容 B', 'https://example.com/cb');
  writeSourceBodyCache(database, readyRecord(a.id, 'A 正文'));
  writeSourceBodyCache(database, readyRecord(b.id, 'B 正文'));
  const one = getSourceBodyCache(database, a.id);
  assert.equal(one?.sourceId, a.id);
  assert.equal(one?.extractedText, 'A 正文');
  assert.ok('updatedAt' in one && 'fetchedAt' in one && 'status' in one, 'legacy 字段完整');
  const many = listSourceBodyCaches(database, [b.id, a.id, b.id]);
  assert.deepEqual(many.map((r) => r.sourceId), [b.id, a.id], '去重且按传入顺序');
  database.close();
});
