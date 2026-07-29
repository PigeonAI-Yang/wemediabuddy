import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

test('Pi uses exact package receipt and suggestions require individual user decisions',async()=>{
  await promisify(execFile)(process.execPath,['tests/knowledge-pi-package-child.mjs'],{cwd:process.cwd()});
});
