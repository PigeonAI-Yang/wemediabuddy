import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

test('context packages preview exact exclusions, version, archive and block oversize input',async()=>{
  await promisify(execFile)(process.execPath,['tests/knowledge-package-management-child.mjs'],{cwd:process.cwd()});
});
