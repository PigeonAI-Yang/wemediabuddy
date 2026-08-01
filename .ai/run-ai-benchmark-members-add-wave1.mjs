import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { readBrowserConfig, ensurePyaireaderXBrowser } from '../src/main/browser.ts';
import { captureXListOperationSnapshot, confirmAndRunXListOperation } from '../src/main/x-list-execution.ts';
import { armXListOperation, getXListOperation, prepareXListOperation } from '../src/main/x-lists.ts';

const LIST_ID = '2083262800521224237';
const ACCOUNT = '@KimbomArtist';
const REQUEST_ID = `wmb-ai-benchmark-wave1-${Date.now()}`;
const DB = 'J:/PigeonYang/WeMediaBuddyData/wmb.db';
const OUT = path.resolve('.ai/ai-benchmark-members-add-wave1-result.json');

// Small first wave to avoid X cooldown.
const HANDLES = [
  '@ArtificialAnlys',
  '@lmsysorg',
  '@lmarena_ai',
  '@huggingface',
  '@OpenRouter',
  '@EpochAIResearch',
  '@arcprize',
  '@SWEbench'
];

function dump(label, value) {
  console.log(label, JSON.stringify(value, null, 2));
}

const database = migrateDatabase(DB);
try {
  const guardPath = path.join(process.env.USERPROFILE || process.env.HOME || '', '.pyaireader', 'guards', 'x-request-guard.json');
  try {
    const guard = JSON.parse(await readFile(guardPath, 'utf8'));
    const remainMs = Math.max(0, Number(guard.cooldown_until || 0) * 1000 - Date.now()) + 5_000;
    if (remainMs > 0) {
      console.log(`waiting ${Math.ceil(remainMs / 1000)}s for X cooldown...`);
      await new Promise((resolve) => setTimeout(resolve, remainMs));
    }
  } catch {
    console.log('no guard cooldown file; short settle wait');
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }

  const prepared = prepareXListOperation(database, {
    requestId: REQUEST_ID,
    accountKey: ACCOUNT,
    kind: 'members_add',
    listId: LIST_ID,
    handles: HANDLES
  });
  if (!prepared.ok) throw new Error(prepared.error?.message || 'prepare failed');
  let operation = prepared.data.operation;
  dump('prepared', { id: operation.id, requestId: operation.requestId, handles: HANDLES });
  await writeFile(path.resolve('.ai/ai-benchmark-members-add-wave1-prepared.json'), JSON.stringify(prepared, null, 2), 'utf8');

  const browser = readBrowserConfig(database);
  if (!browser) throw new Error('请先在设置里选择 Pyaireader 专用 X 登录态。');
  const runtime = await ensurePyaireaderXBrowser(browser, { mode: 'visible' });
  const config = { id: browser.id, cdpUrl: runtime.cdpUrl };
  console.log('browser ready', config);

  const snapshot = await captureXListOperationSnapshot(config, operation);
  dump('snapshot', {
    list: snapshot.list && { listId: snapshot.list.listId, name: snapshot.list.name, ownerHandle: snapshot.list.ownerHandle },
    members: snapshot.members
  });

  const armed = armXListOperation(database, {
    operationId: operation.id,
    expectedRevision: operation.revision,
    snapshot
  });
  if (!armed.ok) throw new Error(armed.error?.message || 'arm failed');
  operation = armed.data;

  const confirmed = await confirmAndRunXListOperation(database, config, {
    operationId: operation.id,
    expectedRevision: operation.revision
  });
  const finalOp = getXListOperation(database, operation.id);
  const result = {
    ok: confirmed.ok,
    requestId: REQUEST_ID,
    operationId: operation.id,
    handles: HANDLES,
    items: finalOp?.items?.map((item) => ({ handle: item.handle, state: item.state, evidence: item.evidence })),
    state: finalOp?.state,
    phase: finalOp?.phase,
    errorCode: finalOp?.errorCode,
    errorMessage: finalOp?.errorMessage,
    confirmedError: confirmed.ok ? null : confirmed.error
  };
  await writeFile(OUT, JSON.stringify(result, null, 2), 'utf8');
  dump('result', result);
  const bad = !confirmed.ok || finalOp?.state === 'needs_user' || finalOp?.state === 'failed';
  if (bad) process.exitCode = 1;
} catch (error) {
  const payload = {
    ok: false,
    error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
  };
  await writeFile(OUT, JSON.stringify(payload, null, 2), 'utf8');
  console.error(payload);
  process.exitCode = 1;
} finally {
  database.close();
}
