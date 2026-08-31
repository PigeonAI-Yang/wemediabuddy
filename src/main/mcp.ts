import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { McpServer, createMcpHandler, type CallToolResult, type McpHttpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { getContentProject, listContentProjects } from './content.ts';
import { readProjectInvestigation } from './project-investigation.ts';
import { migrateDatabase } from './db/migrations.ts';
import { getToday } from './workbench.ts';
import { getSource, searchSources } from './sources.ts';
import { getWireHealthLedger } from './source-wire-health.ts';
import { listAssets } from './assets.ts';
import { listFinalReviewsAndFindings, listReviews } from './reviews.ts';
import { listPublicationMetricSnapshots } from './metrics.ts';
import * as z from 'zod';
import { getAgentTask } from './agent-tasks.ts';
import { getKnowledgeContext, getKnowledgeDomain, getKnowledgeTopicDossier, listKnowledgeDomains, topicDossierCategories } from './knowledge.ts';
import { runFixedVersionQuery } from './fixed-version-query.ts';
import { registerTopicMaintenanceReadMcp } from './mcp-topic-maintenance.ts';
import { getContentProjectContextPackages, getCreativeBriefForContext, getCreativeBriefForPackage, getCreativeBriefLineage, getKnowledgeCanvas, getKnowledgeContextPackage, listKnowledgeContextPackages, previewKnowledgeContextPackage } from './knowledge-canvas.ts';
import { registerXListTools } from './mcp-x-list.ts';
import type { ActiveWorkspaceRuntime, WorkspaceRuntimeGate } from './workspace-runtime.ts';
import { allowsAiOnlyRoutes } from './workspace-profiles.ts';
import { registerWorkspaceApplicationMcp, type WorkspaceApplicationMcp } from './workspace-mcp.ts';
import { registerIntelligenceChannelsMcp } from './intelligence-channel-mcp.ts';
import { registerResearchWebMcp } from './research-web-read.ts';
import { registerSourceMutationMcp } from './mcp-source-commands.ts';
import { registerTaskGrantMcp } from './mcp-task-grants.ts';
import { registerExecutionGrantMcp } from './mcp-execution-grants.ts';
import { registerBusinessMutationMcp } from './mcp-business-commands.ts';
import { registerJobToolsMcp } from './mcp-job-tools.ts';
import { registerWikiActionsMcp } from './mcp-wiki-actions.ts';
import { continueAfterScan, describeDailyReadiness, runManagerDailyStage } from './manager-orchestration.ts';
import { buildRoleRoster } from './role-roster.ts';
import { shanghaiDate } from './ferment.ts';
import { roleReadTools } from '../shared/agent-capabilities.ts';
import { recordRoleAuthorityBlocked } from './operations.ts';
import { getDailyOrchestrationSchedule, setDailyOrchestrationSchedule } from './daily-orchestration.ts';
import { submitWorkspaceOrchestratorIntent } from './workspace-orchestrator-runtime.ts';
import { dispatchBusinessCommand } from './business-command.ts';
export type McpRuntime = { url: string; close: () => Promise<void> };

/** MCP 统一文本结果形状（全部工具 handler 与读门拦截共用）。 */
const text = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

/** WMB-5170 §6.2：后端 MCP 命令名 → 注册的 WMB 公开工具身份（确定性映射；未登记命令以自身为身份 → fail-closed）。 */
const WMB_TOOL_IDENTITY: Readonly<Record<string, string>> = Object.freeze({
  'context.get_workbench': 'wmb_get_workbench',
  'agent_tasks.get': 'wmb_get_agent_task',
  'task_grants.get': 'wmb_get_task_grant',
  'task_grants.list': 'wmb_list_task_grants',
  'agent_tasks.report_progress': 'wmb_report_agent_progress',
  'sources.search': 'wmb_search_sources',
  'sources.get': 'wmb_get_source',
  'sources.upsert_batch': 'wmb_save_source',
  'plans.save': 'wmb_save_plan',
  'knowledge.get_context': 'wmb_get_knowledge_context',
  'knowledge.fixed_versions_get': 'wmb_get_fixed_versions',
  'knowledge.suggestion_create': 'wmb_suggest_knowledge',
  'sources.lane_gate': 'wmb_judge_sources',
  'sources.lane_restore': 'wmb_restore_source',
  'sources.update_status': 'wmb_update_source_status',
  'knowledge.creative_brief_create': 'wmb_create_creative_brief',
  'knowledge.creative_brief_update': 'wmb_update_creative_brief',
  'knowledge.creative_brief_create_project': 'wmb_create_project_from_brief',
  'knowledge.creative_brief_lineage_get': 'wmb_get_brief_lineage',
  'knowledge.record_batch': 'wmb_record_knowledge',
  'knowledge.topic_maintenance_propose': 'wmb_propose_topic_maintenance',
  'knowledge.topic_maintenance_list': 'wmb_list_topic_maintenance',
  'knowledge.topic_maintenance_get': 'wmb_get_topic_maintenance',
  'content.import_image': 'wmb_import_project_image',
  'content.save_version': 'wmb_save_core_version',
  'content_derivative.save_version': 'wmb_save_video_script',
  'content.create': 'wmb_create_content_project',
  'content.get': 'wmb_get_content',
  'content.list': 'wmb_list_content_projects',
  'investigation.get': 'wmb_get_investigation',
  'investigation.outline_save': 'wmb_save_investigation_outline',
  'investigation.review_research': 'wmb_review_investigation_research',
  'investigation.direction_save': 'wmb_save_investigation_direction',
  'metrics.get': 'wmb_get_metrics',
  'reviews.get': 'wmb_get_reviews',
  'reviews.save': 'wmb_save_review',
  'x_lists.read_index': 'wmb_read_x_list_index',
  'x_lists.read_detail': 'wmb_read_x_list_detail',
  'x_lists.read_members': 'wmb_read_x_list_members',
  'x_lists.read_timeline': 'wmb_read_x_list_timeline',
  'x_lists.list_bindings': 'wmb_list_x_list_bindings',
  'x_lists.get_operation': 'wmb_get_x_list_operation',
  'x_lists.prepare': 'wmb_prepare_x_list_operation',
  'x_lists.members_add': 'wmb_add_x_list_members',
  'x_lists.create': 'wmb_create_x_list',
  'x_lists.members_remove': 'wmb_remove_x_list_members',
  'x_lists.collect_timeline': 'wmb_collect_x_list_timeline',
  'x_lists.post_metric_snapshots_list': 'wmb_list_x_post_metric_snapshots',
  'x_lists.post_trend_get': 'wmb_get_x_post_trend',
  'x_lists.observation_start': 'wmb_start_x_list_observation',
  'x_lists.observation_get': 'wmb_get_x_list_observation',
  'x_lists.observation_stop': 'wmb_stop_x_list_observation',
  'wiki.maintenance_start': 'wmb_wiki_maintenance_start',
  'wiki.maintenance_status': 'wmb_wiki_maintenance_status',
  'wiki.maintenance_pause': 'wmb_wiki_maintenance_pause',
  'wiki.maintenance_resume': 'wmb_wiki_maintenance_resume',
  'wiki.maintenance_report': 'wmb_wiki_maintenance_report',
  'wiki.ingest': 'wmb_wiki_ingest',
  'wiki.lint': 'wmb_wiki_lint',
  'wiki.search': 'wmb_wiki_search',
  'wiki.log': 'wmb_wiki_log',
  'wiki.report': 'wmb_wiki_report',
  'agents.roster': 'wmb_list_agents_roster',
  'jobs.list': 'wmb_list_jobs',
  'jobs.get': 'wmb_get_job',
  'jobs.spawn': 'wmb_spawn_job',
  'jobs.cancel': 'wmb_cancel_job',
  'jobs.message': 'wmb_message_job',
  'jobs.messages': 'wmb_list_job_messages',
  'research.dispatch': 'wmb_dispatch_research',
  'daily.readiness': 'wmb_daily_readiness',
  'daily.continue_after_scan': 'wmb_continue_after_scan',
  'daily.run_stage': 'wmb_run_daily_stage',
  'intelligence_channels.get': 'wmb_get_intelligence_channels',
  'intelligence_channels.receipts_list': 'wmb_list_intelligence_channel_receipts',
  'intelligence_channels.resolve_website': 'wmb_resolve_intelligence_website',
  'intelligence_channels.trial_website': 'wmb_trial_intelligence_website',
  'intelligence_channels.resolve_x_list': 'wmb_resolve_intelligence_x_list',
  'intelligence_channels.proposals.prepare': 'wmb_prepare_intelligence_channel_changes',
  'workspaces.list': 'wmb_list_workspaces',
  'workspaces.get_current': 'wmb_get_current_workspace',
  'workspaces.catalog': 'wmb_list_workspace_catalog',
  'workspaces.proposals.prepare': 'wmb_prepare_workspace_profile',
  'research.search_web': 'wmb_search_web',
  'research.read_web_page': 'wmb_read_web_page',
  'plan_item.get': 'wmb_get_plan_item',
  'plan_item.submit': 'wmb_submit_plan_item',
  'xhs_check_login_status': 'xhs_check_login_status',
  'xhs_search_feeds': 'xhs_search_feeds',
  'xhs_get_feed_detail': 'xhs_get_feed_detail',
  'xhs_user_profile': 'xhs_user_profile'
});
/** WMB-5170 §6.2：research 会话读白名单 = roleReadTools('reporter') + 基础设施 + 唯一写回。 */
const RESEARCH_READ_ALLOWED: ReadonlySet<string> = new Set([
  ...roleReadTools('reporter'),
  'wmb_get_agent_task',
  'wmb_report_agent_progress',
  'wmb_save_source'
]);

const RESEARCH_READ_BLOCK_CODE = 'READ_PROFILE_BLOCKED' as const;
const RESEARCH_READ_BLOCK_REASON = 'RESEARCH_READ_WHITELIST' as const;

/**
 * WMB-5170 评审修复：客户端身份接缝只认 `_meta.{taskId, workerLeaseId}` 两个精确键
 * （忽略调用方塞入的其余元数据）；任一键缺失/空 → 对应字段为 null（research 会话的
 * lease 缺失即 fail closed，不再放行 taskId-only 旧通道）。
 */
function researchTaskMeta(ctx: unknown): Readonly<{ taskId: string | null; workerLeaseId: string | null }> {
  const meta = (ctx as { mcpReq?: { _meta?: { taskId?: unknown; workerLeaseId?: unknown } } } | undefined)?.mcpReq?._meta;
  const taskId = typeof meta?.taskId === 'string' && meta.taskId.trim() ? meta.taskId : null;
  const workerLeaseId = typeof meta?.workerLeaseId === 'string' && meta.workerLeaseId.trim() ? meta.workerLeaseId : null;
  return Object.freeze({ taskId, workerLeaseId });
}

/**
 * WMB-5170 §6.2 读硬门（评审修复）：research 会话（taskId → agent_tasks.intent='research'）
 * 必须携带当前运行时 `runtime.isCurrentWorkerLease(workerLeaseId, taskId)` 的活 lease——
 * lease 缺失/过期/伪造一律 fail closed（READ_PROFILE_BLOCKED + role_authority_blocked 审计，
 * reason 与白名单拦截同值，均在 handler 之前返回）；lease 有效才应用
 * roleReadTools('reporter') + 基础设施 + wmb_save_source 白名单。无任务 / 非 research 返回 null（老路径零回归）。
 */
function researchReadGate(database: () => DatabaseSync, command: string, ctx: unknown, runtime?: ActiveWorkspaceRuntime): CallToolResult | null {
  const { taskId, workerLeaseId } = researchTaskMeta(ctx);
  if (!taskId) return null;
  const db = database();
  let intent: string | null = null;
  try {
    const row = db.prepare('SELECT intent FROM agent_tasks WHERE id = ?').get(taskId) as { intent?: string } | undefined;
    intent = row?.intent ?? null;
  } finally {
    db.close();
  }
  if (intent !== 'research') return null;
  const blocked = (): CallToolResult => {
    const auditDb = database();
    try {
      recordRoleAuthorityBlocked(auditDb, { role: 'reporter', command, taskId, reason: RESEARCH_READ_BLOCK_REASON });
    } finally {
      auditDb.close();
    }
    return text({ ok: false, data: null, error: { code: RESEARCH_READ_BLOCK_CODE, message: '研究会话仅允许白名单读工具。', details: { reason: RESEARCH_READ_BLOCK_REASON } } });
  };
  if (!workerLeaseId || !runtime || !runtime.isCurrentWorkerLease(workerLeaseId, taskId)) return blocked();
  const identity = WMB_TOOL_IDENTITY[command] ?? command;
  if (RESEARCH_READ_ALLOWED.has(identity)) return null;
  return blocked();
}

function createServerFor(rootPath: string, application?: WorkspaceApplicationMcp, runtime?: ActiveWorkspaceRuntime): McpServer {
  const server = new McpServer({ name: 'wemedia-buddy', version: '0.1.0' });
  const database = () => migrateDatabase(path.join(rootPath, 'wmb.db'));
  // WMB-5170 §6.2：MCP 读工具 dispatch 预门——所有工具注册都经研究白名单检查（非 research 零回归）。
  type RegisterTool = McpServer['registerTool'];
  const registerTool = server.registerTool.bind(server) as RegisterTool;
  (server as unknown as { registerTool: RegisterTool }).registerTool = ((name: string, config: Parameters<RegisterTool>[1], handler: Parameters<RegisterTool>[2]) => {
    const gated = config.inputSchema
      ? (args: unknown, ctx: unknown) => {
          const blocked = researchReadGate(database, name, ctx, runtime);
          if (blocked) return blocked;
          return (handler as (a: unknown, c: unknown) => unknown)(args, ctx);
        }
      : (ctx: unknown) => {
          const blocked = researchReadGate(database, name, ctx, runtime);
          if (blocked) return blocked;
          return (handler as (c: unknown) => unknown)(ctx);
        };
    return registerTool(name, config, gated as never);
  }) as RegisterTool;
  const profileDatabase = database();
  let aiOnlyRoutes = false;
  try {
    aiOnlyRoutes = allowsAiOnlyRoutes(profileDatabase);
  } catch (error) {
    // requireWorkspaceProfile throws OFFICIAL_PACK_UNAVAILABLE only when the root has no
    // effective workspace profile (fresh/unconfigured root) — fail-closed to no AI-only routes.
    // Any other error is unexpected and must propagate, not be swallowed.
    if ((error as { code?: string }).code !== 'OFFICIAL_PACK_UNAVAILABLE') throw error;
  } finally {
    profileDatabase.close();
  }

  if (application) registerWorkspaceApplicationMcp(server, rootPath, application);
  if (application?.channelProposals) registerIntelligenceChannelsMcp(server, rootPath, application);
  if (runtime) {
    registerSourceMutationMcp(server, runtime);
    registerBusinessMutationMcp(server, runtime);
  }
  registerTaskGrantMcp(server, database, runtime);
  registerExecutionGrantMcp(server, database, runtime);
  registerTopicMaintenanceReadMcp(server, database);
  registerResearchWebMcp(server);
  registerWikiActionsMcp(server, database, runtime);

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
  server.registerTool('investigation.get', {
    description: 'WMB-5290 读取一个内容项目的专项调查（状态、当前提纲版本与审批状态、记者工单、调查资料包、写作方向与历史流水）。只读；不含来源正文。',
    inputSchema: { project_id: z.string() }
  }, async ({ project_id }) => {
    const db = database(); try { return text(readProjectInvestigation(db, project_id)); } finally { db.close(); }
  });
  server.registerTool('assets.list', { description: '读取已导入素材元数据。' }, async () => {
    const db = database();
    try { return text(listAssets(db)); } finally { db.close(); }
  });
  server.registerTool('sources.get', { description: '按 ID 读取完整资料。', inputSchema: { id: z.string() } }, async ({ id }) => {
    const db = database(); try { return text(getSource(db, id)); } finally { db.close(); }
  });
  server.registerTool('sources.search', {
    description: '搜索并读取完整资料字段。默认只返回有效资料（未移出）；传 include_archived=true 可含已移出条目。',
    inputSchema: { query: z.string().optional(), limit: z.number().int().min(1).max(200).optional(), include_archived: z.boolean().optional() }
  }, async ({ query, limit, include_archived }) => {
    const db = database(); try { return text(searchSources(db, query, limit, Boolean(include_archived))); } finally { db.close(); }
  });
  if (aiOnlyRoutes) server.registerTool('sources.wire_health_get', {
    description: '读取最近一次今日情报导线巡检健康台账（按 registry/X List 源）。',
    inputSchema: { business_date: z.string().optional() }
  }, async ({ business_date }) => {
    const db = database();
    try { return text(getWireHealthLedger(db, { businessDate: business_date })); }
    finally { db.close(); }
  });
  registerXListTools(server, database, runtime);
  server.registerTool('knowledge.get_context', {
    description: '按主题、资料或关键词读取历史资料、机会、内容、发布和最终复盘。',
    inputSchema: { topic_id: z.string().optional(), source_id: z.string().optional(), query: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }
  }, async (input) => {
    const db = database(); try { return text(getKnowledgeContext(db, { topicId: input.topic_id, sourceId: input.source_id, query: input.query, limit: input.limit })); } finally { db.close(); }
  });
  server.registerTool('knowledge.fixed_versions_get', {
    description: '按固定版本引用或版本 ID 读取冻结 Wiki 页版本 / Note 版本 / Evidence（只读；版本删除、归属漂移或跨 workspace 一律 fail-closed 返回错误，零部分结果）。支持自然语言「基于这些版本回答」：先用本工具读取指定固定版本，再基于返回内容回答并在末条回复携带 wmb_query_writeback 清单。',
    inputSchema: {
      wiki_version_refs: z.array(z.string()).max(64).optional(),
      note_version_refs: z.array(z.string()).max(64).optional(),
      evidence_refs: z.array(z.string()).max(64).optional(),
      wiki_version_ids: z.array(z.string()).max(64).optional(),
      note_version_ids: z.array(z.string()).max(64).optional(),
      evidence_ids: z.array(z.string()).max(64).optional(),
      question: z.string().optional()
    }
  }, async (input) => {
    const db = database(); try { return text(runFixedVersionQuery(db, {
      wikiVersionRefs: input.wiki_version_refs,
      noteVersionRefs: input.note_version_refs,
      evidenceRefs: input.evidence_refs,
      wikiVersionIds: input.wiki_version_ids,
      noteVersionIds: input.note_version_ids,
      evidenceIds: input.evidence_ids,
      question: input.question
    })); } finally { db.close(); }
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
  server.registerTool('knowledge.creative_brief_get',{
    description:'读取一个静态上下文包版本对应的可编辑创作简报。',
    inputSchema:{package_id:z.string()}
  },async({package_id})=>{const db=database();try{return text(getCreativeBriefForPackage(db,package_id));}finally{db.close();}});
  server.registerTool('knowledge.creative_brief_get_for_context',{
    description:'按画布和直接选择读取最近一份创作简报。',
    inputSchema:{canvas_id:z.string(),node_ids:z.array(z.string()).min(1)}
  },async({canvas_id,node_ids})=>{const db=database();try{return text(getCreativeBriefForContext(db,{canvasId:canvas_id,nodeIds:node_ids}));}finally{db.close();}});
  server.registerTool('knowledge.creative_brief_lineage_get',{
    description:'从简报双向读取内容项目、发布、指标、复盘和方法结论。',
    inputSchema:{brief_id:z.string()}
  },async({brief_id})=>{const db=database();try{return text(getCreativeBriefLineage(db,brief_id));}finally{db.close();}});
  server.registerTool('knowledge.project_context_packages_get', {
    description:'从内容项目反向读取精确上下文包版本。',
    inputSchema:{project_id:z.string()}
  },async({project_id})=>{const db=database();try{return text(getContentProjectContextPackages(db,project_id));}finally{db.close();}});
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
  
  // 主管编排：读班组 / 派工 / 传话（desk manager tools）
  server.registerTool('agents.roster', {
    description: '读取固定角色班组投影状态（主管/记者/策划/写手/资料员）与摘要进度。只读。',
    inputSchema: { business_date: z.string().optional() }
  }, async ({ business_date }) => {
    const db = database();
    try {
      const workers = runtime?.getWorkerSnapshots?.() ?? [];
      const worker = runtime?.getWorkerSnapshot() ?? null;
      return text(buildRoleRoster(db, {
        businessDate: business_date || shanghaiDate(),
        worker,
        workers
      }));
    } finally { db.close(); }
  });

  if (runtime) {
    registerJobToolsMcp(server, runtime, database);
    server.registerTool('daily.readiness', {
      description: '读取当前 workspace 的 Actor、startup gate 与 ManagerAdapter 权威投影。只读。',
      inputSchema: { business_date: z.string().optional() }
    }, async ({ business_date }) => {
      return text(describeDailyReadiness(runtime, business_date || undefined));
    });
    server.registerTool('daily.continue_after_scan', {
      description: '提交带 predecessor intent/root identity 的 typed judge intent；缺少身份时由 Actor 网关拒绝。',
      inputSchema: {
        request_id: z.string().min(1),
        business_date: z.string().optional(),
        predecessor_intent_id: z.string().min(1),
        root_request_id: z.string().min(1),
        orchestration_id: z.string().optional(),
        stage_request_id: z.string().optional(),
        scope_hash: z.string().optional(),
        projection_hash: z.string().optional(),
        eligible_ids_hash: z.string().optional()
      }
    }, async ({ request_id, business_date, predecessor_intent_id, root_request_id, orchestration_id, stage_request_id, scope_hash, projection_hash, eligible_ids_hash }) => {
      return text(await continueAfterScan({
        runtime,
        requestId: request_id,
        businessDate: business_date,
        predecessorIntentId: predecessor_intent_id,
        rootRequestId: root_request_id,
        orchestrationId: orchestration_id,
        stageRequestId: stage_request_id,
        scopeHash: scope_hash,
        projectionHash: projection_hash,
        eligibleIdsHash: eligible_ids_hash
      }));
    });
    server.registerTool('daily.run_stage', {
      description: '提交 typed daily intent。stage=scan、judge 或 full。',
      inputSchema: {
        request_id: z.string().min(1),
        stage: z.enum(['scan', 'judge', 'full']),
        business_date: z.string().optional(),
        modules: z.array(z.enum(['official_web', 'x_lists'])).optional()
      }
    }, async ({ request_id, stage, business_date, modules }) => {
      return text(await runManagerDailyStage({
        runtime,
        requestId: request_id,
        stage,
        businessDate: business_date,
        modules
      }));
    });
    server.registerTool('daily.orchestrate', {
      description: '提交 typed Stage D daily intent。',
      inputSchema: { request_id: z.string().min(1), business_date: z.string().optional() }
    }, async ({ request_id, business_date }) => {
      return text(await submitWorkspaceOrchestratorIntent(runtime, {
        producerId: 'mcp.daily-orchestrate',
        businessDate: business_date?.trim() || shanghaiDate(),
        requestId: request_id,
        action: 'stage_d',
        logicalInput: { source: 'mcp', action: 'stage_d' },
        payload: { source: 'mcp', action: 'stage_d' },
        rootMode: 'owner'
      }));
    });
    server.registerTool('daily.orchestration_schedule_get', {
      description: '读取每日编排调度时间与自动开关（Asia/Shanghai）。只读。',
      inputSchema: {}
    }, async () => {
      const db = database();
      try { return text(getDailyOrchestrationSchedule(db)); } finally { db.close(); }
    });
    server.registerTool('daily.orchestration_schedule_set', {
      description: '设置每日编排调度时间与自动开关。',
      inputSchema: { time: z.string().optional(), auto_enabled: z.boolean().optional() }
    }, async ({ time, auto_enabled }) => {
      const receipt = await dispatchBusinessCommand(runtime, {
        command: 'daily_orchestration.set_schedule',
        requestId: randomUUID(),
        actor: { type: 'external_agent', id: 'mcp', label: 'MCP' },
        input: { time: time ?? undefined, autoEnabled: auto_enabled ?? undefined },
        boundIdentity: {},
        entityType: 'daily_orchestration',
        execute: (database, input) => {
          const result = setDailyOrchestrationSchedule(database, input);
          return { data: result, entityId: 'schedule', readback: result };
        }
      });
      return text(receipt);
    });

  }

return server;
}
export async function startMcp(rootPath: string, gate?: WorkspaceRuntimeGate, application?: WorkspaceApplicationMcp, runtime?: ActiveWorkspaceRuntime): Promise<McpRuntime> {
  const mcpHandler = createMcpHandler(() => createServerFor(rootPath, application, runtime));
  const handler = toNodeHandler(mcpHandler);
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
  return { url: `http://127.0.0.1:${address.port}/mcp`, close: () => closeMcp(mcpHandler, http) };
}

/** Stop accepting traffic, then release in-flight MCP sessions and the HTTP server — both close even if one throws. */
async function closeMcp(mcpHandler: McpHttpHandler, http: Server): Promise<void> {
  http.closeAllConnections();
  const httpClosed = new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
  try {
    await mcpHandler.close();
  } finally {
    await httpClosed;
  }
}
