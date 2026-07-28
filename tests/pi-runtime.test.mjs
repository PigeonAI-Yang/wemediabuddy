import assert from 'node:assert/strict';
import test from 'node:test';
import { PiRpcSupervisor } from '../src/main/pi-runtime.ts';

test('Pi RPC supervisor streams deltas, settles prompts, aborts and stops', async () => {
  const fixture = `
let b='';
let aborted=false;
let turn=0;
process.stdin.on('data',d=>{
  b+=d;
  while(b.includes('\\n')){
    const i=b.indexOf('\\n');
    const r=JSON.parse(b.slice(0,i));
    b=b.slice(i+1);
    if(r.type==='get_state'){
      process.stdout.write(JSON.stringify({id:r.id,type:'response',command:'get_state',success:true,data:{isStreaming:false,sessionId:'s1',sessionFile:'dock.jsonl'}})+'\\n');
      continue;
    }
    if(r.type==='prompt'){
      turn += 1;
      const current = turn;
      process.stdout.write(JSON.stringify({id:r.id,type:'response',command:'prompt',success:true})+'\\n');
      process.stdout.write(JSON.stringify({type:'agent_start'})+'\\n');
      process.stdout.write(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'hel'}})+'\\n');
      if (current === 1) {
        process.stdout.write(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'lo'}})+'\\n');
        setTimeout(() => {
          process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'hello world'}]}})+'\\n');
          process.stdout.write(JSON.stringify({type:'agent_end'})+'\\n');
          process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n');
        }, 20);
      } else {
        setTimeout(() => {
          if (aborted) return;
          process.stdout.write(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'lo'}})+'\\n');
          process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'hello world'}]}})+'\\n');
          process.stdout.write(JSON.stringify({type:'agent_end'})+'\\n');
          process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n');
        }, 80);
      }
      continue;
    }
    if(r.type==='abort'){
      aborted=true;
      process.stdout.write(JSON.stringify({id:r.id,type:'response',command:'abort',success:true})+'\\n');
      process.stdout.write(JSON.stringify({type:'agent_end'})+'\\n');
      process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n');
      continue;
    }
    if(r.type==='get_last_assistant_text'){
      process.stdout.write(JSON.stringify({id:r.id,type:'response',command:'get_last_assistant_text',success:true,data:{text:aborted?'hel':'hello world'}})+'\\n');
      continue;
    }
    process.stdout.write(JSON.stringify({id:r.id,type:'response',command:r.type,success:true})+'\\n');
  }
});
`;
  const events = [];
  const runtime = new PiRpcSupervisor(process.execPath, ['-e', fixture], process.env, (event) => events.push(event));
  assert.equal((await runtime.start()).success, true);
  assert.equal(typeof runtime.pid, 'number');

  const deltas = [];
  const full = await runtime.promptUntilSettled('test', { onDelta: (text) => deltas.push(text) });
  assert.equal(full.text, 'hello world');
  assert.equal(full.stopped, false);
  assert.deepEqual(deltas, ['hel', 'hello']);

  const pending = runtime.promptUntilSettled('again');
  await new Promise((resolve) => setTimeout(resolve, 20));
  await runtime.abortTurn();
  const stopped = await pending;
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.text, 'hel');
  await runtime.stop();
  assert.equal(runtime.isRunning, false);
  assert.equal(events.some((event) => event.type === 'wmb_process_stopped'), true);
});

test('Pi RPC supervisor surfaces unexpected process exit as crash', async () => {
  const fixture = `
let b='';
process.stdin.on('data',d=>{
  b+=d;
  while(b.includes('\\n')){
    const i=b.indexOf('\\n');
    const r=JSON.parse(b.slice(0,i));
    b=b.slice(i+1);
    if(r.type==='get_state'){
      process.stdout.write(JSON.stringify({id:r.id,type:'response',command:'get_state',success:true,data:{}})+'\\n');
      continue;
    }
    if(r.type==='prompt'){
      process.stdout.write(JSON.stringify({id:r.id,type:'response',command:'prompt',success:true})+'\\n');
      process.stdout.write(JSON.stringify({type:'agent_start'})+'\\n');
      process.stdout.write(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'x'}})+'\\n');
      setTimeout(() => process.exit(7), 20);
    }
  }
});
`;
  const events = [];
  const runtime = new PiRpcSupervisor(process.execPath, ['-e', fixture], process.env, (event) => events.push(event));
  await runtime.start();
  await assert.rejects(() => runtime.promptUntilSettled('boom'), /Pi 进程已退出/);
  assert.equal(events.some((event) => event.type === 'wmb_process_crashed'), true);
  assert.equal(runtime.isRunning, false);
});
