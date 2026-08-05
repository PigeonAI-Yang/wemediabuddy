import { callTool, textResult, type ToolDefinition } from './wmb-mcp-client.ts';

const noParameters = { type: 'object' as const, properties: {}, additionalProperties: false };
const websiteCandidate = {
  type: 'object' as const,
  properties: {
    inputText: { type: 'string' }, name: { type: 'string' }, url: { type: 'string' }, canonicalUrl: { type: 'string' },
    origin: { type: 'string', enum: ['direct', 'search'] }
  },
  required: ['inputText', 'name', 'url', 'canonicalUrl', 'origin'], additionalProperties: false
};
const websiteTrialRead = {
  type: 'object' as const,
  properties: {
    title: { type: 'string' }, url: { type: 'string' }, requestedUrl: { type: 'string' }, readable: { type: 'boolean' },
    itemCount: { type: 'number' }, summary: { type: 'string' }, httpStatus: { type: 'number' }, contentType: { type: ['string', 'null'] },
    errorCode: { type: ['string', 'null'] }, errorMessage: { type: ['string', 'null'] }
  },
  required: ['title', 'url', 'readable'], additionalProperties: false
};

const getChannels: ToolDefinition = {
  name: 'wmb_get_intelligence_channels', label: '读取 WMB 情报渠道', description: '只读当前工作空间官网与 X Lists 来源、就绪状态和稳定身份。', parameters: noParameters,
  async execute() { return textResult(await callTool('intelligence_channels.get', {})); }
};

const listReceipts: ToolDefinition = {
  name: 'wmb_list_intelligence_channel_receipts', label: '读取情报渠道检查回执', description: '只读当前工作空间逐来源的最近检查回执。',
  parameters: { type: 'object', properties: { limit: { type: 'number', minimum: 1, maximum: 500 } }, additionalProperties: false },
  async execute(_toolCallId, params) { return textResult(await callTool('intelligence_channels.receipts_list', { limit: typeof params.limit === 'number' ? params.limit : undefined })); }
};

const resolveWebsite: ToolDefinition = {
  name: 'wmb_resolve_intelligence_website', label: '解析官网候选', description: '只读解析公开网站名称或 URL；随后必须试读并由用户确认来源变更。',
  parameters: { type: 'object', properties: { inputText: { type: 'string' } }, required: ['inputText'], additionalProperties: false },
  async execute(_toolCallId, params) { return textResult(await callTool('intelligence_channels.resolve_website', { input_text: String(params.inputText ?? '') })); }
};

const trialWebsite: ToolDefinition = {
  name: 'wmb_trial_intelligence_website', label: '试读官网候选', description: '只读试读一个官网候选；不会创建或启用来源。',
  parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false },
  async execute(_toolCallId, params) { return textResult(await callTool('intelligence_channels.trial_website', { url: String(params.url ?? '') })); }
};


const resolveXList: ToolDefinition = {
  name: 'wmb_resolve_intelligence_x_list', label: '解析 X List 候选', description: '只读当前工作空间账号实际可访问的 X List；同名候选全部返回。',
  parameters: { type: 'object', properties: { inputText: { type: 'string' } }, required: ['inputText'], additionalProperties: false },
  async execute(_toolCallId, params) { return textResult(await callTool('intelligence_channels.resolve_x_list', { input_text: String(params.inputText ?? '') })); }
};

const prepareChanges: ToolDefinition = {
  name: 'wmb_prepare_intelligence_channel_changes', label: '准备情报渠道变更', description: '准备官网/X List 的精确批量新增、启用、停用或移除 diff。只准备，最终确认只能由 WMB UI 完成。',
  parameters: {
    type: 'object',
    properties: {
      requestId: { type: 'string' },
      changes: { type: 'array', items: { type: 'object', properties: {
        action: { type: 'string', enum: ['add', 'enable', 'disable', 'remove'] }, module: { type: 'string', enum: ['official_web', 'x_lists'] },
        sourceId: { type: 'string' }, expectedRevision: { type: 'number' }, inputText: { type: 'string' }, candidate: websiteCandidate, trialRead: websiteTrialRead, resolution: { type: 'object' }
      }, required: ['action', 'module'], additionalProperties: false } }
    },
    required: ['requestId', 'changes'], additionalProperties: false
  },
  async execute(_toolCallId, params) {
    const changes = Array.isArray(params.changes) ? params.changes.map((change) => {
      const item = change as Record<string, unknown>;
      return { action: item.action, module: item.module, source_id: item.sourceId, expected_revision: item.expectedRevision, input_text: item.inputText, candidate: item.candidate, trial_read: item.trialRead, resolution: item.resolution };
    }) : [];
    return textResult(await callTool('intelligence_channels.proposals.prepare', { request_id: String(params.requestId ?? ''), changes }));
  }
};

export const intelligenceChannelTools = [getChannels, listReceipts, resolveWebsite, trialWebsite, resolveXList, prepareChanges];
