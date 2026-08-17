import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { stopProcessTree } from './workspace-runtime.ts';

type RpcMessage = {
  id?: string;
  type?: string;
  success?: boolean;
  error?: unknown;
  data?: unknown;
  message?: unknown;
  assistantMessageEvent?: { type?: string; delta?: string; contentIndex?: number; partial?: unknown };
  [key: string]: unknown;
};

type PendingRequest = {
  resolve(value: RpcMessage): void;
  reject(error: Error): void;
};

type SettleWaiter = {
  resolve(): void;
  reject(error: Error): void;
};

export type PiChatResult = {
  text: string;
  thinking: string;
  stopped: boolean;
  error?: string;
};
export type PiImageContent = { type: 'image'; data: string; mimeType: string };
export type PiModelIdentity = { provider: string; modelId: string };

function defer<T>(): { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void; reject(error: Error): void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function assistantPartsFromMessage(message: unknown, kind: 'text' | 'thinking'): string {
  if (!message || typeof message !== 'object') return '';
  const record = message as { role?: unknown; content?: unknown };
  if (record.role !== 'assistant') return '';
  const content = record.content;
  if (kind === 'text' && typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const item = part as { type?: string; text?: string; thinking?: string };
      return item.type === kind && typeof item[kind] === 'string' ? String(item[kind]) : '';
    })
    .filter(Boolean)
    .join(kind === 'thinking' ? '\n\n' : '');
}

function assistantBlockFromMessage(message: unknown, contentIndex: number | undefined, kind: 'text' | 'thinking'): string {
  if (!message || typeof message !== 'object' || !('content' in message) || !Number.isInteger(contentIndex)) return '';
  const block: unknown = Array.isArray(message.content) ? message.content[contentIndex!] : null;
  if (!block || typeof block !== 'object' || !(kind in block)) return '';
  const value = (block as Record<string, unknown>)[kind];
  return typeof value === 'string' ? value : '';
}

function assistantErrorFromMessage(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const record = message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown; error?: unknown };
  if (record.role !== 'assistant') return '';
  const direct = typeof record.errorMessage === 'string' ? record.errorMessage.trim()
    : typeof record.error === 'string' ? record.error.trim()
    : record.error && typeof record.error === 'object' && typeof (record.error as { message?: unknown }).message === 'string'
      ? String((record.error as { message: string }).message).trim()
      : '';
  if (direct) return humanizePiProviderError(direct);
  if (record.stopReason === 'error') return 'Pi 模型调用失败。';
  return '';
}

export function humanizePiProviderError(raw: string): string {
  const text = raw.replace(/^\d{3}:\s*/, '').trim();
  // OpenCode Go China-hosted model opt-in.
  if (/RegionError/i.test(text) || /only available hosted in China and requires explicit opt in/i.test(text)) {
    const link = text.match(/https?:\/\/\S+/)?.[0]?.replace(/[)\].,]+$/, '') ?? 'https://opencode.ai';
    return `当前模型未开通中国区访问（OpenCode RegionError）。请到 ${link} 完成 opt-in，或在 Pi 模型设置里换一个可用模型。`;
  }
  if (/invalid.?api.?key|incorrect api key|unauthorized/i.test(text)) {
    return 'Pi API Key 无效或未授权，请到设置里检查配置。';
  }
  if (/rate limit|too many requests/i.test(text)) {
    return 'Pi 接口触发限流，请稍后再试。';
  }
  const bodylessServerError = text.match(/^(5\d\d) status code \(no body\)$/i);
  if (bodylessServerError) return `Pi 模型服务暂时异常（HTTP ${bodylessServerError[1]}，服务端未返回详情）。已完成的工具结果已保留，可稍后重试回答。`;
  return text.length > 420 ? `${text.slice(0, 420)}…` : text;
}

export function isPiProviderFallbackError(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const text = raw.replace(/^\d{3}:\s*/, '').trim();
  // 只允许尚未产生副作用的瞬时服务故障降级；鉴权、模型/协议配置、权限和业务错误必须原样失败。
  return /rate limit|too many requests|\b429\b|out of .*messages|quota|limit_reached|resource_exhausted|overloaded|capacity|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network|fetch failed|socket|timeout|temporar(?:y|ily)|bad gateway|service unavailable|\b5\d\d\b/i.test(text);
}

export class PiRpcSupervisor {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private stderr = '';
  private pending = new Map<string, PendingRequest>();
  private settleWaiters: SettleWaiter[] = [];
  private active = false;
  private aborted = false;
  private intentionalStop = false;
  private streamedText = '';
  private streamedThinking = '';
  private assistantEpoch = 0;
  private streamedError = '';
  private onDelta: ((text: string) => void) | null = null;
  private onStreaming: (() => void) | null = null;
  private eventGate: Promise<void> | null = null;
  private bufferedEmissions: Array<() => void> = [];
  private heldSettles: SettleWaiter[] = [];
  private suppressEmissions = false;
  private settleObserved = false;
  private readonly executable: string;
  private readonly args: string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd?: string;
  private readonly onEvent: (event: RpcMessage) => void;

  constructor(executable: string, args: string[], env: NodeJS.ProcessEnv, onEvent: (event: RpcMessage) => void = () => {}, cwd?: string) {
    this.executable = executable;
    this.args = args;
    this.env = env;
    this.onEvent = onEvent;
    this.cwd = cwd;
  }

  get isActive(): boolean {
    return this.active;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get isRunning(): boolean {
    return Boolean(this.child && this.child.exitCode === null);
  }

  async start(): Promise<RpcMessage> {
    if (this.child) throw new Error('Pi RPC 已启动。');
    this.stderr = '';
    this.intentionalStop = false;
    this.child = spawn(this.executable, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.child.stdout.on('data', (data) => this.read(data.toString('utf8')));
    this.child.stderr.on('data', (data) => { this.stderr = `${this.stderr}${data.toString('utf8')}`.slice(-4000); });
    this.child.once('exit', (code) => {
      const intentional = this.intentionalStop;
      this.child = null;
      const error = new Error(intentional ? 'Pi RPC 已停止。' : this.exitError(code));
      this.fail(error);
      this.onEvent({
        type: intentional ? 'wmb_process_stopped' : 'wmb_process_crashed',
        code,
        error: error.message
      });
    });
    this.child.once('error', (error) => this.fail(error));
    return this.send({ type: 'get_state' });
  }

  getState(): Promise<RpcMessage> {
    return this.send({ type: 'get_state' });
  }
  async getModel(): Promise<PiModelIdentity> {
    const state = await this.getState();
    const data = state.data;
    const model = data && typeof data === 'object' && 'model' in data ? data.model : undefined;
    if (!model || typeof model !== 'object' || !('provider' in model) || !('id' in model)) throw new Error('Pi 当前模型不可用。');
    const provider = model.provider;
    const modelId = model.id;
    if (typeof provider !== 'string' || !provider || typeof modelId !== 'string' || !modelId) throw new Error('Pi 当前模型不可用。');
    return { provider, modelId };
  }

  setModel(provider: string, modelId: string): Promise<RpcMessage> {
    return this.send({ type: 'set_model', provider, modelId });
  }

  getCommands(): Promise<RpcMessage> {
    return this.send({ type: 'get_commands' });
  }
  prompt(message: string, images?: readonly PiImageContent[]): Promise<RpcMessage> {
    return this.send({ type: 'prompt', message, ...(images?.length ? { images } : {}) });
  }

  steer(message: string, images?: readonly PiImageContent[]): Promise<RpcMessage> {
    return this.send({ type: 'steer', message, ...(images?.length ? { images } : {}) });
  }

  followUp(message: string, images?: readonly PiImageContent[]): Promise<RpcMessage> {
    return this.send({ type: 'follow_up', message, ...(images?.length ? { images } : {}) });
  }

  getEntries(): Promise<RpcMessage> {
    return this.send({ type: 'get_entries' });
  }

  fork(entryId: string): Promise<RpcMessage> {
    return this.send({ type: 'fork', entryId });
  }

  async promptUntilSettled(
    message: string,
    options: { timeoutMs?: number; onDelta?: (text: string) => void; onStreaming?: () => void; images?: readonly PiImageContent[] } = {}
  ): Promise<PiChatResult> {
    if (this.active) throw new Error('Pi 正在回复，请稍候。');
    this.active = true;
    this.aborted = false;
    this.streamedText = '';
    this.streamedThinking = '';
    this.streamedError = '';
    this.suppressEmissions = false;
    this.settleObserved = false;
    this.onDelta = options.onDelta ?? null;
    this.onStreaming = options.onStreaming ?? null;
    const { promise: settled, resolve, reject } = defer<void>();
    const timer = typeof options.timeoutMs === 'number'
      ? setTimeout(() => {
        this.settleWaiters = this.settleWaiters.filter((waiter) => waiter.resolve !== resolve);
        reject(new Error('Pi 回复超时。'));
      }, options.timeoutMs)
      : undefined;
    this.settleWaiters.push({
      resolve: () => { clearTimeout(timer); resolve(); },
      reject: (error) => { clearTimeout(timer); reject(error); }
    });
    try {
      await this.prompt(message, options.images);
      await settled;
      let text = this.streamedText.trim();
      let thinking = this.streamedThinking.trim();
      const error = this.streamedError.trim();
      if (!text) {
        const result = await this.getLastAssistantText();
        const data = result.data;
        text = data && typeof data === 'object' && 'text' in data
          ? String((data as { text?: string | null }).text ?? '').trim()
          : '';
      }
      if (!text && !this.aborted) {
        throw new Error(error || 'Pi 没有返回文字。');
      }
      return { text, thinking, stopped: this.aborted, ...(error ? { error } : {}) };
    } finally {
      this.active = false;
      this.onDelta = null;
      this.onStreaming = null;
    }
  }

  async abortTurn(): Promise<void> {
    if (!this.active || this.aborted) return;
    this.aborted = true;
    await this.abort();
  }

  abort(): Promise<RpcMessage> {
    return this.send({ type: 'abort' });
  }

  getLastAssistantText(): Promise<RpcMessage> {
    return this.send({ type: 'get_last_assistant_text' });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.intentionalStop = true;
    await stopProcessTree(child, 2_000);
    this.child = null;
  }

  private send(message: RpcMessage): Promise<RpcMessage> {
    if (!this.child) return Promise.reject(new Error('Pi RPC 未启动。'));
    const id = randomUUID();
    const { promise, resolve, reject } = defer<RpcMessage>();
    this.pending.set(id, { resolve, reject });
    this.child.stdin.write(`${JSON.stringify({ ...message, id })}\n`);
    return promise;
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    while (this.buffer.includes('\n')) {
      const index = this.buffer.indexOf('\n');
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        this.child?.kill();
        this.fail(new Error('Pi RPC 返回了无效 JSONL。'));
        return;
      }
      if (message.type === 'response' && message.id && this.pending.has(message.id)) {
        const request = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        if (message.success === false) request.reject(new Error(String(message.error ?? 'Pi RPC 请求失败。')));
        else request.resolve(message);
        continue;
      }
      if (message.type === 'agent_start') {
        this.openEventGate(this.onStreaming?.());
        this.onStreaming = null;
      }
      if (message.type === 'message_start') {
        const started = message.message as { role?: unknown } | undefined;
        if (started?.role === 'assistant') {
          this.assistantEpoch += 1;
          this.streamedText = this.streamedThinking = this.streamedError = '';
        }
      }
      if (message.type === 'message_update') {
        const deltaEvent = message.assistantMessageEvent;
        if (deltaEvent?.type === 'thinking_delta' && typeof deltaEvent.delta === 'string' && deltaEvent.delta) {
          const partial = deltaEvent.partial ?? message.message;
          const full = assistantPartsFromMessage(partial, 'thinking');
          this.streamedThinking = full || this.streamedThinking + deltaEvent.delta;
          const text = assistantBlockFromMessage(partial, deltaEvent.contentIndex, 'thinking') || this.streamedThinking;
          const streamKey = `${this.assistantEpoch}:${deltaEvent.contentIndex ?? 0}:thinking`;
          this.emitOutward(() => this.onEvent({ type: 'wmb_thinking_delta', text, streamKey }));
        } else if (deltaEvent?.type === 'text_delta' && typeof deltaEvent.delta === 'string' && deltaEvent.delta) {
          const partial = deltaEvent.partial ?? message.message;
          const full = assistantPartsFromMessage(partial, 'text');
          this.streamedText = full || this.streamedText + deltaEvent.delta;
          const text = assistantBlockFromMessage(partial, deltaEvent.contentIndex, 'text') || this.streamedText;
          const streamKey = `${this.assistantEpoch}:${deltaEvent.contentIndex ?? 0}:text`;
          const currentText = this.streamedText;
          this.emitOutward(() => {
            this.onDelta?.(currentText);
            this.onEvent({ type: 'wmb_text_delta', text, streamKey });
          });
        } else {
          const partialThinking = assistantPartsFromMessage(message.message, 'thinking');
          if (partialThinking && partialThinking !== this.streamedThinking) {
            this.streamedThinking = partialThinking;
            const text = this.streamedThinking;
            this.emitOutward(() => this.onEvent({ type: 'wmb_thinking_delta', text }));
          }
          const partial = assistantPartsFromMessage(message.message, 'text');
          if (partial && partial !== this.streamedText) {
            this.streamedText = partial;
            const currentText = this.streamedText;
            this.emitOutward(() => {
              this.onDelta?.(currentText);
              this.onEvent({ type: 'wmb_text_delta', text: currentText });
            });
          }
          const partialError = assistantErrorFromMessage(message.message);
          if (partialError) this.streamedError = partialError;
        }
      }
      if (message.type === 'message_end') {
        const finalText = assistantPartsFromMessage(message.message, 'text');
        if (finalText) this.streamedText = finalText;
        const finalThinking = assistantPartsFromMessage(message.message, 'thinking');
        if (finalThinking) this.streamedThinking = finalThinking;
        const finalError = assistantErrorFromMessage(message.message);
        if (finalError) this.streamedError = finalError;
      }
      if (message.type === 'agent_settled') {
        this.settleObserved = true;
        const waiters = this.settleWaiters.splice(0, this.settleWaiters.length);
        if (this.eventGate) this.heldSettles.push(...waiters);
        else for (const waiter of waiters) waiter.resolve();
        // 接受门已拒绝的失败回合：settle 事件本身也随回合丢弃（回合整体零外向），仅复位内部抑制。
        if (this.suppressEmissions) {
          this.suppressEmissions = false;
          continue;
        }
      }
      this.emitOutward(() => this.onEvent(message));
    }
  }

  private emitOutward(emission: () => void): void {
    if (this.suppressEmissions) return;
    if (this.eventGate) this.bufferedEmissions.push(emission);
    else emission();
  }
  private openEventGate(gate: unknown): void {
    // onStreaming 返回值：非 thenable（手动/同步回调）不设门，事件零延迟。
    const thenable = gate as Promise<void> | undefined;
    if (typeof thenable?.then !== 'function') return;
    this.eventGate = Promise.resolve(thenable);
    void this.eventGate.then(
      () => {
        this.eventGate = null;
        for (const emission of this.bufferedEmissions.splice(0, this.bufferedEmissions.length)) emission();
        for (const waiter of this.heldSettles.splice(0, this.heldSettles.length)) waiter.resolve();
      },
      (error) => {
        this.eventGate = null;
        this.bufferedEmissions.length = 0;
        const waiters = this.heldSettles.splice(0, this.heldSettles.length).concat(this.settleWaiters.splice(0, this.settleWaiters.length));
        for (const waiter of waiters) waiter.reject(error instanceof Error ? error : new Error(String(error ?? 'Pi 编排接受门失败。')));
        // 门拒绝后：本失败回合剩余外向事件继续抑制，直到同一回合 agent_settled；
        // agent_settled 已在门内观察到（回合已 settle）→ 立即复位，不残留抑制吞掉后续事件。
        this.suppressEmissions = !this.settleObserved;
      }
    );
  }

  private fail(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    const waiters = this.settleWaiters.splice(0, this.settleWaiters.length).concat(this.heldSettles.splice(0, this.heldSettles.length));
    for (const waiter of waiters) waiter.reject(error);
    this.active = false;
    this.onDelta = null;
    this.onStreaming = null;
    this.eventGate = null;
    this.bufferedEmissions.length = 0;
  }

  private exitError(code: number | null): string {
    const detail = this.stderr.trim();
    return detail ? `Pi 进程已退出 (${code ?? 'signal'})：${detail.slice(0, 500)}` : `Pi 进程已退出 (${code ?? 'signal'})，可重新发送。`;
  }
}
