import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

const DATA_ROOT='J:/PigeonYang/WeMediaBuddyData';
const projectId='54c20293-8038-40fb-a7a2-e74a78f27188';
const initialTaskId='dbf0ae53-c92d-4bdd-9c71-aea9bea2b1f2';
const initialJobId='0e3c087c-46a4-4788-b3b3-c3cfe83a7974';
const reporterTaskId='d7b24b0d-ab41-4716-b9d4-4f7645b856b6';

function safeQuery(fn){
  for(let i=0;i<5;i++){
    try{
      const db=new DatabaseSync(path.join(DATA_ROOT,'wmb.db'),{readOnly:true});
      try{ return fn(db); } finally{ db.close();}
    }catch(e){
      if(String(e.message).includes('database is locked')){
        // wait 500ms
        const start=Date.now(); while(Date.now()-start<500){}
        continue;
      }
      throw e;
    }
  }
  throw new Error('db locked after retries');
}

function log(...a){ console.log(new Date().toISOString(), ...a); }

async function waitForReporter(timeoutMs=600000){
  const start=Date.now();
  while(Date.now()-start < timeoutMs){
    const row = safeQuery(db=> db.prepare(`SELECT id, status, phase, updated_at FROM agent_tasks WHERE id=?`).get(reporterTaskId));
    log('reporter poll', row);
    if(row && ['succeeded','partial','failed'].includes(row.status)){
      return row;
    }
    await new Promise(r=>setTimeout(r,5000));
  }
  return null;
}

async function waitForResumed(timeoutMs=600000){
  const start=Date.now();
  while(Date.now()-start < timeoutMs){
    const rows = safeQuery(db=> db.prepare(`SELECT id, status, phase, context_refs_json, updated_at FROM agent_tasks WHERE intent='studio_draft' AND context_refs_json LIKE '%' || ? || '%' ORDER BY created_at DESC LIMIT 5`).all(projectId));
    // log
    log('resumed poll candidates', rows.map(r=>({id:r.id, status:r.status, phase:r.phase, gate:JSON.parse(r.context_refs_json).researchGate})));
    for(const r of rows){
      if(r.id===initialTaskId) continue;
      const ctx=JSON.parse(r.context_refs_json);
      if(ctx.researchGate==='satisfied'){
        if(['succeeded','failed','partial'].includes(r.status)){
          return r;
        }
        // if running, keep waiting
        log('found resumed running', r.id, r.status);
        // wait a bit and check again
      }
    }
    await new Promise(r=>setTimeout(r,5000));
  }
  return null;
}

async function main(){
  log('waiting for reporter');
  const rep = await waitForReporter(600000);
  log('reporter terminal', rep);
  if(!rep){
    log('reporter timeout');
    process.exit(1);
  }
  log('waiting for resumed');
  const resumed = await waitForResumed(600000);
  log('resumed terminal', resumed);
  if(!resumed){
    log('resumed timeout');
    process.exit(1);
  }
  // check versions
  const versions = safeQuery(db=> db.prepare(`SELECT id, version_number FROM content_versions WHERE project_id=? ORDER BY version_number`).all(projectId));
  log('versions', versions);
  // check receipt
  let resumedTaskId = resumed.id;
  const receipts = safeQuery(db=> db.prepare(`SELECT id, command, task_id, status, request_id, result_json, error_json FROM command_receipts WHERE command='content.save_version' AND task_id=? ORDER BY created_at DESC LIMIT 5`).all(resumedTaskId));
  log('receipts', JSON.stringify(receipts,null,2).slice(0,3000));
  const okReceipt = receipts.find(r=>r.status==='ok');
  if(okReceipt){
    const result = JSON.parse(okReceipt.result_json);
    log('okReceipt version', result);
    const v = safeQuery(db=> db.prepare(`SELECT id, project_id FROM content_versions WHERE id=?`).get(result.id));
    log('version exists under project?', v);
  }
  // also check task and job status
  const taskRow = safeQuery(db=> db.prepare(`SELECT status, phase, error_code, error_message FROM agent_tasks WHERE id=?`).get(resumedTaskId));
  log('resumed taskRow', taskRow);
  // try to get jobId from context
  const ctxRow = safeQuery(db=> db.prepare(`SELECT context_refs_json FROM agent_tasks WHERE id=?`).get(resumedTaskId));
  const ctx = JSON.parse(ctxRow.context_refs_json);
  const jobId = ctx.jobId;
  if(jobId){
    const job = safeQuery(db=> db.prepare(`SELECT id, kind, status, last_error FROM jobs WHERE id=?`).get(jobId));
    log('job', job);
  }
  // project detail
  const detail = safeQuery(db=> {
    // use content_projects detail via direct query for versionCount
    const cnt = db.prepare(`SELECT COUNT(*) as c FROM content_versions WHERE project_id=?`).get(projectId);
    return cnt;
  });
  log('version count', detail);
}

main();
