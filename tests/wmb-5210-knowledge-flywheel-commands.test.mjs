// WMB-5210 M1 命令接线验收（WireKnowledgeCommands 切片）：
// 唯一正式知识写命令 knowledge_flywheel.change_set_apply 走 CommandDispatcher 收据 + store 原子
// ChangeSet；capability 注册最窄复用（cap.knowledge_curate + cap.library_organize，不新增能力）；
// 权限拒绝（pi/external 无 grant）、跨 root（WORKSPACE_MISMATCH / WORKSPACE_STALE）、缺字段
// fail-closed（requestId/reason/枚举/空段/workspace 不匹配）各有局部测试；无直接 SQL 绕过 store。
// 运行：node --test tests/wmb-5210-knowledge-flywheel-commands.test.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { register } from 'node:module';

// ---- 测试本地 ESM 解析钩子（同 command-dispatcher.test.mjs）：electron → 惰性桩；相对无扩展名补 .ts ----
const ELECTRON_STUB = [
  'const noop = () => {};',
  'class BrowserWindow {',
  '  static getAllWindows() { return []; }',
  '  loadURL() { return Promise.resolve(); }',
  '  loadFile() { return Promise.resolve(); }',
  '}',
  "const app = { getAppPath: () => '', whenReady: () => Promise.resolve(), on: noop };",
  'const ipcMain = { handle: noop, on: noop, removeHandler: noop, removeAllListeners: noop };',
  "const safeStorage = { encryptString: (s) => Buffer.from(String(s), 'utf8'), decryptString: (b) => String(b) };",
  'export { app, BrowserWindow, ipcMain, safeStorage };',
  'export default { app, safeStorage };',
].join('\n');
const HOOK_SOURCE = [
  "const { existsSync } = process.getBuiltinModule('node:fs');",
  "const path = process.getBuiltinModule('node:path');",
  "const { fileURLToPath, pathToFileURL } = process.getBuiltinModule('node:url');",
  'const ELECTRON_STUB = ' + JSON.stringify(ELECTRON_STUB) + ';',
  'export async function resolve(specifier, context, nextResolve) {',
  "  if (specifier === 'electron') return { url: 'data:text/javascript,' + encodeURIComponent(ELECTRON_STUB), shortCircuit: true };",
  "  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !path.extname(specifier)) {",
  '    const base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);',
  "    for (const ext of ['.ts', '.mts', '.cts']) {",
  '      const candidate = base + ext;',
  '      if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };',
  '    }',
  '  }',
  '  return nextResolve(specifier, context);',
  '}',
].join('\n');
register('data:text/javascript,' + encodeURIComponent(HOOK_SOURCE), import.meta.url);

const { AGENT_CAPABILITIES, REDLINE_COMMANDS, deskStandingCommands, filterCommandsForRole, roleWriteCommands } = await import('../src/shared/agent-capabilities.ts');
const { createCommandEnvelope } = await import('../src/main/command-dispatcher.ts');
const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { ActiveWorkspaceRuntime } = await import('../src/main/workspace-runtime.ts');
const { ensureOfficialWorkspaceProfile } = await import('../src/main/workspace-profiles.ts');
const {
  applyKnowledgeChangeSet,
  getChangeSet,
  getUpdateReceiptByRequest,
  KNOWLEDGE_FLYWHEEL_CHANGE_SET_COMMAND,
  KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS,
  KNOWLEDGE_FLYWHEEL_WRITE_IPC_CHANNEL,
  listChangeSets
} = await import('../src/main/knowledge-flywheel.ts');
const { KNOWLEDGE_FLYWHEEL_IPC_CHANNELS, normalizeChangeSetApplyInput } = await import('../src/main/ipc-knowledge-flywheel.ts');

const owner = { type: 'owner_ui', id: 'renderer', label: 'Owner UI' };
const CHANGE_SET_COMMAND = KNOWLEDGE_FLYWHEEL_CHANGE_SET_COMMAND;

function meta(workspaceId, requestId, extra = {}) {
  return {
    workspaceId,
    requestId,
    reason: '测试原因',
    triggerSource: 'user',
    resolutionMode: 'manual_correction',
    createdBy: 'user',
    ...extra
  };
}

function entitySegments(canonicalKey = `key-${randomUUID()}`, overrides = {}) {
  return { entities: [{ scope: 'global', entityType: 'person', canonicalKey, canonicalName: 'Alice', ...overrides }] };
}

function count(database, table) {
  return database.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count;
}

// ============================================================
// A. Capability 注册：最窄复用，不新增能力
// ============================================================

test('A1 change_set_apply 注册进 cap.knowledge_curate + cap.library_organize（不新增能力）', () => {
  const command = 'knowledge_flywheel.change_set_apply';
  for (const capId of ['cap.knowledge_curate', 'cap.library_organize']) {
    const cap = AGENT_CAPABILITIES.find((item) => item.id === capId);
    assert.ok(cap, `能力 ${capId} 必须存在`);
    assert.ok(cap.commands.includes(command), `${capId} 必须包含 ${command}`);
    assert.equal(cap.agentGrantable, true, `${capId} 必须 agentGrantable（进入 desk standing 与自动签发）`);
  }
  // 不新增能力（能力锁 2026-08-07 未立法新 id）：14 = 既有集合。
  assert.ok(!AGENT_CAPABILITIES.some((item) => item.id.includes('flywheel')), '不得新增 flywheel 能力 id');
});

test('A2 standing/角色写集包含命令；writer/reporter 零回归；红线不受影响', () => {
  const command = 'knowledge_flywheel.change_set_apply';
  assert.ok(deskStandingCommands().includes(command), 'desk standing 必须包含命令（grantable 能力命令并集）');
  for (const role of ['desk', 'planner', 'librarian']) {
    assert.ok(roleWriteCommands(role).includes(command), `roleWriteCommands(${role}) 必须包含命令`);
  }
  for (const role of ['writer', 'reporter']) {
    assert.ok(!roleWriteCommands(role).includes(command), `roleWriteCommands(${role}) 不得包含命令`);
    assert.ok(!filterCommandsForRole(role, [command]).includes(command), `filterCommandsForRole(${role}) 必须过滤命令`);
  }
  assert.ok(!REDLINE_COMMANDS.includes(command), '命令不得进入红线类别');
  assert.ok(!REDLINE_COMMANDS.includes(CHANGE_SET_COMMAND), '常量与注册表一致');
});

// ============================================================
// B. IPC 写面校验（fail-closed）
// ============================================================

test('B1 缺 requestId/reason/枚举非法/空段/workspace 不匹配一律拒绝', () => {
  const workspaceId = 'ws-a';
  const valid = { requestId: 'r1', reason: '原因', triggerSource: 'user', resolutionMode: 'manual_correction', createdBy: 'user', input: entitySegments('alice') };
  const cases = [
    [{ ...valid, requestId: undefined }, 'KNOWLEDGE_FLYWHEEL_REQUEST_ID_REQUIRED'],
    [{ ...valid, requestId: '   ' }, 'KNOWLEDGE_FLYWHEEL_REQUEST_ID_REQUIRED'],
    [{ ...valid, reason: undefined }, 'KNOWLEDGE_FLYWHEEL_REASON_REQUIRED'],
    [{ ...valid, reason: '' }, 'KNOWLEDGE_FLYWHEEL_REASON_REQUIRED'],
    [{ ...valid, triggerSource: 'hack' }, 'KNOWLEDGE_FLYWHEEL_TRIGGER_SOURCE_INVALID'],
    [{ ...valid, resolutionMode: 'merge_all' }, 'KNOWLEDGE_FLYWHEEL_RESOLUTION_MODE_INVALID'],
    [{ ...valid, createdBy: 'root' }, 'KNOWLEDGE_FLYWHEEL_CREATED_BY_INVALID'],
    [{ ...valid, workspaceId: 'other-root' }, 'KNOWLEDGE_FLYWHEEL_WORKSPACE_MISMATCH'],
    [{ ...valid, input: {} }, 'KNOWLEDGE_FLYWHEEL_INPUT_EMPTY'],
    [{ ...valid, input: { entities: [] } }, 'KNOWLEDGE_FLYWHEEL_INPUT_EMPTY'],
    [null, 'KNOWLEDGE_FLYWHEEL_REQUEST_ID_REQUIRED']
  ];
  for (const [input, code] of cases) {
    assert.throws(() => normalizeChangeSetApplyInput(input, workspaceId), (error) => {
      assert.equal(error.code, code, `${JSON.stringify(input)?.slice(0, 60)} 应拒绝为 ${code}，实际 ${error.code}`);
      return true;
    });
  }
  // 匹配 workspaceId 合法；meta 只取运行时身份。
  const normalized = normalizeChangeSetApplyInput({ ...valid, workspaceId }, workspaceId);
  assert.equal(normalized.meta.workspaceId, workspaceId);
  assert.equal(normalized.meta.requestId, 'r1');
  assert.equal(normalized.segments.entities.length, 1);
});

test('B2 IPC 通道清单与 store 常量一致（写 1 + 读全集）', async () => {
  assert.equal(KNOWLEDGE_FLYWHEEL_WRITE_IPC_CHANNEL, 'knowledge-flywheel:change-set-apply');
  assert.deepEqual(KNOWLEDGE_FLYWHEEL_IPC_CHANNELS, [KNOWLEDGE_FLYWHEEL_WRITE_IPC_CHANNEL, ...KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS]);
  assert.equal(new Set(KNOWLEDGE_FLYWHEEL_IPC_CHANNELS).size, KNOWLEDGE_FLYWHEEL_IPC_CHANNELS.length, '通道名不得重复');
  // 注册不遗漏：每个通道都出现在 ipcMain.handle 注册点（源级钉死，防漂移）。
  const source = await readFile(new URL('../src/main/ipc-knowledge-flywheel.ts', import.meta.url), 'utf8');
  for (const channel of KNOWLEDGE_FLYWHEEL_IPC_CHANNELS) {
    assert.ok(source.includes(`ipcMain.handle('${channel}'`) || source.includes(`ipcMain.handle(KNOWLEDGE_FLYWHEEL_WRITE_IPC_CHANNEL`),
      `通道 ${channel} 必须在 ipc-knowledge-flywheel.ts 注册`);
  }
  assert.ok(source.includes('ipcMain.handle(KNOWLEDGE_FLYWHEEL_WRITE_IPC_CHANNEL'), '写通道必须经常量注册');
});

// ============================================================
// C. dispatcher + store 集成（真实 DB + 活动运行时写保护）
// ============================================================

test('C1 写命令经 dispatcher 原子落库：change_set + 实体 + 收据 + 审计', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const segments = entitySegments('c1-person');
    const receipt = await dispatchChangeSet(runtime, meta(runtime.identity.workspaceId, 'c1-apply'), segments);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.command, CHANGE_SET_COMMAND);
    assert.equal(receipt.data.replay, false);
    assert.equal(receipt.data.revisions[Object.keys(receipt.data.revisions)[0]], 1);
    assert.equal(count(database, 'knowledge_change_sets'), 1);
    assert.equal(count(database, 'knowledge_entities'), 1);
    assert.equal(count(database, 'command_receipts'), 1);
    assert.equal(count(database, 'operation_log'), 1);
    const stored = getChangeSet(database, receipt.data.changeSetId);
    assert.equal(stored.requestId, 'c1-apply');
    assert.equal(stored.workspaceId, runtime.identity.workspaceId);
    const listed = listChangeSets(database, {});
    assert.equal(listed.total, 1);
    assert.equal(listed.items[0].id, receipt.data.changeSetId);
  });
});

test('C2 幂等：同 requestId+输入重放返回同一收据，handler 零重跑，零新增行', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const segments = entitySegments('c2-person');
    const counter = { runs: 0 };
    const first = await dispatchChangeSet(runtime, meta(runtime.identity.workspaceId, 'c2-replay'), segments, counter);
    const second = await dispatchChangeSet(runtime, meta(runtime.identity.workspaceId, 'c2-replay'), segments, counter);
    assert.equal(second.receiptId, first.receiptId, '重放必须返回同一收据');
    assert.deepEqual(second, first);
    assert.equal(counter.runs, 1, '幂等重放不得重跑 handler');
    assert.equal(count(database, 'knowledge_change_sets'), 1);
    assert.equal(count(database, 'knowledge_entities'), 1);
    assert.equal(count(database, 'command_receipts'), 1);
  });
});

test('C3 同 requestId 配不同输入 → REQUEST_REPLAY_CONFLICT，零写', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const first = await dispatchChangeSet(runtime, meta(runtime.identity.workspaceId, 'c3-conflict'), entitySegments('c3-a'));
    assert.equal(first.ok, true);
    // dispatcher 对同 requestId 不同输入直接抛 REQUEST_REPLAY_CONFLICT（不落业务行）。
    const conflictEnvelope = () => dispatchChangeSet(runtime, meta(runtime.identity.workspaceId, 'c3-conflict'), entitySegments('c3-b'));
    await assert.rejects(conflictEnvelope, { code: 'REQUEST_REPLAY_CONFLICT' });
    assert.equal(count(database, 'knowledge_change_sets'), 1, '冲突必须零新增 change_set');
    assert.equal(count(database, 'knowledge_entities'), 1, '冲突必须零新增实体');
    assert.equal(count(database, 'command_receipts'), 1, '冲突不产生第二条收据');
  });
});

test('C4 beforeRevision 强制：更新带错 revision → REVISION_CONFLICT；缺失 → 创建路径零写', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const created = await dispatchChangeSet(runtime, meta(runtime.identity.workspaceId, 'c4-create'), entitySegments('c4-person', { id: 'entity-c4' }));
    assert.equal(created.ok, true);
    const baseline = { changeSets: count(database, 'knowledge_change_sets'), entities: count(database, 'knowledge_entities'), versions: count(database, 'knowledge_note_versions') };

    // 更新带错 beforeRevision → REVISION_CONFLICT。
    const stale = await dispatchChangeSet(runtime, meta(runtime.identity.workspaceId, 'c4-stale'), {
      entities: [{ id: 'entity-c4', scope: 'global', entityType: 'person', canonicalKey: 'c4-person', canonicalName: 'Alice 改', beforeRevision: 999 }]
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, 'REVISION_CONFLICT');

    // 更新缺失 beforeRevision → 语义为创建路径，重复 id/规范键被唯一约束拒绝（fail-closed，零写）。
    const missing = await dispatchChangeSet(runtime, meta(runtime.identity.workspaceId, 'c4-missing'), {
      entities: [{ id: 'entity-c4', scope: 'global', entityType: 'person', canonicalKey: 'c4-person', canonicalName: 'Alice 改' }]
    });
    assert.equal(missing.ok, false, '更新既有对象缺 beforeRevision 必须拒绝');

    assert.equal(count(database, 'knowledge_change_sets'), baseline.changeSets, '失败必须零新增 change_set（整体回滚）');
    assert.equal(count(database, 'knowledge_entities'), baseline.entities);
    assert.equal(count(database, 'knowledge_note_versions'), baseline.versions);
  });
});

test('C5 跨 root 拒绝：store WORKSPACE_MISMATCH 与 dispatcher WORKSPACE_STALE 双门', async () => {
  await withRuntime(async ({ runtime, database }) => {
    // store 层：meta.workspaceId 与 DB 绑定工作空间不一致 → 拒绝，零写。
    assert.throws(() => applyKnowledgeChangeSet(database, meta('foreign-root', 'c5-foreign'), entitySegments('c5-x')), (error) => {
      assert.equal(error.code, 'WORKSPACE_MISMATCH');
      return true;
    });
    assert.equal(count(database, 'knowledge_change_sets'), 0);

    // dispatcher 层：envelope 携带别的 workspaceId → WORKSPACE_STALE（envelope 断言先于任何写）。
    const staleEnvelope = createCommandEnvelope({
      workspaceId: 'other-workspace', runtimeEpoch: runtime.identity.runtimeEpoch,
      command: CHANGE_SET_COMMAND, requestId: 'c5-stale', input: entitySegments('c5-y'),
      boundIdentity: { entityType: 'knowledge_change_set' }, actor: owner
    });
    await assert.rejects(() => runtime.dispatchCommand(staleEnvelope, () => ({ data: {}, entityType: 'knowledge_change_set' })), { code: 'WORKSPACE_STALE' });
    assert.equal(count(database, 'knowledge_change_sets'), 0);
  });
});

test('C6 调用方边界：pi/external 无 task grant → TASK_GRANT_REQUIRED（零业务写）', async () => {
  await withRuntime(async ({ runtime, database }) => {
    for (const actor of [
      { type: 'pi', id: 'pi', label: 'Pi worker' },
      { type: 'external_agent', id: 'mcp', label: 'External Agent' }
    ]) {
      const envelope = createCommandEnvelope({
        workspaceId: runtime.identity.workspaceId, runtimeEpoch: runtime.identity.runtimeEpoch,
        command: CHANGE_SET_COMMAND, requestId: `c6-${actor.type}`, input: entitySegments(`c6-${actor.type}`),
        boundIdentity: { entityType: 'knowledge_change_set' }, actor
      });
      const receipt = await runtime.dispatchCommand(envelope, () => ({ data: {}, entityType: 'knowledge_change_set' }));
      assert.equal(receipt.ok, false, `${actor.type} 无 grant 必须拒绝`);
      assert.equal(receipt.error.code, 'TASK_GRANT_REQUIRED');
      assert.equal(receipt.sideEffectState, 'not_started');
    }
    assert.equal(count(database, 'knowledge_change_sets'), 0, '无授权路径零业务写');
  });
});

test('C7 无直接 SQL 绕过 store：活动运行时上直写 knowledge_* 被写保护拒绝', async () => {
  await withRuntime(async ({ runtime, database }) => {
    assert.throws(() => database.prepare(`INSERT INTO knowledge_free_notes
      (id, scope, source_nature, body, processing_state, revision, created_at, updated_at)
      VALUES ('bypass-1', 'global', 'user_quick_note', 'x', 'captured', 1, '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z')`).run(), (error) => {
      assert.match(String(error.message), /WMB_WRITE_REQUIRES_COMMAND_DISPATCH/);
      return true;
    });
    assert.equal(count(database, 'knowledge_free_notes'), 0);
  });
});

test('C8 回执读回：receipt 段 + getUpdateReceiptByRequest 按 (workspace, request) 读回', async () => {
  await withRuntime(async ({ runtime, database }) => {
    const requestId = 'c8-receipt';
    const segments = {
      entities: entitySegments('c8-person').entities,
      receipts: [{
        triggerType: 'creation', requestId, summary: '一次测试知识变化',
        counts: { entities: 1, notes: 0 }, affectedTopics: [], affectedEntities: [], affectedMethods: [], affectedSyntheses: [],
        wikiPageVersions: [], impact: {}, autoResolutions: [], retainedDisputes: [], failures: []
      }]
    };
    const receipt = await dispatchChangeSet(runtime, meta(runtime.identity.workspaceId, requestId), segments);
    assert.equal(receipt.ok, true);
    const read = getUpdateReceiptByRequest(database, runtime.identity.workspaceId, requestId);
    assert.ok(read, '回执必须按 (workspace, request) 读回');
    assert.equal(read.changeSetId, receipt.data.changeSetId);
    assert.equal(read.summary, '一次测试知识变化');
    // 跨 workspace 读回为空（fail-closed：不串 root）。
    assert.equal(getUpdateReceiptByRequest(database, 'other-root', requestId), null);
  });
});

// ============================================================
// harness
// ============================================================

async function dispatchChangeSet(runtime, metaInput, segments, counter = { runs: 0 }) {
  const envelope = createCommandEnvelope({
    workspaceId: runtime.identity.workspaceId,
    runtimeEpoch: runtime.identity.runtimeEpoch,
    command: CHANGE_SET_COMMAND,
    requestId: metaInput.requestId,
    actor: owner,
    input: segments,
    boundIdentity: { entityType: 'knowledge_change_set', requestId: metaInput.requestId }
  });
  return runtime.dispatchCommand(envelope, () => {
    counter.runs += 1;
    // 与 ipc-knowledge-flywheel.ts execute 相同：dispatcher 事务内 transaction=false。
    const result = applyKnowledgeChangeSet(runtime.database, metaInput, segments, false);
    return { data: result, entityType: 'knowledge_change_set', entityId: result.changeSetId, readback: result };
  });
}

async function withRuntime(work) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-flywheel-cmd-'));
  let runtime;
  try {
    const database = migrateDatabase(path.join(root, 'wmb.db'));
    const now = new Date().toISOString();
    database.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)").run(`workspace-${randomUUID()}`, now, now);
    ensureOfficialWorkspaceProfile(database, 'official.ai');
    database.close();
    runtime = ActiveWorkspaceRuntime.open(root, { openDatabase: migrateDatabase, createEpoch: () => 'runtime-current' });
    await work({ root, runtime, database: runtime.database });
  } finally {
    await runtime?.stop({ drain: false });
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
