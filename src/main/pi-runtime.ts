import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';

type RpcMessage = {
  id?: string;
  type?: string;
  success?: boolean;
  error?: unknown;
  data?: unknown;
  message?: unknown;
  assistantMessageEvent?: { type?: string; delta?: string; contentIndex?: number };
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

function defer<T>(): { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void; reject(error: Error): void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function assistantTextFromMessage(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const record = message as { role?: unknown; content?: unknown };
  if (record.role !== 'assistant') return '';
  const content = record.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const item = part as { type?: string; text?: string };
      return item.type === 'text' && typeof item.text === 'string' ? item.text : '';
    })
    .join('');
}

function assistantThinkingFromMessage(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const record = message as { role?: unknown; content?: unknown };
  if (record.role !== 'assistant') return '';
  const content = record.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const item = part as { type?: string; thinking?: string };
      return item.type === 'thinking' && typeof item.thinking === 'string' ? item.thinking : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function assistantErrorFromMessage(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const record = message as {
    role?: unknown;
    stopReason?: unknown;
    errorMessage?: unknown;
    error?: unknown;
  };
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

function humanizePiProviderError(raw: string): string {
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
  // Keep provider detail, but avoid dumping giant JSON blobs in the dock.
  return text.length > 420 ? `${text.slice(0, 420)}…` : text;
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
  private streamedError = '';
  private onDelta: ((text: string) => void) | null = null;
  private onStreaming: (() => void) | null = null;
  private readonly executable: string;
  private readonly args: string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd?: string;
  private readonly onEvent: (event: RpcMessage) => void;

  constructor(
    executable: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    onEvent: (event: RpcMessage) => void = () => {},
    cwd?: string
  ) {
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
    this.child.stderr.on('data', (data) => {
      this.stderr = `${this.stderr}${data.toString('utf8')}`.slice(-4000);
    });
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

  prompt(message: string): Promise<RpcMessage> {
    return this.send({ type: 'prompt', message });
  }

  steer(message: string): Promise<RpcMessage> {
    return this.send({ type: 'steer', message });
  }

  followUp(message: string): Promise<RpcMessage> {
    return this.send({ type: 'follow_up', message });
  }

  getEntries(): Promise<RpcMessage> {
    return this.send({ type: 'get_entries' });
  }

  fork(entryId: string): Promise<RpcMessage> {
    return this.send({ type: 'fork', entryId });
  }

  async promptUntilSettled(
    message: string,
    options: { timeoutMs?: number; onDelta?: (text: string) => void; onStreaming?: () => void } = {}
  ): Promise<PiChatResult> {
    if (this.active) throw new Error('Pi 正在回复，请稍候。');
    this.active = true;
    this.aborted = false;
    this.streamedText = '';
    this.streamedThinking = '';
    this.streamedError = '';
    this.onDelta = options.onDelta ?? null;
    this.onStreaming = options.onStreaming ?? null;
    const { promise: settled, resolve, reject } = defer<void>();
    const timer = typeof options.timeoutMs === 'number'
      ? setTimeout(() => {
        this.settleWaiters = this.settleWaiters.filter((waiter) => waiter.resolve !== resolve);
        reject(new Error('Pi 回复超时。'));
      }, options.timeoutMs)
      : null;
    this.settleWaiters.push({
      resolve: () => {
        if (timer) clearTimeout(timer);
        resolve();
      },
      reject: (error) => {
        if (timer) clearTimeout(timer);
        reject(error);
      }
    });
    try {
      await this.prompt(message);
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
    const { promise: exited, resolve } = defer<void>();
    child.once('exit', () => resolve());
    child.kill();
    const timeout = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, 2000);
    await exited;
    clearTimeout(timeout);
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
        this.onStreaming?.();
        this.onStreaming = null;
      }
      if (message.type === 'message_start') {
        const started = message.message as { role?: unknown } | undefined;
        if (started?.role === 'assistant') {
          this.streamedText = '';
          this.streamedThinking = '';
          this.streamedError = '';
        }
      }
      if (message.type === 'message_update') {
        const deltaEvent = message.assistantMessageEvent;
        if (deltaEvent?.type === 'thinking_delta' && typeof deltaEvent.delta === 'string' && deltaEvent.delta) {
          this.streamedThinking += deltaEvent.delta;
          this.onEvent({ type: 'wmb_thinking_delta', text: this.streamedThinking });
        } else if (deltaEvent?.type === 'text_delta' && typeof deltaEvent.delta === 'string' && deltaEvent.delta) {
          this.streamedText += deltaEvent.delta;
          this.onDelta?.(this.streamedText);
          this.onEvent({ type: 'wmb_text_delta', text: this.streamedText });
        } else {
          const partialThinking = assistantThinkingFromMessage(message.message);
          if (partialThinking && partialThinking !== this.streamedThinking) {
            this.streamedThinking = partialThinking;
            this.onEvent({ type: 'wmb_thinking_delta', text: this.streamedThinking });
          }
          const partial = assistantTextFromMessage(message.message);
          if (partial && partial !== this.streamedText) {
            this.streamedText = partial;
            this.onDelta?.(this.streamedText);
            this.onEvent({ type: 'wmb_text_delta', text: this.streamedText });
          }
          const partialError = assistantErrorFromMessage(message.message);
          if (partialError) this.streamedError = partialError;
        }
      }
      if (message.type === 'message_end') {
        const finalText = assistantTextFromMessage(message.message);
        if (finalText) this.streamedText = finalText;
        const finalThinking = assistantThinkingFromMessage(message.message);
        if (finalThinking) this.streamedThinking = finalThinking;
        const finalError = assistantErrorFromMessage(message.message);
        if (finalError) this.streamedError = finalError;
      }
      if (message.type === 'agent_settled') {
        const waiters = this.settleWaiters.splice(0, this.settleWaiters.length);
        for (const waiter of waiters) waiter.resolve();
      }
      this.onEvent(message);
    }
  }

  private fail(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    const waiters = this.settleWaiters.splice(0, this.settleWaiters.length);
    for (const waiter of waiters) waiter.reject(error);
    this.active = false;
    this.onDelta = null;
    this.onStreaming = null;
  }

  private exitError(code: number | null): string {
    const detail = this.stderr.trim();
    return detail
      ? `Pi 进程已退出 (${code ?? 'signal'})：${detail.slice(0, 500)}`
      : `Pi 进程已退出 (${code ?? 'signal'})，可重新发送。`;
  }
}
