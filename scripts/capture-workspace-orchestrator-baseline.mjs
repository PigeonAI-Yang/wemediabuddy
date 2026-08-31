import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  WORKSPACE_ORCHESTRATOR_DESIGN,
  WORKSPACE_ORCHESTRATOR_RUNTIME_CENSUS,
  collectWorkspaceOrchestratorBaseline,
  freezeWorkspaceOrchestratorProducerManifest
} from '../src/main/workspace-orchestrator-stage0.ts';
function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`Invalid argument pair at ${key ?? '<end>'}`);
    values[key.slice(2)] = value;
  }
  return values;
}

function required(values, key) {
  const value = values[key]?.trim();
  if (!value) throw new Error(`Missing --${key}`);
  return value;
}

function hashFile(filePath) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(filePath, 'r');
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

const args = parseArguments(process.argv.slice(2));
const dataRootPath = path.resolve(required(args, 'data-root'));
const databasePath = path.resolve(required(args, 'database'));
const packagePath = path.resolve(required(args, 'package'));
const appAsarPath = path.resolve(required(args, 'app-asar'));
const outputPath = path.resolve(required(args, 'output'));
const designPath = path.resolve(WORKSPACE_ORCHESTRATOR_DESIGN.path);
const designHash = hashFile(designPath);
if (designHash !== WORKSPACE_ORCHESTRATOR_DESIGN.sha256) {
  throw new Error(`Approved design drifted: expected ${WORKSPACE_ORCHESTRATOR_DESIGN.sha256}, received ${designHash}`);
}
for (const existingPath of [dataRootPath, databasePath, packagePath, appAsarPath]) {
  if (!fs.existsSync(existingPath)) throw new Error(`Baseline path does not exist: ${existingPath}`);
}

const packageHash = hashFile(packagePath);
const appAsarHash = hashFile(appAsarPath);
const database = new DatabaseSync(databasePath, { readOnly: true });
let baseline;
try {
  baseline = collectWorkspaceOrchestratorBaseline(database, {
    dataRootPath,
    buildId: required(args, 'build-id'),
    packageHash,
    appAsarHash
  });
} finally {
  database.close();
}

const manifest = freezeWorkspaceOrchestratorProducerManifest({
  buildId: required(args, 'build-id'),
  sourceCommit: required(args, 'source-commit'),
  packageHash,
  appAsarHash,
  schemaEpoch: baseline.schema.maxVersion,
  cutoverEpoch: Number(args['cutover-epoch'] ?? 0),
  authorizerRevision: required(args, 'authorizer-revision'),
  processImagePath: packagePath,
  resourcesPath: path.dirname(appAsarPath)
});
const evidence = Object.freeze({
  schemaVersion: 1,
  designHash,
  packagePath,
  appAsarPath,
  baseline,
  runtimeCensus: WORKSPACE_ORCHESTRATOR_RUNTIME_CENSUS,
  producerManifest: manifest
});
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: args.overwrite === 'true' ? 'w' : 'wx' });
console.log(JSON.stringify({ outputPath, workspaceId: baseline.workspaceId, schemaVersion: baseline.schema.maxVersion, censusHash: manifest.censusHash }));
