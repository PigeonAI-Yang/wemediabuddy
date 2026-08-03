import { useEffect, useMemo, useState } from 'react';
import type { IntelligenceModule } from '../main/intelligence-channels';
import type { ChannelProposalInput } from '../main/intelligence-channel-proposals';
import { channelReadiness, intelligenceModuleLabels, intelligenceModules } from './intelligence-channel-ui';

type ChannelData = Awaited<ReturnType<typeof window.wmb.getIntelligenceChannels>>;
type ChannelSource = ChannelData['summary']['sources'][number];
type WebsiteCandidate = Awaited<ReturnType<typeof window.wmb.resolveWebsiteCandidates>>[number];
type WebsiteTrial = Awaited<ReturnType<typeof window.wmb.trialReadWebsite>>;
type XResolution = Awaited<ReturnType<typeof window.wmb.resolveXListCandidates>>;
type XResolutionData = Extract<XResolution, { ok: true }>['data'];
type ChannelProposal = Awaited<ReturnType<typeof window.wmb.listIntelligenceChannelProposals>>[number];

const sourceStatusLabels: Record<ChannelSource['status'], string> = {
  ready: '可运行',
  disabled: '已停用',
  needs_user: '需要处理',
  failed: '读取失败'
};

const receiptStatusLabels = { succeeded: '已检查', failed: '检查失败', needs_user: '需要处理' } as const;

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function displayTime(value: string): string { return new Date(value).toLocaleString('zh-CN', { hour12: false }); }

export function IntelligenceChannelsView({ onStatusChange, settingsMode = false }: {
  onStatusChange?: (status: { text: string; running?: boolean } | null) => void;
  settingsMode?: boolean;
}): React.JSX.Element {
  const [data, setData] = useState<ChannelData | null>(null);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [websiteInput, setWebsiteInput] = useState('');
  const [websiteCandidates, setWebsiteCandidates] = useState<WebsiteCandidate[]>([]);
  const [selectedWebsite, setSelectedWebsite] = useState<WebsiteCandidate | null>(null);
  const [websiteTrial, setWebsiteTrial] = useState<WebsiteTrial | null>(null);
  const [xInput, setXInput] = useState('');
  const [xResolution, setXResolution] = useState<XResolutionData | null>(null);
  const [selectedXListId, setSelectedXListId] = useState('');
  const [proposals, setProposals] = useState<ChannelProposal[]>([]);
  const [xTrends, setXTrends] = useState<Record<string, Awaited<ReturnType<typeof window.wmb.listXPostTrends>>>>({});
  const [observations, setObservations] = useState<Record<string, Awaited<ReturnType<typeof window.wmb.getXObservation>>>>({});

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [channels, pending] = await Promise.all([window.wmb.getIntelligenceChannels(), window.wmb.listIntelligenceChannelProposals()]);
      setData(channels); setProposals(pending);
      const trends = await Promise.all(channels.summary.sources.filter((source) => source.module === 'x_lists')
        .map(async (source) => [source.sourceId, await window.wmb.listXPostTrends({ bindingId: source.sourceId, limit: 20 })] as const));
      setXTrends(Object.fromEntries(trends));
    }
    catch (error) { setNote(messageOf(error)); }
    finally { if (!silent) setLoading(false); }
  };
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(true); }, 5000);
    const unsubscribe = window.wmb.onDataChanged((event) => {
      if (event.scopes.includes('sources') || event.scopes.includes('today')) void load();
    });
    return () => { window.clearInterval(timer); unsubscribe(); };
  }, []);
  useEffect(() => {
    if (!onStatusChange) return;
    onStatusChange(busy ? { text: busy, running: true } : null);
    return () => onStatusChange(null);
  }, [busy, onStatusChange]);

  const latestReceipts = useMemo(() => {
    const latest = new Map<string, ChannelData['receipts'][number]>();
    for (const receipt of data?.receipts ?? []) if (!latest.has(receipt.sourceId)) latest.set(receipt.sourceId, receipt);
    return latest;
  }, [data]);
  const selectedXList = xResolution?.candidates.find((item) => item.listId === selectedXListId) ?? null;

  const resolveWebsite = async () => {
    setBusy('正在识别官网…'); setNote(''); setWebsiteTrial(null); setSelectedWebsite(null);
    try {
      const candidates = await window.wmb.resolveWebsiteCandidates({ inputText: websiteInput });
      setWebsiteCandidates(candidates); setSelectedWebsite(candidates[0] ?? null);
      if (!candidates.length) setNote('没有找到可确认的网站候选。');
    } catch (error) { setWebsiteCandidates([]); setNote(messageOf(error)); }
    finally { setBusy(''); }
  };
  const trialWebsite = async () => {
    if (!selectedWebsite) return;
    setBusy('正在试读官网…'); setNote('');
    try { setWebsiteTrial(await window.wmb.trialReadWebsite({ url: selectedWebsite.url })); }
    catch (error) { setWebsiteTrial(null); setNote(messageOf(error)); }
    finally { setBusy(''); }
  };
  const prepareProposal = async (changes: ChannelProposalInput['changes'], successNote: string): Promise<boolean> => {
    setBusy('正在准备来源变更…'); setNote('');
    try {
      await window.wmb.prepareIntelligenceChannelProposal({ requestId: crypto.randomUUID(), changes });
      setNote(`${successNote} 请在下方确认完整变更。`); await load(); return true;
    } catch (error) { setNote(messageOf(error)); return false; }
    finally { setBusy(''); }
  };
  const confirmWebsite = async () => {
    if (!selectedWebsite || !websiteTrial?.readable) return;
    if (await prepareProposal([{ action: 'add', module: 'official_web', inputText: websiteInput, candidate: selectedWebsite, trialRead: websiteTrial }], '官网已加入待确认清单。')) {
      setWebsiteInput(''); setWebsiteCandidates([]); setSelectedWebsite(null); setWebsiteTrial(null);
    }
  };
  const resolveXList = async () => {
    setBusy('正在读取当前账号的 X Lists…'); setNote(''); setXResolution(null); setSelectedXListId('');
    try {
      const result = await window.wmb.resolveXListCandidates({ inputText: xInput });
      if (!result.ok) { setNote(result.error.message); return; }
      setXResolution(result.data); setSelectedXListId(result.data.candidates[0]?.listId ?? '');
    } catch (error) { setNote(messageOf(error)); }
    finally { setBusy(''); }
  };
  const confirmXList = async () => {
    if (!xResolution || !selectedXList) return;
    if (await prepareProposal([{ action: 'add', module: 'x_lists', resolution: xResolution, candidate: selectedXList }], 'X List 已加入待确认清单。')) {
      setXInput(''); setXResolution(null); setSelectedXListId('');
    }
  };
  const mutateSource = async (source: ChannelSource, action: 'toggle' | 'scan' | 'remove') => {
    const input = { module: source.module, sourceId: source.sourceId, expectedRevision: source.revision };
    if (action !== 'scan') {
      const proposalAction = action === 'remove' ? 'remove' : source.enabled ? 'disable' : 'enable';
      const message = proposalAction === 'remove' ? '来源已加入待确认清单。历史资料会保留。' : `来源${proposalAction === 'enable' ? '启用' : '停用'}已加入待确认清单。`;
      await prepareProposal([{ action: proposalAction, ...input }], message); return;
    }
    setBusy(`正在扫描 ${source.name}…`); setNote('');
    try { await window.wmb.scanIntelligenceChannel(input); setNote('扫描完成，已更新检查回执。'); await load(); }
    catch (error) { setNote(messageOf(error)); }
    finally { setBusy(''); }
  };
  const observeXList = async (source: ChannelSource) => {
    setBusy(`正在开始 ${source.name} 趋势观察…`); setNote('');
    try {
      const result = await window.wmb.startXObservation({ requestId: crypto.randomUUID(), bindingIds: [source.sourceId] });
      if (!result.ok) setNote(result.error.message);
      else { setObservations((current) => ({ ...current, [source.sourceId]: result.data })); setNote('已安排 15/60/180 分钟三个观察窗口。'); await load(true); }
    } catch (error) { setNote(messageOf(error)); }
    finally { setBusy(''); }
  };
  const stopObservation = async (sourceId: string) => {
    const session = observations[sourceId]; if (!session) return;
    const stopped = await window.wmb.stopXObservation({ sessionId: session.id });
    setObservations((current) => ({ ...current, [sourceId]: stopped })); setNote('趋势观察已停止。');
  };
  const confirmProposal = async (entry: ChannelProposal) => {
    setBusy('正在确认来源变更…'); setNote('');
    try {
      const result = await window.wmb.confirmIntelligenceChannelProposal(entry.binding);
      setNote(`已确认 ${result.applied} 项来源变更。`); await load();
    } catch (error) { setNote(messageOf(error)); await load(); }
    finally { setBusy(''); }
  };

  return <section className="intelligence-channels" aria-label="情报渠道">
    <header className="intelligence-channels-head">
      <div>{settingsMode ? <h3>来源与扫描</h3> : <h1>情报渠道</h1>}<p>管理当前工作空间每天会检查的官网和 X Lists。来源各自同等参与今日情报。</p></div>
      <button className="refresh-button" onClick={() => void load()} disabled={loading || Boolean(busy)} title="刷新渠道" aria-label="刷新渠道">↻</button>
    </header>
    <div className="channel-readiness" aria-label="渠道就绪情况">
      {intelligenceModules.map((module) => {
        const readiness = channelReadiness(data?.summary, module);
        return <div key={module}><strong>{intelligenceModuleLabels[module]}</strong><span>{readiness.configuredCount} 个来源，{readiness.readyCount} 个可运行</span>{readiness.blockedCount ? <em>另有 {readiness.blockedCount} 个需要处理</em> : null}</div>;
      })}
    </div>
    {note && <p className="channel-note" data-tone={note.includes('失败') || note.includes('错误') ? 'danger' : undefined}>{note}</p>}
    <div className="channel-add-grid">
      <section className="channel-add-form" aria-labelledby="add-website-title">
        <div><h2 id="add-website-title">添加官网</h2><p>输入网站名称或公开 URL，先确认候选并完成试读。</p></div>
        <label>网站名称或 URL<input value={websiteInput} onChange={(event) => setWebsiteInput(event.target.value)} placeholder="例如 GOV.UK 或 https://www.gov.uk/" /></label>
        <button className="secondary-button" onClick={() => void resolveWebsite()} disabled={!websiteInput.trim() || Boolean(busy)}>识别网站</button>
        {websiteCandidates.length > 0 && <div className="channel-candidates" aria-label="官网候选">
          {websiteCandidates.map((candidate) => <label key={candidate.canonicalUrl} className={selectedWebsite?.canonicalUrl === candidate.canonicalUrl ? 'selected' : ''}>
            <input type="radio" name="website-candidate" checked={selectedWebsite?.canonicalUrl === candidate.canonicalUrl} onChange={() => { setSelectedWebsite(candidate); setWebsiteTrial(null); }} />
            <span><strong>{candidate.name}</strong><small>{candidate.canonicalUrl}</small></span>
          </label>)}
          <div className="channel-confirm-row"><button className="secondary-button" onClick={() => void trialWebsite()} disabled={!selectedWebsite || Boolean(busy)}>试读所选网站</button>{websiteTrial && <span data-state={websiteTrial.readable ? 'ready' : 'blocked'}>{websiteTrial.readable ? `可读：${websiteTrial.title}` : websiteTrial.errorMessage || '暂不可读'}</span>}{websiteTrial?.readable && <button className="primary-button" onClick={() => void confirmWebsite()} disabled={Boolean(busy)}>加入待确认清单</button>}</div>
        </div>}
      </section>
      <section className="channel-add-form" aria-labelledby="add-x-list-title">
        <div><h2 id="add-x-list-title">添加 X List</h2><p>输入 List 名称、URL 或 ID，只从当前工作空间账号读取。</p></div>
        <label>List 名称、URL 或 ID<input value={xInput} onChange={(event) => setXInput(event.target.value)} placeholder="例如 AI Sources 或 https://x.com/i/lists/..." /></label>
        <button className="secondary-button" onClick={() => void resolveXList()} disabled={!xInput.trim() || Boolean(busy)}>查找 List</button>
        {xResolution && <div className="channel-candidates" aria-label="X List 候选">
          {xResolution.candidates.map((candidate) => <label key={candidate.listId} className={selectedXListId === candidate.listId ? 'selected' : ''}>
            <input type="radio" name="x-list-candidate" checked={selectedXListId === candidate.listId} onChange={() => setSelectedXListId(candidate.listId)} />
            <span><strong>{candidate.name}</strong><small>{candidate.accountKey} · {candidate.ownerHandle || '未知创建者'} · {candidate.canonicalUrl}</small></span>
          </label>)}
          <div className="channel-confirm-row"><span>{xResolution.candidates.length > 1 ? '同名 List 已全部列出，请选择准确来源。' : '请确认这是要接入的 List。'}</span><button className="primary-button" onClick={() => void confirmXList()} disabled={!selectedXList || Boolean(busy)}>加入待确认清单</button></div>
        </div>}
      </section>
    </div>
    {proposals.length > 0 && <section className="channel-proposal-list" aria-labelledby="channel-proposal-title">
      <header><div><h2 id="channel-proposal-title">待确认的来源变更</h2><p>这是 Pi 或外部 Agent 准备的精确清单。确认前会重新核验当前工作空间、配方、来源和 X 账号。</p></div></header>
      {proposals.map((entry) => <article key={entry.proposal.id} className="channel-proposal">
        <ol>{entry.proposal.displayedDiff.map((item, index) => <li key={`${item.module}:${item.stableIdentity}`}><strong>{index + 1}. {item.display.title}</strong>{item.display.details.map((detail) => <small key={detail}>{detail}</small>)}</li>)}</ol>
        <button className="primary-button" onClick={() => void confirmProposal(entry)} disabled={Boolean(busy)}>确认这 {entry.proposal.displayedDiff.length} 项变更</button>
      </article>)}
    </section>}
    <section className="channel-source-list" aria-labelledby="configured-sources-title">
      <header><div><h2 id="configured-sources-title">当前来源</h2><p>每次扫描都会留下真实检查回执。停用或移除不会删除已有资料。</p></div></header>
      {loading && !data ? <p className="channel-empty">正在读取来源…</p> : data?.summary.sources.length ? <div>{data.summary.sources.map((source) => {
        const receipt = latestReceipts.get(source.sourceId);
        const trend = xTrends[source.sourceId]?.find((item) => item.viewsPerHour.status === 'value');
        const observation = observations[source.sourceId];
        return <article className="channel-source-row" key={source.sourceId}>
          <div className="channel-source-main"><div className="channel-source-title"><span>{intelligenceModuleLabels[source.module]}</span><h3>{source.name}</h3><em data-state={source.status}>{sourceStatusLabels[source.status]}</em></div><button className="channel-url" onClick={() => void window.wmb.openExternal(source.canonicalUrl)}>{source.canonicalUrl}</button>{source.module === 'x_lists' && <small>{source.accountKey} · List {source.listId}{trend?.viewsPerHour.status === 'value' ? ` · 浏览 +${Math.round(trend.viewsPerHour.value).toLocaleString('zh-CN')}/小时 · ${trend.velocityChange.status === 'value' ? trend.velocityChange.snapshotIds.length : trend.viewsPerHour.snapshotIds.length} 个快照证据` : ''}</small>}</div>
          <div className="channel-receipt">{receipt ? <><strong>{receiptStatusLabels[receipt.status]}</strong><span>{displayTime(receipt.checkedAt)} · 发现 {receipt.candidateCount}，入库 {receipt.savedCount}</span>{receipt.errorMessage ? <small>{receipt.errorMessage}</small> : null}</> : <span>尚未检查</span>}</div>
          <div className="channel-source-actions"><button className="secondary-button" onClick={() => void mutateSource(source, 'toggle')} disabled={Boolean(busy)}>{source.enabled ? '准备停用' : '准备启用'}</button><button className="secondary-button" onClick={() => void mutateSource(source, 'scan')} disabled={!source.enabled || Boolean(busy)}>立即扫描</button>{source.module === 'x_lists' && <button className="secondary-button" onClick={() => void (observation && observation.status !== 'stopped' ? stopObservation(source.sourceId) : observeXList(source))} disabled={!source.enabled || Boolean(busy)}>{observation && observation.status !== 'stopped' ? `停止观察 · ${observation.jobs.filter((job) => job.status === 'pending').length} 待执行` : '观察趋势'}</button>}<button className="channel-remove" onClick={() => void mutateSource(source, 'remove')} disabled={Boolean(busy)}>{source.module === 'x_lists' ? '准备移出' : '准备移除'}</button></div>
        </article>;
      })}</div> : <p className="channel-empty">还没有情报来源。先添加一个公开网站，或接入当前账号可访问的 X List。</p>}
    </section>
  </section>;
}
