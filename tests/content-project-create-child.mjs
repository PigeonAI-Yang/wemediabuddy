import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dispatchStartAgentTask } from '../src/main/agent-task-commands.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { createContentProjectWithVersion, getStudio, saveCoreVersion } from '../src/main/content.ts';
import { startMcp } from '../src/main/mcp.ts';
import { createTopic, saveCurrentPlan } from '../src/main/planning.ts';
import { upsertSource } from '../src/main/sources.ts';
import { dispatchIssueTaskGrant } from '../src/main/task-grants.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { ensureOfficialWorkspaceProfile } from '../src/main/workspace-profiles.ts';

const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-content-project-create-'));
let mcp, runtime;
try {
  const db = migrateDatabase(path.join(directory, 'wmb.db'));
  ensureOfficialWorkspaceProfile(db, 'official.ai');
  const workspaceNow = new Date().toISOString();
  db.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id','workspace-content-create',?,?,1)").run(workspaceNow, workspaceNow);
  const existing = createContentProjectWithVersion(db, { title: '原 MCP 项目', body: '原正文' });
  const source = upsertSource(db, { originalUrl: 'https://example.com/game-news', title: '游戏资讯官方资料', summary: '官方摘要' });
  const topic = createTopic(db, '游戏资讯事件');
  const plan = saveCurrentPlan(db, { planDate: '2026-08-02', timezone: 'Asia/Shanghai', summary: '游戏资讯方案', items: [{ topicId: topic.id, title: '游戏资讯选题', priority: 1, whyNow: '官方信息已更新', timeliness: '今天', targetAudience: '中文玩家', angle: '解释玩家影响', pointOfView: '先核验再创作', platforms: ['x'], formats: ['text'], titleGuidance: '说清变化', openingGuidance: '先说影响', structureGuidance: '变化、影响、行动', effortEstimate: '30 分钟', sourceIds: [source.id] }] });
  const planItemId = db.prepare('SELECT id FROM plan_items WHERE plan_id=?').get(plan.id).id;
  const before = db.prepare('SELECT COUNT(*) AS count FROM content_versions WHERE project_id = ?').get(existing.id).count;
  db.close();

  runtime = ActiveWorkspaceRuntime.open(directory, { openDatabase: migrateDatabase, createEpoch: () => 'content-create-runtime' });
  const task = (await dispatchStartAgentTask(runtime, { intent: 'studio_draft', businessDate: '2026-08-02', contextRefs: { workspaceId: runtime.identity.workspaceId } }, { actor: { type: 'owner_ui', id: 'renderer', label: 'Owner UI' }, requestId: 'content-create-task' })).task;
  const grant = await dispatchIssueTaskGrant(runtime, {
    requestId: 'content-create-grant', taskId: task.id, ownerGoal: '创建测试内容项目', allowedCommands: ['content.create'],
    workers: [{ type: 'external_agent', id: 'mcp' }], expiresAt: new Date(Date.now() + 60_000).toISOString()
  });
  if (!grant.ok) throw new Error(grant.error.message);
  mcp = await startMcp(directory, runtime.gate, undefined, runtime);
  process.env.WMB_MCP_URL = mcp.url;
  const tools = new Map();
  const extension = (await import(`../.pi/extensions/wmb-mcp/index.ts?test=${Date.now()}`)).default;
  extension({
    registerTool(tool) {
      tools.set(tool.name, tool);
    }
  });
  const denied = await tools.get('wmb_create_content_project').execute('draft-bypass', {
    requestId: 'wmb-1101-skill-draft',
    taskId: task.id,
    grantId: grant.data.id,
    title: 'Skill 新稿',
    body: '独立正文',
    planItemId
  });
  const deniedReceipt = JSON.parse(denied.details.content[0].text);
  if (deniedReceipt.ok !== false || deniedReceipt.error?.code !== 'PLAN_ITEM_NOT_APPROVED') {
    throw new Error(`draft plan item unexpectedly created through content.create: ${JSON.stringify(denied.details)}`);
  }

  const saved = await tools.get('wmb_create_content_project').execute('create', {
    requestId: 'wmb-1101-skill-draft-independent',
    taskId: task.id,
    grantId: grant.data.id,
    title: 'Skill 新稿',
    body: '独立正文',
    sourceIds: [source.id]
  });
  const created = JSON.parse(saved.details.content[0].text).data;
  const read = await tools.get('wmb_get_content').execute('read', { projectId: created.id });
  const exactReadback = JSON.parse(read.details.content[0].text);

  const readDb = migrateDatabase(path.join(directory, 'wmb.db'));
  const studio = getStudio(readDb);
  const original = studio.find((project) => project.id === existing.id);
  const skillDraft = studio.find((project) => project.id === created.id);
  const after = readDb.prepare('SELECT COUNT(*) AS count FROM content_versions WHERE project_id = ?').get(existing.id).count;
  const linkedPlanItemId = readDb.prepare('SELECT plan_item_id AS planItemId FROM content_projects WHERE id=?').get(created.id).planItemId;
  const lineage = readDb.prepare('SELECT topic_id AS topicId FROM content_projects WHERE id=?').get(created.id);
  const linkedSources = readDb.prepare('SELECT source_id AS sourceId FROM content_project_sources WHERE project_id=?').all(created.id);

  if (before !== 1 || after !== 1) throw new Error('new article changed the existing project');
  if (linkedPlanItemId !== null) throw new Error('independent MCP content.create unexpectedly linked a plan item');
  if (lineage.topicId !== null || linkedSources.length !== 1 || linkedSources[0].sourceId !== source.id) throw new Error('MCP content.create did not preserve the explicit source lineage');
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
  await runtime?.stop({ drain: false });
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch((error) => {
    if (error.code !== 'EBUSY') throw error;
  });
}
