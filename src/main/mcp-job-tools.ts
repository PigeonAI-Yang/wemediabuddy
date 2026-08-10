import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import { ensureJobSpawner, getActiveJobSpawner } from './job-spawner.ts';
import { createGenericEmployeeRunner } from './generic-employee-runner.ts';
import { notifyDeskJobEvent } from './manager-job-notify.ts';
import { broadcastDataChanged } from './data-changed.ts';
import { getAgentTask } from './agent-tasks.ts';
import type { RoleJobReportV1 } from './role-job-registry.ts';
import type { McpRuntime } from './mcp.ts';

const text = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });

/**
 * WMB-5116：jobs.* 员工工单 MCP 工具（jobs.list/get/spawn/cancel/message/messages）
 * 与 GenericEmployeeRunner 注入。从 mcp.ts 抽出以保持 mcp.ts ≤500 行；
 * 工具名/描述/行为/授权与迁移前一致，唯一变化是 spawn 不再接受 intent/planDate，
 * 且运行时 schema 对多余字段（如 intent）fail closed。
 */
export function registerJobToolsMcp(server: McpServer, runtime: ActiveWorkspaceRuntime, database: () => DatabaseSync): void {
  const managerSpawner = () => ensureJobSpawner(runtime, {
    onEvent: (event) => {
      broadcastDataChanged({ scopes: ['agent'], reason: String(event.type ?? 'jobs.event') });
      const jobId = typeof event.jobId === 'string' ? event.jobId : '';
      const spawner = getActiveJobSpawner();
      const job = jobId && spawner ? spawner.get(jobId) : null;
      void notifyDeskJobEvent({
        type: String(event.type ?? ''),
        job: job ?? {
          id: jobId,
          roleId: typeof event.roleId === 'string' ? event.roleId : undefined,
          intent: typeof event.intent === 'string' ? event.intent : undefined,
          status: typeof event.status === 'string' ? event.status : undefined,
          brief: typeof event.brief === 'string' ? event.brief : undefined,
          error: typeof event.error === 'string' ? event.error : undefined,
          report: typeof event.report === 'object' && event.report !== null ? event.report as RoleJobReportV1 : null
        },
        runtime,
        handle: jobId && spawner ? spawner.getHandle(jobId) : null
      });
    },
    execute: createGenericEmployeeRunner(
      () => runtime,
      () => {
        const mcp = runtime.getMcp<McpRuntime>();
        return mcp?.url ? { mcpUrl: mcp.url, xhsMcpUrl: '' } : null;
      }
    )
  });

  server.registerTool('jobs.list', {
    description: '列出员工工单池（排队/执行/终态）。桌助读进度用。只读。'
  }, async () => {
    const spawner = getActiveJobSpawner() ?? managerSpawner();
    return text(spawner.list().map((job) => ({ ...job, handle: spawner.getHandle(job.id) })));
  });

  server.registerTool('jobs.get', {
    description: '按 jobId 读工单+monitor.task 进度。桌助读进度用；禁止 bash session。终态会推送，不必 sleep 轮询。只读。',
    inputSchema: { job_id: z.string() }
  }, async ({ job_id }) => {
    const spawner = getActiveJobSpawner() ?? managerSpawner();
    const job = spawner.get(job_id);
    if (!job) return text(null);
    const handle = spawner.getHandle(job_id);
    let task = null as ReturnType<typeof getAgentTask> | null;
    if (handle?.taskId) {
      const db = database();
      try { task = getAgentTask(db, handle.taskId); } finally { db.close(); }
    }
    const lastEvent = Array.isArray(task?.events) && task!.events!.length ? task!.events![task!.events!.length - 1] : null;
    return text({
      ...job,
      handle,
      messages: spawner.listMessages(job_id),
      monitor: {
        how: ['用本字段看进度', '有 taskId 看 monitor.task', '写手完成后再 wmb_get_content', '不要 bash session，不要 sleep 空轮询；终态会推送'],
        taskId: handle?.taskId ?? null,
        task: task ? {
          id: task.id, intent: task.intent, status: task.status, phase: task.phase,
          progress: task.progress ?? null,
          lastEvent: lastEvent ? { at: lastEvent.at, message: lastEvent.message } : null,
          errorMessage: task.errorMessage, updatedAt: task.updatedAt
        } : null,
        sessionFile: handle?.sessionFile ?? null,
        note: '终态由系统 push 给 desk；桌助无需轮询。'
      }
    });
  });

  server.registerTool('jobs.spawn', {
    description: '桌助向员工角色派有界工单（记者/策划/写手/资料员）。不可派工给桌助自己。只传角色与业务参数（系统按角色自动选择固定工作流）；写手必须提供 project_id；librarian 可限定 source_ids 或 scope=workspace；多余字段会被拒绝。',
    inputSchema: z.discriminatedUnion('role_id', [
      z.object({ role_id: z.literal('reporter'), brief: z.string().min(1), business_date: z.string().optional(), channel_ids: z.array(z.string()).optional(), source_feed_ids: z.array(z.string()).optional() }).strict(),
      z.object({ role_id: z.literal('planner'), brief: z.string().min(1), business_date: z.string().optional() }).strict(),
      z.object({ role_id: z.literal('writer'), brief: z.string().min(1), business_date: z.string().optional(), project_id: z.string().optional() }).strict(),
      z.object({ role_id: z.literal('librarian'), brief: z.string().min(1), source_ids: z.array(z.string()).optional(), scope: z.literal('workspace').optional() }).strict()
    ])
  }, async (input) => {
    const spawner = managerSpawner();
    if (input.role_id === 'reporter') {
      return text(spawner.spawn({
        roleId: 'reporter',
        brief: input.brief,
        businessDate: input.business_date ?? null,
        channelIds: input.channel_ids ?? null,
        sourceFeedIds: input.source_feed_ids ?? null
      }));
    }
    if (input.role_id === 'planner') {
      return text(spawner.spawn({
        roleId: 'planner',
        brief: input.brief,
        businessDate: input.business_date ?? null
      }));
    }
    if (input.role_id === 'writer') {
      // 缺省空串交给 spawner 运行时 JOB_PROJECT_REQUIRED（保持既有错误码路径），不用 `!` 假定。
      return text(spawner.spawn({
        roleId: 'writer',
        brief: input.brief,
        businessDate: input.business_date ?? null,
        projectId: input.project_id ?? ''
      }));
    }
    return text(spawner.spawn({
      roleId: 'librarian',
      brief: input.brief,
      sourceIds: input.source_ids ?? null,
      scope: input.scope ?? null
    }));
  });

  server.registerTool('jobs.cancel', {
    description: '桌助取消员工工单。',
    inputSchema: { job_id: z.string() }
  }, async ({ job_id }) => {
    const spawner = managerSpawner();
    return text(await spawner.cancel(job_id));
  });

  server.registerTool('jobs.message', {
    description: '桌助给指定工单留言（员工执行上下文可见；running 时写入 task 进度）。',
    inputSchema: { job_id: z.string(), body: z.string().min(1) }
  }, async ({ job_id, body }) => {
    const spawner = managerSpawner();
    return text(await spawner.postMessage(job_id, body, 'desk'));
  });

  server.registerTool('jobs.messages', {
    description: '读取工单留言列表。只读。',
    inputSchema: { job_id: z.string() }
  }, async ({ job_id }) => {
    const spawner = getActiveJobSpawner() ?? managerSpawner();
    return text(spawner.listMessages(job_id));
  });
}
