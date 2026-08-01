import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { readBrowserConfig, ensurePyaireaderXBrowser } from '../src/main/browser.ts';
import { captureXListOperationSnapshot, confirmAndRunXListOperation } from '../src/main/x-list-execution.ts';
import { armXListOperation, getXListOperation, prepareXListOperation } from '../src/main/x-lists.ts';

const LIST_ID = '2083262800521224237';
const ACCOUNT = '@KimbomArtist';
const REQUEST_ID = `wmb-ai-benchmark-members-${Date.now()}`;
const DB = 'J:/PigeonYang/WeMediaBuddyData/wmb.db';
const OUT = path.resolve('.ai/ai-benchmark-members-add-result.json');

// First wave: verified high-signal benchmark accounts only.
const HANDLES = [
  '@ArtificialAnlys',
  '@lmsysorg',
  '@lmarena_ai',
  '@huggingface',
  '@OpenRouter',
  '@togethercompute',
  '@fireworks_ai',
  '@GroqInc',
  '@wandb',
  '@scale_AI',
  '@EpochAIResearch',
  '@StanfordCRFM',
  '@arcprize',
  '@SWEbench',
  '@haizelabs',
  '@vectara'
];

function dump(label, value) {
  console.log(label, JSON.stringify(value, null, 2));
}

const database = migrateDatabase(DB);
try {
  const prepared = prepareXListOperation(database, {
    requestId: REQUEST_ID,
    accountKey: ACCOUNT,
    kind: 'members_add',
    listId: LIST_ID,
    handles: HANDLES
  });
  if (!prepared.ok) throw new Error(prepared.error?.message || 'prepare failed');
  let operation = prepared.data.operation;
  dump('prepared', {
    id: operation.id,
    requestId: operation.requestId,
    state: operation.state,
    handles: HANDLES
  });

  await writeFile(
    path.resolve('.ai/ai-benchmark-members-add-prepared.json'),
    JSON.stringify(prepared, null, 2),
    'utf8'
  );

  const browser = readBrowserConfig(database);
  if (!browser) throw new Error('请先在设置里选择 Pyaireader 专用 X 登录态。');
  const runtime = await ensurePyaireaderXBrowser(browser, { mode: 'visible' });
  const config = { id: browser.id, cdpUrl: runtime.cdpUrl };
  console.log('browser ready', { id: config.id, cdpUrl: config.cdpUrl });

  const snapshot = await captureXListOperationSnapshot(config, operation);
  dump('snapshot.summary', {
    accountKey: snapshot.accountKey,
    list: snapshot.list && {
      listId: snapshot.list.listId,
      name: snapshot.list.name,
      ownerHandle: snapshot.list.ownerHandle,
      kind: snapshot.list.kind,
      memberCount: snapshot.list.memberCount
    },
    members: snapshot.members
  });

  const armed = armXListOperation(database, {
    operationId: operation.id,
    expectedRevision: operation.revision,
    snapshot
  });
  if (!armed.ok) {
    await writeFile(OUT, JSON.stringify({ ok: false, phase: 'arm', error: armed.error, snapshot }, null, 2), 'utf8');
    throw new Error(armed.error?.message || 'arm failed');
  }
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
    confirmed: confirmed.ok ? {
      state: confirmed.data?.state,
      phase: confirmed.data?.phase,
      items: confirmed.data?.items?.map((item) => ({
        handle: item.handle,
        state: item.state,
        evidence: item.evidence
      }))
    } : null,
    error: confirmed.ok ? null : confirmed.error,
    final: finalOp && {
      state: finalOp.state,
      phase: finalOp.phase,
      errorCode: finalOp.errorCode,
      errorMessage: finalOp.errorMessage,
      items: finalOp.items?.map((item) => ({ handle: item.handle, state: item.state }))
    }
  };
  await writeFile(OUT, JSON.stringify(result, null, 2), 'utf8');
  dump('result', result);
  if (!confirmed.ok) process.exitCode = 1;
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
