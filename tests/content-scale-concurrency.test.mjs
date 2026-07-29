import { execFile } from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

test('1001 projects page with fixed query counts and reject stale core-version writes', async () => {
  const directory=await mkdtemp(path.join(os.tmpdir(),'wmb-content-scale-'));
  try{await promisify(execFile)(process.execPath, ['tests/content-scale-concurrency-child.mjs'], {
    cwd: process.cwd(),maxBuffer:1024*1024,env:{...process.env,WMB_TEST_DIRECTORY:directory}
  });}finally{await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
});
