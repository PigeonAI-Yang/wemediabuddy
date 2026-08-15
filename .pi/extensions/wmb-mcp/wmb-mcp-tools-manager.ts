import { callTool, textResult, type ToolDefinition } from './wmb-mcp-client.ts';

const listRoster: ToolDefinition = {
  name: 'wmb_list_agents_roster',
  label: '读取班组投影',
  description: '读取班组投影：主管/记者/策划/写手/资料员的活动状态与进度摘要。主管协调用。只读。',
  parameters: {
    type: 'object',
    properties: { businessDate: { type: 'string' } },
    additionalProperties: false
  },
  async execute(_id, params) {
    return textResult(await callTool('agents.roster', {
      business_date: params.businessDate ? String(params.businessDate) : undefined
    }));
  }
};

const listJobs: ToolDefinition = {
  name: 'wmb_list_jobs',
  label: '列出员工工单',
  description: '列出工单池排队/执行/终态，含运行句柄。主管读进度用。只读。',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async execute() {
    return textResult(await callTool('jobs.list', {}));
  }
};

const getJob: ToolDefinition = {
  name: 'wmb_get_job',
  label: '读取工单详情',
  description: '按 jobId 读工单与 monitor.task 进度。优先靠系统终态推送；不要 bash/sleep 空轮询。只读。',
  parameters: {
    type: 'object',
    properties: { jobId: { type: 'string' } },
    required: ['jobId'],
    additionalProperties: false
  },
  async execute(_id, params) {
    return textResult(await callTool('jobs.get', { job_id: String(params.jobId) }));
  }
};

export function buildSpawnJobPayload(params: Record<string, unknown>): Record<string, unknown> {
  const roleId = String(params.roleId ?? '');
  const common = {
    role_id: roleId,
    brief: String(params.brief ?? '')
  };
  if (roleId === 'reporter') {
    return {
      ...common,
      business_date: params.businessDate ? String(params.businessDate) : undefined,
      channel_ids: Array.isArray(params.channelIds) ? params.channelIds.map(String) : undefined,
      source_feed_ids: Array.isArray(params.sourceFeedIds) ? params.sourceFeedIds.map(String) : undefined
    };
  }
  if (roleId === 'planner') {
    return {
      ...common,
      business_date: params.businessDate ? String(params.businessDate) : undefined
    };
  }
  if (roleId === 'writer') {
    return {
      ...common,
      business_date: params.businessDate ? String(params.businessDate) : undefined,
      project_id: params.projectId ? String(params.projectId) : undefined,
      writer_task: params.writerTask ? String(params.writerTask) : undefined
    };
  }
  if (roleId === 'librarian') {
    return {
      ...common,
      source_ids: Array.isArray(params.sourceIds) ? params.sourceIds.map(String) : undefined,
      scope: params.scope ? String(params.scope) : undefined
    };
  }
  throw new Error(`Unsupported employee role: ${roleId || '(empty)'}`);
}

const spawnJob: ToolDefinition = {
  name: 'wmb_spawn_job',
  label: '主管派工',
  description: '向记者/策划/写手/资料员派有界工单。不可派工给主管自己。写手必须带 projectId，并用 writerTask 明确选择任务：core_draft 只写核心初稿，xiaohongshu_platform_version 只基于现有核心稿生成小红书平台版本；资料员为真实执行任务，无可整理内容时会回报 no-op 确认。派单后等系统 JOB_EVENT 终态推送（含 code/message/readback）再汇报；不要 sleep+bash 轮询 session。必要时才 wmb_get_job 看 monitor.task。',
  parameters: {
    type: 'object',
    properties: {
      roleId: { type: 'string', enum: ['reporter', 'planner', 'writer', 'librarian'], description: 'reporter | planner | writer | librarian' },
      brief: { type: 'string' },
      businessDate: { type: 'string', description: 'reporter/planner 业务日期（缺省今日）' },
      channelIds: { type: 'array', items: { type: 'string' }, description: 'reporter 可选：限定扫描渠道' },
      sourceFeedIds: { type: 'array', items: { type: 'string' }, description: 'reporter 可选：限定信息源' },
      projectId: { type: 'string', description: '写手必填：创作项目 id' },
      writerTask: { type: 'string', enum: ['core_draft', 'xiaohongshu_platform_version'], description: 'writer 必填：core_draft | xiaohongshu_platform_version' },
      sourceIds: { type: 'array', items: { type: 'string' }, description: 'librarian 可选：限定资料 id' },
      scope: { type: 'string', description: 'librarian 可选：workspace（整工作空间维护）' }
    },
    required: ['roleId', 'brief'],
    additionalProperties: false
  },
  async execute(_id, params) {
    return textResult(await callTool('jobs.spawn', buildSpawnJobPayload(params)));
  }
};

const cancelJob: ToolDefinition = {
  name: 'wmb_cancel_job',
  label: '取消工单',
  description: '主管取消员工工单。',
  parameters: {
    type: 'object',
    properties: { jobId: { type: 'string' } },
    required: ['jobId'],
    additionalProperties: false
  },
  async execute(_id, params) {
    return textResult(await callTool('jobs.cancel', { job_id: String(params.jobId) }));
  }
};

const messageJob: ToolDefinition = {
  name: 'wmb_message_job',
  label: '给工单留言',
  description: '主管向指定工单传话。员工执行上下文可见；running 时写入 task 进度（[主管] 前缀）。',
  parameters: {
    type: 'object',
    properties: {
      jobId: { type: 'string' },
      body: { type: 'string' }
    },
    required: ['jobId', 'body'],
    additionalProperties: false
  },
  async execute(_id, params) {
    return textResult(await callTool('jobs.message', {
      job_id: String(params.jobId),
      body: String(params.body)
    }));
  }
};

const listJobMessages: ToolDefinition = {
  name: 'wmb_list_job_messages',
  label: '读取工单留言',
  description: '读取主管给某工单的留言列表。只读。',
  parameters: {
    type: 'object',
    properties: { jobId: { type: 'string' } },
    required: ['jobId'],
    additionalProperties: false
  },
  async execute(_id, params) {
    return textResult(await callTool('jobs.messages', { job_id: String(params.jobId) }));
  }
};


const dailyReadiness: ToolDefinition = {
  name: 'wmb_daily_readiness',
  label: '今日编排就绪状态',
  description: '只读。查看今日扫/判状态与建议下一阶段。是否续接由你决定：可调 wmb_continue_after_scan / wmb_run_daily_stage / wmb_spawn_job。',
  parameters: {
    type: 'object',
    properties: { businessDate: { type: 'string' } },
    additionalProperties: false
  },
  async execute(_id, params) {
    return textResult(await callTool('daily.readiness', {
      business_date: params.businessDate ? String(params.businessDate) : undefined
    }));
  }
};

const continueAfterScan: ToolDefinition = {
  name: 'wmb_continue_after_scan',
  label: '扫描后续接策划',
  description: '主管选用的自动续接工具：扫描完成后调用它，系统按编排把策划接上。若你只要单项采集、不要策划，就不要调用。',
  parameters: {
    type: 'object',
    properties: { businessDate: { type: 'string' } },
    additionalProperties: false
  },
  async execute(_id, params) {
    return textResult(await callTool('daily.continue_after_scan', {
      business_date: params.businessDate ? String(params.businessDate) : undefined
    }));
  }
};

const runDailyStage: ToolDefinition = {
  name: 'wmb_run_daily_stage',
  label: '主管启动今日阶段',
  description: '主管选用的阶段编排工具：scan=单项采集，judge=单项策划，full=一条龙。需要哪种编排就调哪种；不是禁用自动编排。',
  parameters: {
    type: 'object',
    properties: {
      stage: { type: 'string', description: 'scan | judge | full' },
      businessDate: { type: 'string' }
    },
    required: ['stage'],
    additionalProperties: false
  },
  async execute(_id, params) {
    return textResult(await callTool('daily.run_stage', {
      stage: String(params.stage),
      business_date: params.businessDate ? String(params.businessDate) : undefined
    }));
  }
};

export const managerTools = [
  listRoster,
  listJobs,
  getJob,
  spawnJob,
  cancelJob,
  messageJob,
  listJobMessages,
  dailyReadiness,
  continueAfterScan,
  runDailyStage
];
