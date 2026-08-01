import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { readBrowserConfig, ensurePyaireaderXBrowser } from '../src/main/browser.ts';
import { captureXListOperationSnapshot, confirmAndRunXListOperation } from '../src/main/x-list-execution.ts';
import { armXListOperation, getXListOperation, prepareXListOperation } from '../src/main/x-lists.ts';
import { readXListMembers } from '../src/main/platforms/x-list-browser.ts';

const OP_ID = 'af4302f7-faf4-42ad-b0f2-351a44123135';
const LIST_ID = '2082851520417255750';
const ACCOUNT = '@KimbomArtist';
const HANDLES = [
  '@deepseek_ai',
  '@OpenAI',
  '@AnthropicAI',
  '@GoogleDeepMind',
  '@xai',
  '@BytePlusGlobal',
  '@ByteDanceOSS',
  '@CapCutApp'
];
const DB = 'J:/PigeonYang/WeMediaBuddyData/wmb.db';
const OUT = path.resolve('.ai/ai-frontier-members-add-result.json');

function dump(label, value) {
  console.log(label, JSON.stringify(value, null, 2));
}

const database = migrateDatabase(DB);
try {
  let operation = getXListOperation(database, OP_ID);
  if (!operation) {
    console.log('prepared op missing; recreating with same requestId');
    const prepared = prepareXListOperation(database, {
      requestId: 'wmb-1702-ai-frontier-members-2026-07-31',
      accountKey: ACCOUNT,
      kind: 'members_add',
      listId: LIST_ID,
      handles: HANDLES
    });
    if (!prepared.ok) throw new Error(prepared.error?.message || 'prepare failed');
    operation = prepared.data.operation;
  }

  dump('operation.before', {
    id: operation.id,
    state: operation.state,
    phase: operation.phase,
    revision: operation.revision,
    handles: operation.payload?.handles || operation.items?.map((item) => item.handle)
  });

  const browser = readBrowserConfig(database);
  if (!browser) throw new Error('请先在设置里选择 Pyaireader 专用 X 登录态。');
  const runtime = await ensurePyaireaderXBrowser(browser, { mode: 'quiet' });
  const config = { id: browser.id, cdpUrl: runtime.cdpUrl };
  console.log('browser ready', { id: config.id, cdpUrl: config.cdpUrl });

  if (operation.state !== 'prepared' && operation.state !== 'awaiting_confirmation') {
    throw new Error(`操作状态不可继续: ${operation.state}/${operation.phase}`);
  }

  let armedOp = operation;
  if (operation.state === 'prepared') {
    const snapshot = await captureXListOperationSnapshot(config, operation);
    dump('snapshot.forArm', {
      accountKey: snapshot.accountKey,
      list: snapshot.list,
      members: snapshot.members
    });
    const armed = armXListOperation(database, {
      operationId: operation.id,
      expectedRevision: operation.revision,
      snapshot
    });
    if (!armed.ok) throw new Error(`${armed.error?.code}: ${armed.error?.message}`);
    armedOp = armed.data;
    dump('operation.armed', { id: armedOp.id, state: armedOp.state, revision: armedOp.revision });
  }

  const confirmed = await confirmAndRunXListOperation(database, config, {
    operationId: armedOp.id,
    expectedRevision: armedOp.revision
  });
  if (!confirmed.ok) {
    dump('confirm.failed', confirmed);
    await writeFile(OUT, JSON.stringify({ ok: false, confirmed }, null, 2), 'utf8');
    process.exitCode = 2;
  } else {
    let membersRead = null;
    try {
      membersRead = await readXListMembers(config, LIST_ID);
    } catch (error) {
      membersRead = { error: error instanceof Error ? error.message : String(error) };
    }

    const present = new Set((membersRead.members || []).map((member) => String(member.handle || '').toLowerCase()));
    const result = {
      ok: true,
      operation: {
        id: confirmed.data.id,
        state: confirmed.data.state,
        phase: confirmed.data.phase,
        revision: confirmed.data.revision,
        errorCode: confirmed.data.errorCode,
        errorMessage: confirmed.data.errorMessage,
        items: confirmed.data.items
      },
      requested: HANDLES,
      presentAfter: HANDLES.map((handle) => ({
        handle,
        present: present.has(handle.toLowerCase())
      })),
      membersCount: membersRead.members?.length ?? null,
      membersError: membersRead.error ?? null,
      finishedAt: new Date().toISOString()
    };
    await writeFile(OUT, JSON.stringify(result, null, 2), 'utf8');
    dump('result', result);
  }
} catch (error) {
  const payload = {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  };
  await writeFile(OUT, JSON.stringify(payload, null, 2), 'utf8');
  console.error(payload);
  process.exitCode = 1;
} finally {
  database.close();
}
