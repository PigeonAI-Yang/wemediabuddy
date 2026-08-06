import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { ensurePiConversationLayout } from '../src/main/pi-conversation.ts';
import { installPiOperatorSkillForDataRoots, installPiSkill, operatorSkillRevision, PI_AUTHORITY_SYSTEM_PROMPT } from '../src/main/pi-operator-skill.ts';
import { ensureOfficialWorkspaceProfile } from '../src/main/workspace-profiles.ts';

test('operator Skill installs and refreshes every data root without touching lane Skills', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'wmb-operator-install-'));
  const roots = [path.join(parent, 'ai'), path.join(parent, 'uk')];
  try {
    for (const root of roots) {
      await mkdir(path.join(root, 'pi-agent', 'skills', 'lane-skill'), { recursive: true });
      await writeFile(path.join(root, 'pi-agent', 'skills', 'lane-skill', 'marker.txt'), root, 'utf8');
      await mkdir(path.join(root, 'pi-agent', 'skills', 'wemedia-buddy-operator'), { recursive: true });
      await writeFile(path.join(root, 'pi-agent', 'skills', 'wemedia-buddy-operator', 'stale.txt'), 'stale', 'utf8');
    }

    const installed = await installPiOperatorSkillForDataRoots(roots);
    const expectedRevision = await operatorSkillRevision(path.resolve('skills/wemedia-buddy-operator'));
    assert.deepEqual(installed.map((item) => item.revision), [expectedRevision, expectedRevision]);
    for (const root of roots) {
      const skillRoot = path.join(root, 'pi-agent', 'skills', 'wemedia-buddy-operator');
      assert.equal(JSON.parse(await readFile(path.join(skillRoot, '.wmb-install.json'), 'utf8')).revision, expectedRevision);
      assert.equal(await readFile(path.join(skillRoot, 'SKILL.md'), 'utf8'), await readFile('skills/wemedia-buddy-operator/SKILL.md', 'utf8'));
      await assert.rejects(access(path.join(skillRoot, 'stale.txt')));
      assert.equal(await readFile(path.join(root, 'pi-agent', 'skills', 'lane-skill', 'marker.txt'), 'utf8'), root);
    }

    await writeFile(path.join(roots[0], 'pi-agent', 'skills', 'wemedia-buddy-operator', 'SKILL.md'), 'stale', 'utf8');
    await ensurePiConversationLayout(roots[0]);
    assert.equal(await readFile(path.join(roots[0], 'pi-agent', 'skills', 'wemedia-buddy-operator', 'SKILL.md'), 'utf8'), await readFile('skills/wemedia-buddy-operator/SKILL.md', 'utf8'));
  } finally {
    await rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('concurrent installs of the same Pi Skill serialize and leave one complete target', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'wmb-concurrent-skill-install-'));
  const agentDir = path.join(parent, 'pi-agent');
  const sourceRoot = path.join(parent, 'source-skill');
  const skillName = 'fixture-skill';
  const target = path.join(agentDir, 'skills', skillName);
  try {
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(path.join(sourceRoot, 'SKILL.md'), '# Fixture Skill\n\nConcurrent install fixture.\n', 'utf8');
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'stale.txt'), 'stale', 'utf8');

    const expectedRevision = await operatorSkillRevision(sourceRoot);
    const installed = await Promise.all(Array.from(
      { length: 8 },
      () => installPiSkill(agentDir, skillName, sourceRoot, { fixture: true })
    ));

    assert.deepEqual(installed.map(({ revision }) => revision), Array(8).fill(expectedRevision));
    assert.equal(installed.every(({ path: installedPath }) => installedPath === target), true);
    assert.equal(await readFile(path.join(target, 'SKILL.md'), 'utf8'), await readFile(path.join(sourceRoot, 'SKILL.md'), 'utf8'));
    assert.deepEqual(JSON.parse(await readFile(path.join(target, '.wmb-install.json'), 'utf8')), {
      name: skillName,
      revision: expectedRevision,
      fixture: true
    });
    await assert.rejects(access(path.join(target, 'stale.txt')));
    assert.equal((await readdir(path.join(agentDir, 'skills'))).some((entry) => entry.includes('.installing-')), false);
  } finally {
    await rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('Pi conversation refreshes only the current root lane Skill before loading', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'wmb-lane-install-'));
  try {
    const root = await openDataRoot(path.join(parent, 'uk'));
    const database = migrateDatabase(path.join(root.path, 'wmb.db'));
    ensureOfficialWorkspaceProfile(database, 'official.uk');
    database.close();
    const installed = path.join(root.path, 'pi-agent', 'skills', 'uk-life-content-radar');
    await mkdir(installed, { recursive: true });
    await writeFile(path.join(installed, 'stale.txt'), 'stale', 'utf8');

    await ensurePiConversationLayout(root.path);

    assert.equal(await readFile(path.join(installed, 'SKILL.md'), 'utf8'), await readFile('skills/uk-life-content-radar/SKILL.md', 'utf8'));
    assert.equal(JSON.parse(await readFile(path.join(installed, '.wmb-install.json'), 'utf8')).name, 'uk-life-content-radar');
    await assert.rejects(access(path.join(installed, 'stale.txt')));
    await assert.rejects(access(path.join(root.path, 'pi-agent', 'skills', 'wemedia-intelligence-engine')));
  } finally {
    await rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('Pi system prompts keep detailed operating playbooks in the shared Skill', async () => {
  const sources = await Promise.all([
    readFile('src/main/index.ts', 'utf8'),
    readFile('src/main/agent-runner.ts', 'utf8'),
    readFile('src/main/workspace-intelligence.ts', 'utf8')
  ]);
  const prompts = sources.flatMap((source) => [...source.matchAll(/['"]--append-system-prompt['"]\s*,\s*([^,\]\r\n]+)/g)].map((match) => match[1]));
  assert.equal(prompts.length, 5);
  assert.doesNotMatch(prompts.join('\n'), /wmb_(?:prepare|create|save|get|list|read)_[a-z0-9_]+/);
  assert.equal(prompts.every((prompt) => prompt.includes('PI_AUTHORITY_SYSTEM_PROMPT') || prompt.includes('piTaskAuthorityPrompt(')), true);
  assert.match(PI_AUTHORITY_SYSTEM_PROMPT, /禁止直接写文件或数据库/);
  assert.match(PI_AUTHORITY_SYSTEM_PROMPT, /禁止最终发布/);
  assert.match(PI_AUTHORITY_SYSTEM_PROMPT, /只有工具或 Skill 明确要求 UI 确认/);
  assert.match(PI_AUTHORITY_SYSTEM_PROMPT, /已授权直接执行的动作不得追加确认/);
});
