import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { requireWorkspaceProfile } from './workspace-profiles.ts';
import { WORKSPACE_CATALOG, WorkspaceProposalStore } from './workspace-proposals.ts';
import { readIntelligenceChannelsSummary, type IntelligenceChannelsSummary } from './intelligence-channels.ts';
import type { IntelligenceChannelProposalStore } from './intelligence-channel-proposals.ts';
import { readWorkspaceBrowserBinding, type BrowserBindingState, type ExpectedAccountSnapshot } from './workspace-browser-binding.ts';

type WorkspaceListing = { activeWorkspaceId: string | null; workspaces: Array<{ id: string; displayName: string; rootPath: string }> };

const WORKSPACE_INTELLIGENCE_CAPABILITIES = {
  'wemedia-intelligence-engine': { aiIntelligence: true, fixedAiLists: true, rankings: true, sourceWire: true },
  'uk-life-content-radar': { aiIntelligence: false, fixedAiLists: false, rankings: false, sourceWire: false },
  'game-news-radar': { aiIntelligence: false, fixedAiLists: false, rankings: false, sourceWire: false }
} as const;

export type WorkspaceApplicationMcp = {
  listWorkspaces: () => Promise<WorkspaceListing>;
  proposals: WorkspaceProposalStore;
  channelProposals?: IntelligenceChannelProposalStore;
  runtimeEpoch?: string;
};

export type WorkspaceCapabilitySnapshot = {
  id: string;
  displayName: string;
  rootPath: string;
  dataRoot: { workspaceId: string; path: string };
  runtimeEpoch: string | null;
  profile: ReturnType<typeof requireWorkspaceProfile>;
  intelligenceChannels: IntelligenceChannelsSummary;
  browserProfileId: string | null;
  bindingRevision: number | null;
  state: BrowserBindingState | 'missing';
  expectedAccountSnapshots: ExpectedAccountSnapshot;
  capabilities: {
    xLists: true;
    aiIntelligence: boolean;
    fixedAiLists: boolean;
    rankings: boolean;
    sourceWire: boolean;
    publishingPlatforms: Array<'x' | 'xiaohongshu' | 'wechat'>;
  };
};

const text = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });

export async function readCurrentWorkspaceSnapshot(rootPath: string, listWorkspaces: () => Promise<WorkspaceListing>, runtimeEpoch: string | null = null): Promise<WorkspaceCapabilitySnapshot> {
  const registry = await listWorkspaces();
  const workspace = registry.workspaces.find((item) => item.id === registry.activeWorkspaceId);
  const resolvedRootPath = path.resolve(rootPath);
  const db = new DatabaseSync(path.join(resolvedRootPath, 'wmb.db'), { readOnly: true });
  try {
    const workspaceId = (db.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get() as { value?: string } | undefined)?.value;
    if (!workspace || workspace.id !== workspaceId || path.resolve(workspace.rootPath) !== resolvedRootPath) throw new Error('活动工作空间身份不一致。');
    const profile = requireWorkspaceProfile(db);
    const intelligence = WORKSPACE_INTELLIGENCE_CAPABILITIES[profile.intelligencePackId];
    const browserBinding = readWorkspaceBrowserBinding(db);
    return {
      ...workspace,
      dataRoot: { workspaceId, path: resolvedRootPath },
      runtimeEpoch,
      profile,
      intelligenceChannels: readIntelligenceChannelsSummary(db),
      browserProfileId: browserBinding?.profileId ?? null,
      bindingRevision: browserBinding?.bindingRevision ?? null,
      state: browserBinding?.state ?? 'missing',
      expectedAccountSnapshots: browserBinding?.expectedAccountSnapshot ?? {},
      capabilities: {
        xLists: true,
        ...intelligence,
        publishingPlatforms: [...profile.platforms]
      }
    };
  } finally { db.close(); }
}

export function registerWorkspaceApplicationMcp(server: McpServer, rootPath: string, application: WorkspaceApplicationMcp): void {
  const currentWorkspace = () => readCurrentWorkspaceSnapshot(rootPath, application.listWorkspaces, application.runtimeEpoch ?? null);
  server.registerTool('workspaces.list', { description: '列出应用登记的工作空间和当前活动身份。' }, async () => text(await application.listWorkspaces()));
  server.registerTool('workspaces.get_current', { description: '只读当前 MCP URL 绑定的工作空间、有效配方和浏览器 binding 快照；不提供 profile 写入。' }, async () => text(await currentWorkspace()));
  server.registerTool('workspaces.catalog', { description: '读取 WMB 编译期官方能力包和受支持平台。' }, async () => text(WORKSPACE_CATALOG));
  server.registerTool('workspaces.proposals.prepare', {
    description: '提交当前 Main 会话有效的完整自媒体配方提案；不能确认、激活或指定数据目录。',
    inputSchema: {
      request_id: z.string(), target: z.enum(['current', 'new']), purpose: z.string(), display_name: z.string(), audience: z.string(),
      content_goal: z.string(), editorial_brief: z.string(), intelligence_pack_id: z.enum(['wemedia-intelligence-engine', 'uk-life-content-radar', 'game-news-radar']),
      intelligence_pack_version: z.number().int(), creation_pack_id: z.literal('wmb-core-creation'), creation_pack_version: z.number().int(),
      platforms: z.array(z.enum(['x', 'xiaohongshu', 'wechat'])).min(1)
    }
  }, async (input) => {
    const current = input.target === 'current' ? await currentWorkspace() : null;
    try {
      const proposal = application.proposals.prepare({
        requestId: input.request_id, target: input.target, purpose: input.purpose as 'self_media', displayName: input.display_name,
        audience: input.audience, contentGoal: input.content_goal, editorialBrief: input.editorial_brief,
        intelligencePackId: input.intelligence_pack_id, intelligencePackVersion: input.intelligence_pack_version,
        creationPackId: input.creation_pack_id, creationPackVersion: input.creation_pack_version, platforms: input.platforms
      }, { workspaceId: current?.id ?? null, currentProfile: current?.profile ?? null });
      return text({ ok: true, data: proposal, error: null });
    } catch (error) {
      return text({ ok: false, data: null, error: { code: (error as { code?: string }).code ?? 'VALIDATION_ERROR', message: error instanceof Error ? error.message : String(error), details: {} } });
    }
  });
}
