// Scratch validation of WMB-5241 window-A logic (production paths, temp data-root).
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { seedWorkflowBase } from '../tests/e2e/seed-workflow.mjs';
import { seedRichKnowledge } from '../tests/e2e/fixture-knowledge.mjs';
import { rebuildWikiIndex } from '../src/main/db/wiki-index-store.ts';
import { dispatchSourceUpsertBatch } from '../src/main/source-commands.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { setSourceKnowledgeCompileDeps, drainSourceKnowledgeCompileQueue, sourceKnowledgeCompileInFlight } from '../src/main/knowledge-compile-trigger.ts';
import { recordKnowledgeBatch } from '../src/main/knowledge.ts';
import { writeSourceBodyCache } from '../src/main/source-body-cache.ts';
import { executeWikiAction, wireDefaultWikiQueryExecutor } from '../src/main/pi-wiki-actions.ts';
import { dispatchBusinessCommand } from '../src/main/business-command.ts';
import { prepareQueryWriteback, finalizeQueryWriteback } from '../src/main/query-writeback.ts';
import { applyKnowledgeChangeSet, KNOWLEDGE_FLYWHEEL_CHANGE_SET_COMMAND } from '../src/main/knowledge-flywheel.ts';
import { searchWikiIndex } from '../src/main/knowledge-search.ts';

const ownerUiActor = { type: 'owner_ui', id: 'renderer', label: 'Owner UI' };

const root = mkdtempSync(path.join(os.tmpdir(), 'wmb5241-wina-'));
const dataRoot = root;
const workspaceId = `ws-${randomUUID()}`;
console.log('ROOT', root);

async function main() {
  await seedWorkflowBase(dataRoot, workspaceId);
  const seeded = seedRichKnowledge(dataRoot, workspaceId);
  const seedDb = migrateDatabase(path.join(dataRoot, 'wmb.db'));
  rebuildWikiIndex(seedDb, false);
  seedDb.close();

  const before = (() => {
    const db = migrateDatabase(path.join(dataRoot, 'wmb.db'));
    const c = (sql) => Number(db.prepare(sql).get().c);
    const out = { wikiVersions: c('SELECT COUNT(*) AS c FROM knowledge_wiki_page_versions'), notes: c('SELECT COUNT(*) AS c FROM knowledge_notes'), sources: c('SELECT COUNT(*) AS c FROM source_items'), artifacts: c('SELECT COUNT(*) AS c FROM knowledge_query_artifacts'), receipts: c('SELECT COUNT(*) AS c FROM knowledge_update_receipts') };
    db.close();
    return out;
  })();
  console.log('BEFORE', JSON.stringify(before));

  const runtime = ActiveWorkspaceRuntime.open(dataRoot, { openDatabase: migrateDatabase });
  const fence = (manifest) => '```json\n' + JSON.stringify(manifest, null, 2) + '\n```';
  const manifest = {
    wmb_knowledge_candidates: {
      reason: 'WMB-5241 E2E 确定性模型缝',
      topicCompile: { title: 'AI Agent 工具链', summary: 'AgentForge v2 引入多模型路由；企业版发布扩展多租户隔离与审计能力；小红书场景批量内容生成已有验证路径；路由质量评估应先跑混合样本。' },
      entities: [{ entityType: 'product', canonicalKey: 'agentforge', canonicalName: 'AgentForge', excerpt: 'AgentForge v2 企业版发布，扩展多租户隔离与审计能力。', valueRationale: '官方产品身份，可独立验证。' }],
      notes: [
        { kind: 'claim', canonicalKey: 'agentforge-v2-enterprise', statement: 'AgentForge v2 企业版支持多租户隔离与审计。', conclusionStatus: 'supported', evidenceLevel: 'primary', locator: 'L2', excerpt: 'AgentForge v2 企业版支持多租户隔离与审计。', valueRationale: '官方发布，可验证。' },
        { kind: 'claim', canonicalKey: 'agentforge-v2-audit', statement: '企业版审计日志覆盖全部路由决策。', conclusionStatus: 'supported', evidenceLevel: 'single', locator: 'L3', excerpt: '企业版审计日志覆盖全部路由决策。', valueRationale: '官方发布，可验证。' }
      ]
    }
  };
  setSourceKnowledgeCompileDeps({ databasePath: path.join(dataRoot, 'wmb.db'), modelCall: async () => fence(manifest), openDatabase: migrateDatabase });
  try {
    // A1 single ingest
    const singleRequestId = `wmb5241-single-${randomUUID()}`;
    const singleReceipt = await dispatchSourceUpsertBatch(runtime, {
      requestId: singleRequestId, actor: { type: 'owner_ui', id: 'renderer', label: 'Owner UI' },
      items: [{ title: 'AgentForge v2 企业版发布', originalUrl: 'https://news.example/agentforge-v2-enterprise', summary: 'AgentForge 官方发布 v2 企业版，扩展多租户隔离与审计能力。', author: 'News Desk' }]
    });
    console.log('SINGLE receipt ok', singleReceipt.ok, 'id', singleReceipt.data?.items?.[0]?.id, 'rev', singleReceipt.data?.items?.[0]?.revision);
    const singleSaved = singleReceipt.data.items[0];
    // 正文（可定位原文）经正式 sources:fetch-body 命令落盘（source_body_cache + 不可变 revision）
    const bodyText = [
      'AgentForge v2 企业版发布，扩展多租户隔离与审计能力。',
      'AgentForge v2 企业版支持多租户隔离与审计。',
      '企业版审计日志覆盖全部路由决策。'
    ].join('\n');
    const bodyReceipt = await dispatchBusinessCommand(runtime, {
      command: 'sources:fetch-body', requestId: `wmb5241-body-${randomUUID()}`, actor: ownerUiActor,
      input: { sourceId: singleSaved.id, url: 'https://news.example/agentforge-v2-enterprise', status: 'ready', contentType: 'text/plain', extractedText: bodyText, extractedChars: bodyText.length, errorMessage: null, fetchedAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      boundIdentity: { entityType: 'source_body_cache', entityId: singleSaved.id }, entityType: 'source_body_cache',
      execute: (database, value) => ({ data: writeSourceBodyCache(database, value), entityId: value.sourceId, readback: value })
    });
    console.log('BODY receipt ok', bodyReceipt.ok);
    const linkReceipt = await dispatchBusinessCommand(runtime, {
      command: 'knowledge.record_batch', requestId: `wmb5241-link-${randomUUID()}`, actor: ownerUiActor,
      input: { items: [{ sourceId: singleSaved.id, topic: { title: 'AI Agent 工具链', summary: 'x' } }] },
      boundIdentity: { entityType: 'knowledge_batch' }, entityType: 'knowledge_batch',
      execute: (database, normalized) => {
        const data = recordKnowledgeBatch(database, normalized, false);
        return { data, readback: data };
      }
    });
    console.log('LINK receipt ok', linkReceipt.ok, 'topicId', linkReceipt.data?.[0]?.topicId);
    const bumpReceipt = await dispatchSourceUpsertBatch(runtime, {
      requestId: `wmb5241-single-bump-${randomUUID()}`, actor: { type: 'owner_ui', id: 'renderer', label: 'Owner UI' },
      items: [{ id: singleSaved.id, expectedRevision: singleSaved.revision, title: 'AgentForge v2 企业版发布', originalUrl: 'https://news.example/agentforge-v2-enterprise', summary: 'AgentForge 官方发布 v2 企业版，扩展多租户隔离与审计能力（已更新官方文档）。', author: 'News Desk' }]
    });
    console.log('BUMP ok', bumpReceipt.ok, 'rev', bumpReceipt.data?.items?.[0]?.revision, 'expected', Number(singleSaved.revision) + 1);
    await drainSourceKnowledgeCompileQueue();
    console.log('INFLIGHT', sourceKnowledgeCompileInFlight());

    const afterSingle = (() => {
      const db = migrateDatabase(path.join(dataRoot, 'wmb.db'));
      const c = (sql) => Number(db.prepare(sql).get().c);
      const out = { wikiVersions: c('SELECT COUNT(*) AS c FROM knowledge_wiki_page_versions'), notes: c('SELECT COUNT(*) AS c FROM knowledge_notes'), wikiPages: c("SELECT COUNT(*) AS c FROM knowledge_wiki_pages WHERE lifecycle='active'"), compileOps: c("SELECT COUNT(*) AS c FROM operation_log WHERE command='knowledge.compile_source' AND result='ok'") };
      const current = db.prepare(`SELECT pv.body_json FROM knowledge_wiki_page_versions pv JOIN knowledge_wiki_pages p ON p.id = pv.page_id JOIN topics t ON t.id = p.subject_id AND p.subject_type='topic' WHERE t.title='AI Agent 工具链' ORDER BY pv.version_number DESC LIMIT 1`).get();
      db.close();
      out.currentSummary = JSON.parse(current.body_json).summary ?? '';
      return out;
    })();
    console.log('AFTER SINGLE', JSON.stringify(afterSingle));
    console.log('CROSS-PAGE delta wikiVersions', afterSingle.wikiVersions - before.wikiVersions, 'notes', afterSingle.notes - before.notes);

    // A2 batch
    const batchRequestId = `wmb5241-batch-${randomUUID()}`;
    const batchInput = { requestId: batchRequestId, actor: { type: 'owner_ui', id: 'renderer', label: 'Owner UI' }, items: [
      { title: '批量资料甲：多智能体编排综述', originalUrl: 'https://news.example/batch-a', summary: '多智能体编排综述：路由、记忆与工具边界。', author: 'E2E' },
      { title: '批量资料乙：模型路由基准对比', originalUrl: 'https://news.example/batch-b', summary: '模型路由基准对比：延迟、质量与成本。', author: 'E2E' },
      { title: '批量资料丙：Agent 工作流安全清单', originalUrl: 'https://news.example/batch-c', summary: 'Agent 工作流安全清单：审计与权限最小化。', author: 'E2E' }
    ] };
    const batchReceipt = await dispatchSourceUpsertBatch(runtime, batchInput);
    console.log('BATCH ok', batchReceipt.ok, 'items', batchReceipt.data?.items?.length);
    const replay = await dispatchSourceUpsertBatch(runtime, batchInput);
    console.log('REPLAY identical', replay.ok, JSON.stringify(replay.data) === JSON.stringify(batchReceipt.data));
    const afterBatch = (() => { const db = migrateDatabase(path.join(dataRoot, 'wmb.db')); const c = (sql) => Number(db.prepare(sql).get().c); const out = { sources: c('SELECT COUNT(*) AS c FROM source_items'), upserts: c("SELECT COUNT(*) AS c FROM command_receipts WHERE command='sources.upsert_batch'") }; db.close(); return out; })();
    console.log('AFTER BATCH', JSON.stringify(afterBatch), 'expected sources', before.sources + 4);

    // A3 query
    await wireDefaultWikiQueryExecutor();
    const refs = (() => {
      const db = migrateDatabase(path.join(dataRoot, 'wmb.db'));
      const wiki = db.prepare(`SELECT pv.id AS versionId, p.id AS pageId FROM knowledge_wiki_page_versions pv JOIN knowledge_wiki_pages p ON p.id = pv.page_id JOIN topics t ON t.id = p.subject_id AND p.subject_type='topic' WHERE t.title='AI Agent 工具链' ORDER BY pv.created_at DESC LIMIT 1`).get();
      const notes = db.prepare(`SELECT nv.id AS versionId, n.id AS noteId FROM knowledge_note_versions nv JOIN knowledge_notes n ON n.id = nv.note_id WHERE n.canonical_key IN ('agentforge-v2-multi-router','agentforge-xhs-claim') ORDER BY n.canonical_key`).all();
      db.close();
      return { wiki, notes };
    })();
    const queryResult = await executeWikiAction({ runtime, database: runtime.database }, {
      action: 'query', requestId: `wmb5241-query-${randomUUID()}`, question: 'AgentForge v2 是否支持多模型路由？',
      wikiVersionRefs: [`wiki_page:${refs.wiki.pageId}:${refs.wiki.versionId}`],
      noteVersionRefs: refs.notes.map((n) => `knowledge_note:${n.noteId}:${n.versionId}`)
    }, { actor: 'pi' });
    console.log('QUERY ok', queryResult.ok, 'wikiPages', queryResult.data?.wikiPages?.length, 'noteVersions', queryResult.data?.noteVersions?.length, 'hasContent', JSON.stringify(queryResult.data?.wikiPages ?? '').includes('多模型路由'));
    console.log('QUERY error', JSON.stringify(queryResult.error ?? ''));

    // A4 writeback（与生产 Pi settle 同路径：prepare → knowledge_flywheel.change_set_apply 命令 → finalize）
    const writebackRequestId = `query:wmb5241:${randomUUID()}`;
    const prepared = prepareQueryWriteback(runtime.database, {
      requestId: writebackRequestId, workspaceId, scope: 'global', conversationId: 'wmb5241-e2e-conv',
      question: 'AgentForge v2 是否支持多模型路由？', answerSummary: '基于冻结版本：AgentForge v2 支持多模型路由；企业版扩展多租户隔离与审计能力。',
      classification: 'new_synthesis', readWikiVersionIds: [refs.wiki.versionId], readNoteVersionIds: refs.notes.map((n) => n.versionId), readEvidenceIds: [],
      synthesis: { canonicalKey: 'wmb5241-e2e-synthesis', title: 'WMB-5241 综合：AgentForge v2 路由与企业版能力', statement: 'AgentForge v2 支持多模型路由；企业版扩展多租户隔离与审计能力。', basedOnNoteVersionIds: refs.notes.map((n) => n.versionId), valueRationale: 'E2E 固定版本读后综合，可验证。' },
      createdBy: 'background_agent', triggerSource: 'query'
    });
    let writeback;
    if (prepared.duplicate) {
      writeback = prepared.result;
    } else {
      const commandReceipt = await dispatchBusinessCommand(runtime, {
        command: KNOWLEDGE_FLYWHEEL_CHANGE_SET_COMMAND, requestId: prepared.meta.requestId, actor: ownerUiActor,
        input: prepared.segments, boundIdentity: { entityType: 'knowledge_change_set', requestId: prepared.meta.requestId }, entityType: 'knowledge_change_set',
        execute: (database, value) => {
          const result = applyKnowledgeChangeSet(database, prepared.meta, value, false);
          return { data: result, entityId: result.changeSetId, readback: result };
        }
      });
      console.log('WRITEBACK commandReceipt ok', commandReceipt.ok, JSON.stringify(commandReceipt.error ?? ''));
      if (!commandReceipt.ok) throw new Error(JSON.stringify(commandReceipt.error));
      writeback = finalizeQueryWriteback(runtime.database, prepared);
    }
    console.log('WRITEBACK ok', writeback.ok, 'page', writeback.synthesisPageId, 'pageVer', writeback.synthesisPageVersionId, 'counts', JSON.stringify(writeback.counts));
    console.log('WRITEBACK error', JSON.stringify(writeback.error ?? ''));

    // index rebuild + search
    { const { openWorkspaceDb } = await import('../tests/e2e/fixture-knowledge.mjs'); const rc = openWorkspaceDb(dataRoot); try { rebuildWikiIndex(rc, false); } finally { rc.close(); } }
    const hit = searchWikiIndex(runtime.database, { query: '企业版', limit: 20 });
    console.log('SEARCH total', hit.total ?? hit.items?.length);

    // version restore simulation (store-level, mirrors submitKnowledgeChangeSet restore path)
    const restore = await (async () => {
      const { applyKnowledgeChangeSet } = await import('../src/main/knowledge-flywheel.ts');
      const db = migrateDatabase(path.join(dataRoot, 'wmb.db'));
      const page = db.prepare(`SELECT p.id, p.scope, p.canonical_key, p.revision, p.compile_status FROM knowledge_wiki_pages p JOIN topics t ON t.id = p.subject_id AND p.subject_type='topic' WHERE t.title='AI Agent 工具链'`).get();
      const v1 = db.prepare(`SELECT id, version_number, body_json, title FROM knowledge_wiki_page_versions WHERE page_id=? ORDER BY version_number ASC LIMIT 1`).get(page.id);
      const result = applyKnowledgeChangeSet(db, { workspaceId, requestId: `wiki-restore:${page.id}:${v1.id}:${Date.now()}`, reason: `恢复主题 Wiki 到 V${v1.version_number}（用户操作）`, triggerSource: 'user', resolutionMode: 'manual_correction', createdBy: 'user' }, {
        wikiPages: [{
          id: page.id, scope: page.scope, pageType: 'topic', canonicalKey: page.canonical_key,
          title: v1.title, subjectType: 'topic', subjectId: seeded.topicA.id, beforeRevision: page.revision,
          version: { restoreFromVersionId: v1.id, changeSummary: `恢复至 V${v1.version_number}`, compileReason: 'user-restore', body: {} }
        }]
      });
      const latest = db.prepare(`SELECT pv.id, pv.version_number, pv.restored_from_version_id AS restoreFrom, p.current_version_id AS currentId FROM knowledge_wiki_page_versions pv JOIN knowledge_wiki_pages p ON p.id = pv.page_id WHERE p.id=? ORDER BY pv.version_number DESC LIMIT 1`).get(page.id);
      const count = Number(db.prepare('SELECT COUNT(*) AS c FROM knowledge_wiki_page_versions WHERE page_id=?').get(page.id).c);
      db.close();
      return { resultOk: result.ok, latest, count, v1 };
    })();
    console.log('RESTORE resultOk', restore.resultOk, 'count', restore.count, 'restoreFrom==v1', restore.latest.restoreFrom === restore.v1.id, 'current==latest', restore.latest.currentId === restore.latest.id);
  } finally {
    setSourceKnowledgeCompileDeps(null);
    await runtime.stop({ drain: false }).catch(() => {});
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows 锁残留，保留目录 */ }
  }
}
main().catch((e) => { console.error('FAIL', e); process.exit(1); });
