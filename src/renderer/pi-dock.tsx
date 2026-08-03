import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PiContextRef } from './app-types';
import { PiDockTranscript, type PiDockMessage, type PiNativeQueue } from './pi-dock-transcript';
import { PiComposer } from './pi-composer';
import { PiDockHeader, type PiSessionItem } from './pi-dock-header';
import { appendPiStream, finishPiTool, piErrorMessage, piToolActivity, streamingToolSegment } from './pi-dock-utils';
export function PiDock({ collapsed, toggle, configured, context, resize, resetWidth }: {
  collapsed: boolean;
  toggle: () => void;
  configured: boolean;
  context: PiContextRef;
  resize: (event: React.PointerEvent<HTMLDivElement>) => void;
  resetWidth: () => void;
}): React.JSX.Element {
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
    if (event.type === 'tool') {
      setPhase('running'); setStatusText(piToolActivity(event.toolName));
      setMessages((items) => appendPiStream(items, streamingToolSegment(event.toolName, event.toolCallId, event.toolArgs)));
      return;
    }
    if (event.type === 'tool-result') {
      setMessages((items) => finishPiTool(items, event.toolCallId, event.toolResult, event.isError));
      return;
    }
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
      setMessages((items) => appendPiStream(items, { kind: 'thinking', text: event.text ?? '' }, { thinking: event.text ?? '' }));
      return;
    }
    if (event.type === 'delta') {
      setPhase('running'); setStatusText('正在回复');
      setMessages((items) => appendPiStream(items, { kind: 'text', text: event.text ?? '' }, { text: event.text ?? '' }));
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
      <PiDockHeader
        headerRef={headerRef}
        sessionMenuOpen={sessionMenuOpen}
        sessions={sessions}
        activeSessionId={activeSessionId}
        activeTitle={activeTitle}
        phase={phase}
        statusText={statusText}
        contextChip={contextChip}
        toast={toast}
        onToggleSessions={() => { setSessionMenuOpen((open) => !open); void refreshSessions(); }}
        onNewConversation={() => { void newConversation(); }}
        onOpenSession={(id) => { void openSession(id); }}
      />
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
