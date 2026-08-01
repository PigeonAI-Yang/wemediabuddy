import { textResult, type ToolDefinition } from './wmb-mcp-client.ts';
import { callXhsTool } from './wmb-mcp-xhs-client.ts';

const checkLogin: ToolDefinition = {
  name: 'xhs_check_login_status',
  label: '检查小红书登录',
  description: '检查内置小红书 MCP 登录态。只读。不可发布/互动。',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  async execute() {
    return textResult(await callXhsTool('check_login_status', {}));
  }
};

const searchFeeds: ToolDefinition = {
  name: 'xhs_search_feeds',
  label: '搜索小红书笔记',
  description: '按关键词搜索小红书笔记。只读。结果用于后续 get_feed_detail / user_profile。保存资料时必须保留 note id、xsec_token、URL、时间与可见指标。',
  parameters: {
    type: 'object',
    properties: {
      keyword: { type: 'string' },
      filters: { type: 'object' }
    },
    required: ['keyword'],
    additionalProperties: false
  },
  async execute(_id, params) {
    const args: Record<string, unknown> = { keyword: String(params.keyword ?? '') };
    if (params.filters && typeof params.filters === 'object') args.filters = params.filters;
    return textResult(await callXhsTool('search_feeds', args));
  }
};

const getFeedDetail: ToolDefinition = {
  name: 'xhs_get_feed_detail',
  label: '读取小红书笔记详情',
  description: '读取笔记详情。需要 feed_id 与 xsec_token。只读。保存到 WMB 时用 wmb_save_source / sources.upsert_batch，并保留原始证据字段。',
  parameters: {
    type: 'object',
    properties: {
      feed_id: { type: 'string' },
      xsec_token: { type: 'string' },
      load_all_comments: { type: 'boolean' },
      click_more_replies: { type: 'boolean' },
      limit: { type: 'number' }
    },
    required: ['feed_id', 'xsec_token'],
    additionalProperties: false
  },
  async execute(_id, params) {
    return textResult(await callXhsTool('get_feed_detail', {
      feed_id: String(params.feed_id ?? ''),
      xsec_token: String(params.xsec_token ?? ''),
      load_all_comments: params.load_all_comments,
      click_more_replies: params.click_more_replies,
      limit: params.limit
    }));
  }
};

const userProfile: ToolDefinition = {
  name: 'xhs_user_profile',
  label: '读取小红书用户主页',
  description: '读取用户主页。需要 user_id 与 xsec_token。只读。',
  parameters: {
    type: 'object',
    properties: {
      user_id: { type: 'string' },
      xsec_token: { type: 'string' }
    },
    required: ['user_id', 'xsec_token'],
    additionalProperties: false
  },
  async execute(_id, params) {
    return textResult(await callXhsTool('user_profile', {
      user_id: String(params.user_id ?? ''),
      xsec_token: String(params.xsec_token ?? '')
    }));
  }
};

export const xhsTools: ToolDefinition[] = [
  checkLogin,
  searchFeeds,
  getFeedDetail,
  userProfile
];
