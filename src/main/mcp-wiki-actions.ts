/**
 * WMB-5240：Wiki 操作 wmb_* MCP 工具面（本 worker：ImplementPiWikiActionExecutor）。
 * 复用既有 MCP 注册约定（mcp.ts createServerFor / WMB_TOOL_IDENTITY / research 读门）：
 * - 全部 10 个工具都经 shared 解析器（normalizeWikiActionManifest）fail-closed 校验后再执行；
 * - 写工具（maintenance start/pause/resume、ingest、lint run=true）仅在活动运行时存在时注册，
 *   执行经 executeWikiAction → dispatchBusinessCommand（grant/dispatcher + write guard）；
 * - 只读工具（status/report/search/log/report）直达 workspace 作用域 store，不接受
 *   workspaceId/rootPath/本地路径入参；
 * - 无 runtime / 缺授权 → 解析器或执行器拒绝，返回用户可见原因（零写）。
 */

import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import {
  executeWikiAction,
  wireDefaultWikiQueryExecutor,
  type WikiActionCaller,
  type WikiActionExecutorContext
} from './pi-wiki-actions.ts';
import {
  WIKI_ACTION_REQUEST_ID_MAX,
  normalizeWikiActionManifest
} from '../shared/wiki-operator-protocol.ts';

const text = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });

/** MCP 调用方固定为 external_agent（envelope actor；grant/lease 校验由 dispatcher 执行）。 */
const CALLER: WikiActionCaller = Object.freeze({ actor: 'external_agent' });

const requestIdField = { request_id: z.string().min(1).max(WIKI_ACTION_REQUEST_ID_MAX) };
const authorityFields = {
  task_id: z.string().min(1),
  grant_id: z.string().min(1),
  worker_lease_id: z.string().min(1)
};

/** 统一执行：构造清单 → shared 解析器 fail-closed → 执行器；任何拒绝都返回用户可见原因。 */
async function executeTool(
  database: () => DatabaseSync,
  runtime: ActiveWorkspaceRuntime | undefined,
  manifest: Record<string, unknown>
): Promise<CallToolResult> {
  const parsed = normalizeWikiActionManifest(manifest);
  if (parsed.reject) return text({ ok: false, data: null, error: parsed.reject });
  const result = await executeWikiAction(
    { runtime, database: database() } satisfies WikiActionExecutorContext,
    parsed.manifest!,
    CALLER
  );
  return text(result);
}

/** ingest item：snake_case 工具参数 → camelCase 协议条目（unknown 字段由解析器 fail-closed）。 */
const ingestItemSchema = z.object({
  title: z.string().min(1),
  original_url: z.string().min(1),
  author: z.string().optional(),
  published_at: z.string().optional(),
  summary: z.string().optional(),
  categories: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
  value_judgment: z.string().optional(),
  ip_relevance: z.string().optional(),
  creation_angles: z.string().optional(),
  recommended_platforms: z.array(z.string()).optional(),
  recommended_formats: z.array(z.string()).optional(),
  timeliness: z.string().optional(),
  priority: z.number().optional(),
  evidence: z.string().optional(),
  expected_revision: z.number().int().optional()
});

function toIngestItem(raw: z.infer<typeof ingestItemSchema>): Record<string, unknown> {
  return {
    title: raw.title,
    originalUrl: raw.original_url,
    ...(raw.author !== undefined ? { author: raw.author } : {}),
    ...(raw.published_at !== undefined ? { publishedAt: raw.published_at } : {}),
    ...(raw.summary !== undefined ? { summary: raw.summary } : {}),
    ...(raw.categories !== undefined ? { categories: raw.categories } : {}),
    ...(raw.keywords !== undefined ? { keywords: raw.keywords } : {}),
    ...(raw.value_judgment !== undefined ? { valueJudgment: raw.value_judgment } : {}),
    ...(raw.ip_relevance !== undefined ? { ipRelevance: raw.ip_relevance } : {}),
    ...(raw.creation_angles !== undefined ? { creationAngles: raw.creation_angles } : {}),
    ...(raw.recommended_platforms !== undefined ? { recommendedPlatforms: raw.recommended_platforms } : {}),
    ...(raw.recommended_formats !== undefined ? { recommendedFormats: raw.recommended_formats } : {}),
    ...(raw.timeliness !== undefined ? { timeliness: raw.timeliness } : {}),
    ...(raw.priority !== undefined ? { priority: raw.priority } : {}),
    ...(raw.evidence !== undefined ? { evidence: raw.evidence } : {}),
    ...(raw.expected_revision !== undefined ? { expectedRevision: raw.expected_revision } : {})
  };
}

/**
 * 注册 WMB-5240 Wiki 操作工具面。
 * - 只读工具（maintenance status/report、search、log、report）无条件注册（只需 workspace 作用域 database）；
 * - 写工具（maintenance start/pause/resume、ingest、lint run=true）仅在活动运行时存在时注册
 *   （缺 runtime 时工具不存在 = fail-closed，与 registerSourceMutationMcp 同约定）。
 */
export function registerWikiActionsMcp(server: McpServer, database: () => DatabaseSync, runtime?: ActiveWorkspaceRuntime): void {
  void wireDefaultWikiQueryExecutor().catch(() => {});

  // ---- 只读面 ----
  server.registerTool('wiki.maintenance_status', {
    description: '读取全库维护 run 的实时状态（阶段/进度/checkpoint 摘要）。只读。',
    inputSchema: { ...requestIdField }
  }, async ({ request_id }) => executeTool(database, runtime, { action: 'maintain', subaction: 'status', requestId: request_id }));

  server.registerTool('wiki.maintenance_report', {
    description: '读取最近一次全库维护 run 的持久最终报告。只读；无报告时返回 no_op。',
    inputSchema: { ...requestIdField }
  }, async ({ request_id }) => executeTool(database, runtime, { action: 'maintain', subaction: 'report', requestId: request_id }));

  server.registerTool('wiki.search', {
    description: '统一全文搜索 Wiki/Note/Entity/Topic/Source/固定版本引用（WMB-5238 索引）。只读；空查询返回空页。',
    inputSchema: {
      ...requestIdField,
      query: z.string().max(500),
      limit: z.number().int().min(1).max(100).optional(),
      object_types: z.array(z.enum(['wiki_page', 'knowledge_note', 'entity', 'topic', 'source', 'fixed_version_reference'])).optional()
    }
  }, async ({ request_id, query, limit, object_types }) => executeTool(database, runtime, {
    action: 'search',
    requestId: request_id,
    query,
    ...(limit !== undefined ? { limit } : {}),
    ...(object_types !== undefined ? { objectTypes: object_types } : {})
  }));

  server.registerTool('wiki.log', {
    description: '读取全局知识时间日志（分页；limit ≤ 100；cursor 不透明）。只读。',
    inputSchema: {
      ...requestIdField,
      event_type: z.enum(['change_set', 'receipt', 'compile', 'lint_detected', 'lint_resolved', 'maintenance_started', 'maintenance_completed', 'query', 'source']).optional(),
      object_type: z.enum(['change_set', 'receipt', 'wiki_page_version', 'health_issue', 'maintenance_run', 'query_artifact', 'source_revision']).optional(),
      object_id: z.string().optional(),
      topic_id: z.string().optional(),
      scope: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().max(256).optional(),
      before: z.string().optional(),
      after: z.string().optional()
    }
  }, async ({ request_id, event_type, object_type, object_id, topic_id, scope, limit, cursor, before, after }) => {
    const filter: Record<string, unknown> = {};
    if (event_type !== undefined) filter.eventType = event_type;
    if (object_type !== undefined) filter.objectType = object_type;
    if (object_id !== undefined) filter.objectId = object_id;
    if (topic_id !== undefined) filter.topicId = topic_id;
    if (scope !== undefined) filter.scope = scope;
    if (before !== undefined) filter.before = before;
    if (after !== undefined) filter.after = after;
    return executeTool(database, runtime, {
      action: 'log',
      requestId: request_id,
      ...(Object.keys(filter).length ? { filter } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(cursor !== undefined ? { cursor } : {})
    });
  });

  server.registerTool('wiki.report', {
    description: '读取最近一次全库维护 run 的持久最终报告。只读；无报告时返回 no_op。',
    inputSchema: { ...requestIdField }
  }, async ({ request_id }) => executeTool(database, runtime, { action: 'report', requestId: request_id }));

  if (!runtime) return;

  // ---- 写面（仅活动运行时；经 dispatcher + grant） ----
  server.registerTool('wiki.maintenance_start', {
    description: '启动（或幂等复用）全库维护 run；返回 run 与是否新建。写命令 knowledge.maintenance，需 task grant。',
    inputSchema: {
      ...requestIdField,
      ...authorityFields,
      batch_limit: z.number().int().min(1).max(50).optional(),
      max_topics_per_source: z.number().int().min(1).max(20).optional(),
      stall_limit: z.number().int().min(1).max(20).optional()
    }
  }, async ({ request_id, task_id, grant_id, worker_lease_id, batch_limit, max_topics_per_source, stall_limit }) => {
    const config: Record<string, unknown> = {};
    if (batch_limit !== undefined) config.batchLimit = batch_limit;
    if (max_topics_per_source !== undefined) config.maxTopicsPerSource = max_topics_per_source;
    if (stall_limit !== undefined) config.stallLimit = stall_limit;
    return executeTool(database, runtime, {
      action: 'maintain',
      subaction: 'start',
      requestId: request_id,
      taskId: task_id,
      grantId: grant_id,
      workerLeaseId: worker_lease_id,
      ...(Object.keys(config).length ? { config } : {})
    });
  });

  server.registerTool('wiki.maintenance_pause', {
    description: '暂停全库维护 run（批次边界生效；paused 不占执行）。写命令 knowledge.maintenance，需 task grant。',
    inputSchema: { ...requestIdField, ...authorityFields }
  }, async ({ request_id, task_id, grant_id, worker_lease_id }) => executeTool(database, runtime, {
    action: 'maintain', subaction: 'pause', requestId: request_id, taskId: task_id, grantId: grant_id, workerLeaseId: worker_lease_id
  }));

  server.registerTool('wiki.maintenance_resume', {
    description: '继续已暂停/失败的全库维护 run（沿 checkpoint 续跑）。写命令 knowledge.maintenance，需 task grant。',
    inputSchema: { ...requestIdField, ...authorityFields }
  }, async ({ request_id, task_id, grant_id, worker_lease_id }) => executeTool(database, runtime, {
    action: 'maintain', subaction: 'resume', requestId: request_id, taskId: task_id, grantId: grant_id, workerLeaseId: worker_lease_id
  }));

  server.registerTool('wiki.ingest', {
    description: '单条/批量摄取资料（1..50 条；逐项结果；requestId 幂等；feedId 禁入）。写命令 sources.upsert_batch，需 task grant。',
    inputSchema: {
      ...requestIdField,
      ...authorityFields,
      items: z.array(ingestItemSchema).min(1).max(50)
    }
  }, async ({ request_id, task_id, grant_id, worker_lease_id, items }) => executeTool(database, runtime, {
    action: 'ingest',
    requestId: request_id,
    taskId: task_id,
    grantId: grant_id,
    workerLeaseId: worker_lease_id,
    items: items.map(toIngestItem)
  }));

  server.registerTool('wiki.lint', {
    description: 'run=true 执行一步有界全局 Lint（写命令 knowledge.lint，需 task grant）；缺省只读返回 checkpoint 与未解决 Issue 计数。',
    inputSchema: {
      ...requestIdField,
      task_id: z.string().optional(),
      grant_id: z.string().optional(),
      worker_lease_id: z.string().optional(),
      run: z.boolean().optional()
    }
  }, async ({ request_id, task_id, grant_id, worker_lease_id, run }) => {
    if (run === true) {
      if (!task_id || !grant_id || !worker_lease_id) {
        return text({ ok: false, data: null, error: { code: 'WIKI_ACTION_INVALID', field: 'taskId/grantId/workerLeaseId', reason: 'lint run=true 是写动作，必须携带 taskId、grantId、workerLeaseId。' } });
      }
      return executeTool(database, runtime, { action: 'lint', run: true, requestId: request_id, taskId: task_id, grantId: grant_id, workerLeaseId: worker_lease_id });
    }
    return executeTool(database, runtime, { action: 'lint', requestId: request_id });
  });
}
