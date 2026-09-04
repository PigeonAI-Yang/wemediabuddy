import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { RoleModelThinkingLevel } from '../shared/pi-config.ts';

export type PiModelLimits = { contextWindow?: number; maxTokens?: number };
export type PiModelOption = PiModelLimits & { id: string; thinkingLevels?: RoleModelThinkingLevel[] };

export const WMB_VISION_MODEL = 'mimo-v2.5';

const knownLimits: Record<string, Required<PiModelLimits>> = {
  'deepseek-v4-flash': { contextWindow: 1_000_000, maxTokens: 384_000 }
};

const thinkingLevels: readonly RoleModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
type CatalogModel = {
  id: string;
  api: string;
  baseUrl: string;
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<RoleModelThinkingLevel, string | null>>;
};
let modelRuntimePromise: Promise<ModelRuntime> | null = null;

function supportedThinkingLevels(model: { reasoning?: boolean; thinkingLevelMap?: Partial<Record<RoleModelThinkingLevel, string | null>> }): RoleModelThinkingLevel[] {
  if (!model.reasoning) return ['off'];
  return thinkingLevels.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return level === 'xhigh' || level === 'max' ? mapped !== undefined : true;
  });
}

function normalizeUrl(value: string): string {
  try { return new URL(value).toString().replace(/\/$/, ''); } catch { return ''; }
}

function catalogModelScore(model: CatalogModel, api: string, baseUrl: string): number {
  let score = model.api === api ? 8 : 0;
  const requested = normalizeUrl(baseUrl);
  const candidate = normalizeUrl(model.baseUrl);
  if (!requested || !candidate) return score;
  if (requested === candidate) return score + 32;
  const requestedUrl = new URL(requested);
  const candidateUrl = new URL(candidate);
  if (requestedUrl.origin === candidateUrl.origin) score += 16;
  if (requestedUrl.pathname === candidateUrl.pathname) score += 8;
  return score;
}

function directThinkingLevels(value: Record<string, unknown>): RoleModelThinkingLevel[] | undefined {
  const listed = value.thinkingLevels ?? value.thinking_levels;
  if (Array.isArray(listed)) {
    const allowed = listed.filter((level): level is RoleModelThinkingLevel => typeof level === 'string' && thinkingLevels.includes(level as RoleModelThinkingLevel));
    return allowed.length ? [...new Set(allowed)] : undefined;
  }
  if (typeof value.reasoning !== 'boolean' && (!value.thinkingLevelMap || typeof value.thinkingLevelMap !== 'object')) return undefined;
  const map = value.thinkingLevelMap && typeof value.thinkingLevelMap === 'object' ? value.thinkingLevelMap as Partial<Record<RoleModelThinkingLevel, string | null>> : undefined;
  return supportedThinkingLevels({ reasoning: value.reasoning === true, thinkingLevelMap: map });
}

async function catalogThinkingLevels(id: string, api: string, baseUrl: string): Promise<RoleModelThinkingLevel[] | undefined> {
  modelRuntimePromise ??= ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  const runtime = await modelRuntimePromise;
  const candidates = (runtime.getModels() as readonly CatalogModel[]).filter((model) => model.id === id);
  if (!candidates.length) return undefined;
  const scored = candidates.map((model) => ({ model, score: catalogModelScore(model, api, baseUrl) })).sort((left, right) => right.score - left.score);
  if (scored.length === 1 || scored[0]!.score > scored[1]!.score) return supportedThinkingLevels(scored[0]!.model);
  const best = scored.filter((item) => item.score === scored[0]!.score).map((item) => supportedThinkingLevels(item.model));
  const signature = JSON.stringify(best[0]);
  return best.every((levels) => JSON.stringify(levels) === signature) ? best[0] : undefined;
}

export async function resolveModelThinkingLevels(value: Record<string, unknown>, api: string, baseUrl: string): Promise<RoleModelThinkingLevel[] | undefined> {
  return directThinkingLevels(value) ?? catalogThinkingLevels(typeof value.id === 'string' ? value.id.trim() : '', api, baseUrl);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function modelLimits(model: string, limits: PiModelLimits = {}): PiModelLimits {
  return {
    contextWindow: positiveInteger(limits.contextWindow) ?? knownLimits[model]?.contextWindow,
    maxTokens: positiveInteger(limits.maxTokens) ?? knownLimits[model]?.maxTokens
  };
}

export async function modelOption(value: Record<string, unknown>, api: string, baseUrl: string): Promise<PiModelOption | null> {
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  if (!id) return null;
  const limit = value.limit && typeof value.limit === 'object' ? value.limit as Record<string, unknown> : {};
  const supported = await resolveModelThinkingLevels(value, api, baseUrl);
  return {
    id,
    ...modelLimits(id, {
      contextWindow: positiveInteger(value.contextWindow) ?? positiveInteger(value.context_window) ?? positiveInteger(limit.context),
      maxTokens: positiveInteger(value.maxTokens) ?? positiveInteger(value.max_tokens) ?? positiveInteger(limit.output)
    }),
    ...(supported ? { thinkingLevels: supported } : {})
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

export async function piModelsJson(config: {
  baseUrl: string;
  api: string;
  apiKey: string;
  model: string;
  authMode?: 'bearer' | 'x-api-key' | 'none';
  contextWindow?: number;
  maxTokens?: number;
}): Promise<object> {
  const limits = modelLimits(config.model, config);
  const supported = await catalogThinkingLevels(config.model, config.api, config.baseUrl);
  const primary = {
    id: config.model,
    name: config.model,
    reasoning: supported ? supported.some((level) => level !== 'off') : true,
    ...(supported ? { thinkingLevelMap: Object.fromEntries(thinkingLevels.map((level) => [level, supported.includes(level) ? level : null])) } : {}),
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...limits
  };
  const provider = {
    baseUrl: config.baseUrl,
    api: config.api,
    apiKey: config.apiKey,
    ...(config.authMode === 'x-api-key' ? { authHeader: false } : {}),
    models: [primary]
  };
  return { providers: { 'wmb-api': provider } };
}
