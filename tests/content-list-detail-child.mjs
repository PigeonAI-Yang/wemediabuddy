import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import {
  createContentProjectWithVersion,
  getContentProject,
  listContentProjects,
  saveCoreVersion,
  savePlatformVersion
} from '../src/main/content.ts';
import { startMcp } from '../src/main/mcp.ts';

const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-content-list-'));
let mcp;
try {
  const db = migrateDatabase(path.join(directory, 'wmb.db'));
  const ids = [];
  for (let index = 0; index < 55; index += 1) {
    const project = createContentProjectWithVersion(db, {
      title: `项目 ${String(index).padStart(2, '0')}`,
      body: `首版正文 ${index}`
    });
    const saved = saveCoreVersion(db, {
      projectId: project.id,
      body: index === 54 ? '末尾检索词 needle-55' : `第二版正文 ${index}`,
      expectedRevision: 1
    });
    if (!saved.ok) throw new Error('fixture version save failed');
    ids.push(project.id);
  }
  const latest = ids[54];
  const latestVersion = db.prepare('SELECT id FROM content_versions WHERE project_id = ? ORDER BY version_number DESC LIMIT 1').get(latest);
  savePlatformVersion(db, {
    projectId: latest,
    contentVersionId: latestVersion.id,
    platform: 'x',
    format: 'text',
    body: 'X 平台正文'
  });
  db.prepare("UPDATE content_projects SET status = 'ready', archived_at = ? WHERE id = ?").run(new Date().toISOString(), ids[0]);
  db.prepare("UPDATE content_projects SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(ids[1]);
  db.prepare("UPDATE content_projects SET updated_at = '2021-01-01T00:00:00.000Z' WHERE id = ?").run(ids[2]);

  const page = listContentProjects(db, { limit: 200 });
  if (page.items.length !== 50 || page.limit !== 50 || !page.hasMore) throw new Error('bounded page mismatch');
  if (JSON.stringify(page).includes('第二版正文')) throw new Error('list leaked historical body');
  if (page.items.some((item) => item.status !== 'drafting' || item.archivedAt !== null)) throw new Error('active/default lifecycle mismatch');

  const searched = listContentProjects(db, { query: 'needle-55', archived: false, limit: 10 });
  if (searched.items.length !== 1 || searched.items[0].id !== latest || searched.items[0].versionCount !== 2 || searched.items[0].platforms.x !== 1) {
    throw new Error('server search or summary mismatch');
  }
  const archived = listContentProjects(db, { archived: true, status: 'ready', limit: 10 });
  if (archived.items.length !== 1 || archived.items[0].id !== ids[0]) throw new Error('archive/status filter mismatch');
  const xOnly = listContentProjects(db, { platform: 'x', limit: 10 });
  if (xOnly.items.length !== 1 || xOnly.items[0].id !== latest) throw new Error('platform filter mismatch');
  const oldest = listContentProjects(db, { order: 'oldest', limit: 1 });
  if (oldest.items[0]?.id !== ids[1]) throw new Error('oldest ordering mismatch');

  const detail = getContentProject(db, latest);
  if (!detail || detail.id !== latest || detail.revisions.length !== 2 || detail.revisions[0].body !== '末尾检索词 needle-55'
    || detail.platformVersions.x[0].body !== 'X 平台正文') {
    throw new Error('single-project detail mismatch');
  }

  mcp = await startMcp(directory);
  process.env.WMB_MCP_URL = mcp.url;
  const tools = new Map();
  const extension = (await import(`../.pi/extensions/wmb-mcp.ts?test=${Date.now()}`)).default;
  extension({ registerTool(tool) { tools.set(tool.name, tool); } });
  const mcpListResult = await tools.get('wmb_list_content_projects').execute('list', { query: 'needle-55', limit: 50 });
  const mcpList = JSON.parse(mcpListResult.details.content[0].text);
  const mcpDetailResult = await tools.get('wmb_get_content').execute('detail', { projectId: latest });
  const mcpDetail = JSON.parse(mcpDetailResult.details.content[0].text);
  if (mcpList.items.length !== 1 || JSON.stringify(mcpList).includes('needle-55') || mcpDetail.revisions[0].body !== '末尾检索词 needle-55') {
    throw new Error('Pi extension MCP list/detail boundary mismatch');
  }
  console.log(JSON.stringify({
    pageSize: page.items.length,
    hasMore: page.hasMore,
    searchProjectId: searched.items[0].id,
    detailVersionCount: detail.revisions.length,
    archivedCount: archived.items.length,
    listContainsBody: JSON.stringify(page).includes('第二版正文'),
    mcpSearchCount: mcpList.items.length
  }));
  db.close();
} finally {
  await mcp?.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
