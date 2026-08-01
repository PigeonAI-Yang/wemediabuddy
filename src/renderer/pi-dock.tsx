import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PiContextRef } from './app-types';
import { PiDockTranscript, formatPiMessageTime, type PiDockMessage, type PiNativeQueue } from './pi-dock-transcript';

function piToolActivity(toolName?: string): string {
  if (!toolName) return '正在处理';
  if (['read', 'grep', 'find', 'ls'].includes(toolName)) return '正在查阅资料';
  if (toolName === 'bash') return '正在执行任务';
  if (toolName === 'edit' || toolName === 'write') return '正在整理内容';
  if (toolName.includes('search')) return '正在搜索资料';
  if (toolName.includes('source') || toolName.includes('workbench')) return '正在读取工作台';
  if (toolName.includes('save')) return '正在保存成果';
  return '正在使用工具';
}

function piErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim() || 'Pi 回复失败。';
}
const PiComposer = memo(function PiComposer({
  configured,
  busy,
  phase,
  draftSeed,
  onDraftSeedConsumed,
  onSend,
  onStop,
  modelLabel,
  thinkingChoice,
  modelMenuOpen,
  modelMenuBusy,
  modelChoice,
  modelOptions,
  onModelChoice,
  onThinkingChoice,
  onOpenModelMenu,
  onCloseModelMenu,
  onApplyModel
}: {
  configured: boolean;
  busy: boolean;
  phase: 'idle' | 'starting' | 'running' | 'failed' | 'stopped';
  draftSeed: string | null;
  onDraftSeedConsumed: () => void;
  onSend: (text: string, delivery?: 'steer' | 'followUp') => void;
  onStop: () => void;
  modelLabel: string;
  thinkingChoice: 'auto' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  modelMenuOpen: boolean;
  modelMenuBusy: boolean;
  modelChoice: string;
  modelOptions: string[];
  onModelChoice: (value: string) => void;
  onThinkingChoice: (value: 'auto' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max') => void;
  onOpenModelMenu: () => void;
  onCloseModelMenu: () => void;
  onApplyModel: () => void;
}): React.JSX.Element {
  const [input, setInput] = useState('');
  useEffect(() => {
    if (draftSeed == null) return;
    setInput(draftSeed);
    onDraftSeedConsumed();
  }, [draftSeed, onDraftSeedConsumed]);
  const sendCurrent = (delivery?: 'steer' | 'followUp') => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    onSend(text, delivery);
  };
  return <footer className="pi-dock-footer">
    {modelMenuOpen && <div className="pi-model-menu" role="dialog" aria-label="选择模型和推理强度">
      <div className="pi-model-menu-head"><strong>模型与推理</strong><button type="button" onClick={onCloseModelMenu}>×</button></div>
      <label><span>模型</span><select disabled={modelMenuBusy} value={modelChoice} onChange={(event) => onModelChoice(event.target.value)}>
        {modelOptions.length ? modelOptions.map((model) => <option key={model} value={model}>{model}</option>) : <option value={modelChoice}>{modelMenuBusy ? '正在读取模型…' : modelChoice || '没有可用模型'}</option>}
      </select></label>
      <label><span>推理强度</span><select disabled={modelMenuBusy} value={thinkingChoice} onChange={(event) => onThinkingChoice(event.target.value as typeof thinkingChoice)}>
        <option value="auto">自动</option><option value="off">关闭</option><option value="minimal">极简</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="xhigh">很高</option><option value="max">最高</option>
      </select></label>
      <button type="button" className="primary-button" disabled={modelMenuBusy || !modelChoice} onClick={onApplyModel}>{modelMenuBusy ? '读取中…' : '应用到新回复'}</button>
    </div>}
    <div className="pi-composer">
      <textarea
        disabled={!configured}
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendCurrent(event.altKey ? 'followUp' : 'steer'); } }}
        placeholder={configured ? (busy ? '继续输入；发送会插入当前回复，Alt+Enter 放到下一轮' : phase === 'failed' ? '失败后可以直接重试' : phase === 'stopped' ? '已停止，可以继续发送' : '给 Pi 发消息') : '配置 Pi API 后可以对话'}
      />
      <div className="pi-composer-bar">
        <div className="pi-composer-tools">
          <button type="button" className="pi-icon-button" title="插入图片（即将支持）" aria-label="插入图片" disabled>
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m21 15-4.5-4.5L9 18"/></svg>
          </button>
          <button type="button" className="pi-icon-button" title="附件（即将支持）" aria-label="附件" disabled>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21.44 11.05-8.49 8.49a5.5 5.5 0 0 1-7.78-7.78l8.49-8.49a3.5 3.5 0 0 1 4.95 4.95l-8.49 8.49a1.5 1.5 0 0 1-2.12-2.12l7.78-7.78"/></svg>
          </button>
        </div>
        <div className="pi-composer-meta">
          <button type="button" className={`pi-model-trigger${modelMenuOpen ? ' open' : ''}`} title="选择模型和推理强度" onClick={onOpenModelMenu}><span>{modelLabel}</span><small>{thinkingChoice === 'auto' ? '自动' : thinkingChoice}</small><b>▾</b></button>
          {busy && !input.trim()
            ? <button type="button" className="pi-send-button pi-stop-button" title="停止 Pi 当前回复" aria-label="停止 Pi 当前回复" disabled={!configured} onClick={onStop}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg></button>
            : <button type="button" className="pi-send-button" title={busy ? '插入当前回复（Alt+Enter 放到下一轮）' : '发送'} aria-label={busy ? '插入当前回复' : '发送'} disabled={!configured || !input.trim()} onClick={() => sendCurrent('steer')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 14-7-5 14-2-5-7-2Z"/><path d="m12 12 7-7"/></svg></button>}
        </div>
      </div>
    </div>
  </footer>;
});


export function PiDock({ collapsed, toggle, configured, context, resize, resetWidth }: {
  collapsed: boolean;
  toggle: () => void;
  configured: boolean;
  context: PiContextRef;
  resize: (event: React.PointerEvent<HTMLDivElement>) => void;
  resetWidth: () => void;
}): React.JSX.Element {
  type PiSessionItem = { id: string; title: string; preview: string; createdAt: string; updatedAt: string; active: boolean };
  const [draftSeed, setDraftSeed] = useState<string | null>(null);
  const [messages, setMessages] = useState<PiDockMessage[]>([]);
  const [nativeQueue, setNativeQueue] = useState<PiNativeQueue>({ steering: [], followUp: [] });
  const [sessions, setSessions] = useState<PiSessionItem[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'starting' | 'running' | 'failed' | 'stopped'>('idle');
  const [statusText, setStatusText] = useState(configured ? '已配置' : '等待配置');
  const conversationRef = useRef<HTMLDivElement | null>(null);
  const conversationTouched = useRef(false);
  const headerRef = useRef<HTMLElement | null>(null);
  const busy = phase === 'starting' || phase === 'running';
  const [modelLabel, setModelLabel] = useState('默认模型');
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelMenuBusy, setModelMenuBusy] = useState(false);
  const [modelChoice, setModelChoice] = useState('');
  const [thinkingChoice, setThinkingChoice] = useState<'auto' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>('auto');
  const [activePiProfile, setActivePiProfile] = useState<{
    id: string; name: string; baseUrl: string; model: string;
    api: 'openai-responses' | 'openai-completions';
    thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    configured: boolean; active: boolean;
  } | null>(null);
  const [toast, setToast] = useState('');

  const refreshSessions = async () => {
    try {
      const listed = await window.wmb.listPiConversations();
      setSessions(listed);
      setActiveSessionId(listed.find((item) => item.active)?.id ?? listed[0]?.id ?? null);
    } catch {
      setSessions([]);
    }
  };

  useEffect(() => {
    void window.wmb.getPiConversation().then((conversation) => {
      if (conversationTouched.current) return;
      setMessages(conversation.messages ?? []);
      setActiveSessionId(conversation.id || null);
    }).catch(() => {});
    void refreshSessions();
  }, []);
  useEffect(() => {
    setStatusText(configured ? (phase === 'idle' ? '已配置' : statusText) : '等待配置');
  }, [configured]);

  useEffect(() => {
    const node = conversationRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, nativeQueue, phase]);

  useEffect(() => {
    if (!sessionMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (headerRef.current && target && !headerRef.current.contains(target)) setSessionMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSessionMenuOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [sessionMenuOpen]);

  useEffect(() => window.wmb.onPiEvent((event) => {
    if (event.scope !== 'dock') return;
    if (event.type === 'starting') { setPhase('starting'); setStatusText('正在连接 Pi'); return; }
    if (event.type === 'running') { setPhase('running'); setStatusText('正在思考'); return; }
    if (event.type === 'tool') { setPhase('running'); setStatusText(piToolActivity(event.toolName)); return; }
    if (event.type === 'queue') {
      setNativeQueue({ steering: event.steering ?? [], followUp: event.followUp ?? [] });
      return;
    }
    if (event.type === 'queued') {
      setPhase('running');
      setStatusText(event.delivery === 'followUp' ? '已加入下一轮' : '已加入插队队列');
      return;
    }
    if (event.type === 'thinking') {
      setPhase('running'); setStatusText('正在思考');
      setMessages((items) => {
        const next = items.slice();
        const last = next[next.length - 1];
        if (last?.role === 'assistant' && last.status === 'streaming') next[next.length - 1] = { ...last, thinking: event.text ?? '' };
        else next.push({ role: 'assistant', text: '', thinking: event.text ?? '', status: 'streaming', createdAt: new Date().toISOString() });
        return next;
      });
      return;
    }
    if (event.type === 'delta') {
      setPhase('running'); setStatusText('正在回复');
      setMessages((items) => {
        const next = items.slice();
        const last = next[next.length - 1];
        if (last?.role === 'assistant' && last.status === 'streaming') next[next.length - 1] = { ...last, text: event.text ?? '' };
        else next.push({ role: 'assistant', text: event.text ?? '', status: 'streaming', createdAt: new Date().toISOString() });
        return next;
      });
      return;
    }
    if (event.type === 'stopped') {
      setPhase('stopped'); setStatusText('已停止');
      setMessages((items) => {
        const next = items.slice();
        const last = next[next.length - 1];
        const text = (event.text && event.text.trim()) || last?.text || '已停止生成。';
        const thinking = (event.thinking && event.thinking.trim()) || last?.thinking;
        if (last?.role === 'assistant') next[next.length - 1] = { ...last, role: 'assistant', text, ...(thinking ? { thinking } : {}), status: 'stopped' };
        else next.push({ role: 'assistant', text, ...(thinking ? { thinking } : {}), status: 'stopped', createdAt: new Date().toISOString() });
        return next;
      });
      return;
    }
    if (event.type === 'failed') {
      setNativeQueue({ steering: [], followUp: [] });
      setPhase('failed'); setStatusText('失败');
      setMessages((items) => {
        const next = items.slice();
        const last = next[next.length - 1];
        const text = event.error || 'Pi 回复失败。';
        if (last?.role === 'assistant' && last.status === 'streaming') next[next.length - 1] = { ...last, role: 'assistant', text, status: 'failed' };
        else next.push({ role: 'assistant', text, status: 'failed', createdAt: new Date().toISOString() });
        return next;
      });
      return;
    }
    if (event.type === 'idle') {
      setNativeQueue({ steering: [], followUp: [] });
      setPhase('idle'); setStatusText(configured ? '已配置' : '等待配置');
      setMessages((items) => {
        const next = items.slice();
        const last = next[next.length - 1];
        if (last?.role === 'assistant' && last.status === 'streaming') {
          next[next.length - 1] = {
            ...last,
            role: 'assistant',
            text: event.text || last.text,
            ...(event.thinking || last.thinking ? { thinking: event.thinking || last.thinking } : {}),
            status: undefined
          };
        }
        return next;
      });
      void refreshSessions();
    }
  }), [configured]);

  useEffect(() => {
    void window.wmb.getSettings().then((settings) => {
      const profile = settings?.pi?.profiles.find((item) => item.active) ?? null;
      if (profile) {
        setActivePiProfile(profile);
        setModelLabel(profile.model);
        setModelChoice(profile.model);
        setThinkingChoice(profile.thinking ?? 'auto');
      }
    }).catch(() => {});
  }, []);

  const openModelMenu = async () => {
    if (modelMenuOpen) { setModelMenuOpen(false); return; }
    setModelMenuOpen(true);
    setModelMenuBusy(true);
    try {
      const settings = await window.wmb.getSettings();
      const profile = settings?.pi?.profiles.find((item) => item.active) ?? null;
      if (!profile) throw new Error('请先配置 Pi API。');
      setActivePiProfile(profile);
      setModelChoice(profile.model);
      setThinkingChoice(profile.thinking ?? 'auto');
      setModelOptions(await window.wmb.listPiModels({ id: profile.id, baseUrl: profile.baseUrl, api: profile.api }));
    } catch (error) {
      showToast(error instanceof Error ? error.message : '获取模型失败');
    } finally {
      setModelMenuBusy(false);
    }
  };

  const applyModelChoice = async () => {
    if (!activePiProfile || !modelChoice) return;
    setModelMenuBusy(true);
    try {
      await window.wmb.savePiConfig({
        id: activePiProfile.id,
        name: activePiProfile.name,
        baseUrl: activePiProfile.baseUrl,
        model: modelChoice,
        api: activePiProfile.api,
        thinking: thinkingChoice === 'auto' ? undefined : thinkingChoice
      });
      setModelLabel(modelChoice);
      setActivePiProfile({ ...activePiProfile, model: modelChoice, thinking: thinkingChoice === 'auto' ? undefined : thinkingChoice });
      setModelMenuOpen(false);
      showToast('模型设置已更新');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存模型失败');
    } finally {
      setModelMenuBusy(false);
    }
  };

  const showToast = (text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(''), 1400);
  };
  const contextChip = useMemo(() => {
    const rankingCount = (context.rankingContext?.boards.length ?? 0) + (context.rankingContext?.items.length ?? 0);
    const xList = context.xListContext;
    if (context.contextSelection) {
      return `${context.pageLabel} · ${context.contextSelection.mode==='selected'?`已选 ${context.contextSelection.nodeIds.length} 项`:`当前页 ${context.contextSelection.nodeIds.length} 项`}`;
    }
    if (xList) {
      if (xList.mode === 'post' && xList.selectedPost) return `${context.pageLabel} · 帖子 ${xList.selectedPost.authorHandle || ''}`.trim();
      if (xList.listName) return `${context.pageLabel} · ${xList.listName}${xList.loadedCount ? ` · 已加载 ${xList.loadedCount} 条` : (xList.visiblePosts.length ? ` · ${xList.visiblePosts.length} 条动态` : '')}`;
      return `${context.pageLabel} · 当前页`;
    }
    if (rankingCount) return `${context.pageLabel} · 已选 ${context.rankingContext?.boards.length ?? 0} 个榜单、${context.rankingContext?.items.length ?? 0} 个项目`;
    if (context.focus) return `${context.pageLabel} · ${context.focus.title}${context.focus.bodyStatus === 'ready' ? ' · 含正文' : ''}`;
    const oppCount = context.selectedItems?.length ?? 0;
    const sourceCount = context.selectedSources?.length ?? 0;
    const bodyCount = context.selectedSources?.filter((item) => item.bodyStatus === 'ready' && item.bodyExcerpt).length ?? 0;
    const fermentCount = (context.fermenting?.items?.length ?? 0) + (context.fermenting?.watchingItems?.length ?? 0);
    if (oppCount || sourceCount || fermentCount) {
      const parts = [context.pageLabel];
      if (oppCount) parts.push(`已选 ${oppCount} 个机会`);
      if (sourceCount) parts.push(`${sourceCount} 条资料${bodyCount ? `（${bodyCount} 含正文）` : '（摘要）'}`);
      if (fermentCount) parts.push(`发酵 ${fermentCount}`);
      return parts.join(' · ');
    }
    return context.objectTitle ? `${context.pageLabel} · ${context.objectTitle}` : context.pageLabel;
  }, [context]);
  const xList = context.xListContext;
  const buildPayload = (text: string, directContext?: {scope:string;items:Array<{nodeId:string}>;relations:Array<{id:string}>;estimatedCharacters:number}) => {
    const selectedContext = context.selectedItems?.map((item) => ({
      id: item.id,
      title: item.title,
      whyNow: item.whyNow,
      angle: item.angle,
      pointOfView: item.pointOfView,
      titleGuidance: item.titleGuidance,
      openingGuidance: item.openingGuidance,
      structureGuidance: item.structureGuidance,
      sourceIds: item.sourceIds
    })) ?? [];
    const selectedSources = context.selectedSources?.map((source) => ({
      id: source.id,
      title: source.title,
      url: source.canonicalUrl,
      author: source.author,
      publishedAt: source.publishedAt,
      collectedAt: source.collectedAt,
      summary: source.summary,
      categories: source.categories,
      bodyStatus: source.bodyStatus ?? 'none',
      bodyChars: source.bodyChars ?? 0,
      bodyExcerpt: source.bodyExcerpt ?? null
    })) ?? [];
    const contextInstruction = directContext
      ? `\ncontextRule=只使用下面直接提供的页面上下文，不得调用上下文包工具，也不得扩展到选中范围之外。`
        + `\nmode=${context.packagePurpose??'discussion'}`
        + `\ncanvasId=${context.canvasId??''}`
        + `\nselectionMode=${context.contextSelection?.mode??'current_page'}`
        + `\nsuggestionRule=若要提出新节点或关系，只能调用 wmb_suggest_knowledge 创建待确认建议；用户确认前不得视为正式知识。`
        + `\ncontextNodeIds=${JSON.stringify(directContext.items.map(item=>item.nodeId))}`
        + `\ncontextManifest=${JSON.stringify(directContext)}`
      : xList
      ? `\ncontextRule=优先使用下面直接提供的 X List 页面上下文；用户没点帖子时讨论当前列表已加载的全部动态（loadedCount/visiblePosts），点了帖子时只讨论该帖及其评论。不要假设未加载的更早帖子。`
      : context.focus
      ? `\ncontextRule=focus 是用户当前正在看的对象。有 bodyExcerpt 时优先依据正文；否则用 summary。不要把摘要当成全文，也不要假设未提供的页面内容。`
      : selectedSources.length
      ? `\ncontextRule=selectedSources 是用户勾选的原始资料。默认只有摘要（summary）；bodyStatus=ready 且 bodyExcerpt 非空时才有正文摘录。selectedItems 是选题机会。fermenting 是跨日仍在发酵的机会/主题，优先考虑未消化的高价值续命项。回答优先引用 selectedSources 证据，不要把摘要当成全文。`
      : ((context.fermenting?.items?.length ?? 0) + (context.fermenting?.watchingItems?.length ?? 0))
      ? `\ncontextRule=fermenting.items 是仍值得做的跨日项；fermenting.watchingItems 是观察中项。都不是今日主清单。讨论时优先今日 selectedItems，再看发酵补充。`
      : '';
    const xListPayload = xList ? JSON.stringify({
      accountKey: xList.accountKey,
      listId: xList.listId,
      listName: xList.listName,
      listKind: xList.listKind,
      mode: xList.mode,
      loadedCount: xList.loadedCount ?? xList.visiblePosts.length,
      selectedPost: xList.selectedPost,
      visiblePosts: xList.visiblePosts
    }) : 'null';
    const fermentingPayload = JSON.stringify({
      items: (context.fermenting?.items ?? []).slice(0, 5).map((item) => ({
        id: item.id,
        objectType: item.objectType,
        objectId: item.objectId,
        title: item.title,
        state: item.state,
        priority: item.priority,
        topicId: item.topicId,
        sourceIds: item.sourceIds,
        originPlanDate: item.originPlanDate,
        fermentedDays: item.fermentedDays,
        decayScore: item.decayScore,
        reason: item.reason,
        aftershocks: (item.aftershocks || []).slice(0, 3)
      })),
      watchingItems: (context.fermenting?.watchingItems ?? []).slice(0, 5).map((item) => ({
        id: item.id,
        objectType: item.objectType,
        objectId: item.objectId,
        title: item.title,
        state: item.state,
        priority: item.priority,
        fermentedDays: item.fermentedDays,
        originPlanDate: item.originPlanDate
      })),
      topics: (context.fermenting?.topics ?? []).slice(0, 6),
      pinnedSources: (context.fermenting?.pinnedSources ?? []).slice(0, 3)
    });
    return `[WMB_CONTEXT]\npage=${context.page}\npageLabel=${context.pageLabel}\nobjectType=${context.objectType ?? ''}\nobjectId=${context.objectId ?? ''}\nobjectTitle=${context.objectTitle ?? ''}${contextInstruction}\nfocus=${JSON.stringify(context.focus ?? null)}\nselectedItems=${JSON.stringify(selectedContext)}\nselectedSources=${JSON.stringify(selectedSources)}\nfermenting=${fermentingPayload}\nrankingContext=${JSON.stringify(context.rankingContext ?? { boards: [], items: [] })}\nxListContext=${xListPayload}\n[USER_MESSAGE]\n${text}`;
  };

  const sendText = async (text: string, delivery?: 'steer' | 'followUp') => {
    const value = text.trim();
    if (!value) return;
    const queued = busy;
    if (!queued) {
      conversationTouched.current = true;
      const stamped = new Date().toISOString();
      setMessages((items) => [...items, { role: 'user', text: value, createdAt: stamped }, { role: 'assistant', text: '', status: 'streaming', createdAt: stamped }]);
      setPhase('starting'); setStatusText('正在连接 Pi');
    }
    try {
      const directContext = context.contextSelection?.nodeIds.length
        ? await window.wmb.previewKnowledgeContextPackage({ canvasId: context.contextSelection.canvasId, nodeIds: context.contextSelection.nodeIds })
        : undefined;
      const result = await window.wmb.chatPi(buildPayload(value, directContext), queued ? (delivery ?? 'steer') : undefined);
      if (result.queued) return;
      if (result.conversation) {
        setMessages(result.conversation.messages);
        setActiveSessionId(result.conversation.id || null);
      }
      setPhase(result.stopped ? 'stopped' : 'idle');
      setStatusText(result.stopped ? '已停止' : (configured ? '已配置' : '等待配置'));
      void refreshSessions();
    } catch (error) {
      const message = piErrorMessage(error);
      if (queued) { showToast(message); return; }
      setPhase('failed'); setStatusText('失败');
      setMessages((items) => {
        const next = items.slice();
        const last = next[next.length - 1];
        if (last?.role === 'assistant') next[next.length - 1] = { ...last, role: 'assistant', text: message, status: 'failed' };
        else next.push({ role: 'assistant', text: message, status: 'failed', createdAt: new Date().toISOString() });
        return next;
      });
    }
  };

  const send = useCallback(async (text: string, delivery?: 'steer' | 'followUp') => {
    const value = text.trim();
    if (!value) return;
    await sendText(value, delivery);
  }, [busy, configured, context]);
  useEffect(() => {
    const generate = (event: Event) => void sendText((event as CustomEvent<string>).detail);
    window.addEventListener('wmb-pi-generate', generate);
    return () => window.removeEventListener('wmb-pi-generate', generate);
  });
  const stop = useCallback(async () => {
    try {
      const result = await window.wmb.stopPi();
      if (result.stopped) setStatusText('正在停止');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '停止失败');
    }
  }, []);
  const newConversation = async () => {
    if (busy) await stop();
    conversationTouched.current = true;
    const conversation = await window.wmb.newPiConversation();
    setMessages(conversation.messages ?? []);
    setNativeQueue({ steering: [], followUp: [] });
    setActiveSessionId(conversation.id || null);
    setPhase('idle');
    setStatusText(configured ? '新会话' : '等待配置');
    setSessionMenuOpen(false);
    await refreshSessions();
  };
  const openSession = async (conversationId: string) => {
    if (!conversationId || conversationId === activeSessionId) {
      setSessionMenuOpen(false);
      return;
    }
    if (busy) await stop();
    conversationTouched.current = true;
    const conversation = await window.wmb.switchPiConversation(conversationId);
    setMessages(conversation.messages ?? []);
    setNativeQueue({ steering: [], followUp: [] });
    setActiveSessionId(conversation.id || conversationId);
    setPhase('idle');
    setStatusText(configured ? '已切换会话' : '等待配置');
    setSessionMenuOpen(false);
    await refreshSessions();
  };
  const copyMessage = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast('已复制');
    } catch {
      showToast('复制失败');
    }
  };
  const forkMessage = async (entryId: string, retry: boolean) => {
    if (busy) return;
    conversationTouched.current = true;
    try {
      const forked = await window.wmb.forkPiConversation(entryId);
      if (forked.cancelled) { showToast('Pi 未创建分支'); return; }
      setMessages(forked.conversation.messages);
      setNativeQueue({ steering: [], followUp: [] });
      setActiveSessionId(forked.conversation.id || null);
      setPhase('idle');
      setStatusText(configured ? '已创建 Pi 分支' : '等待配置');
      await refreshSessions();
      if (retry) await sendText(forked.text);
      else setDraftSeed(forked.text);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Pi 分叉失败');
    }
  };
  const activeTitle = sessions.find((item) => item.id === activeSessionId)?.title || 'Pi';

  return <aside className={`pi-dock${collapsed ? ' collapsed' : ''}`}>
    {!collapsed && <div className="pi-resize-handle" role="separator" aria-label="调整 Pi 对话栏宽度" aria-orientation="vertical" title="拖拽调整宽度，双击恢复默认" onPointerDown={resize} onDoubleClick={resetWidth}/>}
    <button type="button" className="pi-dock-toggle" onClick={toggle} aria-label={collapsed ? '展开 Pi' : '收起 Pi'} title={collapsed ? '展开 Pi' : '收起 Pi'}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d={collapsed ? 'M14.5 6.5 9 12l5.5 5.5' : 'M9.5 6.5 15 12l-5.5 5.5'} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"/></svg>
    </button>
    {!collapsed && <>
      <header className="pi-dock-header" ref={headerRef}>
        <div className="pi-dock-title-row">
          <button
            type="button"
            className={`pi-session-trigger${sessionMenuOpen ? ' open' : ''}`}
            onClick={() => {
              setSessionMenuOpen((open) => !open);
              void refreshSessions();
            }}
            aria-haspopup="listbox"
            aria-expanded={sessionMenuOpen}
            title="会话管理"
          >
            <strong>Pi</strong>
            <span className="pi-session-current" title={activeTitle}>{activeTitle === 'Pi' ? '会话' : activeTitle}</span>
            <em className="pi-session-caret" aria-hidden="true">▾</em>
          </button>
          <span data-phase={phase}>{statusText}</span>
          <button type="button" className="pi-icon-button pi-new-session" title="新会话" aria-label="新会话" onClick={() => void newConversation()}>＋</button>
        </div>
        {sessionMenuOpen && (
          <div className="pi-session-menu" role="listbox" aria-label="会话列表">
            <div className="pi-session-menu-head">
              <span>会话</span>
              <button type="button" onClick={() => void newConversation()}>新建</button>
            </div>
            <div className="pi-session-list">
              {sessions.length ? sessions.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  role="option"
                  aria-selected={session.id === activeSessionId}
                  className={session.id === activeSessionId ? 'active' : ''}
                  onClick={() => void openSession(session.id)}
                >
                  <strong>{session.title || '新会话'}</strong>
                  <span>{formatPiMessageTime(session.updatedAt) || session.preview}</span>
                  <small>{session.preview}</small>
                </button>
              )) : <p className="pi-session-empty">还没有历史会话</p>}
            </div>
          </div>
        )}
        <div className="pi-context-chip" title={`当前会带给 Pi 的对象：${contextChip}`}>
          <em>当前:</em>
          <span>{contextChip}</span>
        </div>
        {toast && <small className="pi-toast">{toast}</small>}
      </header>
      <PiDockTranscript
        messages={messages}
        queue={nativeQueue}
        busy={busy}
        configured={configured}
        statusText={statusText}
        conversationRef={conversationRef}
        onCopy={(text) => void copyMessage(text)}
        onFork={(entryId) => void forkMessage(entryId, false)}
        onRetry={(entryId) => void forkMessage(entryId, true)}
      />
      <PiComposer
        configured={configured}
        busy={busy}
        phase={phase}
        draftSeed={draftSeed}
        onDraftSeedConsumed={() => setDraftSeed(null)}
        onSend={(text, delivery) => { void send(text, delivery); }}
        onStop={() => { void stop(); }}
        modelLabel={modelLabel}
        thinkingChoice={thinkingChoice}
        modelMenuOpen={modelMenuOpen}
        modelMenuBusy={modelMenuBusy}
        modelChoice={modelChoice}
        modelOptions={modelOptions}
        onModelChoice={setModelChoice}
        onThinkingChoice={setThinkingChoice}
        onOpenModelMenu={() => { void openModelMenu(); }}
        onCloseModelMenu={() => setModelMenuOpen(false)}
        onApplyModel={() => { void applyModelChoice(); }}
      />
    </>}
  </aside>;
}
