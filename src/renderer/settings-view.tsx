import { useEffect, useState } from 'react';
import type { Theme } from './app-types';
import { BrowserSettings } from './browser-settings';
import { IntelligenceChannelsView } from './intelligence-channels-view';
import { PiSkillsSettings } from './pi-skills-settings';
import { XListDisplaySettings } from './x-list-display-settings';
import { AgentsSettingsPanel } from './agents-settings-panel';
import { appConfirm } from './app-confirm';
import { AppUpdateSettings } from './app-update-settings';

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
  type SettingsSection = 'general' | 'ai' | 'skills' | 'data' | 'browser' | 'channels' | 'lists' | 'agent' | 'diagnostics' | 'about';
  const [section, setSection] = useState<SettingsSection>(() => {
    const requested = sessionStorage.getItem('wmb.settingsSection');
    sessionStorage.removeItem('wmb.settingsSection');
    const allowed: SettingsSection[] = ['general', 'ai', 'skills', 'data', 'browser', 'channels', 'lists', 'agent', 'diagnostics', 'about'];
    return allowed.includes(requested as SettingsSection) ? requested as SettingsSection : 'ai';
  });
  const [piProfileId, setPiProfileId] = useState(settings?.pi.activeId ?? '');
  const [piName, setPiName] = useState(settings?.pi.profiles.find((profile) => profile.id === settings.pi.activeId)?.name ?? '');
  const [piApi, setPiApi] = useState<'openai-responses' | 'openai-completions'>(settings?.pi.profiles.find((profile) => profile.id === settings.pi.activeId)?.api ?? 'openai-responses');
  const [piBaseUrl, setPiBaseUrl] = useState(settings?.pi.baseUrl ?? '');
  const [piModel, setPiModel] = useState(settings?.pi.model ?? '');
  const [piApiKey, setPiApiKey] = useState('');
  const [piConfigNote, setPiConfigNote] = useState('');
  const [piModels, setPiModels] = useState<Array<{ id: string; contextWindow?: number; maxTokens?: number }>>([]);
  const [piContextWindow, setPiContextWindow] = useState('');
  const [piMaxTokens, setPiMaxTokens] = useState('');
  const [piNativeSearch, setPiNativeSearch] = useState(false);
  const [loadingPiModels, setLoadingPiModels] = useState(false);
  const [runtimeNote, setRuntimeNote] = useState('');
  const [workspaceNote, setWorkspaceNote] = useState('');
  const [workspaces, setWorkspaces] = useState<{ activeWorkspaceId: string | null; workspaces: Array<{ id: string; displayName: string; rootPath: string }> }>({ activeWorkspaceId: null, workspaces: [] });
  const [workspaceProposals, setWorkspaceProposals] = useState<Awaited<ReturnType<typeof window.wmb.listWorkspaceProposals>>>([]);
  const selectPiProfile = (id: string, { keepNote = false } = {}) => {
    const profile = settings?.pi.profiles.find((item) => item.id === id);
    setPiProfileId(id);
    setPiName(profile?.name ?? '');
    setPiApi(profile?.api ?? 'openai-responses');
    setPiBaseUrl(profile?.baseUrl ?? '');
    setPiModel(profile?.model ?? '');
    setPiContextWindow(profile?.contextWindow ? String(profile.contextWindow) : '');
    setPiMaxTokens(profile?.maxTokens ? String(profile.maxTokens) : '');
    setPiNativeSearch(profile?.nativeSearch === true);
    setPiApiKey('');
    setPiModels([]);
    if (!keepNote) setPiConfigNote('');
  };
  useEffect(() => {
    // 保存/激活后的 settings 刷新也会走这里：保留刚写入的配置反馈（如「已保存并切换到此配置」），
    // 只在用户手动切换预设时由 selectPiProfile 清空提示。
    selectPiProfile(settings?.pi.activeId ?? '', { keepNote: true });
  }, [settings?.pi.activeId, settings?.pi.profiles]);
  useEffect(() => { if (section === 'data') void Promise.all([window.wmb.listWorkspaces(), window.wmb.listWorkspaceProposals()]).then(([listed, proposals]) => { setWorkspaces(listed); setWorkspaceProposals(proposals); }); }, [section, dataRoot]);
  const saveProfile = async () => {
    try {
      await window.wmb.savePiConfig({
        id: piProfileId || undefined,
        name: piName,
        baseUrl: piBaseUrl,
        model: piModel,
        api: piApi,
        thinking: settings?.pi.profiles.find((profile) => profile.id === piProfileId)?.thinking,
        nativeSearch: piNativeSearch,
        contextWindow: piContextWindow ? Number(piContextWindow) : null,
        maxTokens: piMaxTokens ? Number(piMaxTokens) : null,
        apiKey: piApiKey || undefined
      });
      setPiApiKey('');
      setPiConfigNote('已保存并切换到此配置');
      refresh();
    } catch (error) {
      setPiConfigNote(error instanceof Error ? error.message : '保存失败');
    }
  };
  const fetchModels = async () => {
    setLoadingPiModels(true);
    setPiConfigNote('');
    try {
      const models = await window.wmb.listPiModels({
        id: piProfileId || undefined,
        baseUrl: piBaseUrl,
        api: piApi,
        apiKey: piApiKey || undefined
      });
      setPiModels(models);
      const selected = models.find((item) => item.id === piModel) ?? models[0];
      setPiModel(selected.id);
      setPiContextWindow(selected.contextWindow ? String(selected.contextWindow) : '');
      setPiMaxTokens(selected.maxTokens ? String(selected.maxTokens) : '');
      setPiConfigNote(`已获取 ${models.length} 个模型`);
    } catch (error) {
      setPiModels([]);
      setPiConfigNote(`${error instanceof Error ? error.message : '获取模型失败'} 仍可手动填写模型。`);
    } finally {
      setLoadingPiModels(false);
    }
  };

  const fallbackProfiles = (settings?.pi.fallbackOrder ?? [])
    .map((id) => settings?.pi.profiles.find((profile) => profile.id === id))
    .filter((profile): profile is NonNullable<typeof profile> => Boolean(profile));
  const unusedFallbackProfiles = (settings?.pi.profiles ?? []).filter((profile) => !profile.active && !(settings?.pi.fallbackOrder ?? []).includes(profile.id));
  const moveFallback = async (id: string, direction: -1 | 1) => {
    if (!settings) return;
    const order = [...(settings.pi.fallbackOrder ?? [])];
    const index = order.indexOf(id);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= order.length) return;
    [order[index], order[next]] = [order[next], order[index]];
    try {
      await window.wmb.setPiFallbackOrder(order);
      refresh();
    } catch (error) {
      setPiConfigNote(error instanceof Error ? error.message : '保存降级顺序失败');
    }
  };
  const addFallback = async (id: string) => {
    if (!settings) return;
    try {
      await window.wmb.setPiFallbackOrder([...(settings.pi.fallbackOrder ?? []), id]);
      refresh();
    } catch (error) {
      setPiConfigNote(error instanceof Error ? error.message : '保存降级顺序失败');
    }
  };
  const removeFallback = async (id: string) => {
    if (!settings) return;
    try {
      await window.wmb.setPiFallbackOrder((settings.pi.fallbackOrder ?? []).filter((item) => item !== id));
      refresh();
    } catch (error) {
      setPiConfigNote(error instanceof Error ? error.message : '保存降级顺序失败');
    }
  };

  const sections: Array<{ id: SettingsSection; label: string; icon: string }> = [
    { id: 'general', label: '常规', icon: '⌂' },
    { id: 'ai', label: 'AI 与模型', icon: '✦' },
    { id: 'skills', label: 'Pi Skills', icon: '◇' },
    { id: 'data', label: '数据与存储', icon: '▱' },
    { id: 'browser', label: '浏览器与账号', icon: '◎' },
    { id: 'channels', label: '情报渠道', icon: '⌁' },
    { id: 'lists', label: 'X Lists', icon: '≡' },
    { id: 'agent', label: '智能体接入', icon: '↔' },
    { id: 'diagnostics', label: '系统诊断', icon: '⌁' }
  ];
  const headings: Record<SettingsSection, { title: string; description: string }> = {
    general: { title: '常规', description: '' },
    ai: { title: 'AI 与模型', description: '' },
    skills: { title: 'Pi Skills', description: '' },
    data: { title: '数据与存储', description: '' },
    browser: { title: '浏览器与账号', description: '' },
    channels: { title: '情报渠道', description: '' },
    lists: { title: 'X Lists', description: '' },
    agent: { title: '智能体与角色', description: '' },
    diagnostics: { title: '系统诊断', description: '' },
    about: { title: '关于 WMB', description: '' }
  };
  return <section className="settings-workspace">
    <aside className="settings-nav">
      <button type="button" className="settings-back" onClick={back}><b>‹</b><span>返回工作台</span></button>
      <h1>设置</h1>
      <nav>{sections.map((item) => <button type="button" key={item.id} className={section === item.id ? 'active' : ''} onClick={() => setSection(item.id)} title={item.label}><b>{item.icon}</b><span>{item.label}</span></button>)}</nav>
      <nav className="settings-nav-foot"><button type="button" className={section === 'about' ? 'active' : ''} onClick={() => setSection('about')}><b>ⓘ</b><span>关于 WMB</span></button></nav>
    </aside>
    <div className="settings-content">
      <div className="settings-content-inner">
        <header className="settings-heading"><h2>{headings[section].title}</h2></header>
        {section === 'general' && <section className="settings-section">
          <div className="settings-row"><div><h3>启动后打开</h3></div><strong>今日内容</strong></div>
          <div className="settings-row"><div><h3>界面语言</h3></div><strong>简体中文</strong></div>
        </section>}
        {!settings && <section className="settings-section"><p>正在加载设置…若长时间空白，请返回工作台再进设置，或重启应用。</p></section>}
        {section === 'ai' && settings && <>
          <section className="settings-section">
            <div className="settings-section-heading"><h3>配置预设</h3></div>
            <div className="settings-profile-list">
              {settings.pi.profiles.map((profile) => <button type="button" key={profile.id} className={`settings-profile${profile.id === piProfileId ? ' selected' : ''}`} onClick={() => selectPiProfile(profile.id)}>
                <span className="settings-provider-mark">{profile.name.slice(0, 1).toUpperCase()}</span>
                <span><strong>{profile.name}</strong><small>{profile.model} · {profile.api === 'openai-completions' ? 'OpenAI Chat Completions' : 'OpenAI Responses'}{profile.nativeSearch ? ' · 自带搜索' : ''}</small></span>
                {profile.active && <em>● 正在使用</em>}
              </button>)}
            </div>
            <div className="settings-inline-actions">
              <button type="button" className="text-button" onClick={() => selectPiProfile('')}>＋ 添加配置预设</button>
              <button type="button" className="text-button" onClick={() => {
                setPiProfileId(''); setPiName('OpenCode Go'); setPiBaseUrl('https://opencode.ai/zen/go/v1');
                setPiApi('openai-completions'); setPiModel(''); setPiApiKey(''); setPiModels([]); setPiContextWindow(''); setPiMaxTokens(''); setPiNativeSearch(false);
                setPiConfigNote('填写 OpenCode Go API Key 后获取模型');
              }}>＋ OpenCode Go</button>
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-heading"><h3>故障降级顺序</h3><p>当前预设失败时按序切换。</p></div>
            <div className="settings-fallback-active"><span>1</span><div><strong>{settings.pi.profiles.find((profile) => profile.active)?.name || '未选择当前预设'}</strong><small>当前正在使用 · 始终最先尝试</small></div></div>
            <div className="settings-profile-list settings-fallback-list">
              {fallbackProfiles.length === 0 && <div className="settings-fallback-empty">尚未添加降级服务。可从下方未列入的预设中加入。</div>}
              {fallbackProfiles.map((profile, index) => <div key={profile.id} className="settings-fallback-row">
                <span className="settings-fallback-index">{index + 2}</span>
                <span><strong>{profile.name}</strong><small>{profile.model}</small></span>
                <div className="settings-fallback-actions">
                  <button type="button" className="text-button" disabled={index === 0} onClick={() => void moveFallback(profile.id, -1)}>上移</button>
                  <button type="button" className="text-button" disabled={index === fallbackProfiles.length - 1} onClick={() => void moveFallback(profile.id, 1)}>下移</button>
                  <button type="button" className="text-button" onClick={() => void removeFallback(profile.id)}>移除</button>
                </div>
              </div>)}
            </div>
            {unusedFallbackProfiles.length > 0 && <div className="settings-inline-actions settings-fallback-add">
              {unusedFallbackProfiles.map((profile) => <button type="button" key={profile.id} className="text-button" onClick={() => void addFallback(profile.id)}>＋ {profile.name}</button>)}
            </div>}
          </section>
          <section className="settings-section">
            <div className="settings-section-heading"><h3>{piName || '新配置'}</h3></div>
            <div className="settings-form">
            <label><span>配置名称</span><input value={piName} onChange={(event) => setPiName(event.target.value)} placeholder="例如：本地 CPA" /></label>
            <label><span>接口类型</span><select value={piApi} onChange={(event) => { setPiApi(event.target.value as 'openai-responses' | 'openai-completions'); setPiModels([]); }}>
              <option value="openai-responses">OpenAI Responses</option>
              <option value="openai-completions">OpenAI Chat Completions</option>
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
            <label><span>上下文长度（tokens）</span><input type="number" min="1" step="1" value={piContextWindow} onChange={(event) => setPiContextWindow(event.target.value)} placeholder="由模型元数据决定" /></label>
            <label><span>最大输出（tokens）</span><input type="number" min="1" step="1" value={piMaxTokens} onChange={(event) => setPiMaxTokens(event.target.value)} placeholder="由模型元数据决定" /></label>
            <label className="settings-switch"><span>模型自带联网搜索</span><input type="checkbox" checked={piNativeSearch} onChange={(event) => setPiNativeSearch(event.target.checked)} aria-label="模型自带联网搜索" /></label>
            <p className="settings-help wide">不同模型分别保存；接口未提供元数据时可以手动填写，留空则使用 Pi 的运行时默认值。</p>
            <label className="wide"><span>Base URL</span><input value={piBaseUrl} onChange={(event) => setPiBaseUrl(event.target.value)} placeholder="http://localhost:61946/v1" /></label>
            <label className="wide"><span>API Key</span><input value={piApiKey} onChange={(event) => setPiApiKey(event.target.value)} placeholder={piProfileId ? '留空保持原密钥' : '填写 API Key'} type="password" /></label>
            {piConfigNote && <p className="pi-config-note">{piConfigNote}</p>}
            <div className="settings-form-actions">
              {piProfileId && !settings.pi.profiles.find((profile) => profile.id === piProfileId)?.active && <button className="secondary-button" onClick={() => void window.wmb.activatePiConfig(piProfileId).then(refresh)}>设为当前</button>}
              {piProfileId && <button className="danger-button" onClick={() => {
                void (async () => {
                  if (!await appConfirm({ title: '删除配置', message: '删除这个 API 配置？', confirmLabel: '删除', danger: true })) return;
                  await window.wmb.deletePiConfig(piProfileId).then(() => { setPiProfileId(''); refresh(); });
                })();
              }}>删除</button>}
              <button className="primary-button" onClick={() => void saveProfile()}>{piProfileId ? '保存修改' : '保存并使用'}</button>
            </div>
          </div>
          </section>
        </>}
        {section === 'skills' && <PiSkillsSettings />}
        {section === 'data' && <section className="settings-section">
          <div className="settings-row"><div><h3>数据目录</h3></div><div className="settings-row-actions"><span className="path-chip">{dataRoot || '尚未选择数据根目录'}</span><button className="secondary-button" onClick={() => void window.wmb.chooseDataRoot().then(refresh)}>选择目录</button></div></div>
          {workspaceProposals.map(({ proposal, binding, selectedRootPath }) => <div className="settings-row" key={proposal.id}><div><h3>待确认：{proposal.profile.displayName}</h3><p>受众：{proposal.profile.audience}</p><p>目标：{proposal.profile.contentGoal}</p><p>编辑简报：{proposal.profile.editorialBrief}</p><p>能力：{proposal.profile.intelligencePackId}@{proposal.profile.intelligencePackVersion} · {proposal.profile.creationPackId}@{proposal.profile.creationPackVersion} · {proposal.profile.platforms.join(' / ')}</p>{proposal.target === 'new' && <p>新工作空间目录：{selectedRootPath ?? '尚未选择'}</p>}<p>完整差异：{proposal.displayedDiff.map((item) => `${item.field}: ${JSON.stringify(item.before)} → ${JSON.stringify(item.after)}`).join('；')}</p></div><div className="settings-row-actions">{proposal.target === 'new' && <button className="secondary-button" onClick={() => { setWorkspaceNote(''); void window.wmb.selectWorkspaceProposalRoot(binding).then(() => window.wmb.listWorkspaceProposals()).then(setWorkspaceProposals).catch((error) => setWorkspaceNote(error instanceof Error ? error.message : String(error))); }}>选择数据目录</button>}<button className="primary-button" disabled={proposal.target === 'new' && !selectedRootPath} onClick={() => { setWorkspaceNote(''); void window.wmb.confirmWorkspaceProposal(binding).then(async () => { const [listed, proposals] = await Promise.all([window.wmb.listWorkspaces(), window.wmb.listWorkspaceProposals()]); setWorkspaces(listed); setWorkspaceProposals(proposals); setWorkspaceNote(proposal.target === 'new' ? '工作空间已创建，切换后重启即可使用。' : '当前工作空间配方已更新。'); }).catch((error) => setWorkspaceNote(error instanceof Error ? error.message : String(error))); }}>{proposal.target === 'new' ? '确认创建' : '确认更新当前工作空间'}</button></div></div>)}
          {workspaces.workspaces.map((workspace) => <div className="settings-row" key={workspace.id}><div><h3>{workspace.displayName}</h3><p>{workspace.id} · {workspace.rootPath}</p></div>{workspace.id === workspaces.activeWorkspaceId ? <span className="pill-status green"><span className="dot"/>当前</span> : <button className="secondary-button" onClick={() => { setWorkspaceNote(''); void window.wmb.switchWorkspace(workspace.id).catch((error) => setWorkspaceNote(error instanceof Error ? error.message : String(error))); }}>切换后重启</button>}</div>)}
          {!workspaces.workspaces.some((workspace) => workspace.displayName === '英国生活') && <div className="settings-row"><div><h3>英国生活官方工作空间</h3></div><button className="secondary-button" onClick={() => { setWorkspaceNote(''); void window.wmb.createUkWorkspace().then(() => window.wmb.listWorkspaces()).then(setWorkspaces).catch((error) => setWorkspaceNote(error instanceof Error ? error.message : String(error))); }}>创建 UK 工作空间</button></div>}
          {workspaceNote && <p className="settings-note error">{workspaceNote}</p>}
          {settings && <>
            <div className="settings-row"><div><h3>数据库</h3><p>wmb.db · {formatBytes(settings.usage.database)} · 数据库版本 v{settings.counts.migrations}</p></div><span className="pill-status green"><span className="dot"/>健康</span></div>
            <div className="settings-row"><div><h3>素材目录</h3><p>assets/ · {formatBytes(settings.usage.assets)} · 内容指纹去重</p></div></div>
            <div className="settings-row"><div><h3>当前绑定浏览器档案</h3><p>{settings.paths.boundBrowserProfile || '尚未绑定'} · {formatBytes(settings.usage.boundBrowserProfile)}</p></div></div>
            <div className="settings-row"><div><h3>旧版浏览器档案（只读保留）</h3><p>{settings.paths.legacyBrowserProfile} · {formatBytes(settings.usage.legacyBrowserProfile)}</p></div></div>
          </>}
          <div className="settings-row"><div><h3>日志</h3><p>logs/ · {settings ? formatBytes(settings.usage.logs) : '—'}</p></div><button className="secondary-button" onClick={() => void window.wmb.openLogs()}>打开日志目录</button></div>
        </section>}
        {section === 'browser' && settings && (
          <BrowserSettings
            settings={settings}
            browserChoice={browserChoice}
            setBrowserChoice={setBrowserChoice}
            refresh={refresh}
          />
        )}
        {section === 'channels' && settings && <IntelligenceChannelsView settingsMode />}
        {section === 'lists' && settings && <XListDisplaySettings workspaceId={settings.workspace.id} />}
        {section === 'agent' && settings && <section className="settings-section settings-section-agent">
          <div className="settings-row settings-row-compact">
            <div>
              <h3>本地接入</h3>
              <p className="settings-mono-line">{settings.mcp.status === 'ready' ? settings.mcp.url : '本地接入服务未启动'}</p>
              <p>{settings.workspace.displayName} · 配方 {settings.workspace.profile.profileId}</p>
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
          <div className="settings-row"><div><h3>Pi 运行组件</h3><p>{settings.piRuntime?.source === 'override' ? '数据目录版本' : '随应用安装'} · {settings.piRuntime?.root}</p>{runtimeNote && <p className="task-status">{runtimeNote}</p>}</div><div className="settings-row-actions"><strong>{settings.piRuntime?.version || 'unknown'}</strong><button className="secondary-button" onClick={() => void window.wmb.getPiRuntime().then((info) => setRuntimeNote(`当前 ${info.version}（${info.source}）`)).then(refresh)}>刷新版本</button><button className="secondary-button" disabled={!settings.piRuntime?.previousVersion} onClick={() => void window.wmb.rollbackPiRuntime().then((result) => { setRuntimeNote(result.ok ? '已回滚到上一版本' : (result.error?.message || '回滚失败')); refresh(); })}>回滚</button></div></div>
        </section>}
      </div>
    </div>
  </section>;
}
