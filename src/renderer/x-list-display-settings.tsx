import { useEffect, useState } from 'react';
import { parseVisibleXListIds, setListVisibility } from './x-list-visibility';
import { workspaceStorageKey } from './workspace-storage';

type ListIndex = Awaited<ReturnType<typeof window.wmb.readXListIndex>>;
type Binding = Awaited<ReturnType<typeof window.wmb.getIntelligenceChannels>>['summary']['xLists'][number];

export function XListDisplaySettings({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const storageKey = workspaceStorageKey(workspaceId, 'xListVisibleIds');
  const [index, setIndex] = useState<ListIndex | null>(null);
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [visibleIds, setVisibleIds] = useState<string[] | null>(() => parseVisibleXListIds(localStorage.getItem(storageKey)));
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const load = async (refresh = false) => {
    setLoading(true); setNote('');
    try {
      const [nextIndex, channels] = await Promise.all([
        refresh ? window.wmb.readXListIndex() : window.wmb.getCachedXListIndex(),
        window.wmb.getIntelligenceChannels()
      ]);
      setIndex(nextIndex); setBindings(channels.summary.xLists);
      setNote(nextIndex ? `账号 ${nextIndex.accountKey} · ${nextIndex.lists.length} 个可用 Lists` : '尚未读取账号 Lists。');
    } catch (error) { setNote(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(false); }, [workspaceId]);
  const displayedIds = visibleIds ?? bindings.map((item) => item.listId);
  const toggle = (listId: string, visible: boolean) => {
    const next = setListVisibility(displayedIds, listId, visible);
    localStorage.setItem(storageKey, JSON.stringify(next)); setVisibleIds(next);
  };
  return <section className="settings-section">
    <div className="settings-section-heading"><h3>List 工作台显示</h3><p>这里只决定发现页显示哪些 Lists；是否参加每日情报仍在 List 工作台单独控制。</p></div>
    <div className="settings-inline-actions"><button type="button" className="secondary-button" disabled={loading} onClick={() => void load(true)}>{loading ? '读取中…' : '刷新账号 Lists'}</button><span className="settings-list-note">{note}</span></div>
    {index && <div className="settings-list-choices">{index.lists.map((list) => { const binding = bindings.find((item) => item.listId === list.listId); return <label key={list.listId}><input type="checkbox" checked={displayedIds.includes(list.listId)} onChange={(event) => toggle(list.listId, event.target.checked)}/><span><strong>{list.name}</strong><small>{binding?.enabled ? '今日情报已启用' : '未接入今日情报'}</small></span></label>; })}</div>}
  </section>;
}
