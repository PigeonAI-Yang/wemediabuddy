import { useEffect, useState } from 'react';
import type { UpdateState } from '../main/app-update';

type AppUpdateBannerProps = { openSettings(): void };

export function AppUpdateBanner({ openSettings }: AppUpdateBannerProps): React.JSX.Element | null {
  const [state, setState] = useState<UpdateState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void window.wmb.getAppUpdateState().then(setState);
    return window.wmb.onAppUpdateState(setState);
  }, []);
  if (!state) return null;
  const ready = state.status === 'downloaded' && state.userIntent !== 'later';
  const failed = state.status === 'error' && Boolean(state.lastError);
  if (!ready && !failed) return null;

  const run = async (action: () => Promise<UpdateState>) => {
    setBusy(true);
    try { setState(await action()); }
    catch { setState(await window.wmb.getAppUpdateState()); }
    finally { setBusy(false); }
  };
  if (failed) {
    return <section className="app-update-banner error" role="alert">
      <div><strong>更新未完成</strong><span>{state.lastError}</span></div>
      <button className="secondary-button" onClick={openSettings}>查看更新设置</button>
    </section>;
  }
  return <section className="app-update-banner" role="status" aria-live="polite">
    <div><strong>WeMediaBuddy v{state.availableVersion} 已准备好</strong><span>重启前会停止新任务并备份本地数据。</span></div>
    <div className="app-update-banner-actions">
      <button className="secondary-button" disabled={busy} onClick={() => void run(window.wmb.remindAppUpdateLater)}>稍后提醒</button>
      <button className="primary-button" disabled={busy} onClick={() => void run(window.wmb.installAppUpdateNow)}>{busy ? '正在准备…' : '立即重启更新'}</button>
    </div>
  </section>;
}
