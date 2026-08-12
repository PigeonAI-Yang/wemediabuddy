import { callTool, textResult, type ToolDefinition } from './wmb-mcp-client.ts';

const searchWeb: ToolDefinition = {
  name: 'wmb_search_web',
  label: '搜索公网（研究）',
  description: '研究只读：公网搜索候选解析，返回可读公网页候选；不写渠道、不创建来源。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      limit: { type: 'number', minimum: 1, maximum: 40 }
    },
    required: ['query'],
    additionalProperties: false
  },
  async execute(_toolCallId, params) {
    return textResult(await callTool('research.search_web', {
      query: String(params.query ?? ''),
      limit: typeof params.limit === 'number' ? params.limit : undefined
    }));
  }
};

const readWebPage: ToolDefinition = {
  name: 'wmb_read_web_page',
  label: '读取公网页（研究）',
  description: '研究只读：静态正文提取优先；静态失败时受控无头浏览器渲染动态公网页。验证码/登录墙明确失败（auth_required），不绕、不携带会话凭证。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string' }
    },
    required: ['url'],
    additionalProperties: false
  },
  async execute(_toolCallId, params) {
    return textResult(await callTool('research.read_web_page', { url: String(params.url ?? '') }));
  }
};

export const researchTools = [searchWeb, readWebPage];
