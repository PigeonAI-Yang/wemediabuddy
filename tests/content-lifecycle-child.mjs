import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { createContentProject, getContentProject, updateContentProject } from '../src/main/content.ts';
import {upsertKnowledgeTopic} from '../src/main/knowledge.ts';

const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-lifecycle-'));
try {
  const db = migrateDatabase(path.join(directory, 'wmb.db'));
  const topic=upsertKnowledgeTopic(db,{title:'长期方法'});
  const project = createContentProject(db, { title: 'Lifecycle' });
  const updated = updateContentProject(db, { projectId: project.id, expectedRevision: 1, status: 'review', archived: true,topicId:topic.id });
  const stale = updateContentProject(db, { projectId: project.id, expectedRevision: 1, status: 'ready' });
  const restored = updateContentProject(db, { projectId: project.id, expectedRevision: 2, archived: false });
  const readback = getContentProject(db, project.id);
  const missing=updateContentProject(db,{projectId:project.id,expectedRevision:3,topicId:'missing'});
  if (!updated.ok || updated.data.status !== 'review' || !updated.data.archivedAt || updated.data.revision !== 2) throw new Error('lifecycle update failed');
  if (stale.ok || stale.error.code !== 'REVISION_CONFLICT' || stale.error.details.current.revision !== 2) throw new Error('stale lifecycle write was not rejected');
  if (!restored.ok || readback?.status !== 'review' || readback.archivedAt !== null || readback.topicId!==topic.id || readback.revision !== 3) throw new Error('lifecycle readback failed');
  if(missing.ok||missing.error.code!=='NOT_FOUND'||getContentProject(db,project.id)?.revision!==3)throw new Error('missing topic changed project');
  db.close();
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
