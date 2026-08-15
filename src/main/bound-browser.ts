import type { DatabaseSync } from 'node:sqlite';
import { startBrowser, type BrowserRuntime, type StartBrowserOptions } from './browser.ts';
import { requireBrowserProfile, type BrowserProfile } from './browser-config.ts';
import { identifyXAccount } from './platforms/x.ts';
import { identifyWechatAccount } from './platforms/wechat.ts';
import { identifyZhihuAccount } from './platforms/zhihu.ts';
import {
  assertWorkspaceBrowserIdentity,
  readWorkspaceBrowserBinding,
  type WorkspaceBrowserBinding
} from './workspace-browser-binding.ts';
import type { AccountIdentity } from './accounts.ts';

export type BoundBrowserPlatform = Extract<AccountIdentity['platform'], 'x' | 'wechat' | 'zhihu'>;
export type ResolvedBrowserBinding = { profile: BrowserProfile; binding: WorkspaceBrowserBinding };
export type VerifiedBoundBrowser = ResolvedBrowserBinding & { runtime: BrowserRuntime; identity: AccountIdentity };

export function resolveBrowserBinding(database: DatabaseSync): ResolvedBrowserBinding {
  const binding = readWorkspaceBrowserBinding(database);
  if (!binding?.profileId) throw browserBindingError('BROWSER_NEEDS_USER', '当前工作空间尚未绑定浏览器档案。');
  if (binding.state !== 'verified') {
    throw browserBindingError('BROWSER_NEEDS_USER', binding.error?.message || '当前浏览器绑定需要 Owner 验证。');
  }
  const profile = requireBrowserProfile(binding.profileId);
  return { profile, binding };
}

export function workspaceBrowserReady(database: DatabaseSync, platform: BoundBrowserPlatform = 'x'): boolean {
  try {
    const { binding } = resolveBrowserBinding(database);
    const expected = binding.expectedAccountSnapshot[platform];
    return Boolean(expected && expected.browserProfileId === binding.profileId && expected.browserBindingRevision === binding.bindingRevision);
  } catch {
    return false;
  }
}

export async function startVerifiedBoundBrowser(
  database: DatabaseSync,
  platform: BoundBrowserPlatform,
  options: StartBrowserOptions = { mode: 'quiet' }
): Promise<VerifiedBoundBrowser> {
  const resolved = resolveBrowserBinding(database);
  const runtime = await startBrowser(resolved.profile, options);
  const identity = platform === 'x'
    ? await identifyXAccount(runtime.cdpUrl)
    : platform === 'wechat'
      ? await identifyWechatAccount(runtime.cdpUrl)
      : await identifyZhihuAccount(runtime.cdpUrl);
  assertWorkspaceBrowserIdentity(database, {
    profileId: resolved.profile.id,
    bindingRevision: resolved.binding.bindingRevision,
    platform,
    accountKey: identity.accountKey
  });
  return { ...resolved, runtime, identity };
}

function browserBindingError(code: 'BROWSER_NEEDS_USER', message: string): Error {
  return Object.assign(new Error(message), { code, details: { state: 'needs_user' } });
}
