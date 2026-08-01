import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { startMcp } from '../src/main/mcp.ts';
import { startDailyIntelligence } from '../src/main/agent-runner.ts';
import { getAgentTask, getLatestAgentTask } from '../src/main/agent-tasks.ts';

const DATA_ROOT = 'J:/PigeonYang/WeMediaBuddyData';
const OUT = path.resolve('.ai/run-daily-intelligence-once-result.json');
const businessDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());

function dump(label, value) {
  console.log(label, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

const database = migrateDatabase(path.join(DATA_ROOT, 'wmb.db'));
let mcp = null;
try {
  const existing = getLatestAgentTask(database, 'daily_intelligence', businessDate);
  if (existing && existing.status === 'running') {
    dump('existing.running', {
      id: existing.id,
      phase: existing.phase,
      message: existing.message,
      updatedAt: existing.updatedAt
    });
    // Stale headless starts can leave a stuck "starting" task; force a clean run.
    database.prepare(`UPDATE agent_tasks SET status='cancelled', phase='cancelled', error_message=?, updated_at=? WHERE id=?`)
      .run('superseded by manual full run', new Date().toISOString(), existing.id);
    dump('existing.cancelled', existing.id);
  }
  mcp = await startMcp(DATA_ROOT);
  dump('mcp.ready', { url: mcp.url, businessDate });

  const startedAt = Date.now();
  const run = await startDailyIntelligence({
    dataRootPath: DATA_ROOT,
    businessDate,
    mcpUrl: mcp.url,
    onEvent: (event) => {
      if (event?.type === 'agent_task') {
        const task = event.task || {};
        console.log(`[task] ${task.status || '?'} / ${task.phase || '?'} :: ${task.message || ''}`);
      } else if (event?.type === 'failed') {
        console.log('[failed]', event.error || event);
      } else if (event?.type === 'delta') {
        // keep quiet; too noisy
      } else if (event?.type) {
        console.log(`[event] ${event.type}`);
      }
    }
  });

  dump('run.started', {
    taskId: run.task?.id,
    reused: run.reused,
    status: run.task?.status,
    phase: run.task?.phase,
    message: run.task?.message
  });

  // Poll until terminal.
  const terminal = new Set(['succeeded', 'failed', 'cancelled', 'partial']);
  let latest = getAgentTask(database, run.task.id) || run.task;
  const deadline = Date.now() + 50 * 60_000;
  while (latest && !terminal.has(latest.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10_000));
    latest = getAgentTask(database, run.task.id);
    if (latest) {
      console.log(`[poll] ${latest.status}/${latest.phase} processed=${latest.progress?.processed ?? '-'} saved=${latest.progress?.saved ?? '-'} :: ${latest.message || ''}`);
    }
  }

  const sourceCount = database.prepare(
    `select count(*) as c from source_items where collected_at >= ?`
  ).get(`${businessDate}T00:00:00.000Z`).c;
  const recent = database.prepare(
    `select title, original_url as url, client_label as label, collected_at
     from source_items
     where collected_at >= ?
     order by collected_at desc
     limit 15`
  ).all(`${businessDate}T00:00:00.000Z`);

  const payload = {
    ok: latest?.status === 'succeeded' || latest?.status === 'partial',
    businessDate,
    elapsedMs: Date.now() - startedAt,
    task: latest && {
      id: latest.id,
      status: latest.status,
      phase: latest.phase,
      message: latest.message,
      progress: latest.progress,
      errorCode: latest.errorCode,
      errorMessage: latest.errorMessage,
      checkpoint: latest.checkpoint
    },
    sourceCountToday: sourceCount,
    recent
  };
  await writeFile(OUT, JSON.stringify(payload, null, 2), 'utf8');
  dump('result', payload);
  process.exitCode = payload.ok ? 0 : 2;
} catch (error) {
  const payload = {
    ok: false,
    businessDate,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  };
  await writeFile(OUT, JSON.stringify(payload, null, 2), 'utf8');
  console.error(payload);
  process.exitCode = 1;
} finally {
  database.close();
  if (mcp) await mcp.close().catch(() => {});
}
