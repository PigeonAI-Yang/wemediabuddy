/**
 * X List MCP 工具面（WMB-5183 自 src/main/mcp.ts 沿既有边界拆出）：
 * 只读网页/绑定/操作读取 + 内部 prepare（挂 `x_lists.prepare` 内部 scope，不再误用 `x_lists.operation_execute`）
 * + 有界观察。`x_lists.operation_execute` 执行保持 precise Owner UI（mcp.ts 无执行工具）。
 */
import type { DatabaseSync } from 'node:sqlite';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { dispatchBusinessCommand, receiptAsCommandResult, requireCommandResultData } from './business-command.ts';
import { X_LIST_PREPARE_COMMAND } from './x-list-command.ts';
import { getXListOperation, listXListBindings, prepareXListOperation, type PrepareXListOperationInput } from './x-lists.ts';
import { collectBoundXListTimeline } from './x-list-execution.ts';
import { selectedXListBrowser as resolveSelectedXListBrowser } from './x-list-context.ts';
import { readXListDetail, readXListIndex, readXListMembers, readXListTimeline } from './platforms/x-list-browser.ts';
import { XListNeedsUserError } from './platforms/x-list-session.ts';
import { getXPostTrend, listXPostMetricSnapshots } from './x-post-metrics.ts';
import { getXObservationSession, persistXObservationSessionStart, readXObservationSessionStart, stopXObservationSession } from './x-observation-jobs.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';

/** MCP 统一文本结果形状（与 mcp.ts 同形）。 */
const text = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

/**
 * WMB-5183 §4.4 表 ③：X List 内部 prepare 派发（MCP prepare 工具挂接的 scope）。
 * 走 dispatchBusinessCommand——授权（task grant 门）、command_receipt 与 operation_log 审计统一由 dispatcher 记录；
 * 事务核心 prepareXListOperation 在 dispatcher 事务内以 transaction:true 复用，task/grant/preparedActor 血统
 * 保留在操作行与收据。返回既有 CommandResult 形状（ok/data/error）供 xListResult 包裹。
 */
export async function prepareAgentXListOperation(
  runtime: ActiveWorkspaceRuntime,
  input: PrepareXListOperationInput & { taskId: string; taskGrantId: string; workerLeaseId?: string }
) {
  const actor = input.workerLeaseId
    ? Object.freeze({ type: 'pi' as const, id: 'pi', label: 'Pi worker' })
    : Object.freeze({ type: 'external_agent' as const, id: 'mcp', label: 'External Agent' });
  const receipt = await dispatchBusinessCommand(runtime, {
    command: X_LIST_PREPARE_COMMAND,
    requestId: input.requestId,
    actor,
    input: { ...input, transaction: true },
    boundIdentity: { accountKey: input.accountKey, kind: input.kind, listId: input.listId ?? null },
    taskId: input.taskId,
    workerLeaseId: input.workerLeaseId,
    grantId: input.taskGrantId,
    entityType: 'x_list_operation',
    execute: (database, value) => {
      const result = requireCommandResultData(prepareXListOperation(database, { ...value, preparedActor: actor }));
      return { data: result, entityId: result.operation.id, afterRevision: result.operation.revision, readback: result };
    }
  });
  return receiptAsCommandResult(receipt);
}

export function registerXListTools(server: McpServer, database: () => DatabaseSync, runtime?: ActiveWorkspaceRuntime): void {
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
  const accountMatches = (actual: string, expected: string) => actual.trim().toLowerCase() === expected.trim().toLowerCase();
  const prepareAgentX = async (input: PrepareXListOperationInput & { taskId: string; taskGrantId: string; workerLeaseId?: string }) => {
    if (!runtime) throw Object.assign(new Error('当前工作空间运行时不可用。'), { code: 'WORKSPACE_BUSY' });
    const { accountKey } = await selectedXListAccount();
    if (!accountMatches(accountKey, input.accountKey)) return { ok: false, data: null, error: { code: 'ACCOUNT_MISMATCH', message: '当前浏览器账号与请求账号不一致。' } };
    return prepareAgentXListOperation(runtime, input);
  };
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
    grant_id: z.string().min(1).describe('允许x_lists.prepare的当前task grant。'),
    worker_lease_id: z.string().min(1).optional().describe('Pi必须传当前worker lease；外部Agent省略。')
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
}
