import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const DB = 'J:/PigeonYang/WeMediaBuddyData/wmb.db';
const TASK_ID = 'f36ac3dd-5123-4fa4-8e7d-2c63c614de65';
const MAX_MS = 15*60*1000;
const INTERVAL_MS = 30000; // conservative 30s

const startedAt = Date.now();
console.log(`[poll] start ${new Date().toISOString()} task=${TASK_ID} max=${MAX_MS} interval=${INTERVAL_MS}`);

function readTask(){
  const db = new DatabaseSync(DB, { readOnly: true });
  try{
    const row = db.prepare('SELECT id,intent,business_date,status,phase,created_at,updated_at,finished_at,progress_json,checkpoint_json,result_refs_json,error_code,error_message,context_refs_json FROM agent_tasks WHERE id=?').get(TASK_ID);
    return row;
  } finally {
    try{ db.close(); }catch{}
  }
}

function isTerminal(status){
  return status==='succeeded' || status==='partial' || status==='failed' || status==='cancelled' || status==='interrupted' || status==='needs_user';
}

let pollCount=0;
while(true){
  pollCount++;
  const row = readTask();
  if(!row){
    console.log(`[poll ${pollCount}] NOT_FOUND`);
    fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/tmp-poll-result.json', JSON.stringify({ status:'blocked', reason:'task not found', pollCount, elapsedSec: Math.round((Date.now()-startedAt)/1000)},null,2));
    process.exit(2);
  }
  const now = new Date().toISOString();
  const elapsed = Date.now()-startedAt;
  const chk = (()=>{ try{ return JSON.parse(row.checkpoint_json); }catch{return {}}})();
  const prog = (()=>{ try{ return JSON.parse(row.progress_json); }catch{return {}}})();
  console.log(`[poll ${pollCount} ${now} elapsed=${Math.round(elapsed/1000)}s] status=${row.status} phase=${row.phase} finished_at=${row.finished_at} error=${row.error_code} progMsg=${prog.message?.slice(0,80) ?? ''} children=${chk.children?.length??0} planId=${chk.planId??chk.reusedTaskId??''} receipts=${(chk.receiptIds?.length??0)}`);
  if(isTerminal(row.status)){
    console.log(`[poll] TERMINAL detected: status=${row.status}`);
    const out = {
      pollCount,
      elapsedMs: elapsed,
      elapsedSec: Math.round(elapsed/1000),
      final: row,
      parsedCheckpoint: chk,
      parsedProgress: prog
    };
    fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/tmp-poll-result.json', JSON.stringify(out,null,2));
    // also write a proof summary
    fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/tmp-poll-terminal-proof.txt', `taskId=${row.id}\nintent=${row.intent}\nbusiness_date=${row.business_date}\nstatus=${row.status}\nphase=${row.phase}\ncreated_at=${row.created_at}\nupdated_at=${row.updated_at}\nfinished_at=${row.finished_at}\nerror_code=${row.error_code}\nerror_message=${row.error_message}\nprogress=${row.progress_json}\ncheckpoint=${row.checkpoint_json}\nresult_refs=${row.result_refs_json}\ncontext_refs=${row.context_refs_json}\n`);
    process.exit(0);
  }
  if(elapsed >= MAX_MS){
    console.log(`[poll] TIMEOUT after ${Math.round(elapsed/1000)}s still running`);
    fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/tmp-poll-result.json', JSON.stringify({ status:'timeout_running', pollCount, elapsedMs:elapsed, elapsedSec: Math.round(elapsed/1000), last: row, checkpoint: chk, progress: prog},null,2));
    fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/tmp-poll-terminal-proof.txt', `STILL_RUNNING pollCount=${pollCount} elapsedSec=${Math.round(elapsed/1000)} lastStatus=${row.status} phase=${row.phase} updated_at=${row.updated_at}\n`);
    process.exit(1);
  }
  await new Promise(r=>setTimeout(r, INTERVAL_MS));
}
