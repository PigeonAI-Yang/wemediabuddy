export type PiModelLimits = { contextWindow?: number; maxTokens?: number };
export type PiModelOption = PiModelLimits & { id: string };

export const WMB_VISION_MODEL = 'mimo-v2.5';

const knownLimits: Record<string, Required<PiModelLimits>> = {
  'deepseek-v4-flash': { contextWindow: 1_000_000, maxTokens: 384_000 }
};

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function modelLimits(model: string, limits: PiModelLimits = {}): PiModelLimits {
  return {
    contextWindow: positiveInteger(limits.contextWindow) ?? knownLimits[model]?.contextWindow,
    maxTokens: positiveInteger(limits.maxTokens) ?? knownLimits[model]?.maxTokens
  };
}

export function modelOption(value: Record<string, unknown>): PiModelOption | null {
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  if (!id) return null;
  const limit = value.limit && typeof value.limit === 'object' ? value.limit as Record<string, unknown> : {};
  return {
    id,
    ...modelLimits(id, {
      contextWindow: positiveInteger(value.contextWindow) ?? positiveInteger(value.context_window) ?? positiveInteger(limit.context),
      maxTokens: positiveInteger(value.maxTokens) ?? positiveInteger(value.max_tokens) ?? positiveInteger(limit.output)
    })
  };
}

export function requireModelLimits(limits: PiModelLimits): PiModelLimits {
  const contextWindow = limits.contextWindow === undefined ? undefined : positiveInteger(limits.contextWindow);
  const maxTokens = limits.maxTokens === undefined ? undefined : positiveInteger(limits.maxTokens);
  if (limits.contextWindow !== undefined && !contextWindow) throw new Error('上下文长度必须是正整数。');
  if (limits.maxTokens !== undefined && !maxTokens) throw new Error('最大输出长度必须是正整数。');
  if (contextWindow && maxTokens && maxTokens > contextWindow) throw new Error('最大输出长度不能超过上下文长度。');
  return { contextWindow, maxTokens };
}

export function piModelsJson(config: {
  baseUrl: string;
  api: string;
  apiKey: string;
  model: string;
  contextWindow?: number;
  maxTokens?: number;
}): object {
  const limits = modelLimits(config.model, config);
  const primary = {
    id: config.model,
    name: config.model,
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...limits
  };
  return {
    providers: {
      'wmb-api': {
        baseUrl: config.baseUrl,
        api: config.api,
        apiKey: config.apiKey,
        models: [primary]
      }
    }
  };
}
