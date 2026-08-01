import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { readBrowserConfig, ensurePyaireaderXBrowser } from '../src/main/browser.ts';
import { captureXListOperationSnapshot, confirmAndRunXListOperation } from '../src/main/x-list-execution.ts';
import { armXListOperation, getXListOperation, prepareXListOperation } from '../src/main/x-lists.ts';
import { readXListMembers } from '../src/main/platforms/x-list-browser.ts';

const LIST_ID = '2082851520417255750';
const ACCOUNT = '@KimbomArtist';
const HANDLES = [
  '@AnthropicAI',
  '@GoogleDeepMind',
  '@xai',
  '@BytePlusGlobal',
  '@ByteDanceOSS',
  '@CapCutApp'
];
const REQUEST_ID = `wmb-ai-frontier-members-remaining-${Date.now()}`;
const DB = 'J:/PigeonYang/WeMediaBuddyData/wmb.db';
const OUT = path.resolve('.ai/ai-frontier-members-remaining-result.json');

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
  dump('operation.prepared', {
    id: operation.id,
    revision: operation.revision,
    handles: operation.payload?.handles
  });

  const browser = readBrowserConfig(database);
  if (!browser) throw new Error('请先在设置里选择 Pyaireader 专用 X 登录态。');
  const runtime = await ensurePyaireaderXBrowser(browser, { mode: 'visible' });
  const config = { id: browser.id, cdpUrl: runtime.cdpUrl };
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
  operation = armed.data;
  dump('operation.armed', { id: operation.id, state: operation.state, revision: operation.revision });

  const confirmed = await confirmAndRunXListOperation(database, config, {
    operationId: operation.id,
    expectedRevision: operation.revision
  });
  if (!confirmed.ok) {
    await writeFile(OUT, JSON.stringify({ ok: false, confirmed }, null, 2), 'utf8');
    dump('confirm.failed', confirmed);
    process.exitCode = 2;
  } else {
    let membersRead = null;
    try {
      membersRead = await readXListMembers(config, LIST_ID);
    } catch (error) {
      membersRead = { error: error instanceof Error ? error.message : String(error) };
    }
    const present = new Set((membersRead.members || []).map((member) => String(member.handle || '').toLowerCase()));
    const allRequested = [
      '@deepseek_ai',
      '@OpenAI',
      ...HANDLES
    ];
    const result = {
      ok: true,
      requestId: REQUEST_ID,
      operation: {
        id: confirmed.data.id,
        state: confirmed.data.state,
        phase: confirmed.data.phase,
        revision: confirmed.data.revision,
        errorCode: confirmed.data.errorCode,
        errorMessage: confirmed.data.errorMessage,
        items: confirmed.data.items
      },
      remainingRequested: HANDLES,
      presentAfterAll: allRequested.map((handle) => ({
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
