import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import test from 'node:test';

test('direct brief traces through project, publication, metric and review, then returns only after confirmation',async()=>{
  await promisify(execFile)(process.execPath,['tests/knowledge-lineage-child.mjs'],{cwd:process.cwd()});
});
