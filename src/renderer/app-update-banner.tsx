import { useEffect, useState } from 'react';
import type { UpdateState } from '../main/app-update';

type AppUpdateBannerProps = { openSettings(): void };

// Top banner removed: updater failures surface only in the bottom status bar (WMB-update-statusbar).
// Kept for import compatibility; returns null so no workspace overlay is rendered.
export function AppUpdateBanner(_props: AppUpdateBannerProps): React.JSX.Element | null {
  return null;
}

export function AppUpdateStatusItem({ openSettings }: AppUpdateBannerProps): React.JSX.Element | null {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    void window.wmb.getAppUpdateState().then(setState);
    return window.wmb.onAppUpdateState(setState as (s: unknown) => void);
  }, []);
  if (!state) return null;
  const failed = state.status === 'error' && Boolean(state.lastError);
  if (!failed) return null;
  const detail = String(state.lastError ?? '');
  const title = detail ? `更新未完成 · ${detail}` : '更新未完成';
  return (
    <button
      type="button"
      className="status-item status-update-warn"
      title={title}
      aria-label={title}
      aria-describedby={detail ? 'update-error-detail' : undefined}
      onClick={openSettings}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openSettings();
        }
      }}
    >
      <span className="status-dot warn" aria-hidden="true" />
      <span>更新未完成</span>
      {detail ? <span id="update-error-detail" hidden>{detail}</span> : null}
    </button>
  );
}
