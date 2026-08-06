import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { openBrowserProfileRegistry } from '../src/main/browser-config.ts';
import { initializeWorkspaceBrowserBinding } from '../src/main/workspace-browser-binding.ts';
import {
  assertEndpointRejected,
  closeWindowAndWait,
  countRequestReceipt,
  delay,
  expectedAccount,
  killPortOwner,
  legacyFiles,
  openMcp,
  readBinding,
  readLegacyDatabase,
  reservePort,
  treeDigest,
  waitForWorkspace
} from './wmb-4809-package-helpers.mjs';

const execFileAsync = promisify(execFile);
const repo = path.resolve(import.meta.dirname, '..');
const executable = path.resolve(process.env.WMB_PACKAGE_EXE || path.join(repo, 'out', 'WeMediaBuddy-win32-x64', 'WeMediaBuddy.exe'));
const receiptPath = path.resolve(process.env.WMB_ACCEPTANCE_RECEIPT ?? path.join(repo, '.ai', 'wmb-4809-package-readback.json'));
const outer = await mkdtemp(path.join(os.tmpdir(), 'wmb-eval-029-package-'));
const parent = path.join(outer, 'parent');
const userData = path.join(parent, 'user-data');
const cdpPort = await reservePort();
let launched;
let activeBrowser;

try {
  await mkdir(parent);
  await execFileAsync(process.execPath, [path.join(repo, 'scripts', 'eval-029-fixtures.mjs'), 'materialize', '--parent', parent], {
    cwd: repo,
    env: { ...process.env, WMB_EVAL_029_ALLOW_TEMP: '1' },
    timeout: 120_000,
    windowsHide: true
  });
  const fixture = JSON.parse(await readFile(path.join(repo, 'tests', 'fixtures', 'eval-029-workspaces.v1.json'), 'utf8'));
  const roots = Object.fromEntries(Object.entries(fixture.roots).map(([key, value]) => [key, path.join(parent, value.directoryName)]));
  const registryPath = path.join(parent, fixture.installation.registryRelativePath);
  const workspaceRegistry = JSON.parse(await readFile(registryPath, 'utf8'));
  assert.equal(workspaceRegistry.activeWorkspaceId, fixture.roots.ai.workspaceId, 'package acceptance must start through the fixture registry, not a synthetic switch');

  const browserRegistry = openBrowserProfileRegistry(path.join(userData, 'browser-config.json'));
  const defaultProfileId = browserRegistry.defaultProfileId;
  const expectedAccounts = {
    ai: expectedAccount('ai', defaultProfileId),
    uk: expectedAccount('uk', defaultProfileId)
  };
  const alignedExpectedAccounts = {
    ai: null,
    uk: null
  };
  for (const key of ['ai', 'uk']) {
    const database = new DatabaseSync(path.join(roots[key], 'wmb.db'));
    try {
      const binding = initializeWorkspaceBrowserBinding(database, defaultProfileId, expectedAccounts[key]);
      assert.equal(binding.profileId, defaultProfileId);
      assert.deepEqual(binding.expectedAccountSnapshot, expectedAccounts[key]);
      // Align fixture platform_accounts with the verified binding so packaged
      // publication.snapshot_create can freeze identity without direct browser login.
      const expected = expectedAccounts[key].x;
      database.prepare(`UPDATE platform_accounts
        SET account_key=?, display_name=?, login_state='authenticated', evidence_url=?,
            browser_profile_id=?, browser_binding_revision=?, verified_at=?,
            updated_at=?, revision=revision+1
        WHERE platform='x'`).run(
        expected.accountKey,
        expected.displayName,
        expected.evidenceUrl,
        binding.profileId,
        binding.bindingRevision,
        expected.verifiedAt,
        expected.verifiedAt
      );
      const aligned = database.prepare(`SELECT account_key AS accountKey, browser_profile_id AS browserProfileId,
        browser_binding_revision AS browserBindingRevision, revision FROM platform_accounts WHERE platform='x'`).get();
      assert.equal(aligned.accountKey, expected.accountKey);
      assert.equal(aligned.browserProfileId, binding.profileId);
      assert.equal(aligned.browserBindingRevision, binding.bindingRevision);
      const snapshot = JSON.parse(JSON.stringify(binding.expectedAccountSnapshot));
      snapshot.x.accountRevision = aligned.revision;
      database.prepare("UPDATE workspace_browser_bindings SET expected_account_snapshot_json=? WHERE id='effective'")
        .run(JSON.stringify(snapshot));
      alignedExpectedAccounts[key] = snapshot;
    } finally { database.close(); }
  }
  assert.notDeepEqual(expectedAccounts.ai, expectedAccounts.uk);
  assert.equal(alignedExpectedAccounts.ai.x.accountRevision, 2);
  assert.equal(alignedExpectedAccounts.uk.x.accountRevision, 2);
  const ukExpectedBefore = readBinding(roots.uk).expectedAccounts;
  const aiLegacyBefore = await legacyFiles(roots.ai, fixture);
  const aiBrowserConfigBefore = readLegacyDatabase(roots.ai, fixture.legacySentinels.browserConfigKey);

  // Real Pi continuation prerequisite: the packaged app resolves Pi config from its own
  // userData/pi-api-config.json and decrypts via Electron safeStorage. Copy the installed
  // config AND Chromium Local State (same Windows user / app identity) WITHOUT reading or
  // logging their contents so DPAPI can decrypt the API key in the packaged process.
  const installedUserData = process.env.WMB_ACCEPTANCE_INSTALLED_USER_DATA
    || path.join(process.env.APPDATA ?? '', 'WeMediaBuddy');
  const installedPiConfigPath = process.env.WMB_ACCEPTANCE_PI_CONFIG
    || path.join(installedUserData, 'pi-api-config.json');
  const installedLocalStatePath = path.join(installedUserData, 'Local State');
  await access(installedPiConfigPath);
  await access(installedLocalStatePath);
  await mkdir(userData, { recursive: true });
  await copyFile(installedPiConfigPath, path.join(userData, 'pi-api-config.json'));
  await copyFile(installedLocalStatePath, path.join(userData, 'Local State'));

  launched = spawn(executable, [], {
    cwd: path.dirname(executable),
    env: {
      ...process.env,
      WMB_ACCEPTANCE_USER_DATA: userData,
      WMB_ACCEPTANCE_CDP_PORT: String(cdpPort),
      WMB_ACCEPTANCE_HEADLESS: '1',
      WMB_XHS_MCP_DISABLED: '1',
      // Packaged real-model continuation may exceed the default 5-minute Pi settle window.
      WMB_PI_PROMPT_TIMEOUT_MS: process.env.WMB_PI_PROMPT_TIMEOUT_MS ?? String(12 * 60_000)
    },
    stdio: 'ignore',
    windowsHide: true
  });

  const aiConnection = await waitForWorkspace(cdpPort, fixture.roots.ai.workspaceId);
  activeBrowser = aiConnection.browser;
  const aiPage = aiConnection.page;
  const aiState = await aiPage.evaluate(async () => ({
    dataRoot: await window.wmb.getDataRoot(),
    workspaces: await window.wmb.listWorkspaces(),
    settings: await window.wmb.getSettings(),
    sources: await window.wmb.listKnowledgeSources({ includeArchived: true, limit: 100 }),
    skills: await window.wmb.listPiSkills(),
    conversation: await window.wmb.getPiConversation()
  }));
  assert.equal(path.resolve(aiState.dataRoot.path), path.resolve(roots.ai));
  assert.equal(aiState.workspaces.activeWorkspaceId, fixture.roots.ai.workspaceId);
  assert.equal(aiState.settings.workspace.id, fixture.roots.ai.workspaceId);
  assert.equal(aiState.settings.browserBinding.profileId, defaultProfileId);
  assert.equal(aiState.settings.defaultBrowserProfileId, defaultProfileId);
  assert.deepEqual(aiState.settings.browserBinding.expectedAccountSnapshot, alignedExpectedAccounts.ai);
  assert.equal(aiState.sources.items.some((item) => item.id === fixture.roots.ai.ids.source), true);
  assert.equal(aiState.sources.items.some((item) => item.id === fixture.roots.uk.ids.source), false);
  assert.equal(aiState.conversation.id, fixture.roots.ai.ids.legacyConversation);
  assert.equal(aiState.conversation.messages.some((item) => item.text === fixture.sharedBusinessValues.legacyConversationMessage), true);

  const canonicalLegacySession = await readFile(aiState.conversation.sessionFile);
  assert.deepEqual(canonicalLegacySession, aiLegacyBefore.session);
  const createdConversation = await aiPage.evaluate(() => window.wmb.newPiConversation());
  assert.ok(createdConversation.id);
  assert.notEqual(createdConversation.id, fixture.roots.ai.ids.legacyConversation);
  const aiLegacyAfterConversation = await legacyFiles(roots.ai, fixture);
  assert.deepEqual(aiLegacyAfterConversation.pointer, aiLegacyBefore.pointer);
  assert.deepEqual(aiLegacyAfterConversation.session, aiLegacyBefore.session);
  assert.deepEqual(aiLegacyAfterConversation.browser, aiLegacyBefore.browser);
  assert.equal(readLegacyDatabase(roots.ai, fixture.legacySentinels.browserConfigKey), aiBrowserConfigBefore);

  const operatorText = await readFile(path.join(roots.ai, 'pi-agent', 'skills', 'wemedia-buddy-operator', 'SKILL.md'), 'utf8');
  assert.match(operatorText, /wmb_get_task_grant/);
  assert.match(operatorText, /wmb_list_task_grants/);
  assert.match(operatorText, /raw MCP 名不是 Pi 可直接调用的工具/);

  // Static readback: both runners must invoke the onTaskReady hook exactly once for a
  // newly created task, before any phase transition or Pi runtime launch, so that
  // withRuntimeWorker binds its live worker lease to that exact task.
  const runnerSource = await readFile(path.join(repo, 'src', 'main', 'agent-runner.ts'), 'utf8');
  const runnerLeaseOrdering = {};
  for (const runnerName of ['startStudioDraft', 'startResultsReview']) {
    const runnerStart = runnerSource.indexOf(`export async function ${runnerName}(`);
    assert.ok(runnerStart >= 0, `${runnerName} not found in agent-runner.ts`);
    const nextRunner = runnerSource.indexOf('export async function', runnerStart + 10);
    const runnerBody = runnerSource.slice(runnerStart, nextRunner < 0 ? runnerSource.length : nextRunner);
    const readyCall = runnerBody.indexOf('input.onTaskReady?.(task.id)');
    const phaseTransition = runnerBody.indexOf(`dispatchUpdateAgentTaskPhase(dependency, task.id, 'running_pi'`);
    const runtimeLaunch = runnerBody.indexOf('new PiRpcSupervisor(');
    assert.ok(readyCall >= 0, `${runnerName} must invoke input.onTaskReady`);
    assert.ok(phaseTransition > readyCall, `${runnerName} must invoke onTaskReady before the running_pi phase transition`);
    assert.ok(runtimeLaunch > readyCall, `${runnerName} must invoke onTaskReady before the Pi runtime launch`);
    assert.equal(runnerBody.split('input.onTaskReady?.(task.id)').length - 1, 1, `${runnerName} must invoke onTaskReady exactly once`);
    runnerLeaseOrdering[runnerName] = { onTaskReadyBeforePhaseTransition: true, onTaskReadyBeforeRuntimeLaunch: true, exactlyOnce: true };
  }

  const fixtureTask = await aiPage.evaluate((id) => window.wmb.getAgentTask({ id }), fixture.roots.ai.ids.agentTask);
  assert.equal(fixtureTask.id, fixture.roots.ai.ids.agentTask);

  // Read-only MCP surface for the automatic task-grant readback in the continuation
  // block; the packaged product has no owner issue/revoke task-grant IPC anymore.
  const aiMcp = await openMcp(aiState.settings.mcp.url);

  // ---- WMB-4812: real Pi continuation under a live worker lease ----
  // Distinct Studio task on a unique fixed business date (fixture planDate is 2026-08-05).
  const continuationBusinessDate = '2026-08-06';
  const continuationProjectId = fixture.roots.ai.ids.project;
  const continuationPollMs = 120;
  const continuationRunTimeoutMs = Number(process.env.WMB_ACCEPTANCE_PI_TIMEOUT_MS ?? 15 * 60_000);

  // Initial content-version state through the normal Studio readback API.
  const beforeProject = await aiPage.evaluate((projectId) => window.wmb.getStudioProject(projectId), continuationProjectId);
  assert.equal(beforeProject.id, continuationProjectId);
  assert.equal(beforeProject.revisions.length, 1);
  assert.equal(beforeProject.revisions[0].id, fixture.roots.ai.ids.contentVersion);

  // Register Pi events before the continuation starts.
  await aiPage.evaluate(() => {
    window.__eval029DraftUnsubscribe?.();
    window.__eval029PiEvents = [];
    window.__eval029DraftPromise = null;
    window.__eval029DraftUnsubscribe = window.wmb.onPiEvent((event) => { window.__eval029PiEvents.push(event); });
    return true;
  });

  // Start the real Pi draft asynchronously; the Promise is stored on window and the
  // renderer returns immediately. The runner auto-issues the least-privilege task grant
  // on onTaskReady, so no owner grant step exists while the run is live.
  const draftKickedOff = await aiPage.evaluate(({ businessDate, projectId }) => {
    window.__eval029DraftPromise = window.wmb.startStudioDraft({ businessDate, projectId });
    return true;
  }, { businessDate: continuationBusinessDate, projectId: continuationProjectId });
  assert.equal(draftKickedOff, true);

  // Poll until the newly running Studio task exists, then poll the read-only MCP surface
  // for the automatic grant the runner bound to that exact task.
  let continuationTask = null;
  const pollDeadline = Date.now() + 60_000;
  while (Date.now() < pollDeadline) {
    const found = await aiPage.evaluate(({ intent, businessDate }) => window.wmb.getAgentTask({ intent, businessDate }), { intent: 'studio_draft', businessDate: continuationBusinessDate });
    if (found && found.status === 'running' && found.businessDate === continuationBusinessDate) { continuationTask = found; break; }
    await delay(continuationPollMs);
  }
  assert.ok(continuationTask, `Pi continuation task never became running for ${continuationBusinessDate}`);
  assert.equal(continuationTask.intent, 'studio_draft');

  // The Pi's content.save_version envelope is attributed to external_agent:mcp by the
  // packaged MCP server, so the automatic grant carries both the pi worker and that
  // concrete server actor; it still binds the exact task the runner created under its
  // worker lease. No owner issue/revoke task-grant IPC is involved.
  let continuationGrant = null;
  const continuationGrantDeadline = Date.now() + 60_000;
  while (Date.now() < continuationGrantDeadline && !continuationGrant) {
    const grants = await aiMcp.call('task_grants.list', { task_id: continuationTask.id });
    continuationGrant = (Array.isArray(grants) ? grants : []).find((item) => item?.status === 'active' && item?.taskId === continuationTask.id) ?? null;
    if (!continuationGrant) await delay(continuationPollMs);
  }
  assert.ok(continuationGrant, `automatic task grant never became active for task ${continuationTask.id}`);
  assert.equal(continuationGrant.taskId, continuationTask.id);
  assert.ok(continuationGrant.allowedCommands.includes('content.save_version'), JSON.stringify(continuationGrant.allowedCommands));
  assert.ok(
    Array.isArray(continuationGrant.workers)
      && continuationGrant.workers.some((worker) => worker?.type === 'pi' && worker?.id === 'pi')
      && continuationGrant.workers.some((worker) => worker?.type === 'external_agent' && worker?.id === 'mcp'),
    JSON.stringify(continuationGrant.workers)
  );

  const continuationGrantMcp = await aiMcp.call('task_grants.get', { grant_id: continuationGrant.id });
  const continuationGrantsByTask = await aiMcp.call('task_grants.list', { task_id: continuationTask.id });
  assert.equal(continuationGrantMcp.id, continuationGrant.id);
  assert.equal(continuationGrantMcp.taskId, continuationTask.id);
  assert.equal(continuationGrantMcp.status, 'active');
  assert.equal(continuationGrantsByTask.some((item) => item.id === continuationGrant.id), true);

  // Await the real model result under an outer timeout.
  let draftResult;
  try {
    draftResult = await Promise.race([
      aiPage.evaluate(() => window.__eval029DraftPromise),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Pi continuation exceeded ${Math.round(continuationRunTimeoutMs / 1000)}s outer timeout`)), continuationRunTimeoutMs))
    ]);
  } catch (error) {
    assert.fail(error instanceof Error ? error.message : String(error));
  }
  assert.equal(draftResult.ok, true, JSON.stringify(draftResult));
  assert.equal(draftResult.data.reused, false);
  assert.equal(draftResult.data.task.id, continuationTask.id);
  assert.equal(draftResult.data.task.status, 'succeeded', JSON.stringify(draftResult.data.task));

  // The project must show one newly saved core version/body through Studio readback.
  const afterProject = await aiPage.evaluate((projectId) => window.wmb.getStudioProject(projectId), continuationProjectId);
  assert.equal(afterProject.revisions.length, beforeProject.revisions.length + 1);
  const afterLatest = afterProject.revisions[0];
  assert.ok(afterLatest.body?.trim(), 'Pi continuation must save a real core version body');
  assert.notEqual(afterLatest.id, fixture.roots.ai.ids.contentVersion);
  assert.equal(afterLatest.number, beforeProject.revisions[0].number + 1);

  // Pi events must demonstrate the real model/tool path; never accept absence of a
  // save-core-version tool invocation/result. Tool names are matched tolerantly.
  const continuationPiEvents = await aiPage.evaluate(() => window.__eval029PiEvents);
  const isSaveCoreVersionTool = (name) => /save[_-]?core[_-]?version|content\.save_version/i.test(String(name ?? ''));
  const saveToolInvocations = continuationPiEvents.filter((event) => event.type === 'tool' && isSaveCoreVersionTool(event.toolName));
  const saveToolResults = continuationPiEvents.filter((event) => event.type === 'tool-result' && isSaveCoreVersionTool(event.toolName));
  assert.ok(saveToolInvocations.length >= 1, 'Pi events must include a save-core-version tool invocation');
  assert.ok(saveToolResults.length >= 1, 'Pi events must include a save-core-version tool result');
  assert.ok(saveToolResults.some((event) => event.isError !== true), 'at least one save-core-version tool result must be successful');
  assert.ok(continuationPiEvents.some((event) => event.type === 'running'), 'Pi events must show the real model running');

  const continuationSettings = await aiPage.evaluate(() => window.wmb.getSettings());
  const continuationModel = continuationSettings.pi?.model ?? null;
  assert.ok(continuationModel, 'packaged Pi continuation requires a configured model in settings');

  const piContinuationEvidence = {
    modelExecuted: true,
    intent: 'studio_draft',
    businessDate: continuationBusinessDate,
    projectId: continuationProjectId,
    configuredModel: continuationModel,
    task: {
      id: continuationTask.id,
      status: draftResult.data.task.status,
      phase: draftResult.data.task.phase,
      errorCode: draftResult.data.task.errorCode,
      errorMessage: draftResult.data.task.errorMessage
    },
    grant: {
      automatic: true,
      id: continuationGrant.id,
      taskId: continuationGrant.taskId,
      taskIdMatches: continuationGrant.taskId === continuationTask.id,
      allowedCommands: continuationGrant.allowedCommands,
      workers: continuationGrant.workers,
      status: continuationGrant.status,
      expiresAt: continuationGrant.expiresAt,
      mcpGetReadback: continuationGrantMcp.id,
      mcpListReadback: continuationGrantsByTask.map((item) => item.id)
    },
    leaseBound: {
      sameTaskGrant: continuationGrant.taskId === continuationTask.id,
      runnerOrdering: runnerLeaseOrdering
    },
    toolEvents: {
      total: continuationPiEvents.length,
      runningModelEvents: continuationPiEvents.filter((event) => event.type === 'running').length,
      deltaEvents: continuationPiEvents.filter((event) => event.type === 'delta').length,
      saveToolInvocationCount: saveToolInvocations.length,
      saveToolResultCount: saveToolResults.length,
      saveToolSucceeded: saveToolResults.some((event) => event.isError !== true),
      saveToolNames: [...new Set([...saveToolInvocations, ...saveToolResults].map((event) => event.toolName))],
      otherToolNames: [...new Set(continuationPiEvents
        .filter((event) => (event.type === 'tool' || event.type === 'tool-result') && !isSaveCoreVersionTool(event.toolName))
        .map((event) => event.toolName))]
    },
    readback: {
      before: {
        projectRevision: beforeProject.revision,
        versionCount: beforeProject.revisions.length,
        latestVersionId: beforeProject.revisions[0].id,
        latestVersionNumber: beforeProject.revisions[0].number
      },
      after: {
        projectRevision: afterProject.revision,
        versionCount: afterProject.revisions.length,
        latestVersionId: afterLatest.id,
        latestVersionNumber: afterLatest.number,
        savedBodyLength: afterLatest.body.length
      },
      newCoreVersionSaved: true
    }
  };

  // ---- WMB-4812: precise execution-grant negative matrix (packaged IPC) ----
  const countExecutionGrants = (root) => {
    const database = new DatabaseSync(path.join(root, 'wmb.db'), { readOnly: true });
    try { return database.prepare('SELECT COUNT(*) AS count FROM execution_grants').get().count; }
    finally { database.close(); }
  };
  const readRequestReceipt = (root, requestId) => {
    const database = new DatabaseSync(path.join(root, 'wmb.db'), { readOnly: true });
    try {
      return database.prepare(`SELECT status, side_effect_state AS sideEffectState, receipt_json AS receiptJson
        FROM command_receipts WHERE request_id=?`).get(requestId) ?? null;
    } finally { database.close(); }
  };
  const normalizeErrorCode = (code, message) => {
    if (typeof code === 'string' && code !== 'INTERNAL_ERROR') return code;
    const text = String(message ?? '');
    const named = text.match(/\b(EXECUTION_GRANT_[A-Z_]+|TASK_GRANT_[A-Z_]+|REQUEST_REPLAY_CONFLICT|BROWSER_[A-Z_]+|PROFILE_STALE|ACCOUNT_MISMATCH|WORKSPACE_STALE|VALIDATION_ERROR|INVALID_STATE|NOT_FOUND|REVISION_CONFLICT)\b/);
    if (named?.[1]) return named[1];
    if (/taskId 与 taskGrantId|命令不属于 precise execution grant|inputHash 无效|bindingRevision 无效|必须是 JSON object|不能为空/.test(text)) return 'EXECUTION_GRANT_SCOPE_MISMATCH';
    if (/只允许精确授权 owner_ui|身份与 precise execution grant 不匹配/.test(text)) return 'EXECUTION_GRANT_IDENTITY_MISMATCH';
    if (/到期时间必须是未来时间|Precise execution grant 已过期|TaskGrantV1 已过期/.test(text)) return 'EXECUTION_GRANT_EXPIRED';
    if (/revision 已变化|撤销发生并发冲突|消费发生并发冲突/.test(text)) return 'EXECUTION_GRANT_REVISION_CONFLICT';
    if (/Precise execution grant 已撤销|TaskGrantV1 已撤销/.test(text)) return 'EXECUTION_GRANT_REVOKED';
    if (/Precise execution grant 已消费/.test(text)) return 'EXECUTION_GRANT_CONSUMED';
    if (/不属于当前 workspace|不属于当前运行时|不再处于当前运行状态/.test(text)) return 'EXECUTION_GRANT_STALE';
    if (/浏览器绑定尚未验证|浏览器绑定需要 Owner 验证|BROWSER_NEEDS_USER/.test(text)) return 'BROWSER_NEEDS_USER';
    if (/浏览器档案与当前工作空间绑定不一致|浏览器 Profile 与不可变发布快照不一致/.test(text)) return 'BROWSER_PROFILE_MISMATCH';
    if (/binding revision 已变化|浏览器绑定版本与不可变发布快照不一致|PROFILE_STALE|发布快照浏览器绑定已变化/.test(text)) return 'PROFILE_STALE';
    if (/账号与|ACCOUNT_MISMATCH|发布快照账号身份已变化/.test(text)) return 'ACCOUNT_MISMATCH';
    return typeof code === 'string' ? code : 'INTERNAL_ERROR';
  };
  const invokeGrant = async (page, method, input) => {
    return page.evaluate(async ({ methodName, payload }) => {
      const normalizeCode = (code, message) => {
        if (typeof code === 'string' && code !== 'INTERNAL_ERROR') return code;
        const text = String(message ?? '');
        const named = text.match(/\b(EXECUTION_GRANT_[A-Z_]+|TASK_GRANT_[A-Z_]+|REQUEST_REPLAY_CONFLICT|BROWSER_[A-Z_]+|PROFILE_STALE|ACCOUNT_MISMATCH|WORKSPACE_STALE|VALIDATION_ERROR|INVALID_STATE|NOT_FOUND|REVISION_CONFLICT)\b/);
        if (named?.[1]) return named[1];
        if (/taskId 与 taskGrantId|命令不属于 precise execution grant|inputHash 无效|bindingRevision 无效|必须是 JSON object|不能为空/.test(text)) return 'EXECUTION_GRANT_SCOPE_MISMATCH';
        if (/只允许精确授权 owner_ui|身份与 precise execution grant 不匹配/.test(text)) return 'EXECUTION_GRANT_IDENTITY_MISMATCH';
        if (/到期时间必须是未来时间|Precise execution grant 已过期|TaskGrantV1 已过期/.test(text)) return 'EXECUTION_GRANT_EXPIRED';
        if (/revision 已变化|撤销发生并发冲突|消费发生并发冲突/.test(text)) return 'EXECUTION_GRANT_REVISION_CONFLICT';
        if (/Precise execution grant 已撤销|TaskGrantV1 已撤销/.test(text)) return 'EXECUTION_GRANT_REVOKED';
        if (/Precise execution grant 已消费/.test(text)) return 'EXECUTION_GRANT_CONSUMED';
        if (/不属于当前 workspace|不属于当前运行时|不再处于当前运行状态/.test(text)) return 'EXECUTION_GRANT_STALE';
        if (/浏览器绑定尚未验证|浏览器绑定需要 Owner 验证|BROWSER_NEEDS_USER/.test(text)) return 'BROWSER_NEEDS_USER';
        if (/浏览器档案与当前工作空间绑定不一致|浏览器 Profile 与不可变发布快照不一致/.test(text)) return 'BROWSER_PROFILE_MISMATCH';
        if (/binding revision 已变化|浏览器绑定版本与不可变发布快照不一致|PROFILE_STALE|发布快照浏览器绑定已变化/.test(text)) return 'PROFILE_STALE';
        if (/账号与|ACCOUNT_MISMATCH|发布快照账号身份已变化/.test(text)) return 'ACCOUNT_MISMATCH';
        return typeof code === 'string' ? code : 'INTERNAL_ERROR';
      };
      try {
        const result = await window.wmb[methodName](payload);
        if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
          const message = result.error?.message ?? 'command failed';
          return {
            ok: false,
            code: normalizeCode(result.error?.code, message),
            message,
            result
          };
        }
        return { ok: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          code: normalizeCode(typeof error?.code === 'string' ? error.code : undefined, message),
          message
        };
      }
    }, { methodName: method, payload: input });
  };

  const preciseGrantBase = {
    command: 'intelligence_channels.proposal_apply',
    inputHash: 'a'.repeat(64),
    boundIdentity: { fixture: 'EVAL-029', packageAcceptance: true, surface: 'precise-grant-matrix' },
    targetActor: { type: 'owner_ui', id: 'renderer' },
    allowedTransition: 'proposal->applied',
    requiredReadback: { fixture: 'EVAL-029', surface: 'precise-grant-matrix' },
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString()
  };
  const grantsBeforeMatrix = await aiPage.evaluate(() => window.wmb.listExecutionGrants());
  const grantCountBeforeMatrix = countExecutionGrants(roots.ai);
  assert.equal(grantsBeforeMatrix.length, grantCountBeforeMatrix);

  const prevalidationCases = [];
  const prevalidationSpecs = [
    {
      name: 'task-scope-mismatch',
      expectedCode: 'EXECUTION_GRANT_SCOPE_MISMATCH',
      input: { ...preciseGrantBase, requestId: 'eval029.package.precise.scope-mismatch', taskId: 'task-without-task-grant' }
    },
    {
      name: 'unsupported-command',
      expectedCode: 'EXECUTION_GRANT_SCOPE_MISMATCH',
      input: { ...preciseGrantBase, requestId: 'eval029.package.precise.unsupported-command', command: 'sources.upsert_batch' }
    },
    {
      name: 'non-owner-target',
      expectedCode: 'EXECUTION_GRANT_IDENTITY_MISMATCH',
      input: { ...preciseGrantBase, requestId: 'eval029.package.precise.non-owner', targetActor: { type: 'pi', id: 'pi' } }
    },
    {
      name: 'expired-timestamp',
      expectedCode: 'EXECUTION_GRANT_EXPIRED',
      input: { ...preciseGrantBase, requestId: 'eval029.package.precise.expired', expiresAt: new Date(Date.now() - 1_000).toISOString() }
    }
  ];
  for (const spec of prevalidationSpecs) {
    const beforeCount = countExecutionGrants(roots.ai);
    const beforeReceipts = countRequestReceipt(roots.ai, spec.input.requestId);
    const outcome = await invokeGrant(aiPage, 'issueExecutionGrant', spec.input);
    assert.equal(outcome.ok, false, JSON.stringify(outcome));
    assert.equal(outcome.code, spec.expectedCode, JSON.stringify(outcome));
    assert.equal(countExecutionGrants(roots.ai), beforeCount);
    assert.equal(countRequestReceipt(roots.ai, spec.input.requestId), beforeReceipts);
    prevalidationCases.push({
      name: spec.name,
      requestId: spec.input.requestId,
      code: outcome.code,
      grantCountUnchanged: true,
      receiptCountUnchanged: true,
      zeroWrite: true
    });
  }

  const controlIssue = await invokeGrant(aiPage, 'issueExecutionGrant', {
    ...preciseGrantBase,
    requestId: 'eval029.package.precise.control-issue'
  });
  assert.equal(controlIssue.ok, true, JSON.stringify(controlIssue));
  const controlGrant = controlIssue.result?.data ?? controlIssue.result;
  assert.equal(controlGrant.status, 'active');
  assert.equal(controlGrant.command, 'intelligence_channels.proposal_apply');
  const controlGet = await aiPage.evaluate((id) => window.wmb.getExecutionGrant(id), controlGrant.id);
  assert.equal(controlGet?.id, controlGrant.id);
  assert.equal(controlGet?.status, 'active');

  const revisionConflict = await invokeGrant(aiPage, 'revokeExecutionGrant', {
    requestId: 'eval029.package.precise.revision-conflict',
    executionGrantId: controlGrant.id,
    expectedRevision: controlGrant.revision + 1
  });
  assert.equal(revisionConflict.ok, false, JSON.stringify(revisionConflict));
  assert.equal(revisionConflict.code, 'EXECUTION_GRANT_REVISION_CONFLICT', JSON.stringify(revisionConflict));
  const revisionConflictReceipt = readRequestReceipt(roots.ai, 'eval029.package.precise.revision-conflict');
  assert.ok(revisionConflictReceipt);
  assert.equal(revisionConflictReceipt.status, 'error');
  assert.equal(revisionConflictReceipt.sideEffectState, 'not_started');
  const stillActive = await aiPage.evaluate((id) => window.wmb.getExecutionGrant(id), controlGrant.id);
  assert.equal(stillActive?.status, 'active');

  const controlRevoke = await invokeGrant(aiPage, 'revokeExecutionGrant', {
    requestId: 'eval029.package.precise.control-revoke',
    executionGrantId: controlGrant.id,
    expectedRevision: controlGrant.revision
  });
  assert.equal(controlRevoke.ok, true, JSON.stringify(controlRevoke));
  const revokedGrant = controlRevoke.result?.data ?? controlRevoke.result;
  assert.equal(revokedGrant.status, 'revoked');
  assert.equal(revokedGrant.revision, controlGrant.revision + 1);
  const revokedGet = await aiPage.evaluate((id) => window.wmb.getExecutionGrant(id), controlGrant.id);
  assert.equal(revokedGet?.status, 'revoked');

  const revokedReuse = await invokeGrant(aiPage, 'revokeExecutionGrant', {
    requestId: 'eval029.package.precise.revoked-reuse',
    executionGrantId: controlGrant.id,
    expectedRevision: revokedGrant.revision
  });
  assert.equal(revokedReuse.ok, false, JSON.stringify(revokedReuse));
  assert.equal(revokedReuse.code, 'EXECUTION_GRANT_REVOKED', JSON.stringify(revokedReuse));
  const revokedReuseReceipt = readRequestReceipt(roots.ai, 'eval029.package.precise.revoked-reuse');
  assert.ok(revokedReuseReceipt);
  assert.equal(revokedReuseReceipt.status, 'error');
  assert.equal(revokedReuseReceipt.sideEffectState, 'not_started');

  const grantsAfterMatrix = await aiPage.evaluate(() => window.wmb.listExecutionGrants());
  assert.equal(grantsAfterMatrix.some((item) => item.id === controlGrant.id && item.status === 'revoked'), true);
  const preciseGrantNegativeMatrix = {
    prevalidationCases,
    controlLifecycle: {
      requestId: 'eval029.package.precise.control-issue',
      grantId: controlGrant.id,
      beforeStatus: 'active',
      afterStatus: 'revoked',
      revisionBefore: controlGrant.revision,
      revisionAfter: revokedGrant.revision
    },
    dispatchedRejections: [
      {
        name: 'revoke-revision-conflict',
        requestId: 'eval029.package.precise.revision-conflict',
        code: revisionConflict.code,
        receiptStatus: revisionConflictReceipt.status,
        sideEffectState: revisionConflictReceipt.sideEffectState,
        grantRemainedActive: stillActive?.status === 'active'
      },
      {
        name: 'revoked-reuse',
        requestId: 'eval029.package.precise.revoked-reuse',
        code: revokedReuse.code,
        receiptStatus: revokedReuseReceipt.status,
        sideEffectState: revokedReuseReceipt.sideEffectState
      }
    ],
    grantCountBefore: grantCountBeforeMatrix,
    grantCountAfter: countExecutionGrants(roots.ai),
    listReadbackIds: grantsAfterMatrix.map((item) => item.id)
  };

  // ---- WMB-4812: immutable publication snapshot + stale browser reconciliation ----
  const snapshotRequestId = 'eval029.package.publication-snapshot';
  const snapshotCreate = await aiPage.evaluate(({ platformVersionId, requestId }) => window.wmb.createPublicationSnapshot(platformVersionId, requestId), {
    platformVersionId: fixture.roots.ai.ids.platformVersion,
    requestId: snapshotRequestId
  });
  assert.equal(snapshotCreate.ok, true, JSON.stringify(snapshotCreate));
  const snapshotContext = snapshotCreate.data;
  assert.ok(snapshotContext?.snapshot?.id);
  assert.ok(snapshotContext?.publication?.id);
  assert.ok(snapshotContext?.operation?.id);
  assert.equal(snapshotContext.operation.state, 'prepared');
  const frozenSnapshot = JSON.parse(JSON.stringify(snapshotContext.snapshot));
  const frozenPublication = {
    id: snapshotContext.publication.id,
    revision: snapshotContext.publication.revision,
    status: snapshotContext.publication.status
  };
  const frozenOperation = {
    id: snapshotContext.operation.id,
    revision: snapshotContext.operation.revision,
    state: snapshotContext.operation.state
  };
  const snapshotReadbackBefore = await aiPage.evaluate((publicationId) => window.wmb.getPublicationSnapshot(publicationId), frozenPublication.id);
  assert.deepEqual(snapshotReadbackBefore, frozenSnapshot);
  const operationBefore = await aiPage.evaluate((operationId) => window.wmb.getPublicationBrowserOperation(operationId), frozenOperation.id);
  assert.equal(operationBefore?.state, 'prepared');
  assert.equal(operationBefore?.revision, frozenOperation.revision);
  const grantsBeforePublicationAuth = countExecutionGrants(roots.ai);

  const profileBefore = {
    profileId: aiState.settings.browserBinding.profileId,
    bindingRevision: aiState.settings.browserBinding.bindingRevision,
    runtimeEpoch: aiState.settings.workspace.runtimeEpoch,
    mcpUrl: aiState.settings.mcp.url,
    registryRevision: aiState.settings.browserRegistryRevision
  };
  await aiPage.evaluate((input) => window.wmb.createBrowserProfile(input).catch(() => null), {
    workspaceId: fixture.roots.ai.workspaceId,
    expectedBindingRevision: profileBefore.bindingRevision,
    expectedRegistryRevision: profileBefore.registryRevision,
    label: 'EVAL-029 Owner relaunch profile'
  }).catch(() => null);
  await activeBrowser.close().catch(() => {});
  activeBrowser = null;

  const profileConnection = await waitForWorkspace(cdpPort, fixture.roots.ai.workspaceId);
  activeBrowser = profileConnection.browser;
  const profilePage = profileConnection.page;
  const profileSettings = await profilePage.evaluate(() => window.wmb.getSettings());
  assert.notEqual(profileSettings.browserBinding.profileId, profileBefore.profileId);
  assert.equal(profileSettings.browserBinding.bindingRevision, profileBefore.bindingRevision + 1);
  assert.notEqual(profileSettings.workspace.runtimeEpoch, profileBefore.runtimeEpoch);
  assert.notEqual(profileSettings.mcp.url, profileBefore.mcpUrl);
  await assertEndpointRejected(profileBefore.mcpUrl);
  assert.deepEqual(readBinding(roots.uk).expectedAccounts, ukExpectedBefore);
  const aiLegacyAfterProfile = await legacyFiles(roots.ai, fixture);
  assert.deepEqual(aiLegacyAfterProfile.pointer, aiLegacyBefore.pointer);
  assert.deepEqual(aiLegacyAfterProfile.session, aiLegacyBefore.session);
  assert.deepEqual(aiLegacyAfterProfile.browser, aiLegacyBefore.browser);
  assert.equal(readLegacyDatabase(roots.ai, fixture.legacySentinels.browserConfigKey), aiBrowserConfigBefore);

  // Snapshot bytes must survive owner profile relaunch; authorize must reject the stale
  // browser identity before any browser operation transition or final publication.
  const snapshotReadbackAfter = await profilePage.evaluate((publicationId) => window.wmb.getPublicationSnapshot(publicationId), frozenPublication.id);
  assert.deepEqual(snapshotReadbackAfter, frozenSnapshot);
  const authorizeOutcome = await profilePage.evaluate(async (input) => {
    const normalizeCode = (code, message) => {
      if (typeof code === 'string' && code !== 'INTERNAL_ERROR') return code;
      const text = String(message ?? '');
      const named = text.match(/\b(EXECUTION_GRANT_[A-Z_]+|TASK_GRANT_[A-Z_]+|REQUEST_REPLAY_CONFLICT|BROWSER_[A-Z_]+|PROFILE_STALE|ACCOUNT_MISMATCH|WORKSPACE_STALE|VALIDATION_ERROR|INVALID_STATE|NOT_FOUND|REVISION_CONFLICT)\b/);
      if (named?.[1]) return named[1];
      if (/taskId 与 taskGrantId|命令不属于 precise execution grant|inputHash 无效|bindingRevision 无效|必须是 JSON object|不能为空/.test(text)) return 'EXECUTION_GRANT_SCOPE_MISMATCH';
      if (/只允许精确授权 owner_ui|身份与 precise execution grant 不匹配/.test(text)) return 'EXECUTION_GRANT_IDENTITY_MISMATCH';
      if (/到期时间必须是未来时间|Precise execution grant 已过期|TaskGrantV1 已过期/.test(text)) return 'EXECUTION_GRANT_EXPIRED';
      if (/revision 已变化|撤销发生并发冲突|消费发生并发冲突/.test(text)) return 'EXECUTION_GRANT_REVISION_CONFLICT';
      if (/Precise execution grant 已撤销|TaskGrantV1 已撤销/.test(text)) return 'EXECUTION_GRANT_REVOKED';
      if (/Precise execution grant 已消费/.test(text)) return 'EXECUTION_GRANT_CONSUMED';
      if (/不属于当前 workspace|不属于当前运行时|不再处于当前运行状态/.test(text)) return 'EXECUTION_GRANT_STALE';
      if (/浏览器绑定尚未验证|浏览器绑定需要 Owner 验证|BROWSER_NEEDS_USER/.test(text)) return 'BROWSER_NEEDS_USER';
      if (/浏览器档案与当前工作空间绑定不一致|浏览器 Profile 与不可变发布快照不一致/.test(text)) return 'BROWSER_PROFILE_MISMATCH';
      if (/binding revision 已变化|浏览器绑定版本与不可变发布快照不一致|PROFILE_STALE|发布快照浏览器绑定已变化/.test(text)) return 'PROFILE_STALE';
      if (/账号与|ACCOUNT_MISMATCH|发布快照账号身份已变化/.test(text)) return 'ACCOUNT_MISMATCH';
      return typeof code === 'string' ? code : 'INTERNAL_ERROR';
    };
    try {
      const result = await window.wmb.authorizePublicationEditor(input);
      if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
        const message = result.error?.message ?? 'command failed';
        return { ok: false, code: normalizeCode(result.error?.code, message), message, result };
      }
      return { ok: true, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        code: normalizeCode(typeof error?.code === 'string' ? error.code : undefined, message),
        message
      };
    }
  }, {
    publicationId: frozenPublication.id,
    expectedRevision: frozenPublication.revision,
    requestId: 'eval029.package.publication-authorize-stale'
  });
  assert.equal(authorizeOutcome.ok, false, JSON.stringify(authorizeOutcome));
  assert.ok(
    ['BROWSER_NEEDS_USER', 'PROFILE_STALE', 'BROWSER_PROFILE_MISMATCH', 'BROWSER_BINDING_STALE', 'ACCOUNT_MISMATCH'].includes(authorizeOutcome.code),
    `unexpected authorize rejection code: ${authorizeOutcome.code}`
  );
  const operationAfterAuth = await profilePage.evaluate((operationId) => window.wmb.getPublicationBrowserOperation(operationId), frozenOperation.id);
  assert.equal(operationAfterAuth?.state, 'prepared');
  assert.equal(operationAfterAuth?.revision, frozenOperation.revision);
  assert.equal(countExecutionGrants(roots.ai), grantsBeforePublicationAuth);
  const publicationsAfterAuth = await profilePage.evaluate(() => window.wmb.getPublications());
  const publicationAfterAuth = publicationsAfterAuth.find((item) => item.publication?.id === frozenPublication.id)
    ?? publicationsAfterAuth.find((item) => item.id === frozenPublication.id);
  const publicationStatusAfterAuth = publicationAfterAuth?.publication?.status ?? publicationAfterAuth?.status ?? null;
  assert.notEqual(publicationStatusAfterAuth, 'published');
  const publicationSnapshotReconciliation = {
    snapshotRequestId,
    platformVersionId: fixture.roots.ai.ids.platformVersion,
    publicationId: frozenPublication.id,
    snapshotId: frozenSnapshot.id,
    operationId: frozenOperation.id,
    operationStateBefore: frozenOperation.state,
    operationStateAfter: operationAfterAuth?.state ?? null,
    operationRevisionUnchanged: operationAfterAuth?.revision === frozenOperation.revision,
    snapshotImmutableAcrossProfileRelaunch: true,
    authorizeRejectedCode: authorizeOutcome.code,
    noExecutionGrantAdded: countExecutionGrants(roots.ai) === grantsBeforePublicationAuth,
    noFinalPublication: publicationStatusAfterAuth !== 'published',
    identityDelta: {
      profileIdBefore: profileBefore.profileId,
      profileIdAfter: profileSettings.browserBinding.profileId,
      bindingRevisionBefore: profileBefore.bindingRevision,
      bindingRevisionAfter: profileSettings.browserBinding.bindingRevision,
      runtimeEpochChanged: profileSettings.workspace.runtimeEpoch !== profileBefore.runtimeEpoch
    }
  };

  const switchFrom = {
    workspaceId: profileSettings.workspace.id,
    runtimeEpoch: profileSettings.workspace.runtimeEpoch,
    mcpUrl: profileSettings.mcp.url
  };
  await profilePage.evaluate((workspaceId) => window.wmb.switchWorkspace(workspaceId).catch(() => null), fixture.roots.uk.workspaceId).catch(() => null);
  await activeBrowser.close().catch(() => {});
  activeBrowser = null;

  const ukConnection = await waitForWorkspace(cdpPort, fixture.roots.uk.workspaceId);
  activeBrowser = ukConnection.browser;
  const ukPage = ukConnection.page;
  const ukState = await ukPage.evaluate(async () => ({ settings: await window.wmb.getSettings(), workspaces: await window.wmb.listWorkspaces() }));
  assert.equal(ukState.workspaces.activeWorkspaceId, fixture.roots.uk.workspaceId);
  assert.equal(ukState.settings.workspace.id, fixture.roots.uk.workspaceId);
  assert.notEqual(ukState.settings.workspace.runtimeEpoch, switchFrom.runtimeEpoch);
  assert.notEqual(ukState.settings.mcp.url, switchFrom.mcpUrl);
  assert.deepEqual(ukState.settings.browserBinding.expectedAccountSnapshot, ukExpectedBefore);
  await assertEndpointRejected(switchFrom.mcpUrl);

  const ukPreciseGrant = await ukPage.evaluate((id) => window.wmb.getExecutionGrant(id), controlGrant.id);
  assert.equal(ukPreciseGrant, null);
  const ukPublicationSnapshot = await ukPage.evaluate((publicationId) => window.wmb.getPublicationSnapshot(publicationId), frozenPublication.id);
  assert.equal(ukPublicationSnapshot, null);
  publicationSnapshotReconciliation.ukIsolation = {
    preciseGrantVisible: false,
    publicationSnapshotVisible: false
  };
  preciseGrantNegativeMatrix.ukIsolation = {
    controlGrantVisible: false
  };

  const inactiveAiBefore = await treeDigest(roots.ai);
  const inactiveObservedMs = 2_500;
  await delay(inactiveObservedMs);
  const inactiveAiAfter = await treeDigest(roots.ai);
  assert.equal(inactiveAiAfter.digest, inactiveAiBefore.digest);

  const receipt = {
    ok: true,
    schema: 'wmb.eval-029-package-readback.v1',
    scope: 'packaged Windows EVAL-029 acceptance with explicit focused-test boundaries',
    executable,
    receiptPath,
    roots,
    workspaces: {
      ai: fixture.roots.ai.workspaceId,
      uk: fixture.roots.uk.workspaceId,
      switchedByOwnerIpc: true
    },
    defaultProfile: {
      id: defaultProfileId,
      sharedAtStartup: true,
      initialAiBinding: profileBefore.profileId,
      initialUkBinding: readBinding(roots.uk).profileId
    },
    expectedAccounts: {
      ai: alignedExpectedAccounts.ai,
      uk: alignedExpectedAccounts.uk,
      distinct: true,
      ukUnchangedAcrossAiProfileRelaunch: true
    },
    piContinuation: {
      ...piContinuationEvidence,
      note: 'Real configured Pi model ran under an automatic least-privilege task grant bound to the exact task; evidence comes only from packaged WMB APIs and Pi events. The installed pi-api-config.json was copied into temp userData without reading or logging its contents; no final publication is claimed.'
    },
    preciseGrantNegativeMatrix,
    publicationSnapshotReconciliation,
    ownerProfileRelaunch: {
      command: 'createBrowserProfile',
      cdpPort,
      before: profileBefore,
      after: {
        profileId: profileSettings.browserBinding.profileId,
        bindingRevision: profileSettings.browserBinding.bindingRevision,
        runtimeEpoch: profileSettings.workspace.runtimeEpoch,
        mcpUrl: profileSettings.mcp.url
      },
      oldMcpRejected: true
    },
    workspaceSwitch: {
      command: 'window.wmb.switchWorkspace',
      from: switchFrom,
      to: { workspaceId: ukState.settings.workspace.id, runtimeEpoch: ukState.settings.workspace.runtimeEpoch, mcpUrl: ukState.settings.mcp.url },
      oldMcpRejected: true
    },
    legacyBytePreservation: {
      pointerSha256: aiLegacyBefore.pointerSha256,
      sessionSha256: aiLegacyBefore.sessionSha256,
      browserSentinelSha256: aiLegacyBefore.browserSha256,
      browserConfig: aiBrowserConfigBefore,
      canonicalConversationId: fixture.roots.ai.ids.legacyConversation,
      canonicalSessionReadbackMatchesLegacyBytes: true,
      unchangedAfterNewConversationAndRelaunch: true
    },
    operatorSkill: {
      installed: true,
      piAliases: ['wmb_get_task_grant', 'wmb_list_task_grants'],
      rawMcpNamesAreUnderlyingMappingsOnly: true
    },
    inactiveRootDigest: {
      root: 'ai',
      observedMs: inactiveObservedMs,
      before: inactiveAiBefore.digest,
      after: inactiveAiAfter.digest,
      unchanged: true
    },
    manualFinalPublicationBoundary: 'Final platform publication remains an explicit human action; no package step publishes content.',
    focusedCoverageRequired: [
      'Pi worker lease',
      'precise grant negative matrix',
      'publication snapshot reconciliation'
    ],
    quit: { windowCloseRequested: true, cdpRejected: true, finalMcpRejected: true }
  };

  await closeWindowAndWait(ukPage, activeBrowser, cdpPort, ukState.settings.mcp.url);
  activeBrowser = null;
  await mkdir(path.dirname(receiptPath), { recursive: true });
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(receipt));
} finally {
  await activeBrowser?.close().catch(() => {});
  await killPortOwner(cdpPort).catch(() => {});
  if (launched?.pid) {
    await execFileAsync('powershell.exe', ['-NoProfile', '-Command', `if(Get-Process -Id ${launched.pid} -ErrorAction SilentlyContinue){Stop-Process -Id ${launched.pid} -Force}`], { windowsHide: true, timeout: 10_000 }).catch(() => {});
  }
  await rm(outer, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
}
