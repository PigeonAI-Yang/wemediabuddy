import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const skillPath = path.join('skills', 'wemedia-buddy-operator', 'SKILL.md');
const toolsRoot = path.join('.pi', 'extensions', 'wmb-mcp');

test('Pi operator Skill documents exactly the registered WMB tools and hard boundaries', async () => {
  const skill = await readFile(skillPath, 'utf8');
  const toolFiles = (await readdir(toolsRoot)).filter((name) => /^wmb-mcp-tools-.+\.ts$/.test(name));
  const registered = new Set();
  for (const file of toolFiles) {
    const source = await readFile(path.join(toolsRoot, file), 'utf8');
    for (const match of source.matchAll(/name:\s*['"]((?:wmb|xhs)_[a-z0-9_]+)['"]/g)) registered.add(match[1]);
  }
  const documented = new Set([...skill.matchAll(/`((?:wmb|xhs)_[a-z0-9_]+)`/g)].map((match) => match[1]));

  assert.deepEqual([...documented].sort(), [...registered].sort());
  assert.doesNotMatch(skill, /\b(?:TODO|TBD)\b/);
  assert.doesNotMatch(skill, /pyaireader/i);
  assert.match(skill, /禁止直接写文件、SQLite、data-root 或安装目录/);
  assert.match(skill, /最终确认、激活和最终发布只由用户/);
  assert.match(skill, /写入后必须按返回 ID 精确回读/);
  assert.match(skill, /数据库、并发取消或内部错误不是登录失效/);
  assert.match(skill, /只操作当前 MCP URL 绑定的工作空间/);
  assert.match(skill, /不要另起一次选题或提议重复保存方案/);
});

test('UK lane routes X work through current-root WMB tools, not the retired external provider', async () => {
  const skill = await readFile(path.join('skills', 'uk-life-content-radar', 'SKILL.md'), 'utf8');
  assert.doesNotMatch(skill, /pyaireader/i);
  assert.match(skill, /`wmb_read_x_list_index`/);
  assert.match(skill, /不能换账号、另建工作空间浏览器 profile 或迁移其他账号绑定/);
});
