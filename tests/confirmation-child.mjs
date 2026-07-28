import { mkdtemp, rm, writeFile } from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path';
import { openDataRoot } from '../src/main/data-root.ts'; import { migrateDatabase } from '../src/main/db/migrations.ts';
import { importAsset } from '../src/main/assets.ts'; import { createContentProject, saveCoreVersion, savePlatformVersion } from '../src/main/content.ts';
import { saveAccount } from '../src/main/accounts.ts';
import { confirmAndStartPublication, createPublication, getPublicationDetail, preparePublication } from '../src/main/publishing.ts';

const parent = await mkdtemp(path.join(os.tmpdir(), 'wmb-confirmation-'));
try {
  const root = await openDataRoot(path.join(parent, 'data')); const db = migrateDatabase(path.join(root.path, 'wmb.db'));
  const media = path.join(parent, 'image.png'); await writeFile(media, 'image'); const asset = await importAsset(db, root.path, { sourcePath: media, mimeType: 'image/png', origin: 'user' });
  const project = createContentProject(db, { title: 'confirmation' }); const core = saveCoreVersion(db, project.id, 'core');
  const version = savePlatformVersion(db, { projectId: project.id, contentVersionId: core.id, platform: 'x', format: 'image', body: 'hello', assetIds: [asset.id] });
  const account = saveAccount(db, { platform: 'x', accountKey: '@owner', displayName: 'Owner', loginState: 'authenticated', evidenceUrl: 'https://x.com/owner' });
  if (!version.ok) throw new Error('setup failed');
  const created = createPublication(db, { platformVersionId: version.data.id, accountId: account.id });
  if (!created.ok) throw new Error('publication setup failed');
  const mismatch = preparePublication(db, { publicationId: created.data.id, expectedRevision: 1, editorTitle: null, editorBody: 'different', editorAssetIds: [asset.id], editorEvidenceUrl: 'https://x.com/compose' });
  if (mismatch.ok || mismatch.error.code !== 'VALIDATION_ERROR') throw new Error('editor mismatch accepted');
  const prepared = preparePublication(db, { publicationId: created.data.id, expectedRevision: 1, editorTitle: null, editorBody: 'hello', editorAssetIds: [asset.id], editorEvidenceUrl: 'https://x.com/compose' });
  if (!prepared.ok || prepared.data.publication.status !== 'awaiting_confirmation') throw new Error('prepare failed');
  db.prepare('UPDATE platform_versions SET body = ?, revision = revision + 1 WHERE id = ?').run('changed', version.data.id);
  const stale = confirmAndStartPublication(db, { publicationId: created.data.id, expectedRevision: prepared.data.publication.revision });
  if (stale.ok || stale.error.code !== 'CONFIRMATION_STALE') throw new Error('stale confirmation accepted');
  db.prepare('UPDATE platform_versions SET body = ?, revision = ?, updated_at = updated_at WHERE id = ?').run('hello', 1, version.data.id);
  const confirmed = confirmAndStartPublication(db, { publicationId: created.data.id, expectedRevision: prepared.data.publication.revision });
  const detail = getPublicationDetail(db, created.data.id);
  if (!confirmed.ok || confirmed.data.publication.status !== 'publishing' || detail?.attempts.length !== 1 || detail.payload?.assets[0].sha256.length !== 64) throw new Error('confirmation snapshot mismatch');
  const confirmation = db.prepare('SELECT consumed_at AS consumedAt, attempt_id AS attemptId FROM publication_confirmations WHERE id = ?').get(confirmed.data.confirmationId);
  if (!confirmation.consumedAt || confirmation.attemptId !== confirmed.data.attemptId) throw new Error('one-time confirmation mismatch');
  db.close();
} finally { await rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
