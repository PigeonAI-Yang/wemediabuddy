import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { PiCommand } from '../main/pi-commands';
import { filterPiCommands, insertPiCommand } from './pi-command-filter';

const SOURCE_LABEL: Record<PiCommand['source'], string> = {
  skill: 'Skill',
  prompt: '提示模板',
  extension: '扩展命令'
};

export const PiComposer = memo(function PiComposer({
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
  const [commands, setCommands] = useState<PiCommand[]>([]);
  const [commandLoading, setCommandLoading] = useState(false);
  const [commandError, setCommandError] = useState('');
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  const [activeCommand, setActiveCommand] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const paletteRef = useRef<HTMLDivElement | null>(null);
  const paletteOpen = configured && !paletteDismissed && /^\/[^\s]*$/.test(input);
  const filteredCommands = useMemo(() => filterPiCommands(commands, input), [commands, input]);

  useEffect(() => {
    if (draftSeed == null) return;
    setInput(draftSeed);
    setPaletteDismissed(false);
    onDraftSeedConsumed();
  }, [draftSeed, onDraftSeedConsumed]);

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

  useEffect(() => setActiveCommand(0), [input]);
  useEffect(() => {
    paletteRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeCommand]);

  const chooseCommand = (command: PiCommand) => {
    setInput(insertPiCommand(command));
    setPaletteDismissed(true);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };
  const sendCurrent = (delivery?: 'steer' | 'followUp') => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    setPaletteDismissed(false);
    onSend(text, delivery);
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
    <div className="pi-composer">
      <textarea
        ref={textareaRef}
        disabled={!configured}
        value={input}
        role="combobox"
        aria-haspopup="listbox"
        aria-controls={paletteOpen ? 'pi-command-options' : undefined}
        aria-expanded={paletteOpen}
        aria-activedescendant={paletteOpen && filteredCommands.length ? `pi-command-${activeCommand}` : undefined}
        onChange={(event) => { setInput(event.target.value); setPaletteDismissed(false); }}
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
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendCurrent(event.altKey ? 'followUp' : 'steer'); }
        }}
        placeholder={configured ? (busy ? '继续输入；发送会插入当前回复，Alt+Enter 放到下一轮' : phase === 'failed' ? '失败后可以直接重试' : phase === 'stopped' ? '已停止，可以继续发送' : '给 Pi 发消息，输入 / 查看命令') : '配置 Pi API 后可以对话'}
      />
      <div className="pi-composer-bar">
        <div className="pi-composer-tools">
          <button type="button" className="pi-icon-button" title="插入图片（即将支持）" aria-label="插入图片" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m21 15-4.5-4.5L9 18"/></svg></button>
          <button type="button" className="pi-icon-button" title="附件（即将支持）" aria-label="附件" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21.44 11.05-8.49 8.49a5.5 5.5 0 0 1-7.78-7.78l8.49-8.49a3.5 3.5 0 0 1 4.95 4.95l-8.49 8.49a1.5 1.5 0 0 1-2.12-2.12l7.78-7.78"/></svg></button>
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
