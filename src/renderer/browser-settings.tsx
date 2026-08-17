import { useEffect, useState } from 'react';
import type { WmbSettingsSnapshot } from './wmb-settings-types';
import { SettingsIcon } from './settings-icons';

type BrowserPlatform = 'x' | 'wechat' | 'zhihu';
type TimelineCacheStats = { rows: number; bytes: number; accounts: number };

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function bindingStateMeta(state: string | undefined): { label: string; pill: 'green' | 'amber' | 'gray'; detail: string } {
  if (state === 'verified') return { label: '可用', pill: 'green', detail: '发布和采集会使用此登录环境。' };
  if (state === 'needs_user') return { label: '需要处理', pill: 'amber', detail: '当前环境不可用，请切换环境或重新验证账号。' };
  if (state === 'unverified') return { label: '账号待验证', pill: 'amber', detail: '登录环境已设置，请继续验证平台账号。' };
  return { label: '未设置', pill: 'gray', detail: '选择或新建登录环境后，即可验证平台账号。' };
}

function expectedAccountsText(snapshot: WmbSettingsSnapshot['browserBinding']): string {
  const entries = Object.entries(snapshot?.expectedAccountSnapshot ?? {});
  if (!entries.length) return '尚无已验证账号';
  return entries.map(([platform, account]) => {
    const name = platform === 'x' ? 'X' : platform === 'wechat' ? '微信公众号' : platform === 'zhihu' ? '知乎' : platform;
    const key = account?.accountKey || account?.displayName || '未知账号';
    return `${name} · ${key}`;
  }).join('；');
}

export function BrowserSettings({
  settings,
  browserChoice,
  setBrowserChoice,
  refresh,
}: {
  settings: WmbSettingsSnapshot;
  browserChoice: string;
  setBrowserChoice: (value: string) => void;
  refresh: () => void;
}): React.JSX.Element {
  const browserPlatforms = (settings.workspace.profile.platforms ?? []).filter(
    (platform): platform is BrowserPlatform => platform === 'x' || platform === 'wechat' || platform === 'zhihu',
  );
  const [browserPlatform, setBrowserPlatform] = useState<BrowserPlatform>(browserPlatforms[0] ?? 'x');
  const [browserNote, setBrowserNote] = useState('');
  const [timelineCacheNote, setTimelineCacheNote] = useState('');
  const [timelineCacheStats, setTimelineCacheStats] = useState<TimelineCacheStats | null>(null);
  const [busy, setBusy] = useState<'create' | 'rebind' | 'migrate' | 'verify' | 'cache' | null>(null);

  const ownerBase = {
    workspaceId: settings.workspace.id,
    expectedBindingRevision: settings.browserBinding?.bindingRevision ?? 0,
    expectedRegistryRevision: settings.browserRegistryRevision,
  };
  const stateMeta = bindingStateMeta(settings.browserBinding?.state);
  const bound = settings.boundBrowserProfile;
  const selectedProfile = settings.browserProfiles.find((profile) => profile.id === browserChoice) ?? null;
  const isCurrentChoice = Boolean(browserChoice && browserChoice === settings.browserBinding?.profileId);
  const platformName = browserPlatform === 'x' ? 'X' : browserPlatform === 'wechat' ? '微信公众号' : '知乎';
  const selectedAccount = settings.browserBinding?.expectedAccountSnapshot?.[browserPlatform] ?? null;
  const canBindChoice = Boolean(browserChoice && !isCurrentChoice);
  const bindDisabledReason = busy ? '正在处理其他操作' : !browserChoice ? (settings.browserProfiles.length ? '请选择登录环境' : '请先新建登录环境') : '';
  const verifyDisabledReason = busy ? '正在处理其他操作' : !bound ? '请先设置登录环境，再验证平台账号' : '';
  const createIsPrimary = !bound && !canBindChoice;
  const bindIsPrimary = !bound && canBindChoice;
  const verifyIsPrimary = Boolean(bound);

  useEffect(() => {
    void window.wmb.getXListTimelineCacheStats()
      .then(setTimelineCacheStats)
      .catch(() => setTimelineCacheStats(null));
  }, [settings.browser.status]);

  useEffect(() => {
    if (!browserPlatforms.includes(browserPlatform) && browserPlatforms[0]) {
      setBrowserPlatform(browserPlatforms[0]);
    }
  }, [browserPlatform, browserPlatforms.join('|')]);

  useEffect(() => {
    if (!browserChoice && settings.browserBinding?.profileId) {
      setBrowserChoice(settings.browserBinding.profileId);
      return;
    }
    if (browserChoice && !settings.browserProfiles.some((profile) => profile.id === browserChoice)) {
      setBrowserChoice(settings.browserBinding?.profileId || settings.defaultBrowserProfileId || settings.browserProfiles[0]?.id || '');
    }
  }, [browserChoice, settings.browserBinding?.profileId, settings.browserProfiles, settings.defaultBrowserProfileId, setBrowserChoice]);

  const run = async (
    kind: NonNullable<typeof busy>,
    action: () => Promise<unknown>,
    pending: string,
    done?: string,
  ) => {
    setBusy(kind);
    setBrowserNote(pending);
    try {
      const result = await action() as { verified?: boolean; error?: { message?: string }; relaunching?: boolean } | null;
      if (result && result.verified === false) {
        setBrowserNote(result.error?.message || '验证未完成。请先在打开的浏览器中完成登录，再重试。');
        refresh();
        return;
      }
      if (done) setBrowserNote(done);
      refresh();
    } catch (error) {
      setBrowserNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return <section className="settings-section browser-settings">
    <div className="settings-status-card">
      <div className="settings-status-main">
        <span className="settings-provider-mark"><SettingsIcon name="browser" /></span>
        <div><strong>{bound?.label || '尚未设置登录环境'}</strong><small>{bound ? '发布和采集会使用此登录环境。' : '选择或新建登录环境后，即可验证平台账号。'}</small></div>
      </div>
      <span className={`pill-status ${stateMeta.pill}`}><span className="dot" />{stateMeta.label}</span>
    </div>
    {settings.browserBinding?.error && <p className="settings-note error">{settings.browserBinding.error.message}</p>}
    {browserNote && <p className={`settings-note${/失败|错误|invalid|mismatch|stale|悬空|不一致/i.test(browserNote) ? ' error' : ''}`} aria-live="polite">{browserNote}</p>}

    <div className="browser-settings-workflow" aria-label="浏览器与账号配置流程">
      <article className="browser-settings-step">
        <header className="browser-step-heading">
          <span className="browser-step-index">1</span>
          <div><h3>登录环境</h3></div>
        </header>
        <div className="browser-step-body">
          <div className="browser-step-command">
            <label className="settings-field"><span>选择登录环境</span><select aria-label="登录环境" value={browserChoice} onChange={(event) => setBrowserChoice(event.target.value)}><option value="">{settings.browserProfiles.length ? '请选择登录环境' : '暂无可用环境'}</option>{settings.browserProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}{profile.id === settings.defaultBrowserProfileId ? '（本机默认）' : ''}{profile.id === settings.browserBinding?.profileId ? '（正在使用）' : ''}</option>)}</select></label>
            <div className="browser-step-actions">
              <button type="button" className={createIsPrimary ? 'primary-button' : 'secondary-button'} disabled={busy !== null} onClick={() => void run('create', () => window.wmb.createBrowserProfile(ownerBase), '正在新建登录环境并重启…', '登录环境已创建。')}>{busy === 'create' ? '创建中…' : '新建登录环境'}</button>
              <button type="button" className={bindIsPrimary ? 'primary-button' : 'secondary-button'} disabled={busy !== null || !canBindChoice} onClick={() => void run('rebind', () => window.wmb.rebindBrowserProfile({ ...ownerBase, profileId: browserChoice }), '正在切换登录环境并重启…', '已切换登录环境。')}>{busy === 'rebind' ? '切换中…' : bound ? '切换登录环境' : '使用所选环境'}</button>
            </div>
          </div>
          {bindDisabledReason && <p className="settings-help browser-step-feedback">{bindDisabledReason}</p>}
        </div>
      </article>

      <article className="browser-settings-step">
        <header className="browser-step-heading">
          <span className="browser-step-index">2</span>
          <div><h3>平台账号</h3></div>
        </header>
        <div className="browser-step-body">
          <div className="browser-step-command browser-account-command">
            <label className="settings-field"><span>账号平台</span><select aria-label="账号平台" value={browserPlatform} onChange={(event) => setBrowserPlatform(event.target.value as BrowserPlatform)} disabled={browserPlatforms.length === 0}>{browserPlatforms.length === 0 && <option value="x">暂无可验证平台</option>}{browserPlatforms.map((platform) => <option key={platform} value={platform}>{platform === 'x' ? 'X' : platform === 'wechat' ? '微信公众号' : '知乎'}</option>)}</select></label>
            <div className="browser-account-summary"><div><strong>{selectedAccount?.displayName || selectedAccount?.accountKey || `${platformName} 账号尚未验证`}</strong><small>{selectedAccount ? `${selectedAccount.accountKey} · ${new Date(selectedAccount.verifiedAt).toLocaleString('zh-CN')}` : `验证后，WMB 将使用此账号执行 ${platformName} 相关操作。`}</small></div><span className={`pill-status ${selectedAccount ? 'green' : 'gray'}`}>{selectedAccount ? '已验证' : '未验证'}</span></div>
            <div className="browser-step-actions">
              {settings.legacyBrowserSource.detected && <button type="button" className="secondary-button" disabled={busy !== null || !bound || browserPlatforms.length === 0} onClick={() => void run('migrate', () => window.wmb.migrateLegacyBrowserProfile({ ...ownerBase, platform: browserPlatform }), `正在停止浏览器、复制并验证 ${platformName} 账号…`, `已完成 ${platformName} 迁移与验证。`)}>{busy === 'migrate' ? '迁移中…' : '迁移旧数据'}</button>}
              <button type="button" className={verifyIsPrimary ? 'primary-button' : 'secondary-button'} disabled={busy !== null || !bound || browserPlatforms.length === 0} onClick={() => void run('verify', () => window.wmb.verifyBrowserAccount({ workspaceId: settings.workspace.id, platform: browserPlatform, expectedBindingRevision: settings.browserBinding!.bindingRevision, expectedRegistryRevision: settings.browserRegistryRevision }), `正在打开浏览器验证 ${platformName} 账号（未登录可先扫码，最多等待约 3 分钟）…`, `已完成 ${platformName} 账号验证。`)}>{busy === 'verify' ? '验证中…' : `验证 ${platformName}`}</button>
            </div>
          </div>
          {verifyDisabledReason && <p className="settings-help browser-step-feedback">{verifyDisabledReason}</p>}
        </div>
      </article>
    </div>

    <details className="settings-disclosure">
      <summary>环境详情与维护</summary>
      <div className="settings-disclosure-body">
        <div className="settings-meta-grid">
          <div><h4>正在使用</h4><p>{bound?.label || '尚未设置'}</p>{bound?.userDataDir && <p className="settings-meta-path">{bound.userDataDir}</p>}</div>
          <div><h4>准备切换</h4><p>{selectedProfile?.label || '尚未选择'}</p>{selectedProfile?.userDataDir && <p className="settings-meta-path">{selectedProfile.userDataDir}</p>}</div>
          <div><h4>已验证账号</h4><p>{expectedAccountsText(settings.browserBinding)}</p></div>
          <div><h4>旧版登录数据</h4><p>{settings.legacyBrowserSource.detected ? `检测到 ${settings.legacyBrowserSource.entryCount} 项，可按需迁移` : '未检测到旧版登录数据'}</p>{settings.legacyBrowserSource.detected && <p className="settings-meta-path">{settings.legacyBrowserSource.path}</p>}</div>
        </div>
        <div className="settings-row browser-cache-row"><div><h3>X List 浏览缓存</h3><p>{timelineCacheStats ? `${timelineCacheStats.rows} 条预览 · ${formatBytes(timelineCacheStats.bytes)} · ${timelineCacheStats.accounts} 个账号` : '正在读取缓存占用…'}</p>{timelineCacheNote && <p className="task-status">{timelineCacheNote}</p>}</div><button type="button" className="secondary-button" disabled={busy !== null} onClick={() => { setBusy('cache'); setTimelineCacheNote(''); void window.wmb.clearXListTimelineCache().then(async (result) => { setTimelineCacheStats(await window.wmb.getXListTimelineCacheStats()); setTimelineCacheNote(`已清理 ${result.deleted} 条浏览缓存。`); }).catch((error) => setTimelineCacheNote(error instanceof Error ? error.message : '清理失败')).finally(() => setBusy(null)); }}>{busy === 'cache' ? '清理中…' : '清理缓存'}</button></div>
      </div>
    </details>
  </section>;
}
