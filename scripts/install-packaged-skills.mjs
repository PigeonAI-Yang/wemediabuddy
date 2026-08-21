#!/usr/bin/env node
/**
 * WMB-5167/WMB-5240 配套：打包期为 resources/skills/<skill> 写入 .wmb-install.json。
 *
 * extraResource 原样复制 skills/ 目录，不含安装回执；而 check-skill-mirrors 门禁要求
 * 打包镜像的 revision 与 canonical 一致。本脚本在 postPackage 中、门禁之前运行，
 * 用与 src/main/pi-operator-skill.ts installPiSkill 完全相同的算法计算 revision 并写入
 * { name, revision } 回执，使打包产物与运行时安装器产物同构。
 *
 * 参数：--skills-root <dir>（默认 <cwd>/skills）；--output <dir>（forge outputPath，可重复）。
 */

import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { skillRevision } from './check-skill-mirrors.mjs';

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

const skillsRoot = path.resolve(argValue('--skills-root', path.join(process.cwd(), 'skills')));
const outputs = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--output' && index + 1 < args.length) outputs.push(path.resolve(args[index + 1]));
}
if (!outputs.length) outputs.push(path.resolve(process.cwd()));

for (const output of outputs) {
  const entries = (await readdir(skillsRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(skillsRoot, entry.name);
    const mirrorDir = path.join(output, 'resources', 'skills', entry.name);
    const revision = await skillRevision(skillDir);
    await writeFile(
      path.join(mirrorDir, '.wmb-install.json'),
      JSON.stringify({ name: entry.name, revision }) + '\n',
      'utf8'
    );
    console.log(`install-packaged-skills: ${entry.name} → ${mirrorDir} (revision ${revision.slice(0, 12)}…)`);
  }
}
