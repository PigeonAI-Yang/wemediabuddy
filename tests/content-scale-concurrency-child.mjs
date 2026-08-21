import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dispatchStartAgentTask } from '../src/main/agent-task-commands.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { getContentProject, listContentProjects } from '../src/main/content.ts';
import { startMcp } from '../src/main/mcp.ts';
import { dispatchIssueTaskGrant } from '../src/main/task-grants.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { ensureOfficialWorkspaceProfile } from '../src/main/workspace-profiles.ts';

function measured(database) {
  let queryCount = 0;
  const proxy = new Proxy(database, {
    get(target, property) {
      if (property === 'prepare') return (...args) => {
        queryCount += 1;
        return target.prepare(...args);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  return { database: proxy, count: () => queryCount };
}

const externalDirectory=process.env.WMB_TEST_DIRECTORY;
const directory = externalDirectory??await mkdtemp(path.join(os.tmpdir(), 'wmb-content-scale-'));
let mcp, runtime;
try {
  let db = migrateDatabase(path.join(directory, 'wmb.db'));
  ensureOfficialWorkspaceProfile(db, 'official.ai');
  const workspaceNow = new Date().toISOString();
  db.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id','workspace-content-scale',?,?,1)").run(workspaceNow, workspaceNow);
  let insertProject = db.prepare(`INSERT INTO content_projects
    (id, title, status, archived_at, created_at, updated_at, revision)
    VALUES (?, ?, 'drafting', NULL, ?, ?, 1)`);
  let insertVersion = db.prepare(`INSERT INTO content_versions
    (id, project_id, body, version_number, created_at, author)
    VALUES (?, ?, ?, ?, ?, 'ai')`);
  db.exec('BEGIN IMMEDIATE');
  for (let index = 1; index <= 1001; index += 1) {
    const projectId = `project-${String(index).padStart(4, '0')}`;
    const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString();
    insertProject.run(projectId, `规模项目 ${index}`, createdAt, createdAt);
    for (let version = 1; version <= 3; version += 1) {
      const marker = index === 1001 && version === 3 ? 'needle-1001 ' : `project-${index}-v${version} `;
      const body = marker + '字'.repeat(1500 - marker.length);
      insertVersion.run(`${projectId}-v${version}`, projectId, body, version, createdAt);
    }
  }
  db.exec('COMMIT');
  const initialVersionCount = db.prepare('SELECT COUNT(*) AS count FROM content_versions').get().count;
  const bodyLengths = db.prepare('SELECT MIN(length(body)) AS minimum, MAX(length(body)) AS maximum FROM content_versions').get();
  if (initialVersionCount !== 3003 || bodyLengths.minimum !== 1500 || bodyLengths.maximum !== 1500) {
    throw new Error('1001-project fixture mismatch');
  }

  const ids = [];
  const listQueryCounts = [];
  for (let offset = 0; offset < 1001; offset += 50) {
    const counter = measured(db);
    const page = listContentProjects(counter.database, { limit: 50, offset });
    listQueryCounts.push(counter.count());
    ids.push(...page.items.map((item) => item.id));
    if (page.items.length > 50) throw new Error('page exceeded 50');
  }
  if (ids.length !== 1001 || new Set(ids).size !== 1001) throw new Error('paging duplicated or omitted projects');
  if (listQueryCounts.some((count) => count !== 1)) throw new Error(`list query count grew: ${listQueryCounts.join(',')}`);

  const searchCounter = measured(db);
  const searched = listContentProjects(searchCounter.database, { query: 'needle-1001', limit: 50 });
  if (searched.items.length !== 1 || searched.items[0].id !== 'project-1001' || searchCounter.count() !== 1) {
    throw new Error('tail search or query count mismatch');
  }
  const detailCounter = measured(db);
  const detail = getContentProject(detailCounter.database, 'project-1001');
  // WMB-5290 新增 investigation 读模型使 getContentProject 查询数由 11 增至 12（新增 readProjectInvestigation）
  if (!detail || detail.revisions.length !== 3 || detail.revisions[0].body.length !== 1500 || detailCounter.count() !== 12) {
    throw new Error(`fixed detail query count mismatch ${JSON.stringify({found:Boolean(detail),revisions:detail?.revisions.length,body:detail?.revisions[0]?.body.length,queries:detailCounter.count()})}`);
  }

  insertProject=null;insertVersion=null;db.close();
  runtime = ActiveWorkspaceRuntime.open(directory, { openDatabase: migrateDatabase, createEpoch: () => 'content-scale-runtime' });
  db = runtime.database;
  const task = (await dispatchStartAgentTask(runtime, { intent: 'studio_draft', businessDate: '2026-08-02', contextRefs: { workspaceId: runtime.identity.workspaceId } }, { actor: { type: 'owner_ui', id: 'renderer', label: 'Owner UI' }, requestId: 'content-scale-task' })).task;
  const grant = await dispatchIssueTaskGrant(runtime, {
    requestId: 'content-scale-grant', taskId: task.id, ownerGoal: '验证核心版本并发控制', allowedCommands: ['content.save_version'],
    workers: [{ type: 'external_agent', id: 'mcp' }], expiresAt: new Date(Date.now() + 60_000).toISOString()
  });
  if (!grant.ok) throw new Error(grant.error.message);
  mcp = await startMcp(directory, runtime.gate, undefined, runtime);
  process.env.WMB_MCP_URL = mcp.url;
  const tools = new Map();
  const extension = (await import(`../.pi/extensions/wmb-mcp/index.ts?test=${Date.now()}`)).default;
  extension({ registerTool(tool) { tools.set(tool.name, tool); } });
  const imageResult = await tools.get('wmb_import_project_image').execute('image-a', {
    requestId: 'wmb-1103-image-a',
    taskId: task.id,
    grantId: grant.data.id,
    projectId: 'project-1001',
    fileName: 'decision.svg',
    alt: '工具、服务与平台判断图',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675"><rect width="1200" height="675" fill="#f4f4f0"/><text x="80" y="340" font-size="64" fill="#111">Tool → Service → Marketplace</text></svg>'
  });
  const imported = JSON.parse(imageResult.details.content[0].text);
  const assetId = imported.data?.asset?.id;
  const imageMarkdown = imported.data?.markdown;
  const bitmapResult = await tools.get('wmb_import_project_image').execute('image-b', {
    requestId: 'wmb-1103-image-b',
    taskId: task.id,
    grantId: grant.data.id,
    projectId: 'project-1001',
    fileName: 'cover.png',
    mimeType: 'image/png',
    alt: '项目首图',
    contentBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
  });
  const importedBitmap = JSON.parse(bitmapResult.details.content[0].text);
  const bitmapAssetId = importedBitmap.data?.asset?.id;
  const bitmapMarkdown = importedBitmap.data?.markdown;
  const firstResult = await tools.get('wmb_save_core_version').execute('client-a', {
    requestId: 'wmb-1103-client-a',
    taskId: task.id,
    grantId: grant.data.id,
    projectId: 'project-1001',
    expectedRevision: 1,
    title: '客户端 A 新标题',
    body: `客户端 A 新版本\n\n${bitmapMarkdown}\n\n${imageMarkdown}`,
    mediaBindings: [
      { assetId: bitmapAssetId, occurrence: 0, widthPreset: 'full', align: 'center', caption: '项目首图' },
      { assetId, occurrence: 0, widthPreset: 'full', align: 'center', caption: '工具、服务与平台判断图' }
    ]
  });
  const staleResult = await tools.get('wmb_save_core_version').execute('client-b', {
    requestId: 'wmb-1103-client-b',
    taskId: task.id,
    grantId: grant.data.id,
    projectId: 'project-1001',
    expectedRevision: 1,
    body: '客户端 B 旧 revision'
  });
  const first = JSON.parse(firstResult.details.content[0].text);
  const stale = JSON.parse(staleResult.details.content[0].text);
  const finalProject = db.prepare('SELECT title, revision FROM content_projects WHERE id = ?').get('project-1001');
  const finalVersions = db.prepare('SELECT COUNT(*) AS count FROM content_versions WHERE project_id = ?').get('project-1001').count;
  const projectAssets = db.prepare('SELECT COUNT(*) AS count FROM content_project_assets WHERE project_id = ?').get('project-1001').count;
  const mediaBindings = db.prepare('SELECT COUNT(*) AS count FROM content_media_bindings WHERE content_version_id = ?').get(first.data?.id).count;
  const savedBody = db.prepare('SELECT body FROM content_versions WHERE id = ?').get(first.data?.id)?.body ?? '';
  if (!imported.ok || !assetId || !imageMarkdown || !importedBitmap.ok || !bitmapAssetId || !bitmapMarkdown
    || !first.ok || first.data.projectRevision !== 2 || first.data.project.title !== '客户端 A 新标题'
    || !savedBody.includes(`wmb-asset://${assetId}`) || !savedBody.includes(`wmb-asset://${bitmapAssetId}`)
    || projectAssets !== 2 || mediaBindings !== 2 || stale.ok || stale.error.code !== 'REVISION_CONFLICT'
    || stale.error.details.current.revision !== 2 || finalProject.title !== '客户端 A 新标题'
    || finalProject.revision !== 2 || finalVersions !== 4) {
    throw new Error('stale revision created an extra version');
  }

  console.log(JSON.stringify({
    projectCount: ids.length,
    initialVersionCount,
    finalVersionCount: db.prepare('SELECT COUNT(*) AS count FROM content_versions').get().count,
    bodyLength: bodyLengths.minimum,
    pageCount: listQueryCounts.length,
    listQueriesPerPage: [...new Set(listQueryCounts)],
    detailQueryCount: detailCounter.count(),
    searchHit: searched.items[0].id,
    searchQueryCount: searchCounter.count(),
    firstProjectRevision: first.data.projectRevision,
    importedAssetIds: [bitmapAssetId, assetId],
    mediaBindingCount: mediaBindings,
    staleError: stale.error.code,
    finalProjectVersionCount: finalVersions
  }));
  await mcp?.close();mcp=null;
  await runtime.stop({ drain: false });runtime=null;
} finally {
  await mcp?.close();
  if (runtime?.isActive) await runtime.stop({ drain: false });
  if(!externalDirectory)await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
