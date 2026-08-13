import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { operatorSkillRevision } from '../src/main/pi-operator-skill.ts';
import { PI_AUTHORITY_SYSTEM_PROMPT } from '../src/main/pi-operator-skill.ts';

/**
 * WMB-5231 Query 写回真实激活聚焦测试（父进程）。
 * 覆盖：
 * 1. canonical operator Skill 登记完整 wmb_query_writeback 协议（字段/三分/冻结版本/
 *    restatement 零新知识/禁伪造）；
 * 2. 所有实际安装镜像与 canonical 字节一致，且 .wmb-install.json revision 与
 *    operatorSkillRevision() 相同（镜像 revision 已更新）；
 * 3. Pi 系统提示最小加固（真实读取后必须遵守 Skill 协议；无读取禁止伪造清单）；
 * 4. 子进程真实 settle 轮次（无清单/非法清单/restatement/new_synthesis/user_experience/
 *    幽灵版本/basedOn 越界/重放幂等/摘要投影）全部通过；
 * 5. 面板投影：无 Artifact 但有 settle 时显示未写回原因。
 * 退出码 0 = 全部通过；任何断言失败抛错并以非 0 退出。
 */

const skillPath = path.join('skills', 'wemedia-buddy-operator', 'SKILL.md');
const mirrorRoots = [
  path.join('data', 'ukcontentdata', 'pi-agent', 'skills', 'wemedia-buddy-operator'),
  path.join('data', 'gamedata', 'pi-agent', 'skills', 'wemedia-buddy-operator')
];

test('WMB-5231 canonical operator Skill registers the full wmb_query_writeback protocol', async () => {
  const skill = await readFile(skillPath, 'utf8');
  // 协议键：以普通文本登记（协议键非工具名，不进工具清单集合）
  assert.ok(skill.includes('wmb_query_writeback 清单'), '协议键必须登记（不带反引号，非工具名）');
  // 围栏协议：末条回复最后一个 ```json 围栏
  assert.match(skill, /末条回复必须以 ```json 围栏块携带 wmb_query_writeback 清单/);
  assert.match(skill, /回复中最后一个 JSON 围栏/);
  assert.match(skill, /WMB 会把该围栏从用户可见正文中剥离/);
  // 字段
  assert.match(skill, /readWikiVersionIds \/ readNoteVersionIds \/ readEvidenceIds/);
  assert.match(skill, /canonicalKey \/ statement \/ valueRationale/);
  assert.match(skill, /basedOnNoteVersionIds/);
  assert.match(skill, /experience\.body/);
  // 三分决策
  assert.match(skill, /restatement（纯复述）/);
  assert.match(skill, /new_synthesis（新综合）/);
  assert.match(skill, /user_experience（用户经验）/);
  // 固定版本要求：真实存在 + 回答本身不是证据 + basedOn ⊆ read
  assert.match(skill, /每个 id 必须在知识库中真实存在/);
  assert.match(skill, /回答本身不是证据/);
  assert.match(skill, /basedOnNoteVersionIds 必须 ⊆ readNoteVersionIds/);
  // restatement 零新知识规则
  assert.match(skill, /纯复述零 Note、零 Wiki、零 Evidence 写/);
  assert.match(skill, /只落 Artifact 与回执/);
  // 禁伪造：无读取禁止产出清单；失败不阻断回答
  assert.match(skill, /未真实读取任何冻结知识时禁止产出 wmb_query_writeback 清单/);
  assert.match(skill, /轮次回答不被阻断/);
});

test('WMB-5231 every installed operator Skill mirror matches canonical bytes and revision', async () => {
  const canonical = await readFile(skillPath, 'utf8');
  const canonicalRevision = await operatorSkillRevision();
  assert.ok(canonicalRevision.length === 64, 'canonical revision 是 sha256 hex');
  for (const mirror of mirrorRoots) {
    const mirrorSkill = await readFile(path.join(mirror, 'SKILL.md'), 'utf8');
    assert.equal(mirrorSkill, canonical, `${mirror}/SKILL.md 必须与 canonical 字节一致`);
    const install = JSON.parse(await readFile(path.join(mirror, '.wmb-install.json'), 'utf8'));
    assert.equal(install.name, 'wemedia-buddy-operator');
    assert.equal(install.revision, canonicalRevision, `${mirror} .wmb-install.json revision 必须等于 operatorSkillRevision()`);
    assert.ok(install.revision !== '40fa916dd8032babb4b082704ae5acf4750772e6bb20d854b4bd277c95952226', '镜像 revision 必须已更新（旧 revision 失效）');
  }
});

test('WMB-5231 Pi system prompt requires the protocol after real reads and forbids fabricated manifests', () => {
  assert.match(PI_AUTHORITY_SYSTEM_PROMPT, /仅在本轮通过知识工具真实读取冻结 Wiki\/Note\/Evidence 版本后/);
  assert.match(PI_AUTHORITY_SYSTEM_PROMPT, /```json \{"wmb_query_writeback": …\} ```/);
  assert.match(PI_AUTHORITY_SYSTEM_PROMPT, /restatement\/new_synthesis\/user_experience 三分决策/);
  assert.match(PI_AUTHORITY_SYSTEM_PROMPT, /纯复述必须声明 restatement，零新知识/);
  assert.match(PI_AUTHORITY_SYSTEM_PROMPT, /未真实读取任何知识时禁止伪造清单/);
  // 既有权威边界不回归
  assert.match(PI_AUTHORITY_SYSTEM_PROMPT, /禁止直接写文件或数据库/);
  assert.match(PI_AUTHORITY_SYSTEM_PROMPT, /禁止最终发布/);
});

test('WMB-5231 settle round: real Pi reply injection over real SQLite (child process)', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-5231-parent-'));
  try {
    await promisify(execFile)(process.execPath, ['tests/wmb-5231-query-writeback-activation-child.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, WMB_TEST_DIRECTORY: directory }
    });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('WMB-5231 panel projection shows readable un-written reason when settle exists but artifact is null', async () => {
  const transcript = await readFile(new URL('../src/renderer/pi-dock-transcript.tsx', import.meta.url), 'utf8');
  const block = transcript.slice(transcript.indexOf('const piKnowledgeSummaryCache'), transcript.indexOf('export function PiDockTranscript'));
  // 挂载门：无 artifact 且无 settle（重启后旧轮次）隐藏；有 settle 显示原因
  assert.match(block, /if \(!artifact && !settle\) return null;/);
  assert.match(block, /settle\?\.reason \?\? '本轮未产生知识写回。'/);
  assert.match(block, /pi-knowledge-settle-reason/);
  // settle 分支不引用回答正文/内部候选（面板不泄露协议块或 ChangeSet 细节）
  assert.doesNotMatch(block, /JSON\.stringify|answerSummary|segment\.input|segment\.output|toolCallId|message\.text|artifact\.question/);
  // 共享类型：摘要记录带 settle 字段
  const shared = await readFile(new URL('../src/shared/knowledge-flywheel.ts', import.meta.url), 'utf8');
  assert.match(shared, /KnowledgeQueryWritebackSettleRecord/);
  assert.match(shared, /settle: KnowledgeQueryWritebackSettleRecord \| null;/);
  // 写回服务：getQueryWritebackSummary 合并 settle（无 Artifact 时零写原因可见）
  const service = await readFile(new URL('../src/main/query-writeback.ts', import.meta.url), 'utf8');
  assert.match(service, /recordQueryWritebackSettleOutcome/);
  assert.match(service, /getQueryWritebackSettleOutcome/);
  assert.match(service, /settle: settle \?\? Object\.freeze/);
  // settle 钩子：六类区分（无清单/非法/运行时不可用/校验失败/派发失败/成功）
  const dock = await readFile(new URL('../src/main/ipc-pi-dock.ts', import.meta.url), 'utf8');
  assert.match(dock, /QUERY_WRITEBACK_MANIFEST_MISSING/);
  assert.match(dock, /QUERY_WRITEBACK_MANIFEST_INVALID/);
  assert.match(dock, /QUERY_WRITEBACK_RUNTIME_UNAVAILABLE/);
  assert.match(dock, /QUERY_WRITEBACK_DISPATCH_FAILED/);
  assert.match(dock, /recordQueryWritebackSettleOutcome\(requestId/);
});
