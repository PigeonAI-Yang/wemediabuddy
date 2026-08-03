import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deletePiSkill, ensureDefaultPiSkills, listPiSkills, savePiSkill, syncPiSkillsForDataRoots } from '../src/main/pi-skill-library.ts';

async function writeSkill(root, name, description = `${name} description`, instructions = `# ${name}\n\nFollow this.`) {
  const target = path.join(root, name);
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, 'SKILL.md'), `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${instructions}\n`, 'utf8');
  return target;
}

test('installation Pi Skills seed, CRUD, sync and preserve protected roots', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'wmb-pi-skills-'));
  const userData = path.join(parent, 'user-data');
  const packaged = path.join(parent, 'packaged-skills');
  const roots = [path.join(parent, 'root-a'), path.join(parent, 'root-b')];
  try {
    await writeSkill(packaged, 'evidence-grounded-writer', 'Verify factual writing.', '# Workflow\n\nVerify, write, recheck.');
    for (const root of roots) {
      await writeSkill(path.join(root, 'pi-agent', 'skills'), 'lane-skill');
      await writeFile(path.join(root, 'pi-agent', 'skills', 'lane-skill', '.wmb-install.json'), JSON.stringify({ name: 'lane-skill', revision: 'lane' }), 'utf8');
    }

    await syncPiSkillsForDataRoots(userData, packaged, roots);
    for (const root of roots) {
      assert.match(await readFile(path.join(root, 'pi-agent', 'skills', 'evidence-grounded-writer', 'SKILL.md'), 'utf8'), /Verify, write, recheck/);
      assert.equal(JSON.parse(await readFile(path.join(root, 'pi-agent', 'skills', 'evidence-grounded-writer', '.wmb-install.json'), 'utf8')).scope, 'installation');
      assert.match(await readFile(path.join(root, 'pi-agent', 'skills', 'lane-skill', 'SKILL.md'), 'utf8'), /lane-skill/);
      await access(path.join(root, 'pi-agent', 'skills', 'wemedia-buddy-operator', 'SKILL.md'));
    }

    const created = await savePiSkill(userData, packaged, { name: 'my-writer', description: 'Write with evidence.', instructions: '# Rules\n\nUse facts.' });
    assert.equal(created.origin, 'user');
    const updated = await savePiSkill(userData, packaged, { originalName: 'my-writer', name: 'my-writer', description: 'Write with checked evidence.', instructions: '# Rules\n\nUse checked facts.' });
    assert.match(updated.description, /checked evidence/);
    const renamed = await savePiSkill(userData, packaged, { originalName: 'my-writer', name: 'my-better-writer', description: 'Write better with evidence.', instructions: '# Rules\n\nUse verified facts.' });
    assert.equal(renamed.name, 'my-better-writer');
    await assert.rejects(access(path.join(userData, 'pi-skills', 'my-writer', 'SKILL.md')));
    await syncPiSkillsForDataRoots(userData, packaged, roots);
    for (const root of roots) {
      await access(path.join(root, 'pi-agent', 'skills', 'my-better-writer', 'SKILL.md'));
      await assert.rejects(access(path.join(root, 'pi-agent', 'skills', 'my-writer', 'SKILL.md')));
    }

    await deletePiSkill(userData, 'evidence-grounded-writer');
    await ensureDefaultPiSkills(userData, packaged);
    await syncPiSkillsForDataRoots(userData, packaged, roots);
    assert.deepEqual(JSON.parse(await readFile(path.join(userData, 'pi-skills-state.json'), 'utf8')).deletedDefaults, ['evidence-grounded-writer']);
    for (const root of roots) {
      await assert.rejects(access(path.join(root, 'pi-agent', 'skills', 'evidence-grounded-writer', 'SKILL.md')));
      await access(path.join(root, 'pi-agent', 'skills', 'lane-skill', 'SKILL.md'));
      await access(path.join(root, 'pi-agent', 'skills', 'wemedia-buddy-operator', 'SKILL.md'));
    }

    const listed = await listPiSkills(userData, packaged, roots[0]);
    assert.equal(listed.some((skill) => skill.name === 'my-better-writer' && skill.editable && skill.scope === 'installation'), true);
    assert.equal(listed.some((skill) => skill.name === 'wemedia-buddy-operator' && !skill.editable), true);
  } finally {
    await rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('renaming a packaged default does not resurrect the old identity', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'wmb-pi-skills-rename-default-'));
  const packaged = path.join(parent, 'packaged');
  try {
    await writeSkill(packaged, 'evidence-grounded-writer');
    await ensureDefaultPiSkills(parent, packaged);
    await savePiSkill(parent, packaged, { originalName: 'evidence-grounded-writer', name: 'my-evidence-writer', description: 'My evidence writer.', instructions: '# Verify\n\nCheck facts.' });
    await ensureDefaultPiSkills(parent, packaged);
    await assert.rejects(access(path.join(parent, 'pi-skills', 'evidence-grounded-writer', 'SKILL.md')));
    await access(path.join(parent, 'pi-skills', 'my-evidence-writer', 'SKILL.md'));
    assert.deepEqual(JSON.parse(await readFile(path.join(parent, 'pi-skills-state.json'), 'utf8')).deletedDefaults, ['evidence-grounded-writer']);
  } finally {
    await rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('Skill writes reject path escapes and empty content', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'wmb-pi-skills-invalid-'));
  try {
    await assert.rejects(savePiSkill(parent, path.join(parent, 'packaged'), { name: '../escape', description: 'x', instructions: 'x' }), /名称/);
    await assert.rejects(savePiSkill(parent, path.join(parent, 'packaged'), { name: 'valid-name', description: '', instructions: 'x' }), /触发描述/);
    await assert.rejects(deletePiSkill(parent, 'wemedia-buddy-operator'), /不存在或不可删除/);
  } finally {
    await rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
