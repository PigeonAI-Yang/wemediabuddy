import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createContentProject, getStudio, saveCoreVersion, savePlatformVersion } from './content.ts';
import { migrateDatabase } from './db/migrations.ts';
import { getToday } from './workbench.ts';
import { saveCurrentPlan, type PlanItemInput } from './planning.ts';
import { getSource, searchSources, upsertSource, type SourceInput } from './sources.ts';
import { listAssets } from './assets.ts';
import { listFinalReviewsAndFindings, listReviews, saveReview } from './reviews.ts';
import { listPublicationMetricSnapshots } from './metrics.ts';
import * as z from 'zod';

export type McpRuntime = { url: string; close: () => Promise<void> };

const text = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });

function createServerFor(rootPath: string): McpServer {
  const server = new McpServer({ name: 'wemedia-buddy', version: '0.1.0' });
  const database = () => migrateDatabase(path.join(rootPath, 'wmb.db'));

  server.registerTool('context.get_workbench', { description: '读取今日工作、待办、最近资料与当前运营方案。' }, async () => {
    const db = database(); try { return text(getToday(db, new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()))); } finally { db.close(); }
  });
  server.registerTool('plans.get', { description: '读取指定日期或今日的当前运营方案。' }, async () => {
    const db = database(); try { return text(getToday(db, new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())).plan); } finally { db.close(); }
  });
  server.registerTool('content.get', { description: '读取内容项目、版本与平台版本。' }, async () => {
    const db = database(); try { return text(getStudio(db)); } finally { db.close(); }
  });
  server.registerTool('assets.list', { description: '读取已导入素材元数据。' }, async () => {
    const db = database();
    try { return text(listAssets(db)); } finally { db.close(); }
  });
  server.registerTool('sources.get', { description: '按 ID 读取完整资料。', inputSchema: { id: z.string() } }, async ({ id }) => {
    const db = database(); try { return text(getSource(db, id)); } finally { db.close(); }
  });
  server.registerTool('sources.search', {
    description: '搜索并读取完整资料字段。',
    inputSchema: { query: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }
  }, async ({ query, limit }) => {
    const db = database(); try { return text(searchSources(db, query, limit)); } finally { db.close(); }
  });
  server.registerTool('sources.upsert_batch', {
    description: '新增或更新资料；同一 request_id 重放原始结果。',
    inputSchema: { request_id: z.string(), items: z.array(z.object({
      title: z.string(), feedId: z.string().optional(), originalUrl: z.string().optional(), author: z.string().optional(),
      publishedAt: z.string().optional(), summary: z.string().optional(), categories: z.array(z.string()).optional(),
      keywords: z.array(z.string()).optional(), valueJudgment: z.string().optional(), ipRelevance: z.string().optional(),
      creationAngles: z.string().optional(), recommendedPlatforms: z.array(z.string()).optional(),
      recommendedFormats: z.array(z.string()).optional(), timeliness: z.string().optional(), priority: z.number().optional(),
      evidence: z.string().optional(), clientLabel: z.string().optional(), expectedRevision: z.number().int().optional()
    })) }
  }, async ({ request_id, items }) => {
    const db = database();
    try {
      const prior = db.prepare('SELECT result_json AS resultJson FROM mcp_request_results WHERE tool = ? AND request_id = ?').get('sources.upsert_batch', request_id) as { resultJson: string } | undefined;
      if (prior) return text(JSON.parse(prior.resultJson));
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = items.map((item) => upsertSource(db, item as SourceInput));
        const payload = { ok: true, data: result, error: null };
        db.prepare('INSERT INTO mcp_request_results (tool, request_id, result_json, created_at) VALUES (?, ?, ?, ?)').run('sources.upsert_batch', request_id, JSON.stringify(payload), new Date().toISOString());
        db.exec('COMMIT'); return text(payload);
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } finally { db.close(); }
  });
  server.registerTool('content.create', { description: '创建内容项目。', inputSchema: { request_id: z.string(), title: z.string(), source_ids: z.array(z.string()).optional() } }, async ({ request_id, title, source_ids }) => {
    const db = database(); try {
      const prior = db.prepare('SELECT result_json AS resultJson FROM mcp_request_results WHERE tool=? AND request_id=?').get('content.create', request_id) as { resultJson: string } | undefined;
      if (prior) return text(JSON.parse(prior.resultJson));
      db.exec('BEGIN IMMEDIATE'); try { const payload = { ok: true, data: createContentProject(db, { title, sourceIds: source_ids }, false), error: null }; db.prepare('INSERT INTO mcp_request_results (tool, request_id, result_json, created_at) VALUES (?, ?, ?, ?)').run('content.create', request_id, JSON.stringify(payload), new Date().toISOString()); db.exec('COMMIT'); return text(payload); } catch (error) { db.exec('ROLLBACK'); throw error; }
    } finally { db.close(); }
  });
  server.registerTool('plans.save', { description: '保存完整当日运营方案。', inputSchema: {
    request_id: z.string(), plan_date: z.string(), summary: z.string(), items: z.array(z.object({
      title: z.string(), priority: z.number(), whyNow: z.string(), timeliness: z.string(), targetAudience: z.string(),
      angle: z.string(), pointOfView: z.string(), platforms: z.array(z.string()), formats: z.array(z.string()),
      titleGuidance: z.string(), openingGuidance: z.string(), structureGuidance: z.string(), effortEstimate: z.string(),
      sourceIds: z.array(z.string()).min(1), availableMaterials: z.array(z.string()).optional(),
      missingMaterials: z.array(z.string()).optional(),
      reviewIds: z.array(z.string()).optional(), methodFindingIds: z.array(z.string()).optional(), topicId: z.string().optional()
    }))
  } }, async ({ request_id, plan_date, summary, items }) => {
    const db = database(); try {
      const prior = db.prepare('SELECT result_json AS resultJson FROM mcp_request_results WHERE tool=? AND request_id=?').get('plans.save', request_id) as { resultJson: string } | undefined;
      if (prior) return text(JSON.parse(prior.resultJson));
      db.exec('BEGIN IMMEDIATE'); try { const payload = { ok: true, data: saveCurrentPlan(db, { planDate: plan_date, timezone: 'Asia/Shanghai', summary, items: items as PlanItemInput[] }, false), error: null }; db.prepare('INSERT INTO mcp_request_results (tool, request_id, result_json, created_at) VALUES (?, ?, ?, ?)').run('plans.save', request_id, JSON.stringify(payload), new Date().toISOString()); db.exec('COMMIT'); return text(payload); } catch (error) { db.exec('ROLLBACK'); throw error; }
    } finally { db.close(); }
  });
  server.registerTool('content.save_version', { description: '保存核心或平台版本。', inputSchema: { request_id: z.string(), project_id: z.string(), body: z.string(), content_version_id: z.string().optional(), platform: z.enum(['x', 'xiaohongshu', 'wechat']).optional(), format: z.string().optional(), expected_revision: z.number().optional(), version_id: z.string().optional(), title: z.string().optional() } }, async (input) => {
    const db = database(); try {
      const prior = db.prepare('SELECT result_json AS resultJson FROM mcp_request_results WHERE tool=? AND request_id=?').get('content.save_version', input.request_id) as { resultJson: string } | undefined;
      if (prior) return text(JSON.parse(prior.resultJson));
      db.exec('BEGIN IMMEDIATE'); try {
        const data = input.platform ? savePlatformVersion(db, { projectId: input.project_id, contentVersionId: input.content_version_id!, platform: input.platform, format: input.format!, title: input.title, body: input.body, expectedRevision: input.expected_revision, id: input.version_id }) : saveCoreVersion(db, input.project_id, input.body);
        const payload = 'ok' in data ? data : { ok: true, data, error: null };
        db.prepare('INSERT INTO mcp_request_results (tool, request_id, result_json, created_at) VALUES (?, ?, ?, ?)').run('content.save_version', input.request_id, JSON.stringify(payload), new Date().toISOString()); db.exec('COMMIT'); return text(payload);
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } finally { db.close(); }
  });
  server.registerTool('metrics.get', {
    description: '读取发布指标快照。',
    inputSchema: { publication_id: z.string() }
  }, async ({ publication_id }) => {
    const db = database();
    try { return text(listPublicationMetricSnapshots(db, publication_id)); }
    finally { db.close(); }
  });
  server.registerTool('reviews.get', {
    description: '读取复盘与方法结论。',
    inputSchema: { publication_id: z.string().optional(), final_only: z.boolean().optional() }
  }, async ({ publication_id, final_only }) => {
    const db = database();
    try {
      if (final_only) return text(listFinalReviewsAndFindings(db));
      return text(listReviews(db, publication_id));
    } finally { db.close(); }
  });
  server.registerTool('reviews.save', {
    description: '保存或定稿复盘；最终复盘必须引用真实指标快照并包含 Keep/Stop/Change。',
    inputSchema: {
      request_id: z.string(),
      publication_id: z.string(),
      metric_snapshot_ids: z.array(z.string()).min(1),
      keep: z.array(z.string()).optional(),
      stop: z.array(z.string()).optional(),
      change: z.array(z.string()).optional(),
      summary: z.string().optional(),
      status: z.enum(['draft', 'final']).optional(),
      expected_revision: z.number().int().optional(),
      id: z.string().optional(),
      findings: z.array(z.object({ id: z.string().optional(), title: z.string(), body: z.string() })).optional()
    }
  }, async (input) => {
    const db = database();
    try {
      const prior = db.prepare('SELECT result_json AS resultJson FROM mcp_request_results WHERE tool=? AND request_id=?')
        .get('reviews.save', input.request_id) as { resultJson: string } | undefined;
      if (prior) return text(JSON.parse(prior.resultJson));
      const saved = saveReview(db, {
        id: input.id,
        publicationId: input.publication_id,
        metricSnapshotIds: input.metric_snapshot_ids,
        keep: input.keep,
        stop: input.stop,
        change: input.change,
        summary: input.summary,
        status: input.status,
        expectedRevision: input.expected_revision,
        findings: input.findings
      });
      const payload = saved.ok ? { ok: true, data: saved.data, error: null } : { ok: false, data: null, error: saved.error };
      if (saved.ok) {
        db.prepare('INSERT INTO mcp_request_results (tool, request_id, result_json, created_at) VALUES (?, ?, ?, ?)')
          .run('reviews.save', input.request_id, JSON.stringify(payload), new Date().toISOString());
      }
      return text(payload);
    } finally { db.close(); }
  });
  return server;
}

export async function startMcp(rootPath: string): Promise<McpRuntime> {
  const handler = toNodeHandler(createMcpHandler(() => createServerFor(rootPath)));
  const http = createServer((request, response) => {
    if (request.url?.split('?')[0] !== '/mcp') { response.writeHead(404).end(); return; }
    void handler(request, response);
  });
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('MCP 服务未取得监听地址。');
  return { url: `http://127.0.0.1:${address.port}/mcp`, close: () => close(http) };
}

function close(http: Server): Promise<void> { return new Promise((resolve, reject) => http.close((error) => error ? reject(error) : resolve())); }
