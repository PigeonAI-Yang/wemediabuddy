import { useEffect, useState } from 'react';
import type { Theme } from './app-types';

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
  type SettingsSection = 'general' | 'ai' | 'data' | 'browser' | 'agent' | 'diagnostics' | 'about';
  const [section, setSection] = useState<SettingsSection>('ai');
  const [piProfileId, setPiProfileId] = useState(settings?.pi.activeId ?? '');
  const [piName, setPiName] = useState(settings?.pi.profiles.find((profile) => profile.id === settings.pi.activeId)?.name ?? '');
  const [piApi, setPiApi] = useState<'openai-responses' | 'openai-completions' | 'anthropic-messages'>(settings?.pi.profiles.find((profile) => profile.id === settings.pi.activeId)?.api ?? 'openai-responses');
  const [piBaseUrl, setPiBaseUrl] = useState(settings?.pi.baseUrl ?? '');
  const [piModel, setPiModel] = useState(settings?.pi.model ?? '');
  const [piApiKey, setPiApiKey] = useState('');
  const [piConfigNote, setPiConfigNote] = useState('');
  const [piModels, setPiModels] = useState<string[]>([]);
  const [loadingPiModels, setLoadingPiModels] = useState(false);
  const [runtimeNote, setRuntimeNote] = useState('');
  const [timelineCacheNote, setTimelineCacheNote] = useState('');
  const [timelineCacheStats, setTimelineCacheStats] = useState<{ rows: number; bytes: number; accounts: number } | null>(null);
  const selectPiProfile = (id: string) => {
    const profile = settings?.pi.profiles.find((item) => item.id === id);
    setPiProfileId(id);
    setPiName(profile?.name ?? '');
    setPiApi(profile?.api ?? 'openai-responses');
    setPiBaseUrl(profile?.baseUrl ?? '');
    setPiModel(profile?.model ?? '');
    setPiApiKey('');
    setPiModels([]);
    setPiConfigNote('');
  };
  useEffect(() => {
    selectPiProfile(settings?.pi.activeId ?? '');
  }, [settings?.pi.activeId, settings?.pi.profiles]);
  useEffect(() => {
    if (section !== 'browser') return;
    void window.wmb.getXListTimelineCacheStats().then(setTimelineCacheStats).catch(() => setTimelineCacheStats(null));
  }, [section, settings?.browser.status]);
  const saveProfile = async () => {
    try {
      await window.wmb.savePiConfig({
        id: piProfileId || undefined,
        name: piName,
        baseUrl: piBaseUrl,
        model: piModel,
        api: piApi,
        thinking: settings?.pi.profiles.find((profile) => profile.id === piProfileId)?.thinking,
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
      if (!models.includes(piModel)) setPiModel(models[0]);
      setPiConfigNote(`已获取 ${models.length} 个模型`);
    } catch (error) {
      setPiModels([]);
      setPiConfigNote(`${error instanceof Error ? error.message : '获取模型失败'} 仍可手动填写模型。`);
    } finally {
      setLoadingPiModels(false);
    }
  };
  const sections: Array<{ id: SettingsSection; label: string; icon: string }> = [
    { id: 'general', label: '常规', icon: '⌂' },
    { id: 'ai', label: 'AI 与模型', icon: '✦' },
    { id: 'data', label: '数据与存储', icon: '▱' },
    { id: 'browser', label: '浏览器与账号', icon: '◎' },
    { id: 'agent', label: 'Agent 接入', icon: '↔' },
    { id: 'diagnostics', label: '系统诊断', icon: '⌁' }
  ];
  const headings: Record<SettingsSection, { title: string; description: string }> = {
    general: { title: '常规', description: '设置 WMB 启动后的默认工作方式。' },
    ai: { title: 'AI 与模型', description: '管理 Pi 使用的接口配置。你可以保存多个预设，并随时切换当前模型。' },
    data: { title: '数据与存储', description: '查看 WMB 数据保存位置并管理本地文件。' },
    browser: { title: '浏览器与账号', description: '管理 WMB 专用浏览器和平台登录环境。' },
    agent: { title: 'Agent 接入', description: '让其他 Agent 读取和操作 WMB 中的同一份业务资料。' },
    diagnostics: { title: '系统诊断', description: '仅在异常时检查本地数据、创作助手连接和专用浏览器。' },
    about: { title: '关于 WMB', description: '查看应用和 Pi 运行组件版本。' }
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
        <header className="settings-heading"><h2>{headings[section].title}</h2><p>{headings[section].description}</p></header>
        {section === 'general' && <section className="settings-section">
          <div className="settings-row"><div><h3>启动后打开</h3><p>每次启动后进入今日内容，先查看值得做的内容机会。</p></div><strong>今日内容</strong></div>
          <div className="settings-row"><div><h3>界面语言</h3><p>应用菜单和提示使用的语言。</p></div><strong>简体中文</strong></div>
        </section>}
        {section === 'ai' && settings && <>
          <section className="settings-section">
            <div className="settings-section-heading"><h3>配置预设</h3><p>当前预设会用于新的 Pi 对话和内容任务。</p></div>
            <div className="settings-profile-list">
              {settings.pi.profiles.map((profile) => <button type="button" key={profile.id} className={`settings-profile${profile.id === piProfileId ? ' selected' : ''}`} onClick={() => selectPiProfile(profile.id)}>
                <span className="settings-provider-mark">{profile.name.slice(0, 1).toUpperCase()}</span>
                <span><strong>{profile.name}</strong><small>{profile.model} · {profile.api === 'openai-completions' ? 'OpenAI Chat Completions' : profile.api === 'anthropic-messages' ? 'Anthropic Messages' : 'OpenAI Responses'}</small></span>
                {profile.active && <em>● 正在使用</em>}
              </button>)}
            </div>
            <div className="settings-inline-actions">
              <button type="button" className="text-button" onClick={() => selectPiProfile('')}>＋ 添加配置预设</button>
              <button type="button" className="text-button" onClick={() => {
                setPiProfileId(''); setPiName('OpenCode Go'); setPiBaseUrl('https://opencode.ai/zen/go/v1');
                setPiApi('openai-completions'); setPiModel(''); setPiApiKey(''); setPiModels([]);
                setPiConfigNote('填写 OpenCode Go API Key 后获取模型');
              }}>＋ OpenCode Go</button>
            </div>
          </section>
          <section className="settings-section">
            <div className="settings-section-heading"><h3>{piName || '新配置'}</h3><p>修改只影响这个预设，API 密钥保存在本机。</p></div>
            <div className="settings-form">
            <label><span>配置名称</span><input value={piName} onChange={(event) => setPiName(event.target.value)} placeholder="例如：本地 CPA" /></label>
            <label><span>接口类型</span><select value={piApi} onChange={(event) => { setPiApi(event.target.value as 'openai-responses' | 'openai-completions' | 'anthropic-messages'); setPiModels([]); }}>
              <option value="openai-responses">OpenAI Responses</option>
              <option value="openai-completions">OpenAI Chat Completions</option>
              <option value="anthropic-messages">Anthropic Messages</option>
            </select></label>
            <label className="wide">
              <span>模型</span>
              <div className="model-picker">
                {piModels.length
                  ? <select value={piModel} onChange={(event) => setPiModel(event.target.value)}>{piModels.map((model) => <option key={model} value={model}>{model}</option>)}</select>
                  : <input value={piModel} onChange={(event) => setPiModel(event.target.value)} placeholder="获取后选择，或手动填写" />}
                <button type="button" className="secondary-button" disabled={loadingPiModels || !piBaseUrl.trim()} onClick={() => void fetchModels()}>{loadingPiModels ? '获取中…' : '获取模型'}</button>
              </div>
            </label>
            <label className="wide"><span>Base URL</span><input value={piBaseUrl} onChange={(event) => setPiBaseUrl(event.target.value)} placeholder="http://localhost:61946/v1" /></label>
            <label className="wide"><span>API Key</span><input value={piApiKey} onChange={(event) => setPiApiKey(event.target.value)} placeholder={piProfileId ? '留空保持原密钥' : '填写 API Key'} type="password" /></label>
            {piConfigNote && <p className="pi-config-note">{piConfigNote}</p>}
            <div className="settings-form-actions">
              {piProfileId && !settings.pi.profiles.find((profile) => profile.id === piProfileId)?.active && <button className="secondary-button" onClick={() => void window.wmb.activatePiConfig(piProfileId).then(refresh)}>设为当前</button>}
              {piProfileId && <button className="danger-button" onClick={() => {
                if (!window.confirm('删除这个 API 配置？')) return;
                void window.wmb.deletePiConfig(piProfileId).then(() => { setPiProfileId(''); refresh(); });
              }}>删除</button>}
              <button className="primary-button" onClick={() => void saveProfile()}>{piProfileId ? '保存修改' : '保存并使用'}</button>
            </div>
          </div>
          </section>
        </>}
        {section === 'data' && <section className="settings-section">
          <div className="settings-row"><div><h3>数据目录</h3><p>所有业务数据集中保存在此，可整体移动。</p></div><div className="settings-row-actions"><span className="path-chip">{dataRoot || '尚未选择数据根目录'}</span><button className="secondary-button" onClick={() => void window.wmb.chooseDataRoot().then(refresh)}>选择目录</button></div></div>
          {settings && <>
            <div className="settings-row"><div><h3>数据库</h3><p>wmb.db · {formatBytes(settings.usage.database)} · 迁移 v{settings.counts.migrations}</p></div><span className="pill-status green"><span className="dot"/>健康</span></div>
            <div className="settings-row"><div><h3>素材目录</h3><p>assets/ · {formatBytes(settings.usage.assets)} · SHA-256 去重</p></div></div>
            <div className="settings-row"><div><h3>浏览器用户目录</h3><p>browser-profile/ · {formatBytes(settings.usage.browserProfile)} · 独立持久</p></div></div>
          </>}
          <div className="settings-row"><div><h3>日志</h3><p>logs/ · {settings ? formatBytes(settings.usage.logs) : '查看应用运行记录和错误信息。'}</p></div><button className="secondary-button" onClick={() => void window.wmb.openLogs()}>打开日志目录</button></div>
        </section>}
        {section === 'browser' && settings && <section className="settings-section">
          <div className="settings-section-heading">
            <h3>专用浏览器</h3>
            <p>
              {settings.browser.status === 'ready'
                ? `已连接（${settings.browser.mode === 'visible' ? '前台接管' : settings.browser.mode === 'headless' ? '实验无头' : '后台静默'}）${settings.browser.profilePath ? ` · ${settings.browser.profilePath}` : ''}`
                : '浏览器尚未由本应用启动。X List 默认后台静默运行，不抢前台。'}
            </p>
          </div>
          <p className="settings-help">X 默认在后台 worker 运行（隐藏窗口 + 拟人间隔），日常操作不应再弹出浏览器。验证码/登录才用前台接管。</p>
          <div className="settings-browser-controls">
            <select value={browserChoice} onChange={(event) => setBrowserChoice(event.target.value)}>{settings.browserOptions.map((option) => <option key={option.id} value={option.id}>{option.label} · {option.profileDirectory}</option>)}</select>
            <button className="secondary-button" disabled={!browserChoice} onClick={() => void window.wmb.configureBrowser(browserChoice).then(refresh)}>保存选择</button>
            <button className="secondary-button" onClick={() => void window.wmb.startBrowser({ mode: 'quiet' }).then(refresh)}>后台静默启动</button>
            <button className="primary-button" onClick={() => void window.wmb.startBrowser({ mode: 'visible' }).then(refresh)}>前台接管</button>
          </div>
          <div className="settings-row">
            <div>
              <h3>X List 浏览缓存</h3>
              <p>
                {timelineCacheStats
                  ? `${timelineCacheStats.rows} 条预览 · ${formatBytes(timelineCacheStats.bytes)} · ${timelineCacheStats.accounts} 个账号`
                  : '用于秒开已看过的 List 动态，可随时清空，不影响已采集资料。'}
              </p>
              {timelineCacheNote && <p className="task-status">{timelineCacheNote}</p>}
            </div>
            <button className="secondary-button" onClick={() => void (async () => {
              try {
                const result = await window.wmb.clearXListTimelineCache();
                const stats = await window.wmb.getXListTimelineCacheStats();
                setTimelineCacheStats(stats);
                setTimelineCacheNote(`已清理 ${result.deleted} 条浏览缓存。`);
              } catch (error) {
                setTimelineCacheNote(error instanceof Error ? error.message : '清理失败');
              }
            })()}>清理浏览缓存</button>
          </div>
        </section>}
        {section === 'agent' && settings && <section className="settings-section">
          <div className="settings-row"><div><h3>本地接入地址</h3><p>{settings.mcp.status === 'ready' ? settings.mcp.url : '本地接入服务未启动'}</p></div><span className={`pill-status ${settings.mcp.status === 'ready' ? 'green' : 'gray'}`}><span className="dot"/>{settings.mcp.status === 'ready' ? '运行中' : '未启动'}</span></div>
        </section>}
        {section === 'diagnostics' && <section className="settings-section diagnostic-list">
          <article><div><h2>本地数据</h2><p>资料、内容和运行记录的存储状态</p></div><span className={`pill-status ${settings?.health.database === 'ready' ? 'green' : 'gray'}`}><span className="dot"/>{settings?.health.database === 'ready' ? '健康' : String(settings?.health.database ?? '未连接')}</span></article>
          <article><div><h2>创作助手连接</h2><p>外部创作助手能否读取当前终端</p></div><span className={`pill-status ${settings?.mcp.status === 'ready' ? 'green' : 'gray'}`}><span className="dot"/>{settings?.mcp.status === 'ready' ? '正常' : '未启动'}</span></article>
          <article><div><h2>专用浏览器</h2><p>用于登录平台、发布和读取结果</p></div><span className={`pill-status ${settings?.browser.status === 'ready' ? 'green' : 'gray'}`}><span className="dot"/>{settings?.browser.status === 'ready' ? '已连接' : '未启动'}</span></article>
          <div className="settings-form-actions"><button className="secondary-button" onClick={() => void window.wmb.openLogs()}>打开日志目录</button></div>
        </section>}
        {section === 'about' && settings && <section className="settings-section">
          <div className="settings-row"><div><h3>WeMediaBuddy</h3><p>AI 自媒体运营终端</p></div><strong>0.1.0</strong></div>
          <div className="settings-row"><div><h3>Pi 运行组件</h3><p>{settings.piRuntime?.source === 'override' ? '数据目录版本' : '随应用安装'} · {settings.piRuntime?.root}</p>{runtimeNote && <p className="task-status">{runtimeNote}</p>}</div><div className="settings-row-actions"><strong>{settings.piRuntime?.version || 'unknown'}</strong><button className="secondary-button" onClick={() => void window.wmb.getPiRuntime().then((info) => setRuntimeNote(`当前 ${info.version}（${info.source}）`)).then(refresh)}>刷新版本</button><button className="secondary-button" disabled={!settings.piRuntime?.previousVersion} onClick={() => void window.wmb.rollbackPiRuntime().then((result) => { setRuntimeNote(result.ok ? '已回滚到上一版本' : (result.error?.message || '回滚失败')); refresh(); })}>回滚</button></div></div>
        </section>}
      </div>
    </div>
  </section>;
}
