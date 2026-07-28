import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';

type RpcMessage = {
  id?: string;
  type?: string;
  success?: boolean;
  error?: unknown;
  data?: unknown;
  message?: unknown;
  assistantMessageEvent?: { type?: string; delta?: string };
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
  stopped: boolean;
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
  private onDelta: ((text: string) => void) | null = null;
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

  async promptUntilSettled(
    message: string,
    options: { timeoutMs?: number; onDelta?: (text: string) => void } = {}
  ): Promise<PiChatResult> {
    if (this.active) throw new Error('Pi 正在回复，请稍候。');
    const timeoutMs = options.timeoutMs ?? 120000;
    this.active = true;
    this.aborted = false;
    this.streamedText = '';
    this.onDelta = options.onDelta ?? null;
    const { promise: settled, resolve, reject } = defer<void>();
    const timer = setTimeout(() => {
      this.settleWaiters = this.settleWaiters.filter((waiter) => waiter.resolve !== resolve);
      reject(new Error('Pi 回复超时。'));
    }, timeoutMs);
    this.settleWaiters.push({
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      }
    });
    try {
      await this.prompt(message);
      await settled;
      let text = this.streamedText.trim();
      if (!text) {
        const result = await this.getLastAssistantText();
        const data = result.data;
        text = data && typeof data === 'object' && 'text' in data
          ? String((data as { text?: string | null }).text ?? '').trim()
          : '';
      }
      if (!text && !this.aborted) throw new Error('Pi 没有返回文字。');
      return { text, stopped: this.aborted };
    } finally {
      this.active = false;
      this.onDelta = null;
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
      if (message.type === 'message_update') {
        const deltaEvent = message.assistantMessageEvent;
        if (deltaEvent?.type === 'text_delta' && typeof deltaEvent.delta === 'string' && deltaEvent.delta) {
          this.streamedText += deltaEvent.delta;
          this.onDelta?.(this.streamedText);
          this.onEvent({ type: 'wmb_text_delta', text: this.streamedText });
        } else {
          const partial = assistantTextFromMessage(message.message);
          if (partial && partial !== this.streamedText) {
            this.streamedText = partial;
            this.onDelta?.(this.streamedText);
            this.onEvent({ type: 'wmb_text_delta', text: this.streamedText });
          }
        }
      }
      if (message.type === 'message_end') {
        const finalText = assistantTextFromMessage(message.message);
        if (finalText) this.streamedText = finalText;
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
  }

  private exitError(code: number | null): string {
    const detail = this.stderr.trim();
    return detail
      ? `Pi 进程已退出 (${code ?? 'signal'})：${detail.slice(0, 500)}`
      : `Pi 进程已退出 (${code ?? 'signal'})，可重新发送。`;
  }
}
