import { callTool, textResult, type ToolDefinition } from './wmb-mcp-client.ts';

const readIndex: ToolDefinition = {
  name: 'wmb_read_x_list_index', label: '读取 X List 索引',
  description: '读取当前专用 X 登录账号可见的 List 索引。只读真实网页，不是本地绑定。',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async execute() { return textResult(await callTool('x_lists.read_index', {})); }
};

const readDetail: ToolDefinition = {
  name: 'wmb_read_x_list_detail', label: '读取 X List 详情',
  description: '读取指定 X List 的详情。只读真实网页。',
  parameters: { type: 'object', properties: { listId: { type: 'string' } }, required: ['listId'], additionalProperties: false },
  async execute(_toolCallId, params) { return textResult(await callTool('x_lists.read_detail', { list_id: String(params.listId ?? '') })); }
};

const readMembers: ToolDefinition = {
  name: 'wmb_read_x_list_members', label: '读取 X List 成员',
  description: '读取指定 X List 当前可见成员。只读真实网页。',
  parameters: { type: 'object', properties: { listId: { type: 'string' } }, required: ['listId'], additionalProperties: false },
  async execute(_toolCallId, params) { return textResult(await callTool('x_lists.read_members', { list_id: String(params.listId ?? '') })); }
};

const readTimeline: ToolDefinition = {
  name: 'wmb_read_x_list_timeline', label: '读取 X List 动态',
  description: '读取指定 X List 当前可见动态，最多 50 条。只读真实网页。',
  parameters: {
    type: 'object',
    properties: { listId: { type: 'string' }, limit: { type: 'number', minimum: 1, maximum: 50 } },
    required: ['listId'], additionalProperties: false
  },
  async execute(_toolCallId, params) {
    return textResult(await callTool('x_lists.read_timeline', {
      list_id: String(params.listId ?? ''), limit: typeof params.limit === 'number' ? params.limit : 50
    }));
  }
};

const listBindings: ToolDefinition = {
  name: 'wmb_list_x_list_bindings', label: '读取已绑定 X List',
  description: '读取已接入 WMB 发现的 X List。只读，不访问或修改 X。',
  parameters: { type: 'object', properties: { accountKey: { type: 'string' } }, additionalProperties: false },
  async execute(_toolCallId, params) { return textResult(await callTool('x_lists.list_bindings', { account_key: params.accountKey })); }
};

const getOperation: ToolDefinition = {
  name: 'wmb_get_x_list_operation', label: '读取 X List 操作',
  description: '读取一条 X List 的提议、冻结快照和状态。只读。',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  async execute(_toolCallId, params) { return textResult(await callTool('x_lists.get_operation', { id: String(params.id ?? '') })); }
};

const prepareOperation: ToolDefinition = {
  name: 'wmb_prepare_x_list_operation', label: '准备 X List 操作',
  description: '创建 X List 操作提议（create/update/delete/members_add/members_remove）。只准备，最终确认只能由 WMB UI 完成。',
  parameters: {
    type: 'object',
    properties: {
      requestId: { type: 'string' }, accountKey: { type: 'string' }, kind: { type: 'string', enum: ['create', 'update', 'delete', 'members_add', 'members_remove'] },
      listId: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, isPrivate: { type: 'boolean' }, handles: { type: 'array', items: { type: 'string' } }
    },
    required: ['requestId', 'accountKey', 'kind'], additionalProperties: false
  },
  async execute(_toolCallId, params) {
    return textResult(await callTool('x_lists.prepare', {
      request_id: String(params.requestId ?? ''), account_key: String(params.accountKey ?? ''), kind: params.kind,
      list_id: params.listId, name: params.name, description: params.description, is_private: params.isPrivate, handles: params.handles
    }));
  }
};

const collectTimeline: ToolDefinition = {
  name: 'wmb_collect_x_list_timeline', label: '采集已绑定 X List 动态',
  description: '将当前工作空间已启用 List 的有限最新动态采集为现有资料。只读平台、只写当前根，不含确认。',
  parameters: { type: 'object', properties: { accountKey: { type: 'string' }, listId: { type: 'string' }, limit: { type: 'number' } }, required: ['accountKey', 'listId'], additionalProperties: false },
  async execute(_toolCallId, params) {
    return textResult(await callTool('x_lists.collect_timeline', {
      account_key: String(params.accountKey ?? ''), list_id: String(params.listId ?? ''), limit: typeof params.limit === 'number' ? params.limit : undefined
    }));
  }
};

const listMetricSnapshots: ToolDefinition = {
  name: 'wmb_list_x_post_metric_snapshots', label: '读取 X 帖子指标快照',
  description: '读取当前工作空间一个 X 资料的真实指标快照。只读，不访问 X 网页。',
  parameters: {
    type: 'object', properties: { sourceId: { type: 'string' }, limit: { type: 'number', minimum: 1, maximum: 500 } },
    required: ['sourceId'], additionalProperties: false
  },
  async execute(_toolCallId, params) {
    return textResult(await callTool('x_lists.post_metric_snapshots_list', {
      source_id: String(params.sourceId ?? ''), limit: typeof params.limit === 'number' ? params.limit : undefined
    }));
  }
};

const getPostTrend: ToolDefinition = {
  name: 'wmb_get_x_post_trend', label: '读取 X 帖子趋势',
  description: '根据真实指标快照读取确定性浏览速度和速度变化。数据不足返回原因，不生成热度分。',
  parameters: { type: 'object', properties: { sourceId: { type: 'string' } }, required: ['sourceId'], additionalProperties: false },
  async execute(_toolCallId, params) { return textResult(await callTool('x_lists.post_trend_get', { source_id: String(params.sourceId ?? '') })); }
};

const startObservation: ToolDefinition = {
  name: 'wmb_start_x_list_observation', label: '开始 X List 趋势观察',
  description: '显式开始当前根已启用 List 的固定 15/60/180 分钟趋势观察。',
  parameters: {
    type: 'object', properties: { requestId: { type: 'string' }, bindingIds: { type: 'array', items: { type: 'string' } } },
    required: ['requestId', 'bindingIds'], additionalProperties: false
  },
  async execute(_toolCallId, params) {
    return textResult(await callTool('x_lists.observation_start', {
      request_id: String(params.requestId ?? ''), binding_ids: Array.isArray(params.bindingIds) ? params.bindingIds.map(String) : []
    }));
  }
};

const getObservation: ToolDefinition = {
  name: 'wmb_get_x_list_observation', label: '读取 X List 趋势观察',
  description: '读取一个有界趋势观察 session 及其固定窗口状态。',
  parameters: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'], additionalProperties: false },
  async execute(_toolCallId, params) { return textResult(await callTool('x_lists.observation_get', { session_id: String(params.sessionId ?? '') })); }
};

const stopObservation: ToolDefinition = {
  name: 'wmb_stop_x_list_observation', label: '停止 X List 趋势观察',
  description: '停止 session；剩余窗口不再运行，迟到读取不得写入。',
  parameters: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'], additionalProperties: false },
  async execute(_toolCallId, params) { return textResult(await callTool('x_lists.observation_stop', { session_id: String(params.sessionId ?? '') })); }
};

export const xListTools = [readIndex, readDetail, readMembers, readTimeline, listBindings, getOperation, prepareOperation, collectTimeline, listMetricSnapshots, getPostTrend, startObservation, getObservation, stopObservation];
