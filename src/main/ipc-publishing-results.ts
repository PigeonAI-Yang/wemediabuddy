import { ipcMain } from 'electron';
import type { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import type { DataRoot } from './data-root';
import { migrateDatabase } from './db/migrations';
import { readBrowserConfig, startBrowser, type BrowserRuntime } from './browser';
import { createPublication, getPublicationDetail, listPublicationDetails, preparePublication, reconcileAsNotPublished, transitionPublication } from './publishing';
import { saveAccount, verifyAccount } from './accounts';
import { collectXAccountMetrics, collectXMetrics, identifyXAccount, prepareXImage, prepareXText, prepareXVideo } from './platforms/x';
import { identifyWechatAccount, prepareWechatArticle, readBackWechatArticle } from './platforms/wechat';
import { claimDueMetricJobs, completeMetricJob, failMetricJob, listAccountMetricSnapshots, listMetricJobs, listPublicationMetricSnapshots, processDueMetricJobs, saveAccountMetricSnapshot, savePublicationMetricSnapshot, schedulePublicationMetricJobs } from './metrics';
import { getReview, listReviewBacklinks, listReviews, saveReview } from './reviews';

type Dependencies = {
  loadSelectedDataRoot: () => Promise<DataRoot | null>;
  getBrowser: () => BrowserRuntime | null;
  setBrowser: (runtime: BrowserRuntime) => void;
};

export function registerPublishingResultsIpc({ loadSelectedDataRoot, getBrowser, setBrowser }: Dependencies): void {
  const ensureBrowser = async (database: DatabaseSync): Promise<BrowserRuntime> => {
    const current = getBrowser();
    if (current) return current;
    const config = readBrowserConfig(database);
    if (!config) throw new Error('请先在设置中选择浏览器 profile。');
    const runtime = await startBrowser(config, { mode: 'quiet' });
    setBrowser(runtime);
    return runtime;
  };

  ipcMain.handle('publish:list', async () => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) return [];
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try { return listPublicationDetails(database); } finally { database.close(); }
  });
  ipcMain.handle('metrics:collect-x', async (_event, publicationId: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try {
      const publication = getPublicationDetail(database, publicationId)?.publication;
      if (!publication || publication.platform !== 'x' || publication.status !== 'published' || !publication.externalUrl || !publication.publishedAt) {
        throw new Error('只有已发布的 X 内容可以采集指标。');
      }
      schedulePublicationMetricJobs(database, {
        publicationId: publication.id,
        publishedAt: publication.publishedAt,
        sourceUrl: publication.externalUrl,
        platform: publication.platform
      });
      const browser = await ensureBrowser(database);
      const capture = await collectXMetrics(browser.cdpUrl, publication.externalUrl);
      const now = capture.capturedAt || new Date().toISOString();
      const due = claimDueMetricJobs(database, now);
      const snapshots = [];
      for (const job of due) {
        const payload = job.payload as { publicationId?: string; scheduledFor?: string; sourceUrl?: string };
        if (payload.publicationId !== publication.id) continue;
        const saved = completeMetricJob(database, {
          jobId: job.id,
          publicationId: publication.id,
          scheduledFor: String(payload.scheduledFor || job.dueAt),
          sourceUrl: capture.sourceUrl,
          capturedAt: capture.capturedAt,
          normalized: capture.normalized,
          raw: capture.raw
        });
        if (saved.ok) snapshots.push(saved.data);
        else failMetricJob(database, job.id, saved.error.message);
      }
      const manual = savePublicationMetricSnapshot(database, {
        publicationId: publication.id,
        scheduledFor: now,
        sourceUrl: capture.sourceUrl,
        capturedAt: capture.capturedAt,
        normalized: capture.normalized,
        raw: capture.raw
      });
      if (!manual.ok) throw new Error(manual.error.message);
      return { ...capture, snapshot: manual.data, dueSnapshots: snapshots };
    } finally { database.close(); }
  });
  ipcMain.handle('metrics:schedule', async (_event, publicationId: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try {
      const publication = getPublicationDetail(database, publicationId)?.publication;
      if (!publication?.externalUrl || !publication.publishedAt || publication.status !== 'published') {
        throw new Error('只有已发布且有 URL 的内容可以创建指标任务。');
      }
      return schedulePublicationMetricJobs(database, {
        publicationId: publication.id,
        publishedAt: publication.publishedAt,
        sourceUrl: publication.externalUrl,
        platform: publication.platform
      });
    } finally { database.close(); }
  });
  ipcMain.handle('metrics:list-jobs', async (_event, publicationId?: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) return [];
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try { return listMetricJobs(database, publicationId); } finally { database.close(); }
  });
  ipcMain.handle('metrics:list-snapshots', async (_event, publicationId?: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) return [];
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try { return listPublicationMetricSnapshots(database, publicationId); } finally { database.close(); }
  });
  ipcMain.handle('metrics:process-due', async () => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try {
      return await processDueMetricJobs(database, async (platform, sourceUrl) => {
        if (platform !== 'x') throw new Error(`暂不支持平台指标采集：${platform}`);
        const browser = await ensureBrowser(database);
        return collectXMetrics(browser.cdpUrl, sourceUrl);
      });
    } finally { database.close(); }
  });
  ipcMain.handle('metrics:collect-account-x', async () => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try {
      const account = database.prepare(`SELECT id, account_key AS accountKey FROM platform_accounts WHERE platform = 'x'`).get() as { id: string; accountKey: string } | undefined;
      if (!account) throw new Error('请先识别并保存 X 账号。');
      const browser = await ensureBrowser(database);
      const capture = await collectXAccountMetrics(browser.cdpUrl, account.accountKey);
      return saveAccountMetricSnapshot(database, {
        accountId: account.id,
        platform: 'x',
        sourceUrl: capture.sourceUrl,
        capturedAt: capture.capturedAt,
        normalized: capture.normalized,
        raw: capture.raw
      });
    } finally { database.close(); }
  });
  ipcMain.handle('metrics:list-account-snapshots', async (_event, accountId?: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) return [];
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try { return listAccountMetricSnapshots(database, accountId); } finally { database.close(); }
  });
  ipcMain.handle('reviews:list', async (_event, publicationId?: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) return [];
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try { return listReviews(database, publicationId); } finally { database.close(); }
  });
  ipcMain.handle('reviews:get', async (_event, id: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) return null;
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try { return getReview(database, id); } finally { database.close(); }
  });
  ipcMain.handle('reviews:save', async (_event, input: {
    id?: string;
    publicationId: string;
    metricSnapshotIds: string[];
    keep?: string[];
    stop?: string[];
    change?: string[];
    summary?: string;
    status?: 'draft' | 'final';
    expectedRevision?: number;
    findings?: Array<{ id?: string; title: string; body: string }>;
  }) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try { return saveReview(database, input); } finally { database.close(); }
  });
  ipcMain.handle('reviews:backlinks', async (_event, input?: { reviewIds?: string[]; findingIds?: string[] }) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) return [];
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try {
      return listReviewBacklinks(database, input?.reviewIds ?? [], input?.findingIds ?? []);
    } finally { database.close(); }
  });
  ipcMain.handle('publish:prepare-x', async (_event, platformVersionId: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const configDatabase = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    const browser = await ensureBrowser(configDatabase);
    configDatabase.close();
    const identity = await identifyXAccount(browser.cdpUrl);
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try {
      const existing = database.prepare("SELECT id FROM platform_accounts WHERE platform = 'x'").get() as { id: string } | undefined;
      if (existing) {
        const verified = verifyAccount(database, identity);
        if (!verified.ok) return verified;
      }
      const account = existing ?? saveAccount(database, identity);
      const version = database.prepare("SELECT body, format, asset_ids_json AS assets FROM platform_versions WHERE id = ? AND platform = 'x'").get(platformVersionId) as { body: string; format: string; assets: string } | undefined;
      const assetIds = version ? JSON.parse(version.assets) as string[] : [];
      if (!version || !((version.format === 'text' && !assetIds.length) || (['image', 'video'].includes(version.format) && assetIds.length === 1))) throw new Error('X 版本必须是纯文字、正文加一张图片或正文加一个视频。');
      const reusable = database.prepare(`SELECT id FROM publications
        WHERE platform_version_id = ? AND account_id = ? AND status IN ('draft', 'failed', 'needs_user')
        ORDER BY updated_at DESC LIMIT 1`).get(platformVersionId, account.id) as { id: string } | undefined;
      const created = reusable ? { ok: true as const, data: getPublicationDetail(database, reusable.id)!.publication, error: null } : createPublication(database, { platformVersionId, accountId: account.id });
      if (!created.ok) return created;
      const asset = assetIds.length ? database.prepare('SELECT id, relative_path AS relativePath, mime_type AS mimeType FROM assets WHERE id = ?').get(assetIds[0]) as { id: string; relativePath: string; mimeType: string } | undefined : undefined;
      if (assetIds.length && !asset) throw new Error('绑定图片不存在。');
      const readback = asset
        ? version.format === 'video'
          ? await prepareXVideo(browser.cdpUrl, version.body, path.join(dataRoot.path, asset.relativePath), asset.id)
          : await prepareXImage(browser.cdpUrl, version.body, path.join(dataRoot.path, asset.relativePath), asset.id)
        : await prepareXText(browser.cdpUrl, version.body);
      return preparePublication(database, { publicationId: created.data.id, expectedRevision: created.data.revision, editorTitle: null, editorBody: readback.body, editorAssetIds: readback.assetIds, editorEvidenceUrl: readback.evidenceUrl });
    } finally { database.close(); }
  });
  ipcMain.handle('publish:prepare-wechat-article', async (_event, platformVersionId: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try {
      const browser = await ensureBrowser(database);
      const identity = await identifyWechatAccount(browser.cdpUrl);
      const existing = database.prepare("SELECT id FROM platform_accounts WHERE platform = 'wechat'").get() as { id: string } | undefined;
      if (existing) {
        const verified = verifyAccount(database, identity);
        if (!verified.ok) return verified;
      }
      const account = existing ?? saveAccount(database, identity);
      const version = database.prepare("SELECT title, body, format, asset_ids_json AS assets FROM platform_versions WHERE id = ? AND platform = 'wechat'").get(platformVersionId) as { title: string | null; body: string; format: string; assets: string } | undefined;
      if (!version?.title || !version.body.trim() || version.format !== 'article') throw new Error('微信公众号版本必须包含非空标题和正文。');
      const reusable = database.prepare(`SELECT id FROM publications
        WHERE platform_version_id = ? AND account_id = ? AND status IN ('draft', 'failed', 'needs_user')
        ORDER BY updated_at DESC LIMIT 1`).get(platformVersionId, account.id) as { id: string } | undefined;
      const created = reusable ? { ok: true as const, data: getPublicationDetail(database, reusable.id)!.publication, error: null } : createPublication(database, { platformVersionId, accountId: account.id });
      if (!created.ok) return created;
      const readback = await prepareWechatArticle(browser.cdpUrl, version.title, version.body);
      return preparePublication(database, { publicationId: created.data.id, expectedRevision: created.data.revision, editorTitle: readback.title, editorBody: readback.body, editorAssetIds: readback.assetIds, editorEvidenceUrl: readback.evidenceUrl });
    } finally { database.close(); }
  });
  ipcMain.handle('publish:readback-wechat', async (_event, publicationId: string, expectedRevision: number, articleUrl: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try {
      const detail = getPublicationDetail(database, publicationId);
      if (!detail || detail.publication.platform !== 'wechat' || !detail.payload?.title) throw new Error('微信公众号发布记录或标题不存在。');
      const browser = await ensureBrowser(database);
      const readback = await readBackWechatArticle(browser.cdpUrl, articleUrl, detail.payload.title);
      return transitionPublication(database, publicationId, 'published', {
        expectedRevision,
        externalUrl: readback.externalUrl,
        externalId: readback.externalId,
        reason: 'manual publication URL readback matched'
      });
    } finally { database.close(); }
  });
  ipcMain.handle('publish:reconcile-not-published', async (_event, publicationId: string, expectedRevision: number) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try { return reconcileAsNotPublished(database, { publicationId, expectedRevision, evidence: { actor: 'ui', decision: 'not_published' } }); } finally { database.close(); }
  });
}
