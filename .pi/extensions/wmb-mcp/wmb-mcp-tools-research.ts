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

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/**
 * WMB-5292：camelCase Pi 参数 → MCP research.dispatch snake_case 输入，逐键显式映射。
 * required claims 原样透传（key/text/type 由服务端机器校验，非法 fail-closed）；budget 只映射
 * 五个已知键（服务端 schema .strict()），上调由服务端钳制到机器硬上限。
 */
export function buildDispatchResearchPayload(params: Record<string, unknown>): Record<string, unknown> {
  const rawBudget = params.budget && typeof params.budget === 'object' ? (params.budget as Record<string, unknown>) : undefined;
  return {
    parent_task_id: String(params.parentTaskId ?? ''),
    required_claims: Array.isArray(params.requiredClaims)
      ? params.requiredClaims.map((claim) => {
          const entry = (claim ?? {}) as Record<string, unknown>;
          return { key: String(entry.key ?? ''), text: String(entry.text ?? ''), type: String(entry.type ?? '') };
        })
      : [],
    budget: rawBudget
      ? {
          time_minutes: numberOrUndefined(rawBudget.timeMinutes),
          min_valid_sources: numberOrUndefined(rawBudget.minValidSources),
          max_candidates: numberOrUndefined(rawBudget.maxCandidates),
          max_parallel_fetches: numberOrUndefined(rawBudget.maxParallelFetches),
          max_rounds: numberOrUndefined(rawBudget.maxRounds)
        }
      : undefined,
    channels: Array.isArray(params.channels) ? params.channels.map(String) : undefined,
    brief: params.brief ? String(params.brief) : undefined,
    gap_id: params.gapId ? String(params.gapId) : undefined
  };
}

const dispatchResearch: ToolDefinition = {
  name: 'wmb_dispatch_research',
  label: '证据缺口派研究补料',
  description: '事实写作/策划/资料整理发现证据缺口时的受控入口（映射 MCP research.dispatch）：传当前父任务 ID 与 required claims，系统派生研究补料工单（记者执行；同父唯一 + businessDate/projectId 边界继承 + 三层止环；父角色仅 writer/planner/librarian，父为研究/续派产物拒绝）。证据缺口必须走本工具，禁止临时联网或普通 reporter/daily_scan 工单代替。派单成功后立即结束当前交付（不保存无证据支持的草稿），由研究续派链以原角色接续。',
  parameters: {
    type: 'object',
    properties: {
      parentTaskId: { type: 'string', description: '当前父任务 id（系统注入的 taskId）' },
      requiredClaims: {
        type: 'array',
        description: '缺口主张清单（原样透传，服务端机器校验 key/text/type）',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: '主张稳定键' },
            text: { type: 'string', description: '待核查主张原文' },
            type: { type: 'string', enum: ['fact', 'price', 'policy'], description: 'fact | price | policy' }
          },
          required: ['key', 'text', 'type'],
          additionalProperties: false
        },
        minItems: 1
      },
      budget: {
        type: 'object',
        description: '可选：逐键下调预算；上调一律被服务端钳制到机器硬上限（12 分钟/15 有效/40 候选/3 并行/1 轮）',
        properties: {
          timeMinutes: { type: 'number' },
          minValidSources: { type: 'number' },
          maxCandidates: { type: 'number' },
          maxParallelFetches: { type: 'number' },
          maxRounds: { type: 'number' }
        },
        additionalProperties: false
      },
      channels: { type: 'array', items: { type: 'string', enum: ['web', 'x', 'xhs'] }, description: '可选：首批只读面（缺省 web/x/xhs）' },
      brief: { type: 'string', description: '可选：补充指令' },
      gapId: { type: 'string', description: '可选：既有证据缺口 id（缺省自动生成）' }
    },
    required: ['parentTaskId', 'requiredClaims'],
    additionalProperties: false
  },
  async execute(_toolCallId, params) {
    return textResult(await callTool('research.dispatch', buildDispatchResearchPayload(params)));
  }
};

export const researchTools = [searchWeb, readWebPage, dispatchResearch];
