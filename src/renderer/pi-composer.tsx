import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { PiCommand } from '../main/pi-commands';
import { filterPiCommands, insertPiCommand } from './pi-command-filter';
import { MAX_PI_IMAGE_ATTACHMENTS, MAX_PI_IMAGE_BYTES, MAX_PI_IMAGE_TOTAL_BYTES } from '../shared/pi-image-batch';
import type { PiImageAttachmentPayload, PiImageMimeType } from '../shared/pi-image-batch';
import type { PiLocalQueueAttachment } from './pi-dock-utils';

const SOURCE_LABEL: Record<PiCommand['source'], string> = {
  skill: 'Skill',
  prompt: '提示模板',
  extension: '扩展命令'
};
type QueuedImage = {
  id: string;
  fileName: string;
  mimeType: PiImageMimeType;
  byteCount: number;
  width: number | null;
  height: number | null;
  dataBase64: string;
  previewUrl: string;
  state: 'ready' | 'reading' | 'error';
  error?: string;
};

const IMAGE_MIME_BY_EXTENSION: Record<string, PiImageMimeType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
};

const imageMimeType = (file: File): PiImageMimeType | null => {
  if (file.type in { 'image/png': true, 'image/jpeg': true, 'image/webp': true, 'image/gif': true }) return file.type as PiImageMimeType;
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_MIME_BY_EXTENSION[extension] ?? null;
};

const base64FromBuffer = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  return btoa(binary);
};

const imageDimensions = (url: string): Promise<{ width: number; height: number }> => {
  const { promise, resolve, reject } = Promise.withResolvers<{ width: number; height: number }>();
  const image = new Image();
  image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
  image.onerror = () => reject(new Error('无法读取图片尺寸'));
  image.src = url;
  return promise;
};

export type PiSendOutcome = Readonly<{
  accepted: boolean;
  retainAttachments?: boolean;
}>;

export const PiComposer = memo(function PiComposer({
  configured,
  busy,
  phase,
  draftSeed,
  onDraftSeedConsumed,
  draftRestore,
  onDraftRestoreConsumed,
  annotationBadge,
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
  draftRestore: { text: string; requestId: string; attachments: readonly PiLocalQueueAttachment[] } | null;
  onDraftRestoreConsumed: () => void;
  /** WMB-5207：发送时实际带入的批注数；null 表示无批注，不显示徽标。 */
  annotationBadge: { included: number; omitted: number } | null;
  onSend: (text: string, delivery?: 'steer' | 'followUp', attachments?: readonly PiImageAttachmentPayload[], batchRequestId?: string, draftImages?: readonly PiLocalQueueAttachment[]) => void | boolean | PiSendOutcome | Promise<void | boolean | PiSendOutcome>;
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
  const [commands, setCommands] = useState<PiCommand[]>([]);
  const [commandLoading, setCommandLoading] = useState(false);
  const [commandError, setCommandError] = useState('');
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  const [activeCommand, setActiveCommand] = useState(0);
  const [attachments, setAttachments] = useState<QueuedImage[]>([]);
  const [queueError, setQueueError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [sending, setSending] = useState(false);
  const [batchRequestId, setBatchRequestId] = useState<string | null>(null);
  const textHistoryRef = useRef<string[]>([]);
  const historyCursorRef = useRef<number | null>(null);
  const historyDraftRef = useRef('');

  const resetHistoryBrowsing = () => {
    historyCursorRef.current = null;
  };
  const browseHistory = (direction: -1 | 1): boolean => {
    const history = textHistoryRef.current;
    const current = historyCursorRef.current;
    if (current === null) {
      if (direction !== -1 || history.length === 0) return false;
      historyDraftRef.current = input;
      historyCursorRef.current = history.length - 1;
    } else {
      const next = current + direction;
      if (next >= history.length) {
        historyCursorRef.current = null;
        setInput(historyDraftRef.current);
        return true;
      }
      historyCursorRef.current = Math.max(0, next);
    }
    const index = historyCursorRef.current;
    if (index === null) return true;
    setInput(history[index]);
    return true;
  };
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const paletteRef = useRef<HTMLDivElement | null>(null);
  const paletteOpen = configured && !paletteDismissed && /^\/[^\s]*$/.test(input);
  const filteredCommands = useMemo(() => filterPiCommands(commands, input), [commands, input]);

  useEffect(() => {
    if (draftSeed == null) return;
    resetHistoryBrowsing();
    setInput(draftSeed);
    setPaletteDismissed(false);
    onDraftSeedConsumed();
  }, [draftSeed, onDraftSeedConsumed]);
  useEffect(() => {
    if (!draftRestore) return;
    if (!input.trim() && attachments.length === 0) {
      resetHistoryBrowsing();
      setInput(draftRestore.text);
      setAttachments(draftRestore.attachments.map((entry): QueuedImage => ({
        ...entry,
        dataBase64: entry.bytesBase64,
        width: entry.width ?? null,
        height: entry.height ?? null,
        state: 'ready'
      })));
      setBatchRequestId(draftRestore.requestId);
      setPaletteDismissed(false);
      setQueueError('图片批次失败，原提交仍保留，可重试。');
    }
    onDraftRestoreConsumed();
  }, [draftRestore, onDraftRestoreConsumed]);

  useEffect(() => {
    if (!paletteOpen) return;
    let current = true;
    setCommandLoading(true);
    setCommandError('');
    setActiveCommand(0);
    void window.wmb.listPiCommands().then((items) => {
      if (current) setCommands(items);
    }).catch((error: unknown) => {
      if (!current) return;
      const raw = error instanceof Error ? error.message : String(error);
      setCommandError(raw.replace(/^Error invoking remote method '[^']+':\s*/i, '').replace(/^Error:\s*/i, '').trim() || '读取 Pi 命令失败。');
      setCommands([]);
    }).finally(() => {
      if (current) setCommandLoading(false);
    });
    return () => { current = false; };
  }, [paletteOpen]);
  useEffect(() => {
    const focusComposer = () => textareaRef.current?.focus();
    window.addEventListener('wmb:pi-composer-focus', focusComposer);
    return () => window.removeEventListener('wmb:pi-composer-focus', focusComposer);
  }, []);

  useEffect(() => setActiveCommand(0), [input]);
  useEffect(() => {
    paletteRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeCommand]);

  const addFiles = (files: readonly File[]) => {
    if (!files.length) return;
    setBatchRequestId(null);
    setQueueError('');
    const currentBytes = attachments.reduce((total, item) => total + item.byteCount, 0);
    let nextBytes = currentBytes;
    let accepted = 0;
    for (const file of files) {
      if (attachments.length + accepted >= MAX_PI_IMAGE_ATTACHMENTS) { setQueueError(`最多添加 ${MAX_PI_IMAGE_ATTACHMENTS} 张图片。`); break; }
      const mimeType = imageMimeType(file);
      if (!mimeType) { setQueueError(`${file.name} 不是支持的 PNG、JPEG、WebP 或 GIF。`); continue; }
      if (!file.size || file.size > MAX_PI_IMAGE_BYTES) { setQueueError(`${file.name} 超过单张图片大小限制（20 MB）。`); continue; }
      if (nextBytes + file.size > MAX_PI_IMAGE_TOTAL_BYTES) { setQueueError('本批图片总大小不能超过 80 MB。'); break; }
      const id = crypto.randomUUID();
      const previewUrl = URL.createObjectURL(file);
      const item: QueuedImage = { id, fileName: file.name, mimeType, byteCount: file.size, width: null, height: null, dataBase64: '', previewUrl, state: 'reading' };
      accepted += 1;
      nextBytes += file.size;
      setAttachments((current) => [...current, item]);
      void (async () => {
        try {
          const buffer = await file.arrayBuffer();
          const dimensions = await imageDimensions(previewUrl);
          const bytesBase64 = base64FromBuffer(buffer);
          setAttachments((current) => current.map((entry) => entry.id === id ? { ...entry, width: dimensions.width, height: dimensions.height, dataBase64: bytesBase64, state: 'ready' } : entry));
        } catch (error) {
          const message = error instanceof Error ? error.message : '图片读取失败';
          setAttachments((current) => current.map((entry) => entry.id === id ? { ...entry, state: 'error', error: message } : entry));
        }
      })();
    }
  };
  const removeFile = (id: string) => {
    setBatchRequestId(null);
    setAttachments((current) => {
      const removed = current.find((entry) => entry.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((entry) => entry.id !== id);
    });
  };
  const moveFile = (id: string, direction: -1 | 1) => {
    setBatchRequestId(null);
    setAttachments((current) => {
      const index = current.findIndex((entry) => entry.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = current.slice();
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };
  const sendCurrent = (delivery?: 'steer' | 'followUp') => {
    const text = input.trim();
    if ((!text && !attachments.length) || (sending && !busy)) return;
    if (attachments.some((entry) => entry.state !== 'ready')) { setQueueError('请等待图片读取完成，或移除读取失败的图片。'); return; }
    const frozenAttachments = attachments.map((entry): PiImageAttachmentPayload => ({ fileName: entry.fileName, mimeType: entry.mimeType, bytesBase64: entry.dataBase64, byteCount: entry.byteCount, width: entry.width, height: entry.height }));
    const frozenDraftImages = attachments.map((entry): PiLocalQueueAttachment => ({
      id: entry.id,
      fileName: entry.fileName,
      mimeType: entry.mimeType,
      bytesBase64: entry.dataBase64,
      byteCount: entry.byteCount,
      width: entry.width,
      height: entry.height,
      previewUrl: entry.previewUrl
    }));
    const requestId = attachments.length > 0 ? (batchRequestId ?? crypto.randomUUID()) : undefined;
    if (requestId) setBatchRequestId(requestId);
    resetHistoryBrowsing();
    setSending(true);
    setInput('');
    setPaletteDismissed(false);
    void Promise.resolve(onSend(text, delivery, frozenAttachments, requestId, frozenDraftImages)).then((acceptedResult) => {
      const accepted = acceptedResult !== false && (typeof acceptedResult !== 'object' || acceptedResult === null || acceptedResult.accepted !== false);
      if (!accepted) { setInput((current) => current.trim() ? current : text); return; }
      if (text && textHistoryRef.current[textHistoryRef.current.length - 1] !== text) textHistoryRef.current.push(text);
      resetHistoryBrowsing();
      const retainAttachments = typeof acceptedResult === 'object' && acceptedResult !== null && acceptedResult.retainAttachments === true;
      if (!retainAttachments) for (const entry of attachments) URL.revokeObjectURL(entry.previewUrl);
      const submittedIds = new Set(frozenDraftImages.map((entry) => entry.id));
      setAttachments((current) => current.filter((entry) => !submittedIds.has(entry.id)));
      setBatchRequestId(null);
      setQueueError('');
    }).catch(() => setInput((current) => current.trim() ? current : text)).finally(() => setSending(false));
  };

  const chooseCommand = (command: PiCommand) => {
    resetHistoryBrowsing();
    setInput(insertPiCommand(command));
    setPaletteDismissed(true);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  return <footer className="pi-dock-footer">
    {paletteOpen && <div className="pi-command-palette" id="pi-command-options" role="listbox" aria-label="Pi 命令" ref={paletteRef}>
      <header><strong>Pi 命令</strong><small>{commandLoading ? '正在读取…' : `${filteredCommands.length} 项`}</small></header>
      {commandError ? <p className="pi-command-state" data-state="error">{commandError}</p>
        : commandLoading ? <p className="pi-command-state">正在读取当前 Pi 的命令…</p>
          : filteredCommands.length ? <div className="pi-command-options">{filteredCommands.map((command, index) => <button
              type="button"
              id={`pi-command-${index}`}
              role="option"
              aria-selected={index === activeCommand}
              key={`${command.source}:${command.name}`}
              onMouseEnter={() => setActiveCommand(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => chooseCommand(command)}
            ><span><b>/{command.name}</b><small>{command.description || '无说明'}</small></span><em>{SOURCE_LABEL[command.source]}</em></button>)}</div>
            : <p className="pi-command-state">没有匹配的命令</p>}
      <footer>↑↓ 选择 · Enter/Tab 插入 · Esc 关闭</footer>
    </div>}
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
    <div className={`pi-composer${dragOver ? ' drag-over' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={(event) => { event.preventDefault(); setDragOver(false); addFiles(Array.from(event.dataTransfer.files)); }} onPaste={(event) => { const images = Array.from(event.clipboardData.files).filter((file) => imageMimeType(file)); if (images.length) { event.preventDefault(); addFiles(images); } }}>
      {annotationBadge && <div className="pi-annotation-badge" role="status" data-omitted={annotationBadge.omitted > 0 ? 'true' : 'false'} title={annotationBadge.omitted > 0 ? `上下文预算内只带入 ${annotationBadge.included} 条批注，省略 ${annotationBadge.omitted} 条` : '发送时随消息带入的正文批注数量'}>
        {annotationBadge.included > 0
          ? `已带入 ${annotationBadge.included} 条正文批注${annotationBadge.omitted > 0 ? `（省略 ${annotationBadge.omitted} 条）` : ''}`
          : `正文批注已省略 ${annotationBadge.omitted} 条（上下文超限）`}
      </div>}
      {attachments.length > 0 && <div className="pi-image-queue" aria-label={`已选择 ${attachments.length} 张图片`}>
        {attachments.map((entry, index) => <div className="pi-image-queue-item" key={entry.id} title={entry.error ?? entry.fileName}>
          <img src={entry.previewUrl} alt="" aria-hidden="true" />
          <span><b>{index + 1}. {entry.fileName}</b><small>{entry.state === 'reading' ? '读取中…' : entry.state === 'error' ? entry.error : `${entry.width ?? '?'}×${entry.height ?? '?'} · ${(entry.byteCount / 1024 / 1024).toFixed(1)} MB`}</small></span>
          <div className="pi-image-queue-actions">
            <button type="button" aria-label={`上移 ${entry.fileName}`} title="上移" disabled={sending || index === 0} onClick={() => moveFile(entry.id, -1)}>↑</button>
            <button type="button" aria-label={`下移 ${entry.fileName}`} title="下移" disabled={sending || index === attachments.length - 1} onClick={() => moveFile(entry.id, 1)}>↓</button>
            <button type="button" aria-label={`移除 ${entry.fileName}`} title="移除图片" disabled={sending} onClick={() => removeFile(entry.id)}>×</button>
          </div>
        </div>)}
      </div>}
      {queueError && <p className="pi-image-queue-state" role="status" data-state="error">{queueError}</p>}
      <textarea
        ref={textareaRef}
        disabled={!configured}
        value={input}
        role="combobox"
        aria-haspopup="listbox"
        aria-controls={paletteOpen ? 'pi-command-options' : undefined}
        aria-expanded={paletteOpen}
        aria-activedescendant={paletteOpen && filteredCommands.length ? `pi-command-${activeCommand}` : undefined}
        onChange={(event) => { resetHistoryBrowsing(); setInput(event.target.value); setBatchRequestId(null); setPaletteDismissed(false); }}
        onClick={resetHistoryBrowsing}
        onKeyDown={(event) => {
          if (paletteOpen && event.key === 'Escape') { event.preventDefault(); setPaletteDismissed(true); return; }
          if (paletteOpen && filteredCommands.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            setActiveCommand((current) => (current + (event.key === 'ArrowDown' ? 1 : -1) + filteredCommands.length) % filteredCommands.length);
            return;
          }
          if (paletteOpen && !event.shiftKey && (event.key === 'Enter' || event.key === 'Tab')) {
            event.preventDefault();
            const command = filteredCommands[activeCommand];
            if (command) chooseCommand(command);
            return;
          }
          if (!paletteOpen && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
            const browsing = historyCursorRef.current !== null;
            const collapsedAtStart = event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0;
            if (browsing || (event.key === 'ArrowUp' && collapsedAtStart)) {
              if (browseHistory(event.key === 'ArrowUp' ? -1 : 1)) {
                event.preventDefault();
                return;
              }
            }
          }
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendCurrent(event.altKey ? 'followUp' : 'steer'); }
        }}
        placeholder={configured ? (busy ? '继续输入；发送会插入当前回复，Alt+Enter 放到下一轮' : phase === 'failed' ? '失败后可以直接重试' : phase === 'stopped' ? '已停止，可以继续发送' : '给 Pi 发消息，输入 / 查看命令') : '配置 Pi API 后可以对话'}
      />
      <div className="pi-composer-bar">
        <div className="pi-composer-tools">
          <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
          <button type="button" className="pi-icon-button" title="插入图片" aria-label="插入图片" disabled={!configured || (sending && !busy)} onClick={() => fileInputRef.current?.click()}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m21 15-4.5-4.5L9 18"/></svg></button>
          <button type="button" className="pi-icon-button" title="附件（即将支持）" aria-label="附件" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21.44 11.05-8.49 8.49a5.5 5.5 0 0 1-7.78-7.78l8.49-8.49a3.5 3.5 0 0 1 4.95 4.95l-8.49 8.49a1.5 1.5 0 0 1-2.12-2.12l7.78-7.78"/></svg></button>
        </div>
        <div className="pi-composer-meta">
          <button type="button" className={`pi-model-trigger${modelMenuOpen ? ' open' : ''}`} title="选择模型和推理强度" onClick={onOpenModelMenu}><span>{modelLabel}</span><small>{thinkingChoice === 'auto' ? '自动' : thinkingChoice}</small><b>▾</b></button>
          {busy && !input.trim() && attachments.length === 0
            ? <button type="button" className="pi-send-button pi-stop-button" title="停止 Pi 当前回复" aria-label="停止 Pi 当前回复" disabled={!configured} onClick={onStop}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg></button>
            : <button type="button" className="pi-send-button" title={busy ? '插入当前回复（Alt+Enter 放到下一轮）' : '发送'} aria-label={busy ? '插入当前回复' : '发送'} disabled={!configured || (sending && !busy) || (!input.trim() && !attachments.length)} onClick={() => sendCurrent('steer')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 14-7-5 14-2-5-7-2Z"/><path d="m12 12 7-7"/></svg></button>}
        </div>
      </div>
    </div>
  </footer>;
});
