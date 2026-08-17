// WMB-5290 项目专项调查域合同测试（Node 契约层）。
//
// 派生执行 child（同 tests/content-version-project.test.mjs 模式）：
// 覆盖第一次审批门、提纲/方向不可变版本与 revision 冲突、记者工单精确绑定
// （项目 + 提纲版本 + 问题派生 claims + desk 父）、终态 EvidencePack 持久化与
// 来源关联、research_successor 抑制、第二次审批写手门（域函数 + JobSpawner
// 服务端门）、显式写手启动、supplement/expand/stop 分支与重启持久化。
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { buildInvestigationSupervisorReviewPrompt } from '../src/main/project-investigation.ts';

test('WMB-5290 project investigation contract: two-approval gate, immutable versions, reporter binding, writer gate, persistence', async () => {
  await promisify(execFile)(process.execPath, ['tests/wmb-5290-investigation-child.mjs'], { cwd: process.cwd() });
});

test('WMB-5304 reporter completion dispatches a bounded supervisor review prompt', () => {
  const projectId = 'project-review-contract';
  const prompt = buildInvestigationSupervisorReviewPrompt(projectId);
  assert.match(prompt, new RegExp(projectId));
  assert.match(prompt, /wmb_get_investigation/);
  assert.match(prompt, /wmb_review_investigation_research/);
  assert.match(prompt, /decision="accept"/);
  assert.match(prompt, /decision="defer"/);
  assert.match(prompt, /needs_user/);
  assert.match(prompt, /不得把项目留在 research_review/);
  assert.match(prompt, /direction_pending_approval/);
  assert.match(prompt, /按观点稿继续/);
  assert.match(prompt, /外部可验证事实/);
  assert.match(prompt, /不得自行验收通过/);
  assert.match(prompt, /不派写手/);
  assert.match(prompt, /不代替 Owner/);
  assert.match(prompt, /Owner.*第二次审批/);
  assert.match(prompt, /资料不足.*不得伪造方向/);
  assert.match(prompt, /不派写手/);
});
