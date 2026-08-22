/**
 * 系统代理接线（主进程）。
 *
 * Electron/Chromium 的网络栈（session/net.fetch/renderer）默认跟随系统代理；
 * 但主进程的 Node `fetch`（内置 undici）不读系统代理，导致配图模型连通性检查、
 * 模型目录校验、研究抓取等在代理环境下直连失败。
 *
 * 本模块在 app ready 后：
 *  1. 用 `session.defaultSession.resolveProxy()` 解析系统对代表性 https 地址的代理判定；
 *  2. 命中 PROXY 时设置 undici 全局 dispatcher（ProxyAgent），使主进程所有 Node fetch
 *     走同一代理；loopback/局域网地址始终 DIRECT，不影响本地 MCP/CDP。
 *  3. 导出 `proxyEnvForChildren()`：把解析结果以 HTTPS_PROXY/HTTP_PROXY/NO_PROXY 形式
 *     提供给 Pi 等子进程，使其自身 fetch 同样跟随。
 *
 * 显式环境变量（HTTPS_PROXY 等）优先级最高：此时不再解析系统代理，仅补 NO_PROXY 默认值，
 * undici EnvHttpProxyAgent 自身语义生效。
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Session } from 'electron';

/**
 * undici 是 vite external（避免与 Node 内置实现重复打包），运行期解析：
 * 1) 应用内 node_modules（开发态 = 仓库；打包态 = app.asar/node_modules，通常不存在）；
 * 2) 打包回退：resources/node_modules/undici（forge extraResource 副本）。
 */
function loadUndici(): typeof import('undici') | null {
  try {
    return createRequire(import.meta.url)('undici') as typeof import('undici');
  } catch {}
  try {
    const electron = createRequire(import.meta.url)('electron') as { app?: { isPackaged?: boolean } };
    if (electron.app?.isPackaged) {
      const fallbackRequire = createRequire(path.join(process.resourcesPath, 'undici', 'package.json'));
      return fallbackRequire('undici') as typeof import('undici');
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

let current: SystemProxyConfig = { proxyUrl: null, source: 'none' };

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
const PRIVATE_IPV4_PREFIXES = ['10.', '192.168.', '169.254.', '172.'];

function isPrivateIpv4(hostname: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return false;
  if (PRIVATE_IPV4_PREFIXES.some((prefix) => hostname.startsWith(prefix))) {
    // 172.x 需要落在 172.16–31；其余前缀直接命中。
    const second = Number.parseInt(hostname.split('.')[1] ?? '', 10);
    if (hostname.startsWith('172.')) return second >= 16 && second <= 31;
    return true;
  }
  return false;
}

function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;
    return LOOPBACK_HOSTS.has(parsed.hostname) || isPrivateIpv4(parsed.hostname);
  } catch {
    return true;
  }
}

/** Chromium resolveProxy 输出形如 "DIRECT" / "PROXY host:port" / "SOCKS5 host:port" / 分号链。取首个可用条目。 */
function parseResolveProxy(result: string): string | null {
  for (const part of result.split(';')) {
    const token = part.trim();
    if (!token || token.toUpperCase() === 'DIRECT') continue;
    const scheme = /^(?:(?:HTTPS?|SOCKS[45]?)|PROXY)\s+(.+)$/i.exec(token);
    if (scheme) return `http://${scheme[1]}`;
    return null; // PAC 文件路径或无法识别的条目：不处理
  }
  return null;
}

/**
 * app ready 后调用一次。`resolveProxyImpl` 供测试注入。
 * 返回最终生效的代理配置。
 */
export async function initSystemProxy(resolveProxyImpl?: (url: string) => Promise<string>, sessionRef?: Session): Promise<SystemProxyConfig> {
  const envProxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy ?? process.env.ALL_PROXY ?? process.env.all_proxy;
  if (envProxy) {
    // 显式环境变量：交给 EnvHttpProxyAgent（自带 NO_PROXY 语义），不重复实现。
    const undici = loadUndici();
    if (undici) {
      undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent());
      current = { proxyUrl: envProxy, source: 'env' };
    } else {
      current = { proxyUrl: null, source: 'none' };
    }
    return current;
  }

  let proxyUrl: string | null = null;
  try {
    if (resolveProxyImpl) {
      // 测试/注入路径：不触碰 electron。
      for (const probe of ['https://api.github.com/', 'https://www.gyan.dev/']) {
        const parsed = parseResolveProxy(await resolveProxyImpl(probe));
        if (parsed) {
          proxyUrl = parsed;
          break;
        }
      }
    } else {
      const { session } = await import('electron');
      const activeSession = sessionRef ?? session.defaultSession;
      if (activeSession) {
        for (const probe of ['https://api.github.com/', 'https://www.gyan.dev/']) {
          const verdict = await activeSession.resolveProxy(probe);
          const parsed = parseResolveProxy(verdict);
          if (parsed) {
            proxyUrl = parsed;
            break;
          }
          if (verdict.trim().toUpperCase().startsWith('DIRECT')) break; // 首个探测即直连，视为无系统代理
        }
      }
    }
  } catch {
    proxyUrl = null;
  }

  if (!proxyUrl) {
    current = { proxyUrl: null, source: 'none' };
    return current;
  }
  try {
    const undici = loadUndici();
    if (!undici) {
      current = { proxyUrl: null, source: 'none' };
      return current;
    }
    undici.setGlobalDispatcher(new undici.ProxyAgent({ uri: proxyUrl }));
    current = { proxyUrl, source: 'system' };
  } catch {
    current = { proxyUrl: null, source: 'none' };
  }
  return current;
}

/** 当前生效配置（测试与诊断用）。 */
export function currentSystemProxy(): SystemProxyConfig {
  return current;
}

/**
 * 子进程环境注入：Pi 等子进程的 Node fetch 依赖标准代理变量。
 * 仅当本模块已启用代理时返回需覆盖的字段；loopback 豁免由 NO_PROXY 保证。
 */
export function proxyEnvForChildren(): Record<string, string> {
  if (!current.proxyUrl) return {};
  return {
    HTTPS_PROXY: current.proxyUrl,
    HTTP_PROXY: current.proxyUrl,
    ALL_PROXY: current.proxyUrl,
    NO_PROXY: process.env.NO_PROXY ?? process.env.no_proxy ?? 'localhost,127.0.0.1,::1'
  };
}

export const __test = { isLoopbackUrl, parseResolveProxy };
