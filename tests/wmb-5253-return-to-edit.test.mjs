// WMB-5253：Owner 审稿不通过 → awaiting_confirmation 退回创作修改聚焦测试。
// 覆盖：
// 1. 成功路径：真实 dispatch 链（快照 → 授权 → 编辑器准备 → awaiting_confirmation）后，
//    退回命令复用既有 awaiting_confirmation → draft 迁移，写 draft 状态 + Owner preflight
//    rejection 审计事件；不可变快照与浏览器操作终态不改写，零发布副作用
//    （无 attempt/confirmation/外部 URL，无自动发布）；
// 2. 陈旧 revision：CAS 拒绝（REVISION_CONFLICT），状态与事件不变；
// 3. 非 awaiting_confirmation（draft / prepared）：在任何通用迁移之前显式拒绝（INVALID_STATE）；
// 4. preload 接线：returnPublicationToEdit 真实调用 publish:return-to-edit 通道。
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { register } from 'node:module';

// ---- 测试本地 ESM 解析钩子：electron → 捕获型桩；相对无扩展名补 .ts（wmb-5249 同款模式）----
const ELECTRON_STUB = [
  'const ipcRenderer = { invoke: async (channel, ...args) => { globalThis.__wmbInvoked.push([channel, args]); return { ok: true, data: null, error: null }; } };',
  'const contextBridge = { exposeInMainWorld: (name, api) => { globalThis.__wmbExposed = { name, api }; } };',
  'export { ipcRenderer, contextBridge };',
  'export default { ipcRenderer, contextBridge };'
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
  '}'
].join('\n');
register('data:text/javascript,' + encodeURIComponent(HOOK_SOURCE), import.meta.url);
globalThis.__wmbExposed = null;
globalThis.__wmbInvoked = [];

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { createContentProject, saveCoreVersion, savePlatformVersion } = await import('../src/main/content.ts');
const { ActiveWorkspaceRuntime } = await import('../src/main/workspace-runtime.ts');
const { initializeWorkspaceBrowserBinding, markWorkspaceBrowserBindingVerified } = await import('../src/main/workspace-browser-binding.ts');
const { dispatchCreatePublicationSnapshot, dispatchPreparePublicationEditor, dispatchReturnPublicationToEdit } = await import('../src/main/publication-commands.ts');
const { createPublicationSnapshot } = await import('../src/main/publication-operations.ts');
const { transitionPublication } = await import('../src/main/publishing.ts');

const NOW = '2026-08-14T00:00:00.000Z';

async function withDatabaseDir(work) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-5253-return-'));
  try {
    return await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
}

/** 建工作空间 + 已认证 X 绑定 + 项目/平台版本，返回 setup 阶段可写 DB 与冻结身份。 */
function seedWorkspace(directory, workspaceId, profileId, accountKey) {
  const databasePath = path.join(directory, 'wmb.db');
  const setup = migrateDatabase(databasePath);
  setup.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)").run(workspaceId, NOW, NOW);
  initializeWorkspaceBrowserBinding(setup, profileId);
  const binding = markWorkspaceBrowserBindingVerified(setup, {
    profileId, expectedBindingRevision: 1,
    account: { platform: 'x', accountKey, displayName: 'Owner 5253', loginState: 'authenticated', evidenceUrl: `https://x.com/${accountKey}` }
  });
  const project = createContentProject(setup, { title: '退回创作项目' });
  const core = saveCoreVersion(setup, { projectId: project.id, body: '核心正文', expectedRevision: 1 });
  if (!core.ok) throw new Error('core setup failed');
  const version = savePlatformVersion(setup, {
    projectId: project.id, contentVersionId: core.data.id, platform: 'x', format: 'text',
    title: '退回标题', body: '退回正文', assetIds: []
  });
  if (!version.ok) throw new Error('version setup failed');
  return { databasePath, setup, binding, projectId: project.id, platformVersionId: version.data.id };
}

/** 经真实派发链把发布记录推进到 awaiting_confirmation（operation succeeded）。 */
async function prepareToAwaitingConfirmation(runtime, { platformVersionId, binding, profileId, accountKey, requestSuffix }) {
  const fakeBrowserRuntime = Object.freeze({ cdpUrl: `fake://5253-${requestSuffix}`, stop: async () => {} });
  const fakeBrowser = Object.freeze({
    profile: Object.freeze({ id: profileId, label: '5253 profile' }),
    binding: Object.freeze({ profileId, bindingRevision: binding.bindingRevision }),
    identity: Object.freeze({ platform: 'x', accountKey, displayName: 'Owner 5253', loginState: 'authenticated', evidenceUrl: `https://x.com/${accountKey}` }),
    runtime: fakeBrowserRuntime
  });
  const setBrowser = (browser) => runtime.bindBrowser(browser);
  const snapshotReceipt = await dispatchCreatePublicationSnapshot(runtime, { platformVersionId, requestId: `5253-${requestSuffix}-snapshot` });
  assert.equal(snapshotReceipt.ok, true);
  const prepared = snapshotReceipt.data;
  const prepareReceipt = await dispatchPreparePublicationEditor(runtime, {
    publicationId: prepared.publication.id, expectedRevision: prepared.publication.revision, requestId: `5253-${requestSuffix}-prepare`
  }, setBrowser, {
    startBrowser: async () => fakeBrowser,
    invokeEditor: async () => ({ title: '退回标题', body: '退回正文', assetIds: [], evidenceUrl: `https://x.com/compose/5253-${requestSuffix}` })
  });
  assert.equal(prepareReceipt.ok, true);
  return prepared;
}

test('WMB-5253 return to edit writes draft + audit reason, preserves snapshot and manual boundary', async () => {
  await withDatabaseDir(async (directory) => {
    const workspaceId = 'workspace-5253-ok';
    const runtimeEpoch = 'epoch-5253-ok';
    const profileId = 'profile-5253-ok';
    const accountKey = '@owner-5253-ok';
    const { databasePath, binding, projectId, platformVersionId } = seedWorkspace(directory, workspaceId, profileId, accountKey);
    const runtime = ActiveWorkspaceRuntime.open(directory, { expectedWorkspaceId: workspaceId, createEpoch: () => runtimeEpoch, openDatabase: migrateDatabase });
    try {
      const prepared = await prepareToAwaitingConfirmation(runtime, { platformVersionId, binding, profileId, accountKey, requestSuffix: 'ok' });
      assert.equal(prepared.publication.projectId, projectId);
      const awaiting = runtime.database.prepare('SELECT status, revision FROM publications WHERE id=?').get(prepared.publication.id);
      assert.equal(awaiting.status, 'awaiting_confirmation');
      const eventsBefore = Number(runtime.database.prepare('SELECT COUNT(*) AS count FROM publication_events WHERE publication_id=?').get(prepared.publication.id).count);

      const returned = await dispatchReturnPublicationToEdit(runtime, { publicationId: prepared.publication.id, expectedRevision: awaiting.revision });
      assert.equal(returned.ok, true);
      assert.equal(returned.data.status, 'draft');
      assert.equal(returned.data.revision, awaiting.revision + 1);
      assert.equal(returned.data.externalUrl, null);
      assert.equal(returned.data.externalId, null);
      assert.equal(returned.data.publishedAt, null);
      // 审计事件：awaiting_confirmation → draft，reason 明确记录 Owner preflight rejection。
      const events = runtime.database.prepare('SELECT from_status AS fromStatus, to_status AS toStatus, reason FROM publication_events WHERE publication_id=? ORDER BY rowid').all(prepared.publication.id);
      assert.equal(events.length, eventsBefore + 1);
      const last = events[events.length - 1];
      assert.equal(last.fromStatus, 'awaiting_confirmation');
      assert.equal(last.toStatus, 'draft');
      assert.match(last.reason, /Owner preflight rejection/);
      // 零发布副作用：无 attempt / confirmation；不可变快照与浏览器操作终态不改写。
      assert.equal(runtime.database.prepare('SELECT COUNT(*) AS count FROM publication_attempts WHERE publication_id=?').get(prepared.publication.id).count, 0);
      assert.equal(runtime.database.prepare('SELECT COUNT(*) AS count FROM publication_confirmations WHERE publication_id=?').get(prepared.publication.id).count, 0);
      const operation = runtime.database.prepare('SELECT state FROM publication_browser_operations WHERE id=?').get(prepared.operation.id);
      assert.equal(operation.state, 'succeeded');
      const snapshot = runtime.database.prepare('SELECT input_hash AS inputHash FROM publication_snapshots WHERE id=?').get(prepared.snapshot.id);
      assert.equal(snapshot.inputHash, prepared.snapshot.inputHash);
    } finally {
      await runtime.stop({ drain: true }).catch(() => {});
    }
  });
});

test('WMB-5253 return to edit rejects stale revision (CAS preserved)', async () => {
  await withDatabaseDir(async (directory) => {
    const workspaceId = 'workspace-5253-stale';
    const runtimeEpoch = 'epoch-5253-stale';
    const profileId = 'profile-5253-stale';
    const accountKey = '@owner-5253-stale';
    const { databasePath, binding, platformVersionId } = seedWorkspace(directory, workspaceId, profileId, accountKey);
    const runtime = ActiveWorkspaceRuntime.open(directory, { expectedWorkspaceId: workspaceId, createEpoch: () => runtimeEpoch, openDatabase: migrateDatabase });
    try {
      const prepared = await prepareToAwaitingConfirmation(runtime, { platformVersionId, binding, profileId, accountKey, requestSuffix: 'stale' });
      const awaiting = runtime.database.prepare('SELECT status, revision FROM publications WHERE id=?').get(prepared.publication.id);
      const eventsBefore = Number(runtime.database.prepare('SELECT COUNT(*) AS count FROM publication_events WHERE publication_id=?').get(prepared.publication.id).count);
      const returned = await dispatchReturnPublicationToEdit(runtime, { publicationId: prepared.publication.id, expectedRevision: awaiting.revision - 1 });
      assert.equal(returned.ok, false);
      assert.equal(returned.error.code, 'REVISION_CONFLICT');
      const after = runtime.database.prepare('SELECT status, revision FROM publications WHERE id=?').get(prepared.publication.id);
      assert.equal(after.status, 'awaiting_confirmation');
      assert.equal(after.revision, awaiting.revision);
      assert.equal(runtime.database.prepare('SELECT COUNT(*) AS count FROM publication_events WHERE publication_id=?').get(prepared.publication.id).count, eventsBefore);
    } finally {
      await runtime.stop({ drain: true }).catch(() => {});
    }
  });
});

test('WMB-5253 return to edit rejects non-awaiting states before any generic transition', async () => {
  await withDatabaseDir(async (directory) => {
    const workspaceId = 'workspace-5253-invalid';
    const runtimeEpoch = 'epoch-5253-invalid';
    const profileId = 'profile-5253-invalid';
    const accountKey = '@owner-5253-invalid';
    const { databasePath, setup, binding, platformVersionId } = seedWorkspace(directory, workspaceId, profileId, accountKey);
    // setup 阶段直建两条记录：一条停在 draft（快照后未准备），一条经真实迁移到 prepared。
    const accountId = setup.prepare("SELECT id FROM platform_accounts WHERE platform='x'").get().id;
    const snapshotDraft = createPublicationSnapshot(setup, {
      platformVersionId, accountId, browserProfileId: profileId, browserBindingRevision: binding.bindingRevision,
      workspaceId, runtimeEpoch, payload: { title: '退回标题', body: '退回正文', assets: [] }, causation: { actor: 'owner_ui', requestId: '5253-draft' }
    });
    assert.equal(snapshotDraft.ok, true);
    const preparedRecord = createPublicationSnapshot(setup, {
      platformVersionId, accountId, browserProfileId: profileId, browserBindingRevision: binding.bindingRevision,
      workspaceId, runtimeEpoch, payload: { title: '退回标题', body: '退回正文', assets: [] }, causation: { actor: 'owner_ui', requestId: '5253-prepared' }
    });
    assert.equal(preparedRecord.ok, true);
    const preparedTransition = transitionPublication(setup, preparedRecord.data.publication.id, 'prepared', { expectedRevision: preparedRecord.data.publication.revision });
    assert.equal(preparedTransition.ok, true);
    setup.close();

    const runtime = ActiveWorkspaceRuntime.open(directory, { expectedWorkspaceId: workspaceId, createEpoch: () => runtimeEpoch, openDatabase: migrateDatabase });
    try {
      const cases = [
        { id: snapshotDraft.data.publication.id, expectedRevision: snapshotDraft.data.publication.revision, expectedStatus: 'draft' },
        { id: preparedTransition.data.id, expectedRevision: preparedTransition.data.revision, expectedStatus: 'prepared' }
      ];
      for (const { id, expectedRevision, expectedStatus } of cases) {
        const eventsBefore = Number(runtime.database.prepare('SELECT COUNT(*) AS count FROM publication_events WHERE publication_id=?').get(id).count);
        const receipt = await dispatchReturnPublicationToEdit(runtime, { publicationId: id, expectedRevision });
        assert.equal(receipt.ok, false, `状态 ${expectedStatus} 不得通过通用迁移退回`);
        assert.equal(receipt.error.code, 'INVALID_STATE');
        const row = runtime.database.prepare('SELECT status FROM publications WHERE id=?').get(id);
        assert.equal(row.status, expectedStatus, '拒绝后状态不得被改写');
        assert.equal(runtime.database.prepare('SELECT COUNT(*) AS count FROM publication_events WHERE publication_id=?').get(id).count, eventsBefore, '拒绝不得产生审计事件');
      }
    } finally {
      await runtime.stop({ drain: true }).catch(() => {});
    }
  });
});

test('WMB-5253 preload exposes returnPublicationToEdit wired to publish:return-to-edit channel', async () => {
  globalThis.__wmbInvoked = [];
  await import('../src/preload/preload.ts');
  assert.equal(globalThis.__wmbExposed.name, 'wmb');
  const api = globalThis.__wmbExposed.api;
  assert.equal(typeof api.returnPublicationToEdit, 'function');
  const result = await api.returnPublicationToEdit('pub-5253', 7);
  assert.equal(result.ok, true);
  assert.deepEqual(globalThis.__wmbInvoked, [['publish:return-to-edit', ['pub-5253', 7]]]);
});
