// WMB-5237 图片调整全链路 —— 媒体绑定数据合同 + renderer 绑定合同聚焦测试。
// 覆盖（共享合同）：
// - migration 62（content_media_bindings / platform_media_bindings / asset_provenance）与
//   run hook 存量回填（body token → 核心绑定；asset_ids_json → 平台绑定，X 首图 is_cover）；
// - saveCoreVersion 追加版本 + 原子写绑定；无 drafts 时按 body 引用默认对账；
//   width/align/caption 绝不进入正文 token；revision 冲突零写入；
// - savePlatformVersion 绑定/裁剪载荷原子物化（stagedCrops → 派生 asset + provenance +
//   绑定 + asset_ids_json 同事务重建）；revision 冲突零写入；
// - 共享校验（isValidCropRegion / normalize* / buildAssetIdsFromPlatformBindings / contentBindingKey）；
// - materializeCropAsset：原图保留、血缘可溯、sha256 去重复用、无效输入拒绝且零写；
// - renderer：单一 parser（helpers 与共享 media-token 行为一致）、布局草稿纯函数
//   （updateContentMediaBinding / contentMediaLayoutMap，key = assetId:occurrence，布局只改 draft）、
//   工具条导出常量与只读/aria 结构（esbuild 打包 + react-dom/server 渲染；非可执行 DOM 结构
//   沿用既有 esbuild harness 结构断言模式）。
// 数据测试全部使用真实 SQLite（migrateDatabase）+ production 函数，不做源码字符串断言。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import {
  createContentProjectWithVersion,
  getContentProject,
  saveCoreVersion,
  savePlatformVersion
} from '../src/main/content.ts';
import { getAsset, importAssetBytes, stageAssetBytes } from '../src/main/assets.ts';
import { materializeCropAsset } from '../src/main/media-bindings.ts';
import {
  buildAssetIdsFromPlatformBindings,
  contentBindingKey,
  isValidCropRegion,
  normalizeContentMediaBindings,
  normalizePlatformMediaBindings
} from '../src/shared/media-bindings.ts';
import * as sharedToken from '../src/shared/media-token.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

// 三个互异的 1x1 PNG 字节（无解码需求；仅用于 sha256 去重与相对路径断言）。
const PNG_RED = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const PNG_BLUE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);
const PNG_GREEN = Buffer.concat([PNG_BLUE, Buffer.from([1])]);

const shaOf = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** 读取真实 PNG 的 IHDR 像素尺寸（大端 4 字节，偏移 16/20），fixture 自校验用。 */
function pngPixels(bytes) {
  if (bytes.length < 24 || bytes.readUInt32BE(12) !== 0x49484452) throw new Error('fixture 不是合法 PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function withDb(run) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'wmb-5237-media-'));
  const database = migrateDatabase(path.join(rootDir, 'wmb.db'));
  try {
    await run(database, rootDir);
  } finally {
    database.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

function makeProject(database, body, mediaBindings) {
  return createContentProjectWithVersion(database, {
    title: '媒体绑定测试项目',
    body,
    ...(mediaBindings ? { mediaBindings } : {})
  });
}

async function addAsset(database, dataRoot, bytes, fileName = 'img.png') {
  const result = await importAssetBytes(database, dataRoot, {
    bytes,
    fileName,
    mimeType: 'image/png',
    origin: 'test'
  });
  return result.id;
}

const tokenBody = (a, b) => `开头\n\n![图A](wmb-asset://${a})\n\n![图B](wmb-asset://${b})\n\n结尾`;

// ---------------------------------------------------------------------------
// migration 62：三张绑定/血缘表 + run hook 存量回填
// ---------------------------------------------------------------------------

test('WMB-5237 media: migration 62 creates binding tables, provenance table and is idempotent', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'wmb-5237-media-migrate-'));
  const dbPath = path.join(rootDir, 'wmb.db');
  const database = migrateDatabase(dbPath);
  try {
    const names = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('content_media_bindings', 'platform_media_bindings', 'asset_provenance')")
      .all()
      .map((row) => row.name)
      .sort();
    assert.deepEqual(names, ['asset_provenance', 'content_media_bindings', 'platform_media_bindings']);
    assert.ok(database.prepare('SELECT version FROM schema_migrations WHERE version = 62').get(), 'migration 62 must be recorded');
    // 幂等：已应用 62 后重新 migrate 同一库，不重复建表、不重复回填。
    const contentBindings = Number(database.prepare('SELECT COUNT(*) AS count FROM content_media_bindings').get().count);
    database.close();
    const reopened = migrateDatabase(dbPath);
    try {
      const reApplied = reopened.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 62').get().count;
      assert.equal(reApplied, 1);
      assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM content_media_bindings').get().count, contentBindings);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

/** 构造 pre-62 旧库（schema_migrations 1..61 已应用 + 迁移 62 所需的最小旧 schema）。 */
function createLegacyDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const markRows = Array.from({ length: 61 }, (_, i) => `(${i + 1}, '2026-01-01T00:00:00.000Z')`).join(',');
  db.exec(`INSERT INTO schema_migrations (version, applied_at) VALUES ${markRows}`);
  db.exec(`
    CREATE TABLE content_projects (
      id TEXT PRIMARY KEY, topic_id TEXT, plan_item_id TEXT, title TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'drafting', archived_at TEXT
    );
    CREATE TABLE content_versions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES content_projects(id),
      body TEXT NOT NULL, version_number INTEGER NOT NULL, created_at TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT 'ai', UNIQUE (project_id, version_number)
    );
    CREATE TABLE platform_versions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES content_projects(id),
      content_version_id TEXT NOT NULL REFERENCES content_versions(id),
      platform TEXT NOT NULL CHECK (platform IN ('x', 'xiaohongshu', 'wechat')),
      format TEXT NOT NULL, title TEXT, body TEXT NOT NULL, asset_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL
    );
    CREATE TABLE assets (
      id TEXT PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE, mime_type TEXT NOT NULL,
      byte_count INTEGER NOT NULL, sha256 TEXT NOT NULL UNIQUE, origin TEXT NOT NULL,
      width INTEGER, height INTEGER, duration_ms INTEGER,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL
    );
    -- WMB-5245/5246 新增迁移（64-69）会在本旧库上继续执行；migration 69 对
    -- knowledge_visual_runs 做 ADD COLUMN，fixture 需提供该表（最小结构即可，回填语义不受影响）。
    -- WMB-5249（migration 70）以「建新→复制→删旧→改名」重建 platform_versions/
    -- platform_accounts/publications/publication_snapshots/studio_annotations，fixture 需提供
    -- 这些源表的最小结构（空表：INSERT..SELECT 零行复制，回填语义不受影响）。
    CREATE TABLE knowledge_visual_runs (id TEXT PRIMARY KEY);
    CREATE TABLE workspace_browser_bindings (id TEXT PRIMARY KEY CHECK (id = 'effective'));
    CREATE TABLE platform_accounts (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL CHECK (platform IN ('x', 'xiaohongshu', 'wechat')) UNIQUE,
      account_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      login_state TEXT NOT NULL CHECK (login_state IN ('authenticated', 'unauthenticated', 'challenge', 'unknown')),
      evidence_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL,
      browser_profile_id TEXT,
      browser_binding_revision INTEGER,
      verified_at TEXT
    );
    CREATE TABLE publications (
      id TEXT PRIMARY KEY,
      platform_version_id TEXT NOT NULL REFERENCES platform_versions(id),
      platform_version_revision INTEGER NOT NULL,
      platform TEXT NOT NULL CHECK (platform IN ('x', 'xiaohongshu', 'wechat')),
      account_id TEXT NOT NULL REFERENCES platform_accounts(id),
      account_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft', 'prepared', 'awaiting_confirmation', 'publishing', 'published', 'failed', 'needs_user', 'unknown')),
      prepared_title TEXT,
      prepared_body TEXT,
      prepared_assets_json TEXT NOT NULL,
      prepared_evidence_url TEXT,
      external_url TEXT,
      external_id TEXT,
      published_at TEXT,
      last_error_code TEXT,
      last_error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL
    );
    CREATE TABLE publication_snapshots (
      id TEXT PRIMARY KEY,
      publication_id TEXT NOT NULL UNIQUE REFERENCES publications(id),
      workspace_id TEXT NOT NULL,
      runtime_epoch TEXT NOT NULL,
      platform_version_id TEXT NOT NULL REFERENCES platform_versions(id),
      platform_version_revision INTEGER NOT NULL CHECK (platform_version_revision >= 1),
      platform TEXT NOT NULL CHECK (platform IN ('x', 'xiaohongshu', 'wechat')),
      account_id TEXT NOT NULL REFERENCES platform_accounts(id),
      account_key TEXT NOT NULL,
      account_revision INTEGER NOT NULL CHECK (account_revision >= 1),
      browser_binding_id TEXT NOT NULL CHECK (browser_binding_id = 'effective') REFERENCES workspace_browser_bindings(id),
      browser_profile_id TEXT NOT NULL,
      browser_binding_revision INTEGER NOT NULL CHECK (browser_binding_revision >= 1),
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
      assets_json TEXT NOT NULL,
      assets_hash TEXT NOT NULL CHECK (length(assets_hash) = 64),
      input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
      causation_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE studio_annotations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES content_projects(id) ON DELETE CASCADE,
      document_kind TEXT NOT NULL CHECK (document_kind IN ('core', 'platform')),
      document_id TEXT,
      platform TEXT CHECK (platform IN ('x', 'xiaohongshu', 'wechat')),
      start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
      end_offset INTEGER NOT NULL CHECK (end_offset >= 0),
      quoted_text TEXT NOT NULL,
      prefix_context TEXT NOT NULL DEFAULT '',
      suffix_context TEXT NOT NULL DEFAULT '',
      body_fingerprint TEXT NOT NULL,
      note TEXT,
      status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
      resolved_reason TEXT CHECK (resolved_reason IN ('edited', 'deleted', 'ambiguous', 'user_removed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      CHECK (start_offset < end_offset),
      CHECK (
        (document_kind = 'core' AND platform IS NULL)
        OR (document_kind = 'platform' AND platform IS NOT NULL AND document_id IS NOT NULL)
      )
    );
  `);
  return db;
}

test('WMB-5237 media: migration 62 run hook backfills legacy core tokens and platform assetIds (X first image cover)', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'wmb-5237-media-backfill-'));
  const dbPath = path.join(rootDir, 'wmb.db');
  const now = '2026-01-01T00:00:00.000Z';
  const legacy = createLegacyDatabase(dbPath);
  try {
    const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
    legacy.exec(`
      INSERT INTO assets (id, relative_path, mime_type, byte_count, sha256, origin, width, height, duration_ms, created_at, updated_at, revision)
        VALUES ('asset-1', 'assets/a.png', 'image/png', 10, 'sha-1', 'legacy', NULL, NULL, NULL, ${q(now)}, ${q(now)}, 1);
      INSERT INTO assets (id, relative_path, mime_type, byte_count, sha256, origin, width, height, duration_ms, created_at, updated_at, revision)
        VALUES ('asset-2', 'assets/b.png', 'image/png', 20, 'sha-2', 'legacy', NULL, NULL, NULL, ${q(now)}, ${q(now)}, 1);
      INSERT INTO content_projects (id, title, created_at, updated_at, revision) VALUES ('proj-1', '旧项目', ${q(now)}, ${q(now)}, 1);
      INSERT INTO content_versions (id, project_id, body, version_number, created_at) VALUES ('ver-1', 'proj-1', '第一段\n\n![图甲](wmb-asset://asset-1)\n\n文字 ![图乙](wmb-asset://asset-2) 后文', 1, ${q(now)});
      INSERT INTO platform_versions (id, project_id, content_version_id, platform, format, title, body, asset_ids_json, created_at, updated_at, revision)
        VALUES ('pv-1', 'proj-1', 'ver-1', 'x', 'image', NULL, '平台正文', ${q(JSON.stringify(['asset-2', 'asset-1']))}, ${q(now)}, ${q(now)}, 1);
      INSERT INTO platform_versions (id, project_id, content_version_id, platform, format, title, body, asset_ids_json, created_at, updated_at, revision)
        VALUES ('pv-2', 'proj-1', 'ver-1', 'xiaohongshu', 'image', NULL, '小红书正文', ${q(JSON.stringify(['asset-1']))}, ${q(now)}, ${q(now)}, 1);
    `);
    legacy.close();

    // 升级：仅应用尚未应用的 migration 62，run hook 在迁移事务内回填。
    const database = migrateDatabase(dbPath);
    try {
      const coreRows = database.prepare(
        `SELECT asset_id AS assetId, occurrence, ordinal, width_preset AS widthPreset, align, caption
         FROM content_media_bindings WHERE content_version_id = ? ORDER BY ordinal ASC`
      ).all('ver-1');
      assert.equal(coreRows.length, 2);
      assert.equal(coreRows[0].assetId, 'asset-1');
      assert.equal(coreRows[0].occurrence, 0);
      assert.equal(coreRows[0].ordinal, 0);
      assert.equal(coreRows[0].widthPreset, 'full');
      assert.equal(coreRows[0].align, 'center');
      assert.equal(coreRows[0].caption, '图甲');
      assert.equal(coreRows[1].assetId, 'asset-2');
      assert.equal(coreRows[1].ordinal, 1);
      assert.equal(coreRows[1].caption, '图乙');

      const xRows = database.prepare(
        `SELECT asset_id AS assetId, ordinal, is_cover AS isCover FROM platform_media_bindings WHERE platform_version_id = ? ORDER BY ordinal ASC`
      ).all('pv-1');
      assert.deepEqual(xRows.map((row) => row.assetId), ['asset-2', 'asset-1']);
      assert.deepEqual(xRows.map((row) => row.isCover), [1, 0], 'X 首图必须回填为封面');
      const xhsRows = database.prepare(
        `SELECT asset_id AS assetId, is_cover AS isCover FROM platform_media_bindings WHERE platform_version_id = ?`
      ).all('pv-2');
      assert.deepEqual(xhsRows.map((row) => row.assetId), ['asset-1']);
      assert.deepEqual(xhsRows.map((row) => row.isCover), [0], '小红书缺省回填不设封面');

      // 回填引用不存在 asset 的 token 不产生绑定（FK 侧过滤）。
      const missing = database.prepare('SELECT COUNT(*) AS count FROM content_media_bindings WHERE asset_id = ?').get('ghost');
      assert.equal(missing.count, 0);
    } finally {
      database.close();
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

// ---------------------------------------------------------------------------
// saveCoreVersion：追加版本 + 原子绑定；布局绝不进入正文 token
// ---------------------------------------------------------------------------

test('WMB-5237 media: core save appends version, writes bindings atomically and never alters the body token', async () => {
  await withDb(async (database, dataRoot) => {
    const a = await addAsset(database, dataRoot, PNG_RED);
    const b = await addAsset(database, dataRoot, PNG_BLUE);
    const project = makeProject(database, '版本一');
    const body = tokenBody(a, b);
    const saved = saveCoreVersion(database, {
      projectId: project.id,
      body,
      expectedRevision: 1,
      mediaBindings: [
        { assetId: a, occurrence: 0, widthPreset: 'small', align: 'left', caption: '新图注', linkUrl: 'https://example.com' },
        { assetId: b, occurrence: 0, widthPreset: 'full', align: 'right' }
      ]
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.data.versionNumber, 2);
    assert.equal(saved.data.projectRevision, 2);

    const rawBody = database.prepare('SELECT body FROM content_versions WHERE id = ?').get(saved.data.id).body;
    assert.equal(rawBody, body, '正文必须逐字节不变：width/align/caption 只进绑定');

    const detail = getContentProject(database, project.id);
    const version = detail.revisions.find((item) => item.number === 2);
    assert.equal(version.bindings.length, 2);
    const byKey = new Map(version.bindings.map((binding) => [contentBindingKey(binding.assetId, binding.occurrence), binding]));
    const ka = byKey.get(contentBindingKey(a, 0));
    assert.equal(ka.widthPreset, 'small');
    assert.equal(ka.align, 'left');
    assert.equal(ka.caption, '新图注');
    assert.equal(ka.linkUrl, 'https://example.com');
    assert.equal(ka.contentVersionId, saved.data.id, '读模型必须携带版本归属');
    const kb = byKey.get(contentBindingKey(b, 0));
    assert.equal(kb.widthPreset, 'full');
    assert.equal(kb.align, 'right');
    assert.equal(version.bindings[0].ordinal, 0);

    // 布局字段绝不进入 token 文本（共享 parser 同样看不到）。
    assert.ok(!rawBody.includes('small') && !rawBody.includes('right') && !rawBody.includes('新图注'));
    assert.equal(sharedToken.parseAssetImages(rawBody).length, 2);
  });
});

test('WMB-5237 media: core save without drafts reconciles default bindings from body refs (backfill on save)', async () => {
  await withDb(async (database, dataRoot) => {
    const a = await addAsset(database, dataRoot, PNG_RED);
    const b = await addAsset(database, dataRoot, PNG_BLUE);
    const project = makeProject(database, '版本一');
    const saved = saveCoreVersion(database, {
      projectId: project.id,
      body: tokenBody(a, b),
      expectedRevision: 1
    });
    assert.equal(saved.ok, true);
    const detail = getContentProject(database, project.id);
    const version = detail.revisions.find((item) => item.number === 2);
    assert.equal(version.bindings.length, 2);
    for (const binding of version.bindings) {
      assert.equal(binding.widthPreset, 'full');
      assert.equal(binding.align, 'center');
      assert.ok(binding.id && binding.contentVersionId === version.id);
    }
    const aBinding = version.bindings.find((binding) => binding.assetId === a);
    assert.equal(aBinding.caption, '图A', '缺省图注取正文 alt');
  });
});

test('WMB-5237 media: core save revision conflict writes nothing (version, binding, revision all untouched)', async () => {
  await withDb(async (database, dataRoot) => {
    const a = await addAsset(database, dataRoot, PNG_RED);
    const project = makeProject(database, 'v1');
    const first = saveCoreVersion(database, { projectId: project.id, body: '第二次保存', expectedRevision: 1 });
    assert.equal(first.ok, true);
    const before = getContentProject(database, project.id);

    const stale = saveCoreVersion(database, {
      projectId: project.id,
      body: '冲突正文',
      expectedRevision: 1,
      mediaBindings: [{ assetId: a, occurrence: 0, widthPreset: 'medium', align: 'center' }]
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, 'REVISION_CONFLICT');

    const versionCount = database.prepare('SELECT COUNT(*) AS count FROM content_versions WHERE project_id = ?').get(project.id).count;
    assert.equal(versionCount, 2, '冲突不得追加版本');
    const bindingCount = database.prepare(
      `SELECT COUNT(*) AS count FROM content_media_bindings WHERE content_version_id IN (SELECT id FROM content_versions WHERE project_id = ?)`
    ).get(project.id).count;
    assert.equal(bindingCount, 0, '冲突即使携带 mediaBindings 也零绑定写入');
    assert.equal(getContentProject(database, project.id).revision, before.revision);
  });
});

test('WMB-5237 media: core save rejects invalid binding drafts fail-closed with full rollback', async () => {
  await withDb(async (database, dataRoot) => {
    const a = await addAsset(database, dataRoot, PNG_RED);
    const project = makeProject(database, 'v1');
    assert.throws(
      () => saveCoreVersion(database, {
        projectId: project.id,
        body: `![图A](wmb-asset://${a})`,
        expectedRevision: 1,
        mediaBindings: [{ assetId: a, occurrence: 0, widthPreset: 'huge', align: 'center' }]
      }),
      /widthPreset 无效/
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM content_versions WHERE project_id = ?').get(project.id).count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM content_media_bindings').get().count, 0);
    assert.equal(getContentProject(database, project.id).revision, 1);
  });
});

// ---------------------------------------------------------------------------
// savePlatformVersion：绑定替换 + asset_ids_json 投影重建 + 裁剪载荷原子物化
// ---------------------------------------------------------------------------

test('WMB-5237 media: platform save writes bindings and rebuilds asset_ids_json by ordinal (derivedAssetId || assetId)', async () => {
  await withDb(async (database, dataRoot) => {
    const a = await addAsset(database, dataRoot, PNG_RED);
    const b = await addAsset(database, dataRoot, PNG_BLUE);
    const project = makeProject(database, 'v1');
    const pv = savePlatformVersion(database, {
      projectId: project.id,
      contentVersionId: project.contentVersionId,
      platform: 'xiaohongshu',
      format: 'image',
      body: '平台正文',
      mediaBindings: [
        { assetId: b, ordinal: 1 },
        { assetId: a, ordinal: 0, isCover: true, caption: '封面注' }
      ]
    });
    assert.equal(pv.ok, true);
    const row = database.prepare('SELECT asset_ids_json AS assets FROM platform_versions WHERE id = ?').get(pv.data.id);
    assert.deepEqual(JSON.parse(row.assets), [a, b], 'asset_ids_json 按 ordinal 重建');

    const detail = getContentProject(database, project.id);
    const version = detail.platformVersions.xiaohongshu[0];
    assert.deepEqual(version.assets, [a, b]);
    assert.equal(version.mediaBindings.length, 2);
    assert.equal(version.mediaBindings[0].assetId, a);
    assert.equal(version.mediaBindings[0].ordinal, 0);
    assert.equal(version.mediaBindings[0].isCover, true);
    assert.equal(version.mediaBindings[0].caption, '封面注');
    assert.equal(version.mediaBindings[1].assetId, b);
    assert.equal(version.mediaBindings[1].ordinal, 1);
    assert.equal(version.mediaBindings[1].isCover, false);
  });
});

test('WMB-5237 media: platform save without mediaBindings rebuilds from assetIds and update never clears existing cover/crop', async () => {
  await withDb(async (database, dataRoot) => {
    const a = await addAsset(database, dataRoot, PNG_RED);
    const b = await addAsset(database, dataRoot, PNG_BLUE);
    const project = makeProject(database, 'v1');
    const created = savePlatformVersion(database, {
      projectId: project.id,
      contentVersionId: project.contentVersionId,
      platform: 'x',
      format: 'image',
      body: 'x 正文 v1',
      assetIds: [a, b]
    });
    assert.equal(created.ok, true);
    let version = getContentProject(database, project.id).platformVersions.x[0];
    assert.deepEqual(version.mediaBindings.map((binding) => binding.assetId), [a, b]);
    assert.equal(version.mediaBindings[0].isCover, true, 'X 平台首图缺省即封面');

    // 更新不携带 mediaBindings：绑定按 assetIds 重建且保留已有 cover（绝不静默清空）。
    const updated = savePlatformVersion(database, {
      id: created.data.id,
      expectedRevision: 1,
      projectId: project.id,
      contentVersionId: project.contentVersionId,
      platform: 'x',
      format: 'image',
      body: 'x 正文 v2',
      assetIds: [a, b]
    });
    assert.equal(updated.ok, true);
    version = getContentProject(database, project.id).platformVersions.x[0];
    assert.deepEqual(version.mediaBindings.map((binding) => binding.assetId), [a, b]);
    assert.deepEqual(version.mediaBindings.map((binding) => binding.isCover), [true, false]);
    assert.equal(version.mediaBindings.length, 2);
  });
});

test('WMB-5237 media: platform binding with derivedAssetId projects into asset_ids_json and read model', async () => {
  await withDb(async (database, dataRoot) => {
    const a = await addAsset(database, dataRoot, PNG_RED);
    const derived = await materializeCropAsset(database, dataRoot, {
      sourceAssetId: a,
      cropRegion: { x: 0, y: 0, width: 0.5, height: 0.5 },
      bytes: PNG_BLUE,
      origin: 'test'
    });
    const project = makeProject(database, 'v1');
    const pv = savePlatformVersion(database, {
      projectId: project.id,
      contentVersionId: project.contentVersionId,
      platform: 'xiaohongshu',
      format: 'image',
      body: '平台正文',
      mediaBindings: [{ assetId: a, ordinal: 0, derivedAssetId: derived.assetId, cropRegion: { x: 0, y: 0, width: 0.5, height: 0.5 } }]
    });
    assert.equal(pv.ok, true);
    const row = database.prepare('SELECT asset_ids_json AS assets FROM platform_versions WHERE id = ?').get(pv.data.id);
    assert.deepEqual(JSON.parse(row.assets), [derived.assetId], '有效 derivedAssetId 优先于 assetId');
    const version = getContentProject(database, project.id).platformVersions.xiaohongshu[0];
    assert.deepEqual(version.assets, [derived.assetId]);
    assert.equal(version.mediaBindings[0].derivedAssetId, derived.assetId);
    assert.deepEqual(version.mediaBindings[0].cropRegion, { x: 0, y: 0, width: 0.5, height: 0.5 });
  });
});

test('WMB-5237 media: platform save with crop payloads atomically materializes derived asset, provenance, binding and projection', async () => {
  await withDb(async (database, dataRoot) => {
    const a = await addAsset(database, dataRoot, PNG_RED);
    const cropRegion = { x: 0.1, y: 0.2, width: 0.5, height: 0.6 };
    const cropPixels = pngPixels(PNG_BLUE);
    const staged = await stageAssetBytes(dataRoot, {
      bytes: PNG_BLUE,
      fileName: 'crop.png',
      mimeType: 'image/png',
      origin: 'test',
      width: cropPixels.width,
      height: cropPixels.height
    });
    const project = makeProject(database, 'v1');
    const pv = savePlatformVersion(database, {
      projectId: project.id,
      contentVersionId: project.contentVersionId,
      platform: 'xiaohongshu',
      format: 'image',
      body: '平台正文',
      mediaBindings: [{ assetId: a, ordinal: 0, cropRegion, caption: '裁剪图' }],
      stagedCrops: [{ sourceAssetId: a, cropRegion, staged }],
      transaction: true
    });
    assert.equal(pv.ok, true);
    const row = database.prepare('SELECT asset_ids_json AS assets FROM platform_versions WHERE id = ?').get(pv.data.id);
    const ids = JSON.parse(row.assets);
    assert.equal(ids.length, 1);
    const derivedId = ids[0];
    assert.notEqual(derivedId, a);

    const version = getContentProject(database, project.id).platformVersions.xiaohongshu[0];
    assert.deepEqual(version.assets, [derivedId], '发布投影使用派生 asset id');
    assert.equal(version.mediaBindings[0].derivedAssetId, derivedId);
    assert.deepEqual(version.mediaBindings[0].cropRegion, cropRegion);

    // 血缘：derived_crop provenance 指向源 asset，transform_json 记录裁剪参数。
    const prov = database.prepare(
      `SELECT kind, asset_id AS assetId, source_asset_id AS sourceAssetId, derived_asset_id AS derivedAssetId,
              origin, transform_json AS transformJson
       FROM asset_provenance WHERE kind = 'derived_crop'`
    ).get();
    assert.ok(prov);
    assert.equal(prov.sourceAssetId, a);
    assert.equal(prov.assetId, derivedId);
    assert.equal(prov.derivedAssetId, derivedId);
    const transform = JSON.parse(prov.transformJson);
    assert.deepEqual(transform.cropRegion, cropRegion);
    assert.equal(transform.width, cropPixels.width, 'transform_json.width 取真实像素宽');
    assert.equal(transform.height, cropPixels.height, 'transform_json.height 取真实像素高');

    // 原图保留：源 asset 行内容未被改动。
    const source = getAsset(database, a);
    assert.equal(source.sha256, shaOf(PNG_RED));
    assert.equal(source.byteCount, PNG_RED.byteLength);
  });
});

test('WMB-5237 media: platform save revision conflict with crop payload writes nothing', async () => {
  await withDb(async (database, dataRoot) => {
    const a = await addAsset(database, dataRoot, PNG_RED);
    const project = makeProject(database, 'v1');
    const created = savePlatformVersion(database, {
      projectId: project.id,
      contentVersionId: project.contentVersionId,
      platform: 'xiaohongshu',
      format: 'image',
      body: 'v1',
      assetIds: [a]
    });
    assert.equal(created.ok, true);
    const cropPixels = pngPixels(PNG_BLUE);
    const staged = await stageAssetBytes(dataRoot, {
      bytes: PNG_BLUE,
      fileName: 'crop.png',
      mimeType: 'image/png',
      origin: 'test',
      width: cropPixels.width,
      height: cropPixels.height
    });
    const stale = savePlatformVersion(database, {
      id: created.data.id,
      expectedRevision: 2,
      projectId: project.id,
      contentVersionId: project.contentVersionId,
      platform: 'xiaohongshu',
      format: 'image',
      body: 'v2',
      mediaBindings: [{ assetId: a, ordinal: 0, cropRegion: { x: 0, y: 0, width: 0.5, height: 0.5 } }],
      stagedCrops: [{ sourceAssetId: a, cropRegion: { x: 0, y: 0, width: 0.5, height: 0.5 }, staged }],
      transaction: true
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, 'REVISION_CONFLICT');

    // 原子性：无派生 asset、无 provenance、绑定/投影/版本均未变。
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 1);
    // imported 血缘来自 addAsset 生产导入路径；冲突保存不得新增任何 provenance（含 derived_crop）。
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM asset_provenance WHERE kind = 'derived_crop'").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM asset_provenance WHERE kind = 'imported'").get().count, 1);
    const version = getContentProject(database, project.id).platformVersions.xiaohongshu[0];
    assert.deepEqual(version.assets, [a]);
    assert.equal(version.mediaBindings.length, 1);
    assert.equal(version.mediaBindings[0].derivedAssetId, null);
    assert.equal(database.prepare('SELECT revision FROM platform_versions WHERE id = ?').get(created.data.id).revision, 1);
  });
});

test('WMB-5237 media: platform save rejects two covers atomically and X cover must sit at ordinal 0', async () => {
  await withDb(async (database, dataRoot) => {
    const a = await addAsset(database, dataRoot, PNG_RED);
    const b = await addAsset(database, dataRoot, PNG_BLUE);
    const project = makeProject(database, 'v1');

    // 双封面：部分唯一索引拒绝，整个保存事务回滚。
    assert.throws(() => savePlatformVersion(database, {
      projectId: project.id,
      contentVersionId: project.contentVersionId,
      platform: 'xiaohongshu',
      format: 'image',
      body: '双封面',
      mediaBindings: [
        { assetId: a, ordinal: 0, isCover: true },
        { assetId: b, ordinal: 1, isCover: true }
      ],
      transaction: true
    }), /UNIQUE/i);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM platform_versions WHERE project_id = ?').get(project.id).count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM platform_media_bindings').get().count, 0);

    // X 平台封面非首图：发布前 fail-closed。
    assert.throws(() => savePlatformVersion(database, {
      projectId: project.id,
      contentVersionId: project.contentVersionId,
      platform: 'x',
      format: 'image',
      body: 'X 封面错位',
      mediaBindings: [
        { assetId: a, ordinal: 0 },
        { assetId: b, ordinal: 1, isCover: true }
      ],
      transaction: true
    }), /X 平台封面必须位于第一张图/);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM platform_versions WHERE project_id = ?').get(project.id).count, 0);
  });
});

// ---------------------------------------------------------------------------
// 共享校验：CropRegion / normalize* / buildAssetIds / contentBindingKey
// ---------------------------------------------------------------------------

test('WMB-5237 media: isValidCropRegion enforces 0..1 bounds, positive size and x+width/y+height <= 1', () => {
  assert.equal(isValidCropRegion({ x: 0, y: 0, width: 1, height: 1 }), true);
  assert.equal(isValidCropRegion({ x: 0.5, y: 0.25, width: 0.5, height: 0.75 }), true);
  assert.equal(isValidCropRegion({ x: 0.1, y: 0.1, width: 0.2, height: 0.3 }), true);
  assert.equal(isValidCropRegion(null), false);
  assert.equal(isValidCropRegion(undefined), false);
  assert.equal(isValidCropRegion({}), false);
  assert.equal(isValidCropRegion({ x: 0, y: 0, width: 0, height: 1 }), false, 'width 必须 > 0');
  assert.equal(isValidCropRegion({ x: 0, y: 0, width: 1, height: 0 }), false, 'height 必须 > 0');
  assert.equal(isValidCropRegion({ x: -0.1, y: 0, width: 0.5, height: 0.5 }), false);
  assert.equal(isValidCropRegion({ x: 0, y: -0.1, width: 0.5, height: 0.5 }), false);
  assert.equal(isValidCropRegion({ x: 0.6, y: 0, width: 0.5, height: 0.5 }), false, 'x+width 必须 <= 1');
  assert.equal(isValidCropRegion({ x: 0, y: 0.6, width: 0.5, height: 0.5 }), false, 'y+height 必须 <= 1');
  assert.equal(isValidCropRegion({ x: NaN, y: 0, width: 0.5, height: 0.5 }), false);
  assert.equal(isValidCropRegion({ x: 0, y: 0, width: Infinity, height: 0.5 }), false);
});

test('WMB-5237 media: shared normalizers validate drafts and rebuild asset ids by ordinal', () => {
  // 核心绑定：非法 widthPreset / 负 occurrence / 重复 key fail-closed。
  assert.throws(() => normalizeContentMediaBindings([{ assetId: 'a', occurrence: 0, widthPreset: 'huge', align: 'left' }]), /widthPreset 无效/);
  assert.throws(() => normalizeContentMediaBindings([{ assetId: 'a', occurrence: -1, widthPreset: 'full', align: 'left' }]), /occurrence/);
  assert.throws(() => normalizeContentMediaBindings([
    { assetId: 'a', occurrence: 0, widthPreset: 'full', align: 'left' },
    { assetId: 'a', occurrence: 0, widthPreset: 'small', align: 'right' }
  ]), /重复/);
  assert.throws(() => normalizeContentMediaBindings([{ occurrence: 0, widthPreset: 'full', align: 'left' }]), /assetId/);
  assert.deepEqual(normalizeContentMediaBindings(null), []);
  const normalized = normalizeContentMediaBindings([{ assetId: 'a', occurrence: 2, widthPreset: 'full', align: 'center', caption: 7, linkUrl: null }]);
  assert.equal(normalized[0].caption, '7', 'caption 归一化为字符串');

  // 平台绑定：ordinal 重排为连续 0..n-1；assetId 重复 / 无效 cropRegion 拒绝。
  const reordered = normalizePlatformMediaBindings([
    { assetId: 'b', ordinal: 1 },
    { assetId: 'a', ordinal: 0, isCover: true }
  ]);
  assert.deepEqual(reordered.map((binding) => [binding.assetId, binding.ordinal]), [['a', 0], ['b', 1]]);
  assert.equal(reordered[0].isCover, true);
  assert.throws(() => normalizePlatformMediaBindings([
    { assetId: 'a', ordinal: 0 },
    { assetId: 'a', ordinal: 1 }
  ]), /重复/);
  assert.throws(() => normalizePlatformMediaBindings([
    { assetId: 'a', ordinal: 0, cropRegion: { x: 0.9, y: 0, width: 0.5, height: 0.5 } }
  ]), /cropRegion 无效/);

  // asset_ids_json 重建：有效 derivedAssetId || assetId，按 ordinal 升序。
  assert.deepEqual(buildAssetIdsFromPlatformBindings([
    { ordinal: 1, assetId: 'a', derivedAssetId: 'd-a' },
    { ordinal: 0, assetId: 'b', derivedAssetId: null }
  ]), ['b', 'd-a']);
  assert.deepEqual(buildAssetIdsFromPlatformBindings([]), []);
  assert.equal(contentBindingKey('a', 0), 'a:0');
  assert.equal(contentBindingKey('a', 1), 'a:1');
});

// ---------------------------------------------------------------------------
// materializeCropAsset：原图保留 / provenance / sha256 去重复用 / 无效输入零写
// ---------------------------------------------------------------------------

test('WMB-5237 media: materializeCropAsset creates derived asset with provenance, preserves original and dedups by sha256', async () => {
  await withDb(async (database, dataRoot) => {
    const sourceId = await addAsset(database, dataRoot, PNG_RED);
    const sourceBefore = getAsset(database, sourceId);
    const cropRegion = { x: 0, y: 0, width: 0.5, height: 0.5 };

    const first = await materializeCropAsset(database, dataRoot, {
      sourceAssetId: sourceId,
      cropRegion,
      bytes: PNG_BLUE,
      origin: 'studio.crop',
      requestId: 'req-1'
    });
    assert.equal(first.reused, false);
    const derived = getAsset(database, first.assetId);
    assert.ok(derived, '派生 asset 必须落库');
    assert.notEqual(first.assetId, sourceId);
    assert.notEqual(derived.relativePath, sourceBefore.relativePath);
    assert.equal(derived.sha256, shaOf(PNG_BLUE));

    // 原图不动：源 asset 行与派生前逐字段一致。
    assert.deepEqual(getAsset(database, sourceId), sourceBefore);

    // 血缘：derived_crop 行记录 source -> derived 与裁剪参数。
    const prov = database.prepare(
      `SELECT asset_id AS assetId, source_asset_id AS sourceAssetId, derived_asset_id AS derivedAssetId,
              request_id AS requestId, transform_json AS transformJson, origin
       FROM asset_provenance WHERE kind = 'derived_crop'`
    ).get();
    assert.ok(prov);
    assert.equal(prov.sourceAssetId, sourceId);
    assert.equal(prov.assetId, first.assetId);
    assert.equal(prov.derivedAssetId, first.assetId);
    assert.equal(prov.requestId, 'req-1');
    assert.equal(prov.origin, 'studio.crop');
    const transform = JSON.parse(prov.transformJson);
    assert.deepEqual(transform.cropRegion, cropRegion);
    assert.equal(transform.width, pngPixels(PNG_BLUE).width, 'materializeCropAsset 经 IHDR 解析真实像素宽');
    assert.equal(transform.height, pngPixels(PNG_BLUE).height, 'materializeCropAsset 经 IHDR 解析真实像素高');

    // sha256 复用：同字节 → 同 asset、reused=true，provenance 不重复。
    const second = await materializeCropAsset(database, dataRoot, {
      sourceAssetId: sourceId,
      cropRegion,
      bytes: PNG_BLUE,
      origin: 'studio.crop'
    });
    assert.equal(second.assetId, first.assetId);
    assert.equal(second.reused, true);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM assets WHERE sha256 = ?').get(derived.sha256).count, 1);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM asset_provenance WHERE kind = 'derived_crop' AND source_asset_id = ? AND derived_asset_id = ?")
        .get(sourceId, first.assetId).count,
      1
    );

    // 不同裁剪 → 新派生 asset + 新血缘行。
    const third = await materializeCropAsset(database, dataRoot, {
      sourceAssetId: sourceId,
      cropRegion: { x: 0.25, y: 0.25, width: 0.25, height: 0.25 },
      bytes: PNG_GREEN,
      origin: 'studio.crop'
    });
    assert.notEqual(third.assetId, first.assetId);

    // 无效 region / 缺源：拒绝且零写。
    const assetCountBefore = database.prepare('SELECT COUNT(*) AS count FROM assets').get().count;
    await assert.rejects(
      materializeCropAsset(database, dataRoot, {
        sourceAssetId: sourceId,
        cropRegion: { x: 0, y: 0, width: 0, height: 0.5 },
        bytes: PNG_GREEN,
        origin: 'studio.crop'
      }),
      /cropRegion 无效/
    );
    await assert.rejects(
      materializeCropAsset(database, dataRoot, {
        sourceAssetId: 'missing',
        cropRegion,
        bytes: PNG_GREEN,
        origin: 'studio.crop'
      }),
      /源素材不存在/
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM assets').get().count, assetCountBefore);
  });
});

// ---------------------------------------------------------------------------
// renderer：单一 parser + 布局草稿纯函数（esbuild 打包 production helpers）
// ---------------------------------------------------------------------------

let helpers;
let toolbar;
let createElement;
let renderToStaticMarkup;
let harnessDir;

test.before(async () => {
  // esbuild 产物保留 external:['react','react/jsx-runtime']（保证与测试侧同一 react 实例，
  // renderToStaticMarkup 不触发双实例 hook 错误）；因此产物必须写在仓库内，Node 才能从
  // 产物位置向上解析 node_modules/react（os.tmpdir() 无 node_modules，import 会抛
  // ERR_MODULE_NOT_FOUND）。
  await mkdir(path.join(root, 'tmp'), { recursive: true });
  const dir = await mkdtemp(path.join(root, 'tmp', 'wmb-5237-harness-'));
  harnessDir = dir;
  const dompurifyStub = path.join(dir, 'dompurify-stub.mjs');
  await writeFile(dompurifyStub, 'export default { sanitize: (html) => html };\n', 'utf8');

  const helpersOut = path.join(dir, 'helpers.mjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'src/renderer/studio-view-helpers.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: helpersOut,
    jsx: 'automatic',
    alias: { dompurify: dompurifyStub },
    external: ['react', 'react/jsx-runtime'],
    logLevel: 'silent'
  });
  helpers = await import(pathToFileURL(helpersOut).href);

  const toolbarOut = path.join(dir, 'toolbar.mjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'src/renderer/studio-image-toolbar.tsx')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: toolbarOut,
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime'],
    logLevel: 'silent'
  });
  toolbar = await import(pathToFileURL(toolbarOut).href);

  ({ createElement } = await import('react'));
  ({ renderToStaticMarkup } = await import('react-dom/server'));
});

test.after(async () => {
  if (harnessDir) {
    await rm(harnessDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    harnessDir = null;
  }
});

test('WMB-5237 media: renderer helpers are the single shared parser (behavior-identical, no second implementation)', () => {
  const bodies = [
    '第一段\n\n![图A](wmb-asset://aaa)\n\n文字 ![图B](wmb-asset://bbb) 行内\n\n![图A2](wmb-asset://aaa)',
    '![a \\[b\\] c](wmb-asset://1 "标题")',
    'para\n\n```\n![x](wmb-asset://1)\n```\n\n![y](wmb-asset://2)',
    'a\r\n\r\n![x](wmb-asset://1)\r\n\r\n![y](wmb-asset://2 "t")',
    ''
  ];
  for (const body of bodies) {
    assert.deepEqual(helpers.parseAssetImages(body), sharedToken.parseAssetImages(body), 'renderer 与共享 parser 必须一致');
  }
  assert.equal(helpers.ASSET_IMAGE_SCHEME, 'wmb-asset://');
});

test('WMB-5237 media: updateContentMediaBinding upserts by (assetId, occurrence) immutably and never touches body tokens', () => {
  // 新建：默认 large/center，patch 合并。
  const start = helpers.updateContentMediaBinding([], 'a', 0, { widthPreset: 'small', align: 'left' });
  assert.equal(start.length, 1);
  assert.equal(start[0].assetId, 'a');
  assert.equal(start[0].occurrence, 0);
  assert.equal(start[0].widthPreset, 'small');
  assert.equal(start[0].align, 'left');

  const captionOnly = helpers.updateContentMediaBinding([], 'a', 0, { caption: '图注' });
  assert.equal(captionOnly[0].widthPreset, 'large', '仅改图注不突变布局');
  assert.equal(captionOnly[0].align, 'center');
  assert.equal(captionOnly[0].caption, '图注');

  // 追加不同 occurrence：key = assetId:occurrence。
  const two = helpers.updateContentMediaBinding(start, 'a', 1, { widthPreset: 'full', align: 'right' });
  assert.equal(two.length, 2);
  assert.equal(contentBindingKey(two[1].assetId, two[1].occurrence), 'a:1');

  // 幂等纯函数：原数组与元素不被修改。
  assert.equal(start.length, 1);
  assert.equal(start[0].widthPreset, 'small');
  assert.equal(start[0].align, 'left');

  // 更新既有 key：patch 合并，返回新数组。
  const updated = helpers.updateContentMediaBinding(two, 'a', 0, { widthPreset: 'medium' });
  assert.equal(updated[0].widthPreset, 'medium');
  assert.equal(updated[0].align, 'left', '未 patch 字段保留');
  assert.equal(two[0].widthPreset, 'small', '原数组不受影响');

  // 布局只作用于草稿：正文 token 结构零变化。
  const body = '第一段\n\n![图A](wmb-asset://a)\n\n![图B](wmb-asset://b)\n\n结尾';
  const refsBefore = helpers.parseAssetImages(body);
  let draft = [];
  for (const ref of refsBefore) {
    draft = helpers.updateContentMediaBinding(draft, ref.assetId, ref.occurrence, { widthPreset: 'small', align: 'center' });
  }
  draft = helpers.updateContentMediaBinding(draft, 'a', 0, { widthPreset: 'full', align: 'right' });
  const refsAfter = helpers.parseAssetImages(body);
  assert.deepEqual(refsAfter, refsBefore, '布局操作后正文 token 必须逐字段一致');
  assert.ok(!body.includes('small') && !body.includes('full') && !body.includes('right'));
});

test('WMB-5237 media: contentMediaLayoutMap keys figures by assetId:occurrence for projection', () => {
  const map = helpers.contentMediaLayoutMap([
    { assetId: 'a', occurrence: 0, widthPreset: 'small', align: 'left' },
    { assetId: 'a', occurrence: 1, widthPreset: 'full', align: 'right' },
    { assetId: 'b', occurrence: 0, widthPreset: 'medium', align: 'center' }
  ]);
  assert.deepEqual([...map.keys()], ['a:0', 'a:1', 'b:0']);
  assert.deepEqual(map.get('a:0'), { widthPreset: 'small', align: 'left' });
  assert.deepEqual(map.get('a:1'), { widthPreset: 'full', align: 'right' });
  assert.deepEqual(map.get('b:0'), { widthPreset: 'medium', align: 'center' });
  assert.equal(map.has(contentBindingKey('a', 0)), true, '与共享 contentBindingKey 同源');
});

test('WMB-5237 media: caption edits still mutate the token via token helpers; layout never enters the token', () => {
  const body = '![旧注](wmb-asset://a)';
  const next = helpers.updateAssetImageAlt(body, 'a', 0, '新注');
  assert.equal(next, '![新注](wmb-asset://a)');
  assert.ok(!/width|align|preset|crop/i.test(next), 'token 只含 alt + assetId');
  const removed = helpers.removeAssetImageToken('a\n\n![x](wmb-asset://1)\n\nb', '1', 0);
  assert.equal(removed, 'a\n\nb');
});

test('WMB-5237 media: toolbar exports width/align labels and drag-snap ratios (小中大通栏 · 左中右)', () => {
  assert.deepEqual(toolbar.WIDTH_PRESET_LABELS, { small: '小', medium: '中', large: '大', full: '通栏' });
  assert.deepEqual(toolbar.ALIGN_LABELS, { left: '左', center: '中', right: '右' });
  assert.deepEqual(toolbar.PRESET_RATIOS, { small: 0.4, medium: 0.65, full: 1 });
  assert.equal(toolbar.PRESET_HINTS.small, '小 · 40%');
  assert.equal(toolbar.PRESET_HINTS.full, '通栏 · 铺满整行');
});

test('WMB-5237 media: StudioInlineImageOverlay renders readOnly status shell and hides all edit actions', () => {
  const base = {
    selection: { assetId: 'a', occurrence: 0 },
    findFigure: () => null,
    draft: { widthPreset: 'small', align: 'left' },
    alt: '图注',
    editable: true,
    showLayout: true,
    onWidthPreset: () => {},
    onAlign: () => {},
    onReplace: () => {},
    onEditCaption: () => {},
    onCrop: () => {},
    onRemove: () => {},
    onClose: () => {}
  };
  const editableHtml = renderToStaticMarkup(createElement(toolbar.StudioInlineImageOverlay, base));
  assert.match(editableHtml, /class="studio-inline-image-overlay"/);
  assert.doesNotMatch(editableHtml, /role="status"/, '可编辑态不得出现只读状态条');

  const readOnlyHtml = renderToStaticMarkup(createElement(toolbar.StudioInlineImageOverlay, { ...base, editable: false }));
  assert.match(readOnlyHtml, /role="status"/);
  assert.match(readOnlyHtml, /aria-label="图片只读信息"/);
  for (const action of ['替换', '图注', '裁切', '移出']) {
    assert.ok(!readOnlyHtml.includes(action), `只读态不得出现编辑动作「${action}」`);
  }
});

test('WMB-5237 media: toolbar structure contract (toolbar/aria/actions/readOnly/drag-commit-once, esbuild harness for non-executable DOM)', async () => {
  // 既有 esbuild harness 模式：UI 结构无法在 Node 中执行交互时，对 production 模块做语义结构断言。
  const source = await readFile(path.join(root, 'src/renderer/studio-image-toolbar.tsx'), 'utf8');
  assert.match(source, /role="toolbar"/);
  assert.match(source, /aria-label="图片工具条"/);
  assert.match(source, /aria-label="图片宽度"/);
  assert.match(source, /aria-label="图片对齐"/);
  assert.match(source, /aria-label="替换图片"/);
  assert.match(source, /aria-label="编辑图注"/);
  assert.match(source, /aria-label="裁切图片"/);
  assert.match(source, /aria-label="移出本文"/);
  assert.match(source, /aria-pressed/, '尺寸/对齐按钮必须暴露选中态');
  // 只读分支
  assert.match(source, /role="status"/);
  assert.match(source, /aria-label="图片只读信息"/);
  assert.match(source, /历史版本只读/);
  // 拖拽：pointerup 一次性提交吸附结果（onPointerDown 仅负责捕获开始）。
  assert.match(source, /onPointerUp=\{endDrag\}/);
  assert.match(source, /onPointerCancel=\{endDrag\}/);
  assert.match(source, /if \(!draft \|\| best\.preset !== draft\.widthPreset\) onWidthPreset\(best\.preset\)/, '仅在变化时提交一次');
  assert.equal((source.match(/onWidthPreset\(best\.preset\)/g) ?? []).length, 1, '单次提交，绝无重复提交');
  // 工具条只改草稿/内联样式：不得调用正文 token 变换。
  assert.doesNotMatch(source, /updateAssetImageAlt|replaceAssetImageToken|removeAssetImageToken|changeBody/);
});
