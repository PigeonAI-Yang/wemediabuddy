import { createHash } from 'node:crypto';
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const ROOT_KEYS = Object.freeze(['ai', 'uk']);

export function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function resolveFixturePaths(base, fixture, containmentRoot = base) {
  const root = await realpath(containmentRoot);
  const declared = {
    registryPath: fixture.installation.registryRelativePath,
    physicalProfileDirectory: fixture.installation.physicalProfileFixture.relativePath,
    physicalProfileSentinel: fixture.installation.physicalProfileFixture.sentinelRelativePath,
    roots: Object.fromEntries(ROOT_KEYS.map((rootKey) => [rootKey, {
      rootPath: fixture.roots[rootKey].directoryName,
      legacyBrowserFile: path.join(fixture.roots[rootKey].directoryName, fixture.legacySentinels.browserFileRelativePath),
      legacyConversationPointer: path.join(fixture.roots[rootKey].directoryName, fixture.legacySentinels.conversationPointerRelativePath),
      legacyConversationSession: path.join(fixture.roots[rootKey].directoryName, fixture.legacySentinels.conversationSessionRelativePath),
      rootIdentityFile: path.join(fixture.roots[rootKey].directoryName, fixture.legacySentinels.rootIdentityRelativePath)
    }]))
  };
  validateRelativePath(fixture.legacySentinels.browserFileRelativePath, 'legacySentinels.browserFileRelativePath');
  validateRelativePath(fixture.legacySentinels.conversationPointerRelativePath, 'legacySentinels.conversationPointerRelativePath');
  validateRelativePath(fixture.legacySentinels.conversationSessionRelativePath, 'legacySentinels.conversationSessionRelativePath');
  validateRelativePath(fixture.legacySentinels.rootIdentityRelativePath, 'legacySentinels.rootIdentityRelativePath');
  const resolved = {
    parent: path.resolve(base),
    registryPath: await resolveDeclaredPath(base, declared.registryPath, root, 'installation.registryRelativePath'),
    physicalProfileDirectory: await resolveDeclaredPath(base, declared.physicalProfileDirectory, root, 'installation.physicalProfileFixture.relativePath'),
    physicalProfileSentinel: await resolveDeclaredPath(base, declared.physicalProfileSentinel, root, 'installation.physicalProfileFixture.sentinelRelativePath'),
    manifestPath: path.resolve(base, 'eval-029-materialization.v1.json'),
    roots: {}
  };
  for (const rootKey of ROOT_KEYS) {
    resolved.roots[rootKey] = {
      rootPath: await resolveDeclaredPath(base, declared.roots[rootKey].rootPath, root, `roots.${rootKey}.directoryName`),
      legacyBrowserFile: await resolveDeclaredPath(base, declared.roots[rootKey].legacyBrowserFile, root, `${rootKey} legacy browser sentinel`),
      legacyConversationPointer: await resolveDeclaredPath(base, declared.roots[rootKey].legacyConversationPointer, root, `${rootKey} legacy conversation pointer`),
      legacyConversationSession: await resolveDeclaredPath(base, declared.roots[rootKey].legacyConversationSession, root, `${rootKey} legacy conversation session`),
      rootIdentityFile: await resolveDeclaredPath(base, declared.roots[rootKey].rootIdentityFile, root, `${rootKey} root identity sentinel`)
    };
  }
  assertChild(resolved.physicalProfileDirectory, resolved.physicalProfileSentinel, 'physical profile sentinel');
  for (const rootKey of ROOT_KEYS) {
    assertChild(resolved.roots[rootKey].rootPath, resolved.roots[rootKey].legacyBrowserFile, `${rootKey} legacy browser sentinel`);
    assertChild(resolved.roots[rootKey].rootPath, resolved.roots[rootKey].legacyConversationPointer, `${rootKey} legacy conversation pointer`);
    assertChild(resolved.roots[rootKey].rootPath, resolved.roots[rootKey].legacyConversationSession, `${rootKey} legacy conversation session`);
    assertChild(resolved.roots[rootKey].rootPath, resolved.roots[rootKey].rootIdentityFile, `${rootKey} root identity sentinel`);
  }
  if (resolved.roots.ai.rootPath === resolved.roots.uk.rootPath) throw new Error('Fixture root directory paths must be distinct.');
  return resolved;
}

export async function resolveContainedExistingPath(parent, input, label) {
  const root = await realpath(parent);
  const candidate = await realpath(path.resolve(input));
  assertChild(root, candidate, label);
  return candidate;
}

async function resolveDeclaredPath(base, relativePath, containmentRoot, label) {
  validateRelativePath(relativePath, label);
  const candidate = path.resolve(base, relativePath);
  assertChild(containmentRoot, candidate, label);
  const ancestor = await nearestExistingAncestor(candidate);
  const realAncestor = await realpath(ancestor);
  assertChildOrEqual(containmentRoot, realAncestor, `${label} existing ancestor`);
  return candidate;
}

function validateRelativePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty relative path.`);
  }
  const segments = value.split(/[\\/]+/);
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${label} must not contain empty, '.', or '..' path segments.`);
  }
}

async function nearestExistingAncestor(candidate) {
  let current = candidate;
  for (;;) {
    try {
      await stat(current);
      return current;
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function assertChild(parent, candidate, label) {
  const relative = path.relative(parent, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must remain inside the EVAL-029 parent.`);
  }
}

function assertChildOrEqual(parent, candidate, label) {
  if (path.resolve(parent) === path.resolve(candidate)) return;
  assertChild(parent, candidate, label);
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  return value;
}
