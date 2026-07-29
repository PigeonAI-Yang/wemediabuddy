import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

test('topic dossier pages every asset category and places live references on canvas',async()=>{
  await promisify(execFile)(process.execPath,['tests/knowledge-dossier-child.mjs'],{cwd:process.cwd()});
});
