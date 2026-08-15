// WMB-5237 data-layer smoke verification (temp, not part of the test suite).
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrations } from '../src/main/db/migrations.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { createContentProject, createContentProjectWithVersion, getContentProject, saveCoreVersion, savePlatformVersion } from '../src/main/content.ts';
import { getAsset } from '../src/main/assets.ts';
import { materializeCropAsset, readContentMediaBindings, readPlatformMediaBindings } from '../src/main/media-bindings.ts';
import { parseAssetImages } from '../src/shared/media-token.ts';
import { isValidCropRegion, buildAssetIdsFromPlatformBindings } from '../src/shared/media-bindings.ts';

let failures = 0;
const check = (label, condition, extra = '') => {
  if (condition) console.log(`PASS ${label}`);
  else { failures += 1; console.log(`FAIL ${label} ${extra}`); }
};

const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-5237-smoke-'));
const dbPath = path.join(directory, 'wmb.db');
let db = null;
try {
  // ---- 1) Fresh migrate: 3 tables exist, migration 62 applied ----
  {
    const freshPath = path.join(directory, 'fresh.db');
    const db = migrateDatabase(freshPath);
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('content_media_bindings','platform_media_bindings','asset_provenance') ORDER BY name`).all().map(r => r.name);
    check('fresh migrate creates 3 media tables', tables.join(',') === 'asset_provenance,content_media_bindings,platform_media_bindings', JSON.stringify(tables));
    const version = db.prepare('SELECT version FROM schema_migrations WHERE version = 62').get();
    check('migration 62 recorded', Boolean(version));
    db.close();
  }

  // ---- 2) Legacy backfill: apply 1..61, seed legacy rows, then migrate applies 62 ----
  db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map(r => Number(r.version)));
  for (const m of migrations) {
    if (applied.has(m.version) || m.version >= 62) continue;
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      m.run?.(db);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; } finally { db.exec('PRAGMA foreign_keys = ON'); }
  }
  // seed legacy: project, content version with two image tokens, platform version with asset_ids_json
  db.exec(`INSERT INTO assets (id, relative_path, mime_type, byte_count, sha256, origin, width, height, duration_ms, created_at, updated_at, revision)
    VALUES ('legacy-a1', 'assets/x1.png', 'image/png', 10, 'sha-a1', 'legacy', 100, 100, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1),
           ('legacy-a2', 'assets/x2.png', 'image/png', 10, 'sha-a2', 'legacy', 100, 100, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1)`);
  db.exec(`INSERT INTO content_projects (id, title, created_at, updated_at, revision) VALUES ('legacy-p', 'Legacy', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1)`);
  db.exec(`INSERT INTO content_versions (id, project_id, body, version_number, created_at, author) VALUES
    ('legacy-v1', 'legacy-p', 'head\n\n![第一张](wmb-asset://legacy-a1)\n\n![第二张](wmb-asset://legacy-a2)\n\ntail', 1, '2026-01-01T00:00:00.000Z', 'ai')`);
  db.exec(`INSERT INTO platform_versions (id, project_id, content_version_id, platform, format, title, body, asset_ids_json, created_at, updated_at, revision) VALUES
    ('legacy-pv1', 'legacy-p', 'legacy-v1', 'x', 'text', NULL, 'body', '["legacy-a1","legacy-a2"]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1)`);
  db.close();

  db = migrateDatabase(dbPath); // applies 62 + backfill hook
  {
    const coreBindings = db.prepare('SELECT asset_id AS assetId, ordinal, occurrence, caption, width_preset AS widthPreset, align FROM content_media_bindings WHERE content_version_id = ? ORDER BY ordinal').all('legacy-v1');
    check('backfill core bindings from body tokens', coreBindings.length === 2 && coreBindings[0].assetId === 'legacy-a1' && coreBindings[0].caption === '第一张' && coreBindings[1].assetId === 'legacy-a2' && coreBindings[1].caption === '第二张', JSON.stringify(coreBindings));
    const platformBindings = db.prepare('SELECT asset_id AS assetId, ordinal, is_cover AS isCover FROM platform_media_bindings WHERE platform_version_id = ? ORDER BY ordinal').all('legacy-pv1');
    check('backfill platform bindings from asset_ids_json (x first = cover)', platformBindings.length === 2 && platformBindings[0].assetId === 'legacy-a1' && platformBindings[0].isCover === 1 && platformBindings[1].assetId === 'legacy-a2' && platformBindings[1].isCover === 0, JSON.stringify(platformBindings));
    const detail = getContentProject(db, 'legacy-p');
    check('detail read returns backfilled core bindings', detail?.revisions[0]?.bindings?.length === 2, JSON.stringify(detail?.revisions[0]?.bindings));
    check('detail read returns backfilled platform mediaBindings', detail?.platformVersions.x?.[0]?.mediaBindings?.length === 2, JSON.stringify(detail?.platformVersions.x?.[0]?.mediaBindings));
    check('legacy platform assets projection preserved', detail?.platformVersions.x?.[0]?.assets?.join(',') === 'legacy-a1,legacy-a2', JSON.stringify(detail?.platformVersions.x?.[0]?.assets));
  }

  // ---- 3) New core save with mediaBindings: same transaction, readback ----
  {
    const project = createContentProject(db, { title: 'New Project' });
    const body = 'intro\n\n![图A](wmb-asset://legacy-a1)\n\n![图B](wmb-asset://legacy-a2)';
    const result = saveCoreVersion(db, {
      projectId: project.id, body, expectedRevision: 1,
      mediaBindings: [
        { assetId: 'legacy-a1', occurrence: 0, widthPreset: 'large', align: 'center', caption: '核心图注A' },
        { assetId: 'legacy-a2', occurrence: 0, widthPreset: 'small', align: 'right' }
      ]
    }, true);
    check('core save ok', result.ok === true, JSON.stringify(result));
    const detail = getContentProject(db, project.id);
    const bindings = detail?.revisions[0]?.bindings ?? [];
    check('core bindings written with drafts', bindings.length === 2 && bindings[0].widthPreset === 'large' && bindings[0].caption === '核心图注A' && bindings[1].widthPreset === 'small' && bindings[1].align === 'right', JSON.stringify(bindings));
    const bodyRefs = parseAssetImages(body);
    check('body tokens carry no layout metadata', bodyRefs.every(r => !r.raw.includes('small') && !r.raw.includes('large') && !r.raw.includes('right')), bodyRefs.map(r => r.raw).join('|'));
  }

  // ---- 4) Core save without mediaBindings: reconcile from body refs (defaults) ----
  {
    const project = createContentProject(db, { title: 'No Drafts' });
    const body = '![x](wmb-asset://legacy-a1)';
    const result = saveCoreVersion(db, { projectId: project.id, body, expectedRevision: 1 }, true);
    check('core save without drafts ok', result.ok === true);
    const bindings = readContentMediaBindings(db, result.data.id);
    check('core bindings defaulted from body', bindings.length === 1 && bindings[0].assetId === 'legacy-a1' && bindings[0].widthPreset === 'full' && bindings[0].align === 'center', JSON.stringify(bindings));
  }

  // ---- 5) Core save failure (invalid draft) rolls back: no version row, no bindings ----
  {
    const project = createContentProject(db, { title: 'Rollback' });
    let threw = false;
    try {
      saveCoreVersion(db, {
        projectId: project.id, body: '![a](wmb-asset://legacy-a1)', expectedRevision: 1,
        mediaBindings: [{ assetId: 'legacy-a1', occurrence: 0, widthPreset: 'bogus', align: 'center' }]
      }, true);
    } catch { threw = true; }
    const versionCount = db.prepare('SELECT COUNT(*) AS c FROM content_versions WHERE project_id = ?').get(project.id).c;
    const bindingCount = db.prepare('SELECT COUNT(*) AS c FROM content_media_bindings cmb JOIN content_versions cv ON cv.id = cmb.content_version_id WHERE cv.project_id = ?').get(project.id).c;
    check('core invalid draft rolls back (zero partial write)', threw && versionCount === 0 && bindingCount === 0, `threw=${threw} versions=${versionCount} bindings=${bindingCount}`);
  }

  // ---- 6) Platform save create with mediaBindings (cover, crop+derived) ----
  {
    const project = createContentProject(db, { title: 'Platform Create' });
    const core = saveCoreVersion(db, { projectId: project.id, body: '![a](wmb-asset://legacy-a1)', expectedRevision: 1 }, true);
    const platform = savePlatformVersion(db, {
      projectId: project.id, contentVersionId: core.data.id, platform: 'x', format: 'text', body: 'pbody',
      mediaBindings: [
        { assetId: 'legacy-a1', ordinal: 0, isCover: true, caption: '平台图注' },
        { assetId: 'legacy-a2', ordinal: 1 }
      ]
    }, true);
    check('platform create ok', platform.ok === true, JSON.stringify(platform));
    const detail = getContentProject(db, project.id);
    const pv = detail?.platformVersions.x?.[0];
    check('platform create: mediaBindings readback', pv?.mediaBindings?.length === 2 && pv.mediaBindings[0].isCover === true && pv.mediaBindings[1].caption === null, JSON.stringify(pv?.mediaBindings));
    check('platform create: asset_ids_json rebuilt from bindings', pv?.assets?.join(',') === 'legacy-a1,legacy-a2', JSON.stringify(pv?.assets));
  }

  // ---- 7) Platform save update without mediaBindings keeps existing bindings ----
  {
    const project = createContentProject(db, { title: 'Keep Existing' });
    const core = saveCoreVersion(db, { projectId: project.id, body: '![a](wmb-asset://legacy-a1)', expectedRevision: 1 }, true);
    const created = savePlatformVersion(db, {
      projectId: project.id, contentVersionId: core.data.id, platform: 'xiaohongshu', format: 'text', body: 'v1',
      mediaBindings: [{ assetId: 'legacy-a2', ordinal: 0, isCover: true, caption: '小红书画图注' }]
    }, true);
    const updated = savePlatformVersion(db, {
      projectId: project.id, contentVersionId: core.data.id, platform: 'xiaohongshu', format: 'text', body: 'v2 (no bindings)',
      expectedRevision: created.data.revision, id: created.data.id
    }, true);
    check('platform update without mediaBindings ok', updated.ok === true);
    const bindings = readPlatformMediaBindings(db, created.data.id);
    check('existing platform bindings preserved (not cleared)', bindings.length === 1 && bindings[0].assetId === 'legacy-a2' && bindings[0].isCover === true && bindings[0].caption === '小红书画图注', JSON.stringify(bindings));
    const row = db.prepare('SELECT asset_ids_json AS assets FROM platform_versions WHERE id = ?').get(created.data.id);
    check('asset_ids_json preserved on no-bindings update', row.assets === '["legacy-a2"]', row.assets);
  }

  // ---- 8) Revision conflict: zero partial write ----
  {
    const project = createContentProject(db, { title: 'Conflict' });
    const core = saveCoreVersion(db, { projectId: project.id, body: '![a](wmb-asset://legacy-a1)', expectedRevision: 1 }, true);
    const created = savePlatformVersion(db, {
      projectId: project.id, contentVersionId: core.data.id, platform: 'wechat', format: 'html', body: 'v1',
      mediaBindings: [{ assetId: 'legacy-a1', ordinal: 0, caption: 'c1' }]
    }, true);
    const conflicted = savePlatformVersion(db, {
      projectId: project.id, contentVersionId: core.data.id, platform: 'wechat', format: 'html', body: 'v2 stale',
      expectedRevision: 999, id: created.data.id,
      mediaBindings: [{ assetId: 'legacy-a2', ordinal: 0, caption: 'should-not-land' }]
    }, true);
    check('stale revision rejected', conflicted.ok === false && conflicted.error?.code === 'REVISION_CONFLICT', JSON.stringify(conflicted));
    const bindings = readPlatformMediaBindings(db, created.data.id);
    const row = db.prepare('SELECT body, revision, asset_ids_json AS assets FROM platform_versions WHERE id = ?').get(created.data.id);
    check('conflict leaves version + bindings untouched', bindings[0].assetId === 'legacy-a1' && bindings[0].caption === 'c1' && row.body === 'v1' && row.revision === 1 && row.assets === '["legacy-a1"]', JSON.stringify({ bindings, row }));
  }

  // ---- 9) X platform cover must be ordinal 0 ----
  {
    const project = createContentProject(db, { title: 'X Cover Rule' });
    const core = saveCoreVersion(db, { projectId: project.id, body: '![a](wmb-asset://legacy-a1)\n![b](wmb-asset://legacy-a2)', expectedRevision: 1 }, true);
    let threw = false;
    try {
      savePlatformVersion(db, {
        projectId: project.id, contentVersionId: core.data.id, platform: 'x', format: 'text', body: 'p',
        mediaBindings: [
          { assetId: 'legacy-a1', ordinal: 0 },
          { assetId: 'legacy-a2', ordinal: 1, isCover: true }
        ]
      }, true);
    } catch { threw = true; }
    const count = db.prepare('SELECT COUNT(*) AS c FROM platform_versions WHERE project_id = ?').get(project.id).c;
    check('x cover at non-zero ordinal rejected, nothing written', threw && count === 0, `threw=${threw} count=${count}`);
  }

  // ---- 10) Crop materialization (derive flow) + provenance + save with derivedAssetId ----
  {
    const project = createContentProject(db, { title: 'Crop Flow' });
    const core = saveCoreVersion(db, { projectId: project.id, body: '![a](wmb-asset://legacy-a1)', expectedRevision: 1 }, true);
    const crop = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
    const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
    const derived = await materializeCropAsset(db, directory, {
      sourceAssetId: 'legacy-a1', cropRegion: crop, bytes: pngBytes, origin: 'platform-crop:test', width: 1, height: 1
    });
    const derivedRow = db.prepare('SELECT kind, source_asset_id AS sourceAssetId, derived_asset_id AS derivedAssetId, transform_json AS transformJson FROM asset_provenance WHERE derived_asset_id = ?').get(derived.assetId);
    check('derive materializes asset + provenance', derived.reused === false && Boolean(derivedRow) && derivedRow.kind === 'derived_crop' && derivedRow.sourceAssetId === 'legacy-a1' && derivedRow.transformJson.includes('0.5'), JSON.stringify({ derived, derivedRow }));
    // idempotent re-materialization: same source + same bytes → reuse, no duplicate provenance
    const derivedAgain = await materializeCropAsset(db, directory, {
      sourceAssetId: 'legacy-a1', cropRegion: crop, bytes: pngBytes, origin: 'platform-crop:test', width: 1, height: 1
    });
    const provenanceCount = db.prepare("SELECT COUNT(*) AS c FROM asset_provenance WHERE kind='derived_crop' AND source_asset_id='legacy-a1' AND derived_asset_id=?").get(derivedAgain.assetId).c;
    check('derive idempotent (reused, single provenance)', derivedAgain.reused === true && derivedAgain.assetId === derived.assetId && provenanceCount === 1, JSON.stringify({ derivedAgain, provenanceCount }));
    const platform = savePlatformVersion(db, {
      projectId: project.id, contentVersionId: core.data.id, platform: 'xiaohongshu', format: 'text', body: 'p',
      mediaBindings: [{ assetId: 'legacy-a1', ordinal: 0, isCover: true, cropRegion: crop, derivedAssetId: derived.assetId }]
    }, true);
    const bindings = readPlatformMediaBindings(db, platform.data.id);
    const row = db.prepare('SELECT asset_ids_json AS assets FROM platform_versions WHERE id = ?').get(platform.data.id);
    check('platform save uses derivedAssetId in projection', bindings[0].derivedAssetId === derived.assetId && row.assets === JSON.stringify([derived.assetId]), JSON.stringify({ bindings, assets: row.assets }));
    check('original asset untouched by crop', getAsset(db, 'legacy-a1')?.sha256 === 'sha-a1', 'original mutated');
  }

  // ---- 11) Save-attached crop payload (stagedCrops) atomic in save transaction ----
  {
    const project = createContentProject(db, { title: 'Staged Crop Save' });
    const core = saveCoreVersion(db, { projectId: project.id, body: '![a](wmb-asset://legacy-a1)', expectedRevision: 1 }, true);
    const crop2 = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 };
    const png2 = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082'.replace('63600000', '63600001'), 'hex');
    const staged = await (async () => {
      const { stageAssetBytes } = await import('../src/main/assets.ts');
      return stageAssetBytes(directory, { bytes: png2, fileName: 'crop.png', mimeType: 'image/png', origin: 'platform-crop' });
    })();
    const platform = savePlatformVersion(db, {
      projectId: project.id, contentVersionId: core.data.id, platform: 'wechat', format: 'html', body: 'p',
      mediaBindings: [{ assetId: 'legacy-a1', ordinal: 0, cropRegion: crop2 }],
      stagedCrops: [{ sourceAssetId: 'legacy-a1', cropRegion: crop2, staged }]
    }, true);
    const bindings = readPlatformMediaBindings(db, platform.data.id);
    const provenance = db.prepare("SELECT origin FROM asset_provenance WHERE kind='derived_crop' AND derived_asset_id=?").get(bindings[0].derivedAssetId);
    check('staged crop materialized in save transaction', Boolean(bindings[0].derivedAssetId) && Boolean(provenance) && provenance.origin === `platform-crop:${platform.data.id}`, JSON.stringify({ bindings, provenance }));
    const row = db.prepare('SELECT asset_ids_json AS assets FROM platform_versions WHERE id = ?').get(platform.data.id);
    check('projection rebuilt to derived id', row.assets === JSON.stringify([bindings[0].derivedAssetId]), row.assets);
  }

  // ---- 12) Shared helpers sanity ----
  {
    check('isValidCropRegion rejects out-of-range', isValidCropRegion({ x: 0.5, y: 0.5, width: 0.6, height: 0.1 }) === false);
    check('isValidCropRegion accepts valid', isValidCropRegion({ x: 0, y: 0, width: 1, height: 1 }) === true);
    check('buildAssetIds prefers derived', buildAssetIdsFromPlatformBindings([{ ordinal: 0, assetId: 'a', derivedAssetId: 'd' }, { ordinal: 1, assetId: 'b' }]).join(',') === 'd,b');
  }
} catch (error) {
  console.log('SMOKE CRASH', error);
  failures += 1;
} finally {
  try { db?.close(); } catch { /* already closed */ }
  await rm(directory, { recursive: true, force: true });
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
