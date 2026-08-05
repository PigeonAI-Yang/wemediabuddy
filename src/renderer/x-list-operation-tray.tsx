import { useCallback, useEffect, useRef, useState } from 'react';
import type { XListOperation } from '../main/x-lists';

const terminal = new Set<XListOperation['state']>(['succeeded', 'partial', 'needs_user', 'unknown', 'failed']);
const labels: Record<XListOperation['kind'], string> = {
  create: '新建 List', update: '编辑 List', delete: '删除 List', members_add: '添加成员', members_remove: '移除成员'
};

export function XListOperationTray(): React.JSX.Element | null {
  const [operation, setOperation] = useState<XListOperation | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [typedName, setTypedName] = useState('');
  const [open, setOpen] = useState(false);
  const arming = useRef('');
  const refresh = useCallback(async () => {
    const latest = (await window.wmb.listXListOperations({ limit: 8 }))[0] ?? null;
    const recentTerminal = latest && terminal.has(latest.state) && Date.now() - Date.parse(latest.updatedAt) < 30 * 60_000;
    setOperation(latest && (!terminal.has(latest.state) || recentTerminal) ? latest : null);
  }, []);

  useEffect(() => {
    void refresh().catch(() => {});
    const timer = window.setInterval(() => void refresh().catch(() => {}), 1_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (isAwaitingConfirmation(operation)) setOpen(true);
  }, [operation?.id, operation?.state, operation?.phase]);
  useEffect(() => {
    if (operation?.state !== 'prepared' || operation.phase === 'awaiting_confirmation') return;
    const key = `${operation.id}:${operation.revision}`;
    if (arming.current === key) return;
    arming.current = key; setBusy(true); setNote('正在核对账号、List 和精确变更…');
    void window.wmb.armXListOperation({ operationId: operation.id, expectedRevision: operation.revision }).then((result) => {
      if (result.ok) { setOperation(result.data); setNote('核对完成，等待一次确认。'); }
      else setNote(result.error.message);
    }).catch((error) => setNote(error instanceof Error ? error.message : String(error))).finally(() => setBusy(false));
  }, [operation?.id, operation?.revision, operation?.state, operation?.phase]);

  if (!operation) return null;
  const pending = operation.items.filter((item) => item.state === 'pending').length;
  const done = operation.items.length - pending;
  const canConfirm = isAwaitingConfirmation(operation)
    && (operation.kind !== 'delete' || typedName.trim() === operation.snapshot.list?.name);
  const confirm = async () => {
    setBusy(true); setNote('正在确认操作…');
    try {
      const result = await window.wmb.confirmXListOperation({ operationId: operation.id, expectedRevision: operation.revision, typedListName: typedName });
      if (!result.ok || !result.data) { setNote(result.error?.message ?? '确认失败。'); await refresh(); return; }
      setOperation(result.data); setNote('后台执行已开始。');
    } catch (error) { setNote(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const stop = async () => {
    const result = await window.wmb.stopXListOperation({ operationId: operation.id, expectedRevision: operation.revision });
    if (result.ok) { setOperation(result.data); setNote('将在当前页面动作完成后停止。'); }
    else setNote(result.error.message);
  };

  return <><button className="x-list-operation-trigger" onClick={() => setOpen((value) => !value)}>X List · {status(operation)}{operation.items.length ? ` ${done}/${operation.items.length}` : ''}</button>{open && <section className={`x-list-operation-tray state-${operation.state}`}>
    <header><div><small>WMB X List 操作</small><strong>{labels[operation.kind]}</strong></div><button aria-label="收起操作" onClick={() => setOpen(false)}>×</button></header>
    <p>{operation.accountKey} · {operation.snapshot.list?.name ?? operation.listId ?? '新 List'}</p>
    {(operation.kind === 'members_add' || operation.kind === 'members_remove') && <p className="x-list-operation-handles">{operation.items.map((item) => item.handle).join('、')}</p>}
    {operation.kind === 'delete' && isAwaitingConfirmation(operation) && <label>输入“{operation.snapshot.list?.name}”确认删除<input value={typedName} onChange={(event) => setTypedName(event.target.value)}/></label>}
    {operation.state === 'execution_granted' && <p>确认已提交 · 正在等待浏览器接管</p>}
    {operation.state === 'browser_leased' && <p>浏览器已接管 · 正在等待执行开始</p>}
    {operation.state === 'running' && <p>后台执行中 · 已处理 {done}/{operation.items.length}</p>}
    {terminal.has(operation.state) && <p>执行结束 · 成功或无需变更 {operation.items.filter((item) => ['succeeded', 'already_present', 'already_absent'].includes(item.state)).length} · 异常 {operation.items.filter((item) => ['failed', 'needs_user', 'unknown'].includes(item.state)).length}</p>}
    {operation.errorMessage && <p className="x-list-operation-error">{operation.errorMessage}</p>}
    {note && <small>{note}</small>}
    <div className="x-list-operation-actions">{canConfirm && <button disabled={busy} onClick={() => void confirm()}>确认执行</button>}{operation.state === 'running' && <button disabled={busy} onClick={() => void stop()}>停止后续成员</button>}</div>
  </section>}</>;
}

function isAwaitingConfirmation(operation: XListOperation | null): boolean {
  return operation?.state === 'awaiting_confirmation'
    || (operation?.state === 'prepared' && operation.phase === 'awaiting_confirmation');
}

function status(operation: XListOperation): string {
  if (isAwaitingConfirmation(operation)) return '待确认';
  if (operation.state === 'prepared') return '准备中';
  if (operation.state === 'execution_granted') return '已确认，等待浏览器';
  if (operation.state === 'browser_leased') return '浏览器已接管，等待执行';
  if (operation.state === 'running') return '执行中';
  return ({ succeeded: '已完成', partial: '部分完成', needs_user: '需要接管', unknown: '结果未知', failed: '失败' } as Record<string, string>)[operation.state] ?? operation.state;
}
