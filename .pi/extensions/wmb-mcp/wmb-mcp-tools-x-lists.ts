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
      list_id: String(params.listId ?? ''),
      limit: typeof params.limit === 'number' ? params.limit : 50
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
  description: '创建 X List 操作提议（create/update/delete/members_add/members_remove）。真正写入 X 前必须再调用 wmb_confirm_x_list_operation。members_* 建议每次只传 1 个 handle，串行执行。',
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

const confirmOperation: ToolDefinition = {
  name: 'wmb_confirm_x_list_operation', label: '确认并执行 X List 操作',
  description: '确认并执行已 prepare 的 X List 操作。会读取真实网页快照、arm，再后台 quiet 串行执行。delete 必须提供 typedListName 且与当前 List 名称完全一致。用于 members_add/members_remove/create/update/delete。',
  parameters: {
    type: 'object',
    properties: {
      operationId: { type: 'string' },
      expectedRevision: { type: 'number' },
      typedListName: { type: 'string' }
    },
    required: ['operationId'],
    additionalProperties: false
  },
  async execute(_toolCallId, params) {
    return textResult(await callTool('x_lists.confirm', {
      operation_id: String(params.operationId ?? ''),
      expected_revision: typeof params.expectedRevision === 'number' ? params.expectedRevision : undefined,
      typed_list_name: params.typedListName === undefined ? undefined : String(params.typedListName)
    }));
  }
};

export const xListTools = [readIndex, readDetail, readMembers, readTimeline, listBindings, getOperation, prepareOperation, confirmOperation];
