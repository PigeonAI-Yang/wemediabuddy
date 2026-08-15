import { callTool, textResult, type ToolDefinition } from './wmb-mcp-client.ts';

const noParameters = { type: 'object' as const, properties: {}, additionalProperties: false };

const listWorkspaces: ToolDefinition = {
  name: 'wmb_list_workspaces', label: '列出 WMB 工作空间', description: '只读应用登记的工作空间与当前活动身份。', parameters: noParameters,
  async execute() { return textResult(await callTool('workspaces.list', {})); }
};

const getCurrentWorkspace: ToolDefinition = {
  name: 'wmb_get_current_workspace', label: '读取当前 WMB 工作空间', description: '读取当前 MCP URL 绑定的工作空间与有效配方。', parameters: noParameters,
  async execute() { return textResult(await callTool('workspaces.get_current', {})); }
};

const listWorkspaceCatalog: ToolDefinition = {
  name: 'wmb_list_workspace_catalog', label: '读取 WMB 官方能力目录', description: '读取有限的官方情报包、创作包与受支持平台。', parameters: noParameters,
  async execute() { return textResult(await callTool('workspaces.catalog', {})); }
};

const prepareWorkspaceProfile: ToolDefinition = {
  name: 'wmb_prepare_workspace_profile',
  label: '准备 WMB 工作空间配方',
  description: '提交当前 Main 会话有效的自媒体配方提案。只准备，不确认、不激活，也不能指定数据目录。',
  parameters: {
    type: 'object',
    properties: {
      requestId: { type: 'string' }, target: { type: 'string', enum: ['current', 'new'] }, purpose: { type: 'string', enum: ['self_media'] },
      displayName: { type: 'string' }, audience: { type: 'string' }, contentGoal: { type: 'string' }, editorialBrief: { type: 'string' },
      intelligencePackId: { type: 'string', enum: ['wemedia-intelligence-engine', 'uk-life-content-radar', 'game-news-radar'] }, intelligencePackVersion: { type: 'number' },
      creationPackId: { type: 'string', enum: ['wmb-core-creation'] }, creationPackVersion: { type: 'number' },
      platforms: { type: 'array', items: { type: 'string', enum: ['x', 'xiaohongshu', 'wechat', 'zhihu'] } }
    },
    required: ['requestId', 'target', 'purpose', 'displayName', 'audience', 'contentGoal', 'editorialBrief', 'intelligencePackId', 'intelligencePackVersion', 'creationPackId', 'creationPackVersion', 'platforms'],
    additionalProperties: false
  },
  async execute(_toolCallId, params) {
    return textResult(await callTool('workspaces.proposals.prepare', {
      request_id: String(params.requestId), target: params.target, purpose: params.purpose, display_name: String(params.displayName),
      audience: String(params.audience), content_goal: String(params.contentGoal), editorial_brief: String(params.editorialBrief),
      intelligence_pack_id: params.intelligencePackId, intelligence_pack_version: Number(params.intelligencePackVersion),
      creation_pack_id: params.creationPackId, creation_pack_version: Number(params.creationPackVersion), platforms: params.platforms
    }));
  }
};

export const workspaceTools = [listWorkspaces, getCurrentWorkspace, listWorkspaceCatalog, prepareWorkspaceProfile];
