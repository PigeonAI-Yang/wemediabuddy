import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase } from './src/main/db/migrations.ts';
import { ActiveWorkspaceRuntime } from './src/main/workspace-runtime.ts';
import { dispatchManagerDailyIntelligence } from './src/main/manager-dispatch.ts';
import { readLatestJudgeWatermark } from './src/main/agent-tasks.ts';
import { listLaneGateCandidates } from './src/main/lane-gate.ts';
import { assembleEditorialBrief } from './src/main/editorial-brief.ts';

const dataRootPath = 'J:\\PigeonYang\\WeMediaBuddyData';
const businessDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
console.log('Triggering fresh daily-intelligence for businessDate', businessDate, 'at', new Date().toISOString());

// Verify watermark before trigger
{
  const db = migrateDatabase(path.join(dataRootPath, 'wmb.db'));
  const wm = readLatestJudgeWatermark(db);
  console.log('pre-trigger watermark', wm);
  const candidates = listLaneGateCandidates(db, { since: wm ?? new Date(Date.now()-24*3600*1000).toISOString() });
  console.log('pre-trigger candidates count', candidates.length, 'contains Wan?', candidates.some(c=>c.sourceId==='153162be-6b20-49ea-8c17-a2fc18fafe4d'));
  const brief = assembleEditorialBrief(db, { businessDate, watermark: wm });
  console.log('pre-trigger brief sources', brief.increment.sources.length, 'contains Wan?', brief.increment.sources.some(s=>s.id==='153162be-6b20-49ea-8c17-a2fc18fafe4d'));
  db.close();
}

let runtime;
try {
  runtime = ActiveWorkspaceRuntime.open(dataRootPath, { openDatabase: migrateDatabase, createEpoch: () => randomUUID() });
  console.log('runtime opened', runtime.identity.workspaceId, runtime.identity.runtimeEpoch);
  console.log('runtime isActive', runtime.isActive);

  // Trigger exactly one fresh run via manager dispatch (normal UI path)
  const result = await dispatchManagerDailyIntelligence(runtime, dataRootPath, { businessDate });
  console.log('dispatch result', JSON.stringify(result, null, 2));
  const managerTask = result.managerTask;
  console.log('new managerTask id', managerTask.id, 'status', managerTask.status, 'phase', managerTask.phase);
  console.log('action', result.action);

  // Also check for any new daily tasks created
  const db = runtime.database;
  const newTasks = db.prepare("SELECT id, intent, business_date, status, phase, created_at FROM agent_tasks WHERE business_date=? ORDER BY created_at DESC LIMIT 5").all(businessDate);
  console.log('tasks for businessDate after dispatch', newTasks);

  // Poll for up to 14 minutes (we have already spent ~5, total 15)
  const start = Date.now();
  const timeoutMs = 14*60*1000;
  let terminal = null;
  let lastProgress = '';
  while (Date.now() - start < timeoutMs) {
    await new Promise(r=>setTimeout(r, 5000));
    const polled = db.prepare("SELECT id, intent, business_date, status, phase, error_code, error_message, progress_json, checkpoint_json, updated_at FROM agent_tasks WHERE business_date=? ORDER BY updated_at DESC LIMIT 5").all(businessDate);
    // Also check manager task
    const mgr = db.prepare("SELECT id, status, phase, checkpoint_json, progress_json, error_code FROM agent_tasks WHERE id=?").get(managerTask.id);
    const mgrCk = mgr ? JSON.parse(mgr.checkpoint_json) : null;
    const mgrStatus = mgr ? mgr.status : 'unknown';
    const elapsed = Math.round((Date.now()-start)/1000);
    console.log(`[${elapsed}s] manager ${managerTask.id} status=${mgrStatus} phase=${mgr?.phase} progress=${mgr?.progress_json?.slice(0,120) || ''}`);
    for (const t of polled) {
      if (t.intent !== 'page_agents') {
        console.log(`  task ${t.id} ${t.intent} ${t.status}/${t.phase} err=${t.error_code || ''}`);
      }
    }
    // Check if manager is terminal (succeeded/partial/failed) or if a daily_judge succeeded
    const dailyJudge = polled.find(t=>t.intent==='daily_judge' || t.intent==='daily_scan' || t.intent==='daily_intelligence');
    if (dailyJudge && ['succeeded','partial','failed','cancelled'].includes(dailyJudge.status)) {
      // Check if manager also terminal or still running but daily is terminal
      // For manager dispatch, terminal is when manager status is succeeded/partial/failed or phase done
      if (mgrStatus !== 'running' || (mgrCk && ['succeeded','partial','failed','cancelled'].includes(mgrCk.status))) {
        terminal = { manager: mgr, daily: dailyJudge, polled };
        console.log('terminal detected', JSON.stringify(terminal, null, 2));
        break;
      }
    }
    // Also check Today DOM via workbench? We'll just log
    // Check for new plan
    const plans = db.prepare("SELECT id, plan_date, summary, is_current, updated_at FROM plans WHERE plan_date=? ORDER BY updated_at DESC LIMIT 3").all(businessDate);
    console.log('  plans for date', plans.map(p=>`${p.id.slice(0,8)} is_current=${p.is_current} summary=${p.summary.slice(0,40)}`));

    // Truthful progress: if still active, continue
    if (mgrStatus === 'running') {
      console.log('  still running, continue polling...');
    } else {
      console.log('  manager not running, checking terminal...');
      if (['succeeded','partial','failed'].includes(mgrStatus)) {
        terminal = { manager: mgr, daily: dailyJudge, polled };
        break;
      }
    }
  }

  if (!terminal) {
    console.log('timeout reached, returning partial with current state');
    const mgr = db.prepare("SELECT id, status, phase, checkpoint_json, progress_json FROM agent_tasks WHERE id=?").get(managerTask.id);
    console.log('final manager', JSON.stringify(mgr, null, 2));
    const polled = db.prepare("SELECT id, intent, status, phase, error_code FROM agent_tasks WHERE business_date=? ORDER BY updated_at DESC LIMIT 5").all(businessDate);
    console.log('final polled tasks', polled);
  } else {
    console.log('run completed terminal', JSON.stringify(terminal, null, 2));
    // Check plan items
    const plans = db.prepare("SELECT id, plan_date, is_current FROM plans WHERE plan_date=? ORDER BY updated_at DESC LIMIT 2").all(businessDate);
    console.log('final plans', plans);
    for (const p of plans) {
      const items = db.prepare("SELECT id, title, source_ids_json FROM plan_items WHERE plan_id=?").all(p.id);
      console.log(`plan ${p.id} items ${items.length}`, items.map(i=>`${i.id.slice(0,8)} title=${i.title.slice(0,30)} sources=${i.source_ids_json.slice(0,100)}`));
      const hasWan = items.some(i=> {
        try { const ids = JSON.parse(i.source_ids_json); return ids.includes('153162be-6b20-49ea-8c17-a2fc18fafe4d'); } catch{ return false; }
      });
      console.log('plan contains Wan?', hasWan);
    }
  }

} catch(e) {
  console.error('trigger failed', e.stack || e.message, e.code || '');
} finally {
  if (runtime) {
    try { await runtime.stop({drain:false}); console.log('runtime stopped'); } catch(e){ console.error('stop failed', e); }
  }
  console.log('trigger script done');
}
