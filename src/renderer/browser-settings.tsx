import { useEffect, useState } from 'react';
import type { WmbSettingsSnapshot } from './wmb-settings-types';

type BrowserPlatform = 'x' | 'wechat';
type TimelineCacheStats = { rows: number; bytes: number; accounts: number };

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function bindingStateMeta(state: string | undefined): { label: string; pill: 'green' | 'amber' | 'gray'; detail: string } {
  if (state === 'verified') return { label: '已验证', pill: 'green', detail: '当前工作空间可使用此登录环境发布和读取。' };
  if (state === 'needs_user') return { label: '需要处理', pill: 'amber', detail: '绑定异常，请改绑、迁移或重新验证账号。' };
  if (state === 'unverified') return { label: '未验证', pill: 'amber', detail: '已绑定登录环境，但还没有完成平台账号验证。' };
  return { label: '未绑定', pill: 'gray', detail: '当前工作空间还没有可用的浏览器登录环境。' };
}

function expectedAccountsText(snapshot: WmbSettingsSnapshot['browserBinding']): string {
  const entries = Object.entries(snapshot?.expectedAccountSnapshot ?? {});
  if (!entries.length) return '尚未记录已验证账号';
  return entries.map(([platform, account]) => {
    const name = platform === 'x' ? 'X' : platform === 'wechat' ? '微信公众号' : platform;
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
    (platform): platform is BrowserPlatform => platform === 'x' || platform === 'wechat',
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
  const platformName = browserPlatform === 'x' ? 'X' : '微信公众号';

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

  return <>
    <section className="settings-section">
      <div className="settings-section-heading">
        <h3>当前登录环境</h3>
      </div>
      <div className="settings-status-card">
        <div className="settings-status-main">
          <span className="settings-provider-mark">◎</span>
          <div>
            <strong>{bound?.label || '尚未绑定登录环境'}</strong>
            <small>{bound?.userDataDir || '创建独立环境，或从已有环境改绑后开始使用。'}</small>
          </div>
        </div>
        <span className={`pill-status ${stateMeta.pill}`}><span className="dot" />{stateMeta.label}</span>
      </div>
      <div className="settings-meta-grid">
        <div>
          <h4>绑定说明</h4>
          <p>
            {settings.browserBinding?.error
              ? `${settings.browserBinding.error.code}: ${settings.browserBinding.error.message}`
              : stateMeta.detail}
          </p>
        </div>
        <div>
          <h4>已验证账号</h4>
          <p>{expectedAccountsText(settings.browserBinding)}</p>
        </div>
        <div>
          <h4>本机默认环境</h4>
          <p>{settings.defaultBrowserProfileId || '尚未设置'} · 新建工作空间会继承</p>
        </div>
        <div>
          <h4>旧版登录数据</h4>
          <p>
            {settings.legacyBrowserSource.detected
              ? `可迁移 · 检测到 ${settings.legacyBrowserSource.entryCount} 项`
              : '未检测到可迁移内容'}
          </p>
          <p className="settings-meta-path">{settings.legacyBrowserSource.path}</p>
        </div>
      </div>
    </section>

    <section className="settings-section">
      <div className="settings-section-heading">
        <h3>切换或创建登录环境</h3>
      </div>
      <div className="settings-form">
        <label className="wide">
          <span>登录环境</span>
          <select
            aria-label="登录环境"
            value={browserChoice}
            onChange={(event) => setBrowserChoice(event.target.value)}
          >
            {settings.browserProfiles.length === 0 && <option value="">暂无可用环境</option>}
            {settings.browserProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.label}
                {profile.id === settings.defaultBrowserProfileId ? '（本机默认）' : ''}
                {profile.id === settings.browserBinding?.profileId ? '（当前绑定）' : ''}
              </option>
            ))}
          </select>
        </label>
        {selectedProfile && (
          <p className="settings-help wide">
            数据目录：{selectedProfile.userDataDir}
            {isCurrentChoice ? ' · 已是当前绑定' : ''}
          </p>
        )}
        <div className="settings-form-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={busy !== null}
            onClick={() => void run(
              'create',
              () => window.wmb.createBrowserProfile(ownerBase),
              '正在创建独立登录环境并重启…',
              '已创建独立登录环境。',
            )}
          >
            {busy === 'create' ? '创建中…' : '创建独立环境'}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy !== null || !browserChoice || isCurrentChoice}
            onClick={() => void run(
              'rebind',
              () => window.wmb.rebindBrowserProfile({ ...ownerBase, profileId: browserChoice }),
              '正在改绑并重启…',
              '已改绑到所选登录环境。',
            )}
          >
            {busy === 'rebind' ? '改绑中…' : '改绑到所选环境'}
          </button>
        </div>
      </div>
    </section>

    <section className="settings-section">
      <div className="settings-section-heading">
        <h3>验证平台账号</h3>
      </div>
      <div className="settings-form">
        <label>
          <span>账号平台</span>
          <select
            aria-label="账号平台"
            value={browserPlatform}
            onChange={(event) => setBrowserPlatform(event.target.value as BrowserPlatform)}
            disabled={browserPlatforms.length === 0}
          >
            {browserPlatforms.length === 0 && <option value="x">当前工作空间未启用可验证平台</option>}
            {browserPlatforms.map((platform) => (
              <option key={platform} value={platform}>{platform === 'x' ? 'X' : '微信公众号'}</option>
            ))}
          </select>
        </label>
        <div className="settings-form-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={busy !== null || !settings.legacyBrowserSource.detected || browserPlatforms.length === 0}
            onClick={() => void run(
              'migrate',
              () => window.wmb.migrateLegacyBrowserProfile({ ...ownerBase, platform: browserPlatform }),
              `正在停止浏览器、复制并验证 ${platformName} 账号…`,
              `已完成 ${platformName} 迁移与验证。`,
            )}
          >
            {busy === 'migrate' ? '迁移中…' : `迁移并验证${platformName}`}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy !== null || !settings.browserBinding || browserPlatforms.length === 0}
            onClick={() => void run(
              'verify',
              () => window.wmb.verifyBrowserAccount({
                workspaceId: settings.workspace.id,
                platform: browserPlatform,
                expectedBindingRevision: settings.browserBinding!.bindingRevision,
                expectedRegistryRevision: settings.browserRegistryRevision,
              }),
              `正在打开浏览器验证 ${platformName} 账号（未登录可先扫码，最多等待约 3 分钟）…`,
              `已完成 ${platformName} 账号验证。`,
            )}
          >
            {busy === 'verify' ? '验证中…' : `验证 ${platformName} 账号`}
          </button>
        </div>
      </div>
      {browserNote && (
        <p className={`settings-note${/失败|错误|invalid|mismatch|stale|悬空|不一致/i.test(browserNote) ? ' error' : ''}`}>
          {browserNote}
        </p>
      )}
    </section>

    <section className="settings-section">
      <div className="settings-section-heading">
        <h3>X List 浏览缓存</h3>
      </div>
      <div className="settings-row">
        <div>
          <h3>本地预览缓存</h3>
          <p>
            {timelineCacheStats
              ? `${timelineCacheStats.rows} 条预览 · ${formatBytes(timelineCacheStats.bytes)} · ${timelineCacheStats.accounts} 个账号`
              : '正在读取缓存占用…'}
          </p>
          {timelineCacheNote && <p className="task-status">{timelineCacheNote}</p>}
        </div>
        <button
          type="button"
          className="secondary-button"
          disabled={busy !== null}
          onClick={() => {
            setBusy('cache');
            setTimelineCacheNote('');
            void window.wmb.clearXListTimelineCache()
              .then(async (result) => {
                setTimelineCacheStats(await window.wmb.getXListTimelineCacheStats());
                setTimelineCacheNote(`已清理 ${result.deleted} 条浏览缓存。`);
              })
              .catch((error) => setTimelineCacheNote(error instanceof Error ? error.message : '清理失败'))
              .finally(() => setBusy(null));
          }}
        >
          {busy === 'cache' ? '清理中…' : '清理浏览缓存'}
        </button>
      </div>
    </section>
  </>;
}
