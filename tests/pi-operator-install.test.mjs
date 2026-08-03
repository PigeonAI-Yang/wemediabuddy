import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensurePiConversationLayout } from '../src/main/pi-conversation.ts';
import { installPiOperatorSkillForDataRoots, operatorSkillRevision, PI_AUTHORITY_SYSTEM_PROMPT } from '../src/main/pi-operator-skill.ts';

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

test('Pi system prompts keep detailed operating playbooks in the shared Skill', async () => {
  const sources = await Promise.all([
    readFile('src/main/index.ts', 'utf8'),
    readFile('src/main/agent-runner.ts', 'utf8'),
    readFile('src/main/workspace-intelligence.ts', 'utf8')
  ]);
  const prompts = sources.flatMap((source) => [...source.matchAll(/--append-system-prompt['"`\s,]+([\s\S]*?)(?=\r?\n\s*[,\]])/g)].map((match) => match[1]));
  assert.ok(prompts.length >= 5);
  assert.doesNotMatch(prompts.join('\n'), /wmb_(?:prepare|create|save|get|list|read)_[a-z0-9_]+/);
  assert.equal(prompts.every((prompt) => prompt.includes('PI_AUTHORITY_SYSTEM_PROMPT')), true);
  assert.match(PI_AUTHORITY_SYSTEM_PROMPT, /禁止直接写文件或数据库/);
  assert.match(PI_AUTHORITY_SYSTEM_PROMPT, /禁止最终发布/);
  assert.match(PI_AUTHORITY_SYSTEM_PROMPT, /只能由用户在 WMB UI 完成/);
});
