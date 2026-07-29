import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

test('creative brief stays editable, direct, idempotent and cannot escape its page context',async()=>{
  await promisify(execFile)(process.execPath,['tests/knowledge-creative-brief-child.mjs'],{cwd:process.cwd()});
});
