import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase } from './src/main/db/migrations.ts';
import { ActiveWorkspaceRuntime } from './src/main/workspace-runtime.ts';
import { startMcp } from './src/main/mcp.ts';
import { startDailyIntelligence } from './src/main/agent-runner.ts';

const dataRootPath = 'J:\\PigeonYang\\WeMediaBuddyData';
const businessDate = '2026-08-25';
console.log('Starting direct daily intelligence for', businessDate);

let runtime;
let mcp;
try {
  runtime = ActiveWorkspaceRuntime.open(dataRootPath, { openDatabase: migrateDatabase, createEpoch: () => randomUUID() });
  console.log('runtime', runtime.identity.workspaceId);

  // Start MCP
  mcp = await startMcp(dataRootPath, undefined, undefined, runtime);
  console.log('mcp url', mcp.url);

  // Need to ensure Pi runtime is prepared - check if pi-runtime exists
  // startDailyIntelligence will handle Pi via ensurePiConversationLayout etc.
  console.log('calling startDailyIntelligence...');
  const result = await startDailyIntelligence({
    dataRootPath,
    businessDate,
    mcpUrl: mcp.url,
    activeRuntime: runtime,
  });
  console.log('startDailyIntelligence result', JSON.stringify(result, null, 2));

  // Poll for completion
  const db = runtime.database;
  const taskId = result.task.id;
  console.log('task id', taskId, 'reused', result.reused);
  const start = Date.now();
  const timeoutMs = 10*60*1000;
  while (Date.now() - start < timeoutMs) {
    await new Promise(r=>setTimeout(r, 5000));
    const row = db.prepare("SELECT id, status, phase, error_code, error_message, progress_json, checkpoint_json FROM agent_tasks WHERE id=?").get(taskId);
    console.log(`[${Math.round((Date.now()-start)/1000)}s] task ${taskId} ${row.status}/${row.phase} err=${row.error_code || ''} progress=${row.progress_json.slice(0,150)}`);
    if (['succeeded','partial','failed','cancelled'].includes(row.status)) {
      console.log('terminal reached', row.status);
      break;
    }
  }
  const finalRow = runtime.database.prepare("SELECT * FROM agent_tasks WHERE id=?").get(taskId);
  console.log('final row', JSON.stringify(finalRow, null, 2));
  // Check plan
  const plans = runtime.database.prepare("SELECT id, plan_date, summary, is_current FROM plans WHERE plan_date=? ORDER BY updated_at DESC LIMIT 2").all(businessDate);
  console.log('plans', plans);
  for (const p of plans) {
    const items = runtime.database.prepare("SELECT id, title, source_ids_json FROM plan_items WHERE plan_id=?").all(p.id);
    console.log(`plan ${p.id} items ${items.length}`, items.map(i=>i.title.slice(0,40)));
    console.log('contains Wan?', items.some(i=>JSON.parse(i.source_ids_json).includes('153162be-6b20-49ea-8c17-a2fc18fafe4d')));
  }

} catch(e) {
  console.error('direct trigger failed', e.stack || e.message);
} finally {
  if (mcp) { try { await mcp.close(); console.log('mcp closed'); } catch(e){} }
  if (runtime) { try { await runtime.stop({drain:false}); console.log('runtime stopped'); } catch(e){} }
}
