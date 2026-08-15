import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

// WMB-5243：全局 Wiki 知识网络只读投影验收（真实 SQLite 子进程；聚焦行为测试，主代理统一运行）。
test('global wiki knowledge network: three node types, formal relations, ontology detail, deduped frozen selection, old canvas compat', async () => {
  await promisify(execFile)(process.execPath, ['tests/wmb-5243-knowledge-network-child.mjs'], { cwd: process.cwd() });
});
