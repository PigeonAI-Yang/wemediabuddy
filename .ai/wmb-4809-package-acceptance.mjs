import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  for (const key of ['ai', 'uk']) {
    const database = new DatabaseSync(path.join(roots[key], 'wmb.db'));
    try {
      const binding = initializeWorkspaceBrowserBinding(database, defaultProfileId, expectedAccounts[key]);
      assert.equal(binding.profileId, defaultProfileId);
      assert.deepEqual(binding.expectedAccountSnapshot, expectedAccounts[key]);
    } finally { database.close(); }
  }
  assert.notDeepEqual(expectedAccounts.ai, expectedAccounts.uk);
  const ukExpectedBefore = readBinding(roots.uk).expectedAccounts;
  const aiLegacyBefore = await legacyFiles(roots.ai, fixture);
  const aiBrowserConfigBefore = readLegacyDatabase(roots.ai, fixture.legacySentinels.browserConfigKey);

  launched = spawn(executable, [], {
    cwd: path.dirname(executable),
    env: {
      ...process.env,
      WMB_ACCEPTANCE_USER_DATA: userData,
      WMB_ACCEPTANCE_CDP_PORT: String(cdpPort),
      WMB_ACCEPTANCE_HEADLESS: '1',
      WMB_XHS_MCP_DISABLED: '1'
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
  assert.deepEqual(aiState.settings.browserBinding.expectedAccountSnapshot, expectedAccounts.ai);
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

  const fixtureTask = await aiPage.evaluate((id) => window.wmb.getAgentTask({ id }), fixture.roots.ai.ids.agentTask);
  assert.equal(fixtureTask.id, fixture.roots.ai.ids.agentTask);
  const startedTask = await aiPage.evaluate((input) => window.wmb.startAgentTask(input), {
    intent: 'studio_draft',
    businessDate: fixture.sharedBusinessValues.planDate,
    contextRefs: { workspaceId: fixture.roots.ai.workspaceId, fixture: 'EVAL-029', packageAcceptance: true }
  });
  assert.equal(startedTask.ok, true, JSON.stringify(startedTask));
  assert.equal(startedTask.data.status, 'running');
  const taskId = startedTask.data.id;
  const grantRequestId = 'eval029.package.owner-grant';
  const grantReceipt = await aiPage.evaluate((input) => window.wmb.issueTaskGrant(input), {
    requestId: grantRequestId,
    taskId,
    ownerGoal: 'EVAL-029 packaged external Agent continuation',
    allowedCommands: ['sources.upsert_batch'],
    workers: [{ type: 'pi', id: 'pi' }, { type: 'external_agent', id: 'mcp' }],
    relevantContext: { fixture: 'EVAL-029', packageAcceptance: true },
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString()
  });
  assert.equal(grantReceipt.ok, true, JSON.stringify(grantReceipt));
  const grant = grantReceipt.data;
  assert.equal(grant.taskId, taskId);
  assert.deepEqual(grant.allowedCommands, ['sources.upsert_batch']);
  assert.deepEqual(grant.workers, [{ type: 'pi', id: 'pi' }, { type: 'external_agent', id: 'mcp' }]);

  const aiMcp = await openMcp(aiState.settings.mcp.url);
  const grantById = await aiMcp.call('task_grants.get', { grant_id: grant.id });
  const grantsByTask = await aiMcp.call('task_grants.list', { task_id: taskId });
  assert.equal(grantById.id, grant.id);
  assert.equal(grantsByTask.some((item) => item.id === grant.id), true);

  const sourceRequestId = 'eval029.package.external-source';
  const sourceInput = {
    request_id: sourceRequestId,
    task_id: taskId,
    grant_id: grant.id,
    items: [{
      title: 'EVAL-029 packaged external Agent source',
      originalUrl: 'https://example.com/eval-029/package-external-source',
      summary: '真实 MCP task grant 写入、重放与冲突证据。'
    }]
  };
  const sourceReceipt = await aiMcp.call('sources.upsert_batch', sourceInput);
  assert.equal(sourceReceipt.ok, true);
  assert.equal(sourceReceipt.actor.type, 'external_agent');
  assert.equal(sourceReceipt.actor.id, 'mcp');
  const sourceReplay = await aiMcp.call('sources.upsert_batch', sourceInput);
  assert.deepEqual(sourceReplay, sourceReceipt);
  const sourceConflict = await aiMcp.call('sources.upsert_batch', {
    ...sourceInput,
    items: [{ ...sourceInput.items[0], summary: '改变输入必须冲突且零写。' }]
  });
  assert.equal(sourceConflict.ok, false);
  assert.equal(sourceConflict.error.code, 'REQUEST_REPLAY_CONFLICT');
  const externalSourceId = sourceReceipt.data.items[0].id;
  const failedTask = await aiPage.evaluate((input) => window.wmb.failAgentTask(input), {
    id: taskId,
    errorCode: 'EVAL_029_COMPLETE',
    errorMessage: 'Package grant and replay matrix completed.'
  });
  assert.equal(failedTask.ok, true, JSON.stringify(failedTask));
  assert.equal(failedTask.data.status, 'failed');

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

  const ukMcp = await openMcp(ukState.settings.mcp.url);
  const ukSearch = await ukMcp.call('sources.search', { query: sourceInput.items[0].originalUrl, limit: 20 });
  assert.equal(ukSearch.some((item) => item.id === externalSourceId), false);
  assert.equal(countRequestReceipt(roots.uk, sourceRequestId), 0);
  assert.equal(countRequestReceipt(roots.ai, sourceRequestId), 1);

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
      ai: expectedAccounts.ai,
      uk: expectedAccounts.uk,
      distinct: true,
      ukUnchangedAcrossAiProfileRelaunch: true
    },
    taskGrant: {
      requestId: grantRequestId,
      id: grant.id,
      taskId,
      allowedCommands: grant.allowedCommands,
      workers: grant.workers,
      mcpGetReadback: grantById.id,
      mcpListReadback: grantsByTask.map((item) => item.id)
    },
    mcpReplayConflict: {
      requestId: sourceRequestId,
      sourceId: externalSourceId,
      firstReceiptId: sourceReceipt.receiptId,
      replayByteEquivalent: true,
      conflictCode: sourceConflict.error.code,
      ukSourceVisible: false,
      ukReceiptCount: 0,
      aiReceiptCount: 1
    },
    piContinuation: {
      modelExecuted: false,
      evidence: 'Pi alias availability is covered by tests/pi-extension.test.mjs; this package run does not claim a model invocation or Pi write.'
    },
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
