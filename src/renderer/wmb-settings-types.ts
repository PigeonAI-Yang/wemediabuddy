import type { BrowserProfile } from '../main/browser-config';
import type { IntelligenceChannelsSummary } from '../main/intelligence-channels';
import type { WorkspaceBrowserBinding } from '../main/workspace-browser-binding';
import type { OwnerBrowserState } from '../main/browser-profile-owner';

export type WmbSettingsSnapshot = {
  paths: Record<string, string>;
  usage: Record<string, number>;
  counts: Record<string, number>;
  health: Record<string, unknown>;
  mcp: { status: string; url: string | null };
  browser: { status: string; pid?: number; cdpUrl?: string; profilePath?: string; mode?: 'quiet' | 'visible' | 'headless' };
  browserProfiles: BrowserProfile[];
  defaultBrowserProfileId: string;
  browserRegistryRevision: number;
  browserBinding: WorkspaceBrowserBinding | null;
  boundBrowserProfile: BrowserProfile | null;
  legacyBrowserSource: OwnerBrowserState['legacySource'];
  pi: {
    activeId: string | null;
    profiles: Array<{ id: string; name: string; baseUrl: string; model: string; api: 'openai-responses' | 'openai-completions'; thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'; nativeSearch?: boolean; contextWindow?: number; maxTokens?: number; configured: boolean; active: boolean }>;
    fallbackOrder: string[];
    baseUrl: string;
    model: string;
    configured: boolean;
  };
  piRuntime: { version: string; root: string; source: 'bundled' | 'override'; previousVersion: string | null; stagingVersion: string | null };
  workspace: {
    id: string; displayName: string; rootPath: string;
    dataRoot: { workspaceId: string; path: string };
    profile: { profileId: string; revision: number; intelligencePackId: string; creationPackId: string; platforms: Array<'x' | 'xiaohongshu' | 'wechat' | 'zhihu'> };
    intelligenceChannels: IntelligenceChannelsSummary;
    browserProfileId: string | null;
    bindingRevision: number | null;
    state: WorkspaceBrowserBinding['state'] | 'missing';
    expectedAccountSnapshots: WorkspaceBrowserBinding['expectedAccountSnapshot'];
    capabilities: { xLists: true; aiIntelligence: boolean; fixedAiLists: boolean; rankings: boolean; sourceWire: boolean; publishingPlatforms: Array<'x' | 'xiaohongshu' | 'wechat' | 'zhihu'> };
  };
};
