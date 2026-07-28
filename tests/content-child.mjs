import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { addProjectNote, createContentProject, saveCoreVersion, savePlatformVersion } from '../src/main/content.ts';

const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-content-'));
try {
  const db = migrateDatabase(path.join(directory, 'wmb.db'));
  const project = createContentProject(db, { title: 'Project' });
  addProjectNote(db, project.id, 'note', 'note');
  addProjectNote(db, project.id, 'decision', 'decision');
  const first = saveCoreVersion(db, project.id, 'first');
  const second = saveCoreVersion(db, project.id, 'second');
  const platform = savePlatformVersion(db, { projectId: project.id, contentVersionId: second.id, platform: 'x', format: 'text', body: 'post' });
  if (!platform.ok) throw new Error('platform create failed');
  const updated = savePlatformVersion(db, { id: platform.data.id, expectedRevision: 1, projectId: project.id, contentVersionId: second.id, platform: 'x', format: 'text', body: 'updated' });
  const stale = savePlatformVersion(db, { id: platform.data.id, expectedRevision: 1, projectId: project.id, contentVersionId: second.id, platform: 'x', format: 'text', body: 'stale' });
  const xiaohongshuVideo = savePlatformVersion(db, {
    projectId: project.id,
    contentVersionId: second.id,
    platform: 'xiaohongshu',
    format: 'video',
    title: '视频标题',
    body: '视频正文',
    assetIds: ['video-asset']
  });
  const videoPayload = xiaohongshuVideo.ok
    ? db.prepare('SELECT title, body, format, asset_ids_json AS assetIds FROM platform_versions WHERE id = ?').get(xiaohongshuVideo.data.id)
    : undefined;
  const versionCount = db.prepare('SELECT COUNT(*) AS count FROM content_versions WHERE project_id = ?').get(project.id).count;
  if (first.versionNumber !== 1 || second.versionNumber !== 2 || versionCount !== 2 || !updated.ok || stale.ok || stale.error.code !== 'REVISION_CONFLICT') throw new Error('content version regression');
  if (!videoPayload || videoPayload.title !== '视频标题' || videoPayload.body !== '视频正文' || videoPayload.format !== 'video' || JSON.parse(videoPayload.assetIds)[0] !== 'video-asset') throw new Error('Xiaohongshu video handoff mismatch');
  db.close();
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
