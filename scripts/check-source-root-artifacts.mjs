#!/usr/bin/env node
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function findFlattenedSourceArtifacts(sourceRoot) {
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  const matches = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^(renderer|shared)/.test(entry.name)) continue;
    const filePath = path.join(sourceRoot, entry.name);
    const info = await stat(filePath);
    if (info.size === 0) matches.push(filePath);
  }
  return matches.sort();
}

async function main() {
  const sourceRoot = path.resolve(process.argv[2] ?? path.join(process.cwd(), 'src'));
  const matches = await findFlattenedSourceArtifacts(sourceRoot);
  if (matches.length === 0) {
    console.log('check-source-root-artifacts PASS: no flattened zero-byte source files.');
    return;
  }
  for (const filePath of matches) console.error(`FLATTENED ZERO-BYTE SOURCE: ${filePath}`);
  process.exitCode = 1;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main().catch((error) => {
  console.error(`check-source-root-artifacts ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});
