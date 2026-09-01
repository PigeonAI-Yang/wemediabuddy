import { useEffect, useMemo, useRef, useState } from 'react';
import type { Theme } from './app-types';
import { BrowserSettings } from './browser-settings';
import { IntelligenceChannelsView } from './intelligence-channels-view';
import { PiSkillsSettings } from './pi-skills-settings';
import { AgentsSettingsPanel } from './agents-settings-panel';
import { appConfirm } from './app-confirm';
import { AppUpdateSettings } from './app-update-settings';
import { SettingsIcon, type SettingsIconName } from './settings-icons';
import { TodayDailyCycle } from './today-daily-cycle';
import type { WmbRoleId, WmbRoleModelCandidate, WmbRoleModelPolicy, WmbSettingsSnapshot } from './wmb-settings-types';

const ROLE_DEFINITIONS: Array<{ id: WmbRoleId; label: string; description: string }> = [
  { id: 'desk', label: '主管 / Pi', description: '主编席对话与全站内部审批。' },
  { id: 'reporter', label: '记者', description: '发现、采集和整理外部线索。' },
  { id: 'planner', label: '策划', description: '判断机会、形成选题与复盘方向。' },
  { id: 'writer', label: '写手', description: '根据已批准的方向起草内容。' },
  { id: 'librarian', label: '资料员', description: '整理资料库与主题家底。' }
];
type RolePolicyDraft = Record<WmbRoleId, WmbRoleModelCandidate[]>;
type PiModelOption = { id: string; contextWindow?: number; maxTokens?: number };
type RoleModelFetchRecord = { requestKey: string; models: PiModelOption[]; error?: string };
const ROLE_THINKING_OPTIONS = [
  { value: 'off', label: '关闭思考' },
  { value: 'minimal', label: '最低' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
  { value: 'max', label: '最大' }
] as const;
type RoleThinkingLevel = typeof ROLE_THINKING_OPTIONS[number]['value'];

function isRoleThinkingLevel(value: unknown): value is RoleThinkingLevel {
  return ROLE_THINKING_OPTIONS.some((option) => option.value === value);
}

function roleCandidateIdentity(candidate: WmbRoleModelCandidate): string {
  return JSON.stringify([candidate.profileId, candidate.model]);
}

function roleCandidateValue(candidate: WmbRoleModelCandidate): string {
  return JSON.stringify({ profileId: candidate.profileId, model: candidate.model });
}

function parseRoleCandidateValue(value: string): WmbRoleModelCandidate | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || !('profileId' in parsed) || !('model' in parsed) || typeof parsed.profileId !== 'string' || typeof parsed.model !== 'string') return null;
    const thinking = 'thinking' in parsed ? parsed.thinking : undefined;
    if (thinking !== undefined && !isRoleThinkingLevel(thinking)) return null;
    return { profileId: parsed.profileId, model: parsed.model, ...(thinking === undefined ? {} : { thinking }) };
  } catch {
    return null;
  }
}

function isPiModelOption(value: unknown): value is PiModelOption {
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string') return false;
  return value.id.length > 0;
}

function normalizePiModels(models: unknown): PiModelOption[] {
  if (!Array.isArray(models)) return [];
  const seen = new Set<string>();
  return models.filter((model): model is PiModelOption => {
    if (!isPiModelOption(model) || seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

function rolePolicyDraftFromSettings(settings: WmbSettingsSnapshot | null | undefined): RolePolicyDraft {
  return ROLE_DEFINITIONS.reduce((draft, role) => {
    draft[role.id] = (settings?.pi.roleModelPolicies?.[role.id]?.candidates ?? []).map((candidate) => ({
      profileId: typeof candidate?.profileId === 'string' ? candidate.profileId : '',
      model: typeof candidate?.model === 'string' ? candidate.model : '',
      thinking: candidate?.thinking
    }));
    return draft;
  }, {} as RolePolicyDraft);
}

function policyInputFromDraft(draft: RolePolicyDraft): Record<WmbRoleId, WmbRoleModelPolicy> {
  return ROLE_DEFINITIONS.reduce((policies, role) => {
    policies[role.id] = { candidates: draft[role.id].map((candidate) => ({ ...candidate })) };
    return policies;
  }, {} as Record<WmbRoleId, WmbRoleModelPolicy>);
}

function validateRolePolicyDraft(draft: RolePolicyDraft, settings: WmbSettingsSnapshot | null | undefined): string[] {
  const profiles = settings?.pi.profiles ?? [];
  const errors: string[] = [];
  for (const role of ROLE_DEFINITIONS) {
    const candidates = draft[role.id] ?? [];
    if (candidates.length === 0) {
      errors.push(`${role.label}至少需要一个模型候选。`);
      continue;
    }
    const identities = new Set<string>();
    for (const candidate of candidates) {
      const profileId = typeof candidate?.profileId === 'string' ? candidate.profileId : '';
      const model = typeof candidate?.model === 'string' ? candidate.model : '';
      if (!profileId.trim() || !model.trim()) {
        errors.push(`${role.label}的候选必须同时包含 Provider 预设和模型。`);
        continue;
      }
      const identity = roleCandidateIdentity({ profileId, model });
      if (identities.has(identity)) errors.push(`${role.label}的 Provider 与模型组合不能重复。`);
      identities.add(identity);
      const profile = profiles.find((item) => item.id === profileId);
      if (!profile) errors.push(`${role.label}引用的预设已不存在，请重新分配。`);
      else if (!profile.configured) errors.push(`${role.label}的预设“${profile.name}”尚未完成 API 配置。`);
    }
  }
  return errors;
}

function formatThinking(thinking: WmbRoleModelCandidate['thinking']): string {
  const labels: Record<RoleThinkingLevel, string> = {
    off: '关闭思考', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大'
  };
  return thinking ? labels[thinking] : '默认思考';
}

function formatRoleCandidateThinking(candidate: WmbRoleModelCandidate, providerThinking: WmbRoleModelCandidate['thinking']): string {
  const inherited = candidate.thinking === undefined;
  const effectiveThinking = inherited ? providerThinking : candidate.thinking;
  const source = inherited ? '继承 Provider 默认' : '候选覆盖';
  return `${source}：${formatThinking(effectiveThinking)}`;
}

function formatPiConfigError(error: unknown): string {
  const value = error as { message?: unknown; details?: { roleIds?: unknown; taskReferences?: unknown } } | null;
  const message = value && typeof value.message === 'string' ? value.message : '操作失败';
  const details = value?.details;
  const roleIds = Array.isArray(details?.roleIds) ? details.roleIds.filter((id): id is WmbRoleId => ROLE_DEFINITIONS.some((role) => role.id === id)) : [];
  const tasks = Array.isArray(details?.taskReferences) ? details.taskReferences.filter((task): task is { taskId?: string } => Boolean(task && typeof task === 'object')) : [];
  const roleText = roleIds.length ? `引用角色：${roleIds.map((id) => ROLE_DEFINITIONS.find((role) => role.id === id)?.label ?? id).join('、')}。` : '';
  const taskText = tasks.length ? `还有 ${tasks.length} 个未结束任务引用此预设${tasks.some((task) => task.taskId) ? `（${tasks.map((task) => task.taskId).filter(Boolean).join('、')}）` : ''}。` : '';
  return `${message}${roleText}${taskText}`;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
export function SettingsView({ dataRoot, settings, browserChoice, setBrowserChoice, refresh, theme, setTheme, back }: {
  dataRoot: string | null; settings: Awaited<ReturnType<typeof window.wmb.getSettings>>; browserChoice: string;
  setBrowserChoice: (value: string) => void; refresh: () => void; theme: Theme;
  setTheme: (value: Theme) => void; back: () => void;
}): React.JSX.Element {
  type SettingsSection = 'general' | 'ai' | 'skills' | 'data' | 'browser' | 'channels' | 'daily-automation' | 'agent' | 'diagnostics' | 'about';
  const dailyAutomationBusinessDate = useMemo(() => {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    } catch {
      return new Date().toISOString().slice(0, 10);
    }
  }, []);
  const [section, setSection] = useState<SettingsSection>(() => {
    const requested = sessionStorage.getItem('wmb.settingsSection');
    sessionStorage.removeItem('wmb.settingsSection');
    if (requested === 'lists') return 'channels';
    const allowed: SettingsSection[] = ['general', 'ai', 'skills', 'data', 'browser', 'channels', 'daily-automation', 'agent', 'diagnostics', 'about'];
    return allowed.includes(requested as SettingsSection) ? requested as SettingsSection : 'ai';
  });
  const [piProfileId, setPiProfileId] = useState(settings?.pi.activeId ?? '');
  const [piName, setPiName] = useState(settings?.pi.profiles.find((profile) => profile.id === settings.pi.activeId)?.name ?? '');
  const [piApi, setPiApi] = useState<'openai-responses' | 'openai-completions' | 'anthropic-messages'>(settings?.pi.profiles.find((profile) => profile.id === settings.pi.activeId)?.api ?? 'openai-responses');
  const [piBaseUrl, setPiBaseUrl] = useState(settings?.pi.baseUrl ?? '');
  const [piModel, setPiModel] = useState(settings?.pi.model ?? '');
  const [piThinking, setPiThinking] = useState<WmbSettingsSnapshot['pi']['profiles'][number]['thinking']>('off');
  const [piAuthMode, setPiAuthMode] = useState<'bearer' | 'x-api-key' | 'none'>(settings?.pi.profiles.find((profile) => profile.id === settings.pi.activeId)?.authMode ?? 'bearer');
  const [piCredentialKind, setPiCredentialKind] = useState<'encrypted' | 'environment' | 'command' | 'none'>(settings?.pi.profiles.find((profile) => profile.id === settings.pi.activeId)?.credentialSourceKind ?? 'encrypted');
  const [piCredentialVariable, setPiCredentialVariable] = useState('');
  const [piCredentialCommand, setPiCredentialCommand] = useState('');
  const [piCredentialArgs, setPiCredentialArgs] = useState('');
  const [piApiKey, setPiApiKey] = useState('');
  const [piConfigNote, setPiConfigNote] = useState('');
  const [piModels, setPiModels] = useState<PiModelOption[]>([]);
  const [discoveredProviders, setDiscoveredProviders] = useState<Awaited<ReturnType<typeof window.wmb.discoverPiProviders>>>([]);
  const [discoveringProviders, setDiscoveringProviders] = useState(false);
  const [probingProvider, setProbingProvider] = useState(false);
  const [roleModelCatalog, setRoleModelCatalog] = useState<Record<string, PiModelOption[]>>({});
  const [roleModelFetchErrors, setRoleModelFetchErrors] = useState<Record<string, string>>({});
  const roleModelFetchCache = useRef(new Map<string, RoleModelFetchRecord>());
  const [piContextWindow, setPiContextWindow] = useState('');
  const [piMaxTokens, setPiMaxTokens] = useState('');
  const [piText, setPiText] = useState(true);
  const [piVision, setPiVision] = useState(true);
  const [piNativeSearch, setPiNativeSearch] = useState(false);
  const [piImageGeneration, setPiImageGeneration] = useState(false);
  const [piJsonOutput, setPiJsonOutput] = useState(true);
  const [piStreaming, setPiStreaming] = useState(true);
  const [loadingPiModels, setLoadingPiModels] = useState(false);
  const [rolePolicyDraft, setRolePolicyDraft] = useState<RolePolicyDraft>(() => rolePolicyDraftFromSettings(settings));
  const [rolePolicyDirty, setRolePolicyDirty] = useState(false);
  const [rolePolicySaving, setRolePolicySaving] = useState(false);
  const [rolePolicyNote, setRolePolicyNote] = useState('');
  const [illustrationProfileId, setIllustrationProfileId] = useState('');
  const [illustrationModel, setIllustrationModel] = useState('');
  const [illustrationConfigNote, setIllustrationConfigNote] = useState('');
  const [runtimeNote, setRuntimeNote] = useState('');
  const [workspaceNote, setWorkspaceNote] = useState('');
  const [workspaces, setWorkspaces] = useState<{ activeWorkspaceId: string | null; workspaces: Array<{ id: string; displayName: string; rootPath: string }> }>({ activeWorkspaceId: null, workspaces: [] });
  const [workspaceProposals, setWorkspaceProposals] = useState<Awaited<ReturnType<typeof window.wmb.listWorkspaceProposals>>>([]);
  const selectPiProfile = (id: string, { keepNote = false } = {}) => {
    const profile = settings?.pi.profiles.find((item) => item.id === id);
    setPiProfileId(id);
    setPiName(profile?.name ?? '');
    setPiApi(profile?.api ?? 'openai-responses');
    setPiAuthMode(profile?.authMode ?? 'bearer');
    setPiCredentialKind(profile?.credentialSourceKind ?? 'encrypted');
    setPiCredentialVariable('');
    setPiCredentialCommand('');
    setPiCredentialArgs('');
    setPiBaseUrl(profile?.baseUrl ?? '');
    setPiModel(profile?.model ?? '');
    setPiThinking(profile?.thinking ?? 'off');
    setPiContextWindow(profile?.contextWindow ? String(profile.contextWindow) : '');
    setPiMaxTokens(profile?.maxTokens ? String(profile.maxTokens) : '');
    setPiText(profile?.capabilities.text !== false);
    setPiVision(profile?.capabilities.vision !== false);
    setPiNativeSearch(profile?.capabilities.nativeSearch === true);
    setPiImageGeneration(profile?.capabilities.imageGeneration === true);
    setPiJsonOutput(profile?.capabilities.jsonOutput !== false);
    setPiStreaming(profile?.capabilities.streaming !== false);
    setPiApiKey('');
    setPiModels([]);
    if (!keepNote) setPiConfigNote('');
  };
  useEffect(() => {
    // 保存/激活后的 settings 刷新也会走这里：保留刚写入的配置反馈（如「已保存并切换到此配置」），
    // 只在用户手动切换预设时由 selectPiProfile 清空提示。
    selectPiProfile(settings?.pi.activeId ?? '', { keepNote: true });
  }, [settings?.pi.activeId, settings?.pi.profiles]);
  useEffect(() => {
    if (rolePolicyDirty) return;
    setRolePolicyDraft(rolePolicyDraftFromSettings(settings));
  }, [settings?.pi.modelPolicyRevision, settings?.pi.profiles, rolePolicyDirty]);
  useEffect(() => {
    if (section !== 'ai' || !settings) return;
    let cancelled = false;
    const configuredProfiles = settings.pi.profiles.filter((profile) => profile.configured);
    const pending = configuredProfiles.map(async (profile) => {
      const requestKey = `${profile.baseUrl}\u0000${profile.api}`;
      const cached = roleModelFetchCache.current.get(profile.id);
      if (cached?.requestKey === requestKey) return [profile.id, cached] as const;
      try {
        const models = normalizePiModels(await window.wmb.listPiModels({ id: profile.id, baseUrl: profile.baseUrl, api: profile.api }));
        const record: RoleModelFetchRecord = { requestKey, models };
        roleModelFetchCache.current.set(profile.id, record);
        return [profile.id, record] as const;
      } catch (error) {
        const record: RoleModelFetchRecord = {
          requestKey,
          models: [],
          error: error instanceof Error ? error.message : '获取模型失败'
        };
        roleModelFetchCache.current.set(profile.id, record);
        return [profile.id, record] as const;
      }
    });
    void Promise.all(pending).then((entries) => {
      if (cancelled) return;
      const nextCatalog: Record<string, PiModelOption[]> = {};
      const nextErrors: Record<string, string> = {};
      for (const [profileId, record] of entries) {
        nextCatalog[profileId] = record.models;
        if (record.error) nextErrors[profileId] = record.error;
      }
      setRoleModelCatalog(nextCatalog);
      setRoleModelFetchErrors(nextErrors);
    });
    return () => { cancelled = true; };
  }, [section, settings?.pi.profiles]);
  useEffect(() => {
    if (section !== 'ai') return;
    void window.wmb.getIllustrationImageConfig().then((config) => {
      if (!config) return;
      setIllustrationProfileId(config.profileId);
      setIllustrationModel(config.model);
    }).catch(() => {});
  }, [section, settings?.pi.profiles]);
  useEffect(() => { if (section === 'data') void Promise.all([window.wmb.listWorkspaces(), window.wmb.listWorkspaceProposals()]).then(([listed, proposals]) => { setWorkspaces(listed); setWorkspaceProposals(proposals); }); }, [section, dataRoot]);
  const providerCredentialSource = () => {
    if (piCredentialKind === 'environment') return { kind: 'environment' as const, variable: piCredentialVariable.trim() };
    if (piCredentialKind === 'command') return { kind: 'command' as const, executable: piCredentialCommand.trim(), args: piCredentialArgs.split(/\r?\n/).map((value) => value.trim()).filter(Boolean) };
    if (piCredentialKind === 'none') return { kind: 'none' as const };
    return undefined;
  };
  const saveProfile = async () => {
    try {
      await window.wmb.savePiConfig({
        id: piProfileId || undefined, name: piName, baseUrl: piBaseUrl, model: piModel, api: piApi,
        authMode: piAuthMode, credentialSource: providerCredentialSource(), thinking: piThinking,
        text: piText, vision: piVision, nativeSearch: piNativeSearch, imageGeneration: piImageGeneration, jsonOutput: piJsonOutput, streaming: piStreaming,
        contextWindow: piContextWindow ? Number(piContextWindow) : null,
        maxTokens: piMaxTokens ? Number(piMaxTokens) : null, apiKey: piApiKey || undefined
      });
      setPiApiKey('');
      setPiConfigNote('预设已保存并设为新任务的默认选择。');
      refresh();
    } catch (error) { setPiConfigNote(formatPiConfigError(error)); }
  };
  const saveIllustrationConfig = async () => {
    if (!illustrationProfileId || !illustrationModel.trim()) { setIllustrationConfigNote('请选择已配置的 Provider 预设并填写图像模型。'); return; }
    try {
      const result = await window.wmb.saveIllustrationImageConfig({ profileId: illustrationProfileId, model: illustrationModel.trim() });
      setIllustrationConfigNote(result.ok ? '独立配图模型已保存。' : result.error?.message || '保存失败');
    } catch (error) { setIllustrationConfigNote(error instanceof Error ? error.message : '保存失败'); }
  };
  const fetchModels = async () => {
    setLoadingPiModels(true);
    setPiConfigNote('');
    try {
      const models = await window.wmb.listPiModels({ id: piProfileId || undefined, baseUrl: piBaseUrl, api: piApi, authMode: piAuthMode, credentialSource: providerCredentialSource(), apiKey: piApiKey || undefined });
      setPiModels(models);
      const selected = models.find((item) => item.id === piModel) ?? models[0];
      setPiModel(selected.id);
      setPiContextWindow(selected.contextWindow ? String(selected.contextWindow) : '');
      setPiMaxTokens(selected.maxTokens ? String(selected.maxTokens) : '');
      setPiConfigNote(`已获取 ${models.length} 个模型`);
    } catch (error) {
      setPiModels([]);
      setPiConfigNote(`${error instanceof Error ? error.message : '获取模型失败'} 仍可手动填写模型。`);
    } finally { setLoadingPiModels(false); }
  };
  const discoverProviders = async () => {
    setDiscoveringProviders(true);
    try { const found = await window.wmb.discoverPiProviders(); setDiscoveredProviders(found); setPiConfigNote(found.length ? `发现 ${found.length} 个本机 Provider。` : '没有发现可自动接入的本机 Provider。'); }
    catch (error) { setPiConfigNote(error instanceof Error ? error.message : '发现 Provider 失败'); }
    finally { setDiscoveringProviders(false); }
  };
  const applyDiscoveredProvider = (candidate: Awaited<ReturnType<typeof window.wmb.discoverPiProviders>>[number]) => {
    setPiProfileId(''); setPiName(candidate.name); setPiBaseUrl(candidate.baseUrl); setPiApi(candidate.api); setPiAuthMode(candidate.authMode);
    setPiCredentialKind(candidate.credentialSource.kind); setPiCredentialVariable(candidate.credentialSource.kind === 'environment' ? candidate.credentialSource.variable : '');
    setPiCredentialCommand(candidate.credentialSource.kind === 'command' ? candidate.credentialSource.executable : ''); setPiCredentialArgs(candidate.credentialSource.kind === 'command' ? candidate.credentialSource.args.join(' ') : '');
    setPiModel(candidate.suggestedModel ?? ''); setPiText(candidate.capabilities.text); setPiVision(candidate.capabilities.vision); setPiNativeSearch(candidate.capabilities.nativeSearch); setPiImageGeneration(candidate.capabilities.imageGeneration); setPiJsonOutput(candidate.capabilities.jsonOutput); setPiStreaming(candidate.capabilities.streaming); setPiModels([]); setPiApiKey('');
  };
  const probeProvider = async () => {
    setProbingProvider(true);
    try { const result = await window.wmb.probePiProvider({ id: piProfileId || undefined, baseUrl: piBaseUrl, api: piApi, authMode: piAuthMode, credentialSource: providerCredentialSource(), apiKey: piApiKey || undefined }); setPiConfigNote(result.state === 'healthy' ? `连接正常${result.modelCount ? `，发现 ${result.modelCount} 个模型` : ''}。` : `连接失败：${result.lastError ?? '未知错误'}`); refresh(); }
    catch (error) { setPiConfigNote(error instanceof Error ? error.message : '连接测试失败'); }
    finally { setProbingProvider(false); }
  };

  const roleModelOptionsForProfile = (profile: WmbSettingsSnapshot['pi']['profiles'][number]): PiModelOption[] => {
    const fetched = roleModelCatalog[profile.id] ?? [];
    if (fetched.length > 0) return fetched;
    return profile.model.trim() ? [{ id: profile.model }] : [];
  };
  const roleModelFetchErrorEntries = (settings?.pi.profiles ?? [])
    .filter((profile) => roleModelFetchErrors[profile.id])
    .map((profile) => ({ profile, error: roleModelFetchErrors[profile.id] }));
  const rolePolicyErrors = validateRolePolicyDraft(rolePolicyDraft, settings);
  const updateRoleChain = (roleId: WmbRoleId, update: (candidates: WmbRoleModelCandidate[]) => WmbRoleModelCandidate[]) => {
    setRolePolicyDraft((current) => ({ ...current, [roleId]: update([...(current[roleId] ?? [])]) }));
    setRolePolicyDirty(true);
    setRolePolicyNote('');
  };
  const updateRoleCandidateThinking = (roleId: WmbRoleId, index: number, thinking: WmbRoleModelCandidate['thinking']) => {
    updateRoleChain(roleId, (candidates) => candidates.map((candidate, itemIndex) => itemIndex === index ? { ...candidate, thinking } : candidate));
  };
  const addRoleCandidate = (roleId: WmbRoleId, value: string) => {
    const candidate = parseRoleCandidateValue(value);
    if (!candidate) return;
    updateRoleChain(roleId, (candidates) => candidates.some((item) => roleCandidateIdentity(item) === roleCandidateIdentity(candidate)) ? candidates : [...candidates, candidate]);
  };
  const moveRoleCandidate = (roleId: WmbRoleId, index: number, direction: -1 | 1) => {
    updateRoleChain(roleId, (candidates) => {
      const next = index + direction;
      if (index < 0 || next < 0 || next >= candidates.length) return candidates;
      [candidates[index], candidates[next]] = [candidates[next], candidates[index]];
      return candidates;
    });
  };
  const removeRoleCandidate = (roleId: WmbRoleId, index: number) => {
    updateRoleChain(roleId, (candidates) => candidates.length <= 1 ? candidates : candidates.filter((_candidate, itemIndex) => itemIndex !== index));
  };
  const saveRolePolicies = async () => {
    if (!settings) return;
    const errors = validateRolePolicyDraft(rolePolicyDraft, settings);
    if (errors.length > 0) {
      setRolePolicyNote(errors.join(' '));
      return;
    }
    setRolePolicySaving(true);
    setRolePolicyNote('');
    try {
      await window.wmb.saveRoleModelPolicies({
        roleModelPolicies: policyInputFromDraft(rolePolicyDraft),
        expectedRevision: settings.pi.modelPolicyRevision
      });
      setRolePolicyDirty(false);
      setRolePolicyNote('五个角色的模型策略已一次性保存，新任务将使用新的策略版本。');
      refresh();
    } catch (error) {
      setRolePolicyNote(formatPiConfigError(error));
    } finally {
      setRolePolicySaving(false);
    }
  };

  const navigationGroups: Array<{ label: string; items: Array<{ id: SettingsSection; label: string; icon: SettingsIconName }> }> = [
    { label: '基础', items: [
      { id: 'general', label: '常规', icon: 'general' },
      { id: 'ai', label: 'AI 与模型', icon: 'ai' },
      { id: 'skills', label: 'Pi Skills', icon: 'skills' }
    ] },
    { label: '采集与账号', items: [
      { id: 'browser', label: '浏览器与账号', icon: 'browser' },
      { id: 'channels', label: '情报渠道', icon: 'channels' }
    ] },
    { label: '自动化', items: [
      { id: 'daily-automation', label: '每日自动化', icon: 'daily-automation' }
    ] },
    { label: '系统', items: [
      { id: 'agent', label: '智能体接入', icon: 'agent' },
      { id: 'data', label: '数据与存储', icon: 'data' },
      { id: 'diagnostics', label: '系统诊断', icon: 'diagnostics' }
    ] }
  ];
  const headings: Record<SettingsSection, { title: string; description: string }> = {
    general: { title: '常规', description: '' },
    ai: { title: 'AI 与模型', description: '' },
    skills: { title: 'Pi Skills', description: '管理 Pi 在新会话中加载的工作方法。' },
    data: { title: '数据与存储', description: '' },
    browser: { title: '浏览器与账号', description: '设置登录环境，并确认各平台使用的账号。' },
    channels: { title: '情报渠道', description: '' },
    'daily-automation': { title: '每日自动化', description: '定时、自动执行、立即执行与最近结算；由此统一管理每日编排。前置依赖请检查浏览器与情报渠道。' },
    agent: { title: '智能体与角色', description: '' },
    diagnostics: { title: '系统诊断', description: '' },
    about: { title: '关于 WMB', description: '' }
  };
  return <section className="settings-workspace">
    <aside className="settings-nav">
      <button type="button" className="settings-back" onClick={back}><b><SettingsIcon name="back" /></b><span>返回工作台</span></button>
      <nav aria-label="设置菜单">{navigationGroups.map((group) => <div className="settings-nav-group" key={group.label}>
        <p>{group.label}</p>
        {group.items.map((item) => <button type="button" key={item.id} className={section === item.id ? 'active' : ''} onClick={() => setSection(item.id)} title={item.label}><b><SettingsIcon name={item.icon} /></b><span>{item.label}</span></button>)}
      </div>)}</nav>
      <nav className="settings-nav-foot"><button type="button" className={section === 'about' ? 'active' : ''} onClick={() => setSection('about')}><b><SettingsIcon name="about" /></b><span>关于 WMB</span></button></nav>
    </aside>
    <div className="settings-content">
      <div className="settings-content-inner">
        <header className="settings-heading"><h2>{headings[section].title}</h2>{headings[section].description && <p>{headings[section].description}</p>}</header>
        {section === 'general' && <section className="settings-section settings-general-grid">
          <article className="settings-preference-group">
            <div className="settings-section-heading"><h3>界面主题</h3><p>切换立即生效并自动记住。</p></div>
            <div className="settings-theme-options" role="group" aria-label="界面主题">
              <button type="button" aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}><span aria-hidden="true"><SettingsIcon name="moon" /></span><span><strong>黑夜紫罗兰</strong><small>深色工作环境</small></span></button>
              <button type="button" aria-pressed={theme === 'light'} onClick={() => setTheme('light')}><span aria-hidden="true"><SettingsIcon name="sun" /></span><span><strong>白昼紫罗兰</strong><small>明亮工作环境</small></span></button>
            </div>
          </article>
          <article className="settings-preference-group">
            <div className="settings-section-heading"><h3>启动与语言</h3></div>
            <div className="settings-row"><div><h3>启动后打开</h3></div><div className="settings-row-actions"><strong>今日内容</strong><span className="pill-status gray">固定</span></div></div>
            <div className="settings-row"><div><h3>界面语言</h3></div><div className="settings-row-actions"><strong>简体中文</strong><span className="pill-status gray">固定</span></div></div>
          </article>
        </section>}
        {section !== 'general' && !settings && <section className="settings-section"><p>正在加载设置…若长时间空白，请返回工作台再进设置，或重启应用。</p></section>}
        {section === 'ai' && settings && <>
          <section className="settings-section settings-preset-section" aria-labelledby="model-preset-title">
            <div className="settings-section-heading"><h3 id="model-preset-title">模型预设</h3><p>预设保存接口、模型和密钥；角色分配只引用预设，不复制密钥。</p></div>
            <div className="settings-profile-list">
              {settings.pi.profiles.length === 0 && <div className="settings-fallback-empty">还没有模型预设，请先添加一个预设。</div>}
              {settings.pi.profiles.map((profile) => <button type="button" key={profile.id} className={`settings-profile${profile.id === piProfileId ? ' selected' : ''}`} onClick={() => selectPiProfile(profile.id)}>
                <span className="settings-provider-mark"><SettingsIcon name="ai" /></span>
                <span><strong>{profile.name}</strong><small>{profile.model || '未填写模型'} · {profile.api === 'openai-completions' ? 'OpenAI Chat Completions' : profile.api === 'anthropic-messages' ? 'Anthropic Messages' : 'OpenAI Responses'} · {profile.credentialSourceLabel} · {formatThinking(profile.thinking)}{profile.capabilities.text ? ' · 文本' : ''}{profile.capabilities.vision ? ' · 视觉' : ''}{profile.capabilities.nativeSearch ? ' · 搜索' : ''}{profile.capabilities.imageGeneration ? ' · 生图' : ''}{profile.capabilities.jsonOutput ? ' · JSON' : ''}{profile.capabilities.streaming ? ' · 流式' : ''}</small></span>
                <em className={profile.health.state === 'unhealthy' ? 'unconfigured' : profile.configured ? 'configured' : 'unconfigured'}>{profile.health.state === 'healthy' ? '连接正常' : profile.health.state === 'unhealthy' ? '连接异常' : profile.configured ? '已配置' : '未完成配置'}{profile.active ? ' · 默认选择' : ''}</em>
              </button>)}
            </div>
            <div className="settings-inline-actions settings-preset-actions">
              <button type="button" className="text-button settings-icon-text-button" onClick={() => selectPiProfile('')}><SettingsIcon name="plus" />添加模型预设</button>
              <button type="button" className="secondary-button" disabled={discoveringProviders} onClick={() => void discoverProviders()}>{discoveringProviders ? '发现中…' : '发现本机 Provider'}</button>
              <details className="settings-action-disclosure">
                <summary className="text-button settings-icon-text-button"><SettingsIcon name="plus" />更多预设模板</summary>
                <div className="settings-action-disclosure-menu">
                  <button type="button" className="text-button settings-icon-text-button" onClick={() => {
                    setPiProfileId(''); setPiName('OpenCode Go'); setPiBaseUrl('https://opencode.ai/zen/go/v1'); setPiAuthMode('bearer'); setPiCredentialKind('encrypted');
                    setPiApi('openai-completions'); setPiModel(''); setPiThinking('off'); setPiApiKey(''); setPiModels([]); setPiContextWindow(''); setPiMaxTokens(''); setPiText(true); setPiVision(true); setPiNativeSearch(false); setPiImageGeneration(false); setPiJsonOutput(true); setPiStreaming(true);
                    setPiConfigNote('填写 OpenCode Go API Key 后获取模型。');
                  }}><SettingsIcon name="plus" />使用 OpenCode Go 模板</button>
                </div>
              </details>
            </div>
            {discoveredProviders.length > 0 && <div className="settings-profile-list" aria-label="发现的本机 Provider">{discoveredProviders.map((candidate) => <button type="button" key={`${candidate.source}-${candidate.baseUrl}`} className="settings-profile" onClick={() => applyDiscoveredProvider(candidate)}><span className="settings-provider-mark"><SettingsIcon name="ai" /></span><span><strong>{candidate.name}</strong><small>{candidate.baseUrl} · 点击载入，保存后才会启用</small></span><em>已发现</em></button>)}</div>}
            <div className="settings-profile-editor" aria-labelledby="profile-editor-title">
              <div className="settings-section-heading"><h3 id="profile-editor-title">{piName || '新模型预设'}</h3><p>先完成 Provider 预设，再在下方角色分配中引用它。这里仅修改接口、模型和密钥。</p></div>
            <div className="settings-form">
            <label><span>预设名称</span><input value={piName} onChange={(event) => setPiName(event.target.value)} placeholder="例如：本地 CPA" /></label>
            <label><span>接口协议</span><select value={piApi} onChange={(event) => { const api = event.target.value as 'openai-responses' | 'openai-completions' | 'anthropic-messages'; setPiApi(api); if (api === 'anthropic-messages' && piAuthMode === 'bearer') setPiAuthMode('x-api-key'); setPiModels([]); }}>
              <option value="openai-responses">OpenAI Responses</option>
              <option value="openai-completions">OpenAI Chat Completions</option>
              <option value="anthropic-messages">Anthropic Messages</option>
            </select></label>
            <label className="wide">
              <span>模型</span>
              <div className="model-picker">
                {piModels.length
                  ? <select value={piModel} onChange={(event) => { const model = piModels.find((item) => item.id === event.target.value)!; setPiModel(model.id); setPiContextWindow(model.contextWindow ? String(model.contextWindow) : ''); setPiMaxTokens(model.maxTokens ? String(model.maxTokens) : ''); }}>{piModels.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}</select>
                  : <input value={piModel} onChange={(event) => { setPiModel(event.target.value); setPiContextWindow(''); setPiMaxTokens(''); }} placeholder="获取后选择，或手动填写" />}
                <button type="button" className="secondary-button" disabled={loadingPiModels || !piBaseUrl.trim()} onClick={() => void fetchModels()}>{loadingPiModels ? '获取中…' : '获取模型'}</button>
              </div>
            </label>
            <label><span>思考等级</span><select value={piThinking ?? 'off'} onChange={(event) => setPiThinking(event.target.value as WmbSettingsSnapshot['pi']['profiles'][number]['thinking'])}><option value="off">关闭思考</option><option value="minimal">最低</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="xhigh">极高</option><option value="max">最大</option></select></label>
            <label><span>上下文长度（tokens）</span><input type="number" min="1" step="1" value={piContextWindow} onChange={(event) => setPiContextWindow(event.target.value)} placeholder="由模型元数据决定" /></label>
            <label><span>最大输出（tokens）</span><input type="number" min="1" step="1" value={piMaxTokens} onChange={(event) => setPiMaxTokens(event.target.value)} placeholder="由模型元数据决定" /></label>
            <label className="settings-switch"><span>支持文本生成</span><input type="checkbox" checked={piText} onChange={(event) => setPiText(event.target.checked)} aria-label="支持文本生成" /></label>
            <label className="settings-switch"><span>支持视觉输入</span><input type="checkbox" checked={piVision} onChange={(event) => setPiVision(event.target.checked)} aria-label="支持视觉输入" /></label>
            <label className="settings-switch"><span>支持图像生成</span><input type="checkbox" checked={piImageGeneration} onChange={(event) => setPiImageGeneration(event.target.checked)} aria-label="支持图像生成" /></label>
            <label className="settings-switch"><span>模型自带联网搜索</span><input type="checkbox" checked={piNativeSearch} onChange={(event) => setPiNativeSearch(event.target.checked)} aria-label="模型自带联网搜索" /></label>
            <label className="settings-switch"><span>支持 JSON 结构化输出</span><input type="checkbox" checked={piJsonOutput} onChange={(event) => setPiJsonOutput(event.target.checked)} aria-label="支持 JSON 结构化输出" /></label>
            <label className="settings-switch"><span>支持流式输出</span><input type="checkbox" checked={piStreaming} onChange={(event) => setPiStreaming(event.target.checked)} aria-label="支持流式输出" /></label>
            <p className="settings-help wide">能力声明用于限制运行时路由；接口未提供模型元数据时仍可手动填写。</p>
            <label className="wide"><span>Base URL</span><input value={piBaseUrl} onChange={(event) => setPiBaseUrl(event.target.value)} placeholder="http://localhost:61946/v1" /></label>
            <label><span>鉴权方式</span><select value={piAuthMode} onChange={(event) => setPiAuthMode(event.target.value as typeof piAuthMode)}><option value="bearer">Authorization: Bearer</option><option value="x-api-key">x-api-key</option><option value="none">无需鉴权</option></select></label>
            <label><span>凭证来源</span><select value={piCredentialKind} onChange={(event) => setPiCredentialKind(event.target.value as typeof piCredentialKind)}><option value="encrypted">本机加密密钥</option><option value="environment">环境变量</option><option value="command">外部命令</option><option value="none">无需凭证</option></select></label>
            {piCredentialKind === 'encrypted' && <label className="wide"><span>API Key</span><input value={piApiKey} onChange={(event) => setPiApiKey(event.target.value)} placeholder={piProfileId ? '留空保持原密钥' : '填写 API Key'} type="password" /></label>}
            {piCredentialKind === 'environment' && <label className="wide"><span>环境变量名</span><input value={piCredentialVariable} onChange={(event) => setPiCredentialVariable(event.target.value)} placeholder="ANTHROPIC_API_KEY" /></label>}
            {piCredentialKind === 'command' && <><label className="wide"><span>凭证命令</span><input value={piCredentialCommand} onChange={(event) => setPiCredentialCommand(event.target.value)} placeholder="powershell.exe" /></label><label className="wide"><span>命令参数（每行一个）</span><textarea value={piCredentialArgs} onChange={(event) => setPiCredentialArgs(event.target.value)} rows={3} /></label></>}
            {piConfigNote && <p className="pi-config-note" aria-live="polite">{piConfigNote}</p>}
            <div className="settings-form-actions">
              <button type="button" className="secondary-button" disabled={probingProvider || !piBaseUrl.trim()} onClick={() => void probeProvider()}>{probingProvider ? '测试中…' : '测试连接'}</button>
              {piProfileId && !settings.pi.profiles.find((profile) => profile.id === piProfileId)?.active && <button type="button" className="secondary-button" onClick={() => void window.wmb.activatePiConfig(piProfileId).then(refresh)}>设为默认选择</button>}
              {piProfileId && <button type="button" className="danger-button" onClick={() => {
                void (async () => {
                  if (!await appConfirm({ title: '删除模型预设', message: '删除这个模型预设？若仍被角色或未结束任务引用，系统会拒绝删除并列出引用。', confirmLabel: '删除', danger: true })) return;
                  try {
                    await window.wmb.deletePiConfig(piProfileId);
                    setPiProfileId('');
                    setPiConfigNote('模型预设已删除。');
                    refresh();
                  } catch (error) {
                    setPiConfigNote(formatPiConfigError(error));
                  }
                })();
              }}>删除预设</button>}
              <button type="button" className="primary-button" onClick={() => void saveProfile()}>{piProfileId ? '保存预设修改' : '保存模型预设'}</button>
            </div>
            </div>
            </div>
          </section>

          <section className="settings-section settings-role-policy-section" aria-labelledby="role-policy-title">
            <div className="settings-section-heading"><h3 id="role-policy-title">角色分配</h3><p>每个角色从上到下依次尝试，首项是首选；思考等级可按候选覆盖，排序和移除收在“管理”中。调整后统一保存，不会打断当前正在生成的回复。</p></div>
            {roleModelFetchErrorEntries.length > 0 && <p className="settings-note error" role="status" aria-live="polite">部分 Provider 模型列表获取失败：{roleModelFetchErrorEntries.map(({ profile, error }) => `${profile.name}（${error}）`).join('；')}。仍保留各预设当前模型作为选择。</p>}
            <div className="role-policy-list">
              {ROLE_DEFINITIONS.map((role) => {
                const candidates = rolePolicyDraft[role.id] ?? [];
                const selectedIdentities = new Set(candidates.map(roleCandidateIdentity));
                const availableIdentities = new Set<string>();
                const availableCandidates = settings.pi.profiles.filter((profile) => profile.capabilities.text).flatMap((profile) => roleModelOptionsForProfile(profile).map((model) => ({ profileId: profile.id, model: model.id }))).filter((candidate) => {
                  const identity = roleCandidateIdentity(candidate);
                  if (selectedIdentities.has(identity) || availableIdentities.has(identity)) return false;
                  availableIdentities.add(identity);
                  return true;
                });
                return <article className="role-policy-row" key={role.id}>
                  <div className="role-policy-heading"><div><h4>{role.label}</h4><p>{role.description}</p></div><span className={`pill-status ${candidates.length ? 'gray' : 'red'}`}><span className="dot" aria-hidden="true" />{candidates.length ? `${candidates.length} 个候选` : '需要配置'}</span></div>
                  <ol className="role-policy-chain" aria-label={`${role.label}模型候选顺序`}>
                    {candidates.map((candidate, index) => {
                      const profile = settings.pi.profiles.find((item) => item.id === candidate.profileId);
                      return <li key={`${role.id}-${roleCandidateIdentity(candidate)}-${index}`} data-profile-id={candidate.profileId} data-model={candidate.model}>
                        <span className="role-policy-index" aria-hidden="true">{index + 1}</span>
                        <div className="role-policy-copy">
                          {profile ? <>
                            <div className="role-policy-provider-line"><strong>{profile.name}</strong><span className="role-policy-priority">{index === 0 ? '首选' : `备用 ${index}`}</span></div>
                            <small data-role-model={candidate.model}>模型 · {candidate.model || '未填写模型'} · {profile.api === 'openai-completions' ? 'Chat Completions' : profile.api === 'anthropic-messages' ? 'Anthropic Messages' : 'Responses'} · {formatRoleCandidateThinking(candidate, profile.thinking)}</small>
                            {!profile.configured && <span className="role-policy-warning">此预设尚未完成 API 配置</span>}
                          </> : <>
                            <div className="role-policy-provider-line"><strong className="role-policy-error">预设已不存在</strong><span className="role-policy-priority">不可用</span></div>
                            <small data-role-model={candidate.model}>{candidate.profileId} · {candidate.model || '未填写模型'} · {formatRoleCandidateThinking(candidate, undefined)}</small>
                          </>}
                        </div>
                        <div className="role-policy-actions">
                          <label className="role-policy-thinking"><span>候选思考</span><select value={candidate.thinking ?? ''} aria-label={`${role.label}第 ${index + 1} 项候选思考等级`} onChange={(event) => updateRoleCandidateThinking(role.id, index, event.target.value === '' ? undefined : event.target.value as RoleThinkingLevel)}>
                            <option value="">继承 Provider 默认（{formatThinking(profile?.thinking)}）</option>
                            {ROLE_THINKING_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                          </select></label>
                          <details className="role-policy-management">
                            <summary aria-label={`${role.label}第 ${index + 1} 项候选管理`}>管理</summary>
                            <div className="role-policy-management-menu">
                              <button type="button" className="text-button" disabled={index === 0} aria-label={`${role.label}第 ${index + 1} 项上移`} onClick={() => moveRoleCandidate(role.id, index, -1)}>上移</button>
                              <button type="button" className="text-button" disabled={index === candidates.length - 1} aria-label={`${role.label}第 ${index + 1} 项下移`} onClick={() => moveRoleCandidate(role.id, index, 1)}>下移</button>
                              <button type="button" className="text-button" disabled={candidates.length <= 1} aria-label={`从${role.label}移除第 ${index + 1} 项`} onClick={() => removeRoleCandidate(role.id, index)}>移除</button>
                            </div>
                          </details>
                        </div>
                      </li>;
                    })}
                  </ol>
                  <label className="role-policy-add"><span>添加备用模型</span><select value="" onChange={(event) => addRoleCandidate(role.id, event.target.value)} aria-label={`为${role.label}添加备用模型`}><option value="">选择 Provider + 模型</option>{availableCandidates.map((candidate) => {
                    const profile = settings.pi.profiles.find((item) => item.id === candidate.profileId);
                    return <option key={roleCandidateValue(candidate)} value={roleCandidateValue(candidate)} data-profile-id={candidate.profileId} data-model={candidate.model}>{profile?.name ?? candidate.profileId} · {candidate.model}</option>;
                  })}</select></label>
                </article>;
              })}
            </div>
            {rolePolicyErrors.length > 0 && <p className="settings-note error" role="alert"><strong>无法保存：</strong>{rolePolicyErrors.join(' ')}</p>}
            {rolePolicyNote && <p className={`settings-note${/失败|错误|无效|不存在|引用|需要|未完成/.test(rolePolicyNote) ? ' error' : ''}`} aria-live="polite">{rolePolicyNote}</p>}
            <div className="settings-form-actions role-policy-save-actions">
              <span className="settings-list-note">{rolePolicyDirty ? '有未保存的角色分配' : `当前策略版本 ${settings.pi.modelPolicyRevision}`}</span>
              <button type="button" className="primary-button" disabled={!rolePolicyDirty || rolePolicyErrors.length > 0 || rolePolicySaving} onClick={() => void saveRolePolicies()}>{rolePolicySaving ? '保存中…' : '保存智能体模型分配'}</button>
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-heading"><h3>独立配图模型</h3><p>沿用已配置 Provider 的 API，只为定稿后的配图调用；不会在正文阶段自动运行。</p></div>
            <div className="settings-form">
              <label><span>Provider 预设</span><select value={illustrationProfileId} onChange={(event) => setIllustrationProfileId(event.target.value)}><option value="">请选择支持图像生成的预设</option>{settings.pi.profiles.filter((profile) => profile.configured && profile.capabilities.imageGeneration).map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
              <label><span>图像模型</span><input value={illustrationModel} onChange={(event) => setIllustrationModel(event.target.value)} placeholder="例如：gpt-image-1" /></label>
              <p className="settings-help wide">需要服务商支持图像生成接口；API Key 仍由上方模型预设管理。</p>
              {illustrationConfigNote && <p className="pi-config-note">{illustrationConfigNote}</p>}
              <div className="settings-form-actions"><button type="button" className="primary-button" disabled={!illustrationProfileId || !illustrationModel.trim()} onClick={() => void saveIllustrationConfig()}>保存配图模型</button></div>
            </div>
          </section>

        </>}
        {section === 'skills' && <PiSkillsSettings />}
        {section === 'data' && <section className="settings-section">
          <div className="settings-row"><div><h3>数据目录</h3></div><div className="settings-row-actions"><span className="path-chip">{dataRoot || '尚未选择数据根目录'}</span><button className="secondary-button" onClick={() => void window.wmb.chooseDataRoot().then(refresh)}>选择目录</button></div></div>
          {workspaceProposals.map(({ proposal, binding, selectedRootPath }) => <div className="settings-row" key={proposal.id}><div><h3>待确认：{proposal.profile.displayName}</h3><p>受众：{proposal.profile.audience}</p><p>目标：{proposal.profile.contentGoal}</p><p>编辑简报：{proposal.profile.editorialBrief}</p><p>能力：{proposal.profile.intelligencePackId}@{proposal.profile.intelligencePackVersion} · {proposal.profile.creationPackId}@{proposal.profile.creationPackVersion} · {proposal.profile.platforms.join(' / ')}</p>{proposal.target === 'new' && <p>新工作空间目录：{selectedRootPath ?? '尚未选择'}</p>}<p>完整差异：{proposal.displayedDiff.map((item) => `${item.field}: ${JSON.stringify(item.before)} → ${JSON.stringify(item.after)}`).join('；')}</p></div><div className="settings-row-actions">{proposal.target === 'new' && <button className="secondary-button" onClick={() => { setWorkspaceNote(''); void window.wmb.selectWorkspaceProposalRoot(binding).then(() => window.wmb.listWorkspaceProposals()).then(setWorkspaceProposals).catch((error) => setWorkspaceNote(error instanceof Error ? error.message : String(error))); }}>选择数据目录</button>}<button className="primary-button" disabled={proposal.target === 'new' && !selectedRootPath} onClick={() => { setWorkspaceNote(''); void window.wmb.confirmWorkspaceProposal(binding).then(async () => { const [listed, proposals] = await Promise.all([window.wmb.listWorkspaces(), window.wmb.listWorkspaceProposals()]); setWorkspaces(listed); setWorkspaceProposals(proposals); setWorkspaceNote(proposal.target === 'new' ? '工作空间已创建，切换后重启即可使用。' : '当前工作空间配方已更新。'); }).catch((error) => setWorkspaceNote(error instanceof Error ? error.message : String(error))); }}>{proposal.target === 'new' ? '确认创建' : '确认更新当前工作空间'}</button></div></div>)}
          {workspaces.workspaces.map((workspace) => <div className="settings-row" key={workspace.id}><div><h3>{workspace.displayName}</h3><p>{workspace.rootPath}</p></div>{workspace.id === workspaces.activeWorkspaceId ? <span className="pill-status green"><span className="dot"/>当前</span> : <button className="secondary-button" onClick={() => { setWorkspaceNote(''); void window.wmb.switchWorkspace(workspace.id).catch((error) => setWorkspaceNote(error instanceof Error ? error.message : String(error))); }}>切换后重启</button>}</div>)}
          {!workspaces.workspaces.some((workspace) => workspace.displayName === '英国生活') && <div className="settings-row"><div><h3>英国生活官方工作空间</h3></div><button className="secondary-button" onClick={() => { setWorkspaceNote(''); void window.wmb.createUkWorkspace().then(() => window.wmb.listWorkspaces()).then(setWorkspaces).catch((error) => setWorkspaceNote(error instanceof Error ? error.message : String(error))); }}>创建 UK 工作空间</button></div>}
          {workspaceNote && <p className="settings-note error">{workspaceNote}</p>}
          {settings && <>
            <div className="settings-row"><div><h3>数据库</h3><p>占用 {formatBytes(settings.usage.database)}</p></div><span className="pill-status green"><span className="dot"/>健康</span></div>
            <div className="settings-row"><div><h3>素材目录</h3><p>占用 {formatBytes(settings.usage.assets)}</p></div></div>
            <div className="settings-row"><div><h3>当前登录环境</h3><p>{settings.paths.boundBrowserProfile || '尚未设置'} · {formatBytes(settings.usage.boundBrowserProfile)}</p></div></div>
            <div className="settings-row"><div><h3>旧版登录环境（只读保留）</h3><p>{settings.paths.legacyBrowserProfile} · {formatBytes(settings.usage.legacyBrowserProfile)}</p></div></div>
          </>}
          <div className="settings-row"><div><h3>日志</h3><p>占用 {settings ? formatBytes(settings.usage.logs) : '—'}</p></div><button className="secondary-button" onClick={() => void window.wmb.openLogs()}>打开日志目录</button></div>
        </section>}
        {section === 'browser' && settings && (
          <BrowserSettings
            settings={settings}
            browserChoice={browserChoice}
            setBrowserChoice={setBrowserChoice}
            refresh={refresh}
          />
        )}
        {section === 'channels' && settings && <IntelligenceChannelsView settingsMode workspaceId={settings.workspace.id} />}
        {section === 'daily-automation' && (
          <section className="settings-section settings-daily-automation" aria-label="每日自动化控制">
            <TodayDailyCycle
              businessDate={dailyAutomationBusinessDate}
              openSettings={(target) => {
                if (target === 'browser' || target === 'channels') setSection(target);
                else if (target === 'daily-automation') setSection('daily-automation');
                else setSection('browser');
              }}
            />
            <div className="settings-row settings-daily-automation-links">
              <div>
                <h3>前置依赖</h3>
                <p>浏览器登录与情报渠道决定每日编排能否正常执行。</p>
              </div>
              <div className="settings-row-actions">
                <button type="button" className="secondary-button" onClick={() => setSection('browser')}>去浏览器与账号</button>
                <button type="button" className="secondary-button" onClick={() => setSection('channels')}>去情报渠道</button>
              </div>
            </div>
          </section>
        )}
        {section === 'agent' && settings && <section className="settings-section settings-section-agent">
          <div className="settings-row settings-row-compact">
            <div>
              <h3>本地接入</h3>
              <p className="settings-mono-line">{settings.mcp.status === 'ready' ? settings.mcp.url : '—'}</p>
              <p>{settings.workspace.displayName}</p>
            </div>
            <span className={`pill-status ${settings.mcp.status === 'ready' ? 'green' : 'gray'}`}><span className="dot"/>{settings.mcp.status === 'ready' ? '运行中' : '未启动'}</span>
          </div>
          <AgentsSettingsPanel />
        </section>}
        {section === 'diagnostics' && <section className="settings-section diagnostic-list">
          <article><div><h2>本地数据</h2></div><span className={`pill-status ${settings?.health.database === 'ready' ? 'green' : 'gray'}`}><span className="dot"/>{settings?.health.database === 'ready' ? '健康' : String(settings?.health.database ?? '未连接')}</span></article>
          <article><div><h2>创作助手连接</h2></div><span className={`pill-status ${settings?.mcp.status === 'ready' ? 'green' : 'gray'}`}><span className="dot"/>{settings?.mcp.status === 'ready' ? '正常' : '未启动'}</span></article>
          <article><div><h2>专用浏览器</h2></div><span className={`pill-status ${settings?.browser.status === 'ready' ? 'green' : 'gray'}`}><span className="dot"/>{settings?.browser.status === 'ready' ? '已连接' : '未启动'}</span></article>
          <div className="settings-form-actions"><button className="secondary-button" onClick={() => void window.wmb.openLogs()}>打开日志目录</button></div>
        </section>}
        {section === 'about' && settings && <section className="settings-section">
          <AppUpdateSettings/>
          <div className="settings-row"><div><h3>Pi 运行组件</h3><p>{settings.piRuntime?.source === 'override' ? '数据目录版本' : '随应用安装'}</p>{runtimeNote && <p className="task-status">{runtimeNote}</p>}</div><div className="settings-row-actions"><strong>{settings.piRuntime?.version || '未知'}</strong><button className="secondary-button" onClick={() => void window.wmb.getPiRuntime().then(() => setRuntimeNote('版本信息已刷新。')).then(refresh)}>刷新版本</button><button className="secondary-button" disabled={!settings.piRuntime?.previousVersion} onClick={() => void window.wmb.rollbackPiRuntime().then((result) => { setRuntimeNote(result.ok ? '已回滚到上一版本' : (result.error?.message || '回滚失败')); refresh(); })}>回滚</button></div></div>
        </section>}
      </div>
    </div>
  </section>;
}
