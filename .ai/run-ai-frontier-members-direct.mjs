import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { readBrowserConfig, ensurePyaireaderXBrowser } from '../src/main/browser.ts';
import { ensureXListMember, readXListMembers } from '../src/main/platforms/x-list-browser.ts';

const LIST_ID = '2082851520417255750';
const HANDLES = [
  '@AnthropicAI',
  '@GoogleDeepMind',
  '@xai',
  '@BytePlusGlobal',
  '@ByteDanceOSS',
  '@CapCutApp'
];
const OUT = path.resolve('.ai/ai-frontier-members-direct-result.json');

const database = migrateDatabase('J:/PigeonYang/WeMediaBuddyData/wmb.db');
const results = [];
try {
  const browserCfg = readBrowserConfig(database);
  if (!browserCfg) throw new Error('no browser config');
  const runtime = await ensurePyaireaderXBrowser(browserCfg, { mode: 'visible' });
  const config = { id: browserCfg.id, cdpUrl: runtime.cdpUrl };

  for (const handle of HANDLES) {
    const started = Date.now();
    console.log('adding', handle);
    try {
      const outcome = await ensureXListMember(config, {
        listId: LIST_ID,
        handle,
        desiredState: 'present'
      });
      results.push({ handle, ok: true, outcome, ms: Date.now() - started });
      console.log('ok', handle, outcome.outcome, `${Date.now() - started}ms`);
    } catch (error) {
      results.push({
        handle,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ms: Date.now() - started
      });
      console.error('fail', handle, error instanceof Error ? error.message : error);
    }
  }

  let members = null;
  try {
    members = await readXListMembers(config, LIST_ID);
  } catch (error) {
    members = { error: error instanceof Error ? error.message : String(error) };
  }
  const present = new Set((members.members || []).map((m) => String(m.handle || '').toLowerCase()));
  const all = ['@deepseek_ai', '@OpenAI', ...HANDLES];
  const payload = {
    ok: results.every((r) => r.ok),
    results,
    presentAfter: all.map((handle) => ({ handle, present: present.has(handle.toLowerCase()) })),
    membersCount: members.members?.length ?? null,
    membersError: members.error ?? null,
    finishedAt: new Date().toISOString()
  };
  await writeFile(OUT, JSON.stringify(payload, null, 2), 'utf8');
  console.log(JSON.stringify(payload, null, 2));
  process.exitCode = payload.ok ? 0 : 2;
} catch (error) {
  const payload = { ok: false, error: error instanceof Error ? error.message : String(error), stack: error?.stack, results };
  await writeFile(OUT, JSON.stringify(payload, null, 2), 'utf8');
  console.error(payload);
  process.exitCode = 1;
} finally {
  database.close();
}
