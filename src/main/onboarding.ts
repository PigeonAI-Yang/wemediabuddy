/**
 * First-run onboarding backend (Windows release design §7): restart-safe wizard
 * state at userData/onboarding.json, default/custom workspace creation, BYOK AI
 * connection test, optional platform checks, and completion gated on real
 * prerequisites. No secrets are written to onboarding.json; credential persistence
 * is delegated to the injected secure savePiConfig. Collaborators are injected so
 * the module stays testable without Electron and usable from Main IPC.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { requirePiApiType, type PiApiType, type PiThinkingLevel, type PiConfig } from './pi-config.ts';
import { WMB_VISION_MODEL } from './pi-model.ts';
import type { DataRoot } from './data-root.ts';
import type { WorkspaceRecord, WorkspaceRegistry } from './workspaces.ts';

export const ONBOARDING_STEPS = ['welcome', 'workspace', 'ai', 'platforms', 'complete'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export const DEFAULT_WORKSPACE_DIR_NAME = 'WeMediaBuddy';
export const AI_TEST_TIMEOUT_MS = 15_000;
const DEFAULT_WORKSPACE_DISPLAY_NAME = '我的工作空间';

export type PlatformCheckStatus = 'completed' | 'skipped';
export type PlatformCheckRecord = { status: PlatformCheckStatus; updatedAt: string };
export type PlatformChecks = Record<string, PlatformCheckRecord>;
export type OnboardingWorkspaceRecord = { workspaceId: string; rootPath: string; createdAt: string };
export type OnboardingAiTestRecord = { api: PiApiType; model: string; latencyMs: number; message: string; testedAt: string; visionModelId: string | null };
export type OnboardingAiRecord = { profileId: string; savedAt: string; testedAt: string | null; lastTest: OnboardingAiTestRecord | null };
export type StoredOnboardingState = {
  currentStep: OnboardingStep;
  workspace: OnboardingWorkspaceRecord | null;
  ai: OnboardingAiRecord | null;
  platforms: PlatformChecks;
  startedAt: string;
  completedAt: string | null;
  updatedAt: string;
};
export type OnboardingPrerequisites = { workspaceReady: boolean; aiReady: boolean };
export type OnboardingAiTestSettings = { baseUrl: string; api: PiApiType; apiKey: string; model: string };
export type OnboardingAiTestResult = { ok: true; api: PiApiType; model: string; latencyMs: number; message: string; visionModelId: string | null; testedAt: string };
export type OnboardingAiSaveInput = OnboardingAiTestSettings & { name: string; thinking?: PiThinkingLevel; nativeSearch?: boolean; contextWindow?: number | null; maxTokens?: number | null };
export type OnboardingAiSaveResult = { piConfig: PiConfig; ai: OnboardingAiRecord; state: StoredOnboardingState };
export type OnboardingWorkspaceResult = { workspace: WorkspaceRecord; state: StoredOnboardingState };
export type OnboardingStatus = {
  currentStep: OnboardingStep;
  persistedStep: OnboardingStep;
  prerequisites: OnboardingPrerequisites;
  workspace: OnboardingWorkspaceRecord | null;
  ai: OnboardingAiRecord | null;
  platforms: PlatformChecks;
  startedAt: string;
  completedAt: string | null;
  updatedAt: string;
  completed: boolean;
};
export type OnboardingErrorCode = 'INVALID_URL' | 'INVALID_API' | 'INVALID_MODEL' | 'AUTH_FAILED' | 'MODELS_FETCH_FAILED' | 'MODEL_NOT_FOUND' | 'TEXT_REQUEST_FAILED' | 'TIMEOUT' | 'NETWORK_ERROR' | 'WORKSPACE_REQUIRED' | 'AI_REQUIRED' | 'INVALID_STATE';
export type OnboardingCollaborators = {
  userDataPath: () => string;
  documentsPath: () => string;
  readWorkspaceRegistry: () => Promise<WorkspaceRegistry>;
  readPiConfig: () => PiConfig;
  openDataRoot: (rootPath: string) => Promise<DataRoot>;
  enroll: (input: { rootPath: string; displayName?: string }) => Promise<WorkspaceRecord>;
  refresh: (dataRoot: DataRoot) => Promise<void>;
  chooseWorkspaceDirectory: () => Promise<string | null>;
  savePiConfig: (input: OnboardingAiSaveInput) => PiConfig;
  now?: () => string;
  fetchImpl?: typeof fetch;
};
export type OnboardingManager = {
  onboardingPath: () => string;
  defaultWorkspacePath: () => string;
  inspectStatus: () => Promise<OnboardingStatus>;
  recordStep: (step: OnboardingStep) => OnboardingStep;
  createDefaultWorkspace: () => Promise<OnboardingWorkspaceResult>;
  chooseCustomWorkspace: () => Promise<OnboardingWorkspaceResult | null>;
  testAiConnection: (settings: OnboardingAiTestSettings) => Promise<OnboardingAiTestResult>;
  saveAiConfig: (settings: OnboardingAiSaveInput, testResult?: OnboardingAiTestRecord | null) => OnboardingAiSaveResult;
  recordPlatformStatus: (platformId: string, status: PlatformCheckStatus) => PlatformChecks;
  skipPlatform: (platformId: string) => PlatformChecks;
  clearPlatform: (platformId: string) => PlatformChecks;
  completeOnboarding: () => Promise<OnboardingStatus>;
};

export function onboardingError(code: OnboardingErrorCode, message: string): Error {
  return Object.assign(new Error(message), { code });
}
function isOnboardingError(error: unknown): error is Error & { code: OnboardingErrorCode } {
  return error instanceof Error && 'code' in error && typeof error.code === 'string';
}
/** Boundary conversion: only plain objects pass; fields stay `unknown` until checked. */
function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
function safeApiType(value: unknown): PiApiType | null {
  if (typeof value !== 'string') return null;
  try {
    return requirePiApiType(value);
  } catch {
    return null;
  }
}
function isOnboardingStep(value: unknown): value is OnboardingStep {
  return typeof value === 'string' && (ONBOARDING_STEPS as readonly string[]).includes(value);
}
/** Validates and normalizes a Pi base URL (http/https, trailing slash stripped). */
export function normalizePiBaseUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw onboardingError('INVALID_URL', 'Pi API 地址必须使用 HTTP 或 HTTPS。');
  }
  return url.toString().replace(/\/$/, '');
}

export function createOnboardingState(now: string): StoredOnboardingState {
  return { currentStep: 'welcome', workspace: null, ai: null, platforms: {}, startedAt: now, completedAt: null, updatedAt: now };
}
export function hasActiveWorkspace(registry: WorkspaceRegistry): boolean {
  return registry.activeWorkspaceId !== null && registry.workspaces.some((workspace) => workspace.id === registry.activeWorkspaceId);
}
export function hasActivePiConfig(config: PiConfig): boolean {
  return config.activeId !== null && config.configured;
}
/** Resume step derived from real prerequisites, never a cosmetic page counter:
 * missing workspace → `workspace` (unless still on `welcome`); no active configured
 * Pi profile → `ai`; both met → `complete` when completed else the persisted anchor
 * (a satisfied `welcome`/`workspace` advances to `ai` instead of parking). */
export function deriveCurrentStep(
  state: Pick<StoredOnboardingState, 'currentStep' | 'completedAt'>,
  prereqs: OnboardingPrerequisites
): OnboardingStep {
  if (!prereqs.workspaceReady) return state.currentStep === 'welcome' ? 'welcome' : 'workspace';
  if (!prereqs.aiReady) return state.currentStep === 'welcome' ? 'welcome' : 'ai';
  if (state.completedAt) return 'complete';
  if (state.currentStep === 'welcome' || state.currentStep === 'workspace') return 'ai';
  return state.currentStep === 'complete' ? 'platforms' : state.currentStep;
}
function unwrapStored(value: unknown): unknown {
  const record = recordOf(value);
  if (!record || !('state' in record)) return value;
  return record.version === 1 ? record.state : undefined;
}
function normalizeWorkspace(value: unknown): OnboardingWorkspaceRecord | null {
  const record = recordOf(value);
  if (!record || typeof record.workspaceId !== 'string' || !record.workspaceId) return null;
  if (typeof record.rootPath !== 'string' || !record.rootPath) return null;
  return { workspaceId: record.workspaceId, rootPath: record.rootPath, createdAt: typeof record.createdAt === 'string' ? record.createdAt : '' };
}
function normalizeAiTest(value: unknown): OnboardingAiTestRecord | null {
  const record = recordOf(value);
  if (!record) return null;
  const api = safeApiType(record.api);
  if (!api || typeof record.model !== 'string' || !record.model) return null;
  const latencyMs = typeof record.latencyMs === 'number' && Number.isFinite(record.latencyMs) ? Math.max(0, Math.round(record.latencyMs)) : 0;
  return {
    api,
    model: record.model,
    latencyMs,
    message: typeof record.message === 'string' ? record.message : '',
    testedAt: typeof record.testedAt === 'string' ? record.testedAt : '',
    visionModelId: typeof record.visionModelId === 'string' && record.visionModelId ? record.visionModelId : null
  };
}
function normalizeAi(value: unknown): OnboardingAiRecord | null {
  const record = recordOf(value);
  if (!record || typeof record.profileId !== 'string' || !record.profileId) return null;
  return {
    profileId: record.profileId,
    savedAt: typeof record.savedAt === 'string' ? record.savedAt : '',
    testedAt: typeof record.testedAt === 'string' ? record.testedAt : null,
    lastTest: normalizeAiTest(record.lastTest)
  };
}
function normalizePlatforms(value: unknown): PlatformChecks {
  const record = recordOf(value);
  if (!record) return {};
  const platforms: PlatformChecks = {};
  for (const [id, entry] of Object.entries(record)) {
    const entryRecord = recordOf(entry);
    if (!id || !entryRecord) continue;
    if (entryRecord.status !== 'completed' && entryRecord.status !== 'skipped') continue;
    const updatedAt = entryRecord.updatedAt;
    platforms[id] = { status: entryRecord.status, updatedAt: typeof updatedAt === 'string' ? updatedAt : '' };
  }
  return platforms;
}
/** Defensive normalization; corrupt or unsupported state degrades to a fresh default. */
export function normalizeOnboardingState(value: unknown, now: string): StoredOnboardingState {
  const fallback = createOnboardingState(now);
  const record = recordOf(unwrapStored(value));
  if (!record) return fallback;
  const currentStep = isOnboardingStep(record.currentStep) ? record.currentStep : fallback.currentStep;
  const completedAt = typeof record.completedAt === 'string' && record.completedAt ? record.completedAt : null;
  return {
    currentStep: currentStep === 'complete' && !completedAt ? 'platforms' : currentStep,
    workspace: normalizeWorkspace(record.workspace),
    ai: normalizeAi(record.ai),
    platforms: normalizePlatforms(record.platforms),
    startedAt: typeof record.startedAt === 'string' && record.startedAt ? record.startedAt : now,
    completedAt,
    updatedAt: typeof record.updatedAt === 'string' && record.updatedAt ? record.updatedAt : now
  };
}
export function readOnboardingState(statePath: string, now: string): StoredOnboardingState | null {
  if (!existsSync(statePath)) return null;
  return normalizeOnboardingState(JSON.parse(readFileSync(statePath, 'utf8')) as unknown, now);
}
/** Atomic write: temporary sibling file then rename (pi-config/workspaces pattern). */
export function writeOnboardingState(statePath: string, state: StoredOnboardingState): void {
  mkdirSync(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify({ version: 1, state }, null, 2)}\n`, 'utf8');
  renameSync(temporaryPath, statePath);
}

function modelEntries(value: unknown): Array<{ id: string; meta: Record<string, unknown> }> {
  const record = recordOf(value);
  if (!record || !Array.isArray(record.data)) return [];
  const entries: Array<{ id: string; meta: Record<string, unknown> }> = [];
  for (const item of record.data) {
    const itemRecord = recordOf(item);
    if (!itemRecord || typeof itemRecord.id !== 'string' || !itemRecord.id.trim()) continue;
    entries.push({ id: itemRecord.id.trim(), meta: { ...itemRecord } });
  }
  return entries;
}
function isVisionCapableMeta(meta: Record<string, unknown>): boolean {
  const inputs = meta.input ?? meta.modalities ?? meta.modality;
  if (Array.isArray(inputs)) return inputs.includes('image') || inputs.includes('image_url') || inputs.includes('multimodal');
  return meta.vision === true;
}
/** Reports a vision-capable model from /models metadata without requiring one. */
export function findVisionCapableModel(modelsValue: unknown): string | null {
  const entries = modelEntries(modelsValue);
  const explicit = entries.find((entry) => entry.id === WMB_VISION_MODEL);
  if (explicit) return explicit.id;
  return entries.find((entry) => isVisionCapableMeta(entry.meta))?.id ?? null;
}
function extractResponsesText(body: unknown): string {
  const record = recordOf(body);
  if (!record) return '';
  if (typeof record.output_text === 'string') return record.output_text.trim();
  if (!Array.isArray(record.output)) return '';
  const parts: string[] = [];
  for (const item of record.output) {
    const itemRecord = recordOf(item);
    if (!itemRecord || !Array.isArray(itemRecord.content)) continue;
    for (const block of itemRecord.content) {
      const blockRecord = recordOf(block);
      if (blockRecord && blockRecord.type === 'output_text' && typeof blockRecord.text === 'string') parts.push(blockRecord.text);
    }
  }
  return parts.join('').trim();
}
function extractCompletionsText(body: unknown): string {
  const record = recordOf(body);
  if (!record || !Array.isArray(record.choices)) return '';
  for (const choice of record.choices) {
    const message = recordOf(recordOf(choice)?.message);
    if (message && typeof message.content === 'string') return message.content.trim();
  }
  return '';
}
function httpFailure(code: OnboardingErrorCode, context: string, status: number): Error {
  if (status === 401 || status === 403) return onboardingError('AUTH_FAILED', `${context}：鉴权失败（HTTP ${status}）。`);
  return onboardingError(code, `${context}（HTTP ${status}）。`);
}
function mapFetchError(error: unknown, code: OnboardingErrorCode, context: string): Error {
  if (isOnboardingError(error)) return error;
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return onboardingError('TIMEOUT', `${context}：请求超时（${AI_TEST_TIMEOUT_MS / 1000} 秒）。`);
  }
  return onboardingError('NETWORK_ERROR', `${context}：网络请求失败。`);
}
/** BYOK test: validates URL/API type, fetches /models, confirms the model, then a
 * minimal text request against /responses or /chat/completions (15s timeout).
 * Missing vision capability never fails the test. */
export async function runAiConnectionTest(
  input: OnboardingAiTestSettings & { fetchImpl?: typeof fetch; now?: () => string }
): Promise<OnboardingAiTestResult> {
  let api: PiApiType;
  try {
    api = requirePiApiType(input.api);
  } catch {
    throw onboardingError('INVALID_API', 'Pi 接口类型不受支持，仅支持 OpenAI Responses 或 OpenAI Chat Completions。');
  }
  const baseUrl = normalizePiBaseUrl(input.baseUrl);
  const model = input.model.trim();
  if (!model) throw onboardingError('INVALID_MODEL', '请填写模型名称。');
  const apiKey = input.apiKey?.trim() ?? '';
  if (!apiKey) throw onboardingError('AUTH_FAILED', '请先填写 API Key。');
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => new Date().toISOString());
  const authHeaders = { authorization: `Bearer ${apiKey}` };
  let modelsBody: unknown;
  try {
    const response = await fetchImpl(`${baseUrl}/models`, { headers: authHeaders, signal: AbortSignal.timeout(AI_TEST_TIMEOUT_MS) });
    if (!response.ok) throw httpFailure('MODELS_FETCH_FAILED', '获取模型列表失败', response.status);
    modelsBody = await response.json();
  } catch (error) {
    throw mapFetchError(error, 'MODELS_FETCH_FAILED', '获取模型列表失败');
  }
  const entries = modelEntries(modelsBody);
  if (!entries.some((entry) => entry.id === model)) throw onboardingError('MODEL_NOT_FOUND', `模型列表中没有 ${model}。`);
  const visionModelId = findVisionCapableModel(modelsBody);
  const endpoint = api === 'openai-responses' ? `${baseUrl}/responses` : `${baseUrl}/chat/completions`;
  const body = api === 'openai-responses'
    ? JSON.stringify({ model, input: 'ping' })
    : JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }] });
  const startedAt = Date.now();
  let textBody: unknown;
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(AI_TEST_TIMEOUT_MS)
    });
    if (!response.ok) throw httpFailure('TEXT_REQUEST_FAILED', '最小文本请求失败', response.status);
    textBody = await response.json();
  } catch (error) {
    throw mapFetchError(error, 'TEXT_REQUEST_FAILED', '最小文本请求失败');
  }
  const message = api === 'openai-responses' ? extractResponsesText(textBody) : extractCompletionsText(textBody);
  if (!message) throw onboardingError('TEXT_REQUEST_FAILED', '接口没有返回文本回复。');
  return {
    ok: true,
    api,
    model,
    latencyMs: Math.max(0, Date.now() - startedAt),
    message,
    visionModelId,
    testedAt: now()
  };
}

export function createOnboardingManager(input: OnboardingCollaborators): OnboardingManager {
  const now = () => input.now?.() ?? new Date().toISOString();
  const statePath = () => path.join(input.userDataPath(), 'onboarding.json');
  function readOrCreateState(): StoredOnboardingState {
    const existing = readOnboardingState(statePath(), now());
    if (existing) return existing;
    const created = createOnboardingState(now());
    writeOnboardingState(statePath(), created);
    return created;
  }
  function writeState(next: StoredOnboardingState): StoredOnboardingState {
    writeOnboardingState(statePath(), next);
    return next;
  }
  async function prerequisites(state?: StoredOnboardingState): Promise<OnboardingPrerequisites> {
    const [registry, piConfig] = await Promise.all([input.readWorkspaceRegistry(), Promise.resolve(input.readPiConfig())]);
    const configured = hasActivePiConfig(piConfig);
    return { workspaceReady: hasActiveWorkspace(registry), aiReady: configured && Boolean(state?.ai?.testedAt || state?.completedAt) };
  }
  function statusFrom(state: StoredOnboardingState, prereqs: OnboardingPrerequisites): OnboardingStatus {
    const currentStep = deriveCurrentStep(state, prereqs);
    return {
      currentStep,
      persistedStep: state.currentStep,
      prerequisites: prereqs,
      workspace: state.workspace,
      ai: state.ai,
      platforms: state.platforms,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
      updatedAt: state.updatedAt,
      completed: currentStep === 'complete'
    };
  }
  async function inspectStatus(): Promise<OnboardingStatus> {
    const existed = existsSync(statePath());
    let state = readOrCreateState();
    if (!existed) {
      const legacyPrereqs = await Promise.all([input.readWorkspaceRegistry(), Promise.resolve(input.readPiConfig())]);
      const workspaceReady = hasActiveWorkspace(legacyPrereqs[0]);
      const aiConfigured = hasActivePiConfig(legacyPrereqs[1]);
      if (workspaceReady && aiConfigured) {
        state = writeState({ ...state, currentStep: 'complete', completedAt: now(), updatedAt: now() });
      } else if (workspaceReady) {
        state = writeState({ ...state, currentStep: 'ai', updatedAt: now() });
      }
    }
    return statusFrom(state, await prerequisites(state));
  }
  function recordStep(step: OnboardingStep): OnboardingStep {
    if (!ONBOARDING_STEPS.includes(step)) throw onboardingError('INVALID_STATE', `未知向导步骤：${String(step)}。`);
    if (step === 'complete') throw onboardingError('INVALID_STATE', '完成向导请调用 completeOnboarding。');
    writeState({ ...readOrCreateState(), currentStep: step, updatedAt: now() });
    return step;
  }
  function defaultWorkspacePath(): string {
    return path.join(input.documentsPath(), DEFAULT_WORKSPACE_DIR_NAME);
  }
  async function createWorkspaceAt(rootPath: string, displayName: string): Promise<OnboardingWorkspaceResult> {
    const dataRoot = await input.openDataRoot(rootPath);
    const workspace = await input.enroll({ rootPath: dataRoot.path, displayName });
    await input.refresh(dataRoot);
    const state = writeState({
      ...readOrCreateState(),
      currentStep: 'ai',
      workspace: { workspaceId: workspace.id, rootPath: workspace.rootPath, createdAt: now() },
      updatedAt: now()
    });
    return { workspace, state };
  }
  function createDefaultWorkspace(): Promise<OnboardingWorkspaceResult> {
    return createWorkspaceAt(defaultWorkspacePath(), DEFAULT_WORKSPACE_DISPLAY_NAME);
  }
  async function chooseCustomWorkspace(): Promise<OnboardingWorkspaceResult | null> {
    const rootPath = await input.chooseWorkspaceDirectory();
    if (!rootPath) return null;
    return createWorkspaceAt(rootPath, DEFAULT_WORKSPACE_DISPLAY_NAME);
  }
  function testAiConnection(settings: OnboardingAiTestSettings): Promise<OnboardingAiTestResult> {
    return runAiConnectionTest({ ...settings, fetchImpl: input.fetchImpl, now });
  }
  function saveAiConfig(settings: OnboardingAiSaveInput, testResult: OnboardingAiTestRecord | null = null): OnboardingAiSaveResult {
    if (!testResult || testResult.model !== settings.model || testResult.api !== settings.api) throw onboardingError('AI_REQUIRED', '请先用当前接口和模型完成连接测试。');
    let api: PiApiType;
    try {
      api = requirePiApiType(settings.api);
    } catch {
      throw onboardingError('INVALID_API', 'Pi 接口类型不受支持，仅支持 OpenAI Responses 或 OpenAI Chat Completions。');
    }
    const saved = input.savePiConfig({
      name: settings.name,
      baseUrl: normalizePiBaseUrl(settings.baseUrl),
      model: settings.model,
      api,
      thinking: settings.thinking,
      nativeSearch: settings.nativeSearch,
      contextWindow: settings.contextWindow,
      maxTokens: settings.maxTokens,
      apiKey: settings.apiKey
    });
    if (!saved.activeId) throw onboardingError('INVALID_STATE', '保存后没有活动 Pi 配置。');
    const ai: OnboardingAiRecord = {
      profileId: saved.activeId,
      savedAt: now(),
      testedAt: testResult?.testedAt ?? null,
      lastTest: testResult
    };
    const state = writeState({ ...readOrCreateState(), currentStep: 'platforms', ai, updatedAt: now() });
    return { piConfig: saved, ai, state };
  }
  function recordPlatformStatus(platformId: string, status: PlatformCheckStatus): PlatformChecks {
    const id = platformId.trim();
    if (!id) throw onboardingError('INVALID_STATE', '平台标识不能为空。');
    const state = readOrCreateState();
    const platforms = { ...state.platforms, [id]: { status, updatedAt: now() } };
    writeState({ ...state, platforms, updatedAt: now() });
    return platforms;
  }
  function skipPlatform(platformId: string): PlatformChecks {
    return recordPlatformStatus(platformId, 'skipped');
  }
  function clearPlatform(platformId: string): PlatformChecks {
    const state = readOrCreateState();
    const platforms = { ...state.platforms };
    delete platforms[platformId];
    writeState({ ...state, platforms, updatedAt: now() });
    return platforms;
  }
  async function completeOnboarding(): Promise<OnboardingStatus> {
    const state = readOrCreateState();
    const prereqs = await prerequisites(state);
    if (!prereqs.workspaceReady) throw onboardingError('WORKSPACE_REQUIRED', '完成向导前请先创建工作空间。');
    if (!prereqs.aiReady) throw onboardingError('AI_REQUIRED', '完成向导前请先配置并测试 Pi API。');
    const completed = writeState({ ...state, currentStep: 'complete', completedAt: now(), updatedAt: now() });
    return statusFrom(completed, prereqs);
  }
  return {
    onboardingPath: statePath,
    defaultWorkspacePath,
    inspectStatus,
    recordStep,
    createDefaultWorkspace,
    chooseCustomWorkspace,
    testAiConnection,
    saveAiConfig,
    recordPlatformStatus,
    skipPlatform,
    clearPlatform,
    completeOnboarding
  };
}
