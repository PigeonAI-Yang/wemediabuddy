import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ROSTER_CONFLICT_WAIT_CODES, resolveDeskConflict } from '../src/renderer/agents-roster-conflict.ts';

function job(overrides = {}) {
  return { status: 'running', waitReason: null, ...overrides };
}

test('normal orchestration: desk running + employee running is NOT a conflict (WMB-5137)', () => {
  // 2026-08-09 11:41 daily_scan 正常编排：desk 主管占用（lease）+ reporter 扫描 running。
  const jobs = [
    job({ status: 'running', waitReason: null }),
    job({ status: 'queued', waitReason: null })
  ];
  assert.equal(resolveDeskConflict({ deskOccupied: true, deskStatus: 'running', jobs }), false);
});

test('desk blocked (needs_user / 权限 BLOCKED) stays a conflict', () => {
  assert.equal(resolveDeskConflict({ deskOccupied: true, deskStatus: 'blocked', jobs: [] }), true);
  assert.equal(resolveDeskConflict({ deskOccupied: true, deskStatus: 'blocked', jobs: [job({ status: 'running' })] }), true);
});

test('free desk is never a conflict even with blocked row or conflict-coded parks', () => {
  assert.equal(resolveDeskConflict({ deskOccupied: false, deskStatus: 'blocked', jobs: [] }), false);
  assert.equal(
    resolveDeskConflict({
      deskOccupied: false,
      deskStatus: 'running',
      jobs: [job({ status: 'waiting_resource', waitReason: 'RESOURCE_LOCK_CONFLICT: page_agents (held by job-9)' })]
    }),
    false
  );
});

test('real RESOURCE_LOCK_CONFLICT park shows conflict danger', () => {
  const jobs = [job({ status: 'waiting_resource', waitReason: 'RESOURCE_LOCK_CONFLICT: page_agents (held by job-9)' })];
  assert.equal(resolveDeskConflict({ deskOccupied: true, deskStatus: 'running', jobs }), true);
});

test('real RESOURCE_LEASE_BUSY park shows conflict danger', () => {
  const jobs = [job({ status: 'waiting_resource', waitReason: 'RESOURCE_LEASE_BUSY: 软上限 1 已达' })];
  assert.equal(resolveDeskConflict({ deskOccupied: true, deskStatus: 'running', jobs }), true);
});

test('orchestration waits (RESOURCE_JUDGE_IN_FLIGHT, plain queued) are NOT conflicts', () => {
  const jobs = [
    job({ status: 'waiting_resource', waitReason: 'RESOURCE_JUDGE_IN_FLIGHT: scan-judge 窗口' }),
    job({ status: 'queued', waitReason: null }),
    job({ status: 'running', waitReason: null })
  ];
  assert.equal(resolveDeskConflict({ deskOccupied: true, deskStatus: 'running', jobs }), false);
});

test('absent job list never fabricates a conflict', () => {
  assert.equal(resolveDeskConflict({ deskOccupied: true, deskStatus: 'running', jobs: null }), false);
  assert.equal(resolveDeskConflict({ deskOccupied: true, deskStatus: 'running', jobs: undefined }), false);
  assert.equal(resolveDeskConflict({ deskOccupied: true, deskStatus: 'running' }), false);
});

test('conflict codes are exactly RESOURCE_LOCK_CONFLICT and RESOURCE_LEASE_BUSY', () => {
  assert.deepEqual(ROSTER_CONFLICT_WAIT_CODES, ['RESOURCE_LOCK_CONFLICT', 'RESOURCE_LEASE_BUSY']);
});

test('roster view DOM gates: desk conflict callout + dot/word driven only by deskConflict (WMB-5137/5143)', async () => {
  const source = await readFile(new URL('../src/renderer/agents-roster-view.tsx', import.meta.url), 'utf8');
  const overview = await readFile(new URL('../src/renderer/agents-roster-overview.tsx', import.meta.url), 'utf8');

  // 冲突判定已委托纯函数（行为在 agents-roster-conflict.ts）。
  assert.match(source, /const deskConflict = resolveDeskConflict\(\{/);

  // DOM 断言：危险 callout 由 deskConflict 驱动（主视图）；主管状态点/词在概览组件（实例驱动视图不再有席位 DOM）。
  assert.match(
    source,
    /\{deskConflict \? \([\s\S]*?agents-callout danger seat-conflict/,
    'desk conflict danger callout must render only when deskConflict'
  );
  assert.match(
    overview,
    /<StatusDot status=\{deskOccupied \? \(deskConflict \? 'blocked' : 'running'\) : 'idle'}\s*\/>/,
    'desk state dot shows danger blocked only when deskConflict'
  );

  // 状态词文字同样以 deskConflict 优先：冲突（主管 blocked 或员工工单资源占用）→「受阻」，
  // 与红点/红字（status-blocked → var(--danger)）双编码一致，不再渲染红色「工作中」。
  assert.match(
    overview,
    /const deskState = deskOccupied \? \(deskConflict \? '受阻' : '工作中'\) : '当前无任务'/,
    'desk state word must read 受阻 when deskConflict'
  );
  assert.match(overview, /\{deskState\}/, 'desk state word span must render deskState');

  // 回归守卫：旧的错误判定（pool.running > 0 触发冲突）必须已删除。
  assert.doesNotMatch(source, /deskConflict = deskOccupied && \(deskRow\?\.status === 'blocked' \|\| pool\.running > 0\)/);
});

test('roster view DOM gates: WMB-5143 instance-driven view has no seat/slot terminology', async () => {
  const source = await readFile(new URL('../src/renderer/agents-roster-view.tsx', import.meta.url), 'utf8');
  const instances = await readFile(new URL('../src/renderer/agents-roster-instances.tsx', import.meta.url), 'utf8');
  const overview = await readFile(new URL('../src/renderer/agents-roster-overview.tsx', import.meta.url), 'utf8');
  const parts = await readFile(new URL('../src/renderer/agents-roster-parts.tsx', import.meta.url), 'utf8');
  const all = source + instances + overview + parts;

  // 槽位/坐席/待命语义必须整体消失（EVAL-CAP-027.4/.5：不预设空槽、无虚构待命）。
  for (const term of ['待命', '槽位', '坐席', 'agents-seat', 'agents-slot', 'slot-pill', 'seat-strip', 'seat-cell']) {
    assert.doesNotMatch(all, new RegExp(term), `view must not contain ${term}`);
  }

  // 五角色分组始终可见 + 空角色「当前无任务」。
  assert.match(source, /const ORDER: RoleId\[\] = \['desk', 'reporter', 'planner', 'writer', 'librarian'\]/);
  assert.match(instances, /className="agents-role-group"/);
  assert.match(overview, />当前无任务</);
  assert.match(instances, /data-role=\{roleId\}/);

  // 投影驱动：只从投影 API 读取，UI 单源（§12.2.6）。
  assert.match(source, /getCrewInstanceProjection/);
  assert.match(source, /getAgentsRoster/);
});

test('roster view DOM gates: desk card head uses roster projection labels with ROLE_CATALOG.desk fallback (WMB-5184)', async () => {
  const source = await readFile(new URL('../src/renderer/agents-roster-view.tsx', import.meta.url), 'utf8');
  const overview = await readFile(new URL('../src/renderer/agents-roster-overview.tsx', import.meta.url), 'utf8');
  const parts = await readFile(new URL('../src/renderer/agents-roster-parts.tsx', import.meta.url), 'utf8');

  // 主管卡头标签只来自 roster 投影行（labelZh/roomZh）；缺数据回落到 ROLE_CATALOG.desk（主管/主编席），
  // 不得重建「桌助/协调入口」展示覆盖（2026-08-10 主管授权翻转：不留用户可见兼容别名）。
  assert.match(
    overview,
    /roleId === 'desk' \? \{ labelZh: deskRow\?\.labelZh \?\? ROLE_CATALOG\.desk\.labelZh, roomZh: deskRow\?\.roomZh \?\? ROLE_CATALOG\.desk\.roomZh \} : ROLE_CATALOG\[roleId\]/,
    'desk card head must resolve labelZh/roomZh from the roster row, falling back to ROLE_CATALOG.desk'
  );

  // 用户可见文案：视图 desk 行 = 主管/主编席；「桌助/协调入口」别名整体消失。
  assert.match(overview, /ROLE_CATALOG\.desk\.labelZh/);
  assert.doesNotMatch(source + overview + parts, /桌助|协调入口/, 'view must not carry the 桌助/协调入口 alias');

  // 员工角色卡头仍走 ROLE_CATALOG（纯展示，注册表零改动）。
  assert.match(overview, /: ROLE_CATALOG\[roleId\]/, 'employee heads must keep ROLE_CATALOG labels');

  // 头像裁剪对话框的 desk 标签同样走投影行，回落到 ROLE_CATALOG.desk（主管）。
  assert.match(
    source,
    /roleLabel=\{cropRole === 'desk' \? \(deskRow\?\.labelZh \?\? ROLE_CATALOG\.desk\.labelZh\) : ROLE_CATALOG\[cropRole\]\.labelZh\}/,
    'desk avatar crop dialog label must fall back to ROLE_CATALOG.desk'
  );
});
