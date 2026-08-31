/**
 * 系统代理接线（主进程）。
 *
 * Electron/Chromium 的网络栈（session/net.fetch/renderer）默认跟随系统代理；
 * 但主进程的 Node `fetch`（内置 undici）不读系统代理，导致配图模型连通性检查、
 * 模型目录校验、研究抓取等在代理环境下直连失败。
 *
 * 本模块在 app ready 后：
 *  1. 用 `session.defaultSession.resolveProxy()` 解析系统对代表性 https 地址的代理判定；
 *  2. 命中代理时设置 undici 全局 dispatcher；loopback/局域网地址始终 DIRECT，
 *     不影响本地 MCP/CDP。
 *  3. 导出 `proxyEnvForChildren()`：把解析结果以标准代理变量提供给 Pi 等子进程。
 *
 * 显式环境变量（HTTPS_PROXY 等）优先级最高。所有初始化失败都降级为直连，
 * 不得阻塞 Electron 启动。
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Agent, Dispatcher, EnvHttpProxyAgent, ProxyAgent } from 'undici';
import type { Session } from 'electron';

type UndiciModule = {
  Agent: new (options?: Agent.Options) => Agent;
  EnvHttpProxyAgent: new (options?: EnvHttpProxyAgent.Options) => EnvHttpProxyAgent;
  ProxyAgent: new (options: ProxyAgent.Options | string) => ProxyAgent;
  setGlobalDispatcher: (dispatcher: Dispatcher) => void;
};
type UndiciDispatcher = Dispatcher;
type UndiciDispatchOptions = Dispatcher.DispatchOptions;
type UndiciDispatchHandler = Dispatcher.DispatchHandler;

/**
 * undici 是 vite external（避免与 Node 内置实现重复打包），运行期解析：
 * 1) 应用内 node_modules（开发态 = 仓库；打包态 = app.asar/node_modules，通常不存在）；
 * 2) 打包回退：resources/undici（forge extraResource 副本）。
 */
function loadUndici(): UndiciModule | null {
  try {
    return createRequire(import.meta.url)('undici') as UndiciModule;
  } catch {}
  try {
    const electron = createRequire(import.meta.url)('electron') as { app?: { isPackaged?: boolean } };
    if (electron.app?.isPackaged && typeof process.resourcesPath === 'string') {
      const packagedRoot = path.join(process.resourcesPath, 'undici');
      const fallbackRequire = createRequire(path.join(packagedRoot, 'package.json'));
      return fallbackRequire(packagedRoot) as UndiciModule;
    }
  } catch {}
  return null;
}

export type SystemProxyConfig = {
  /** 生效的代理 URL（http://host:port），null = 直连。 */
  proxyUrl: string | null;
  /** 判定来源：env=显式环境变量，system=Chromium 解析，none=未启用。 */
  source: 'env' | 'system' | 'none';
};

type ClosableDispatcher = { close: () => Promise<unknown> };

let current: SystemProxyConfig = { proxyUrl: null, source: 'none' };
let childProxyEnv: Record<string, string> = {};
let activeDispatcher: ClosableDispatcher | null = null;

const PROXY_PROBES = ['https://api.github.com/', 'https://www.gyan.dev/'] as const;
const PROXY_RESOLVE_TIMEOUT_MS = 1_000;
const LOOPBACK_HOSTS: Record<string, true> = { localhost: true, '127.0.0.1': true, '::1': true, '0.0.0.0': true };

function readEnvProxy(upper: string, lower: string): string | null {
  const value = process.env[upper]?.trim() || process.env[lower]?.trim() || '';
  return value || null;
}

function defaultNoProxy(value: string | null): string {
  // Keep a user wildcard untouched: appending entries would change EnvHttpProxyAgent's
  // wildcard semantics. The dispatcher itself still enforces the private-address bypass.
  if (value?.trim() === '*') return '*';
  const entries = new Map<string, string>();
  for (const item of (value ?? '').split(/[\s,]+/)) {
    const trimmed = item.trim();
    if (trimmed && !entries.has(trimmed.toLowerCase())) entries.set(trimmed.toLowerCase(), trimmed);
  }
  // Include both bracketed and unbracketed IPv6 spellings because URL.hostname retains
  // brackets for IPv6 literals while clients differ in how they parse NO_PROXY entries.
  for (const item of ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']) {
    if (!entries.has(item.toLowerCase())) entries.set(item.toLowerCase(), item);
  }
  return [...entries.values()].join(',');
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split('.');
  if (octets.length !== 4 || octets.some((item) => !/^\d{1,3}$/.test(item))) return false;
  const values = octets.map((item) => Number.parseInt(item, 10));
  if (values.some((value) => value > 255)) return false;
  const [first, second] = values;
  if (first === 10 || first === 127) return true;
  if (first === 192 && second === 168) return true;
  if (first === 169 && second === 254) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  return false;
}

function isPrivateIpv6(hostname: string): boolean {
  const value = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return true;
  // RFC 4193 unique-local and RFC 4291 link-local ranges.
  return /^(?:f[cd]|fe[89ab])/.test(value);
}

function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;
    const hostname = parsed.hostname.toLowerCase();
    return LOOPBACK_HOSTS[hostname] === true
      || hostname.endsWith('.localhost')
      || hostname.endsWith('.local')
      || isPrivateIpv4(hostname)
      || isPrivateIpv6(hostname);
  } catch {
    // Invalid/unknown origins must not be sent through a newly configured proxy.
    return true;
  }
}

/** Chromium resolveProxy 输出形如 "DIRECT" / "PROXY host:port" / "SOCKS5 host:port" / 分号链。取首个可用条目。 */
function parseResolveProxy(result: string): string | null {
  for (const part of String(result ?? '').split(';')) {
    const token = part.trim();
    if (!token || token.toUpperCase() === 'DIRECT') continue;
    const match = /^(PROXY|HTTPS?|SOCKS(?:4A?|5)?)\s+(.+)$/i.exec(token);
    if (!match) continue;
    const endpoint = match[2]?.trim();
    if (!endpoint) continue;
    return match[1]!.toUpperCase().startsWith('SOCKS') ? `socks5://${endpoint}` : `http://${endpoint}`;
  }
  return null;
}

/**
 * ProxyAgent itself proxies every origin. Wrap it with a direct Agent so local
 * MCP/CDP and RFC1918/link-local endpoints never traverse the external proxy.
 */

class LoopbackBypassDispatcher {
  private readonly proxied: UndiciDispatcher;
  private readonly direct: UndiciDispatcher;

  constructor(proxied: UndiciDispatcher, direct: UndiciDispatcher) {
    this.proxied = proxied;
    this.direct = direct;
  }

  dispatch(options: UndiciDispatchOptions, handler: UndiciDispatchHandler): boolean {
    const origin = typeof options.origin === 'string' ? options.origin : String(options.origin ?? '');
    const dispatcher = isLoopbackUrl(origin) ? this.direct : this.proxied;
    return dispatcher.dispatch(options, handler);
  }

  async close(): Promise<void> {
    await Promise.all([this.proxied.close(), this.direct.close()]);
  }

  async destroy(error?: Error): Promise<void> {
    await Promise.all([this.proxied.destroy(error ?? null), this.direct.destroy(error ?? null)]);
  }
}

function installDispatcher(undici: UndiciModule, next: ClosableDispatcher): void {
  const previous = activeDispatcher;
  undici.setGlobalDispatcher(next as unknown as UndiciDispatcher);
  activeDispatcher = next;
  if (previous && previous !== next) void previous.close().catch(() => {});
}

function installDirectDispatcher(undici: UndiciModule | null): void {
  if (!undici) return;
  try {
    installDispatcher(undici, new undici.Agent());
  } catch {}
}

function setDirectState(undici: UndiciModule | null): SystemProxyConfig {
  installDirectDispatcher(undici);
  current = { proxyUrl: null, source: 'none' };
  childProxyEnv = {};
  return current;
}

function childEnvFor(proxyUrl: string, noProxy: string): Record<string, string> {
  return {
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    NO_PROXY: noProxy
  };
}
function childEnvForExplicit(input: {
  httpProxy: string | null;
  httpsProxy: string | null;
  allProxy: string | null;
  noProxy: string;
}): Record<string, string> {
  const fallback = input.httpsProxy ?? input.httpProxy ?? input.allProxy;
  if (!fallback) return {};
  return {
    HTTPS_PROXY: input.httpsProxy ?? input.allProxy ?? input.httpProxy ?? fallback,
    HTTP_PROXY: input.httpProxy ?? input.allProxy ?? input.httpsProxy ?? fallback,
    ALL_PROXY: input.allProxy ?? input.httpsProxy ?? input.httpProxy ?? fallback,
    NO_PROXY: input.noProxy
  };
}


async function resolveWithDeadline(resolveProxy: (url: string) => Promise<string>, url: string): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resolveProxy(url),
      new Promise<string>((_, reject) => {
        timer = setTimeout(() => reject(new Error('resolveProxy timeout')), PROXY_RESOLVE_TIMEOUT_MS);
        timer.unref?.();
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * app ready 后调用一次。`resolveProxyImpl` 供测试注入。
 * 返回最终生效的代理配置。
 */
export async function initSystemProxy(resolveProxyImpl?: (url: string) => Promise<string>, sessionRef?: Session): Promise<SystemProxyConfig> {
  const httpProxy = readEnvProxy('HTTP_PROXY', 'http_proxy');
  const httpsProxy = readEnvProxy('HTTPS_PROXY', 'https_proxy');
  const allProxy = readEnvProxy('ALL_PROXY', 'all_proxy');
  const envProxy = httpsProxy ?? httpProxy ?? allProxy;
  const noProxy = defaultNoProxy(readEnvProxy('NO_PROXY', 'no_proxy'));
  const undici = loadUndici();

  // Explicit environment variables win over Electron's PAC/system result.
  if (envProxy) {
    if (!undici) return setDirectState(null);
    try {
      const envAgent = new undici.EnvHttpProxyAgent({
        httpProxy: httpProxy ?? allProxy ?? undefined,
        httpsProxy: httpsProxy ?? allProxy ?? undefined,
        noProxy
      });
      installDispatcher(undici, new LoopbackBypassDispatcher(envAgent, new undici.Agent()));
      current = { proxyUrl: envProxy, source: 'env' };
      childProxyEnv = childEnvForExplicit({ httpProxy, httpsProxy, allProxy, noProxy });
      return current;
    } catch {
      return setDirectState(undici);
    }
  }

  let proxyUrl: string | null = null;
  try {
    if (resolveProxyImpl) {
      for (const probe of PROXY_PROBES) {
        const parsed = parseResolveProxy(await resolveWithDeadline(resolveProxyImpl, probe));
        if (parsed) {
          proxyUrl = parsed;
          break;
        }
      }
    } else {
      // Electron is intentionally loaded lazily: the test module and non-Electron
      // tooling import this helper in plain Node, where the Electron module is absent.
      const { session } = await import('electron');
      const activeSession = sessionRef ?? session.defaultSession;
      if (activeSession) {
        for (const probe of PROXY_PROBES) {
          const verdict = await resolveWithDeadline((url) => activeSession.resolveProxy(url), probe);
          const parsed = parseResolveProxy(verdict);
          if (parsed) {
            proxyUrl = parsed;
            break;
          }
          // PAC files can choose DIRECT for one origin and PROXY for another;
          // continue probing instead of treating the first DIRECT as global.
        }
      }
    }
  } catch {
    proxyUrl = null;
  }

  if (!proxyUrl || !undici) return setDirectState(undici);
  try {
    const proxyAgent = new undici.ProxyAgent({ uri: proxyUrl });
    installDispatcher(undici, new LoopbackBypassDispatcher(proxyAgent, new undici.Agent()));
    current = { proxyUrl, source: 'system' };
    childProxyEnv = childEnvFor(proxyUrl, noProxy);
  } catch {
    return setDirectState(undici);
  }
  return current;
}

/** 当前生效配置（测试与诊断用）。 */
export function currentSystemProxy(): SystemProxyConfig {
  return current;
}

/**
 * 子进程环境注入：Pi 等子进程的 Node fetch 依赖标准代理变量。
 * 返回新对象，避免某个调用方修改后污染其他 Pi 进程；loopback/内网由 NO_PROXY
 * 与主进程 dispatcher 双重保证。
 */
export function proxyEnvForChildren(): Record<string, string> {
  return { ...childProxyEnv };
}

export const __test = { isLoopbackUrl, parseResolveProxy };
