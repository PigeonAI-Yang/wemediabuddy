import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { completeAgentTask, agentRequestId, finishDailyIntelligenceFromReceipts, getAgentTask, readDailyReceiptAggregation, startAgentTask, updateAgentTaskPhase } from '../src/main/agent-tasks.ts';
import { startDailyChannelRun } from '../src/main/daily-intelligence-channels.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { createWebsiteSource, recordSourceScanReceipt, setWebsiteSourceEnabled } from '../src/main/intelligence-channels.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { upsertSource } from '../src/main/sources.ts';
import { bindXList, setXListBindingEnabled } from '../src/main/x-lists.ts';
import { collectBoundXListTimeline } from '../src/main/x-list-execution.ts';
import { insertWorkspaceProfile } from '../src/main/workspace-profiles.ts';
import { startWorkspaceDailyIntelligence } from '../src/main/workspace-intelligence.ts';
import { startMcp } from '../src/main/mcp.ts';

async function makeRoot(prefix = 'wmb-daily-channels-') {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  const workspaceId = `${prefix.replace(/[^a-z]/gi, '')}-workspace`;
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO app_meta (key, value, created_at, updated_at, revision)
    VALUES ('workspace_id', ?, ?, ?, 1)`).run(workspaceId, now, now);
  return { root, database, workspaceId };
}

function website(database, slug) {
  const url = `https://example.com/${slug}`;
  return createWebsiteSource(database, {
    inputText: url,
    name: `Example ${slug}`,
    canonicalUrl: url,
    resolutionStatus: 'ready',
    trialRead: { title: `Example ${slug}`, url, readable: true, summary: 'A readable source page for the daily channel test.' }
  });
}

function recordWebsiteSuccess(database, taskId, workspaceId, source, savedCount = 0) {
  return recordSourceScanReceipt(database, {
    taskId, workspaceId, module: 'official_web', sourceId: source.id, sourceFeedId: source.sourceFeedId,
    status: 'succeeded', candidateCount: savedCount, savedCount
  });
}

function savePlanReadback(database, task, planDate, items = []) {
  saveCurrentPlan(database, { planDate, timezone: 'Asia/Shanghai', summary: '今日没有新增机会', items });
  database.prepare('INSERT INTO mcp_request_results(tool,request_id,result_json,created_at) VALUES(?,?,?,?)')
    .run('plans.save', agentRequestId(task.id, 'plan'), '{}', new Date().toISOString());
}

test('zero-item website receipt plus an empty saved plan completes daily intelligence truthfully', async () => {
  const current = await makeRoot();
  try {
    const source = website(current.database, 'zero');
    const ignoredX = bindXList(current.database, {
      accountKey: '@owner', list: { listId: '900', canonicalUrl: 'https://x.com/i/lists/900', ownerHandle: '@owner', name: 'Ignored this run', kind: 'owned' }
    });
    assert.equal(ignoredX.ok, true);
    const run = await startDailyChannelRun(current.database, {
      businessDate: '2026-08-03', workspaceId: current.workspaceId, profileRevision: 1, modules: ['official_web']
    }, {
      scanWebsite: async (database, input) => {
        recordWebsiteSuccess(database, input.taskId, input.workspaceId, source);
      }
    });
    assert.equal(run.shouldRunJudgment, true);
    assert.equal(run.aggregation?.status, 'succeeded');
    assert.deepEqual(run.frozen.modules, ['official_web']);
    assert.equal(run.frozen.sources.length, 1);
    savePlanReadback(current.database, run.task, '2026-08-03');
    const completed = completeAgentTask(current.database, run.task.id);
    assert.equal(completed.ok, true);
    assert.equal(completed.data.status, 'succeeded');
    assert.equal(completed.data.resultRefs.opportunityCount, 0);
    assert.equal(current.database.prepare('SELECT COUNT(*) AS count FROM source_items').get().count, 0);
    assert.equal(current.database.prepare('SELECT COUNT(*) AS count FROM source_scan_receipts WHERE module=?').get('x_lists').count, 0);
  } finally {
    current.database.close();
    await rm(current.root, { recursive: true, force: true });
  }
});

test('one committed channel success and one channel failure finish as partial without rollback', async () => {
  const current = await makeRoot();
  try {
    const good = website(current.database, 'good');
    const bad = website(current.database, 'bad');
    const run = await startDailyChannelRun(current.database, {
      businessDate: '2026-08-03', workspaceId: current.workspaceId, profileRevision: 1
    }, {
      scanWebsite: async (database, input) => {
        if (input.sourceId === bad.id) throw Object.assign(new Error('upstream unavailable'), { code: 'WEBSITE_TRIAL_FAILED' });
        upsertSource(database, { feedId: good.sourceFeedId, originalUrl: 'https://example.com/good/item', title: 'Committed item', summary: 'A committed real item.' });
        recordWebsiteSuccess(database, input.taskId, input.workspaceId, good, 1);
      }
    });
    assert.equal(run.shouldRunJudgment, true);
    assert.equal(run.aggregation?.status, 'partial');
    savePlanReadback(current.database, run.task, '2026-08-03');
    const completed = completeAgentTask(current.database, run.task.id);
    assert.equal(completed.ok, true);
    assert.equal(completed.data.status, 'partial');
    assert.equal(current.database.prepare('SELECT COUNT(*) AS count FROM source_items').get().count, 1);
    assert.equal(current.database.prepare('SELECT COUNT(*) AS count FROM source_scan_receipts WHERE task_id=?').get(run.task.id).count, 2);
  } finally {
    current.database.close();
    await rm(current.root, { recursive: true, force: true });
  }
});

test('a later lane/runtime failure preserves trustworthy channel results as partial', async () => {
  const current = await makeRoot('wmb-daily-runtime-failure-');
  try {
    const source = website(current.database, 'runtime');
    const run = await startDailyChannelRun(current.database, {
      businessDate: '2026-08-03', workspaceId: current.workspaceId, profileRevision: 1
    }, {
      scanWebsite: async (database, input) => {
        upsertSource(database, { feedId: source.sourceFeedId, originalUrl: 'https://example.com/runtime/item', title: 'Surviving item' });
        recordWebsiteSuccess(database, input.taskId, input.workspaceId, source, 1);
      }
    });
    const finished = finishDailyIntelligenceFromReceipts(current.database, run.task.id, {
      forcePartial: true, errorCode: 'PI_EXIT', errorMessage: 'Pi exited after channel scans.'
    });
    assert.equal(finished.ok, true);
    assert.equal(finished.data.status, 'partial');
    assert.equal(finished.data.errorCode, 'PI_EXIT');
    assert.equal(current.database.prepare('SELECT COUNT(*) AS count FROM source_items').get().count, 1);
    assert.equal(current.database.prepare('SELECT COUNT(*) AS count FROM source_scan_receipts').get().count, 1);
  } finally {
    current.database.close();
    await rm(current.root, { recursive: true, force: true });
  }
});

test('all blocked sources persist needs_user before any injected lane runner starts', async () => {
  const current = await makeRoot('wmb-daily-blocked-');
  try {
    insertWorkspaceProfile(current.database, {
      profileId: 'profile.test.uk', revision: 1, officialTemplateId: null, officialTemplateVersion: null,
      displayName: '英国生活', audience: '在英华人', contentGoal: '生活信息', editorialBrief: '实用优先',
      intelligencePackId: 'uk-life-content-radar', intelligencePackVersion: 1,
      creationPackId: 'wmb-core-creation', creationPackVersion: 1, platforms: ['x']
    });
    const binding = bindXList(current.database, {
      accountKey: '@owner', list: { listId: '101', canonicalUrl: 'https://x.com/i/lists/101', ownerHandle: '@owner', name: 'UK updates', kind: 'owned' }
    });
    assert.equal(binding.ok, true);
    let calls = 0;
    const result = await startWorkspaceDailyIntelligence({ dataRootPath: current.root, businessDate: '2026-08-03', mcpUrl: 'http://127.0.0.1:1/mcp' }, {
      uk: async () => { calls += 1; throw new Error('lane runner must not start'); }
    });
    assert.equal(result.task.status, 'needs_user');
    assert.equal(result.task.errorCode, 'CHANNELS_NEEDS_USER');
    assert.equal(result.task.progress.planned, 1);
    assert.equal(result.task.progress.processed, 1);
    assert.equal(result.task.progress.failed, 1);
    assert.equal(calls, 0);
    assert.equal(current.database.prepare('SELECT COUNT(*) AS count FROM source_scan_receipts').get().count, 1);
  } finally {
    current.database.close();
    await rm(current.root, { recursive: true, force: true });
  }
});

test('an orchestration exception with no durable receipt fails instead of claiming success', async () => {
  const current = await makeRoot('wmb-daily-failed-');
  try {
    const source = website(current.database, 'throw');
    const run = await startDailyChannelRun(current.database, {
      businessDate: '2026-08-03', workspaceId: current.workspaceId, profileRevision: 1
    }, {
      scanWebsite: async (database) => {
        database.prepare('DELETE FROM website_sources WHERE id=?').run(source.id);
        throw new Error('scanner aborted before receipt');
      }
    });
    assert.equal(run.shouldRunJudgment, false);
    assert.equal(run.task.status, 'failed');
    assert.equal(current.database.prepare('SELECT COUNT(*) AS count FROM source_scan_receipts').get().count, 0);
  } finally {
    current.database.close();
    await rm(current.root, { recursive: true, force: true });
  }
});

test('late X results write neither cached nor source data after binding revision changes, while another source continues', async () => {
  const current = await makeRoot('wmb-daily-stale-x-');
  try {
    const web = website(current.database, 'stable-web');
    const bound = bindXList(current.database, {
      accountKey: '@owner', list: { listId: '202', canonicalUrl: 'https://x.com/i/lists/202', ownerHandle: '@owner', name: 'AI updates', kind: 'owned' }
    });
    assert.equal(bound.ok, true);
    const run = await startDailyChannelRun(current.database, {
      businessDate: '2026-08-03', workspaceId: current.workspaceId, profileRevision: 1
    }, {
      browserConfig: { id: 'edge:test', label: 'test', executablePath: 'test', userDataDir: 'test', profileDirectory: 'Default', cdpUrl: 'http://127.0.0.1:1' },
      scanWebsite: async (database, input) => {
        upsertSource(database, { feedId: web.sourceFeedId, originalUrl: 'https://example.com/stable-web/item', title: 'Stable website item' });
        recordWebsiteSuccess(database, input.taskId, input.workspaceId, web, 1);
      },
      collectX: async (database, config, input) => collectBoundXListTimeline(database, config, {
        ...input,
        readTimeline: async () => {
          const changed = setXListBindingEnabled(database, { accountKey: '@owner', listId: '202', expectedRevision: bound.data.revision, enabled: false });
          assert.equal(changed.ok, true);
          return {
            accountKey: '@owner', posts: [{ url: 'https://x.com/owner/status/1', text: 'Late X post', authorHandle: '@owner', postedAt: '2026-08-03T00:00:00.000Z' }],
            detail: { name: 'AI updates', canonicalUrl: 'https://x.com/i/lists/202', observation: { capturedAt: '2026-08-03T00:00:00.000Z', pageUrl: 'https://x.com/i/lists/202', fingerprint: 'late' } }
          };
        }
      })
    });
    assert.equal(run.shouldRunJudgment, true);
    assert.equal(run.aggregation?.status, 'partial');
    assert.equal(current.database.prepare('SELECT COUNT(*) AS count FROM source_items').get().count, 1);
    assert.equal(current.database.prepare('SELECT COUNT(*) AS count FROM x_list_timeline_cache').get().count, 0);
    assert.equal(current.database.prepare('SELECT COUNT(*) AS count FROM x_post_metric_snapshots').get().count, 0);
  } finally {
    current.database.close();
    await rm(current.root, { recursive: true, force: true });
  }
});

test('identical channel fixtures keep receipts and source items inside their own data roots', async () => {
  const left = await makeRoot('wmb-daily-left-');
  const right = await makeRoot('wmb-daily-right-');
  try {
    const leftSource = website(left.database, 'same');
    const rightSource = website(right.database, 'same');
    const run = async (current, source) => startDailyChannelRun(current.database, {
      businessDate: '2026-08-03', workspaceId: current.workspaceId, profileRevision: 1
    }, {
      scanWebsite: async (database, input) => {
        const saved = upsertSource(database, { feedId: source.sourceFeedId, originalUrl: 'https://example.com/same/item', title: `Item ${current.workspaceId}` });
        recordWebsiteSuccess(database, input.taskId, input.workspaceId, source, 1);
        return saved;
      }
    });
    const [leftRun, rightRun] = await Promise.all([run(left, leftSource), run(right, rightSource)]);
    assert.notEqual(leftRun.task.id, rightRun.task.id);
    assert.equal(left.database.prepare('SELECT COUNT(*) AS count FROM source_scan_receipts WHERE workspace_id=?').get(left.workspaceId).count, 1);
    assert.equal(right.database.prepare('SELECT COUNT(*) AS count FROM source_scan_receipts WHERE workspace_id=?').get(right.workspaceId).count, 1);
    assert.equal(left.database.prepare('SELECT COUNT(*) AS count FROM source_items').get().count, 1);
    assert.equal(right.database.prepare('SELECT COUNT(*) AS count FROM source_items').get().count, 1);
  } finally {
    left.database.close(); right.database.close();
    await Promise.all([rm(left.root, { recursive: true, force: true }), rm(right.root, { recursive: true, force: true })]);
  }
});

test('a nonempty plan with a missing source remains rejected after a truthful scan', async () => {
  const current = await makeRoot('wmb-daily-plan-');
  try {
    const source = website(current.database, 'plan');
    let itemId = '';
    const run = await startDailyChannelRun(current.database, {
      businessDate: '2026-08-03', workspaceId: current.workspaceId, profileRevision: 1
    }, {
      scanWebsite: async (database, input) => {
        itemId = upsertSource(database, { feedId: source.sourceFeedId, originalUrl: 'https://example.com/plan/item', title: 'Referenced item' }).id;
        recordWebsiteSuccess(database, input.taskId, input.workspaceId, source, 1);
      }
    });
    const item = {
      title: 'Must keep real source', priority: 1, whyNow: 'now', timeliness: 'today', targetAudience: 'builders', angle: 'angle', pointOfView: 'point',
      platforms: ['x'], formats: ['text'], titleGuidance: 'title', openingGuidance: 'opening', structureGuidance: 'structure', effortEstimate: '30m', sourceIds: [itemId]
    };
    savePlanReadback(current.database, run.task, '2026-08-03', [item]);
    current.database.prepare('DELETE FROM source_items WHERE id=?').run(itemId);
    const completed = completeAgentTask(current.database, run.task.id);
    assert.equal(completed.ok, false);
    assert.equal(completed.error.code, 'VALIDATION_ERROR');
  } finally {
    current.database.close();
    await rm(current.root, { recursive: true, force: true });
  }
});

test('a receipt for an unselected source cannot satisfy a frozen daily task', async () => {
  const current = await makeRoot('wmb-daily-frozen-receipt-');
  try {
    const selected = website(current.database, 'selected');
    const unselected = website(current.database, 'unselected');
    const started = startAgentTask(current.database, {
      intent: 'daily_intelligence', businessDate: '2026-08-03', contextRefs: {
        workspaceId: current.workspaceId,
        intelligenceChannels: {
          workspaceId: current.workspaceId, profileRevision: 1, modules: ['official_web'],
          sources: [{ module: 'official_web', sourceId: selected.id, sourceFeedId: selected.sourceFeedId, revision: selected.revision }]
        }
      }
    });
    assert.equal(started.ok, true);
    recordWebsiteSuccess(current.database, started.data.id, current.workspaceId, unselected);
    const aggregation = readDailyReceiptAggregation(current.database, started.data);
    assert.equal(aggregation.status, 'failed');
    assert.equal(aggregation.receipts.length, 0);
    assert.equal(aggregation.missingReceiptCount, 1);
    const completed = completeAgentTask(current.database, started.data.id);
    assert.equal(completed.ok, false);
    assert.equal(getAgentTask(current.database, started.data.id)?.status, 'running');
  } finally {
    current.database.close();
    await rm(current.root, { recursive: true, force: true });
  }
});

test('a resumed task with one completed source and one newly blocked source runs judgment as partial', async () => {
  const current = await makeRoot('wmb-daily-resume-partial-');
  try {
    insertWorkspaceProfile(current.database, {
      profileId: 'profile.test.resume', revision: 1, officialTemplateId: null, officialTemplateVersion: null,
      displayName: '英国生活', audience: '在英华人', contentGoal: '生活信息', editorialBrief: '实用优先',
      intelligencePackId: 'uk-life-content-radar', intelligencePackVersion: 1,
      creationPackId: 'wmb-core-creation', creationPackVersion: 1, platforms: ['x']
    });
    const finished = website(current.database, 'resume-finished');
    const blocked = website(current.database, 'resume-blocked');
    const started = startAgentTask(current.database, {
      intent: 'daily_intelligence', businessDate: '2026-08-03', contextRefs: {
        workspaceId: current.workspaceId,
        intelligenceChannels: {
          workspaceId: current.workspaceId, profileRevision: 1, modules: ['official_web'],
          sources: [
            { module: 'official_web', sourceId: finished.id, sourceFeedId: finished.sourceFeedId, revision: finished.revision },
            { module: 'official_web', sourceId: blocked.id, sourceFeedId: blocked.sourceFeedId, revision: blocked.revision }
          ]
        }
      }
    });
    assert.equal(started.ok, true);
    recordWebsiteSuccess(current.database, started.data.id, current.workspaceId, finished);
    updateAgentTaskPhase(current.database, started.data.id, 'resume_pending');
    setWebsiteSourceEnabled(current.database, { id: blocked.id, enabled: false, expectedRevision: blocked.revision });
    let laneCalls = 0;
    const routed = await startWorkspaceDailyIntelligence({ dataRootPath: current.root, businessDate: '2026-08-03', mcpUrl: 'http://127.0.0.1:1/mcp' }, {
      uk: async () => {
        laneCalls += 1;
        const channelScanned = getAgentTask(current.database, started.data.id);
        assert.equal(channelScanned?.phase, 'channel_scanned');
        savePlanReadback(current.database, channelScanned, '2026-08-03');
        const completed = completeAgentTask(current.database, started.data.id);
        assert.equal(completed.ok, true);
        return { task: completed.data, reused: false };
      }
    });
    assert.equal(laneCalls, 1);
    assert.equal(routed.task.id, started.data.id);
    assert.equal(routed.task.status, 'partial');
    assert.equal(current.database.prepare('SELECT status FROM source_scan_receipts WHERE task_id=? AND source_id=?').get(started.data.id, blocked.id).status, 'needs_user');
  } finally {
    current.database.close();
    await rm(current.root, { recursive: true, force: true });
  }
});

test('a duplicate start observes a preflight task without scanning the same source twice', async () => {
  const current = await makeRoot('wmb-daily-duplicate-start-');
  try {
    const source = website(current.database, 'duplicate');
    let enterScan;
    let releaseScan;
    const entered = new Promise((resolve) => { enterScan = resolve; });
    const release = new Promise((resolve) => { releaseScan = resolve; });
    let scans = 0;
    const first = startDailyChannelRun(current.database, {
      businessDate: '2026-08-03', workspaceId: current.workspaceId, profileRevision: 1
    }, {
      scanWebsite: async (database, input) => {
        scans += 1;
        enterScan();
        await release;
        recordWebsiteSuccess(database, input.taskId, input.workspaceId, source);
      }
    });
    await entered;
    const second = await startDailyChannelRun(current.database, {
      businessDate: '2026-08-03', workspaceId: current.workspaceId, profileRevision: 1
    }, {
      scanWebsite: async () => { throw new Error('duplicate start must not scan'); }
    });
    assert.equal(second.reused, true);
    assert.equal(second.shouldRunJudgment, false);
    assert.equal(scans, 1);
    releaseScan();
    const completed = await first;
    assert.equal(completed.shouldRunJudgment, true);
    assert.equal(scans, 1);
  } finally {
    current.database.close();
    await rm(current.root, { recursive: true, force: true });
  }
});

test('plans.save MCP accepts an empty current plan and persists its readback', async () => {
  const current = await makeRoot('wmb-daily-mcp-empty-');
  let mcp;
  try {
    insertWorkspaceProfile(current.database, {
      profileId: 'profile.test.mcp', revision: 1, officialTemplateId: null, officialTemplateVersion: null,
      displayName: 'MCP test', audience: 'test', contentGoal: 'test', editorialBrief: 'test',
      intelligencePackId: 'game-news-radar', intelligencePackVersion: 1,
      creationPackId: 'wmb-core-creation', creationPackVersion: 1, platforms: ['x']
    });
    current.database.close();
    mcp = await startMcp(current.root);
    const initialized = await mcpRequest(mcp.url, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'daily-channel-test', version: '1' } });
    const response = await mcpRequest(mcp.url, 'tools/call', {
      name: 'plans.save', arguments: { request_id: 'empty-plan', plan_date: '2026-08-03', summary: '今天没有可执行机会', items: [] }
    }, initialized.sessionId);
    const payload = JSON.parse(response.data.content[0].text);
    assert.equal(payload.ok, true);
    const readback = migrateDatabase(path.join(current.root, 'wmb.db'));
    try {
      assert.equal(readback.prepare('SELECT COUNT(*) AS count FROM plans WHERE plan_date=? AND is_current=1').get('2026-08-03').count, 1);
      assert.equal(readback.prepare('SELECT COUNT(*) AS count FROM plan_items').get().count, 0);
    } finally { readback.close(); }
  } finally {
    await mcp?.close();
    await rm(current.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

async function mcpRequest(url, method, params, sessionId) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params })
  });
  const body = await response.text();
  assert.equal(response.ok, true, body);
  const payload = response.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(body.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6))
    : JSON.parse(body);
  if (payload.error) throw new Error(payload.error.message);
  return { data: payload.result, sessionId: response.headers.get('mcp-session-id') ?? sessionId };
}
