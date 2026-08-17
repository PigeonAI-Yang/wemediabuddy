import { useEffect, useState } from 'react';
import type { UpdateState } from '../main/app-update';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function AppUpdateSettings(): React.JSX.Element {
  const [state, setState] = useState<UpdateState | null>(null);
  const [actionError, setActionError] = useState('');
  useEffect(() => {
    void window.wmb.getAppUpdateState().then(setState);
    return window.wmb.onAppUpdateState(setState);
  }, []);
  const run = async (action: () => Promise<UpdateState>) => {
    setActionError('');
    try { setState(await action()); }
    catch (error) { setActionError(errorText(error)); setState(await window.wmb.getAppUpdateState()); }
  };
  if (!state) return <div className="settings-row"><div><h3>应用更新</h3><p>正在读取更新状态…</p></div></div>;
  const available = state.status === 'available' || state.status === 'downloading' || state.status === 'downloaded';
  const statusText = state.status === 'checking' ? '正在检查'
    : state.status === 'available' ? `发现 ${state.availableVersion ? `v${state.availableVersion}` : '新版本'}`
    : state.status === 'downloading' ? `正在下载${state.progress ? ` · ${state.progress.percent.toFixed(0)}%` : ''}`
    : state.status === 'downloaded' ? `${state.availableVersion ? `v${state.availableVersion} ` : ''}已下载`
    : state.status === 'error' ? '更新失败'
    : '已是最新版本';
  const color = state.status === 'error' ? 'gray' : available ? 'green' : 'gray';
  return <div className="app-update-block">
    <div className="settings-row">
      <div><h3>应用版本</h3><p>v{state.currentVersion} · 更新源 GitHub Releases</p></div>
      <div className="settings-row-actions"><span className={`pill-status ${color}`}><span className="dot"/>{statusText}</span><button className="secondary-button" disabled={state.status === 'checking' || state.status === 'downloading' || state.installing} onClick={() => void run(window.wmb.checkAppUpdate)}>检查更新</button></div>
    </div>
    {state.status === 'downloading' && state.progress && <div className="update-progress" aria-label={`更新下载 ${state.progress.percent.toFixed(0)}%`}><span style={{ width: `${Math.min(100, Math.max(0, state.progress.percent))}%` }}/></div>}
    {available && <div className="settings-row update-decision"><div><h3>{state.status === 'downloaded' ? '更新已准备好' : '可用更新'}</h3><p>{state.release?.releaseNotes || '安装前会停止新任务，并备份本地数据与配置。'}</p>{state.userIntent === 'on-quit' && <p className="task-status">已选择退出时安装。</p>}{state.userIntent === 'later' && <p className="task-status">本次已稍后提醒，可随时改选。</p>}</div><div className="settings-row-actions"><button className="primary-button" disabled={state.installing} onClick={() => void run(window.wmb.installAppUpdateNow)}>现在更新</button><button className="secondary-button" disabled={state.installing} onClick={() => void run(window.wmb.installAppUpdateOnQuit)}>退出时安装</button><button className="secondary-button" disabled={state.installing} onClick={() => void run(window.wmb.remindAppUpdateLater)}>稍后提醒</button></div></div>}
    {(state.lastError || actionError) && <div className="settings-row update-error"><div><h3>未能完成更新</h3><p>{actionError || state.lastError}</p>{state.backupPath && <p>可恢复备份：{state.backupPath}</p>}</div><div className="settings-row-actions"><button className="secondary-button" onClick={() => void run(window.wmb.checkAppUpdate)}>重试</button><button className="secondary-button" onClick={() => void window.wmb.openExternal('https://github.com/PigeonAI-Yang/wemediabuddy/releases')}>手动下载</button></div></div>}
    {state.pendingVersion && <div className="settings-row"><div><h3>更新恢复信息</h3><p>待确认版本 v{state.pendingVersion}{state.backupPath ? ` · 备份 ${state.backupPath}` : ''}</p></div></div>}
  </div>;
}
