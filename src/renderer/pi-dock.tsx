import { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { PiContextRef } from './app-types';
function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, {
    async: false,
    gfm: true,
    breaks: true
  }) as string);
}

function formatPiMessageTime(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date);
}

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

export function PiDock({ collapsed, toggle, configured, context, resize, resetWidth }: {
  collapsed: boolean;
  toggle: () => void;
  configured: boolean;
  context: PiContextRef;
  resize: (event: React.PointerEvent<HTMLDivElement>) => void;
  resetWidth: () => void;
}): React.JSX.Element {
  type PiMessage = { role: 'user' | 'assistant'; text: string; status?: 'streaming' | 'stopped' | 'failed'; createdAt?: string };
  type PiSessionItem = { id: string; title: string; preview: string; createdAt: string; updatedAt: string; active: boolean };
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<PiMessage[]>([]);
  const [sessions, setSessions] = useState<PiSessionItem[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'starting' | 'running' | 'failed' | 'stopped'>('idle');
  const [statusText, setStatusText] = useState(configured ? '已配置' : '等待配置');
  const conversationRef = useRef<HTMLDivElement | null>(null);
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
    api: 'openai-responses' | 'openai-completions' | 'anthropic-messages';
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
  }, [messages, phase]);

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
    if (event.type === 'starting') { setPhase('starting'); setStatusText('正在连接 Pi'); return; }
    if (event.type === 'running') { setPhase('running'); setStatusText('正在思考'); return; }
    if (event.type === 'tool') { setPhase('running'); setStatusText(piToolActivity(event.toolName)); return; }
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
        if (last?.role === 'assistant') next[next.length - 1] = { ...last, role: 'assistant', text, status: 'stopped' };
        else next.push({ role: 'assistant', text, status: 'stopped', createdAt: new Date().toISOString() });
        return next;
      });
      return;
    }
    if (event.type === 'failed') {
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
      setPhase('idle'); setStatusText(configured ? '已配置' : '等待配置');
      setMessages((items) => {
        const next = items.slice();
        const last = next[next.length - 1];
        if (last?.role === 'assistant' && last.status === 'streaming') next[next.length - 1] = { ...last, role: 'assistant', text: event.text || last.text, status: undefined };
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
  const rankingCount = (context.rankingContext?.boards.length ?? 0) + (context.rankingContext?.items.length ?? 0);
  const contextChip = context.contextSelection
    ? `${context.pageLabel} · ${context.contextSelection.mode==='selected'?`已选 ${context.contextSelection.nodeIds.length} 项`:`当前页 ${context.contextSelection.nodeIds.length} 项`}`
    : rankingCount
    ? `${context.pageLabel} · 已选 ${context.rankingContext?.boards.length ?? 0} 个榜单、${context.rankingContext?.items.length ?? 0} 个项目`
    : context.objectTitle
    ? context.selectedItems?.length
      ? `${context.pageLabel} · 已选 ${context.selectedItems.length} 个机会`
      : `${context.pageLabel} · ${context.objectTitle}`
    : context.pageLabel;
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
    const contextInstruction = directContext
      ? `\ncontextRule=只使用下面直接提供的页面上下文，不得调用上下文包工具，也不得扩展到选中范围之外。`
        + `\nmode=${context.packagePurpose??'discussion'}`
        + `\ncanvasId=${context.canvasId??''}`
        + `\nselectionMode=${context.contextSelection?.mode??'current_page'}`
        + `\nsuggestionRule=若要提出新节点或关系，只能调用 wmb_suggest_knowledge 创建待确认建议；用户确认前不得视为正式知识。`
        + (context.packagePurpose==='creation'?`\nbriefRule=这次要形成可编辑简报；必须调用 wmb_create_creative_brief，传入 canvasId、contextNodeIds 和 selectionMode，证据不得超出 contextNodeIds；保存后回读结果，不要直接生成正文。`:'')
        + `\ncontextNodeIds=${JSON.stringify(directContext.items.map(item=>item.nodeId))}`
        + `\ncontextManifest=${JSON.stringify(directContext)}`
      : '';
    return `[WMB_CONTEXT]\npage=${context.page}\npageLabel=${context.pageLabel}\nobjectType=${context.objectType ?? ''}\nobjectId=${context.objectId ?? ''}\nobjectTitle=${context.objectTitle ?? ''}${contextInstruction}\nselectedItems=${JSON.stringify(selectedContext)}\nrankingContext=${JSON.stringify(context.rankingContext ?? { boards: [], items: [] })}\n[USER_MESSAGE]\n${text}`;
  };

  const sendText = async (text: string, opts?: { replaceFrom?: number }) => {
    const value = text.trim();
    if (!value || busy) return;
    const stamped = new Date().toISOString();
    if (opts?.replaceFrom !== undefined) {
      setMessages((items) => items.slice(0, opts.replaceFrom).concat([
        { role: 'user', text: value, createdAt: stamped },
        { role: 'assistant', text: '', status: 'streaming', createdAt: stamped }
      ]));
    } else {
      setMessages((items) => [...items, { role: 'user', text: value, createdAt: stamped }, { role: 'assistant', text: '', status: 'streaming', createdAt: stamped }]);
    }
    setPhase('starting'); setStatusText('正在连接 Pi');
    try {
      const directContext=context.contextSelection?.nodeIds.length
        ? await window.wmb.previewKnowledgeContextPackage({canvasId:context.contextSelection.canvasId,nodeIds:context.contextSelection.nodeIds})
        : undefined;
      const result = await window.wmb.chatPi(buildPayload(value,directContext));
      setMessages((items) => {
        const next = items.slice();
        const last = next[next.length - 1];
        if (last?.role === 'assistant') next[next.length - 1] = { ...last, role: 'assistant', text: result.text || last.text, status: result.stopped ? 'stopped' : undefined };
        return next;
      });
      setPhase(result.stopped ? 'stopped' : 'idle');
      setStatusText(result.stopped ? '已停止' : (configured ? '已配置' : '等待配置'));
      void refreshSessions();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    await sendText(text);
  };
  useEffect(()=>{
    const generate=(event:Event)=>void sendText((event as CustomEvent<string>).detail);
    window.addEventListener('wmb-pi-generate',generate);
    return()=>window.removeEventListener('wmb-pi-generate',generate);
  });
  const stop = async () => { try { await window.wmb.stopPi(); } catch {} };
  const newConversation = async () => {
    if (busy) await stop();
    const conversation = await window.wmb.newPiConversation();
    setMessages(conversation.messages ?? []);
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
    const conversation = await window.wmb.switchPiConversation(conversationId);
    setMessages(conversation.messages ?? []);
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
  const recallMessage = (index: number) => {
    if (busy) return;
    setMessages((items) => items.slice(0, index));
    showToast('已撤回');
  };
  const resendMessage = async (index: number) => {
    const target = messages[index];
    if (!target) return;
    if (target.role === 'user') {
      await sendText(target.text, { replaceFrom: index });
      return;
    }
    let userIndex = -1;
    for (let i = index - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === 'user') { userIndex = i; break; }
    }
    if (userIndex < 0) return;
    await sendText(messages[userIndex].text, { replaceFrom: userIndex });
  };
  const activeTitle = sessions.find((item) => item.id === activeSessionId)?.title || 'Pi';

  return <aside className={`pi-dock${collapsed ? ' collapsed' : ''}`}>
    {!collapsed && <div className="pi-resize-handle" role="separator" aria-label="调整 Pi 对话栏宽度" aria-orientation="vertical" title="拖拽调整宽度，双击恢复默认" onPointerDown={resize} onDoubleClick={resetWidth}/>}
    <button className="pi-dock-toggle" onClick={toggle} aria-label={collapsed ? '展开 Pi' : '收起 Pi'}>{collapsed ? '‹' : '›'}</button>
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
      <div className="pi-conversation" ref={conversationRef}>
        {messages.length ? <>
          {messages.map((message, index) => {
            const timeLabel = formatPiMessageTime(message.createdAt);
            const showActions = Boolean(message.text) && message.status !== 'streaming';
            return (
              <div className={`pi-bubble-wrap ${message.role}`} key={`${message.role}-${index}-${message.createdAt ?? ''}-${message.text.slice(0, 12)}`}>
                {message.role === 'assistant'
                  ? message.status === 'streaming' && !message.text
                    ? <div className="assistant pi-bubble streaming pi-activity" role="status" aria-live="polite">
                        <span className="pi-activity-mark" aria-hidden="true"><i /></span>
                        <span className="pi-activity-copy"><strong>{statusText}</strong><small>Pi 正在继续处理</small></span>
                      </div>
                    : <div className={`assistant pi-bubble${message.status ? ` ${message.status}` : ''}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(message.text) }} />
                  : <p className="user pi-bubble">{message.text}</p>}
                <div className="pi-bubble-meta">
                  <time className="pi-bubble-time">{timeLabel || (message.status === 'streaming' ? '发送中' : '')}</time>
                  <div className="pi-bubble-actions" aria-hidden={showActions ? undefined : true} style={showActions ? undefined : { visibility: 'hidden' }}>
                    <button type="button" title="复制" aria-label="复制" disabled={!showActions} onClick={() => void copyMessage(message.text)}>
                      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/></svg>
                    </button>
                    <button type="button" title="撤回" aria-label="撤回" disabled={!showActions || busy} onClick={() => recallMessage(index)}>
                      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 1 1 0 12h-3"/></svg>
                    </button>
                    <button type="button" title="重发" aria-label="重发" disabled={!showActions || busy || !configured} onClick={() => void resendMessage(index)}>
                      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.3"/><path d="M21 3v6h-6"/></svg>
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
          <div className="pi-conversation-end-spacer" aria-hidden="true" />
        </> : <p className="pi-empty">{configured ? '现在可以直接和我对话。' : '请先在设置中填写 Pi API。'}</p>}
      </div>
      <footer className="pi-dock-footer">
        {modelMenuOpen && <div className="pi-model-menu" role="dialog" aria-label="选择模型和推理强度">
          <div className="pi-model-menu-head"><strong>模型与推理</strong><button type="button" onClick={() => setModelMenuOpen(false)}>×</button></div>
          <label><span>模型</span><select disabled={modelMenuBusy} value={modelChoice} onChange={(event) => setModelChoice(event.target.value)}>
            {modelOptions.length ? modelOptions.map((model) => <option key={model} value={model}>{model}</option>) : <option value={modelChoice}>{modelMenuBusy ? '正在读取模型…' : modelChoice || '没有可用模型'}</option>}
          </select></label>
          <label><span>推理强度</span><select disabled={modelMenuBusy} value={thinkingChoice} onChange={(event) => setThinkingChoice(event.target.value as typeof thinkingChoice)}>
            <option value="auto">自动</option><option value="off">关闭</option><option value="minimal">极简</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="xhigh">很高</option><option value="max">最高</option>
          </select></label>
          <button type="button" className="primary-button" disabled={modelMenuBusy || !modelChoice} onClick={() => void applyModelChoice()}>{modelMenuBusy ? '读取中…' : '应用到新回复'}</button>
        </div>}
        <div className="pi-composer">
          <textarea
            disabled={!configured || busy}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }}
            placeholder={configured ? (busy ? 'Pi 正在回复…' : phase === 'failed' ? '失败后可以直接重试' : phase === 'stopped' ? '已停止，可以继续发送' : '给 Pi 发消息') : '配置 Pi API 后可以对话'}
          />
          <div className="pi-composer-bar">
            <div className="pi-composer-tools">
              <button type="button" className="pi-icon-button" title="插入图片（即将支持）" aria-label="插入图片" disabled>
                <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m21 15-4.5-4.5L9 18"/></svg>
              </button>
              <button type="button" className="pi-icon-button" title="附件（即将支持）" aria-label="附件" disabled>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21.44 11.05-8.49 8.49a5.5 5.5 0 0 1-7.78-7.78l8.49-8.49a3.5 3.5 0 0 1 4.95 4.95l-8.49 8.49a1.5 1.5 0 0 1-2.12-2.12l7.78-7.78"/></svg>
              </button>
              <button type="button" className="pi-icon-button" title={busy ? '停止生成' : '新会话'} aria-label={busy ? '停止生成' : '新会话'} onClick={() => void (busy ? stop() : newConversation())}>
                {busy
                  ? <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>
                  : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>}
              </button>
            </div>
            <div className="pi-composer-meta">
              <button type="button" className={`pi-model-trigger${modelMenuOpen ? ' open' : ''}`} title="选择模型和推理强度" onClick={() => void openModelMenu()}><span>{modelLabel}</span><small>{thinkingChoice === 'auto' ? '自动' : thinkingChoice}</small><b>▾</b></button>
              <button type="button" className="pi-send-button" disabled={!configured || busy || !input.trim()} onClick={() => void send()}>{busy ? '…' : '发送'}</button>
            </div>
          </div>
        </div>
      </footer>
    </>}
  </aside>;
}
