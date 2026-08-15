import { randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import type { BrowserRuntime } from './browser';
import { startVerifiedBoundBrowser, type BoundBrowserPlatform } from './bound-browser.ts';
import { getPublicationDetail, listPublicationDetails } from './publishing';
import { collectXAccountMetrics, collectXMetrics } from './platforms/x';
import { listAccountMetricSnapshots, listMetricJobs, listPublicationMetricSnapshots } from './metrics';
import { dispatchClaimDueMetricJobs, dispatchCompleteMetricJob, dispatchFailMetricJob, dispatchSaveAccountMetricSnapshot, dispatchSavePublicationMetricSnapshot, dispatchSchedulePublicationMetricJobs, processDueMetricJobs } from './metric-commands.ts';
import { dispatchSaveReview, getReview, listReviewBacklinks, listReviews, type SaveReviewInput } from './reviews';
import { requireReceiptData, receiptAsCommandResult } from './business-command.ts';
import type { ActiveWorkspaceRuntime, WorkspaceRuntimeLease } from './workspace-runtime.ts';
import { dispatchCreatePublicationSnapshot, dispatchManualWechatReadback, dispatchPreparePublicationEditor, dispatchReconcilePublication, dispatchReturnPublicationToEdit, readPublicationOperationContext } from './publication-commands.ts';
import { getPublicationBrowserOperation } from './publication-operations.ts';

type Dependencies = {
  setBrowser: (runtime: BrowserRuntime) => WorkspaceRuntimeLease;
  getActiveRuntime: () => ActiveWorkspaceRuntime | null;
};

export function registerPublishingResultsIpc({ setBrowser, getActiveRuntime }: Dependencies): void {
  const requireRuntime = (expected?: ActiveWorkspaceRuntime): ActiveWorkspaceRuntime => {
    const runtime = getActiveRuntime();
    if (!runtime?.isActive || (expected && runtime !== expected)) throw Object.assign(new Error('当前工作空间运行时不可用。'), { code: 'WORKSPACE_STALE' });
    return runtime;
  };
  const ensureRuntimeBrowser = async (runtime: ActiveWorkspaceRuntime, platform: BoundBrowserPlatform): Promise<{ browser: BrowserRuntime; lease: WorkspaceRuntimeLease }> => {
    requireRuntime(runtime);
    const resolved = await startVerifiedBoundBrowser(runtime.database, platform, { mode: 'quiet' });
    requireRuntime(runtime);
    return { browser: resolved.runtime, lease: setBrowser(resolved.runtime) };
  };

  ipcMain.handle('metrics:collect-x', async (_event, publicationId: string, requestId?: string) => {
    const runtime = requireRuntime();
    const publication = getPublicationDetail(runtime.database, publicationId)?.publication;
    if (!publication || publication.platform !== 'x' || publication.status !== 'published' || !publication.externalUrl || !publication.publishedAt) {
      throw new Error('只有已发布的 X 内容可以采集指标。');
    }
    const { browser, lease } = await ensureRuntimeBrowser(runtime, 'x');
    requireRuntime(runtime);
    requireReceiptData(await dispatchSchedulePublicationMetricJobs(runtime, requestId ? `${requestId}:schedule` : randomUUID(), {
      publicationId: publication.id,
      publishedAt: publication.publishedAt,
      sourceUrl: publication.externalUrl,
      platform: publication.platform,
      expectedRevision: publication.revision
    }));
    requireRuntime(runtime);
    const capture = await runtime.runExternalBrowserWork(lease, () => collectXMetrics(browser.cdpUrl, publication.externalUrl!));
    requireRuntime(runtime);
    const current = getPublicationDetail(runtime.database, publicationId)?.publication;
    if (!current || current.revision !== publication.revision || current.externalUrl !== publication.externalUrl || current.status !== 'published') {
      throw Object.assign(new Error('发布记录已变化，请重新采集。'), { code: 'REVISION_CONFLICT' });
    }
    const now = capture.capturedAt || new Date().toISOString();
    const due = await dispatchClaimDueMetricJobs(runtime, now, 20, publication.id);
    requireRuntime(runtime);
    const snapshots = [];
    for (const job of due) {
      const completed = await dispatchCompleteMetricJob(runtime, job, capture);
      requireRuntime(runtime);
      if (completed.ok && completed.data) snapshots.push(completed.data);
      else {
        await dispatchFailMetricJob(runtime, job, completed.error?.message ?? '指标快照保存失败。');
        requireRuntime(runtime);
      }
    }
    const manual = await dispatchSavePublicationMetricSnapshot(runtime, requestId ? `${requestId}:snapshot` : randomUUID(), {
      publicationId: publication.id,
      scheduledFor: now,
      sourceUrl: capture.sourceUrl,
      capturedAt: capture.capturedAt,
      expectedRevision: current.revision,
      expectedSourceUrl: current.externalUrl,
      normalized: capture.normalized,
      raw: capture.raw
    });
    requireRuntime(runtime);
    return { ...capture, snapshot: requireReceiptData(manual), dueSnapshots: snapshots };
  });
  ipcMain.handle('metrics:schedule', async (_event, publicationId: string, requestId?: string) => {
    const runtime = requireRuntime();
    const publication = getPublicationDetail(runtime.database, publicationId)?.publication;
    if (!publication?.externalUrl || !publication.publishedAt || publication.status !== 'published') {
      throw new Error('只有已发布且有 URL 的内容可以创建指标任务。');
    }
    return receiptAsCommandResult(await dispatchSchedulePublicationMetricJobs(runtime, requestId ?? randomUUID(), {
      publicationId: publication.id,
      publishedAt: publication.publishedAt,
      sourceUrl: publication.externalUrl,
      platform: publication.platform,
      expectedRevision: publication.revision
    }));
  });
  ipcMain.handle('metrics:list-jobs', async (_event, publicationId?: string) => {
    const runtime = getActiveRuntime();
    return runtime?.isActive ? listMetricJobs(runtime.database, publicationId) : [];
  });
  ipcMain.handle('metrics:list-snapshots', async (_event, publicationId?: string) => {
    const runtime = getActiveRuntime();
    return runtime?.isActive ? listPublicationMetricSnapshots(runtime.database, publicationId) : [];
  });
  ipcMain.handle('metrics:process-due', async () => {
    const runtime = requireRuntime();
    const { browser, lease } = await ensureRuntimeBrowser(runtime, 'x');
    requireRuntime(runtime);
    return runtime.runExternalBrowserWork(lease, () => processDueMetricJobs(runtime, async (platform, sourceUrl) => {
      requireRuntime(runtime);
      if (platform !== 'x') throw new Error(`暂不支持平台指标采集：${platform}`);
      const capture = await collectXMetrics(browser.cdpUrl, sourceUrl);
      requireRuntime(runtime);
      return capture;
    }));
  });
  ipcMain.handle('metrics:collect-account-x', async (_event, requestId?: string) => {
    const runtime = requireRuntime();
    const account = runtime.database.prepare(`SELECT id, account_key AS accountKey, revision FROM platform_accounts WHERE platform = 'x'`)
      .get() as { id: string; accountKey: string; revision: number } | undefined;
    if (!account) throw new Error('请先识别并保存 X 账号。');
    const { browser, lease } = await ensureRuntimeBrowser(runtime, 'x');
    requireRuntime(runtime);
    const capture = await runtime.runExternalBrowserWork(lease, () => collectXAccountMetrics(browser.cdpUrl, account.accountKey));
    requireRuntime(runtime);
    const current = runtime.database.prepare('SELECT account_key AS accountKey, revision FROM platform_accounts WHERE id = ?')
      .get(account.id) as { accountKey: string; revision: number } | undefined;
    if (!current || current.revision !== account.revision || current.accountKey !== account.accountKey) {
      throw Object.assign(new Error('X 账号已变化，请重新采集。'), { code: 'REVISION_CONFLICT' });
    }
    return receiptAsCommandResult(await dispatchSaveAccountMetricSnapshot(runtime, requestId ?? randomUUID(), {
      accountId: account.id,
      platform: 'x',
      sourceUrl: capture.sourceUrl,
      capturedAt: capture.capturedAt,
      expectedRevision: current.revision,
      expectedAccountKey: current.accountKey,
      normalized: capture.normalized,
      raw: capture.raw
    }));
  });
  ipcMain.handle('metrics:list-account-snapshots', async (_event, accountId?: string) => {
    const runtime = getActiveRuntime();
    return runtime?.isActive ? listAccountMetricSnapshots(runtime.database, accountId) : [];
  });
  ipcMain.handle('reviews:list', async (_event, publicationId?: string) => {
    const runtime = getActiveRuntime();
    return runtime?.isActive ? listReviews(runtime.database, publicationId) : [];
  });
  ipcMain.handle('reviews:get', async (_event, id: string) => {
    const runtime = getActiveRuntime();
    return runtime?.isActive ? getReview(runtime.database, id) : null;
  });
  ipcMain.handle('reviews:save', async (_event, input: SaveReviewInput & { requestId?: string }) => {
    const runtime = requireRuntime();
    const { requestId, ...reviewInput } = input;
    return receiptAsCommandResult(await dispatchSaveReview(runtime, requestId ?? randomUUID(), reviewInput));
  });
  ipcMain.handle('reviews:backlinks', async (_event, input?: { reviewIds?: string[]; findingIds?: string[] }) => {
    const runtime = getActiveRuntime();
    return runtime?.isActive ? listReviewBacklinks(runtime.database, input?.reviewIds ?? [], input?.findingIds ?? []) : [];
  });
  ipcMain.handle('publish:list', async () => {
    const runtime = getActiveRuntime();
    if (!runtime?.isActive) return [];
    return listPublicationDetails(runtime.database).map((detail) => {
      try {
        const context = readPublicationOperationContext(runtime, detail.publication.id);
        return { ...detail, snapshot: context.snapshot, operation: context.operation };
      } catch { return detail; }
    });
  });
  ipcMain.handle('publish:snapshot-create', async (_event, input: { platformVersionId: string; requestId?: string }) => {
    const runtime = requireRuntime();
    return receiptAsCommandResult(await dispatchCreatePublicationSnapshot(runtime, input));
  });
  ipcMain.handle('publish:editor-prepare', async (_event, input: { publicationId: string; expectedRevision: number; requestId?: string }) => {
    const runtime = requireRuntime();
    return receiptAsCommandResult(await dispatchPreparePublicationEditor(runtime, input, setBrowser));
  });
  ipcMain.handle('publish:snapshot-get', (_event, publicationId: string) => {
    const runtime = requireRuntime();
    try { return readPublicationOperationContext(runtime, publicationId).snapshot; } catch { return null; }
  });
  ipcMain.handle('publish:operation-get', (_event, operationId: string) => {
    const runtime = requireRuntime();
    return getPublicationBrowserOperation(runtime.database, operationId) ?? null;
  });
  ipcMain.handle('publish:readback-wechat', async (_event, publicationId: string, expectedRevision: number, articleUrl: string) => {
    const runtime = requireRuntime();
    const { browser } = await ensureRuntimeBrowser(runtime, 'wechat');
    return receiptAsCommandResult(await dispatchManualWechatReadback(runtime, { publicationId, expectedRevision, articleUrl }, browser));
  });
  ipcMain.handle('publish:reconcile-not-published', async (_event, publicationId: string, expectedRevision: number) => {
    const runtime = requireRuntime();
    return receiptAsCommandResult(await dispatchReconcilePublication(runtime, { publicationId, expectedRevision }));
  });
  ipcMain.handle('publish:return-to-edit', async (_event, publicationId: string, expectedRevision: number) => {
    const runtime = requireRuntime();
    return receiptAsCommandResult(await dispatchReturnPublicationToEdit(runtime, { publicationId, expectedRevision }));
  });
}
