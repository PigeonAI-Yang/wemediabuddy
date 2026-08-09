
import { DatabaseSync } from 'node:sqlite';
import { getToday } from '../src/main/workbench.ts';
import { completeAgentTask, getAgentTask } from '../src/main/agent-tasks.ts';
import { randomUUID } from 'node:crypto';

const db = new DatabaseSync('j:/PigeonYang/WeMediaBuddyData/wmb.db');
const today = getToday(db, '2026-08-08');
console.log('plan', today.plan && { id: today.plan.id, items: today.plan.items.length, summary: today.plan.summary.slice(0,60) });

// create synthetic running daily_judge task
const id = randomUUID();
const now = new Date().toISOString();
db.prepare(`INSERT INTO agent_tasks (
  id, intent, business_date, status, phase, context_refs_json, progress_json, events_json, result_refs_json,
  created_at, updated_at, revision
) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`).run(
  id, 'daily_judge', '2026-08-08', 'running', 'validating',
  JSON.stringify({ planDate: '2026-08-08', workspaceId: 'a755adf2-4e8d-4abd-b616-4d7934f730f1' }),
  '{}', '[]', '{}', now, now
);
try {
  const res = completeAgentTask(db, id);
  console.log('complete', res);
  const task = getAgentTask(db, id);
  console.log('task status', task?.status, task?.errorCode, task?.errorMessage);
} finally {
  db.prepare('DELETE FROM agent_tasks WHERE id=?').run(id);
}
db.close();
