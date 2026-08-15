import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { dispatchStartAgentTask } from '../src/main/agent-task-commands.ts';
import { createContentProjectWithVersion } from '../src/main/content.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { startMcp } from '../src/main/mcp.ts';
import { dispatchIssueTaskGrant } from '../src/main/task-grants.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { ensureOfficialWorkspaceProfile } from '../src/main/workspace-profiles.ts';

test('Pi saves X, Xiaohongshu and WeChat versions against one exact core version', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-pi-platform-version-'));
  let database = migrateDatabase(path.join(directory, 'wmb.db'));
  let mcp, runtime;
  try {
    ensureOfficialWorkspaceProfile(database, 'official.ai');
    const workspaceNow = new Date().toISOString();
    database.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id','workspace-platform-version',?,?,1)").run(workspaceNow, workspaceNow);
    const project = createContentProjectWithVersion(database, { title: '三平台测试', body: '已核验核心正文' });
    database.close();database=null;
    runtime = ActiveWorkspaceRuntime.open(directory, { openDatabase: migrateDatabase, createEpoch: () => 'platform-version-runtime' });
    const task = (await dispatchStartAgentTask(runtime, { intent: 'studio_draft', businessDate: '2026-08-02', contextRefs: { workspaceId: runtime.identity.workspaceId } }, { actor: { type: 'owner_ui', id: 'renderer', label: 'Owner UI' }, requestId: 'platform-version-task' })).task;
    const grant = await dispatchIssueTaskGrant(runtime, {
      requestId: 'platform-version-grant', taskId: task.id, ownerGoal: '保存三平台测试版本', allowedCommands: ['content.save_version'],
      workers: [{ type: 'external_agent', id: 'mcp' }], expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    assert.equal(grant.ok, true);
    mcp = await startMcp(directory, runtime.gate, undefined, runtime);
    process.env.WMB_MCP_URL = mcp.url;
    const tools = new Map();
    const extension = (await import(`../.pi/extensions/wmb-mcp/index.ts?platform=${Date.now()}`)).default;
    extension({ registerTool(tool) { tools.set(tool.name, tool); } });
    const save = tools.get('wmb_save_platform_version');
    assert.ok(save);
    // WMB-5249：知乎成为一等平台（MCP 平台枚举与平台版本保存面同步扩展）。
    assert.deepEqual(save.parameters.properties.platform.enum, ['x', 'xiaohongshu', 'wechat', 'zhihu']);

    for (const platform of ['x', 'xiaohongshu', 'wechat', 'zhihu']) {
      const result = await save.execute(`save-${platform}`, {
        requestId: `save-${platform}`,
        taskId: task.id,
        grantId: grant.data.id,
        projectId: project.id,
        contentVersionId: project.contentVersionId,
        platform,
        format: 'text',
        title: `${platform} 标题`,
        body: `${platform} 正文`
      });
      const payload = JSON.parse(result.details.content[0].text);
      assert.equal(payload.ok, true);
    }

    const get = tools.get('wmb_get_content');
    const readback = await get.execute('readback', { projectId: project.id });
    const payload = JSON.parse(readback.details.content[0].text);
    for (const platform of ['x', 'xiaohongshu', 'wechat', 'zhihu']) {
      const version = payload.platformVersions[platform][0];
      assert.equal(version.contentVersionId, project.contentVersionId);
      assert.equal(version.title, `${platform} 标题`);
      assert.equal(version.body, `${platform} 正文`);
    }
  } finally {
    await mcp?.close();
    await runtime?.stop({ drain: false });
    database?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
