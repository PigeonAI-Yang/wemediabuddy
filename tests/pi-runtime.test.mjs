import assert from 'node:assert/strict';
import test from 'node:test';
import { PiRpcSupervisor } from '../src/main/pi-runtime.ts';
import { readPiCommands } from '../src/main/pi-commands.ts';

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
      process.stdout.write(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'thinking_delta',delta:'why '}})+'\\n');
      process.stdout.write(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'thinking_delta',delta:'now'}})+'\\n');
      process.stdout.write(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'hel'}})+'\\n');
      if (current === 1) {
        process.stdout.write(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'lo'}})+'\\n');
        setTimeout(() => {
          process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'thinking',thinking:'why now'},{type:'text',text:'hello world'}]}})+'\\n');
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
  assert.equal(full.thinking, 'why now');
  assert.equal(full.stopped, false);
  assert.deepEqual(deltas, ['hel', 'hello']);
  assert.equal(events.some((event) => event.type === 'wmb_thinking_delta' && event.text === 'why now'), true);

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

test('Pi RPC supervisor preserves native delivery, entries and no default dock deadline', async () => {
  const fixture = `
let b='';
const steering=[];
const followUp=[];
process.stdin.on('data',d=>{
  b+=d;
  while(b.includes('\\n')){
    const i=b.indexOf('\\n');
    const r=JSON.parse(b.slice(0,i));
    b=b.slice(i+1);
    if(r.type==='get_state'){
      process.stdout.write(JSON.stringify({id:r.id,type:'response',command:'get_state',success:true,data:{sessionId:'s2',sessionFile:'fork.jsonl'}})+'\\n');
      continue;
    }
    if(r.type==='prompt'){
      process.stdout.write(JSON.stringify({id:r.id,type:'response',command:'prompt',success:true})+'\\n');
      if(r.message==='wait') setTimeout(()=>{
        process.stdout.write(JSON.stringify({type:'agent_start'})+'\\n');
        process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}]}})+'\\n');
        process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n');
      },15);
      continue;
    }
    if(r.type==='steer'||r.type==='follow_up'){
      if(r.type==='steer') steering.push(r.message);
      else followUp.push(r.message);
      process.stdout.write(JSON.stringify({id:r.id,type:'response',command:r.type,success:true,data:{type:r.type}})+'\\n');
      process.stdout.write(JSON.stringify({type:'queue_update',steering,followUp})+'\\n');
      continue;
    }
    if(r.type==='get_entries'){
      process.stdout.write(JSON.stringify({id:r.id,type:'response',command:'get_entries',success:true,data:{entries:[{type:'message',id:'u1',timestamp:'2026-07-30T00:00:00.000Z',message:{role:'user',content:'hello'}}],leafId:'u1'}})+'\\n');
      continue;
    }
    if(r.type==='get_commands'){
      process.stdout.write(JSON.stringify({id:r.id,type:'response',command:'get_commands',success:true,data:{commands:[{name:'skill:writer',description:'Write with evidence',source:'skill',path:'C:/secret/SKILL.md'},{name:'fix-tests',description:'Fix tests',source:'prompt',location:'project'},{name:'session-name',source:'extension'}]}})+'\\n');
      continue;
    }
    if(r.type==='fork'){
      process.stdout.write(JSON.stringify({id:r.id,type:'response',command:'fork',success:true,data:{text:'hello',cancelled:false}})+'\\n');
      continue;
    }
  }
});
`;
  const events = [];
  const runtime = new PiRpcSupervisor(process.execPath, ['-e', fixture], process.env, (event) => events.push(event));
  await runtime.start();
  const originalSetTimeout = global.setTimeout;
  const delays = [];
  let streaming = false;
  global.setTimeout = (...args) => {
    delays.push(args[1]);
    return originalSetTimeout(...args);
  };
  try {
    assert.equal((await runtime.promptUntilSettled('wait', { onStreaming: () => { streaming = true; } })).text, 'done');
  } finally {
    global.setTimeout = originalSetTimeout;
  }
  assert.equal(delays.includes(120000), false);
  assert.equal(streaming, true);
  assert.equal((await runtime.steer('now')).data.type, 'steer');
  assert.equal((await runtime.followUp('later')).data.type, 'follow_up');
  const deadline = Date.now() + 500;
  let hasQueue = false;
  while (Date.now() < deadline) {
    hasQueue = events.some((event) => {
      if (event.type !== 'queue_update') return false;
      const steering = Array.isArray(event.steering) ? event.steering.map(String) : [];
      const followUp = Array.isArray(event.followUp) ? event.followUp.map(String) : [];
      return steering.includes('now') && followUp.includes('later');
    });
    if (hasQueue) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(hasQueue, true);
  assert.equal((await runtime.getEntries()).data.entries[0].id, 'u1');
  assert.deepEqual(readPiCommands(await runtime.getCommands()), [
    { name: 'skill:writer', description: 'Write with evidence', source: 'skill' },
    { name: 'fix-tests', description: 'Fix tests', source: 'prompt' },
    { name: 'session-name', description: '', source: 'extension' }
  ]);
  assert.equal((await runtime.fork('u1')).data.cancelled, false);
  await runtime.stop();
});

test('Pi command catalog drops paths and invalid commands', () => {
  assert.deepEqual(readPiCommands({ data: { commands: [
    { name: ' skill:real ', description: ' Real ', source: 'skill', path: 'C:/secret/SKILL.md' },
    { name: 'bad', source: 'builtin' },
    { name: '', source: 'prompt' },
    null
  ] } }), [{ name: 'skill:real', description: 'Real', source: 'skill' }]);
  assert.deepEqual(readPiCommands({ data: { commands: 'bad' } }), []);
});


test('Pi RPC supervisor surfaces provider stop errors instead of empty-text', async () => {
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
      process.stdout.write(JSON.stringify({type:'message_start',message:{role:'assistant',content:[]}})+'\\n');
      process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',content:[],stopReason:'error',errorMessage:'403: {"type":"RegionError","message":"The latest version of this model is only available hosted in China and requires explicit opt in: https://opencode.ai/workspace/x/go"}'}})+'\\n');
      process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n');
      continue;
    }
    if(r.type==='get_last_assistant_text'){
      process.stdout.write(JSON.stringify({id:r.id,type:'response',command:'get_last_assistant_text',success:true,data:{text:''}})+'\\n');
      continue;
    }
    process.stdout.write(JSON.stringify({id:r.id,type:'response',command:r.type,success:true})+'\\n');
  }
});
`;
  const runtime = new PiRpcSupervisor(process.execPath, ['-e', fixture], process.env);
  await runtime.start();
  await assert.rejects(
    () => runtime.promptUntilSettled('hello'),
    /RegionError|中国区|opt-in|opt in/i
  );
  await runtime.stop();
});
