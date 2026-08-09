import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { getContentProject, listContentProjects } from './content.ts';
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
import { getContentProjectContextPackages, getCreativeBriefForContext, getCreativeBriefForPackage, getCreativeBriefLineage, getKnowledgeCanvas, getKnowledgeContextPackage, listKnowledgeContextPackages, previewKnowledgeContextPackage } from './knowledge-canvas.ts';
import { getXListOperation, listXListBindings, prepareXListOperation, type PrepareXListOperationInput } from './x-lists.ts';
import { collectBoundXListTimeline } from './x-list-execution.ts';
import { selectedXListBrowser as resolveSelectedXListBrowser } from './x-list-context.ts';
import { readXListDetail, readXListIndex, readXListMembers, readXListTimeline } from './platforms/x-list-browser.ts';
import { XListNeedsUserError } from './platforms/x-list-session.ts';
import type { ActiveWorkspaceRuntime, WorkspaceRuntimeGate } from './workspace-runtime.ts';
import { allowsAiOnlyRoutes } from './workspace-profiles.ts';
import { registerWorkspaceApplicationMcp, type WorkspaceApplicationMcp } from './workspace-mcp.ts';
import { registerIntelligenceChannelsMcp } from './intelligence-channel-mcp.ts';
import { getXPostTrend, listXPostMetricSnapshots } from './x-post-metrics.ts';
import { getXObservationSession, persistXObservationSessionStart, readXObservationSessionStart, stopXObservationSession } from './x-observation-jobs.ts';
import { registerSourceMutationMcp } from './mcp-source-commands.ts';
import { registerTaskGrantMcp } from './mcp-task-grants.ts';
import { assertTaskGrantForEnvelope } from './task-grants.ts';
import { createCommandEnvelope } from './command-dispatcher.ts';
import { registerExecutionGrantMcp } from './mcp-execution-grants.ts';
import { registerBusinessMutationMcp } from './mcp-business-commands.ts';
import { dispatchBusinessCommand, requireCommandResultData } from './business-command.ts';
import { registerJobToolsMcp } from './mcp-job-tools.ts';
import { continueAfterScan, describeDailyReadiness, runManagerDailyStage } from './manager-orchestration.ts';
import { buildRoleRoster } from './role-roster.ts';
import { shanghaiDate } from './ferment.ts';
export type McpRuntime = { url: string; close: () => Promise<void> };
const text = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
function createServerFor(rootPath: string, application?: WorkspaceApplicationMcp, runtime?: ActiveWorkspaceRuntime): McpServer {
  const server = new McpServer({ name: 'wemedia-buddy', version: '0.1.0' });
  const database = () => migrateDatabase(path.join(rootPath, 'wmb.db'));
  const profileDatabase = database();
  const aiOnlyRoutes = allowsAiOnlyRoutes(profileDatabase);
  profileDatabase.close();

  if (application) registerWorkspaceApplicationMcp(server, rootPath, application);
  if (application?.channelProposals) registerIntelligenceChannelsMcp(server, rootPath, application);
  if (runtime) {
    registerSourceMutationMcp(server, runtime);
    registerBusinessMutationMcp(server, runtime);
  }
  registerTaskGrantMcp(server, database, runtime);
  registerExecutionGrantMcp(server, database, runtime);

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
  const selectedXListBrowser = async () => {
    const db = database();
    try {
      const workspaceId = (db.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get() as { value?: string } | undefined)?.value;
      if (!workspaceId) throw Object.assign(new Error('当前工作空间身份缺失。'), { code: 'BROWSER_NEEDS_USER' });
      const config = await resolveSelectedXListBrowser(db);
      return { ...config, workspaceId };
    } finally { db.close(); }
  };
  const xListResult = async <T>(work: () => Promise<T>) => {
    try { return text(await work()); }
    catch (error) { const explicit = (error as { code?: string })?.code; const code = explicit ?? (error instanceof XListNeedsUserError ? 'BROWSER_NEEDS_USER' : error instanceof Error && error.name === 'XListSupersededError' ? 'INVALID_STATE' : 'VALIDATION_ERROR'); return text({ ok: false, data: null, error: { code, message: error instanceof Error ? error.message : String(error), details: { state: code === 'BROWSER_NEEDS_USER' || code === 'ACCOUNT_MISMATCH' ? 'needs_user' : 'failed' } } }); }
  };
  const selectedXListAccount = async () => {
    const config = await selectedXListBrowser();
    const index = await readXListIndex(config);
    return { config: { ...config, accountKey: index.accountKey }, accountKey: index.accountKey };
  };
  const prepareAgentXListOperation = async (input: PrepareXListOperationInput & { taskId: string; taskGrantId: string; workerLeaseId?: string }) => {
    if (!runtime) throw Object.assign(new Error('当前工作空间运行时不可用。'), { code: 'WORKSPACE_BUSY' });
    const actor = input.workerLeaseId
      ? { type: 'pi' as const, id: 'pi', label: 'Pi worker' }
      : { type: 'external_agent' as const, id: 'mcp', label: 'External Agent' };
    const envelope = createCommandEnvelope({
      workspaceId: runtime.identity.workspaceId,
      runtimeEpoch: runtime.identity.runtimeEpoch,
      command: 'x_lists.operation_execute',
      requestId: input.requestId,
      input,
      boundIdentity: { accountKey: input.accountKey, kind: input.kind, listId: input.listId ?? null },
      actor,
      taskId: input.taskId,
      workerLeaseId: input.workerLeaseId,
      grantId: input.taskGrantId
    });
    return runtime.runAtomic(() => {
      assertTaskGrantForEnvelope(runtime.database, envelope, new Date(), (leaseId, taskId) => runtime.isCurrentWorkerLease(leaseId, taskId));
      return prepareXListOperation(runtime.database, { ...input, preparedActor: actor });
    });
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
  }, async ({ account_key }) => xListResult(async () => { const db = database(); try { return listXListBindings(db, account_key); } finally { db.close(); } }));
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
  const agentXAuthoritySchema = {
    task_id: z.string().min(1).describe('Owner签发且当前active的task grant所属任务。'),
    grant_id: z.string().min(1).describe('允许x_lists.operation_execute的当前task grant。'),
    worker_lease_id: z.string().min(1).optional().describe('Pi必须传当前worker lease；外部Agent省略。')
  };
  const prepareAgentX = async (input: PrepareXListOperationInput & { taskId: string; taskGrantId: string; workerLeaseId?: string }) => {
    const { accountKey } = await selectedXListAccount();
    if (!accountMatches(accountKey, input.accountKey)) return { ok: false, data: null, error: { code: 'ACCOUNT_MISMATCH', message: '当前浏览器账号与请求账号不一致。' } };
    return prepareAgentXListOperation(input);
  };
  server.registerTool('x_lists.prepare', {
    description: '准备精确 X List 操作。只写提议，不执行浏览器动作；Owner必须在 WMB UI 针对此冻结操作签发单用途授权并确认。',
    inputSchema: { request_id: z.string(), account_key: z.string(), kind: z.enum(['create', 'update', 'delete', 'members_add', 'members_remove']), list_id: z.string().optional(),
      name: z.string().optional(), description: z.string().optional(), is_private: z.boolean().optional(), handles: z.array(z.string()).optional(), ...agentXAuthoritySchema }
  }, async ({ request_id, account_key, kind, list_id, name, description, is_private, handles, task_id, grant_id, worker_lease_id }) => xListResult(async () =>
    prepareAgentX({ requestId: request_id, accountKey: account_key, kind, listId: list_id, name, description, isPrivate: is_private, handles, taskId: task_id, taskGrantId: grant_id, workerLeaseId: worker_lease_id })));
  server.registerTool('x_lists.members_add', {
    description: '准备添加 X List 成员；不会执行平台写入。返回操作必须等待 Owner 在 WMB UI 精确确认。',
    inputSchema: { request_id: z.string(), account_key: z.string(), list_id: z.string(), handles: z.array(z.string()).min(1).max(100), ...agentXAuthoritySchema }
  }, async ({ request_id, account_key, list_id, handles, task_id, grant_id, worker_lease_id }) => xListResult(async () =>
    prepareAgentX({ requestId: request_id, accountKey: account_key, kind: 'members_add', listId: list_id, handles, taskId: task_id, taskGrantId: grant_id, workerLeaseId: worker_lease_id })));
  server.registerTool('x_lists.create', {
    description: '准备新建 X List；不会执行平台写入。返回操作必须等待 Owner 在 WMB UI 精确确认。',
    inputSchema: { request_id: z.string(), account_key: z.string(), name: z.string().min(1), description: z.string().optional(), is_private: z.boolean().optional(), ...agentXAuthoritySchema }
  }, async ({ request_id, account_key, name, description, is_private, task_id, grant_id, worker_lease_id }) => xListResult(async () =>
    prepareAgentX({ requestId: request_id, accountKey: account_key, kind: 'create', name, description, isPrivate: is_private, taskId: task_id, taskGrantId: grant_id, workerLeaseId: worker_lease_id })));
  server.registerTool('x_lists.members_remove', {
    description: '准备移除 X List 成员；不会执行平台写入。返回操作必须等待 Owner 在 WMB UI 精确确认。',
    inputSchema: { request_id: z.string(), account_key: z.string(), list_id: z.string(), handles: z.array(z.string()).min(1).max(100), ...agentXAuthoritySchema }
  }, async ({ request_id, account_key, list_id, handles, task_id, grant_id, worker_lease_id }) => xListResult(async () =>
    prepareAgentX({ requestId: request_id, accountKey: account_key, kind: 'members_remove', listId: list_id, handles, taskId: task_id, taskGrantId: grant_id, workerLeaseId: worker_lease_id })));
  server.registerTool('x_lists.collect_timeline', {
    description: '采集当前根已启用 List 的有限最新动态到现有资料库。只操作当前根绑定，不含确认。',
    inputSchema: { account_key: z.string(), list_id: z.string(), limit: z.number().int().min(1).max(50).optional() }
  }, async ({ account_key, list_id, limit }) => xListResult(async () => {
    const { config, accountKey } = await selectedXListAccount();
    if (!accountMatches(accountKey, account_key)) return { ok: false, data: null, error: { code: 'ACCOUNT_MISMATCH', message: '当前浏览器账号与绑定账号不一致。' } };
    const db = database();
    try { return await collectBoundXListTimeline(db, config, { accountKey: account_key, listId: list_id, limit }); }
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
    inputSchema: { request_id: z.string(), task_id: z.string(), grant_id: z.string(), worker_lease_id: z.string().optional(), binding_ids: z.array(z.string()).min(1).max(50) }
  }, async ({ request_id, task_id, grant_id, worker_lease_id, binding_ids }) => xListResult(async () => {
    if (!runtime) throw Object.assign(new Error('当前工作空间运行时不可用。'), { code: 'WORKSPACE_BUSY' });
    const { config } = await selectedXListAccount();
    const readResult = await readXObservationSessionStart(runtime.database, config, { requestId: request_id, bindingIds: binding_ids });
    return dispatchBusinessCommand(runtime, {
      command: 'x_lists.observation_start', requestId: request_id,
      actor: { type: 'external_agent', id: 'mcp', label: 'External Agent' },
      input: { bindingIds: binding_ids },
      boundIdentity: { browserId: config.id, accountKey: config.accountKey ?? null, bindingIds: [...new Set(binding_ids)].sort() },
      taskId: task_id, workerLeaseId: worker_lease_id, grantId: grant_id, entityType: 'x_observation_session',
      execute: (database) => {
        const read = requireCommandResultData(readResult);
        const data = requireCommandResultData(persistXObservationSessionStart(database, config, read));
        return { data, entityId: data.id, readback: data };
      }
    });
  }));
  server.registerTool('x_lists.observation_get', {
    description: '读取一个有界 X List 趋势观察 session 及固定窗口状态。',
    inputSchema: { session_id: z.string() }
  }, async ({ session_id }) => {
    const db = database(); try { return text(getXObservationSession(db, session_id)); } finally { db.close(); }
  });
  server.registerTool('x_lists.observation_stop', {
    description: '停止一个有界 X List 趋势观察；当前迟到读取不得写入，剩余窗口不再运行。',
    inputSchema: { request_id: z.string(), task_id: z.string(), grant_id: z.string(), worker_lease_id: z.string().optional(), session_id: z.string() }
  }, async ({ request_id, task_id, grant_id, worker_lease_id, session_id }) => xListResult(async () => {
    if (!runtime) throw Object.assign(new Error('当前工作空间运行时不可用。'), { code: 'WORKSPACE_BUSY' });
    return dispatchBusinessCommand(runtime, {
      command: 'x_lists.observation_stop', requestId: request_id,
      actor: { type: 'external_agent', id: 'mcp', label: 'External Agent' }, input: { sessionId: session_id },
      boundIdentity: { sessionId: session_id }, taskId: task_id, workerLeaseId: worker_lease_id, grantId: grant_id,
      entityType: 'x_observation_session',
      execute: (database, normalized) => {
        const data = stopXObservationSession(database, normalized.sessionId);
        return { data, entityId: normalized.sessionId, readback: data };
      }
    });
  }));
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
    description: '读取固定角色班组席位状态（主管/记者/策划/写手/资料员）与摘要进度。只读。',
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
      description: '读取今日扫/判就绪状态与建议下一阶段。只读；是否续接由主管决定并调用 continue/run_stage/spawn。',
      inputSchema: { business_date: z.string().optional() }
    }, async ({ business_date }) => {
      return text(describeDailyReadiness(runtime, business_date || undefined));
    });
    server.registerTool('daily.continue_after_scan', {
      description: '主管工具：在扫描完成后显式续接策划（自动编排续接能力的可控入口）。认为该续就调；认为只要单项采集就不要调。',
      inputSchema: { business_date: z.string().optional() }
    }, async ({ business_date }) => {
      const mcp = runtime.getMcp<McpRuntime>();
      if (!mcp?.url) return text({ ok: false, error: 'MCP_UNAVAILABLE' });
      try {
        return text(await continueAfterScan({
          runtime,
          dataRootPath: runtime.identity.rootPath,
          mcpUrl: mcp.url,
          xhsMcpUrl: '',
          businessDate: business_date
        }));
      } catch (error) {
        return text({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
    server.registerTool('daily.run_stage', {
      description: '主管启动今日情报阶段。stage=scan 单项采集；stage=judge 单项策划；stage=full 一条龙。自动编排能力由主管选用，不是禁用。',
      inputSchema: {
        stage: z.enum(['scan', 'judge', 'full']),
        business_date: z.string().optional(),
        modules: z.array(z.enum(['official_web', 'x_lists'])).optional()
      }
    }, async ({ stage, business_date, modules }) => {
      const mcp = runtime.getMcp<McpRuntime>();
      if (!mcp?.url) return text({ ok: false, error: 'MCP_UNAVAILABLE' });
      try {
        const result = await runManagerDailyStage({
          runtime,
          dataRootPath: runtime.identity.rootPath,
          mcpUrl: mcp.url,
          xhsMcpUrl: '',
          stage,
          businessDate: business_date,
          modules
        });
        return text(result);
      } catch (error) {
        return text({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });

  }

return server;
}

export async function startMcp(rootPath: string, gate?: WorkspaceRuntimeGate, application?: WorkspaceApplicationMcp, runtime?: ActiveWorkspaceRuntime): Promise<McpRuntime> {
  const handler = toNodeHandler(createMcpHandler(() => createServerFor(rootPath, application, runtime)));
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
