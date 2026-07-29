import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { createContentProjectWithVersion, getStudio, saveCoreVersion } from '../src/main/content.ts';
import { startMcp } from '../src/main/mcp.ts';

const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-content-project-create-'));
let mcp;
try {
  const db = migrateDatabase(path.join(directory, 'wmb.db'));
  const existing = createContentProjectWithVersion(db, { title: '原 MCP 项目', body: '原正文' });
  const before = db.prepare('SELECT COUNT(*) AS count FROM content_versions WHERE project_id = ?').get(existing.id).count;
  db.close();

  mcp = await startMcp(directory);
  process.env.WMB_MCP_URL = mcp.url;
  const tools = new Map();
  const extension = (await import(`../.pi/extensions/wmb-mcp.ts?test=${Date.now()}`)).default;
  extension({
    registerTool(tool) {
      tools.set(tool.name, tool);
    }
  });
  const saved = await tools.get('wmb_create_content_project').execute('create', {
    requestId: 'wmb-1101-skill-draft',
    title: 'Skill 新稿',
    body: '独立正文'
  });
  const created = JSON.parse(saved.details.content[0].text).data;
  const read = await tools.get('wmb_get_content').execute('read', { projectId: created.id });
  const exactReadback = JSON.parse(read.details.content[0].text);

  const readDb = migrateDatabase(path.join(directory, 'wmb.db'));
  const studio = getStudio(readDb);
  const original = studio.find((project) => project.id === existing.id);
  const skillDraft = studio.find((project) => project.id === created.id);
  const after = readDb.prepare('SELECT COUNT(*) AS count FROM content_versions WHERE project_id = ?').get(existing.id).count;

  if (before !== 1 || after !== 1) throw new Error('new article changed the existing project');
  if (created.versionNumber !== 1 || skillDraft?.title !== 'Skill 新稿' || skillDraft.revisions[0]?.body !== '独立正文'
    || exactReadback?.id !== created.id || exactReadback?.title !== 'Skill 新稿'
    || exactReadback?.revisions[0]?.number !== 1 || exactReadback?.revisions[0]?.body !== '独立正文') {
    throw new Error('new project v1 readback mismatch');
  }
  console.log(JSON.stringify({
    originalProjectId: existing.id,
    originalVersionCountBefore: before,
    originalVersionCountAfter: after,
    newProjectId: created.id,
    title: exactReadback.title,
    versionNumber: exactReadback.revisions[0].number,
    body: exactReadback.revisions[0].body
  }));

  readDb.exec('BEGIN IMMEDIATE');
  try {
    createContentProjectWithVersion(readDb, { title: '应回滚', body: '正文' }, false);
    throw new Error('simulate later failure');
  } catch {
    readDb.exec('ROLLBACK');
  }
  const rolledBack = readDb.prepare("SELECT COUNT(*) AS count FROM content_projects WHERE title = '应回滚'").get().count;
  if (rolledBack !== 0) throw new Error('project and first version were not atomic');

  const continued = saveCoreVersion(readDb, { projectId: created.id, body: '明确续写', expectedRevision: 1 });
  if (!continued.ok) throw new Error('explicit continuation failed');
  if (getStudio(readDb).find((project) => project.id === created.id)?.revisions[0]?.number !== 2) {
    throw new Error('explicit continuation did not append one version');
  }
  readDb.close();
} finally {
  await mcp?.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
