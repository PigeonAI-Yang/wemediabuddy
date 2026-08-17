// 智能体 (Agents roster) surface Electron E2E scenarios (WMB-5243).
//
// Journeys implemented: AG-001..AG-007 (see tests/e2e/user-journeys.json).
// Real Electron + isolated workspace fixture; assertions on user-visible DOM /
// navigation / real IPC; SQLite used for dual readback only. No external
// network: where a scenario must exercise job spawning, the Pi config is
// rewritten to a local unreachable endpoint (ECONNREFUSED, zero egress), so
// spawned jobs fail fast and locally without ever calling a real API.

import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { helpers } from './harness.mjs';
import {
  NOW, shanghaiPlanDate, openDb,
  seedAgentTask, writeLocalPiConfig
} from './lib/seed.mjs';

const { waitForAppReady, navigateTo, VIEW_TITLES, delay } = helpers;

const planDate = shanghaiPlanDate();
const RUNTIME_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '.runtime');

// 最小 PNG 编码器（E2E 专用夹具：纯色方块图，验证裁切画布像素）。
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  let crc = 0xffffffff;
  const body = Buffer.concat([typeBuf, data]);
  for (let i = 0; i < body.length; i += 1) {
    crc ^= body[i];
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function solidPng(size, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // 8-bit RGB
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y += 1) {
    const row = y * (1 + size * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const o = row + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/** 主管 dock 会话（legacy conversation.json 迁移路径）：遗留任务弹窗的实时运行记录来源。 */
function writeLegacyDockConversation(dataRoot) {
  const agentDir = path.join(dataRoot, 'pi-agent');
  mkdirSync(agentDir, { recursive: true });
  const now = NOW();
  writeFileSync(path.join(agentDir, 'conversation.json'), JSON.stringify({
    id: 'e2e-dock-conv',
    title: 'E2E 主管会话',
    sessionFile: path.join(agentDir, 'sessions', 'e2e-dock.jsonl'),
    sessionId: null,
    messages: [
      { role: 'user', text: '今日扫描：X 列表与社区信号', createdAt: now },
      { role: 'assistant', text: '已开始扫描，当前进度 1/4 渠道。', status: 'stopped', createdAt: now },
      ...Array.from({ length: 18 }, (_, index) => ({
        role: 'assistant',
        text: `扫描运行记录 ${index + 1}/18：正在核验渠道证据与来源状态。`,
        status: 'stopped',
        createdAt: new Date(Date.parse(now) + (index + 1) * 1_000).toISOString()
      }))
    ],
    createdAt: now,
    updatedAt: now
  }, null, 2), 'utf8');
}

/** 本地黑洞服务器：接受连接但永不响应 → 任务停留在 running（取消窗口可测），零外网。 */
function startHangingServer() {
  return new Promise((resolve) => {
    const server = createServer(() => { /* 故意不 res.end()：请求悬挂 */ });
    server.on('error', () => {});
    // 黑洞连接会悬挂到请求方超时/进程被杀；跟踪 socket，收尾时强关，
    // 否则 server.close 会永久等待残留连接（取消时 Pi CLI 强停 ≤2s 竞态下进程可能存活）。
    const sockets = new Set();
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1', () => resolve({
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      close: () => new Promise((r) => {
        server.closeAllConnections?.();
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.close(() => r());
        // 兜底：即使仍有残留连接，场景收尾也不永久阻塞。
        const timer = setTimeout(() => r(), 2_000);
        if (typeof timer.unref === 'function') timer.unref();
      })
    }));
  });
}
let ag004Server = null;

/** History: reporter succeeded / planner failed / writer succeeded (persistent face). */
function seedHistoryFixture({ localPi = false, piBaseUrl = null } = {}) {
  return async ({ dataRoot, userDataDir }) => {
    if (localPi) {
      if (piBaseUrl) {
        // 真实可解密 key + 本地黑洞端点：续派工单真正进入 running（而非配置解密失败被泊入等你批）。
        writePiConfigFile(userDataDir, { baseUrl: piBaseUrl, encryptedApiKey: await encryptedPiKey() });
      } else {
        writeLocalPiConfig(userDataDir);
      }
    }
    const db = openDb(dataRoot);
    try {
      seedAgentTask(db, { jobId: 'job-e2e-reporter-1', roleId: 'reporter', intent: 'research', status: 'succeeded', phase: 'done', brief: 'E2E 记者历史工单', businessDate: planDate });
      seedAgentTask(db, { jobId: 'job-e2e-planner-1', roleId: 'planner', intent: 'research', status: 'failed', phase: 'failed', brief: 'E2E 策划失败工单', businessDate: planDate, errorCode: 'E2E_FAIL', errorMessage: 'E2E 模拟失败原因' });
      seedAgentTask(db, { jobId: 'job-e2e-writer-1', roleId: 'writer', intent: 'research', status: 'succeeded', phase: 'done', brief: 'E2E 写作历史工单', businessDate: planDate });
    } finally {
      db.close();
    }
  };
}

async function healthCheck(page, evidence, assert, step) {
  await step('健康: 无页面异常 / 无崩溃', async () => {
    assert(!evidence.crashed, '渲染进程崩溃');
    assert(evidence.pageerrors.length === 0, `页面异常 ${evidence.pageerrors.length} 条: ${evidence.pageerrors[0]?.message ?? ''}`);
  });
}

/** Open every history <details> so its rows are visible/clickable. */
async function openHistorySections(page) {
  const details = page.locator('.agents-role-history');
  const n = await details.count();
  for (let i = 0; i < n; i += 1) {
    const one = details.nth(i);
    if ((await one.getAttribute('open')) === null) {
      await one.locator('summary').click();
    }
  }
}

export default [
  {
    id: 'AG-001-agents-roster-normal',
    journeyIds: ['AG-001-agents-roster-normal'],
    launch: {
      seedFixture: async ({ dataRoot }) => {
        const db = openDb(dataRoot);
        try {
          // Persistent needs_user card (等你批) for the reporter + 3 terminal history rows.
          seedAgentTask(db, { jobId: 'job-e2e-reporter-needs', roleId: 'reporter', intent: 'research', status: 'needs_user', phase: 'waiting_human', brief: 'E2E 记者待批工单', businessDate: planDate, errorMessage: 'E2E 等你批：需补齐配置' });
          seedAgentTask(db, { jobId: 'job-e2e-reporter-1', roleId: 'reporter', intent: 'research', status: 'succeeded', phase: 'done', brief: 'E2E 记者历史工单', businessDate: planDate });
          seedAgentTask(db, { jobId: 'job-e2e-planner-1', roleId: 'planner', intent: 'research', status: 'failed', phase: 'failed', brief: 'E2E 策划失败工单', businessDate: planDate, errorCode: 'E2E_FAIL', errorMessage: 'E2E 模拟失败原因' });
          seedAgentTask(db, { jobId: 'job-e2e-writer-1', roleId: 'writer', intent: 'research', status: 'succeeded', phase: 'done', brief: 'E2E 写作历史工单', businessDate: planDate });
        } finally {
          db.close();
        }
      }
    },
    run: async ({ page, evidence, assert, step }) => {
      await step('启动进入主壳并打开智能体页', async () => {
        await waitForAppReady(page, { shell: '.app-shell', timeoutMs: 90_000 });
        await navigateTo(page, 'agents');
        await page.locator('section.agents-roster').waitFor({ state: 'visible', timeout: 20_000 });
      });
      await step('五角色概览卡始终可见', async () => {
        const cards = page.locator('.agents-role-card');
        await cards.first().waitFor({ state: 'visible', timeout: 20_000 });
        assert(await cards.count() === 5, `角色卡应为 5 张，实际 ${await cards.count()}`);
        for (const role of ['desk', 'reporter', 'planner', 'writer', 'librarian']) {
          assert(await page.locator(`.agents-role-card[data-role="${role}"]`).count() === 1, `缺少角色卡 ${role}`);
        }
      });
      await step('活动实例卡显示状态词与任务摘要 (等你批)', async () => {
        const card = page.locator('.agents-role-group[data-role="reporter"] .agents-instance-card.status-needs_user');
        await card.waitFor({ state: 'visible', timeout: 20_000 });
        const word = await card.locator('.agents-job-status-word').textContent();
        assert((word ?? '').includes('等你批'), `needs_user 实例状态词异常: ${word}`);
        assert(((await card.locator('.agents-instance-brief').textContent()) ?? '').includes('待批工单'), '实例卡任务摘要缺失');
      });
      await step('历史任务区按角色渲染终态工单', async () => {
        await page.waitForFunction(() => document.querySelectorAll('.agents-role-history').length >= 3, null, { timeout: 20_000 });
        await openHistorySections(page);
        const failed = page.locator('.agents-history-row.status-failed');
        await failed.first().waitFor({ state: 'visible', timeout: 10_000 });
        assert(((await failed.first().textContent()) ?? '').includes('E2E 策划失败工单'), '历史失败工单缺失');
      });
      await healthCheck(page, evidence, assert, step);
      return { roles: 5, active: 1, history: 3, pageerrors: evidence.pageerrors.length };
    }
  },
  {
    id: 'AG-002-agents-detail-modal',
    journeyIds: ['AG-002-agents-detail-modal'],
    launch: {
      seedFixture: async ({ dataRoot }) => {
        const db = openDb(dataRoot);
        try {
          seedAgentTask(db, { jobId: 'job-e2e-reporter-needs', roleId: 'reporter', intent: 'research', status: 'needs_user', phase: 'waiting_human', brief: 'E2E 弹窗待批工单', businessDate: planDate, errorMessage: 'E2E 等你批：需补齐配置' });
        } finally {
          db.close();
        }
      }
    },
    run: async ({ page, evidence, assert, step }) => {
      await step('启动进入主壳并打开智能体页', async () => {
        await waitForAppReady(page, { shell: '.app-shell', timeoutMs: 90_000 });
        await navigateTo(page, 'agents');
        await page.locator('.agents-role-card[data-role="reporter"]').waitFor({ state: 'visible', timeout: 20_000 });
      });
      await step('点击角色卡打开运行明细弹窗', async () => {
        await page.locator('.agents-role-card[data-role="reporter"]').click();
        const modal = page.locator('[data-testid="agents-detail-modal"]');
        await modal.waitFor({ state: 'visible', timeout: 15_000 });
        const jobId = await modal.locator('.agents-detail-jobid').textContent();
        assert((jobId ?? '').trim() === 'job-e2e-reporter-needs', `弹窗任务编号不符: ${jobId}`);
        assert(((await modal.textContent()) ?? '').includes('等你批'), '弹窗未显示等你批提示');
        assert(((await modal.textContent()) ?? '').includes('E2E 弹窗待批工单'), '弹窗未显示任务摘要');
        assert(await modal.locator('.agents-detail-section[aria-label="运行记录"]').count() === 1, '实例任务也应只有一个运行记录区域');
        assert(await modal.locator('.agents-detail-section[aria-label="任务事件"]').count() === 0, '实例任务不应保留重复的任务事件区域');
      });
      await step('关闭弹窗后页面恢复正常且焦点回到触发卡', async () => {
        await page.locator('[data-testid="agents-detail-modal"] .app-modal-close').click();
        await page.waitForFunction(() => document.querySelectorAll('[data-testid="agents-detail-modal"]').length === 0, null, { timeout: 10_000 });
        assert(await page.locator('.agents-role-card').count() === 5, '关闭弹窗后角色卡应仍可见');
        const focusInfo = await page.evaluate(() => {
          const active = document.activeElement;
          return active ? { role: active.getAttribute('data-role'), className: active.className } : null;
        });
        assert(focusInfo?.role === 'reporter', `关闭弹窗后焦点应回到触发角色卡, 实际: ${JSON.stringify(focusInfo)}`);
      });
      await healthCheck(page, evidence, assert, step);
      return { modal: true, pageerrors: evidence.pageerrors.length };
    }
  },
  {
    id: 'AG-003-agents-redispatch-history',
    journeyIds: ['AG-003-agents-redispatch-history'],
    launch: { seedFixture: seedHistoryFixture({ localPi: true }) },
    run: async ({ page, evidence, assert, step }) => {
      await step('启动进入主壳并打开智能体页', async () => {
        await waitForAppReady(page, { shell: '.app-shell', timeoutMs: 90_000 });
        await navigateTo(page, 'agents');
        await page.locator('.agents-role-history').first().waitFor({ state: 'visible', timeout: 20_000 });
      });
      await step('历史工单一键续派: 真实 jobsSpawn 返回已续派消息', async () => {
        await openHistorySections(page);
        const before = await page.locator('.agents-history-row').count();
        const redispatch = page.locator('.agents-history-actions .agents-row-action.strong').first();
        await redispatch.waitFor({ state: 'visible', timeout: 10_000 });
        await redispatch.click();
        await page.waitForFunction(() => (document.querySelector('.agents-jobs-msg')?.textContent ?? '').includes('已续派'), null, { timeout: 15_000 });
        const msg = ((await page.locator('.agents-jobs-msg').textContent()) ?? '').replace(/\s+/g, ' ');
        assert(msg.includes('已续派') && !msg.includes('失败'), `续派消息异常: ${msg}`);
        // 本地 ECONNREFUSED 让工单快速落终态 -> 持久面历史新增一条（活动区或历史区出现新实例）。
        await page.waitForFunction(
          (n) => document.querySelectorAll('.agents-history-row').length > n || document.querySelectorAll('.agents-instance-card').length > 0,
          before,
          { timeout: 30_000 }
        );
      });
      await healthCheck(page, evidence, assert, step);
      return { redispatch: true, pageerrors: evidence.pageerrors.length };
    }
  },
  {
    id: 'AG-004-agents-cancel-active',
    journeyIds: ['AG-004-agents-cancel-active'],
    launch: {
      // 黑洞服务器提供悬挂端点；Pi 配置由应用自身经 savePiConfig 写入
      // （safeStorage 同进程上下文加密，续派工单才能真实解密 → 判断任务挂在 Pi 上保持 running）。
      seedFixture: async (ctx) => {
        ag004Server = await startHangingServer();
        await seedHistoryFixture({ localPi: true })(ctx);
      }
    },
    run: async ({ page, evidence, assert, step, openDb }) => {
      try {
        await step('启动进入主壳并打开智能体页', async () => {
          await waitForAppReady(page, { shell: '.app-shell', timeoutMs: 90_000 });
          await navigateTo(page, 'agents');
          await page.locator('.agents-role-history').first().waitFor({ state: 'visible', timeout: 20_000 });
        });
        await step('应用内写入真实 Pi 配置（同上下文加密，续派工单可真实解密）', async () => {
          const saved = await page.evaluate((baseUrl) => window.wmb.savePiConfig({
            name: 'E2E 黑洞配置',
            baseUrl,
            model: 'gpt-5.4',
            api: 'openai-responses',
            thinking: 'medium',
            apiKey: 'e2e-placeholder-key-do-not-use'
          }), ag004Server.baseUrl);
          assert(Boolean(saved) && !saved?.error, `保存 Pi 配置失败: ${JSON.stringify(saved)}`);
        });
        await step('续派产生活动实例并等待稳定运行态后取消', async () => {
          await openHistorySections(page);
          // 续派策划历史工单：judge 策略在 Pi 判断阶段悬挂于本地黑洞端点 → 实例保持 running（可取消）。
          // 历史折叠区是独立 details（不在 .agents-role-group 内），按 summary 文案定位策划区。
          const plannerHistory = page.locator('details.agents-role-history').filter({ hasText: '策划' }).first();
          await plannerHistory.locator('.agents-row-action.strong').click();
          await page.waitForFunction(() => (document.querySelector('.agents-jobs-msg')?.textContent ?? '').includes('已续派'), null, { timeout: 15_000 });
          // 稳定业务状态（DOM detach 竞态修复）：实例以 running 进入活动区且状态词为工作中/研究中，
          // 取消按钮 attached；再跨完整渲染轮询（渲染器每 3s 刷新投影）确认持续 running——
          // 点击窗口内不被终态替换/卸载（此前 job 快速落终态时按钮在点击瞬间被 detach）。
          const runningCard = page.locator('.agents-instance-card.status-running');
          await runningCard.first().waitFor({ state: 'visible', timeout: 15_000 });
          const word = await runningCard.first().locator('.agents-job-status-word').textContent();
          assert(['工作中', '研究中'].some((w) => (word ?? '').includes(w)), `续派实例状态词异常: ${word}`);
          await page.waitForFunction(() => {
            const buttons = document.querySelectorAll('.agents-instance-card.status-running .agents-row-action');
            return [...buttons].some((b) => (b.textContent ?? '').includes('取消'));
          }, null, { timeout: 10_000 });
          await delay(3_500);
          assert(await page.locator('.agents-instance-card.status-running').count() > 0, '运行中实例未稳定保持（取消窗口丢失）');
          const cancel = page.locator('.agents-instance-card.status-running .agents-row-action', { hasText: '取消' }).first();
          await cancel.waitFor({ state: 'visible', timeout: 10_000 });
          await cancel.click();
          await page.waitForFunction(() => (document.querySelector('.agents-jobs-msg')?.textContent ?? '').includes('已取消'), null, { timeout: 15_000 });
          const msg = ((await page.locator('.agents-jobs-msg').textContent()) ?? '').replace(/\s+/g, ' ');
          assert(msg.includes('已取消'), `取消消息异常: ${msg}`);
        });
        await step('取消后活动实例离开活动区且持久面落终态', async () => {
          await page.waitForFunction(() => document.querySelectorAll('.agents-instance-card').length === 0, null, { timeout: 20_000 });
          // 真实取消终态（用户可见）：策划历史新增「已取消」终态行（持久面投影，jobId 锚点可追）。
          await page.waitForFunction(() => {
            const rows = [...document.querySelectorAll('.agents-history-row')];
            return rows.some((r) => (r.textContent ?? '').includes('已取消') && (r.textContent ?? '').includes('E2E 策划失败工单'));
          }, null, { timeout: 20_000 });
          // 双读回：agent_tasks 持久面落 cancelled 终态（同 brief 唯一命中本次取消的任务）。
          const { db, close } = openDb();
          try {
            const row = db.prepare(
              "SELECT id, status FROM agent_tasks WHERE status = 'cancelled' AND context_refs_json LIKE '%E2E 策划失败工单%' ORDER BY created_at DESC LIMIT 1"
            ).get();
            assert(Boolean(row), 'agent_tasks 持久面未落 cancelled 终态');
          } finally {
            close();
          }
        });
        await healthCheck(page, evidence, assert, step);
        return { cancel: true, pageerrors: evidence.pageerrors.length };
      } finally {
        if (ag004Server) { await ag004Server.close().catch(() => {}); ag004Server = null; }
      }
    }
  },
  {
    id: 'AG-005-agents-empty',
    journeyIds: ['AG-005-agents-empty'],
    run: async ({ page, evidence, assert, step }) => {
      await step('空工作空间打开智能体页', async () => {
        await waitForAppReady(page, { shell: '.app-shell', timeoutMs: 90_000 });
        await navigateTo(page, 'agents');
        await page.locator('section.agents-roster').waitFor({ state: 'visible', timeout: 20_000 });
      });
      await step('五角色空态: 当前无任务 + 无进行中任务', async () => {
        const cards = page.locator('.agents-role-card');
        await cards.first().waitFor({ state: 'visible', timeout: 20_000 });
        assert(await cards.count() === 5, `角色卡应为 5 张，实际 ${await cards.count()}`);
        const words = await page.locator('.agents-role-card .agents-status-word').allTextContents();
        assert(words.every((w) => w.includes('当前无任务')), `空角色状态词异常: ${words.join(' | ')}`);
        const empty = page.locator('.agents-filter-empty');
        await empty.waitFor({ state: 'visible', timeout: 15_000 });
        assert(((await empty.textContent()) ?? '').includes('当前无进行中的任务'), '活动区空态文案异常');
      });
      await healthCheck(page, evidence, assert, step);
      return { empty: true, pageerrors: evidence.pageerrors.length };
    }
  },
  {
    id: 'AG-006-agents-desk-conflict-error',
    journeyIds: ['AG-006-agents-desk-conflict-error'],
    launch: {
      seedFixture: async ({ dataRoot }) => {
        const db = openDb(dataRoot);
        try {
          // Desk blocked (needs_user daily task) -> deskOccupied + deskStatus blocked -> conflict banner.
          seedAgentTask(db, {
            intent: 'daily_intelligence', status: 'needs_user', phase: 'waiting_human',
            businessDate: planDate, roleId: 'desk', brief: 'E2E 主管受阻任务',
            errorMessage: 'E2E 主管席受阻'
          });
        } finally {
          db.close();
        }
      }
    },
    run: async ({ page, evidence, assert, step }) => {
      await step('启动进入主壳并打开智能体页', async () => {
        await waitForAppReady(page, { shell: '.app-shell', timeoutMs: 90_000 });
        await navigateTo(page, 'agents');
        await page.locator('section.agents-roster').waitFor({ state: 'visible', timeout: 20_000 });
      });
      await step('主管受阻时显示 role=alert 冲突横幅', async () => {
        const banner = page.locator('.agents-callout.danger.seat-conflict[role="alert"]');
        await banner.waitFor({ state: 'visible', timeout: 20_000 });
        assert(((await banner.textContent()) ?? '').includes('主管受阻'), '冲突横幅文案异常');
      });
      await step('冲突时其余角色区仍可查看', async () => {
        assert(await page.locator('.agents-role-card').count() === 5, '冲突时角色卡应仍渲染');
        await page.locator('.agents-role-card[data-role="reporter"]').waitFor({ state: 'visible', timeout: 10_000 });
      });
      await healthCheck(page, evidence, assert, step);
      return { conflict: true, pageerrors: evidence.pageerrors.length };
    }
  },
  {
    id: 'AG-007-agents-permission-redispatch-error',
    journeyIds: ['AG-007-agents-permission-redispatch-error'],
    launch: { seedFixture: seedHistoryFixture({ localPi: false }) },
    run: async ({ page, evidence, assert, step }) => {
      await step('启动进入主壳并打开智能体页', async () => {
        await waitForAppReady(page, { shell: '.app-shell', timeoutMs: 90_000 });
        await navigateTo(page, 'agents');
        await page.locator('.agents-role-history').first().waitFor({ state: 'visible', timeout: 20_000 });
      });
      await step('关闭员工派出后续派失败并如实报错', async () => {
        await openHistorySections(page);
        // Real IPC: disable job spawning (authority boundary — maxWorkers=0).
        await page.evaluate(() => window.wmb.jobsSetMaxWorkers(0));
        await page.locator('.agents-history-actions .agents-row-action.strong').first().click();
        await page.waitForFunction(() => Boolean(document.querySelector('.agents-jobs-msg')?.textContent), null, { timeout: 15_000 });
        const msg = ((await page.locator('.agents-jobs-msg').textContent()) ?? '').replace(/\s+/g, ' ');
        assert(msg.includes('员工派出已关闭') || msg.includes('JOB_SPAWN_DISABLED'), `应显示派工被关闭错误: ${msg}`);
        assert(!msg.includes('已续派'), '不得误报续派成功');
      });
      await step('错误后界面保持可用', async () => {
        assert(await page.locator('.agents-role-card').count() === 5, '报错后角色卡应仍可见');
        await page.locator('.agents-role-history').first().waitFor({ state: 'visible', timeout: 10_000 });
      });
      await healthCheck(page, evidence, assert, step);
      return { errorShown: true, pageerrors: evidence.pageerrors.length };
    }
  },
  {
    // WMB-5273：遗留 Pi 任务（daily 编排不经 JobPool）在角色卡显示工作中、投影无实例的
    // mismatch —— 弹窗必须渲染同一 roster 行的真实任务（task/events/progress/运行记录）并
    // 经轮询实时更新；大号头像控件 = 唯一头像入口，裁切画布预载当前头像像素，保存后弹窗
    // 立即恢复并同步新头像。
    id: 'AG-008-agents-legacy-task-avatar',
    journeyIds: ['AG-008-agents-legacy-task-avatar'],
    launch: {
      seedFixture: async ({ dataRoot }) => {
        const db = openDb(dataRoot);
        try {
          // 遗留 running 任务：roster 行 running（工作中），但 JobPool 投影无实例（mismatch 前提）。
          seedAgentTask(db, {
            id: 'task-e2e-legacy-scan',
            intent: 'daily_scan',
            status: 'running',
            phase: 'scanning',
            businessDate: planDate,
            roleId: 'reporter',
            brief: 'E2E 每日扫描',
            progress: { planned: 4, processed: 1, currentSource: 'X 列表', message: '已扫描 1/4 渠道' },
            events: [
              { at: NOW(), message: 'E2E 每日扫描启动，读取渠道清单' },
              { at: NOW(), message: 'E2E 正在扫描 X 列表渠道' }
            ]
          });
        } finally {
          db.close();
        }
        writeLegacyDockConversation(dataRoot);
      }
    },
    run: async ({ app, page, evidence, artifactsDir, assert, step, workspace }) => {
      let blueAvatar = null;
      await step('启动进入主壳并打开智能体页', async () => {
        await waitForAppReady(page, { shell: '.app-shell', timeoutMs: 90_000 });
        await navigateTo(page, 'agents');
        await page.locator('section.agents-roster').waitFor({ state: 'visible', timeout: 20_000 });
      });
      await step('角色卡显示遗留 Pi 任务工作中（投影无实例）', async () => {
        const card = page.locator('.agents-role-card[data-role="reporter"]');
        await card.waitFor({ state: 'visible', timeout: 20_000 });
        await page.waitForFunction(() => {
          const cardEl = document.querySelector('.agents-role-card[data-role="reporter"]');
          return (cardEl?.querySelector('.agents-status-word')?.textContent ?? '').includes('工作中');
        }, null, { timeout: 15_000 });
        const word = await card.locator('.agents-status-word').textContent();
        assert((word ?? '').includes('工作中'), `遗留任务卡状态词异常: ${word}`);
        const pct = await card.locator('.agents-card-pct').textContent();
        assert((pct ?? '').includes('25%'), `遗留任务卡进度异常: ${pct}`);
        const summary = await card.locator('.agents-card-summary').textContent();
        assert((summary ?? '').includes('E2E 正在扫描 X 列表渠道'), `卡片摘要异常: ${summary}`);
        assert(await page.locator('.agents-instance-card').count() === 0, '投影活动实例区应为空（mismatch 前提）');
      });
      await step('点击角色卡打开弹窗：真实任务明细而非空态', async () => {
        await page.locator('.agents-role-card[data-role="reporter"]').click();
        const modal = page.locator('[data-testid="agents-detail-modal"]');
        await modal.waitFor({ state: 'visible', timeout: 15_000 });
        // 等待真实任务加载完成（taskId 出现）再断言，避免初始空态与异步加载的竞态。
        await page.waitForFunction((expectedDate) => {
          const el = document.querySelector('[data-testid="agents-detail-modal"]');
          const textContent = el?.textContent ?? '';
          return textContent.includes('task-e2e-legacy-scan') && textContent.includes(expectedDate);
        }, planDate, { timeout: 15_000 });
        const text = (await modal.textContent()) ?? '';
        const topLevelEmpty = await modal.locator('.agents-detail-body > .agents-detail-empty').count();
        assert(topLevelEmpty === 0, `遗留活动行不应落入整窗空态，实际 ${topLevelEmpty} 个`);
        assert(!text.includes('设置头像'), '显式设置头像按钮应已移除');
        assert(await modal.locator('.eyebrow').count() === 0, '弹窗不应再渲染眉标');
        assert(text.includes('工作中'), '弹窗应显示工作中');
        assert(text.includes('task-e2e-legacy-scan'), '弹窗应显示真实任务标识');
        assert(text.includes('daily_scan'), '弹窗应显示真实意图');
        assert(text.includes(planDate), '弹窗应显示业务日');
        assert(text.includes('E2E 每日扫描启动，读取渠道清单'), '任务状态内容缺失');
        assert(text.includes('已开始扫描，当前进度 1/4 渠道。'), 'Pi 会话运行记录缺失');
        assert(await modal.locator('.agents-detail-section[aria-label="运行记录"]').count() === 1, '任务状态与 Pi 会话应合并为单一运行记录区域');
        assert(await modal.locator('.agents-detail-section[aria-label="任务事件"]').count() === 0, '不应保留重复的任务事件区域');
        const events = modal.locator('.agents-detail-run-log .task-event');
        assert(await events.count() >= 2, `运行记录内任务状态应为 2 条，实际 ${await events.count()}`);
        const logGeometry = await modal.locator('.agents-detail-run-log').evaluate((node) => ({
          clientHeight: node.clientHeight,
          scrollHeight: node.scrollHeight,
          distanceFromBottom: node.scrollHeight - node.clientHeight - node.scrollTop
        }));
        assert(logGeometry.scrollHeight > logGeometry.clientHeight, `运行记录应限制高度并内部滚动: ${JSON.stringify(logGeometry)}`);
        assert(logGeometry.distanceFromBottom <= 2, `运行记录初始应跟随最新条目: ${JSON.stringify(logGeometry)}`);
        const pct = await modal.locator('.agents-detail-pct').textContent();
        assert((pct ?? '').includes('25%'), `弹窗进度异常: ${pct}`);
      });
      await step('运行记录实时更新：上滚时保留阅读位置，回到底部后恢复追尾', async () => {
        const runLog = page.locator('[data-testid="agents-detail-modal"] .agents-detail-run-log');
        await runLog.evaluate((node) => {
          node.scrollTop = 0;
          node.dispatchEvent(new Event('scroll'));
        });
        const db = openDb(workspace.dataRoot);
        try {
          db.prepare(
            `UPDATE agent_tasks SET events_json = ?, progress_json = ?, updated_at = ? WHERE id = 'task-e2e-legacy-scan'`
          ).run(
            JSON.stringify([
              { at: NOW(), message: 'E2E 每日扫描启动，读取渠道清单' },
              { at: NOW(), message: 'E2E 正在扫描 X 列表渠道' },
              { at: NOW(), message: 'E2E 扫描完成 2/4，进入判断' }
            ]),
            JSON.stringify({ planned: 4, processed: 2, currentSource: '判断阶段', message: '已扫描 2/4 渠道' }),
            NOW()
          );
        } finally {
          db.close();
        }
        await page.waitForFunction(() => {
          const items = [...document.querySelectorAll('[data-testid="agents-detail-modal"] .agents-detail-run-log .task-event')];
          return items.some((item) => (item.textContent ?? '').includes('E2E 扫描完成 2/4'));
        }, null, { timeout: 15_000 });
        await delay(300);
        const readingScrollTop = await runLog.evaluate((node) => node.scrollTop);
        assert(readingScrollTop <= 2, `用户主动上滚后不应被新记录拉回底部，实际 scrollTop=${readingScrollTop}`);
        await page.waitForFunction(() => {
          const pct = document.querySelector('[data-testid="agents-detail-modal"] .agents-detail-pct');
          return (pct?.textContent ?? '').includes('50%');
        }, null, { timeout: 15_000 });
        await runLog.evaluate((node) => {
          node.scrollTop = node.scrollHeight;
          node.dispatchEvent(new Event('scroll'));
        });
        const db2 = openDb(workspace.dataRoot);
        try {
          db2.prepare(
            `UPDATE agent_tasks SET events_json = ?, progress_json = ?, updated_at = ? WHERE id = 'task-e2e-legacy-scan'`
          ).run(
            JSON.stringify([
              { at: NOW(), message: 'E2E 每日扫描启动，读取渠道清单' },
              { at: NOW(), message: 'E2E 正在扫描 X 列表渠道' },
              { at: NOW(), message: 'E2E 扫描完成 2/4，进入判断' },
              { at: NOW(), message: 'E2E 扫描完成 3/4，准备汇总' }
            ]),
            JSON.stringify({ planned: 4, processed: 3, currentSource: '汇总阶段', message: '已扫描 3/4 渠道' }),
            NOW()
          );
        } finally {
          db2.close();
        }
        await page.waitForFunction(() => {
          const log = document.querySelector('[data-testid="agents-detail-modal"] .agents-detail-run-log');
          const hasLatest = (log?.textContent ?? '').includes('E2E 扫描完成 3/4');
          return Boolean(log) && hasLatest && log.scrollHeight - log.clientHeight - log.scrollTop <= 2;
        }, null, { timeout: 15_000 });
      });
      await step('保存统一运行记录视觉证据', async () => {
        await helpers.captureEvidence({ app, page, evidence, artifactsDir, name: 'agents-unified-run-log' });
      });

      await step('真实 API 保存头像：卡片与弹窗即时显示大号头像控件', async () => {
        blueAvatar = await page.evaluate(async () => {
          const c = document.createElement('canvas');
          c.width = 8;
          c.height = 8;
          const x = c.getContext('2d');
          x.fillStyle = '#3b82f6';
          x.fillRect(0, 0, 8, 8);
          const dataUrl = c.toDataURL('image/png');
          const saved = await window.wmb.setAgentAvatar({
            roleId: 'reporter',
            base64: dataUrl.replace(/^data:image\/png;base64,/, ''),
            mimeType: 'image/png',
            width: 8,
            height: 8
          });
          return saved?.url ?? null;
        });
        assert(blueAvatar && blueAvatar.startsWith('wmb-asset://'), `头像保存失败: ${blueAvatar}`);
        const modalAvatar = page.locator('[data-testid="agents-detail-modal"] .agents-detail-avatar img');
        await modalAvatar.waitFor({ state: 'visible', timeout: 15_000 });
        assert((await modalAvatar.getAttribute('src')) === blueAvatar, '弹窗头像控件应显示刚保存的头像');
        const cardImg = page.locator('.agents-role-card[data-role="reporter"] .agents-card-avatar img');
        await cardImg.waitFor({ state: 'visible', timeout: 15_000 });
        assert((await cardImg.getAttribute('src')) === blueAvatar, '角色卡应显示同一头像');
      });
      await step('点击弹窗头像进入裁切：画布预载当前头像像素', async () => {
        await page.locator('[data-testid="agents-detail-modal"] .agents-detail-avatar').click();
        const crop = page.locator('.agent-avatar-modal');
        await crop.waitFor({ state: 'visible', timeout: 15_000 });
        assert(await page.locator('[data-testid="agents-detail-modal"]').count() === 0, '裁切期间详情弹窗应关闭（避免嵌套模态）');
        // 画布中心像素 = 当前头像蓝色（rgb 59,130,246），而非空白/黑色。
        await page.waitForFunction(() => {
          const canvas = document.querySelector('.agent-avatar-canvas');
          if (!canvas) return false;
          const ctx = canvas.getContext('2d');
          const d = ctx.getImageData(128, 128, 1, 1).data;
          return d[0] === 59 && d[1] === 130 && d[2] === 246;
        }, null, { timeout: 15_000 });
      });
      await step('替换图片并保存：裁切关闭、详情弹窗恢复并即时显示新头像', async () => {
        mkdirSync(RUNTIME_DIR, { recursive: true });
        const filePath = path.join(RUNTIME_DIR, 'avatar-replace-red.png');
        writeFileSync(filePath, solidPng(8, [220, 38, 38]));
        await page.locator('.agent-avatar-file input[type="file"]').setInputFiles(filePath);
        await page.waitForFunction(() => {
          const canvas = document.querySelector('.agent-avatar-canvas');
          if (!canvas) return false;
          const ctx = canvas.getContext('2d');
          const d = ctx.getImageData(128, 128, 1, 1).data;
          return d[0] === 220 && d[1] === 38 && d[2] === 38;
        }, null, { timeout: 15_000 });
        await page.locator('.agent-avatar-dialog .primary-button').click();
        const modal = page.locator('[data-testid="agents-detail-modal"]');
        await modal.waitFor({ state: 'visible', timeout: 15_000 });
        assert(await page.locator('.agent-avatar-modal').count() === 0, '保存后裁切弹窗应关闭');
        const modalSrc = await modal.locator('.agents-detail-avatar img').getAttribute('src');
        assert(modalSrc && modalSrc.startsWith('wmb-asset://') && modalSrc !== blueAvatar, `弹窗应显示新头像: ${modalSrc}`);
        const cardSrc = await page.locator('.agents-role-card[data-role="reporter"] .agents-card-avatar img').getAttribute('src');
        assert(cardSrc === modalSrc, '角色卡应同步显示保存后的头像');
        await page.waitForFunction(() => {
          const el = document.querySelector('[data-testid="agents-detail-modal"]');
          return (el?.textContent ?? '').includes('task-e2e-legacy-scan');
        }, null, { timeout: 15_000 });
        assert(((await modal.textContent()) ?? '').includes('task-e2e-legacy-scan'), '恢复后的弹窗应显示同一任务明细');
      });
      await step('关闭弹窗：焦点回到触发角色卡', async () => {
        await page.locator('[data-testid="agents-detail-modal"] .app-modal-close').click();
        await page.waitForFunction(() => document.querySelectorAll('[data-testid="agents-detail-modal"]').length === 0, null, { timeout: 10_000 });
        const focusInfo = await page.evaluate(() => {
          const active = document.activeElement;
          return active ? { role: active.getAttribute('data-role'), className: active.className } : null;
        });
        assert(focusInfo?.role === 'reporter', `关闭弹窗后焦点应回到触发角色卡, 实际: ${JSON.stringify(focusInfo)}`);
      });
      await healthCheck(page, evidence, assert, step);
      return { legacyDetail: true, avatar: true, pageerrors: evidence.pageerrors.length };
    }
  }
];
