import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { migrateDatabase } from './db/migrations.ts';
import { listSourceScanReceipts } from './intelligence-channels.ts';
import { readChannelProposalContext } from './intelligence-channel-confirmation.ts';
import type { ChannelProposalChangeInput } from './intelligence-channel-proposals.ts';
import { currentXListContextForRoot } from './x-list-context.ts';
import { resolveXListCandidates, type XListCandidate, type XListResolution } from './x-list-channel.ts';
import { resolveWebsiteCandidates, trialReadWebsite, type WebsiteCandidate } from './website-channel.ts';
import { readCurrentWorkspaceSnapshot, type WorkspaceApplicationMcp } from './workspace-mcp.ts';

const text = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
const changeSchema = z.object({
  action: z.enum(['add', 'enable', 'disable', 'remove']),
  module: z.enum(['official_web', 'x_lists']),
  source_id: z.string().optional(),
  expected_revision: z.number().int().optional(),
  input_text: z.string().optional(),
  candidate: z.unknown().optional(),
  trial_read: z.unknown().optional(),
  resolution: z.unknown().optional()
});

export function registerIntelligenceChannelsMcp(server: McpServer, rootPath: string, application: WorkspaceApplicationMcp): void {
  const current = () => readCurrentWorkspaceSnapshot(rootPath, application.listWorkspaces);
  server.registerTool('intelligence_channels.get', { description: '读取当前工作空间官网与 X Lists 渠道、就绪状态和来源身份。' }, async () => {
    try { return text({ ok: true, data: await current(), error: null }); }
    catch (error) { return failure(error); }
  });
  server.registerTool('intelligence_channels.receipts_list', {
    description: '读取当前根最近的逐来源扫描回执。', inputSchema: { limit: z.number().int().min(1).max(500).optional() }
  }, async ({ limit }) => {
    try {
      const snapshot = await current();
      const receipts = withDatabase(rootPath, (database) => listSourceScanReceipts(database, { workspaceId: snapshot.id, limit }));
      return text({ ok: true, data: receipts, error: null });
    } catch (error) { return failure(error); }
  });
  server.registerTool('intelligence_channels.resolve_website', {
    description: '只读解析公开网站名称或 URL，返回待试读候选。', inputSchema: { input_text: z.string() }
  }, async ({ input_text }) => {
    try { await current(); return text({ ok: true, data: await resolveWebsiteCandidates({ inputText: input_text }), error: null }); }
    catch (error) { return failure(error); }
  });
  server.registerTool('intelligence_channels.trial_website', {
    description: '只读试读一个已解析的网站候选，不创建来源。', inputSchema: { url: z.string() }
  }, async ({ url }) => {
    try { await current(); return text({ ok: true, data: await trialReadWebsite({ url }), error: null }); }
    catch (error) { return failure(error); }
  });
  server.registerTool('intelligence_channels.resolve_x_list', {
    description: '只读从当前工作空间账号实际可访问的 X List 中解析名称、URL 或 ID。', inputSchema: { input_text: z.string() }
  }, async ({ input_text }) => {
    try {
      await current();
      const xContext = await xContextFor(rootPath);
      const result = await withDatabaseAsync(rootPath, (database) => resolveXListCandidates(database, xContext.config, { inputText: input_text }, async () => xContext.index));
      return text(result);
    } catch (error) { return failure(error); }
  });
  server.registerTool('intelligence_channels.proposals.prepare', {
    description: '准备当前 Main 会话内的精确官网/X List 批量来源变更；只准备，最终确认只能由 WMB UI 完成。',
    inputSchema: { request_id: z.string(), changes: z.array(changeSchema).min(1) }
  }, async ({ request_id, changes }) => {
    try {
      const snapshot = await current();
      const proposal = withDatabase(rootPath, (database) => application.channelProposals!.prepare({
        requestId: request_id,
        changes: changes.map(toChange)
      }, readChannelProposalContext(database)));
      if (proposal.workspaceId !== snapshot.id || proposal.profileRevision !== snapshot.profile.revision) throw stale('工作空间或配方已变化，请重新准备。');
      return text({ ok: true, data: proposal, error: null });
    } catch (error) { return failure(error); }
  });
}

function toChange(change: z.infer<typeof changeSchema>): ChannelProposalChangeInput {
  if (change.action === 'add' && change.module === 'official_web') {
    return { action: 'add', module: 'official_web', inputText: change.input_text ?? '', candidate: change.candidate as WebsiteCandidate, trialRead: change.trial_read as Awaited<ReturnType<typeof trialReadWebsite>> };
  }
  if (change.action === 'add' && change.module === 'x_lists') {
    return { action: 'add', module: 'x_lists', resolution: change.resolution as XListResolution, candidate: change.candidate as XListCandidate };
  }
  return { action: change.action as 'enable' | 'disable' | 'remove', module: change.module, sourceId: change.source_id ?? '', expectedRevision: change.expected_revision ?? Number.NaN };
}

function withDatabase<T>(rootPath: string, action: (database: ReturnType<typeof migrateDatabase>) => T): T {
  const database = migrateDatabase(path.join(rootPath, 'wmb.db'));
  try { return action(database); } finally { database.close(); }
}

async function withDatabaseAsync<T>(rootPath: string, action: (database: ReturnType<typeof migrateDatabase>) => Promise<T>): Promise<T> {
  const database = migrateDatabase(path.join(rootPath, 'wmb.db'));
  try { return await action(database); } finally { database.close(); }
}

function failure(error: unknown) {
  const code = typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'VALIDATION_ERROR';
  return text({ ok: false, data: null, error: { code, message: error instanceof Error ? error.message : String(error), details: {} } });
}
async function xContextFor(rootPath: string) {
  try { return await currentXListContextForRoot({ path: rootPath, isNew: false }, { allowMissingExpectedAccount: true }); }
  catch (error) { throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { code: (error as { code?: string })?.code ?? 'BROWSER_NEEDS_USER' }); }
}
function stale(message: string): Error { return Object.assign(new Error(message), { code: 'CONFIRMATION_STALE' }); }
