import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

test('domain map persists bounded real topic membership and rejects stale writes',async()=>{
  await promisify(execFile)(process.execPath,['tests/knowledge-domain-child.mjs'],{cwd:process.cwd()});
});
