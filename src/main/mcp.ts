import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createContentProjectWithVersion, getContentProject, listContentProjects, saveCoreVersion, savePlatformVersion } from './content.ts';
import { migrateDatabase } from './db/migrations.ts';
import { getToday } from './workbench.ts';
import { saveCurrentPlan, type PlanItemInput } from './planning.ts';
import { getSource, searchSources, upsertSource, type SourceInput } from './sources.ts';
import { getWireHealthLedger } from './source-wire-health.ts';
import { listAssets } from './assets.ts';
import { listFinalReviewsAndFindings, listReviews, saveReview } from './reviews.ts';
import { listPublicationMetricSnapshots } from './metrics.ts';
import * as z from 'zod';
import { clearAgentTaskControl, getAgentTask, reportAgentTaskProgress } from './agent-tasks.ts';
import { createKnowledgeDomain, getKnowledgeContext, getKnowledgeDomain, getKnowledgeTopicDossier, listKnowledgeDomains, recordKnowledgeBatch, topicDossierCategories, updateKnowledgeDomain } from './knowledge.ts';
import { createContentProjectFromBriefIdempotent, createCreativeBriefIdempotent, createKnowledgeSuggestionIdempotent, getContentProjectContextPackages, getCreativeBriefForContext, getCreativeBriefForPackage, getCreativeBriefLineage, getKnowledgeCanvas, getKnowledgeContextPackage, listKnowledgeContextPackages, previewKnowledgeContextPackage, updateCreativeBriefIdempotent } from './knowledge-canvas.ts';
import { getXListOperation, listXListBindings, prepareXListOperation, xListOperationKinds } from './x-lists.ts';
import { collectBoundXListTimeline } from './x-list-execution.ts';
import { ensurePyaireaderXBrowser, readBrowserConfig } from './browser.ts';
import { readXListDetail, readXListIndex, readXListMembers, readXListTimeline } from './platforms/x-list-browser.ts';
import { isPyaireaderXProfile } from './platforms/x-list-primitives.ts';
import type { WorkspaceRuntimeGate } from './workspace-runtime.ts';
import { allowsAiOnlyRoutes, assertPublishingPlatforms } from './workspace-profiles.ts';
import { registerWorkspaceApplicationMcp, type WorkspaceApplicationMcp } from './workspace-mcp.ts';
import { registerIntelligenceChannelsMcp } from './intelligence-channel-mcp.ts';
import { getXPostTrend, listXPostMetricSnapshots } from './x-post-metrics.ts';
import { getXObservationSession, startXObservationSession, stopXObservationSession } from './x-observation-jobs.ts';

export type McpRuntime = { url: string; close: () => Promise<void> };

const text = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });

function createServerFor(rootPath: string, application?: WorkspaceApplicationMcp): McpServer {
  const server = new McpServer({ name: 'wemedia-buddy', version: '0.1.0' });
  const database = () => migrateDatabase(path.join(rootPath, 'wmb.db'));
  const profileDatabase = database();
  const aiOnlyRoutes = allowsAiOnlyRoutes(profileDatabase);
  profileDatabase.close();

  if (application) registerWorkspaceApplicationMcp(server, rootPath, application);
  if (application?.channelProposals) registerIntelligenceChannelsMcp(server, rootPath, application);

  server.registerTool('context.get_workbench', { description: '读取今日工作、待办、最近资料与当前运营方案。' }, async () => {
    const db = database(); try { return text(getToday(db, new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()))); } finally { db.close(); }
  });
  server.registerTool('plans.get', { description: '读取指定日期或今日的当前运营方案。' }, async () => {
    const db = database(); try { return text(getToday(db, new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())).plan); } finally { db.close(); }
  });
  server.registerTool('agent_tasks.get', {
    description: '读取长任务的持久进度、检查点和待处理控制。',
    inputSchema: { task_id: z.string() }
  }, async ({ task_id }) => {
    const db = database(); try { return text(getAgentTask(db, task_id)); } finally { db.close(); }
  });
  server.registerTool('agent_tasks.report_progress', {
    description: '在每个来源开始、成功、失败或跳过后持久化进度和检查点。',
    inputSchema: {
      task_id: z.string(),
      phase: z.string().optional(),
      current_source: z.string().optional(),
      planned: z.number().int().nonnegative().optional(),
      processed: z.number().int().nonnegative().optional(),
      failed: z.number().int().nonnegative().optional(),
      verified: z.number().int().nonnegative().optional(),
      saved: z.number().int().nonnegative().optional(),
      opportunity_count: z.number().int().nonnegative().optional(),
      checkpoint: z.record(z.string(), z.unknown()).optional(),
      message: z.string().optional(),
      level: z.enum(['info', 'warning']).optional(),
      clear_control: z.boolean().optional()
    }
  }, async (input) => {
    const db = database();
    try {
      const result = reportAgentTaskProgress(db, input.task_id, {
        phase: input.phase,
        progress: {
          currentSource: input.current_source, planned: input.planned, processed: input.processed,
          failed: input.failed, verified: input.verified, saved: input.saved, opportunityCount: input.opportunity_count
        },
        checkpoint: input.checkpoint,
        message: input.message,
        level: input.level
      });
      if (input.clear_control && result.ok) clearAgentTaskControl(db, input.task_id);
      return text(result);
    } finally { db.close(); }
  });
  server.registerTool('content.list', {
    description: '服务端搜索内容项目，只返回最多 50 条摘要，不返回历史正文。',
    inputSchema: {
      query: z.string().optional(),
      status: z.enum(['idea', 'drafting', 'review', 'ready', 'completed']).optional(),
      archived: z.boolean().optional(),
      limit: z.number().int().min(1).max(50).optional(),
      offset: z.number().int().min(0).optional()
    }
  }, async (input) => {
    const db = database(); try { return text(listContentProjects(db, input)); } finally { db.close(); }
  });
  server.registerTool('content.get', { description: '按项目 ID 读取一个内容项目的完整详情。', inputSchema: { project_id: z.string() } }, async ({ project_id }) => {
    const db = database(); try { return text(getContentProject(db, project_id)); } finally { db.close(); }
  });
  server.registerTool('assets.list', { description: '读取已导入素材元数据。' }, async () => {
    const db = database();
    try { return text(listAssets(db)); } finally { db.close(); }
  });
  server.registerTool('sources.get', { description: '按 ID 读取完整资料。', inputSchema: { id: z.string() } }, async ({ id }) => {
    const db = database(); try { return text(getSource(db, id)); } finally { db.close(); }
  });
  server.registerTool('sources.search', {
    description: '搜索并读取完整资料字段。',
    inputSchema: { query: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }
  }, async ({ query, limit }) => {
    const db = database(); try { return text(searchSources(db, query, limit)); } finally { db.close(); }
  });
  if (aiOnlyRoutes) server.registerTool('sources.wire_health_get', {
    description: '读取最近一次今日情报导线巡检健康台账（按 registry/X List 源）。',
    inputSchema: { business_date: z.string().optional() }
  }, async ({ business_date }) => {
    const db = database();
    try { return text(getWireHealthLedger(db, { businessDate: business_date })); }
    finally { db.close(); }
  });
  server.registerTool('sources.upsert_batch', {
    description: '新增或更新资料；同一 request_id 重放原始结果。',
    inputSchema: { request_id: z.string(), items: z.array(z.object({
      title: z.string(), feedId: z.string().optional(), originalUrl: z.string().optional(), author: z.string().optional(),
      publishedAt: z.string().optional(), summary: z.string().optional(), categories: z.array(z.string()).optional(),
      keywords: z.array(z.string()).optional(), valueJudgment: z.string().optional(), ipRelevance: z.string().optional(),
      creationAngles: z.string().optional(), recommendedPlatforms: z.array(z.string()).optional(),
      recommendedFormats: z.array(z.string()).optional(), timeliness: z.string().optional(), priority: z.number().optional(),
      evidence: z.string().optional(), clientLabel: z.string().optional(), expectedRevision: z.number().int().optional()
    })) }
  }, async ({ request_id, items }) => {
    const db = database();
    try {
      const prior = db.prepare('SELECT result_json AS resultJson FROM mcp_request_results WHERE tool = ? AND request_id = ?').get('sources.upsert_batch', request_id) as { resultJson: string } | undefined;
      if (prior) return text(JSON.parse(prior.resultJson));
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = items.map((item) => upsertSource(db, item as SourceInput));
        const payload = { ok: true, data: result, error: null };
        db.prepare('INSERT INTO mcp_request_results (tool, request_id, result_json, created_at) VALUES (?, ?, ?, ?)').run('sources.upsert_batch', request_id, JSON.stringify(payload), new Date().toISOString());
        db.exec('COMMIT'); return text(payload);
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } finally { db.close(); }
  });
  const selectedXListBrowser = async () => {
    const db = database();
    try {
      const config = readBrowserConfig(db);
      const workspaceId = (db.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get() as { value?: string } | undefined)?.value;
      if (!workspaceId || !config || (config.id === 'edge:pyaireader-default' && !aiOnlyRoutes) || !isPyaireaderXProfile({ id: config.id, cdpUrl: config.cdpUrl })) {
        throw new Error('请先在设置中选择当前工作空间专用的 X 登录态。');
      }
      const runtime = await ensurePyaireaderXBrowser(config, { mode: 'quiet' });
      return { id: config.id, cdpUrl: runtime.cdpUrl, workspaceId };
    } finally { db.close(); }
  };
  const xListResult = async <T>(work: () => Promise<T>) => {
    try { return text(await work()); }
    catch (error) { return text({ ok: false, data: null, error: { code: (error as { code?: string })?.code ?? 'BROWSER_NEEDS_USER', message: error instanceof Error ? error.message : String(error), details: { state: 'needs_user' } } }); }
  };
  const selectedXListAccount = async () => {
    const config = await selectedXListBrowser();
    const index = await readXListIndex(config);
    return { config: { ...config, accountKey: index.accountKey }, accountKey: index.accountKey };
  };
  const accountMatches = (actual: string, expected: string) => actual.trim().toLowerCase() === expected.trim().toLowerCase();
  server.registerTool('x_lists.read_index', {
    description: '读取当前专用 X 登录账号可见的 List 索引（真实网页，不是仅本地绑定）。只读。后台静默浏览器，含拟人间隔。',
    inputSchema: {}
  }, async () => xListResult(async () => readXListIndex(await selectedXListBrowser())));
  server.registerTool('x_lists.read_detail', {
    description: '读取指定 X List 的详情。只读真实网页。后台静默浏览器，含拟人间隔。',
    inputSchema: { list_id: z.string() }
  }, async ({ list_id }) => xListResult(async () => readXListDetail(await selectedXListBrowser(), list_id)));
  server.registerTool('x_lists.read_members', {
    description: '读取指定 X List 当前可见成员。只读真实网页。后台静默浏览器，含拟人间隔。',
    inputSchema: { list_id: z.string() }
  }, async ({ list_id }) => xListResult(async () => readXListMembers(await selectedXListBrowser(), list_id)));
  server.registerTool('x_lists.read_timeline', {
    description: '读取指定 X List 当前可见动态，最多 50 条。只读真实网页。后台静默浏览器，含拟人间隔。',
    inputSchema: { list_id: z.string(), limit: z.number().int().min(1).max(50).optional() }
  }, async ({ list_id, limit }) => xListResult(async () => {
    const { config } = await selectedXListAccount();
    return readXListTimeline(config, list_id, limit ?? 50);
  }));
  server.registerTool('x_lists.list_bindings', {
    description: '读取已绑定到 WMB 发现的 X List，不读取或操作 X 网页。',
    inputSchema: { account_key: z.string().optional() }
  }, async ({ account_key }) => xListResult(async () => {
    const { accountKey } = await selectedXListAccount();
    if (account_key && !accountMatches(accountKey, account_key)) return { ok: false, data: null, error: { code: 'ACCOUNT_MISMATCH', message: '当前浏览器账号与请求账号不一致。' } };
    const db = database(); try { return listXListBindings(db, accountKey); } finally { db.close(); }
  }));
  server.registerTool('x_lists.get_operation', {
    description: '读取一条 X List 操作提议、冻结快照和执行状态。只读。',
    inputSchema: { id: z.string() }
  }, async ({ id }) => xListResult(async () => {
    const { accountKey } = await selectedXListAccount();
    const db = database();
    try {
      const operation = getXListOperation(db, id);
      return operation && !accountMatches(operation.accountKey, accountKey)
        ? { ok: false, data: null, error: { code: 'ACCOUNT_MISMATCH', message: '当前浏览器账号与操作绑定账号不一致。' } }
        : operation;
    } finally { db.close(); }
  }));
  server.registerTool('x_lists.prepare', {
    description: '创建 X List 操作提议（create/update/delete/members_add/members_remove）。只准备，最终确认只能在 WMB UI 完成。',
    inputSchema: {
      request_id: z.string(), account_key: z.string(), kind: z.enum(xListOperationKinds), list_id: z.string().optional(),
      name: z.string().optional(), description: z.string().optional(), is_private: z.boolean().optional(), handles: z.array(z.string()).optional()
    }
  }, async ({ request_id, account_key, kind, list_id, name, description, is_private, handles }) => xListResult(async () => {
    const { accountKey } = await selectedXListAccount();
    if (!accountMatches(accountKey, account_key)) return { ok: false, data: null, error: { code: 'ACCOUNT_MISMATCH', message: '当前浏览器账号与请求账号不一致。' } };
    const db = database();
    try { return prepareXListOperation(db, { requestId: request_id, accountKey: account_key, kind, listId: list_id, name, description, isPrivate: is_private, handles }); }
    finally { db.close(); }
  }));
  server.registerTool('x_lists.collect_timeline', {
    description: '采集当前根已启用 List 的有限最新动态到现有资料库。只操作当前根绑定，不含确认。',
    inputSchema: { account_key: z.string(), list_id: z.string(), limit: z.number().int().min(1).max(50).optional() }
  }, async ({ account_key, list_id, limit }) => xListResult(async () => {
    const { config, accountKey } = await selectedXListAccount();
    if (!accountMatches(accountKey, account_key)) return { ok: false, data: null, error: { code: 'ACCOUNT_MISMATCH', message: '当前浏览器账号与绑定账号不一致。' } };
    const db = database();
    try { return collectBoundXListTimeline(db, config, { accountKey: account_key, listId: list_id, limit }); }
    finally { db.close(); }
  }));
  server.registerTool('x_lists.post_metric_snapshots_list', {
    description: '读取当前根一个 X 资料的真实指标快照。只读，不访问 X 网页。',
    inputSchema: { source_id: z.string(), limit: z.number().int().min(1).max(500).optional() }
  }, async ({ source_id, limit }) => {
    const db = database(); try { return text(listXPostMetricSnapshots(db, source_id, limit)); } finally { db.close(); }
  });
  server.registerTool('x_lists.post_trend_get', {
    description: '按真实快照确定性读取浏览速度和速度变化；数据不足返回稳定原因，不返回热度分。',
    inputSchema: { source_id: z.string() }
  }, async ({ source_id }) => {
    const db = database(); try { return text(getXPostTrend(db, source_id)); } finally { db.close(); }
  });
  server.registerTool('x_lists.observation_start', {
    description: '显式开始当前根已启用 List 的有界趋势观察；只创建固定 15/60/180 分钟窗口。',
    inputSchema: { request_id: z.string(), binding_ids: z.array(z.string()).min(1).max(50) }
  }, async ({ request_id, binding_ids }) => xListResult(async () => {
    const { config } = await selectedXListAccount();
    const db = database(); try { return startXObservationSession(db, config, { requestId: request_id, bindingIds: binding_ids }); } finally { db.close(); }
  }));
  server.registerTool('x_lists.observation_get', {
    description: '读取一个有界 X List 趋势观察 session 及固定窗口状态。',
    inputSchema: { session_id: z.string() }
  }, async ({ session_id }) => {
    const db = database(); try { return text(getXObservationSession(db, session_id)); } finally { db.close(); }
  });
  server.registerTool('x_lists.observation_stop', {
    description: '停止一个有界 X List 趋势观察；当前迟到读取不得写入，剩余窗口不再运行。',
    inputSchema: { session_id: z.string() }
  }, async ({ session_id }) => {
    const db = database(); try { return text(stopXObservationSession(db, session_id)); } finally { db.close(); }
  });
  server.registerTool('knowledge.get_context', {
    description: '按主题、资料或关键词读取历史资料、机会、内容、发布和最终复盘。',
    inputSchema: { topic_id: z.string().optional(), source_id: z.string().optional(), query: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }
  }, async (input) => {
    const db = database(); try { return text(getKnowledgeContext(db, { topicId: input.topic_id, sourceId: input.source_id, query: input.query, limit: input.limit })); } finally { db.close(); }
  });
  server.registerTool('knowledge.domains_list',{
    description:'分页读取长期领域及真实主题、资料和近期变化计数。',
    inputSchema:{query:z.string().optional(),status:z.enum(['active','watching','dormant']).optional(),order:z.enum(['manual','recent','size']).optional(),limit:z.number().int().min(1).max(100).optional(),offset:z.number().int().nonnegative().optional()}
  },async input=>{const db=database();try{return text(listKnowledgeDomains(db,input));}finally{db.close();}});
  server.registerTool('knowledge.domain_get',{
    description:'读取一个领域及完整有界主题页。',
    inputSchema:{domain_id:z.string(),limit:z.number().int().min(1).max(100).optional(),offset:z.number().int().nonnegative().optional()}
  },async({domain_id,...input})=>{const db=database();try{return text(getKnowledgeDomain(db,domain_id,input));}finally{db.close();}});
  server.registerTool('knowledge.topic_dossier_get',{
    description:'分页读取一个长期主题的资料、判断、受众需求、反证、内容、指标、复盘与方法结论。',
    inputSchema:{topic_id:z.string(),category:z.enum(topicDossierCategories).optional(),limit:z.number().int().min(1).max(100).optional(),offset:z.number().int().nonnegative().optional()}
  },async({topic_id,...input})=>{const db=database();try{return text(getKnowledgeTopicDossier(db,{topicId:topic_id,...input}));}finally{db.close();}});
  server.registerTool('knowledge.domain_create',{
    description:'原子创建长期领域和明确主题成员；同一 request_id 重放原结果。',
    inputSchema:{request_id:z.string(),title:z.string(),description:z.string().optional(),status:z.enum(['active','watching','dormant']).optional(),topic_ids:z.array(z.string()).optional()}
  },async({request_id,topic_ids,...input})=>{const db=database();try{
    const tool='knowledge.domain_create',prior=db.prepare('SELECT result_json AS resultJson FROM mcp_request_results WHERE tool=? AND request_id=?').get(tool,request_id) as {resultJson:string}|undefined;
    if(prior)return text(JSON.parse(prior.resultJson));db.exec('BEGIN IMMEDIATE');try{const payload={ok:true,data:createKnowledgeDomain(db,{...input,topicIds:topic_ids},false),error:null};db.prepare('INSERT INTO mcp_request_results(tool,request_id,result_json,created_at) VALUES(?,?,?,?)').run(tool,request_id,JSON.stringify(payload),new Date().toISOString());db.exec('COMMIT');return text(payload);}catch(error){db.exec('ROLLBACK');throw error;}
  }finally{db.close();}});
  server.registerTool('knowledge.domain_update',{
    description:'按 revision 原子更新或归档长期领域；同一 request_id 重放原结果。',
    inputSchema:{request_id:z.string(),id:z.string(),expected_revision:z.number().int(),title:z.string().optional(),description:z.string().optional(),status:z.enum(['active','watching','dormant']).optional(),topic_ids:z.array(z.string()).optional(),archived:z.boolean().optional()}
  },async({request_id,expected_revision,topic_ids,...input})=>{const db=database();try{
    const tool='knowledge.domain_update',prior=db.prepare('SELECT result_json AS resultJson FROM mcp_request_results WHERE tool=? AND request_id=?').get(tool,request_id) as {resultJson:string}|undefined;
    if(prior)return text(JSON.parse(prior.resultJson));db.exec('BEGIN IMMEDIATE');try{const payload={ok:true,data:updateKnowledgeDomain(db,{...input,expectedRevision:expected_revision,topicIds:topic_ids},false),error:null};db.prepare('INSERT INTO mcp_request_results(tool,request_id,result_json,created_at) VALUES(?,?,?,?)').run(tool,request_id,JSON.stringify(payload),new Date().toISOString());db.exec('COMMIT');return text(payload);}catch(error){db.exec('ROLLBACK');throw error;}
  }finally{db.close();}});
  server.registerTool('knowledge.canvas_get', {
    description: '读取一张持久知识画布的真实对象引用、布局和语义关系。',
    inputSchema: { canvas_id: z.string() }
  }, async ({ canvas_id }) => {
    const db = database(); try { return text(getKnowledgeCanvas(db,canvas_id)); } finally { db.close(); }
  });
  server.registerTool('knowledge.context_package_get', {
    description: '读取用户明确保存的静态上下文包及 Pi 实际允许接收的 selected_only manifest；不得扩展到包外对象。',
    inputSchema: { package_id: z.string() }
  }, async ({ package_id }) => {
    const db = database(); try { return text(getKnowledgeContextPackage(db,package_id)); } finally { db.close(); }
  });
  server.registerTool('knowledge.context_packages_list',{
    description:'分页读取可复用静态上下文包及版本、对象、关系和使用计数。',
    inputSchema:{query:z.string().optional(),archived:z.boolean().optional(),limit:z.number().int().min(1).max(100).optional(),offset:z.number().int().nonnegative().optional()}
  },async input=>{const db=database();try{return text(listKnowledgeContextPackages(db,input));}finally{db.close();}});
  server.registerTool('knowledge.context_package_preview',{
    description:'在保存前生成 selected_only 精确清单、排除项与体积门槛。',
    inputSchema:{canvas_id:z.string(),node_ids:z.array(z.string()).min(1),excluded_node_ids:z.array(z.string()).optional(),excluded_relation_ids:z.array(z.string()).optional()}
  },async({canvas_id,node_ids,excluded_node_ids,excluded_relation_ids})=>{const db=database();try{return text(previewKnowledgeContextPackage(db,{canvasId:canvas_id,nodeIds:node_ids,excludedNodeIds:excluded_node_ids,excludedRelationIds:excluded_relation_ids}));}finally{db.close();}});
  server.registerTool('knowledge.suggestion_create',{
    description:'Pi 只创建待用户确认的画布节点或关系建议；同一 request_id 只产生一条建议，不直接写入正式知识。',
    inputSchema:{
      request_id:z.string(),canvas_id:z.string(),kind:z.enum(['node','relation']),
      payload:z.record(z.string(),z.unknown())
    }
  },async({request_id,canvas_id,kind,payload})=>{const db=database();try{
    return text(createKnowledgeSuggestionIdempotent(db,{requestId:request_id,canvasId:canvas_id,kind,payload}));
  }finally{db.close();}});
  server.registerTool('knowledge.creative_brief_get',{
    description:'读取一个静态上下文包版本对应的可编辑创作简报。',
    inputSchema:{package_id:z.string()}
  },async({package_id})=>{const db=database();try{return text(getCreativeBriefForPackage(db,package_id));}finally{db.close();}});
  server.registerTool('knowledge.creative_brief_get_for_context',{
    description:'按画布和直接选择读取最近一份创作简报。',
    inputSchema:{canvas_id:z.string(),node_ids:z.array(z.string()).min(1)}
  },async({canvas_id,node_ids})=>{const db=database();try{return text(getCreativeBriefForContext(db,{canvasId:canvas_id,nodeIds:node_ids}));}finally{db.close();}});
  server.registerTool('knowledge.creative_brief_create',{
    description:'只用当前页或直接选择的画布节点创建一份可编辑简报；同一 request_id 重放同一结果。',
    inputSchema:{request_id:z.string(),canvas_id:z.string(),node_ids:z.array(z.string()).min(1),selection_mode:z.enum(['current_page','selected']),title:z.string(),core_judgment:z.string(),why_now:z.string(),structure:z.array(z.string()).min(1),evidence_node_ids:z.array(z.string())}
  },async({request_id,canvas_id,node_ids,selection_mode,core_judgment,why_now,evidence_node_ids,...input})=>{const db=database();try{
    return text(createCreativeBriefIdempotent(db,{...input,requestId:request_id,canvasId:canvas_id,nodeIds:node_ids,selectionMode:selection_mode,coreJudgment:core_judgment,whyNow:why_now,evidenceNodeIds:evidence_node_ids}));
  }finally{db.close();}});
  server.registerTool('knowledge.creative_brief_update',{
    description:'按 revision 更新已有创作简报；证据仍必须属于原静态包，同一 request_id 重放同一结果。',
    inputSchema:{request_id:z.string(),id:z.string(),expected_revision:z.number().int(),title:z.string(),core_judgment:z.string(),why_now:z.string(),structure:z.array(z.string()).min(1),evidence_node_ids:z.array(z.string()),status:z.enum(['draft','confirmed']).optional()}
  },async({request_id,expected_revision,core_judgment,why_now,evidence_node_ids,...input})=>{const db=database();try{
    return text(updateCreativeBriefIdempotent(db,{...input,requestId:request_id,expectedRevision:expected_revision,coreJudgment:core_judgment,whyNow:why_now,evidenceNodeIds:evidence_node_ids}));
  }finally{db.close();}});
  server.registerTool('knowledge.creative_brief_create_project',{
    description:'从已确认创作简报原子创建内容项目和首版正文，并直接关联所选真实资料；同一 request_id 重放原结果。',
    inputSchema:{request_id:z.string(),brief_id:z.string(),expected_revision:z.number().int()}
  },async({request_id,brief_id,expected_revision})=>{const db=database();try{
    return text(createContentProjectFromBriefIdempotent(db,{requestId:request_id,briefId:brief_id,expectedRevision:expected_revision}));
  }finally{db.close();}});
  server.registerTool('knowledge.creative_brief_lineage_get',{
    description:'从简报双向读取内容项目、发布、指标、复盘和方法结论。',
    inputSchema:{brief_id:z.string()}
  },async({brief_id})=>{const db=database();try{return text(getCreativeBriefLineage(db,brief_id));}finally{db.close();}});
  server.registerTool('knowledge.project_context_packages_get', {
    description:'从内容项目反向读取精确上下文包版本。',
    inputSchema:{project_id:z.string()}
  },async({project_id})=>{const db=database();try{return text(getContentProjectContextPackages(db,project_id));}finally{db.close();}});
  server.registerTool('knowledge.record_batch', {
    description: '把已入库资料归入稳定主题并更新核验/管理状态；同一 request_id 重放原结果。',
    inputSchema: { request_id: z.string(), items: z.array(z.object({
      sourceId: z.string(), topic: z.object({ canonicalKey: z.string().optional(), title: z.string(), kind: z.enum(['theme','event']).optional(), summary: z.string().optional() }),
      relation: z.enum(['primary','supporting','background','contradicting']).optional(),
      verificationStatus: z.enum(['pending','verified','disputed','rejected']).optional(),
      managementStatus: z.enum(['active','watching','expired','archived']).optional()
    })).min(1) }
  }, async ({ request_id, items }) => {
    const db = database();
    try {
      const prior = db.prepare('SELECT result_json AS resultJson FROM mcp_request_results WHERE tool=? AND request_id=?').get('knowledge.record_batch', request_id) as { resultJson: string } | undefined;
      if (prior) return text(JSON.parse(prior.resultJson));
      const payload = { ok: true, data: recordKnowledgeBatch(db, { items }), error: null };
      db.prepare('INSERT INTO mcp_request_results(tool,request_id,result_json,created_at) VALUES(?,?,?,?)').run('knowledge.record_batch', request_id, JSON.stringify(payload), new Date().toISOString());
      return text(payload);
    } finally { db.close(); }
  });
  server.registerTool('content.create', { description: '原子创建内容项目和首个核心版本。新主题必须使用此工具。', inputSchema: { request_id: z.string(), title: z.string(), body: z.string(), plan_item_id: z.string().optional(), source_ids: z.array(z.string()).optional() } }, async ({ request_id, title, body, plan_item_id, source_ids }) => {
    const db = database(); try {
      const prior = db.prepare('SELECT result_json AS resultJson FROM mcp_request_results WHERE tool=? AND request_id=?').get('content.create', request_id) as { resultJson: string } | undefined;
      if (prior) return text(JSON.parse(prior.resultJson));
      db.exec('BEGIN IMMEDIATE'); try { const payload = { ok: true, data: createContentProjectWithVersion(db, { title, body, planItemId: plan_item_id, sourceIds: source_ids }, false), error: null }; db.prepare('INSERT INTO mcp_request_results (tool, request_id, result_json, created_at) VALUES (?, ?, ?, ?)').run('content.create', request_id, JSON.stringify(payload), new Date().toISOString()); db.exec('COMMIT'); return text(payload); } catch (error) { db.exec('ROLLBACK'); throw error; }
    } finally { db.close(); }
  });
  server.registerTool('plans.save', { description: '保存完整当日运营方案。', inputSchema: {
    request_id: z.string(), plan_date: z.string(), summary: z.string(), items: z.array(z.object({
      title: z.string(), priority: z.number().int().min(0).max(7), whyNow: z.string(), timeliness: z.string(), targetAudience: z.string(),
      angle: z.string(), pointOfView: z.string(), platforms: z.array(z.string()), formats: z.array(z.string()),
      titleGuidance: z.string(), openingGuidance: z.string(), structureGuidance: z.string(), effortEstimate: z.string(),
      sourceIds: z.array(z.string()).min(1), availableMaterials: z.array(z.string()).optional(),
      missingMaterials: z.array(z.string()).optional(),
      reviewIds: z.array(z.string()).optional(), methodFindingIds: z.array(z.string()).optional(), topicId: z.string().optional()
    }))
  } }, async ({ request_id, plan_date, summary, items }) => {
    const db = database(); try {
      const prior = db.prepare('SELECT result_json AS resultJson FROM mcp_request_results WHERE tool=? AND request_id=?').get('plans.save', request_id) as { resultJson: string } | undefined;
      if (prior) return text(JSON.parse(prior.resultJson));
      assertPublishingPlatforms(db, items.flatMap((item) => item.platforms));
      db.exec('BEGIN IMMEDIATE'); try { const payload = { ok: true, data: saveCurrentPlan(db, { planDate: plan_date, timezone: 'Asia/Shanghai', summary, items: items as PlanItemInput[] }, false), error: null }; db.prepare('INSERT INTO mcp_request_results (tool, request_id, result_json, created_at) VALUES (?, ?, ?, ?)').run('plans.save', request_id, JSON.stringify(payload), new Date().toISOString()); db.exec('COMMIT'); return text(payload); } catch (error) { db.exec('ROLLBACK'); throw error; }
    } finally { db.close(); }
  });
  server.registerTool('content.save_version', { description: '保存核心或平台版本。', inputSchema: { request_id: z.string(), project_id: z.string(), body: z.string(), content_version_id: z.string().optional(), platform: z.enum(['x', 'xiaohongshu', 'wechat']).optional(), format: z.string().optional(), expected_revision: z.number().optional(), version_id: z.string().optional(), title: z.string().optional() } }, async (input) => {
    const db = database(); try {
      const prior = db.prepare('SELECT result_json AS resultJson FROM mcp_request_results WHERE tool=? AND request_id=?').get('content.save_version', input.request_id) as { resultJson: string } | undefined;
      if (prior) return text(JSON.parse(prior.resultJson));
      if (input.platform) assertPublishingPlatforms(db, [input.platform]);
      db.exec('BEGIN IMMEDIATE'); try {
        const data = input.platform
          ? savePlatformVersion(db, { projectId: input.project_id, contentVersionId: input.content_version_id!, platform: input.platform, format: input.format!, title: input.title, body: input.body, expectedRevision: input.expected_revision, id: input.version_id })
          : typeof input.expected_revision === 'number'
            ? saveCoreVersion(db, { projectId: input.project_id, body: input.body, expectedRevision: input.expected_revision }, false)
            : { ok: false as const, data: null, error: { code: 'VALIDATION_ERROR', message: '核心版本写入必须提供 expected_revision。' } };
        const payload = 'ok' in data ? data : { ok: true, data, error: null };
        db.prepare('INSERT INTO mcp_request_results (tool, request_id, result_json, created_at) VALUES (?, ?, ?, ?)').run('content.save_version', input.request_id, JSON.stringify(payload), new Date().toISOString()); db.exec('COMMIT'); return text(payload);
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } finally { db.close(); }
  });
  server.registerTool('metrics.get', {
    description: '读取发布指标快照。',
    inputSchema: { publication_id: z.string() }
  }, async ({ publication_id }) => {
    const db = database();
    try { return text(listPublicationMetricSnapshots(db, publication_id)); }
    finally { db.close(); }
  });
  server.registerTool('reviews.get', {
    description: '读取复盘与方法结论。',
    inputSchema: { publication_id: z.string().optional(), final_only: z.boolean().optional() }
  }, async ({ publication_id, final_only }) => {
    const db = database();
    try {
      if (final_only) return text(listFinalReviewsAndFindings(db));
      return text(listReviews(db, publication_id));
    } finally { db.close(); }
  });
  server.registerTool('reviews.save', {
    description: '保存或定稿复盘；最终复盘必须引用真实指标快照并包含 Keep/Stop/Change。',
    inputSchema: {
      request_id: z.string(),
      publication_id: z.string(),
      metric_snapshot_ids: z.array(z.string()).min(1),
      keep: z.array(z.string()).optional(),
      stop: z.array(z.string()).optional(),
      change: z.array(z.string()).optional(),
      summary: z.string().optional(),
      status: z.enum(['draft', 'final']).optional(),
      expected_revision: z.number().int().optional(),
      id: z.string().optional(),
      findings: z.array(z.object({ id: z.string().optional(), title: z.string(), body: z.string() })).optional()
    }
  }, async (input) => {
    const db = database();
    try {
      const prior = db.prepare('SELECT result_json AS resultJson FROM mcp_request_results WHERE tool=? AND request_id=?')
        .get('reviews.save', input.request_id) as { resultJson: string } | undefined;
      if (prior) return text(JSON.parse(prior.resultJson));
      const saved = saveReview(db, {
        id: input.id,
        publicationId: input.publication_id,
        metricSnapshotIds: input.metric_snapshot_ids,
        keep: input.keep,
        stop: input.stop,
        change: input.change,
        summary: input.summary,
        status: input.status,
        expectedRevision: input.expected_revision,
        findings: input.findings
      });
      const payload = saved.ok ? { ok: true, data: saved.data, error: null } : { ok: false, data: null, error: saved.error };
      if (saved.ok) {
        db.prepare('INSERT INTO mcp_request_results (tool, request_id, result_json, created_at) VALUES (?, ?, ?, ?)')
          .run('reviews.save', input.request_id, JSON.stringify(payload), new Date().toISOString());
      }
      return text(payload);
    } finally { db.close(); }
  });
  return server;
}

export async function startMcp(rootPath: string, gate?: WorkspaceRuntimeGate, application?: WorkspaceApplicationMcp): Promise<McpRuntime> {
  const handler = toNodeHandler(createMcpHandler(() => createServerFor(rootPath, application)));
  const http = createServer((request, response) => {
    if (request.url?.split('?')[0] !== '/mcp') { response.writeHead(404).end(); return; }
    void (gate ? gate.run(() => handler(request, response)) : handler(request, response)).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead((error as { code?: string }).code === 'WORKSPACE_BUSY' ? 503 : 500);
      if (!response.writableEnded) response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('MCP 服务未取得监听地址。');
  return { url: `http://127.0.0.1:${address.port}/mcp`, close: () => close(http) };
}

function close(http: Server): Promise<void> {
  http.closeAllConnections();
  return new Promise((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
}
