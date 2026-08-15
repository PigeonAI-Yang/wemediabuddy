import { useEffect, useState } from 'react';

type Row = Record<string, unknown>;
type SnapshotState = Readonly<{
  topics: Row[];
  sourceLinks: Row[];
  planItems: Row[];
  contentProjects: Row[];
  workCarryItems: Row[];
  knowledgeCanvases: Row[];
  knowledgeCanvasNodes: Row[];
  knowledgeDomainTopics: Row[];
  reviews: Row[];
}>;
type Proposal = Readonly<{
  id: string;
  supersedesProposalId: string | null;
  title: string;
  reason: string;
  status: 'proposed' | 'approved' | 'rejected' | 'stale';
  revision: number;
  changes: Array<Record<string, unknown>>;
  snapshot: { frozenAt: string; before: SnapshotState; after: SnapshotState };
  reproposal: null | {
    status: 'pending' | 'completed' | 'needs_user';
    successorProposalId: string | null;
  };
}>;
type ProposalPage = { items: Proposal[]; hasMore: boolean };

const groups: Array<readonly [keyof Omit<SnapshotState, 'topics'>, string, string]> = [
  ['sourceLinks', '资料', 'source_id'],
  ['planItems', '选题', 'id'],
  ['contentProjects', '内容项目', 'id'],
  ['workCarryItems', '持续关注', 'id'],
  ['knowledgeCanvases', '画布', 'id'],
  ['knowledgeCanvasNodes', '画布主题节点', 'id'],
  ['knowledgeDomainTopics', '领域关系', 'domain_id'],
  ['reviews', '复盘', 'review_id']
];

function proposalPresentation(item: Proposal): { state: string; label: string; message?: string } {
  if (item.status === 'approved') return { state: 'approved', label: '已批准并生效' };
  if (item.status === 'rejected') return { state: 'rejected', label: '已驳回' };
  if (item.reproposal?.status === 'completed' && item.reproposal.successorProposalId) return { state: 'superseded', label: '已由新版接替', message: '这份建议未生效。资料员已按最新情况提交新版，请查看上方的新建议。' };
  if (item.reproposal?.status === 'pending') return { state: 'reproposing', label: '资料员正在重新整理', message: '现场变化影响了执行结果，系统已交回资料员按最新情况重新整理，你无需操作。' };
  if (item.reproposal?.status === 'needs_user') return { state: 'retry-exhausted', label: '重新整理未完成', message: '资料员暂未完成新版建议，请到班组查看对应工单；无需你手工整理主题。' };
  return { state: 'legacy-stale', label: '历史未生效', message: '这份历史建议未生效，仅保留作记录，不会自动恢复或改动主题。' };
}

const topicStatusLabels: Record<string, string> = {
  active: '持续关注',
  watching: '观察中',
  dormant: '已暂停',
  archived: '已归档'
};

const topicKindLabels: Record<string, string> = { theme: '长期主题', event: '事件主题' };

function topicName(state: SnapshotState, id: unknown): string {
  const row = state.topics.find((item) => item.id === id);
  return String(row?.title ?? '未知主题');
}

function changeLabel(change: Record<string, unknown>, before: SnapshotState): string {
  if (change.kind === 'merge') return `将“${topicName(before, change.mergedTopicId)}”合并到“${topicName(before, change.retainedTopicId)}”`;
  if (change.kind === 'reassign') return `将 1 份资料从“${topicName(before, change.fromTopicId)}”调整到“${topicName(before, change.toTopicId)}”`;
  if (change.kind === 'archive') return `归档主题“${topicName(before, change.topicId)}”`;
  if (change.kind === 'update') return `更新主题“${topicName(before, change.topicId)}”`;
  const after = change.after as Row | undefined;
  return `新建主题“${String(after?.title ?? '未命名主题')}”`;
}

function TopicChanges({ before, after }: { before: Row[]; after: Row[] }): React.JSX.Element {
  const beforeById = new Map(before.map((row) => [String(row.id), row]));
  const changed = after.flatMap((next) => {
    const id = String(next.id), previous = beforeById.get(id);
    if (!previous) return [{ id, title: String(next.title ?? '未命名主题'), details: [`新建${topicKindLabels[String(next.kind)] ?? '主题'}，状态：${topicStatusLabels[String(next.status)] ?? '主题'}`, ...(next.summary ? [`说明：${String(next.summary)}`] : [])] }];
    const beforeTitle = String(previous.title ?? '未命名主题'), afterTitle = String(next.title ?? '未命名主题');
    const beforeStatus = topicStatusLabels[String(previous.status)] ?? '主题', afterStatus = topicStatusLabels[String(next.status)] ?? '主题';
    const details: string[] = [];
    if (beforeStatus !== afterStatus) details.push(`状态：${beforeStatus} → ${afterStatus}`);
    if (previous.kind !== next.kind) details.push(`类型：${topicKindLabels[String(previous.kind)] ?? '主题'} → ${topicKindLabels[String(next.kind)] ?? '主题'}`);
    if (previous.summary !== next.summary) details.push(`说明：${String(previous.summary ?? '无')} → ${String(next.summary ?? '无')}`);
    if (beforeTitle === afterTitle && previous.canonical_key !== next.canonical_key) details.push('主题识别方式已更新');
    if (beforeTitle === afterTitle && !details.length) return [];
    return [{ id, title: beforeTitle === afterTitle ? afterTitle : `${beforeTitle} → ${afterTitle}`, details }];
  });
  return <div className="topic-maintenance-topic-changes"><h4>主题变化</h4>{changed.length ? changed.map((row) => (
    <div key={row.id}><strong>{row.title}</strong>{row.details.map((detail) => <span key={detail}>{detail}</span>)}</div>
  )) : <p>主题状态不变，仅调整关联内容。</p>}</div>;
}

function TechnicalDetails({ state }: { state: SnapshotState }): React.JSX.Element {
  return <div className="topic-maintenance-relations">{groups.map(([key, label, idKey]) => {
    const rows = state[key];
    return <details key={key} open={rows.length > 0}><summary>{label} {rows.length}</summary>{rows.length ? <ul>{rows.map((row, index) => (
      <li key={`${String(row[idKey])}-${index}`}><code>{String(row[idKey])}</code>{row.relation ? ` · ${String(row.relation)}` : ''}{row.topic_id ? ` → ${String(row.topic_id)}` : ''}</li>
    ))}</ul> : <p>无</p>}</details>;
  })}</div>;
}

function TechnicalTopicRows({ rows }: { rows: Row[] }): React.JSX.Element {
  return <div className="topic-maintenance-technical-topics">{rows.map((row) => <code key={String(row.id)}>{String(row.id)} · {String(row.status ?? '')} · r{String(row.revision ?? '')}</code>)}</div>;
}

function formatProposalTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function TopicMaintenanceLedger(): React.JSX.Element | null {
  const [items, setItems] = useState<Proposal[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<{ id: string; decision: 'approve' | 'reject' } | null>(null);
  const [resumeBusyId, setResumeBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => void (async () => { const all: Proposal[] = []; let offset = 0; do { const page = await window.wmb.listTopicMaintenanceProposals({ limit: 100, offset }) as ProposalPage; all.push(...page.items); if (!page.hasMore) break; offset += page.items.length; } while (true); setItems(all); setError(null); setLoaded(true); })().catch((cause: unknown) => { setError(cause instanceof Error ? cause.message : String(cause)); setLoaded(true); });
  useEffect(() => { load(); return window.wmb.onDataChanged((event) => { if (event.scopes.includes('library') || event.scopes.includes('today')) load(); }); }, []);
  const decide = async (item: Proposal, decision: 'approve' | 'reject') => {
    setBusy({ id: item.id, decision }); setError(null);
    try {
      const result = await (decision === 'approve' ? window.wmb.approveTopicMaintenanceProposal : window.wmb.rejectTopicMaintenanceProposal)({ id: item.id, expectedRevision: item.revision, requestId: `topic-maintenance:${decision}:${item.id}:r${item.revision}` });
      if (!result?.ok) { setError(result?.error?.message ?? '提案处理失败。'); return; }
      load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };
  const resume = async (item: Proposal) => {
    setResumeBusyId(item.id); setError(null);
    try {
      const result = await window.wmb.resumeTopicMaintenanceReproposal({ id: item.id });
      if (!result?.ok) { setError(result?.error?.message ?? '重新派工失败。'); return; }
      load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setResumeBusyId(null); }
  };
  if (!loaded && !error) return <section className="topic-maintenance-ledger"><p className="topic-maintenance-empty">正在加载整理记录…</p></section>;
  if (!items.length && !error) return <section className="topic-maintenance-ledger"><p className="topic-maintenance-empty">暂无整理记录。</p></section>;
  return <section className="topic-maintenance-ledger" aria-label="主题整理提案台账">
    {error ? <p role="alert" className="topic-maintenance-error">{error}</p> : null}
    {items.map((item) => { const presentation = proposalPresentation(item); return <article key={item.id} className="topic-maintenance-row" data-proposal-id={item.id}>
      <header className="topic-maintenance-head"><div><strong>{item.supersedesProposalId ? '资料员重新提交' : '主题整理建议'}（{item.changes.length} 项）</strong><small>资料员提交于 {formatProposalTime(item.snapshot.frozenAt)}</small></div><div className="topic-maintenance-head-side">{item.status === 'proposed' ? null : <span className="topic-maintenance-status" data-state={presentation.state}>{presentation.label}</span>}{item.status === 'proposed' ? <div className="topic-maintenance-actions"><button type="button" className="primary-button" disabled={busy?.id === item.id} onClick={() => void decide(item, 'approve')}>{busy?.id === item.id && busy?.decision === 'approve' ? '正在批准…' : '批准并生效'}</button><button type="button" className="secondary-button" disabled={busy?.id === item.id} onClick={() => void decide(item, 'reject')}>{busy?.id === item.id && busy?.decision === 'reject' ? '正在驳回…' : '驳回提案'}</button></div> : null}</div></header>
      <div className="topic-maintenance-summary">
        <section><h3>资料员建议</h3><ol>{item.changes.map((change, index) => <li key={index}>{changeLabel(change, item.snapshot.before)}</li>)}</ol></section>
        <section><h3>批准后影响</h3><p>将一次性执行 {item.changes.length} 项主题调整，并同步更新以下关联内容；驳回不会改动现有主题。</p><ul className="topic-maintenance-impact">{groups.filter(([key]) => item.snapshot.before[key].length > 0).map(([key, label]) => <li key={key}>{label} {item.snapshot.before[key].length}</li>)}</ul></section>
      </div>
      <details className="topic-maintenance-diff"><summary>查看完整变更明细（{item.changes.length} 项）</summary>
        <TopicChanges before={item.snapshot.before.topics} after={item.snapshot.after.topics} />
        <details className="topic-maintenance-technical"><summary>技术明细</summary><p className="topic-maintenance-reason">资料员原始说明：{item.reason}</p><div className="topic-maintenance-technical-grid"><section><h4>批准前主题</h4><TechnicalTopicRows rows={item.snapshot.before.topics} /><h4>批准前关联</h4><TechnicalDetails state={item.snapshot.before} /></section><section><h4>批准后主题</h4><TechnicalTopicRows rows={item.snapshot.after.topics} /><h4>批准后关联</h4><TechnicalDetails state={item.snapshot.after} /></section></div></details>
      </details>
      {item.status === 'stale' ? <div className="topic-maintenance-warning" data-state={presentation.state}><p>{presentation.message}</p>{item.reproposal?.status === 'needs_user' ? <button type="button" className="secondary-button" disabled={resumeBusyId === item.id} onClick={() => void resume(item)}>{resumeBusyId === item.id ? '正在重新派工…' : '重新交给资料员'}</button> : null}</div> : null}
    </article>; })}
  </section>;
}
