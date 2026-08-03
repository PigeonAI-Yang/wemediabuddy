import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createContentProjectWithVersion } from '../src/main/content.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { startMcp } from '../src/main/mcp.ts';
import { ensureOfficialWorkspaceProfile } from '../src/main/workspace-profiles.ts';

test('Pi saves X, Xiaohongshu and WeChat versions against one exact core version', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-pi-platform-version-'));
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  let mcp;
  try {
    ensureOfficialWorkspaceProfile(database, 'official.ai');
    const project = createContentProjectWithVersion(database, { title: '三平台测试', body: '已核验核心正文' });
    mcp = await startMcp(directory);
    process.env.WMB_MCP_URL = mcp.url;
    const tools = new Map();
    const extension = (await import(`../.pi/extensions/wmb-mcp/index.ts?platform=${Date.now()}`)).default;
    extension({ registerTool(tool) { tools.set(tool.name, tool); } });
    const save = tools.get('wmb_save_platform_version');
    assert.ok(save);
    assert.deepEqual(save.parameters.properties.platform.enum, ['x', 'xiaohongshu', 'wechat']);

    for (const platform of ['x', 'xiaohongshu', 'wechat']) {
      const result = await save.execute(`save-${platform}`, {
        requestId: `save-${platform}`,
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
    for (const platform of ['x', 'xiaohongshu', 'wechat']) {
      const version = payload.platformVersions[platform][0];
      assert.equal(version.contentVersionId, project.contentVersionId);
      assert.equal(version.title, `${platform} 标题`);
      assert.equal(version.body, `${platform} 正文`);
    }
  } finally {
    await mcp?.close();
    database.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
