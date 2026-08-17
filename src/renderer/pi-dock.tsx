import { pageAuthoritySpec } from '../shared/page-authority';
import { ORCHESTRATION_SAFE_FIELDS, type OrchestrationSafeFields } from '../shared/orchestration-envelope';
import type { PiImageAttachmentPayload } from '../shared/pi-image-batch';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PiContextRef } from './app-types';
import { buildPiContextPayload, describePiContextChip, resolveStudioAnnotationBadge, type PiDirectCanvasContext } from './pi-context-payload';
import { PiDockTranscript, type PiDockMessage, type PiNativeQueue } from './pi-dock-transcript';
import { PiComposer, type PiSendOutcome } from './pi-composer';
import { PiDockHeader, type PiSessionItem } from './pi-dock-header';
import { appendPiStream, createPiLocalQueueItem, finishPiTool, mergePiConversationWithLive, piErrorMessage, piJobEventNotice, piToolActivity, prunePiLocalQueue, reconcilePiLocalQueue, streamingToolSegment, upsertPiJobNotice, type PiLocalQueueAttachment, type PiLocalQueueItem } from './pi-dock-utils';
/** WMB-5178：chatPi 编排派发结果（消费面类型；编排输入携带安全字段，dispatchId 由主进程生成）。 */
type OrchestratedChatPiResult = {
  queued: boolean;
  stopped: boolean;
  conversation: { id: string; messages: PiDockMessage[] } | null;
};
type DeferredImageQueue = Readonly<{
  localId: string;
  conversationId: string;
  projectId: string;
  message: string;
}>;
export function PiDock({ collapsed, toggle, configured, context, resize, resetWidth }: {
  collapsed: boolean;
  toggle: () => void;
  configured: boolean;
  context: PiContextRef;
  resize: (event: React.PointerEvent<HTMLDivElement>) => void;
  resetWidth: () => void;
}): React.JSX.Element {
  const [draftSeed, setDraftSeed] = useState<string | null>(null);
  const [draftRestore, setDraftRestore] = useState<{ text: string; requestId: string; attachments: readonly PiLocalQueueAttachment[] } | null>(null);
  const [messages, setMessages] = useState<PiDockMessage[]>([]);
  const [nativeQueue, setNativeQueue] = useState<PiNativeQueue>({ steering: [], followUp: [] });
  /** WMB-5204：忙时人工消息的 renderer 本地气泡与投递状态（瞬态，绝不持久化）。 */
  const [localQueue, setLocalQueue] = useState<PiLocalQueueItem[]>([]);
  /** 主进程工单生命周期的即时可见反馈；与 Pi 原生消息流分离，避免截断 tool-result。 */
  const [jobNotices, setJobNotices] = useState<PiDockMessage[]>([]);
  const [sessions, setSessions] = useState<PiSessionItem[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'starting' | 'running' | 'failed' | 'stopped'>('idle');
  const [statusText, setStatusText] = useState(configured ? '已配置' : '等待配置');
  /** 仅真 Pi 回合占用 busy；主管投影 tool-line 不得阻塞发送/队列。 */
  const [piTurnActive, setPiTurnActive] = useState(false);
  const conversationRef = useRef<HTMLDivElement | null>(null);
  const conversationTouched = useRef(false);
  const forkActionRef = useRef(false);
  const [forkAction, setForkAction] = useState<{ entryId: string; retry: boolean } | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  activeSessionIdRef.current = activeSessionId;
  const deferredImageDrainRef = useRef<string | null>(null);
  const busy = piTurnActive;
  useEffect(() => {
    setLocalQueue((items) => prunePiLocalQueue(messages, items));
  }, [messages]);


  useEffect(() => {
    const onFocusManager = () => {
      try { window.dispatchEvent(new CustomEvent('wmb:pi-dock-expand')); } catch { /* */ }
      setStatusText('主管任务进行中');
      void window.wmb.getPiConversation().then((conversation) => {
        conversationTouched.current = false;
        setMessages(conversation.messages ?? []);
        setActiveSessionId(conversation.id || null);
        requestAnimationFrame(() => { const el = conversationRef.current; if (el) el.scrollTop = el.scrollHeight; });
      }).catch(() => {});
    };
    window.addEventListener('wmb:focus-manager-dialog', onFocusManager as EventListener);
    return () => window.removeEventListener('wmb:focus-manager-dialog', onFocusManager as EventListener);
  }, []);

  const [modelLabel, setModelLabel] = useState('默认模型');
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelOptions, setModelOptions] = useState<Array<{ id: string; contextWindow?: number; maxTokens?: number }>>([]);
  const [modelMenuBusy, setModelMenuBusy] = useState(false);
  const [modelChoice, setModelChoice] = useState('');
  const [thinkingChoice, setThinkingChoice] = useState<'auto' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>('auto');
  const [activePiProfile, setActivePiProfile] = useState<{
    id: string; name: string; baseUrl: string; model: string; api: 'openai-responses' | 'openai-completions';
    thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'; contextWindow?: number; maxTokens?: number; configured: boolean; active: boolean;
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
  const showToast = (text: string) => { setToast(text); window.setTimeout(() => setToast(''), 1400); };

  useEffect(() => {
    if (!window.wmb.onDataChanged) return;
    return window.wmb.onDataChanged((event) => {
      if (!event?.scopes?.includes('agent')) return;
      if (event.reason && !String(event.reason).startsWith('manager.')) return;
      // 任意尚未持久化的 streaming thinking/text/tool 都由内存事件流权威保留；
      // 磁盘只替换更早消息，不能让后台 agent 刷新收走正在输出的正文。
      void window.wmb.getPiConversation().then((conversation) => {
        conversationTouched.current = false;
        setMessages((current) => mergePiConversationWithLive(conversation.messages ?? [], current));
        setActiveSessionId(conversation.id || null);
        requestAnimationFrame(() => { const el = conversationRef.current; if (el) el.scrollTop = el.scrollHeight; });
      }).catch(() => {});
    });
  }, []);

  useEffect(() => window.wmb.onPiEvent((event) => {
    if (event.type === 'fallback-try' || event.type === 'fallback') {
      if (event.type === 'fallback-try') {
        setPhase('starting');
        setStatusText(event.text || '正在降级到备用 AI 服务');
        showToast(event.text || '正在降级到备用 AI 服务');
      } else {
        setStatusText(event.text || '已切换备用 AI 服务');
        showToast(event.text || '已切换备用 AI 服务');
        if (typeof event.model === 'string' && event.model) setModelLabel(event.model);
        if (typeof event.profileName === 'string' && event.profileName) {
          setActivePiProfile((current) => current ? { ...current, name: event.profileName!, model: typeof event.model === 'string' ? event.model : current.model } : current);
        }
      }
      return;
    }
    if (event.scope !== 'dock') return;
    const managerSource = event.source === 'manager';
    if (event.type === 'job_event') {
      const notice = piJobEventNotice(event, new Date().toISOString());
      if (notice) {
        setJobNotices((items) => upsertPiJobNotice(items, notice));
        setStatusText(notice.text);
      }
      return;
    }
    if (event.type === 'starting') {
      if (managerSource) {
        setStatusText(event.text || '主管编排中');
        return;
      }
      setPiTurnActive(true);
      setPhase('starting'); setStatusText('正在连接 Pi');
      return;
    }
    if (event.type === 'running') {
      if (managerSource) {
        setStatusText(event.text || '主管编排中');
        return;
      }
      setPiTurnActive(true);
      setPhase('starting'); setStatusText('正在连接 Pi');
      return;
    }
    if (event.type === 'tool') {
      if (!managerSource) {
        setPiTurnActive(true);
        setPhase('running');
        setStatusText(piToolActivity(event.toolName));
      } else {
        setStatusText(piToolActivity(event.toolName));
      }
      setMessages((items) => appendPiStream(items, streamingToolSegment(event.toolName, event.toolCallId, event.toolArgs)));
      return;
    }
    if (event.type === 'tool-result') {
      setMessages((items) => finishPiTool(items, event.toolCallId, event.toolResult, event.isError));
      return;
    }
    if (event.type === 'queue') {
      const steering = event.steering ?? [];
      const followUp = event.followUp ?? [];
      const queue = { steering, followUp };
      setNativeQueue(queue);
      // WMB-5204：native 确认只升级本地用户气泡状态，正文留在主时间线等待 canonical 接管。
      setLocalQueue((items) => reconcilePiLocalQueue(queue, items));
      return;
    }
    if (event.type === 'queued') {
      setPiTurnActive(true);
      setPhase('running');
      setStatusText(event.delivery === 'followUp' ? '已加入下一轮' : '已加入插队队列');
      return;
    }
    if (event.type === 'thinking') {
      setPiTurnActive(true);
      setPhase('running'); setStatusText('正在输出');
      setMessages((items) => appendPiStream(items, { kind: 'thinking', text: event.text ?? '', streamKey: event.streamKey }, { thinking: event.text ?? '' }));
      return;
    }
    if (event.type === 'delta') {
      setPiTurnActive(true);
      setPhase('running'); setStatusText('正在回复');
      setMessages((items) => appendPiStream(items, { kind: 'text', text: event.text ?? '', streamKey: event.streamKey }, { text: event.text ?? '' }));
      return;
    }
    if (event.type === 'stopped') {
      if (managerSource) {
        setStatusText(event.text || '主管编排已结束');
        setMessages((items) => {
          const next = items.slice();
          const last = next[next.length - 1];
          const text = (event.text && event.text.trim()) || last?.text || '主管编排已结束。';
          if (last?.role === 'assistant' && last.status === 'streaming') {
            next[next.length - 1] = { ...last, role: 'assistant', text, status: 'stopped' };
          }
          return next;
        });
        return;
      }
      setPiTurnActive(false);
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
      if (managerSource) {
        setStatusText(event.error || '主管编排失败');
        return;
      }
      setPiTurnActive(false);
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
      if (managerSource) {
        // 主管投影结束不得清掉真 Pi 回合
        setStatusText(event.text || (configured ? '已配置' : '等待配置'));
        setMessages((items) => {
          const next = items.slice();
          const last = next[next.length - 1];
          if (last?.role === 'assistant' && last.status === 'streaming' && event.text) {
            next[next.length - 1] = {
              ...last,
              role: 'assistant',
              text: event.text,
              status: undefined,
              segments: [
                ...(last.segments || []).filter((segment) => segment.kind === 'tool'),
                { kind: 'text' as const, text: event.text }
              ]
            };
          }
          return next;
        });
        return;
      }
      setPiTurnActive(false);
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
    const modelMetadata = modelOptions.find((item) => item.id === modelChoice);
    setModelMenuBusy(true);
    try {
      await window.wmb.savePiConfig({
        id: activePiProfile.id,
        name: activePiProfile.name,
        baseUrl: activePiProfile.baseUrl,
        model: modelChoice,
        api: activePiProfile.api,
        thinking: thinkingChoice === 'auto' ? undefined : thinkingChoice,
        contextWindow: modelMetadata?.contextWindow ?? null,
        maxTokens: modelMetadata?.maxTokens ?? null
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

  const contextChip = useMemo(() => describePiContextChip(context), [context]);
  /** WMB-5207：发送时实际带入的批注数（与 payload 同一确定性预算函数，保证徽标与快照一致）。 */
  const annotationBadge = useMemo(() => resolveStudioAnnotationBadge(context), [context]);
  const pageSpec = useMemo(() => pageAuthoritySpec(context.page), [context.page]);
  const [authorityChip, setAuthorityChip] = useState(pageSpec?.chipLabel ?? '—');
  const [authorityTone, setAuthorityTone] = useState<'write' | 'readonly' | 'prepare'>(pageSpec?.chipTone ?? 'readonly');
  useEffect(() => {
    setAuthorityChip(pageSpec?.chipLabel ?? '—');
    setAuthorityTone(pageSpec?.chipTone ?? 'readonly');
  }, [pageSpec?.chipLabel, pageSpec?.chipTone]);
  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      try {
        const status = await window.wmb.getPiAuthorityStatus?.();
        if (cancelled || !status) return;
        if (status.chipLabel) setAuthorityChip(status.chipLabel);
        if (status.chipTone) setAuthorityTone(status.chipTone);
      } catch { /* ignore */ }
    };
    void pull();
    const timer = window.setInterval(() => { void pull(); }, 2500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [context.page, context.objectId, phase]);
  const buildPayload = (text: string, directContext?: PiDirectCanvasContext) =>
    buildPiContextPayload(context, text, directContext);

  const sendText = async (text: string, delivery?: 'steer' | 'followUp', orchestration?: OrchestrationSafeFields, attachments: readonly PiImageAttachmentPayload[] = [], batchRequestId?: string, draftImages: readonly PiLocalQueueAttachment[] = [], deferred?: DeferredImageQueue): Promise<boolean | PiSendOutcome> => {
    const value = text.trim();
    if (!value && attachments.length === 0) return false;
    // §7.1：编排派发前安全字段前置校验——任一缺失/为空即失败，该次任务不发送。
    if (orchestration && !ORCHESTRATION_SAFE_FIELDS.every((field) => orchestration[field]?.trim())) {
      showToast('任务信息不完整，未发送');
      return false;
    }
    const batchProjectId = context.focus?.studioDocument?.projectId ?? (context.page === 'studio' && context.objectType === 'project' ? context.objectId : null);
    if (attachments.length > 0 && !batchProjectId) {
      showToast('请先打开一个明确的创作项目，再发送图片。');
      return false;
    }
    const queued = piTurnActive;
    if (deferred && (queued || deferred.conversationId !== activeSessionId || deferred.projectId !== batchProjectId)) return false;
    // WMB-5311：忙时图片不进入 Pi native 字符串队列，也不创建批次；冻结原会话、项目、requestId、lane、正文和有序预览快照。
    if (attachments.length > 0 && queued && !orchestration) {
      if (!activeSessionId) {
        showToast('当前 Pi 会话尚未准备好，请稍后再发送图片。');
        return false;
      }
      try {
        const directContext = context.contextSelection?.nodeIds.length
          ? await window.wmb.validateKnowledgeSelectionManifest({ canvasId: context.contextSelection.canvasId, nodeIds: context.contextSelection.nodeIds })
          : undefined;
        if (directContext && directContext.excludedCount > 0) showToast(`已纳入 ${directContext.items.length} 项 · 未纳入 ${directContext.excludedCount} 项`);
        const queuedMessage = buildPayload(value || '请根据当前正文的语义，为这些图片选择合理的插入位置；不合适的图片不要硬塞。', directContext);
        const requestId = batchRequestId ?? crypto.randomUUID();
        const frozenImages = (draftImages.length ? draftImages : attachments.map((attachment, index): PiLocalQueueAttachment => ({
          id: `${requestId}-${index}`,
          ...attachment,
          previewUrl: ''
        }))).map((attachment) => ({ ...attachment }));
        const item = createPiLocalQueueItem(value, delivery ?? 'steer', {
          conversationId: activeSessionId,
          imageBatch: { projectId: batchProjectId!, requestId, message: queuedMessage, attachments: frozenImages }
        });
        setLocalQueue((items) => [...items, item]);
        return { accepted: true, retainAttachments: true };
      } catch (error) {
        showToast(piErrorMessage(error));
        return false;
      }
    }
    // WMB-5204：忙时人工输入立即投影为主时间线用户气泡；本地项只承载投递状态，不写入会话快照。
    let localId: string | undefined;
    if (queued && !orchestration) {
      const item = createPiLocalQueueItem(value, delivery ?? 'steer', { conversationId: activeSessionId });
      localId = item.localId;
      setLocalQueue((items) => [...items, item]);
    }
    if (!queued) {
      conversationTouched.current = true;
      const stamped = new Date().toISOString();
      setPiTurnActive(true);
      if (!orchestration) {
        setMessages((items) => {
          const next = items.slice();
          const last = next[next.length - 1];
          // 结束仍 streaming 的主管投影气泡，避免把用户话挂在假回合上
          if (last?.role === 'assistant' && last.status === 'streaming') {
            next[next.length - 1] = {
              ...last,
              status: undefined,
              text: last.text || '（后台编排继续，你可直接对话）'
            };
          }
          next.push({ role: 'user', text: value || '请根据当前正文语义合理安排这些图片。', createdAt: stamped });
          next.push({ role: 'assistant', text: '', status: 'streaming', createdAt: stamped });
          return next;
        });
      }
      setPhase('starting'); setStatusText(orchestration ? '正在安排主管' : '正在连接 Pi');
    }
    try {
      // WMB-5243：发送时才取后端冻结选择清单（服务端校验/去重/限长）；框选本身不发送、不建包。
      const directContext = deferred?.message
        ? undefined
        : context.contextSelection?.nodeIds.length
          ? await window.wmb.validateKnowledgeSelectionManifest({ canvasId: context.contextSelection.canvasId, nodeIds: context.contextSelection.nodeIds })
          : undefined;
      // WMB-5243：冻结包未纳入明示（重复/无效/限长裁剪后 Pi 实际只收到部分选中项）。
      if (directContext && directContext.excludedCount > 0) showToast(`已纳入 ${directContext.items.length} 项 · 未纳入 ${directContext.excludedCount} 项`);
      const contextualMessage = deferred?.message ?? buildPayload(value || '请根据当前正文的语义，为这些图片选择合理的插入位置；不合适的图片不要硬塞。', directContext);
      const chatInput = attachments.length > 0
        ? {
            message: contextualMessage,
            ...(deferred ? { delivery: delivery ?? 'steer' as const } : {}),
            requestId: batchRequestId ?? crypto.randomUUID(),
            projectId: batchProjectId!,
            attachments
          }
        : orchestration ? { message: contextualMessage, orchestration } : contextualMessage;
      const result = await window.wmb.chatPi(chatInput, queued ? (delivery ?? 'steer') : undefined);
      const batchFailed = attachments.length > 0 && result.batchStatus !== 'completed';
      if (result.queued) return true;
      // 忙时提交未被排队：消息已进会话/被直接处理，移除对应本地反馈项； deferred image item waits for drain outcome.
      if (localId && !deferred) setLocalQueue((items) => items.filter((item) => item.localId !== localId));
      if (result.conversation) {
        setMessages(result.conversation.messages);
        setActiveSessionId(result.conversation.id || null);
      }
      setPiTurnActive(false);
      setPhase(result.stopped ? 'stopped' : 'idle');
      setStatusText(result.stopped ? '已停止' : (configured ? '已配置' : '等待配置'));
      void refreshSessions();
      if (batchFailed) {
        showToast('图片批次未完成，图片仍保留在输入框。');
        return false;
      }
      if (!deferred && attachments.length > 0 && result.batchStatus === 'completed' && batchRequestId) {
        setLocalQueue((items) => items.filter((item) => item.imageBatch?.requestId !== batchRequestId));
      }
      return true;
    } catch (error) {
      const message = piErrorMessage(error);
      if (queued) {
        // WMB-5189：steer 派发被拒 → 本地项明确 failed + 既有 toast
        if (localId) setLocalQueue((items) => items.map((item) => item.localId === localId ? { ...item, status: 'failed' as const } : item));
        showToast(message);
        return false;
      }
      setPiTurnActive(false);
      setPhase('failed'); setStatusText('失败');
      setMessages((items) => {
        const next = items.slice();
        const last = next[next.length - 1];
        if (last?.role === 'assistant') next[next.length - 1] = { ...last, role: 'assistant', text: message, status: 'failed' };
        else next.push({ role: 'assistant', text: message, status: 'failed', createdAt: new Date().toISOString() });
        return next;
      });
      return false;
    }
  };

  const send = useCallback(async (text: string, delivery?: 'steer' | 'followUp', attachments?: readonly PiImageAttachmentPayload[], batchRequestId?: string, draftImages?: readonly PiLocalQueueAttachment[]) => {
    return sendText(text, delivery, undefined, attachments, batchRequestId, draftImages);
  }, [piTurnActive, configured, context, activeSessionId]);
  useEffect(() => {
    if (!configured || piTurnActive || phase !== 'idle' || deferredImageDrainRef.current) return;
    const projectId = context.focus?.studioDocument?.projectId ?? (context.page === 'studio' && context.objectType === 'project' ? context.objectId : null);
    const imageIndex = localQueue.findIndex((candidate) => {
      if (candidate.kind !== 'imageBatch' || candidate.status !== 'pending' || !candidate.imageBatch) return false;
      if (candidate.conversationId !== activeSessionId || candidate.imageBatch.projectId !== projectId) return false;
      return true;
    });
    if (imageIndex < 0) return;
    const item = localQueue[imageIndex];
    const batch = item.imageBatch;
    if (!batch || !item.conversationId) return;
    // Preserve FIFO across the existing native text lanes and local image lane.
    if (localQueue.slice(0, imageIndex).some((candidate) => candidate.conversationId === item.conversationId && (candidate.kind === 'imageBatch' || candidate.status === 'pending'))) return;
    const deferred: DeferredImageQueue = {
      localId: item.localId,
      conversationId: item.conversationId,
      projectId: batch.projectId,
      message: batch.message
    };
    deferredImageDrainRef.current = item.localId;
    setLocalQueue((items) => items.map((candidate) => candidate.localId === item.localId ? { ...candidate, status: 'accepted' as const } : candidate));
    void sendText(item.text, item.delivery, undefined, batch.attachments, batch.requestId, batch.attachments, deferred).then((outcome) => {
      const accepted = outcome !== false && (typeof outcome !== 'object' || outcome === null || outcome.accepted !== false);
      if (activeSessionIdRef.current !== item.conversationId) {
        if (accepted) for (const attachment of batch.attachments) if (attachment.previewUrl.startsWith('blob:')) URL.revokeObjectURL(attachment.previewUrl);
        return;
      }
      if (accepted) {
        for (const attachment of batch.attachments) if (attachment.previewUrl.startsWith('blob:')) URL.revokeObjectURL(attachment.previewUrl);
        setLocalQueue((items) => items.filter((candidate) => candidate.localId !== item.localId));
        return;
      }
      setLocalQueue((items) => items.map((candidate) => candidate.localId === item.localId ? { ...candidate, status: 'failed' as const } : candidate));
      setDraftRestore({ text: item.text, requestId: batch.requestId, attachments: batch.attachments });
    }).catch(() => {
      if (activeSessionIdRef.current !== item.conversationId) return;
      setLocalQueue((items) => items.map((candidate) => candidate.localId === item.localId ? { ...candidate, status: 'failed' as const } : candidate));
      setDraftRestore({ text: item.text, requestId: batch.requestId, attachments: batch.attachments });
    }).finally(() => {
      deferredImageDrainRef.current = null;
    });
  }, [configured, piTurnActive, phase, localQueue, activeSessionId, context]);

  useEffect(() => {
    const generate = (event: Event) => {
      const detail = (event as CustomEvent<string | { prompt: string; orchestration?: OrchestrationSafeFields }>).detail;
      if (typeof detail === 'string') { void sendText(detail); return; }
      if (detail?.orchestration) void sendText(detail.prompt, undefined, detail.orchestration);
      else void sendText(detail.prompt ?? '');
    };
    window.addEventListener('wmb-pi-generate', generate);
    return () => window.removeEventListener('wmb-pi-generate', generate);
  });
  const stop = useCallback(async () => {
    try {
      const result = await window.wmb.stopPi();
      if (result.stopped) setStatusText('正在停止');
      else if (!piTurnActive) setPhase('idle'), setStatusText(configured ? '已配置' : '等待配置'); // 无真回合时收投影态
    } catch (error) {
      showToast(error instanceof Error ? error.message : '停止失败');
    }
  }, [piTurnActive, configured]);
  const discardLocalQueue = () => {
    for (const item of localQueue) for (const attachment of item.imageBatch?.attachments ?? []) if (attachment.previewUrl.startsWith('blob:')) URL.revokeObjectURL(attachment.previewUrl);
    activeSessionIdRef.current = null;
    deferredImageDrainRef.current = null;
    setLocalQueue([]);
    setDraftRestore(null);
  };
  const newConversation = async () => {
    if (busy) await stop();
    discardLocalQueue();
    conversationTouched.current = true;
    const conversation = await window.wmb.newPiConversation();
    setMessages(conversation.messages ?? []);
    setNativeQueue({ steering: [], followUp: [] }); setJobNotices([]);
    setActiveSessionId(conversation.id || null);
    setPhase('idle');
    setStatusText(configured ? '新会话' : '等待配置');
    setSessionMenuOpen(false);
    await refreshSessions();
  };
  const openSession = async (conversationId: string) => {
    if (!conversationId || conversationId === activeSessionId) { setSessionMenuOpen(false); return; }
    if (busy) await stop();
    discardLocalQueue();
    conversationTouched.current = true;
    const conversation = await window.wmb.switchPiConversation(conversationId);
    setMessages(conversation.messages ?? []);
    setNativeQueue({ steering: [], followUp: [] }); setJobNotices([]);
    setActiveSessionId(conversation.id || conversationId);
    setPhase('idle');
    setStatusText(configured ? '已切换会话' : '等待配置');
    setSessionMenuOpen(false);
    await refreshSessions();
  };
  const archiveSession = async (conversationId: string, archived: boolean) => { if (busy) { showToast('Pi 正在回复，完成或停止后再归档'); return; }
    try {
      conversationTouched.current = true; const selected = await window.wmb.archivePiConversation(conversationId, archived);
      if (archived && conversationId === activeSessionId) { discardLocalQueue(); setMessages(selected.messages ?? []); setNativeQueue({ steering: [], followUp: [] }); setJobNotices([]); setActiveSessionId(selected.id || null);
        setPhase('idle'); setStatusText(configured ? '已切换会话' : '等待配置');
      }
      await refreshSessions(); showToast(archived ? '会话已归档' : '会话已恢复');
    } catch (error) { showToast(error instanceof Error ? error.message : (archived ? '归档失败' : '恢复失败')); }
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
    if (busy || forkActionRef.current) return;
    forkActionRef.current = true; setForkAction({ entryId, retry });
    setStatusText(retry ? '正在重新发送' : '正在创建新对话');
    conversationTouched.current = true;
    try {
      const forked = await window.wmb.forkPiConversation(entryId);
      setMessages(forked.conversation.messages);
      discardLocalQueue(); setNativeQueue({ steering: [], followUp: [] }); setJobNotices([]);
      setActiveSessionId(forked.conversation.id || null);
      setPhase('idle'); setStatusText(configured ? '已创建新对话' : '等待配置');
      await refreshSessions();
      if (retry) await sendText(forked.text);
      else setDraftSeed(forked.text);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '创建新对话失败');
      setStatusText(configured ? '已配置' : '等待配置');
    } finally {
      forkActionRef.current = false; setForkAction(null);
    }
  };
  const activeTitle = sessions.find((item) => item.id === activeSessionId)?.title || 'Pi';

  return <aside className={`pi-dock${collapsed ? ' collapsed' : ''}`}>
    {!collapsed && <div className="pi-resize-handle" role="separator" aria-label="调整 Pi 对话栏宽度" aria-orientation="vertical" title="拖拽调整宽度，双击恢复默认" onPointerDown={resize} onDoubleClick={resetWidth}/>}
    <div className={`pi-dock-toggle-rail${collapsed ? ' is-collapsed' : ''}`} data-collapsed={collapsed ? 'true' : 'false'}>
      <button type="button" className="pi-dock-toggle" onClick={(event) => { toggle(); if (event.detail > 0) event.currentTarget.blur(); }} aria-label={collapsed ? '展开 Pi' : '收起 Pi'} title={collapsed ? '展开 Pi' : '收起 Pi'}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d={collapsed ? 'M14.5 6.5 9 12l5.5 5.5' : 'M9.5 6.5 15 12l-5.5 5.5'} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </button>
    </div>
    {!collapsed && <>
      <PiDockHeader headerRef={headerRef} sessionMenuOpen={sessionMenuOpen} sessions={sessions}
        activeSessionId={activeSessionId} activeTitle={activeTitle} phase={phase} statusText={statusText}
        contextChip={contextChip} authorityChip={authorityChip} authorityTone={authorityTone} toast={toast}
        onToggleSessions={() => { setSessionMenuOpen((open) => !open); void refreshSessions(); }}
        onNewConversation={() => { void newConversation(); }} onOpenSession={(id) => { void openSession(id); }} onArchiveSession={(id, archived) => { void archiveSession(id, archived); }} busy={busy}
      />
      <PiDockTranscript
        messages={messages}
        jobNotices={jobNotices}
        queue={nativeQueue}
        localQueue={localQueue}
        busy={busy || Boolean(forkAction)}
        pendingAction={forkAction}
        configured={configured}
        connecting={phase === 'starting'}
        statusText={statusText}
        conversationRef={conversationRef}
        conversationId={activeSessionId}
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
        draftRestore={draftRestore}
        onDraftRestoreConsumed={() => setDraftRestore(null)}
        annotationBadge={annotationBadge}
        onSend={(text, delivery, attachments, batchRequestId, draftImages) => send(text, delivery, attachments, batchRequestId, draftImages)}
        onStop={() => { void stop(); }}
        modelLabel={modelLabel}
        thinkingChoice={thinkingChoice}
        modelMenuOpen={modelMenuOpen}
        modelMenuBusy={modelMenuBusy}
        modelChoice={modelChoice}
        modelOptions={modelOptions.map((item) => item.id)}
        onModelChoice={setModelChoice}
        onThinkingChoice={setThinkingChoice}
        onOpenModelMenu={() => { void openModelMenu(); }}
        onCloseModelMenu={() => setModelMenuOpen(false)}
        onApplyModel={() => { void applyModelChoice(); }}
      />
    </>}
  </aside>;
}
