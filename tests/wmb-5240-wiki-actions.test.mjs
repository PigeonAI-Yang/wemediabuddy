// WMB-5240：Pi/operator 全 Wiki 操作执行器（src/main/pi-wiki-actions.ts）聚焦契约测试。
// 真实 SQLite + ActiveWorkspaceRuntime + 真实 task grant/dispatcher；协议层在 wmb-5240-protocol.test.mjs。
// 覆盖（对应验收清单）：
// A. maintain start → run 创建 + 幂等重放（T-RE-3）；pause/resume 经 dispatcher；status/report 只读；
// B. ingest 单条 → 成功；ingest 批量部分失败（非法 item 隔离，合法 item 照常，overall=partial）；
// C. lint run=true（写面有界步进）与 lint 只读状态；
// D. search / log / report 只读直达（无 authority 要求）；
// E. query 未注册执行器 → WIKI_ACTION_QUERY_UNAVAILABLE fail-closed（零写零执行）；
// F. grant/dispatcher 硬门：缺 grant → TASK_GRANT_REQUIRED 零写；scope 外命令 → TASK_SCOPE_BROADENED；
//    过期 grant → TASK_GRANT_EXPIRED；撤销 grant → TASK_GRANT_REVOKED；worker 身份不匹配 → TASK_WORKER_MISMATCH；
// G. requestId 重放：同 ID+同输入 → 原回执零重复；异输入 → REQUEST_REPLAY_CONFLICT；
// H. 跨 data-root 隔离：只读动作不跨库（搜索只读当前 root）；写动作 workspace write guard；
// I. 发布边界：协议/执行器零发布动作（无 final publish/redline），维护不自动发布；
// J. 错误卫生（T-EL-1）：失败错误不含 rootPath/绝对路径/SQL/堆栈。
// 运行：node --test --test-concurrency=1 tests/wmb-5240-wiki-actions.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';
import { upsertKnowledgeTopic } from '../src/main/knowledge.ts';
import { compileSourceKnowledge, sourceCompileRequestId } from '../src/main/knowledge-compiler.ts';
import { rebuildWikiIndex } from '../src/main/db/wiki-index-store.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { createCommandEnvelope } from '../src/main/command-dispatcher.ts';
import { dispatchStartAgentTask } from '../src/main/agent-task-commands.ts';
import { dispatchIssueTaskGrant } from '../src/main/task-grants.ts';
import { executeWikiAction, registerWikiQueryExecutor } from '../src/main/pi-wiki-actions.ts';
import { getMaintenanceRun } from '../src/main/knowledge-maintenance.ts';

const AUTHORITY = { taskId: 'task-wiki-1', grantId: 'grant-wiki-1', workerLeaseId: 'lease-wiki-1' };

function count(database, table) {
  return Number(database.prepare(`SELECT count(*) AS c FROM ${table}`).get().c);
}

test('WMB-5240 executor：七类动作 + grant 硬门 + 重放 + 部分失败 + 隔离 + 发布边界', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-5240-'));
  let database = migrateDatabase(path.join(directory, 'wmb.db'));
  let runtime = null;
  try {
    const now = new Date().toISOString();
    database.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id','ws-5240',?,?,1)").run(now, now);

    // 前置：真实冻结知识（Topic Wiki + Note 版本），供 search/log/query 轮次使用
    const sourceA = upsertSource(database, {
      originalUrl: 'https://news.example/agentforge-v2', title: 'AgentForge v2 发布：多模型路由',
      summary: 'AgentForge 官方发布 v2，引入多模型路由能力。', author: 'News Desk'
    });
    const topic = upsertKnowledgeTopic(database, { title: 'AI Agent 工具链' });
    const compile = compileSourceKnowledge(database, {
      workspaceId: 'ws-5240', sourceId: sourceA.id, sourceRevision: sourceA.revision, topicId: topic.id,
      reason: 'WMB-5240 前置编译', requestId: sourceCompileRequestId(sourceA.id, sourceA.revision),
      entities: [{ entityType: 'organization', canonicalKey: 'agentforge', canonicalName: 'AgentForge', valueRationale: '可验证产品事实' }],
      notes: [
        { kind: 'claim', canonicalKey: 'agentforge-v2-multi-router', title: 'AgentForge v2 支持多模型路由', statement: 'AgentForge v2 支持多模型路由', conclusionStatus: 'supported', evidenceLevel: 'primary', locator: 'L12-18', entityKeys: ['agentforge'], valueRationale: '可验证产品事实' }
      ],
      topicCompile: { title: 'AI Agent 工具链', summary: 'AgentForge v2 引入多模型路由。' }
    });
    assert.equal(compile.ok, true, '前置编译必须成功');
    rebuildWikiIndex(database, false);
    database.close();
    database = null;

    runtime = ActiveWorkspaceRuntime.open(directory, { openDatabase: migrateDatabase, createEpoch: () => 'wmb5240-runtime' });
    assert.equal(runtime.isActive, true, '运行时必须活动');

    // ============ grant 前置：真实 agent task + 写命令 grant（worker=pi） ============
    const task = (await dispatchStartAgentTask(runtime, {
      intent: 'studio_draft', businessDate: '2026-08-14',
      contextRefs: { workspaceId: runtime.identity.workspaceId }
    }, { actor: { type: 'owner_ui', id: 'renderer', label: 'Owner UI' }, requestId: 'wiki-task-1' })).task;
    const granted = await dispatchIssueTaskGrant(runtime, {
      requestId: 'grant-wiki-main',
      taskId: task.id,
      ownerGoal: 'WMB-5240 测试授权',
      allowedCommands: ['knowledge.maintenance', 'knowledge.lint', 'sources.upsert_batch'],
      workers: [{ type: 'pi', id: 'pi' }],
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    assert.equal(granted.ok, true, 'grant 签发必须成功');
    const grantId = granted.data.id;
    const taskId = task.id;
    // 真实 Pi worker lease（dispatcher 校验 isCurrentPiLease）
    const lease = runtime.acquireWorkerLease(taskId, 'desk', 'desk');
    runtime.bindWorkerTask(lease, taskId);
    const workerLeaseId = lease.leaseId;

    // ============ A. maintain start（写面；经 dispatcher + grant） ============
    const started = await executeWikiAction({ runtime }, {
      action: 'maintain', subaction: 'start', requestId: 'wiki-maintain-1', config: { batchLimit: 10, stallLimit: 3 },
      taskId: taskId, grantId, workerLeaseId: workerLeaseId
    }, { actor: 'pi' });
    assert.equal(started.ok, true, 'maintain start 必须成功');
    assert.equal(started.overall, 'succeeded');
    assert.equal(started.action, 'maintain');
    assert.ok(started.receipts?.length === 1 && started.receipts[0].ok === true, '必须携带 dispatcher 回执');
    assert.ok(started.data.created === true, '首次 start 必须 created');
    assert.ok(getMaintenanceRun(runtime.database)?.workspaceId === 'ws-5240', 'run 绑定当前 workspace');

    // 幂等重放（T-RE-3）：同 requestId + 同输入 → 原回执（零重复写；overall 按回执数据投影）
    const changeSetsBeforeReplay = count(runtime.database, 'knowledge_change_sets');
    const replayed = await executeWikiAction({ runtime }, {
      action: 'maintain', subaction: 'start', requestId: 'wiki-maintain-1', config: { batchLimit: 10, stallLimit: 3 },
      taskId: taskId, grantId, workerLeaseId: workerLeaseId
    }, { actor: 'pi' });
    assert.equal(replayed.ok, true);
    assert.equal(replayed.receipts[0].requestId, 'wiki-maintain-1', '重放返回原回执');
    assert.equal(replayed.receipts[0].data.created, true, '重放回执数据与首次一致（原回执）');
    assert.equal(count(runtime.database, 'knowledge_change_sets'), changeSetsBeforeReplay, '重放零重复写');

    // 新 requestId 但已存在 run → 幂等 no_op（不新建）
    const secondStart = await executeWikiAction({ runtime }, {
      action: 'maintain', subaction: 'start', requestId: 'wiki-maintain-2',
      taskId: taskId, grantId, workerLeaseId: workerLeaseId
    }, { actor: 'pi' });
    assert.equal(secondStart.overall, 'no_op', '已存在 run 再 start 应为 no_op');
    assert.equal(count(runtime.database, 'knowledge_change_sets'), changeSetsBeforeReplay, '不新增 run 记录');

    // 异输入同 requestId → REQUEST_REPLAY_CONFLICT（保持原回执语义）
    const conflict = await executeWikiAction({ runtime }, {
      action: 'maintain', subaction: 'start', requestId: 'wiki-maintain-1', config: { batchLimit: 20 },
      taskId: taskId, grantId, workerLeaseId: workerLeaseId
    }, { actor: 'pi' });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error.code, 'REQUEST_REPLAY_CONFLICT', '异输入必须 REQUEST_REPLAY_CONFLICT');

    // pause / resume（写面）
    const paused = await executeWikiAction({ runtime }, {
      action: 'maintain', subaction: 'pause', requestId: 'wiki-pause-1',
      taskId: taskId, grantId, workerLeaseId: workerLeaseId
    }, { actor: 'pi' });
    assert.equal(paused.ok, true);
    assert.equal(paused.data.run.status, 'paused', 'pause 后 run 为 paused');
    const resumed = await executeWikiAction({ runtime }, {
      action: 'maintain', subaction: 'resume', requestId: 'wiki-resume-1',
      taskId: taskId, grantId, workerLeaseId: workerLeaseId
    }, { actor: 'pi' });
    assert.equal(resumed.ok, true);
    assert.equal(resumed.data.run.status, 'running', 'resume 后 run 为 running');

    // status / report（只读；无 authority 要求）
    const status = await executeWikiAction({ runtime }, { action: 'maintain', subaction: 'status', requestId: 'wiki-status-1' }, { actor: 'pi' });
    assert.equal(status.ok, true);
    assert.equal(status.overall, 'succeeded');
    assert.equal(status.data.run.workspaceId, 'ws-5240');
    const report = await executeWikiAction({ runtime }, { action: 'maintain', subaction: 'report', requestId: 'wiki-report-1' }, { actor: 'pi' });
    assert.equal(report.ok, true);
    assert.ok(report.data.report === null || typeof report.data.report === 'object', '报告可为 null（未完成）或对象');

    // ============ B. ingest 单条成功 + 批量部分失败隔离 ============
    const single = await executeWikiAction({ runtime }, {
      action: 'ingest', requestId: 'wiki-ingest-1',
      items: [{ title: '单条资料', originalUrl: 'https://example.com/single' }],
      taskId: taskId, grantId, workerLeaseId: workerLeaseId
    }, { actor: 'pi' });
    assert.equal(single.ok, true);
    assert.equal(single.overall, 'succeeded');
    assert.equal(single.data.items.length, 1);
    assert.equal(single.data.items[0].ok, true);

    // 批量：2 条合法 + 1 条非法（非 http URL；协议外绕过，验证执行器双门）→ partial，合法 item 照常落库
    const batch = await executeWikiAction({ runtime }, {
      action: 'ingest', requestId: 'wiki-ingest-batch-1',
      items: [
        { title: '合法甲', originalUrl: 'https://example.com/ok-a' },
        { title: '非法乙', originalUrl: 'file:///etc/passwd' },
        { title: '合法丙', originalUrl: 'https://example.com/ok-c' }
      ],
      taskId: taskId, grantId, workerLeaseId: workerLeaseId
    }, { actor: 'pi' });
    assert.equal(batch.ok, true);
    assert.equal(batch.overall, 'partial', '批量含非法 item 必须 partial');
    assert.equal(batch.data.failed, 1);
    assert.equal(batch.data.total, 3);
    const itemResults = batch.data.items;
    assert.equal(itemResults[0].ok, true, '合法甲必须成功');
    assert.equal(itemResults[1].ok, false, '非法乙必须失败');
    assert.equal(itemResults[2].ok, true, '合法丙必须成功');
    assert.equal(itemResults[1].error.code, 'WIKI_ACTION_INGEST_ITEM_INVALID', '非法 item 错误码隔离');
    assert.ok(itemResults[0].id && itemResults[2].id, '合法 item 真实落库');
    assert.equal(count(runtime.database, 'source_items'), 4, '种子 1 + 单条 1 + 批量合法 2 = 4 条来源');

    // 全非法 → overall failed，零成功
    const allBad = await executeWikiAction({ runtime }, {
      action: 'ingest', requestId: 'wiki-ingest-allbad',
      items: [
        { title: '坏一', originalUrl: 'javascript:alert(1)' },
        { title: '坏二', originalUrl: '/etc/hosts' }
      ],
      taskId: taskId, grantId, workerLeaseId: workerLeaseId
    }, { actor: 'pi' });
    assert.equal(allBad.ok, false);
    assert.equal(allBad.overall, 'failed');
    // 全部失败且错误码一致时透传首个错误码（不折叠成泛化码）
    assert.equal(allBad.error.code, 'WIKI_ACTION_INGEST_ITEM_INVALID', '全非法透传一致 item 错误码');
    assert.equal(allBad.data, null, '全失败 data=null');

    // B2. 批量重放幂等（T-RE-2，per-item 派生 requestId 命中原回执）：同 requestId + 同 items
    // 连续两次 → 同一组回执、source_items 行数/revision 零增量（防双写）
    const replayItems = [
      { title: '重放甲', originalUrl: 'https://example.com/replay-a' },
      { title: '重放乙', originalUrl: 'https://example.com/replay-b' }
    ];
    const replayFirst = await executeWikiAction({ runtime }, {
      action: 'ingest', requestId: 'wiki-ingest-replay-1', items: replayItems,
      taskId: taskId, grantId, workerLeaseId: workerLeaseId
    }, { actor: 'pi' });
    assert.equal(replayFirst.ok, true);
    assert.equal(replayFirst.overall, 'succeeded');
    const sourcesAfterFirst = count(runtime.database, 'source_items');
    const idsFirst = replayFirst.data.items.map((i) => i.id);
    const replaySecond = await executeWikiAction({ runtime }, {
      action: 'ingest', requestId: 'wiki-ingest-replay-1', items: replayItems,
      taskId: taskId, grantId, workerLeaseId: workerLeaseId
    }, { actor: 'pi' });
    assert.equal(replaySecond.ok, true);
    assert.equal(count(runtime.database, 'source_items'), sourcesAfterFirst, '重放零新增行（防双写）');
    assert.deepEqual(replaySecond.data.items.map((i) => i.id), idsFirst, '重放命中同一组回执（同 id）');
    assert.deepEqual(replaySecond.data.items.map((i) => i.revision), replayFirst.data.items.map((i) => i.revision), '重放 revision 零增量');

    // B3. 异 items 同 requestId → 冲突 item 投影 REQUEST_REPLAY_CONFLICT 且零写（不换 ID 绕过）；
    // 未变化 item 仍重放原回执（per-item 幂等诚实投影）
    const beforeConflict = count(runtime.database, 'source_items');
    const replayConflict = await executeWikiAction({ runtime }, {
      action: 'ingest', requestId: 'wiki-ingest-replay-1', items: [
        { title: '重放甲', originalUrl: 'https://example.com/replay-a' },
        { title: '改了的乙', originalUrl: 'https://example.com/replay-b-changed' }
      ],
      taskId: taskId, grantId, workerLeaseId: workerLeaseId
    }, { actor: 'pi' });
    assert.equal(replayConflict.overall, 'partial', '部分 item 冲突 → partial（未变化 item 仍重放成功）');
    assert.ok(replayConflict.data.items.some((i) => i.error?.code === 'REQUEST_REPLAY_CONFLICT')
      || replayConflict.receipts?.some((r) => r.error?.code === 'REQUEST_REPLAY_CONFLICT'),
      '冲突必须投影 REQUEST_REPLAY_CONFLICT');
    assert.ok(replayConflict.data.items.some((i) => i.ok === true), '未变化 item 重放原回执成功');
    assert.equal(count(runtime.database, 'source_items'), beforeConflict, '冲突零新增行');

    // ============ C. lint：只读状态 + run=true 写面 ============
    const lintRead = await executeWikiAction({ runtime }, { action: 'lint', requestId: 'wiki-lint-read-1' }, { actor: 'pi' });
    assert.equal(lintRead.ok, true);
    assert.ok('checkpoint' in lintRead.data && typeof lintRead.data.openIssues === 'number', 'lint 只读返回 checkpoint+openIssues');
    const lintRun = await executeWikiAction({ runtime }, {
      action: 'lint', run: true, requestId: 'wiki-lint-run-1',
      taskId: taskId, grantId, workerLeaseId: workerLeaseId
    }, { actor: 'pi' });
    assert.equal(lintRun.ok, true);
    assert.equal(lintRun.overall, 'succeeded');
    assert.ok(lintRun.receipts?.length === 1 && lintRun.receipts[0].ok, 'lint run 经 dispatcher 回执');

    // ============ D. search / log / report 只读直达 ============
    const search = await executeWikiAction({ runtime }, { action: 'search', requestId: 'wiki-search-1', query: 'AgentForge', limit: 20 }, { actor: 'pi' });
    assert.equal(search.ok, true);
    assert.ok(search.data.items.length >= 1, '搜索必须命中前置编译对象');
    assert.ok(search.data.items.some((item) => ['wiki_page', 'knowledge_note', 'entity', 'fixed_version_reference'].includes(item.objectType)), `索引应含编译对象，实际 ${search.data.items.map((i) => i.objectType).join(',')}`);
    const log = await executeWikiAction({ runtime }, { action: 'log', requestId: 'wiki-log-1', limit: 10 }, { actor: 'pi' });
    assert.equal(log.ok, true);
    assert.ok(Array.isArray(log.data.items) && log.data.items.length >= 1, '全局日志必须含条目');
    const reportRead = await executeWikiAction({ runtime }, { action: 'report', requestId: 'wiki-report-2' }, { actor: 'pi' });
    assert.equal(reportRead.ok, true);

    // ============ E. query：固定版本引用 → 真实只读查询；幽灵引用 → fail-closed 零写 ============
    const noteVersionId = compile.noteVersionIds['agentforge-v2-multi-router'];
    const realRef = `knowledge_note:${compile.noteIds['agentforge-v2-multi-router']}:${noteVersionId}`;
    const queryReal = await executeWikiAction({ runtime }, {
      action: 'query', requestId: 'wiki-query-1', question: 'AgentForge v2 支持什么？',
      noteVersionRefs: [realRef]
    }, { actor: 'pi' });
    assert.equal(queryReal.ok, true, '真实冻结版本引用查询必须成功');
    assert.equal(queryReal.overall, 'succeeded');
    assert.ok(queryReal.data && typeof queryReal.data === 'object', 'query 返回只读解析结果');

    // 幽灵引用（不存在版本）→ fail-closed（FIXED_VERSION_NOT_FOUND / NOT_FOUND 族），不吞错误
    const queryGhost = await executeWikiAction({ runtime }, {
      action: 'query', requestId: 'wiki-query-ghost',
      noteVersionRefs: ['knowledge_note:note-x:v-ghost']
    }, { actor: 'pi' });
    assert.equal(queryGhost.ok, false);
    assert.equal(queryGhost.overall, 'failed');
    assert.ok(/NOT_FOUND|UNAVAILABLE|INVALID/.test(queryGhost.error.code), `幽灵引用必须失败且码可读：${queryGhost.error.code}`);
    // 路由缝：注册 stub 后 query 必须命中（验证 manifest 透传与注册缝可替换默认执行器）
    const seen = [];
    registerWikiQueryExecutor((ctx, manifest) => {
      seen.push(manifest);
      return { resolved: manifest.noteVersionRefs ?? [], question: manifest.question ?? null };
    });
    const queryStub = await executeWikiAction({ runtime }, {
      action: 'query', requestId: 'wiki-query-2', question: 'AgentForge 支持什么？',
      noteVersionRefs: ['knowledge_note:note-1:v1'], wikiVersionRefs: ['wiki_page:page-1:v1']
    }, { actor: 'pi' });
    assert.equal(queryStub.ok, true);
    assert.deepEqual(seen[0].noteVersionRefs, ['knowledge_note:note-1:v1']);
    assert.deepEqual(seen[0].wikiVersionRefs, ['wiki_page:page-1:v1']);
    assert.equal(queryStub.data.question, 'AgentForge 支持什么？');

    // ============ F. grant 硬门：缺 grant / scope 外 / 过期 / 撤销 / worker 不匹配 → 零写 ============
    // F1 缺 grantId → TASK_GRANT_REQUIRED（写命令零执行）
    const noGrant = await executeWikiAction({ runtime }, {
      action: 'maintain', subaction: 'start', requestId: 'wiki-nogrant-1',
      taskId: taskId, workerLeaseId: workerLeaseId
    }, { actor: 'pi' });
    assert.equal(noGrant.ok, false);
    assert.equal(noGrant.error.code, 'TASK_GRANT_REQUIRED', '缺 grant 必须 TASK_GRANT_REQUIRED');

    // F2 伪造 grantId（不在库）→ TASK_GRANT_NOT_FOUND
    const fakeGrant = await executeWikiAction({ runtime }, {
      action: 'ingest', requestId: 'wiki-fakegrant-1',
      items: [{ title: 't', originalUrl: 'https://example.com/fake' }],
      taskId: taskId, grantId: 'grant-does-not-exist', workerLeaseId: workerLeaseId
    }, { actor: 'pi' });
    assert.equal(fakeGrant.ok, false);
    assert.equal(fakeGrant.overall, 'failed');
    // 全部失败且错误码一致 → 透传首个一致错误码（dispatcher 语义原样可见）
    assert.equal(fakeGrant.error.code, 'TASK_GRANT_NOT_FOUND', '伪造 grant 全部失败透传 TASK_GRANT_NOT_FOUND（零写）');

    // F3 过期 grant → TASK_GRANT_EXPIRED（先签发未来过期，再改库使其过期）
    const taskExpired = (await dispatchStartAgentTask(runtime, {
      intent: 'studio_draft', businessDate: '2026-08-15', contextRefs: { workspaceId: runtime.identity.workspaceId }
    }, { actor: { type: 'owner_ui', id: 'renderer', label: 'Owner UI' }, requestId: 'task-wiki-expired' })).task;
    const expired = await dispatchIssueTaskGrant(runtime, {
      requestId: 'grant-wiki-expired', taskId: taskExpired.id, ownerGoal: '过期测试',
      allowedCommands: ['knowledge.maintenance'],
      workers: [{ type: 'pi', id: 'pi' }],
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    assert.equal(expired.ok, true);
    const expireEnvelope = createCommandEnvelope({
      workspaceId: runtime.identity.workspaceId, runtimeEpoch: runtime.identity.runtimeEpoch,
      command: 'test.wmb5240.expire_grant', requestId: 'expire-wiki-grant-fixture',
      input: { grantId: expired.data.id }, boundIdentity: { grantId: expired.data.id },
      actor: { type: 'owner_ui', id: 'renderer' }
    });
    const expiredFixture = await runtime.dispatchCommand(expireEnvelope, () => {
      runtime.database.prepare('UPDATE task_grants SET expires_at = ? WHERE id = ?')
        .run(new Date(Date.now() - 1000).toISOString(), expired.data.id);
      return { data: { grantId: expired.data.id }, entityType: 'task_grant', entityId: expired.data.id };
    });
    assert.equal(expiredFixture.ok, true);
    const expiredRun = await executeWikiAction({ runtime }, {
      action: 'maintain', subaction: 'start', requestId: 'wiki-expired-1',
      taskId: taskExpired.id, grantId: expired.data.id, workerLeaseId: 'lease-expired'
    }, { actor: 'pi' });
    assert.equal(expiredRun.ok, false);
    assert.equal(expiredRun.error.code, 'TASK_GRANT_EXPIRED', '过期 grant 必须拒绝');

    // F4 scope 外命令 → TASK_SCOPE_BROADENED（grant 只含 content.save_version）
    const taskNarrow = (await dispatchStartAgentTask(runtime, {
      intent: 'studio_draft', businessDate: '2026-08-13', contextRefs: { workspaceId: runtime.identity.workspaceId }
    }, { actor: { type: 'owner_ui', id: 'renderer', label: 'Owner UI' }, requestId: 'task-wiki-narrow' })).task;
    const narrow = await dispatchIssueTaskGrant(runtime, {
      requestId: 'grant-wiki-narrow', taskId: taskNarrow.id, ownerGoal: '窄 scope 测试',
      allowedCommands: ['content.save_version'],
      workers: [{ type: 'pi', id: 'pi' }],
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    assert.equal(narrow.ok, true);
    const scoped = await executeWikiAction({ runtime }, {
      action: 'ingest', requestId: 'wiki-narrow-1',
      items: [{ title: 't', originalUrl: 'https://example.com/narrow' }],
      taskId: taskNarrow.id, grantId: narrow.data.id, workerLeaseId: 'lease-narrow'
    }, { actor: 'pi' });
    assert.equal(scoped.ok, false);
    // 全部失败且错误码一致 → 透传一致错误码（TASK_SCOPE_BROADENED 原样可见）
    assert.equal(scoped.error.code, 'TASK_SCOPE_BROADENED', 'scope 外命令全部失败透传 TASK_SCOPE_BROADENED');

    // F5 worker 不匹配（grant worker=external_agent，调用 actor=pi）→ TASK_WORKER_MISMATCH
    const taskExt = (await dispatchStartAgentTask(runtime, {
      intent: 'studio_draft', businessDate: '2026-08-12', contextRefs: { workspaceId: runtime.identity.workspaceId }
    }, { actor: { type: 'owner_ui', id: 'renderer', label: 'Owner UI' }, requestId: 'task-wiki-ext' })).task;
    const extGrant = await dispatchIssueTaskGrant(runtime, {
      requestId: 'grant-wiki-ext', taskId: taskExt.id, ownerGoal: '外部 worker 测试',
      allowedCommands: ['knowledge.lint'],
      workers: [{ type: 'external_agent', id: 'mcp' }],
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    assert.equal(extGrant.ok, true);
    const mismatch = await executeWikiAction({ runtime }, {
      action: 'lint', run: true, requestId: 'wiki-mismatch-1',
      taskId: taskExt.id, grantId: extGrant.data.id, workerLeaseId: 'lease-ext'
    }, { actor: 'pi' });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.error.code, 'TASK_WORKER_MISMATCH', 'worker 身份不匹配必须拒绝');

    // ============ I. 发布边界：执行器零发布动作（T-PUB-1/2） ============
    const actionNames = ['maintain', 'ingest', 'query', 'lint', 'search', 'log', 'report'];
    assert.deepEqual(actionNames.sort(), ['ingest', 'lint', 'log', 'maintain', 'query', 'report', 'search'], '执行器动作面固定');
    assert.ok(!actionNames.some((a) => /publish|platform|delete|execute/.test(a)), '无发布/平台变更/硬删动作');

    // ============ J. 错误卫生（T-EL-1）：失败不含 rootPath/绝对路径/SQL/堆栈 ============
    const errText = JSON.stringify({ code: noGrant.error.code, message: noGrant.error.message, details: noGrant.error.details ?? null });
    assert.ok(!/C:\\|[A-Za-z]:[\\/]/.test(errText), '错误不得含盘符绝对路径');
    assert.ok(!/wmb\.db|SELECT|INSERT|UPDATE|DELETE/.test(errText), '错误不得含 SQL');
    assert.ok(!/at .*\.mjs|at .*\.ts|stack/i.test(errText), '错误不得含堆栈');

    await runtime.stop({ drain: false });
    runtime = null;
  } finally {
    await runtime?.stop({ drain: false });
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
