import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { copyContentVersionToNewProject, createContentProjectWithVersion, getContentProject, saveCoreVersion, savePlatformVersion } from '../src/main/content.ts';
import { upsertSource } from '../src/main/sources.ts';

const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-version-project-'));
try {
  const db = migrateDatabase(path.join(directory, 'wmb.db'));
  const source = upsertSource(db, { originalUrl: 'https://example.com/source', title: '真实资料', summary: '资料摘要' });
  const project = createContentProjectWithVersion(db, { title: '原项目', body: '版本一', sourceIds: [source.id] });
  const second = saveCoreVersion(db, { projectId: project.id, expectedRevision: 1, body: '误归版本二' });
  if (!second.ok) throw new Error('second version failed');
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO assets (id, relative_path, mime_type, byte_count, sha256, origin, width, height, duration_ms, created_at, updated_at, revision)
    VALUES ('asset-1', 'assets/example.png', 'image/png', 12, 'sha-example', 'test', 100, 200, NULL, ?, ?, 1)`).run(now, now);
  savePlatformVersion(db, {
    projectId: project.id, contentVersionId: second.data.id, platform: 'x', format: 'image',
    body: '平台正文', assetIds: ['asset-1']
  });
  const detail = getContentProject(db, project.id);
  const fromOld = saveCoreVersion(db, {
    projectId: project.id, expectedRevision: 2, body: detail.revisions.find((version) => version.number === 1).body
  });
  const copied = copyContentVersionToNewProject(db, {
    sourceProjectId: project.id, contentVersionId: second.data.id, title: '独立 Skill 项目'
  });
  if (!detail || detail.sources[0]?.title !== '真实资料' || detail.assets[0]?.sha256 !== 'sha-example'
    || detail.platformVersions.x[0]?.contentVersionId !== second.data.id) throw new Error('project materials readback failed');
  const sourceAfterOldSave = getContentProject(db, project.id);
  if (!fromOld.ok || sourceAfterOldSave?.revisions.length !== detail.revisions.length + 1
    || sourceAfterOldSave.revisions[0].body !== '版本一') throw new Error('save from old version added the wrong history');
  if (!copied.ok || copied.data.id === project.id || copied.data.revisions.length !== 1
    || copied.data.revisions[0].body !== '误归版本二' || copied.data.sources[0]?.id !== source.id) throw new Error('explicit copy failed');
  if (getContentProject(db, project.id)?.revisions.length !== 3) throw new Error('copy changed source history');
  console.log(JSON.stringify({
    sourceProjectId: project.id, copiedProjectId: copied.data.id, copiedBody: copied.data.revisions[0].body,
    sourceVersionCountBefore: detail.revisions.length, sourceVersionCountAfter: sourceAfterOldSave.revisions.length, copiedVersionCount: copied.data.revisions.length,
    sourceTitle: detail.sources[0].title, assetSha256: detail.assets[0].sha256
  }));
  db.close();
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
