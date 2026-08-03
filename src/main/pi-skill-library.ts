import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { installPiOperatorSkillForDataRoots, installPiSkill } from './pi-operator-skill.ts';

const DEFAULT_EDITABLE_SKILLS = ['evidence-grounded-writer'];
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type PiSkillSummary = {
  name: string;
  description: string;
  instructions: string;
  scope: 'system' | 'workspace' | 'installation';
  editable: boolean;
  origin: 'operator' | 'lane' | 'bundled' | 'user';
  revision: string;
};

export type PiSkillInput = { originalName?: string; name: string; description: string; instructions: string };
type LibraryState = { version: 1; deletedDefaults: string[] };

function libraryRoot(userDataPath: string): string { return path.join(userDataPath, 'pi-skills'); }
function statePath(userDataPath: string): string { return path.join(userDataPath, 'pi-skills-state.json'); }
function skillRoot(userDataPath: string, name: string): string { return path.join(libraryRoot(userDataPath), name); }

async function exists(target: string): Promise<boolean> {
  try { await stat(target); return true; } catch { return false; }
}

async function readState(userDataPath: string): Promise<LibraryState> {
  try {
    const raw = JSON.parse(await readFile(statePath(userDataPath), 'utf8')) as Partial<LibraryState>;
    return { version: 1, deletedDefaults: Array.isArray(raw.deletedDefaults) ? raw.deletedDefaults.filter((name): name is string => typeof name === 'string') : [] };
  } catch { return { version: 1, deletedDefaults: [] }; }
}

async function writeState(userDataPath: string, state: LibraryState): Promise<void> {
  await mkdir(userDataPath, { recursive: true });
  const target = statePath(userDataPath);
  const staging = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(staging, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(staging, target);
}

function packagedSkillRoot(packagedSkillsPath: string, name: string): string { return path.join(packagedSkillsPath, name); }

export async function ensureDefaultPiSkills(userDataPath: string, packagedSkillsPath: string): Promise<void> {
  const state = await readState(userDataPath);
  await mkdir(libraryRoot(userDataPath), { recursive: true });
  for (const name of DEFAULT_EDITABLE_SKILLS) {
    const source = packagedSkillRoot(packagedSkillsPath, name);
    const target = skillRoot(userDataPath, name);
    if (state.deletedDefaults.includes(name) || await exists(target) || !await exists(path.join(source, 'SKILL.md'))) continue;
    const staging = path.join(libraryRoot(userDataPath), `.${name}.seeding-${process.pid}-${randomUUID()}`);
    await cp(source, staging, { recursive: true, force: true });
    await rename(staging, target);
  }
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try { return JSON.parse(trimmed) as string; } catch { return trimmed.slice(1, -1); }
  }
  return trimmed.replace(/^['"]|['"]$/g, '');
}

export function parsePiSkill(markdown: string): { name: string; description: string; instructions: string } {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error('SKILL.md 缺少 YAML frontmatter。');
  const frontmatter = match[1];
  const name = unquote(frontmatter.match(/^name:\s*(.+)$/m)?.[1] ?? '');
  const descriptionLine = frontmatter.match(/^description:\s*(.*)$/m);
  let description = unquote(descriptionLine?.[1] ?? '');
  if (description === '|' || description === '>' || description === '|-' || description === '>-') {
    const after = frontmatter.slice((descriptionLine?.index ?? 0) + (descriptionLine?.[0].length ?? 0));
    description = after.split(/\r?\n/).filter((line) => /^\s+/.test(line)).map((line) => line.trim()).join(' ').trim();
  }
  return { name, description, instructions: match[2].trim() };
}

function validateInput(input: PiSkillInput): PiSkillInput {
  const name = input.name.trim();
  const originalName = input.originalName?.trim();
  const description = input.description.trim();
  const instructions = input.instructions.trim();
  if (!SKILL_NAME.test(name) || name.length > 64) throw new Error('Skill 名称只能使用小写字母、数字和连字符，且不超过 64 个字符。');
  if (originalName && (!SKILL_NAME.test(originalName) || originalName.length > 64)) throw new Error('原 Skill 名称无效。');
  if (!description) throw new Error('请填写触发描述。');
  if (!instructions) throw new Error('请填写 Skill 指令。');
  return { originalName, name, description, instructions };
}

function serializeSkill(input: PiSkillInput): string {
  return `---\nname: ${input.name}\ndescription: ${JSON.stringify(input.description)}\n---\n\n${input.instructions.trim()}\n`;
}

async function skillSummary(root: string, scope: PiSkillSummary['scope'], editable: boolean, origin: PiSkillSummary['origin']): Promise<PiSkillSummary> {
  const markdown = await readFile(path.join(root, 'SKILL.md'), 'utf8');
  const parsed = parsePiSkill(markdown);
  return { ...parsed, scope, editable, origin, revision: createHash('sha256').update(markdown).digest('hex') };
}

async function installationSkillNames(userDataPath: string): Promise<string[]> {
  try {
    const entries = await readdir(libraryRoot(userDataPath), { withFileTypes: true });
    const names: string[] = [];
    for (const entry of entries) if (entry.isDirectory() && SKILL_NAME.test(entry.name) && await exists(path.join(libraryRoot(userDataPath), entry.name, 'SKILL.md'))) names.push(entry.name);
    return names.sort();
  } catch { return []; }
}

function currentLaneName(dataRootPath: string): string | null {
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(path.join(dataRootPath, 'wmb.db'), { readOnly: true });
    const row = database.prepare("SELECT intelligence_pack_id AS name FROM workspace_profiles WHERE id='effective'").get() as { name?: string } | undefined;
    return row?.name ?? null;
  } catch { return null; } finally { database?.close(); }
}

export async function listPiSkills(userDataPath: string, packagedSkillsPath: string, dataRootPath: string): Promise<PiSkillSummary[]> {
  await ensureDefaultPiSkills(userDataPath, packagedSkillsPath);
  const result: PiSkillSummary[] = [];
  const operator = path.join(dataRootPath, 'pi-agent', 'skills', 'wemedia-buddy-operator');
  if (await exists(path.join(operator, 'SKILL.md'))) result.push(await skillSummary(operator, 'system', false, 'operator'));
  const laneName = currentLaneName(dataRootPath);
  const lane = laneName ? path.join(dataRootPath, 'pi-agent', 'skills', laneName) : '';
  if (laneName && await exists(path.join(lane, 'SKILL.md'))) result.push(await skillSummary(lane, 'workspace', false, 'lane'));
  for (const name of await installationSkillNames(userDataPath)) {
    result.push(await skillSummary(skillRoot(userDataPath, name), 'installation', true, DEFAULT_EDITABLE_SKILLS.includes(name) ? 'bundled' : 'user'));
  }
  return result;
}

export async function savePiSkill(userDataPath: string, packagedSkillsPath: string, raw: PiSkillInput): Promise<PiSkillSummary> {
  await ensureDefaultPiSkills(userDataPath, packagedSkillsPath);
  const input = validateInput(raw);
  const oldName = input.originalName || input.name;
  const oldRoot = skillRoot(userDataPath, oldName);
  const target = skillRoot(userDataPath, input.name);
  if (input.originalName && !await exists(path.join(oldRoot, 'SKILL.md'))) throw new Error('要修改的 Skill 不存在。');
  if (oldName !== input.name && await exists(target)) throw new Error('同名 Skill 已存在。');
  await mkdir(libraryRoot(userDataPath), { recursive: true });
  if (oldName !== input.name) {
    const staging = path.join(libraryRoot(userDataPath), `.${input.name}.saving-${process.pid}-${randomUUID()}`);
    if (await exists(oldRoot)) await cp(oldRoot, staging, { recursive: true, force: true }); else await mkdir(staging, { recursive: true });
    await writeFile(path.join(staging, 'SKILL.md'), serializeSkill(input), 'utf8');
    await rename(staging, target);
    await rm(oldRoot, { recursive: true, force: true });
  } else {
    await mkdir(target, { recursive: true });
    const staging = path.join(target, `.SKILL-${process.pid}-${randomUUID()}.tmp`);
    await writeFile(staging, serializeSkill(input), 'utf8');
    await rename(staging, path.join(target, 'SKILL.md'));
  }
  const state = await readState(userDataPath);
  const deletedDefaults = new Set(state.deletedDefaults);
  deletedDefaults.delete(input.name);
  if (oldName !== input.name && DEFAULT_EDITABLE_SKILLS.includes(oldName)) deletedDefaults.add(oldName);
  const nextDeletedDefaults = [...deletedDefaults].sort();
  if (JSON.stringify(nextDeletedDefaults) !== JSON.stringify(state.deletedDefaults)) await writeState(userDataPath, { version: 1, deletedDefaults: nextDeletedDefaults });
  return skillSummary(target, 'installation', true, DEFAULT_EDITABLE_SKILLS.includes(input.name) ? 'bundled' : 'user');
}

export async function deletePiSkill(userDataPath: string, name: string): Promise<void> {
  if (!SKILL_NAME.test(name)) throw new Error('Skill 名称无效。');
  const target = skillRoot(userDataPath, name);
  if (!await exists(path.join(target, 'SKILL.md'))) throw new Error('Skill 不存在或不可删除。');
  await rm(target, { recursive: true, force: true });
  if (DEFAULT_EDITABLE_SKILLS.includes(name)) {
    const state = await readState(userDataPath);
    if (!state.deletedDefaults.includes(name)) await writeState(userDataPath, { version: 1, deletedDefaults: [...state.deletedDefaults, name].sort() });
  }
}

export async function syncPiSkillsForDataRoots(userDataPath: string, packagedSkillsPath: string, dataRootPaths: string[]): Promise<void> {
  await ensureDefaultPiSkills(userDataPath, packagedSkillsPath);
  await installPiOperatorSkillForDataRoots(dataRootPaths);
  const desired = new Set(await installationSkillNames(userDataPath));
  await Promise.all(dataRootPaths.map(async (dataRootPath) => {
    const skillsRoot = path.join(dataRootPath, 'pi-agent', 'skills');
    await mkdir(skillsRoot, { recursive: true });
    for (const name of desired) await installPiSkill(path.join(dataRootPath, 'pi-agent'), name, skillRoot(userDataPath, name), { scope: 'installation' });
    for (const entry of await readdir(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || desired.has(entry.name)) continue;
      try {
        const receipt = JSON.parse(await readFile(path.join(skillsRoot, entry.name, '.wmb-install.json'), 'utf8')) as { scope?: string };
        if (receipt.scope === 'installation') await rm(path.join(skillsRoot, entry.name), { recursive: true, force: true });
      } catch {}
    }
  }));
}
