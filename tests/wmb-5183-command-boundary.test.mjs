/**
 * WMB-5183 命令边界（渠道/X List/发布）— 准备/执行分离的行为级验收。
 * 覆盖设计 §4.4 表 ①-③ 与 §7 A3a/A3b/A3c：
 * - 注册表枚举：新增内部 prepare 命令恰好登记一次、grantable + desk 绑定、自动进入 deskStanding、永不进红线；
 * - X List：内部 prepare 命令可经主管 grant 成功准备（readback）；`x_lists.operation_execute` 对代理不可达
 *   （deskStanding 无此命令 → TASK_SCOPE_BROADENED；即便 Owner 显式签发含执行命令的 grant，无 precise grant
 *   → EXECUTION_GRANT_REQUIRED），零业务写；
 * - 发布：`publication.snapshot_create` 经主管 grant 成功（readback）；`publication.editor_prepare_execute`
 *   不在 TASK_INTERNAL_COMMANDS（Owner 也无法写进 grant），代理信封一律 TASK_SCOPE_BROADENED，最终 publish click 无任何 grant/命令可达。
 * 业务写入一律走 ActiveWorkspaceRuntime + dispatch*（禁止裸 SQL 绕过写护栏；fixture 仅在 runtime 打开前预置）。
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { createContentProject, saveCoreVersion, savePlatformVersion } from '../src/main/content.ts';
import { dispatchCancelAgentTask, dispatchStartAgentTask } from '../src/main/agent-task-commands.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import {
  AUTOMATIC_TASK_GRANT_SCOPES,
  dispatchIssueTaskGrant,
  ensureAutomaticTaskGrant,
  getTaskGrant
} from '../src/main/task-grants.ts';
import { createCommandEnvelope } from '../src/main/command-dispatcher.ts';
import {
  AGENT_CAPABILITIES,
  REDLINE_COMMANDS,
  commandsCoveredByGrantableCapabilities,
  deskStanding,
  deskStandingCommands,
  filterCommandsForRole,
  roleWriteCommands
} from '../src/shared/agent-capabilities.ts';
import { prepareAgentXListOperation } from '../src/main/mcp-x-list.ts';
import { getXListOperation } from '../src/main/x-lists.ts';
import { dispatchAcceptXListOperation } from '../src/main/x-list-command.ts';
import { dispatchArmXListOperation } from '../src/main/x-list-business-command.ts';
import { getExecutionGrant } from '../src/main/execution-grants.ts';
import { dispatchCreatePublicationSnapshot } from '../src/main/publication-commands.ts';
import { initializeWorkspaceBrowserBinding, markWorkspaceBrowserBindingVerified } from '../src/main/workspace-browser-binding.ts';
import { ensureOfficialWorkspaceProfile } from '../src/main/workspace-profiles.ts';

const NEW_INTERNAL_PREPARE_COMMANDS = Object.freeze([
  'intelligence_channels.proposal_apply_safe',
  'x_lists.prepare',
  'publication.snapshot_create'
]);
const REDLINE_EXECUTIONS = Object.freeze([
  'intelligence_channels.proposal_apply',
  'x_lists.operation_execute',
  'publication.editor_prepare_execute'
]);

function openRuntime(directory, seed = () => {}) {
  const databasePath = path.join(directory, 'wmb.db');
  const database = migrateDatabase(databasePath);
  const now = new Date().toISOString();
  database.prepare(
    "INSERT OR REPLACE INTO app_meta(key, value, created_at, updated_at, revision) VALUES(?, ?, ?, ?, 1)"
  ).run('workspace_id', `ws-${path.basename(directory)}`, now, now);
  ensureOfficialWorkspaceProfile(database, 'official.ai');
  seed(database);
  database.close();
  return ActiveWorkspaceRuntime.open(directory);
}

function actor(lane = 'wmb-5183') {
  return { actor: { type: 'scheduler', id: lane, label: lane }, requestId: randomUUID() };
}

function withWs(runtime, refs = {}) {
  return { workspaceId: runtime.identity.workspaceId, ...refs };
}

async function startTask(runtime, input, workerLeaseId) {
  return dispatchStartAgentTask(runtime, { ...input, contextRefs: withWs(runtime, input.contextRefs || {}) }, { ...actor('start'), workerLeaseId, taskId: undefined });
}

async function cancelTask(runtime, taskId, workerLeaseId) {
  return dispatchCancelAgentTask(runtime, taskId, { ...actor('cancel'), taskId, workerLeaseId });
}

async function deskTaskAndGrant(runtime, desk, intent = 'page_publish') {
  const started = await startTask(runtime, { intent, businessDate: '2026-08-08', contextRefs: { roleId: 'desk', page: intent.replace('page_', '') } }, desk.leaseId);
  runtime.bindWorkerTask(desk, started.task.id);
  const grantId = await ensureAutomaticTaskGrant(runtime, started.task.id, new Date(), 'desk');
  return { task: started.task, grantId };
}

function future() { return new Date(Date.now() + 60_000).toISOString(); }

test('1 WMB-5183 registry: internal prepare commands registered once, desk-bound, in standing, never redline', () => {
  for (const command of NEW_INTERNAL_PREPARE_COMMANDS) {
    const owners = AGENT_CAPABILITIES.filter((cap) => cap.commands.includes(command));
    assert.equal(owners.length, 1, `${command} must be registered exactly once`);
    const cap = owners[0];
    assert.equal(cap.id, 'cap.internal_prepare', `${command} owned by cap.internal_prepare`);
    assert.equal(cap.agentGrantable, true, `${command} must be grantable`);
    assert.equal(cap.precise, false, `${command} is internal, not precise`);
    assert.equal(cap.defaultRoleBindings.desk, true, `${command} binds desk`);
    for (const role of ['reporter', 'planner', 'writer', 'librarian']) {
      assert.equal(cap.defaultRoleBindings[role], undefined, `${command} must not bind ${role}`);
    }
  }
  const covered = commandsCoveredByGrantableCapabilities();
  for (const command of NEW_INTERNAL_PREPARE_COMMANDS) {
    assert.ok(covered.has(command), `${command} in grantable coverage`);
    assert.ok(deskStanding.has(command), `${command} enters deskStanding automatically`);
    assert.equal(REDLINE_COMMANDS.includes(command), false, `${command} never enters redline`);
    assert.ok(roleWriteCommands('desk').includes(command), `${command} in desk standing write set`);
  }
  // 红线执行命令永不进入任何 grant / standing。
  for (const command of REDLINE_EXECUTIONS) {
    assert.equal(deskStanding.has(command), false, `redline execution ${command} never enters deskStanding`);
    assert.ok(REDLINE_COMMANDS.includes(command), `${command} stays in REDLINE_COMMANDS`);
  }
  assert.deepEqual([...deskStanding].filter((c) => REDLINE_COMMANDS.includes(c)), [], 'deskStanding disjoint from redline executions');
  assert.deepEqual(filterCommandsForRole('desk', [...REDLINE_EXECUTIONS]), [], 'desk filter drops every redline execution');
});

test('2 WMB-5183 x-list: desk internal prepare succeeds with receipt/audit/lineage; Owner confirm happy path; agent execute denied', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-5183-xlist-'));
  const runtime = openRuntime(directory, (database) => {
    initializeWorkspaceBrowserBinding(database, 'profile-wmb5183', {
      x: {
        platform: 'x', accountKey: '@owner', displayName: 'Owner', loginState: 'authenticated',
        accountRevision: 1, browserProfileId: 'profile-wmb5183', browserBindingRevision: 1, verifiedAt: '2026-08-08T00:00:00.000Z'
      }
    });
  });
  try {
    const desk = runtime.acquireWorkerLease(null, 'desk', 'desk');
    const { task, grantId } = await deskTaskAndGrant(runtime, desk, 'page_publish');
    const grant = getTaskGrant(runtime.database, grantId);
    assert.ok(grant.allowedCommands.includes('x_lists.prepare'), 'desk standing includes internal prepare');
    assert.equal(grant.allowedCommands.includes('x_lists.operation_execute'), false, 'execution never enters desk grant');

    // 内部 prepare（MCP prepare 工具挂接的真实派发路径）：经 desk grant 成功准备，授权/收据/审计/血统齐全。
    const preparedResult = await prepareAgentXListOperation(runtime, {
      requestId: 'wmb5183-x-prepare', accountKey: '@owner', kind: 'members_add', listId: '123', handles: ['@alice'],
      taskId: task.id, taskGrantId: grantId, workerLeaseId: desk.leaseId
    });
    assert.equal(preparedResult.ok, true, JSON.stringify(preparedResult.error ?? null));
    assert.equal(preparedResult.data.replayed, false);
    const prepared = preparedResult.data.operation;
    assert.equal(prepared.state, 'prepared', 'operation persisted in prepared state');
    assert.deepEqual(preparedResult.data, { operation: prepared, replayed: false }, 'complete readback of prepared operation');

    // 血统保留在操作行：task/grant/preparedActor（Owner 精确授权仍可审计到准备者）。
    const lineage = getXListOperation(runtime.database, prepared.id);
    assert.equal(lineage.taskId, task.id, 'prepare task lineage stored');
    assert.equal(lineage.taskGrantId, grantId, 'prepare grant lineage stored');
    assert.deepEqual(lineage.preparedActor, { type: 'pi', id: 'pi' }, 'preparedActor lineage stored');

    // dispatcher 审计：command_receipt 与 operation_log 均落 x_lists.prepare 成功行。
    const receiptRow = runtime.database.prepare(
      'SELECT status, receipt_json AS receiptJson FROM command_receipts WHERE workspace_id=? AND request_id=?'
    ).get(runtime.identity.workspaceId, 'wmb5183-x-prepare');
    assert.ok(receiptRow, 'command_receipt recorded for internal prepare');
    assert.equal(receiptRow.status, 'ok');
    const receiptParsed = JSON.parse(receiptRow.receiptJson);
    assert.equal(receiptParsed.command, 'x_lists.prepare');
    assert.equal(receiptParsed.actor.type, 'pi');
    const auditRow = runtime.database.prepare(
      "SELECT command, entity_type AS entityType, result, after_revision AS afterRevision FROM operation_log WHERE command='x_lists.prepare'"
    ).get();
    assert.ok(auditRow, 'operation_log recorded for internal prepare');
    assert.equal(auditRow.entityType, 'x_list_operation');
    assert.equal(auditRow.result, 'ok');
    assert.equal(auditRow.afterRevision, 1);

    // Owner UI 确认：精确授权绑定冻结操作/账号/快照，不再重要求历史准备 task grant（主管准备血统可用）。
    const armed = await dispatchArmXListOperation(runtime, {
      operationId: prepared.id,
      expectedRevision: prepared.revision,
      expectedAccountKey: '@owner',
      snapshot: {
        accountKey: '@owner',
        list: { listId: '123', canonicalUrl: 'https://x.com/i/lists/123', ownerHandle: '@owner', name: 'Research', description: '', isPrivate: false, memberCount: 0, kind: 'owned', evidenceFingerprint: 'list-proof' },
        members: [{ handle: '@alice', present: false }]
      }
    });
    assert.equal(armed.ok, true, JSON.stringify(armed.error ?? null));
    assert.equal(armed.data.phase, 'awaiting_confirmation');
    const context = {
      root: { path: directory },
      workspaceId: runtime.identity.workspaceId,
      browserId: 'profile-wmb5183',
      accountKey: '@owner',
      config: { profileDir: path.join(directory, 'profile') },
      index: { accountKey: '@owner', lists: [], observation: { capturedAt: '2026-08-08T00:00:00.000Z', pageUrl: 'https://x.com/home', fingerprint: 'index-proof' } },
      selectedXListBrowser() { throw new Error('not used before browser execution'); }
    };
    const confirm = await dispatchAcceptXListOperation(runtime, context, { operationId: prepared.id, expectedRevision: armed.data.revision });
    assert.equal(confirm.ok, true, JSON.stringify(confirm.error ?? null));
    assert.equal(confirm.data.state, 'execution_granted');
    assert.ok(confirm.executionGrantId, 'Owner confirm consumes a fresh precise grant');
    assert.equal(confirm.data.executionGrantId, confirm.executionGrantId);
    assert.deepEqual(confirm.readback, confirm.data, 'execution readback complete');
    const consumedGrant = getExecutionGrant(runtime.database, confirm.executionGrantId, new Date(), runtime.identity);
    assert.equal(consumedGrant.status, 'consumed', 'precise grant consumed atomically');
    assert.equal(consumedGrant.taskId, null, 'precise grant not bound to the historical prepare task grant');
    assert.deepEqual(consumedGrant.boundIdentity.preparedTaskId, task.id, 'prepare lineage still on the grant for audit');
    const replay = await dispatchAcceptXListOperation(runtime, context, { operationId: prepared.id, expectedRevision: armed.data.revision });
    assert.deepEqual(replay, confirm, 'exact replay returns the same execution receipt');

    // 执行：deskStanding grant 无执行命令 → TASK_SCOPE_BROADENED，零业务写。
    const executeDenied = await runtime.dispatchCommand(createCommandEnvelope({
      workspaceId: runtime.identity.workspaceId,
      runtimeEpoch: runtime.identity.runtimeEpoch,
      command: 'x_lists.operation_execute',
      requestId: 'wmb5183-x-execute-desk',
      input: {},
      boundIdentity: {},
      actor: { type: 'pi', id: 'pi', label: 'Pi worker' },
      taskId: task.id,
      workerLeaseId: desk.leaseId,
      grantId
    }), () => { throw new Error('HANDLER_MUST_NOT_RUN'); });
    assert.equal(executeDenied.ok, false);
    assert.equal(executeDenied.error.code, 'TASK_SCOPE_BROADENED', 'execution is not in any desk grant');
    assert.equal(executeDenied.sideEffectState, 'not_started');

    // 执行：即便 Owner 显式签发含执行命令的 task grant（外部 Agent 无 lease），缺 precise grant → Precise 门拦截。
    const second = await startTask(runtime, { intent: 'page_today', businessDate: '2026-08-08', contextRefs: { roleId: 'desk', page: 'today' } }, desk.leaseId);
    runtime.bindWorkerTask(desk, second.task.id);
    const explicit = await dispatchIssueTaskGrant(runtime, {
      requestId: `explicit-x-execute-${randomUUID()}`,
      taskId: second.task.id,
      ownerGoal: '显式执行授权基底（仅测试）',
      allowedCommands: ['x_lists.operation_execute'],
      workers: [{ type: 'external_agent', id: 'mcp' }],
      expiresAt: future()
    });
    assert.equal(explicit.ok, true, JSON.stringify(explicit.error ?? null));
    const preciseDenied = await runtime.dispatchCommand(createCommandEnvelope({
      workspaceId: runtime.identity.workspaceId,
      runtimeEpoch: runtime.identity.runtimeEpoch,
      command: 'x_lists.operation_execute',
      requestId: 'wmb5183-x-execute-no-grant',
      input: {},
      boundIdentity: {},
      actor: { type: 'external_agent', id: 'mcp', label: 'External Agent' },
      taskId: second.task.id,
      grantId: explicit.data.id
    }), () => { throw new Error('HANDLER_MUST_NOT_RUN'); });
    assert.equal(preciseDenied.ok, false);
    assert.equal(preciseDenied.error.code, 'EXECUTION_GRANT_REQUIRED', 'execution requires a fresh precise Owner-UI grant');
    assert.equal(preciseDenied.sideEffectState, 'not_started');

    await cancelTask(runtime, task.id, desk.leaseId);
    await cancelTask(runtime, second.task.id, desk.leaseId);
    runtime.releaseWorker(desk);
  } finally {
    await runtime.stop({ drain: false }).catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});

test('3 WMB-5183 publication: desk snapshot prepare succeeds with readback; editor prepare and final publish unreachable', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-5183-pub-'));
  const accountKey = '@wmb5183-owner';
  const profileId = 'profile-wmb5183';
  const assetId = 'asset-wmb5183';
  const runtime = openRuntime(directory, (database) => {
    initializeWorkspaceBrowserBinding(database, profileId);
    markWorkspaceBrowserBindingVerified(database, {
      profileId,
      expectedBindingRevision: 1,
      account: { platform: 'x', accountKey, displayName: 'WMB5183 Owner', loginState: 'authenticated', evidenceUrl: 'https://x.com/wmb5183-owner' }
    });
    database.prepare(`INSERT INTO assets(id,relative_path,mime_type,byte_count,sha256,origin,created_at,updated_at,revision)
      VALUES (?,?,?,?,?,'user',?,?,1)`).run(assetId, 'assets/wmb5183.png', 'image/png', 13, 'd'.repeat(64), '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z');
    const project = createContentProject(database, { title: 'WMB5183 project' });
    const core = saveCoreVersion(database, { projectId: project.id, body: 'core', expectedRevision: 1 });
    assert.equal(core.ok, true, core.error?.message ?? 'core version must seed');
    const version = savePlatformVersion(database, {
      projectId: project.id, contentVersionId: core.data.id, platform: 'x', format: 'image',
      title: 'WMB5183 frozen title', body: 'WMB5183 frozen body', assetIds: [assetId]
    });
    assert.equal(version.ok, true, version.error?.message ?? 'platform version must seed');
  });
  try {
    const desk = runtime.acquireWorkerLease(null, 'desk', 'desk');
    const { task, grantId } = await deskTaskAndGrant(runtime, desk, 'page_publish');
    const grant = getTaskGrant(runtime.database, grantId);
    assert.ok(grant.allowedCommands.includes('publication.snapshot_create'), 'desk standing includes snapshot prepare');
    assert.equal(grant.allowedCommands.includes('publication.editor_prepare_execute'), false, 'editor prepare never enters desk grant');

    const versionRow = runtime.database.prepare('SELECT id FROM platform_versions LIMIT 1').get();
    assert.ok(versionRow, 'seeded platform version present');
    const snapshot = await dispatchCreatePublicationSnapshot(runtime, { platformVersionId: versionRow.id, requestId: 'wmb5183-snapshot' }, {
      taskId: task.id, taskGrantId: grantId, workerLeaseId: desk.leaseId
    });
    assert.equal(snapshot.ok, true, JSON.stringify(snapshot.error ?? null));
    assert.equal(snapshot.command, 'publication.snapshot_create');
    assert.equal(snapshot.actor.type, 'pi');
    assert.equal(snapshot.executionGrantId, null, 'snapshot prepare needs no precise execution grant');
    assert.equal(snapshot.data.operation.state, 'prepared', 'publication browser operation prepared');
    assert.deepEqual(snapshot.readback.snapshot.payload, { title: 'WMB5183 frozen title', body: 'WMB5183 frozen body', format: 'image' }, 'full snapshot readback');

    // editor_prepare_execute：deskStanding grant 无此命令 → TASK_SCOPE_BROADENED，零业务写。
    const editorDesk = await runtime.dispatchCommand(createCommandEnvelope({
      workspaceId: runtime.identity.workspaceId,
      runtimeEpoch: runtime.identity.runtimeEpoch,
      command: 'publication.editor_prepare_execute',
      requestId: 'wmb5183-editor-desk',
      input: {},
      boundIdentity: {},
      actor: { type: 'pi', id: 'pi', label: 'Pi worker' },
      taskId: task.id,
      workerLeaseId: desk.leaseId,
      grantId
    }), () => { throw new Error('HANDLER_MUST_NOT_RUN'); });
    assert.equal(editorDesk.ok, false);
    assert.equal(editorDesk.error.code, 'TASK_SCOPE_BROADENED', 'editor prepare is not in any desk grant');
    assert.equal(editorDesk.sideEffectState, 'not_started');

    // editor_prepare_execute：该命令不在 TASK_INTERNAL_COMMANDS（红线执行命令不可入任何 task grant）
    // → Owner 也无法把它写进 grant（TASK_SCOPE_BROADENED，同步抛错）；代理信封一律 TASK_SCOPE_BROADENED，零业务写。
    const second = await startTask(runtime, { intent: 'page_today', businessDate: '2026-08-08', contextRefs: { roleId: 'desk', page: 'today' } }, desk.leaseId);
    runtime.bindWorkerTask(desk, second.task.id);
    assert.throws(
      () => dispatchIssueTaskGrant(runtime, {
        requestId: `explicit-editor-${randomUUID()}`,
        taskId: second.task.id,
        ownerGoal: '显式执行授权基底（仅测试）',
        allowedCommands: ['publication.editor_prepare_execute'],
        workers: [{ type: 'external_agent', id: 'mcp' }],
        expiresAt: future()
      }),
      (error) => error.code === 'TASK_SCOPE_BROADENED',
      'no task grant may ever contain publication.editor_prepare_execute'
    );

    // 最终 publish click 永不自动：grantable 面只暴露快照准备，无任何发布点击命令可达。
    const grantableCommands = [...commandsCoveredByGrantableCapabilities()];
    assert.equal(grantableCommands.filter((command) => command.startsWith('publication.')).sort().join(','), 'publication.snapshot_create', 'only snapshot prepare is grantable in publication domain');
    assert.equal(
      AGENT_CAPABILITIES.some((cap) => cap.commands.some((command) => /^publication\.(publish|final_publish|click)/.test(command))),
      false,
      'no publish-click command exists in any capability'
    );
    assert.deepEqual(
      REDLINE_COMMANDS.filter((command) => command.startsWith('publication.')),
      ['publication.editor_prepare_execute'],
      'editor prepare stays the only publication redline command (click has no command)'
    );

    await cancelTask(runtime, task.id, desk.leaseId);
    await cancelTask(runtime, second.task.id, desk.leaseId);
    runtime.releaseWorker(desk);
  } finally {
    await runtime.stop({ drain: false }).catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});

test('4 WMB-5183 regression: page scopes never gain internal prepare or redline executions', () => {
  const scoped = new Set(Object.values(AUTOMATIC_TASK_GRANT_SCOPES).flat());
  for (const command of NEW_INTERNAL_PREPARE_COMMANDS) {
    assert.equal(scoped.has(command), false, `${command} must not be added to employee page scopes`);
  }
  for (const command of REDLINE_EXECUTIONS) {
    assert.equal(scoped.has(command), false, `${command} must not be added to page scopes`);
  }
  assert.deepEqual([...deskStandingCommands()].sort(), [...deskStanding].sort(), 'deskStandingCommands stays the sorted projection');
});
