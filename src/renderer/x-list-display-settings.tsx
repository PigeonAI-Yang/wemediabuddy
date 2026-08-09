import { useEffect, useState } from 'react';
import { parseVisibleXListIds, setListVisibility } from './x-list-visibility';
import { workspaceStorageKey } from './workspace-storage';

type ListIndex = Awaited<ReturnType<typeof window.wmb.readXListIndex>>;
type ListRef = ListIndex['lists'][number];
type Binding = Awaited<ReturnType<typeof window.wmb.listXListBindings>>[number];
type Operation = Awaited<ReturnType<typeof window.wmb.listXListOperations>>[number];
type ComposerInput = Parameters<typeof window.wmb.prepareXListOperation>[0];

const stateLabels: Record<Operation['state'], string> = {
  prepared: '待读取快照', awaiting_confirmation: '等待确认', execution_granted: '已确认，等待浏览器',
  browser_leased: '浏览器已接管，等待执行', running: '执行中', succeeded: '已完成',
  partial: '已停止', needs_user: '需要接管', unknown: '结果未知', failed: '失败'
};

export function XListDisplaySettings({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const storageKey = workspaceStorageKey(workspaceId, 'xListVisibleIds');
  const [index, setIndex] = useState<ListIndex | null>(null);
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [activeOperation, setActiveOperation] = useState<Operation | null>(null);
  const [visibleIds, setVisibleIds] = useState<string[] | null>(() => parseVisibleXListIds(localStorage.getItem(storageKey)));
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);

  const load = async (refresh = false) => {
    setLoading(true); setNote('');
    try {
      const nextIndex = refresh ? await window.wmb.readXListIndex() : await window.wmb.getCachedXListIndex();
      const nextBindings = await window.wmb.listXListBindings(nextIndex?.accountKey);
      const nextOperations = await window.wmb.listXListOperations({ accountKey: nextIndex?.accountKey, limit: 24 });
      setIndex(nextIndex); setBindings(nextBindings); setOperations(nextOperations);
      setSelectedId((current) => nextIndex?.lists.some((item) => item.listId === current) ? current : nextIndex?.lists[0]?.listId ?? '');
      setActiveOperation((current) => {
        if (current) return nextOperations.find((item) => item.id === current.id) ?? current;
        return nextOperations[0] ?? null;
      });
      setNote(nextIndex ? `账号 ${nextIndex.accountKey} · ${nextIndex.lists.length} 个可用 Lists` : '尚未读取账号 Lists。');
    } catch (error) { setNote(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  };

  useEffect(() => { void load(false); }, [workspaceId]);
  useEffect(() => {
    if (!activeOperation || activeOperation.state !== 'running') return;
    const timer = window.setInterval(() => void window.wmb.getXListOperation(activeOperation.id).then((current) => {
      if (!current) return;
      mergeOperation(current);
    }), 800);
    return () => window.clearInterval(timer);
  }, [activeOperation?.id, activeOperation?.state]);

  const displayedIds = visibleIds ?? bindings.map((item) => item.listId);
  const selected = index?.lists.find((item) => item.listId === selectedId) ?? null;
  const selectedBinding = selected && index ? bindings.find((item) => item.accountKey.toLowerCase() === index.accountKey.toLowerCase() && item.listId === selected.listId) ?? null : null;
  const toggle = (listId: string, visible: boolean) => {
    const next = setListVisibility(displayedIds, listId, visible);
    localStorage.setItem(storageKey, JSON.stringify(next)); setVisibleIds(next);
  };
  const mergeOperation = (operation: Operation) => {
    setActiveOperation(operation);
    setOperations((items) => [operation, ...items.filter((item) => item.id !== operation.id)]);
  };
  const toggleBinding = async () => {
    if (!selected || !index) return;
    setLoading(true); setNote('');
    try {
      const result = selectedBinding
        ? await window.wmb.setXListBindingEnabled({ accountKey: selectedBinding.accountKey, listId: selectedBinding.listId, expectedRevision: selectedBinding.revision, enabled: !selectedBinding.enabled })
        : await window.wmb.bindXList({ listId: selected.listId });
      if (!result.ok) setNote(result.error.message);
      else { await load(false); setNote(selectedBinding?.enabled ? '已移出今日情报；已有资料与 X List 均未删除。' : '已接入今日情报。'); }
    } catch (error) { setNote(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  };
  const prepare = async (draft: ComposerInput) => {
    setLoading(true); setNote('');
    try {
      const proposed = await window.wmb.prepareXListOperation(draft);
      if (!proposed.ok) { setNote(proposed.error.message); return; }
      const armed = await window.wmb.armXListOperation({ operationId: proposed.data.operation.id, expectedRevision: proposed.data.operation.revision });
      if (!armed.ok) { mergeOperation(proposed.data.operation); setNote(armed.error.message); return; }
      mergeOperation(armed.data); setNote('已冻结账号、List 与精确变更集；请回到 Pi 对话框确认一次。');
    } catch (error) { setNote(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  };
  return <>
    <section className="settings-section">
      <div className="settings-section-heading"><h3>List 工作台显示</h3></div>
      <div className="settings-inline-actions"><button type="button" className="secondary-button" disabled={loading} onClick={() => void load(true)}>{loading ? '读取中…' : '刷新账号 Lists'}</button><span className="settings-list-note">{note}</span></div>
      {index && <div className="settings-list-choices">{index.lists.map((list) => { const binding = bindings.find((item) => item.listId === list.listId); return <label key={list.listId}><input type="checkbox" checked={displayedIds.includes(list.listId)} onChange={(event) => toggle(list.listId, event.target.checked)}/><span><strong>{list.name}</strong><small>{binding?.enabled ? '今日情报已启用' : '未接入今日情报'}</small></span></label>; })}</div>}
    </section>
    {index && <section className="settings-section x-list-settings-management">
      <div className="settings-section-heading"><h3>List 管理</h3></div>
      <div className="settings-inline-actions">
        <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>{index.lists.map((list) => <option key={list.listId} value={list.listId}>{list.name} · {list.kind === 'owned' ? '我创建的' : list.kind === 'following' ? '我关注的' : '我在其中'}</option>)}</select>
        {selected && <button type="button" className="secondary-button" disabled={loading} onClick={() => void toggleBinding()}>{selectedBinding?.enabled ? '移出今日情报' : '接入今日情报'}</button>}
      </div>
      <XListComposer accountKey={index.accountKey} selected={selected} disabled={loading} onPrepare={prepare}/>
      {operations.length > 0 && <section className="x-list-history"><h3>操作记录</h3>{operations.map((operation) => <button key={operation.id} className={activeOperation?.id === operation.id ? 'active' : ''} onClick={() => setActiveOperation(operation)}><span>{operationLabel(operation)}</span><small>{stateLabel(operation)} · {new Date(operation.updatedAt).toLocaleString('zh-CN')}</small></button>)}</section>}
    </section>}
  </>;
}

function XListComposer({ accountKey, selected, disabled, onPrepare }: { accountKey: string; selected: ListRef | null; disabled: boolean; onPrepare: (input: ComposerInput) => Promise<void> }): React.JSX.Element {
  const canManage = selected?.kind === 'owned';
  const [kind, setKind] = useState<'create' | 'update' | 'delete' | 'members_add' | 'members_remove'>('create');
  const [name, setName] = useState(''); const [description, setDescription] = useState(''); const [changeDescription, setChangeDescription] = useState(false);
  const [privacy, setPrivacy] = useState<'unchanged' | 'public' | 'private'>('unchanged'); const [handles, setHandles] = useState('');
  useEffect(() => { if (!canManage && kind !== 'create') setKind('create'); }, [canManage, kind]);
  const submit = () => {
    const input: ComposerInput = { requestId: crypto.randomUUID(), accountKey, kind };
    if (kind !== 'create') input.listId = selected?.listId;
    if (kind === 'create') { input.name = name.trim(); input.description = description || undefined; input.isPrivate = privacy === 'private'; }
    if (kind === 'update') { if (name.trim()) input.name = name.trim(); if (changeDescription) input.description = description; if (privacy !== 'unchanged') input.isPrivate = privacy === 'private'; }
    if (kind === 'members_add' || kind === 'members_remove') input.handles = handles.split(/[\s,，]+/).filter(Boolean);
    void onPrepare(input);
  };
  const modes: Array<{ id: typeof kind; label: string }> = [{ id: 'create', label: '新建' }, ...(canManage ? [{ id: 'update' as const, label: '编辑' }, { id: 'members_remove' as const, label: '移除成员' }, { id: 'delete' as const, label: '删除' }] : [])];
  return <section className="x-list-composer"><header><div><h3>{selected ? `操作 ${selected.name}` : '新建 List'}</h3></div></header><div className="x-list-mode-tabs">{modes.map((mode) => <button key={mode.id} className={kind === mode.id ? 'active' : ''} onClick={() => setKind(mode.id)} disabled={disabled}>{mode.label}</button>)}</div>
    {(kind === 'create' || kind === 'update') && <div className="x-list-form"><label>名称<input value={name} placeholder={kind === 'create' ? '例如：行业观察' : '不修改'} onChange={(event) => setName(event.target.value)}/></label><label className="x-list-description-toggle"><input type="checkbox" checked={kind === 'create' || changeDescription} onChange={(event) => setChangeDescription(event.target.checked)} disabled={kind === 'create'}/> {kind === 'create' ? '添加描述' : '修改或清空描述'}</label>{(kind === 'create' || changeDescription) && <label>描述<textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="这份 List 关注什么？"/></label>}<label>公开性<select value={privacy} onChange={(event) => setPrivacy(event.target.value as typeof privacy)}><option value="unchanged">{kind === 'create' ? '公开' : '不修改'}</option><option value="public">公开</option><option value="private">私密</option></select></label></div>}
    {(kind === 'members_add' || kind === 'members_remove') && <label className="x-list-form">精确 handle（一行一个）<textarea value={handles} onChange={(event) => setHandles(event.target.value)} placeholder={'@karpathy\n@ylecun'}/></label>}
    {kind === 'delete' && <p className="x-list-danger">删除不会立即执行；下一步仍需读取快照，并要求输入当前 List 名称确认。</p>}
    <button className="x-list-primary" disabled={disabled || (kind !== 'create' && !selected) || (kind === 'create' && !name.trim())} onClick={submit}>读取快照并准备确认</button>
  </section>;
}
function stateLabel(operation: Operation): string {
  if (operation.state === 'prepared' && operation.phase === 'awaiting_confirmation') return '等待确认';
  return stateLabels[operation.state];
}


function operationLabel(operation: Operation): string {
  const labels: Record<Operation['kind'], string> = { create: '新建 List', update: '编辑 List', delete: '删除 List', members_add: '添加成员', members_remove: '移除成员' };
  return labels[operation.kind];
}
