import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { readBrowserConfig, ensurePyaireaderXBrowser } from '../src/main/browser.ts';
import { ensureXListMember, readXListMembers } from '../src/main/platforms/x-list-browser.ts';

const LIST_ID = '2082851520417255750';
const HANDLE = process.argv[2] || '@AnthropicAI';
const OUT = path.resolve('.ai/run-add-one-member-result.json');

const database = migrateDatabase('J:/PigeonYang/WeMediaBuddyData/wmb.db');
try {
  const browserCfg = readBrowserConfig(database);
  const runtime = await ensurePyaireaderXBrowser(browserCfg, { mode: 'visible' });
  const config = { id: browserCfg.id, cdpUrl: runtime.cdpUrl };
  console.log('adding', HANDLE);
  const outcome = await ensureXListMember(config, { listId: LIST_ID, handle: HANDLE, desiredState: 'present' });
  console.log('outcome', outcome);
  let members = null;
  try { members = await readXListMembers(config, LIST_ID); } catch (e) { members = { error: String(e?.message || e) }; }
  const present = new Set((members.members || []).map((m) => String(m.handle || '').toLowerCase()));
  const payload = {
    ok: true,
    handle: HANDLE,
    outcome,
    present: present.has(HANDLE.toLowerCase()),
    membersCount: members.members?.length ?? null,
    memberHandles: (members.members || []).map((m) => m.handle),
    membersError: members.error ?? null
  };
  await writeFile(OUT, JSON.stringify(payload, null, 2), 'utf8');
  console.log(JSON.stringify(payload, null, 2));
} catch (error) {
  const payload = { ok: false, handle: HANDLE, error: error instanceof Error ? error.message : String(error), stack: error?.stack };
  await writeFile(OUT, JSON.stringify(payload, null, 2), 'utf8');
  console.error(payload);
  process.exitCode = 1;
} finally {
  database.close();
}
