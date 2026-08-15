#!/usr/bin/env node
/**
 * WMB-5167 + WMB-5240：Pi Skill 镜像 freshness 预防性门禁。
 *
 * 比对 canonical Skill 目录与已安装镜像（pi-agent/skills/<name> 或打包 resources/skills/<name>）：
 * - 文件清单一致（递归、排除 .wmb-install.json、排序稳定）；
 * - 每个文件逐字节一致（SKILL.md 等）；
 * - 镜像 .wmb-install.json 的 revision 与 canonical 按同一算法计算的 hash 一致。
 *
 * 参数：
 *   --canonical <dir>        默认 skills/wemedia-buddy-operator
 *   --mirror <dir>           可重复；对每个镜像独立校验
 *   --require-existing       镜像缺失 → fail（缺省：镜像缺失 → skip，本地诊断干净）
 *
 * 退出码：全部通过 0；任一陈旧/缺失（--require-existing）1；输出精确失败路径。
 * revision 算法与 src/main/pi-operator-skill.ts（skillFiles + operatorSkillRevision）逐语义一致，
 * 保证安装器写入的 hash 与此处计算一致。
 */

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}
function hasFlag(name) {
  return args.includes(name);
}

const canonical = path.resolve(argValue('--canonical', path.join(process.cwd(), 'skills', 'wemedia-buddy-operator')));
const mirrors = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--mirror' && index + 1 < args.length) mirrors.push(path.resolve(args[index + 1]));
}
const requireExisting = hasFlag('--require-existing');

/** 递归文件清单（排除 .wmb-install.json；排序稳定，与安装器一致）。 */
export async function skillFiles(root, relative = '') {
  const files = [];
  const entries = (await readdir(path.join(root, relative), { withFileTypes: true }))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await skillFiles(root, next));
    else if (entry.isFile() && entry.name !== '.wmb-install.json') files.push(next);
  }
  return files;
}

/** revision hash（与 src/main/pi-operator-skill.ts operatorSkillRevision 同算法）。 */
export async function skillRevision(root) {
  const hash = createHash('sha256');
  for (const relativePath of await skillFiles(root)) {
    hash.update(relativePath.replaceAll('\\', '/')).update('\0').update(await readFile(path.join(root, relativePath))).update('\0');
  }
  return hash.digest('hex');
}

/** 读镜像 .wmb-install.json 的 revision；文件缺失/非法 → null。 */
async function installedRevision(mirror) {
  try {
    const raw = await readFile(path.join(mirror, '.wmb-install.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed?.revision === 'string' && parsed.revision ? parsed.revision : null;
  } catch {
    return null;
  }
}

async function main() {
  const canonicalRevision = await skillRevision(canonical);
  const canonicalFiles = await skillFiles(canonical);
  const failures = [];

  for (const mirror of mirrors) {
    let mirrorFiles;
    let mirrorFailures = [];
    try {
      mirrorFiles = await skillFiles(mirror);
    } catch {
      if (!requireExisting) {
        console.log(`check-skill-mirrors: skip (mirror missing): ${mirror}`);
        continue;
      }
      mirrorFailures = [`MISSING: ${path.join(mirror, 'SKILL.md')}`];
    }
    if (mirrorFailures.length === 0) {
      const installedRev = await installedRevision(mirror);
      if (!installedRev || installedRev !== canonicalRevision) {
        mirrorFailures.push(`STALE revision: ${path.join(mirror, '.wmb-install.json')} (installed=${installedRev ?? 'missing'}, canonical=${canonicalRevision})`);
      }

      const canonicalSet = new Set(canonicalFiles);
      const mirrorSet = new Set(mirrorFiles);
      for (const file of canonicalFiles) {
        if (!mirrorSet.has(file)) {
          mirrorFailures.push(`MISSING FILE: ${path.join(mirror, file)}`);
          continue;
        }
        const canonicalBytes = await readFile(path.join(canonical, file));
        const mirrorBytes = await readFile(path.join(mirror, file));
        if (!canonicalBytes.equals(mirrorBytes)) {
          mirrorFailures.push(`STALE FILE (byte mismatch): ${path.join(mirror, file)}`);
        }
      }
      for (const file of mirrorFiles) {
        if (!canonicalSet.has(file)) {
          mirrorFailures.push(`EXTRA FILE: ${path.join(mirror, file)}`);
        }
      }
    }
    if (mirrorFailures.length > 0) {
      failures.push(...mirrorFailures);
    } else {
      console.log(`check-skill-mirrors PASS: ${mirror} matches canonical (${canonicalFiles.length} files, revision ${canonicalRevision.slice(0, 12)}…).`);
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`check-skill-mirrors FAIL: ${failure}`);
    process.exit(1);
  }
}

const isDirectRun = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href;
if (isDirectRun) {
  if (mirrors.length === 0) {
    console.error('check-skill-mirrors: no --mirror provided (nothing to verify).');
    process.exit(2);
  }
  main().catch((error) => {
    console.error(`check-skill-mirrors ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  });
}
