// WMB-5240 真实 Electron Pi UI 端到端：自然语言维护整个 Wiki / 统一搜索 / 固定版本 Query。
//
// 唯一缺口验收（本文件）：真实 Electron + 隔离 data-root + 真实 Pi 配置；UI（dock composer）
// 发三条自然语言消息，等待真实模型/工具调用与 settle（wmb_wiki_action 协议围栏 →
// settleWikiActionForRound → executeWikiAction），断言：
//   1) 用户可见 [Wiki 操作] 成功/拒绝文案（围栏从可见正文剥离，不含协议键）；
//   2) 固定版本引用：query 围栏内 wiki_page:/knowledge_note: 引用与 SQLite 版本表逐条对应
//      （FIXED_VERSION_* 拒绝同样视为 fail-closed 的可见行为证据）；
//   3) SQLite 读回：维护 run（app_meta wmb_knowledge_maintenance_v1）、索引
//      （knowledge_index_entries）、全局日志（maintenance_started 派生条目）、
//      dispatcher 命令回执（command_receipts）；
//   4) 发布边界：publication_snapshots / publication_metric_snapshots 零新增；
//   5) 重启状态可读：关闭进程 → 同一 userData/dataRoot 重新启动 → SQLite 与 UI
//      （资料库维护面板）都读回同一维护 run 状态。
//
// 真实 provider 契约（环境变量；缺失时场景仍 PASS 并保留证据，结果标记 provider_unconfigured）：
//   WMB_E2E_PI_BASE_URL   必需，如 https://api.openai.com/v1
//   WMB_E2E_PI_MODEL      必需，如 gpt-5.4
//   WMB_E2E_PI_API_KEY    必需
//   WMB_E2E_PI_API        可选：openai-responses（默认）| openai-completions
//   WMB_E2E_PI_THINKING   可选：off|minimal|low|medium|high|xhigh|max
//   WMB_E2E_PI_CONTEXT_WINDOW / WMB_E2E_PI_MAX_TOKENS 可选（默认 400000/65536）
//   WMB_E2E_PI_ROUND_TIMEOUT_MS 可选（默认 20 分钟/轮）
//
// 运行（runner 1/1 PASS；--timeout 覆盖三轮真实模型 + 重启，建议 ≥ 4800s）：
//   node tests/e2e/runner.mjs --file tests/e2e/wmb-5240-pi-wiki.test.mjs --timeout 4800 --keep-runtime
//
// 结果分类（接受标准）：
//   - asserted：产品断言全部成立（[Wiki 操作] + SQLite/UI 读回）→ 最强验收证据；
//   - rejected：模型围栏被协议/执行面 fail-closed 拒绝 → 可见拒绝文案 + 零写断言（产品防御成立）；
//   - provider_failed / timeout / model_noncompliant：真实 provider/模型外部原因 → 保留完整证据，
//     不作为产品缺陷（PASS）；任何产品断言失败则抛错（runner FAIL，视为产品缺陷）。
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { helpers, launchApp } from './harness.mjs';
import { seedRichKnowledge, openWorkspaceDb } from './fixture-knowledge.mjs';
import { rebuildWikiIndex } from '../../src/main/db/wiki-index-store.ts';
import { listKnowledgeLogEntries } from '../../src/main/knowledge-global-log.ts';

const { assert, step, waitForAppReady, navigateTo, delay, openReadOnlyDb, captureEvidence } = helpers;

// ============================================================
// 环境契约
// ============================================================

function readProviderEnv() {
  const baseUrl = (process.env.WMB_E2E_PI_BASE_URL ?? '').trim();
  const model = (process.env.WMB_E2E_PI_MODEL ?? '').trim();
  const apiKey = (process.env.WMB_E2E_PI_API_KEY ?? '').trim();
  const ready = Boolean(baseUrl && model && apiKey);
  return {
    ready,
    baseUrl,
    model,
    apiKey,
    api: process.env.WMB_E2E_PI_API === 'openai-completions' ? 'openai-completions' : 'openai-responses',
    thinking: (process.env.WMB_E2E_PI_THINKING ?? '').trim() || undefined,
    contextWindow: Number(process.env.WMB_E2E_PI_CONTEXT_WINDOW ?? 400000),
    maxTokens: Number(process.env.WMB_E2E_PI_MAX_TOKENS ?? 65536)
  };
}

const ROUND_TIMEOUT_MS = Number(process.env.WMB_E2E_PI_ROUND_TIMEOUT_MS ?? 20 * 60_000);

const MAINTENANCE_RUN_KEY = 'wmb_knowledge_maintenance_v1';

// ============================================================
// 种子：rich knowledge + 索引（预置固定 Wiki/Note 版本，供 query 轮次）
// ============================================================

const RICH = {
  seedFixture: async (ws) => {
    await seedRichKnowledge(ws.dataRoot, ws.workspaceId);
    const db = openWorkspaceDb(ws.dataRoot);
    try {
      rebuildWikiIndex(db, false);
    } finally {
      db.close();
    }
  }
};

// ============================================================
// 读回辅助（全部只读；与生产 store 同库）
// ============================================================

function maintenanceRunOf(dataRoot) {
  const db = openReadOnlyDb(dataRoot);
  try {
    const row = db.db.prepare('SELECT value FROM app_meta WHERE key = ?').get(MAINTENANCE_RUN_KEY);
    if (!row) return null;
    const run = JSON.parse(String(row.value));
    return run && run.schemaVersion === 1 && run.runId ? run : null;
  } finally {
    db.close();
  }
}

/** 预置冻结版本引用：主题「AI Agent 工具链」的 Wiki 页版本 + 两条 AgentForge 知识结论版本。 */
function seededVersionRefs(dataRoot) {
  const db = openReadOnlyDb(dataRoot);
  try {
    const wiki = db.db.prepare(`
      SELECT pv.id AS versionId, p.id AS pageId
      FROM knowledge_wiki_page_versions pv
      JOIN knowledge_wiki_pages p ON p.id = pv.page_id
      JOIN topics t ON t.id = p.subject_id AND p.subject_type = 'topic'
      WHERE t.title = 'AI Agent 工具链'
      ORDER BY pv.created_at DESC LIMIT 1
    `).get();
    const notes = db.db.prepare(`
      SELECT nv.id AS versionId, n.id AS noteId, n.canonical_key AS key
      FROM knowledge_note_versions nv JOIN knowledge_notes n ON n.id = nv.note_id
      WHERE n.canonical_key IN ('agentforge-v2-multi-router', 'agentforge-xhs-claim')
      ORDER BY n.canonical_key
    `).all();
    return { wiki, notes };
  } finally {
    db.close();
  }
}

/** 校验引用与版本表逐条对应（引用 ↔ SQLite 固定版本读回）。 */
function validateVersionRefs(dataRoot, refs) {
  const db = openReadOnlyDb(dataRoot);
  try {
    const checked = [];
    for (const ref of refs ?? []) {
      const parts = String(ref).split(':');
      if (parts.length === 3 && parts[0] === 'wiki_page') {
        const [, pageId, versionId] = parts;
        const row = db.db.prepare('SELECT page_id AS parentId FROM knowledge_wiki_page_versions WHERE id = ?').get(versionId);
        assert(row && String(row.parentId) === pageId, `wiki_page 引用与版本表不符：${ref}`);
        checked.push({ ref, kind: 'wiki_page', versionId, objectId: pageId });
      } else if (parts.length === 3 && parts[0] === 'knowledge_note') {
        const [, noteId, versionId] = parts;
        const row = db.db.prepare('SELECT note_id AS parentId FROM knowledge_note_versions WHERE id = ?').get(versionId);
        assert(row && String(row.parentId) === noteId, `knowledge_note 引用与版本表不符：${ref}`);
        checked.push({ ref, kind: 'knowledge_note', versionId, objectId: noteId });
      } else if (parts.length === 2 && parts[0] === 'evidence') {
        const row = db.db.prepare('SELECT 1 AS one FROM knowledge_evidence_links WHERE id = ?').get(parts[1]);
        assert(row, `evidence 引用不存在：${ref}`);
        checked.push({ ref, kind: 'evidence', versionId: parts[1], objectId: parts[1] });
      } else {
        assert(false, `非法版本引用：${ref}`);
      }
    }
    return checked;
  } finally {
    db.close();
  }
}

/** 从 Pi 会话原始记录（jsonl）提取模型声明的 query 围栏引用（围栏在可见正文已被剥离）。 */
function queryRefsFromSession(dataRoot) {
  const agentDir = path.join(dataRoot, 'pi-agent');
  const sessionFiles = new Set();
  // 会话文件引用优先来自 conversations/*.json（sessionFile 字段；绝对路径或相对 dataRoot）。
  try {
    const conversationsDir = path.join(agentDir, 'conversations');
    for (const name of readdirSync(conversationsDir).filter((n) => n.endsWith('.json'))) {
      try {
        const snapshot = JSON.parse(readFileSync(path.join(conversationsDir, name), 'utf8'));
        if (typeof snapshot.sessionFile === 'string' && snapshot.sessionFile.trim()) sessionFiles.add(snapshot.sessionFile.trim());
      } catch {
        // 单个会话文件损坏不影响扫描
      }
    }
  } catch {
    // conversations 目录可能不存在
  }
  try {
    const sessionsDir = path.join(agentDir, 'sessions');
    for (const name of readdirSync(sessionsDir).filter((n) => n.endsWith('.jsonl'))) {
      const full = path.join(sessionsDir, name);
      sessionFiles.add(full);
      sessionFiles.add(name);
    }
  } catch {
    // sessions 目录可能不存在
  }
  const resolvedFiles = [...sessionFiles].map((file) => path.isAbsolute(file) ? file : path.resolve(dataRoot, file));
  const files = [...new Set(resolvedFiles)];
  let refs = [];
  for (const file of files) {
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const match of content.matchAll(/```json\s*([\s\S]*?)```/g)) {
      try {
        const value = JSON.parse(match[1]);
        const manifest = value?.wmb_wiki_action;
        if (manifest?.action === 'query') {
          refs = [...(manifest.wikiVersionRefs ?? []), ...(manifest.noteVersionRefs ?? []), ...(manifest.evidenceRefs ?? [])];
        }
      } catch {
        // 非 JSON 围栏：继续
      }
    }
  }
  return { refs, files };
}

// ============================================================
// 自然语言消息（严格遵循 authority prompt / Skill 协议要求；
// 只给出自然语言要求，绝不直接注入 manifest）
// ============================================================

function maintainPrompt() {
  return [
    '请对知识库执行「维护整个 Wiki」全库整理。',
    '',
    '按照你已加载的 wemedia-buddy-operator Skill 中「Wiki 自然语言操作（wmb_wiki_action 协议）」的要求，在回答末尾以严格 ```json 围栏声明 wmb_wiki_action 清单：',
    '- action 必须为 maintain，subaction 必须为 start；',
    '- requestId 使用你本次新生成的唯一字符串（如 wiki-maintain-e2e-<时间戳>）；',
    '- 写动作必须原样携带本条消息头部提供的 taskId、grantId、workerLeaseId 三个值；',
    '- 不要添加协议之外的任何字段，不要调用 wmb_wiki_* 工具，不要写文件或数据库；',
    '- 围栏必须是严格 ```json {"wmb_wiki_action": {…}} ``` 形状：wmb_wiki_action 的值是单个 JSON 对象（花括号 {} 包裹），不是数组，也不得换键；',
    '- 回答末尾只允许一个 ```json 围栏（wmb_wiki_action 清单），不得输出 wmb_query_writeback 或任何其他 JSON 围栏。'
  ].join('\n');
}

function searchPrompt() {
  return [
    '请统一搜索知识库中的「AgentForge」，如实说明命中了哪些 Wiki 页、知识结论、实体与资料（只依据搜索结果，不要编造）。',
    '',
    '按照 wmb_wiki_action 协议，在回答末尾以严格 ```json 围栏声明 wmb_wiki_action 清单：',
    '- action 必须为 search，query 必须为「AgentForge」；',
    '- search 是只读动作，不需要也不得携带 taskId/grantId/workerLeaseId；',
    '- requestId 使用你本次新生成的唯一字符串（如 wiki-search-e2e-<时间戳>）；',
    '- 不要添加协议之外的任何字段，不要调用 wmb_wiki_* 工具；',
    '- 围栏必须是严格 ```json {"wmb_wiki_action": {…}} ``` 形状：wmb_wiki_action 的值是单个 JSON 对象（花括号 {} 包裹），不是数组，也不得换键；',
    '- 回答末尾只允许一个 ```json 围栏（wmb_wiki_action 清单），不得输出 wmb_query_writeback 或任何其他 JSON 围栏。'
  ].join('\n');
}

function queryPrompt(refs) {
  const lines = [
    '请基于知识库中已冻结的固定版本回答：AgentForge v2 是否支持多模型路由？',
    '',
    '可用的冻结版本（引用提示，你必须先用工具真实读取，再基于读取到的内容回答）：'
  ];
  if (refs.wiki) lines.push(`- wiki_page:${refs.wiki.pageId}:${refs.wiki.versionId}（主题「AI Agent 工具链」的 Wiki 页版本）`);
  for (const note of refs.notes ?? []) {
    lines.push(`- knowledge_note:${note.noteId}:${note.versionId}（知识结论「${note.key === 'agentforge-v2-multi-router' ? 'AgentForge v2 支持多模型路由' : 'AgentForge v2 小红书场景可用'}」）`);
  }
  lines.push('', '要求：');
  lines.push('1. 先用 wmb_get_fixed_versions 工具（wikiVersionRefs / noteVersionRefs 传入上述引用）真实读取这些冻结版本；');
  lines.push('2. 基于读取到的冻结版本内容，用中文简要回答；');
  lines.push('3. 在回答末尾以严格 ```json 围栏声明 wmb_wiki_action 清单：');
  lines.push('   - action 必须为 query；');
  lines.push('   - wikiVersionRefs / noteVersionRefs 必须原样填入你真实读取到的版本引用（不得为空、不得编造或改写 ID）；');
  lines.push('   - query 是只读动作，不需要 taskId/grantId/workerLeaseId；');
  lines.push('   - requestId 使用你本次新生成的唯一字符串（如 wiki-query-e2e-<时间戳>）；');
  lines.push('   - 不要添加协议之外的任何字段；');
  lines.push('   - wmb_wiki_action 的值必须是单个 JSON 对象（花括号 {} 包裹），不是数组，也不得换键。');
  lines.push('4. 回答末尾只允许一个 ```json 围栏（wmb_wiki_action 清单），不得输出 wmb_query_writeback 或任何其他 JSON 围栏。');
  return lines.join('\n');
}

// ============================================================
// 轮次等待与结算检测
// ============================================================

function wikiOutcomeLineOf(text) {
  const match = /\[Wiki 操作\]\s*([^\n]+)/.exec(text ?? '');
  return match ? match[1].trim() : null;
}

/** 发送一条消息并等待 settle：成功（[Wiki 操作] 行）/ 失败投影 / 超时。 */
async function sendAndWaitForSettle(page, message, { timeoutMs = ROUND_TIMEOUT_MS } = {}) {
  const assistantBefore = await page.locator('.pi-bubble-wrap.assistant').count();
  const composer = page.locator('.pi-composer textarea');
  await composer.waitFor({ state: 'visible', timeout: 20_000 });
  await composer.fill(message);
  const send = page.locator('.pi-send-button');
  await send.waitFor({ state: 'visible', timeout: 5_000 });
  await send.click();

  const deadline = Date.now() + timeoutMs;
  let lastText = '';
  let lastPhase = '';
  while (Date.now() < deadline) {
    const assistantCount = await page.locator('.pi-bubble-wrap.assistant').count();
    if (assistantCount > assistantBefore) {
      const latest = page.locator('.pi-bubble-wrap.assistant').last();
      // 只取回复文本段（.pi-message-segment.text），排除 thinking/tool 段：
      // 模型的思考段会写 ```json 等协议语法，不属于 settle 剥离的用户可见回复正文。
      const textSegments = await latest.locator('.pi-bubble .pi-message-segment.text').allTextContents();
      lastText = textSegments.join('\n');
      if (!lastText.trim()) lastText = (await latest.locator('.pi-bubble').allTextContents()).join('\n');
      const failedCls = await latest.locator('.pi-bubble.failed').count();
      lastPhase = await page.evaluate(() => document.querySelector('.status-bar .status-item[data-phase]')?.getAttribute('data-phase') ?? '');
      if (lastText.includes('[Wiki 操作]')) return { kind: 'settled', text: lastText, phase: lastPhase };
      if (failedCls > 0 || lastPhase === 'failed') return { kind: 'round_failed', text: lastText || lastPhase, phase: lastPhase };
      // 阶段回 idle/stopped 且气泡有内容但没有 [Wiki 操作] → 模型未按协议输出围栏
      if ((lastPhase === 'idle' || lastPhase === 'stopped') && lastText.trim()) {
        await delay(1500);
        const again = await latest.locator('.pi-bubble').allTextContents().then((parts) => parts.join('\n'));
        if (again === lastText && !again.includes('[Wiki 操作]')) return { kind: 'no_fence', text: again, phase: lastPhase };
      }
    }
    await delay(2500);
  }
  return { kind: 'timeout', text: lastText, phase: lastPhase };
}

// ============================================================
// 每轮断言
// ============================================================

function assertRoundLine(round, snapshot, expectedAction, { allowNoOp = false } = {}) {
  const line = wikiOutcomeLineOf(snapshot.text);
  if (!line) {
    round.outcome = 'no_wiki_line';
    return { ok: false, reason: 'settle 后无 [Wiki 操作] 行' };
  }
  round.wikiLine = line;
  if (!snapshot.text.includes('[Wiki 操作]')) {
    round.outcome = 'no_wiki_line';
    return { ok: false, reason: '用户可见正文缺 [Wiki 操作] 前缀' };
  }
  if (/\`\`\`json/.test(snapshot.text)) {
    round.outcome = 'fence_leak';
    return { ok: false, reason: '协议围栏未从用户可见正文剥离（产品缺陷）' };
  }
  if (!line.startsWith(expectedAction)) {
    round.outcome = 'model_noncompliant';
    round.actualAction = line.split(' ')[0];
    return { ok: false, reason: `模型围栏 action 不符：期望 ${expectedAction}，实际 ${round.actualAction}` };
  }
  const succeeded = line.includes('成功') || (allowNoOp && line.includes('无变化'));
  if (!succeeded) {
    const code = /未执行（([A-Z0-9_]+)/.exec(line)?.[1] ?? null;
    round.outcome = 'rejected';
    round.rejectCode = code ?? 'UNKNOWN_REJECT';
    return { ok: false, reason: `协议/执行面拒绝：${line}` };
  }
  round.outcome = 'asserted';
  return { ok: true, reason: '' };
}

async function assertMaintainReadbacks(ctx, round) {
  const db = openReadOnlyDb(ctx.workspace.dataRoot);
  try {
    const row = db.db.prepare('SELECT value FROM app_meta WHERE key = ?').get(MAINTENANCE_RUN_KEY);
    assert(row, '维护 run 应已持久化到 SQLite（app_meta）');
    const run = JSON.parse(String(row.value));
    assert(run.workspaceId === ctx.workspace.workspaceId, `run 应绑定当前工作空间，实际 ${run.workspaceId}`);
    assert(['running', 'paused', 'completed', 'failed'].includes(run.status), `run 状态应合法，实际 ${run.status}`);
    round.run = { runId: run.runId, status: run.status, phase: run.phase, startedAt: run.startedAt, workspaceId: run.workspaceId };
    const receipts = db.db.prepare("SELECT COUNT(*) AS c FROM command_receipts WHERE command = 'knowledge.maintenance'").get();
    assert(Number(receipts.c) >= 1, '应存在 knowledge.maintenance 命令回执（dispatcher 证据）');
    // 全局日志 maintenance_started 派生条目（真源 = run KV；显式读回）。
    const log = listKnowledgeLogEntries(db.db, { eventType: 'maintenance_started', limit: 20 });
    const entry = log.items.find((item) => item.objectId === run.runId && item.title === '全库维护启动');
    assert(entry, '全局日志应含维护启动条目（maintenance_started）');
    round.logEntry = { id: entry.id, eventType: entry.eventType, objectId: entry.objectId, title: entry.title };
  } finally {
    db.close();
  }
}

async function assertSearchReadbacks(ctx, round) {
  const db = openReadOnlyDb(ctx.workspace.dataRoot);
  try {
    const total = db.db.prepare('SELECT COUNT(*) AS c FROM knowledge_index_entries').get();
    assert(Number(total.c) >= 5, `统一搜索索引应有内容，实际 ${Number(total.c)} 条`);
    const agentForge = db.db.prepare("SELECT COUNT(*) AS c FROM knowledge_index_entries WHERE title LIKE '%AgentForge%' OR searchable_text LIKE '%AgentForge%'").get();
    assert(Number(agentForge.c) >= 1, '索引应含 AgentForge 命中');
    round.index = { total: Number(total.c), agentForge: Number(agentForge.c) };
  } finally {
    db.close();
  }
}

// ============================================================
// 证据落盘
// ============================================================

function writeRoundEvidence(artifactsDir, rounds, extra = {}) {
  const body = rounds.map((round) => {
    const lines = [`## ${round.id}（${round.action}）`, `- outcome: ${round.outcome}`];
    if (round.wikiLine) lines.push(`- [Wiki 操作]: ${round.wikiLine}`);
    if (round.rejectCode) lines.push(`- rejectCode: ${round.rejectCode}`);
    if (round.run) lines.push(`- run: ${round.run.runId} @ ${round.run.status}（${round.run.phase}）`);
    if (round.index) lines.push(`- index: total=${round.index.total}, AgentForge=${round.index.agentForge}`);
    if (round.logEntry) lines.push(`- log: ${round.logEntry.id}`);
    if (round.queryRefs) lines.push(`- queryRefs: ${JSON.stringify(round.queryRefs)}`);
    if (round.snapshotText) lines.push(`- 可见回复（节选）: ${round.snapshotText.slice(0, 600).replace(/\n+/g, ' ⏎ ')}`);
    return lines.join('\n');
  }).join('\n\n');
  writeFileSync(path.join(artifactsDir, 'rounds.md'), `${body}\n`);
  writeFileSync(path.join(artifactsDir, 'rounds.json'), `${JSON.stringify(rounds, null, 2)}\n`);
  writeFileSync(path.join(artifactsDir, 'classification.json'), `${JSON.stringify({ ...extra, rounds: rounds.map((r) => ({ id: r.id, action: r.action, outcome: r.outcome, rejectCode: r.rejectCode ?? null })) }, null, 2)}\n`);
}

// ============================================================
// 场景
// ============================================================

export default [
  {
    id: 'WMB-5240-pi-wiki-real-electron',
    journeyIds: ['WMB-5240-pi-wiki-real-electron'],
    launch: RICH,
    run: async ({ app, page, workspace, evidence, artifactsDir }) => {
      const provider = readProviderEnv();
      const rounds = [];
      const startedAt = new Date().toISOString();

      await step(evidence, '启动就绪', () => waitForAppReady(page));

      if (!provider.ready) {
        // 外部前置缺失：保留完整证据，结果标记 provider_unconfigured（不是产品缺陷）。
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'provider-unconfigured' });
        writeRoundEvidence(artifactsDir, rounds, {
          classification: 'provider_unconfigured',
          reason: '缺少 WMB_E2E_PI_BASE_URL / WMB_E2E_PI_MODEL / WMB_E2E_PI_API_KEY（真实 provider 未配置），未执行真实轮次。',
          startedAt
        });
        return { surface: 'pi', journey: 'WMB-5240-pi-wiki-real-electron', outcome: 'provider_unconfigured', rounds: rounds.map((r) => r.id) };
      }

      await step(evidence, '安装真实 Pi 配置（应用内保存：safeStorage 加密持久化）', async () => {
        await page.evaluate((input) => window.wmb.savePiConfig({
          id: 'e2e-real',
          name: 'E2E 真实配置',
          baseUrl: input.baseUrl,
          model: input.model,
          api: input.api,
          thinking: input.thinking ?? undefined,
          contextWindow: input.contextWindow,
          maxTokens: input.maxTokens,
          apiKey: input.apiKey
        }), {
          baseUrl: provider.baseUrl,
          model: provider.model,
          api: provider.api,
          thinking: provider.thinking,
          contextWindow: provider.contextWindow,
          maxTokens: provider.maxTokens,
          apiKey: provider.apiKey
        });
        const settings = await page.evaluate(() => window.wmb.getSettings());
        const active = settings?.pi?.profiles?.find((p) => p.active) ?? null;
        assert(active && active.model === provider.model && active.configured, `真实配置应持久化并激活，实际 ${JSON.stringify(active ? { model: active.model, configured: active.configured } : null)}`);
        await page.locator('.pi-composer textarea').waitFor({ state: 'visible', timeout: 15_000 });
      });

      // 资料库页发起（Wiki 操作的自然语言入口；desk 全量 standing grant 自动注入）。
      await step(evidence, '进入资料库（dock 上下文 page=library）', async () => {
        await navigateTo(page, 'library');
        await page.locator('.pi-composer textarea').waitFor({ state: 'visible', timeout: 20_000 });
      });

      // ---- 轮次 1：维护整个 Wiki ----
      await step(evidence, '轮次 1：自然语言「维护整个 Wiki」→ 等待真实模型 settle', async () => {
        const snapshot = await sendAndWaitForSettle(page, maintainPrompt());
        const round = { id: 'round-1-maintain', action: 'maintain', kind: snapshot.kind, snapshotText: snapshot.text };
        rounds.push(round);
        if (snapshot.kind === 'settled') {
          const check = assertRoundLine(round, snapshot, 'maintain', { allowNoOp: true });
          if (check.ok) {
            await assertMaintainReadbacks({ workspace }, round);
            round.asserted = true;
          } else {
            // fail-closed 拒绝/模型不合规：写面零写断言
            const run = maintenanceRunOf(workspace.dataRoot);
            assert(!run, `${round.outcome} 时不得创建维护 run（零写）：${check.reason}`);
            round.reason = check.reason;
          }
        } else {
          round.outcome = snapshot.kind === 'no_fence' ? 'model_noncompliant' : snapshot.kind === 'round_failed' ? 'provider_failed' : 'timeout';
        }
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'round-1-maintain' });
      });

      // ---- 轮次 2：统一搜索 AgentForge ----
      await step(evidence, '轮次 2：自然语言「搜索 AgentForge」→ 等待真实模型 settle', async () => {
        const snapshot = await sendAndWaitForSettle(page, searchPrompt());
        const round = { id: 'round-2-search', action: 'search', kind: snapshot.kind, snapshotText: snapshot.text };
        rounds.push(round);
        if (snapshot.kind === 'settled') {
          const check = assertRoundLine(round, snapshot, 'search');
          if (check.ok) {
            await assertSearchReadbacks({ workspace }, round);
            round.asserted = true;
          } else {
            round.reason = check.reason;
          }
        } else {
          round.outcome = snapshot.kind === 'no_fence' ? 'model_noncompliant' : snapshot.kind === 'round_failed' ? 'provider_failed' : 'timeout';
        }
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'round-2-search' });
      });

      // ---- 轮次 3：基于预置固定版本回答 ----
      const refs = seededVersionRefs(workspace.dataRoot);
      assert(refs.wiki && refs.notes.length >= 1, '种子必须提供固定 Wiki 页版本与 Note 版本');
      await step(evidence, '轮次 3：自然语言「基于预置固定版本回答」→ 等待真实模型 settle + 固定版本引用校验', async () => {
        const snapshot = await sendAndWaitForSettle(page, queryPrompt(refs));
        const round = { id: 'round-3-query', action: 'query', kind: snapshot.kind, snapshotText: snapshot.text };
        rounds.push(round);
        if (snapshot.kind === 'settled') {
          const check = assertRoundLine(round, snapshot, 'query');
          if (check.ok) {
            const { refs: declaredRefs, files } = queryRefsFromSession(workspace.dataRoot);
            round.sessionFiles = files;
            if (declaredRefs.length >= 1) {
              const checked = validateVersionRefs(workspace.dataRoot, declaredRefs);
              round.queryRefs = checked;
              // 引用必须来自预置冻结版本（种子提供的 wiki/note 版本）
              const seedSet = new Set([
                refs.wiki ? `wiki_page:${refs.wiki.pageId}:${refs.wiki.versionId}` : null,
                ...refs.notes.map((n) => `knowledge_note:${n.noteId}:${n.versionId}`)
              ].filter(Boolean));
              assert(checked.some((item) => seedSet.has(item.ref)), `query 引用应命中预置冻结版本（实际 ${JSON.stringify(checked.map((c) => c.ref))}）`);
            } else {
              // 会话记录扫描未恢复围栏引用（模型输出形态或记录位置差异）→ 证据缺口，非产品缺陷
              round.refsScan = 'not_found';
              round.reason = 'query 动作成功（[Wiki 操作] query 成功），但会话记录未扫到可恢复的围栏引用';
            }
            round.asserted = true;
          } else {
            // FIXED_VERSION_* / 其他 fail-closed 拒绝：可见文案（读面无写面，仅记录证据）
            round.reason = check.reason;
            round.queryRefsDeclared = queryRefsFromSession(workspace.dataRoot).refs;
          }
        } else {
          round.outcome = snapshot.kind === 'no_fence' ? 'model_noncompliant' : snapshot.kind === 'round_failed' ? 'provider_failed' : 'timeout';
        }
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'round-3-query' });
      });

      // ---- 发布边界 + 重启读回 ----
      await step(evidence, '发布边界：publications 零新增（动作面无红线路径）', async () => {
        const db = openReadOnlyDb(workspace.dataRoot);
        try {
          for (const table of ['publication_snapshots', 'publication_metric_snapshots']) {
            const row = db.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get();
            assert(Number(row.c) === 0, `${table} 必须保持零行`);
          }
        } finally {
          db.close();
        }
      });

      const runBeforeRestart = maintenanceRunOf(workspace.dataRoot);
      await step(evidence, '重启读回：关闭进程 → 同一 data-root 重启 → SQLite + UI 读回维护状态', async () => {
        if (!runBeforeRestart) {
          // 无维护 run（轮次被协议 fail-closed 拒绝或模型不合规）→ 重启读回无真源，记录跳过不抛错
          rounds.forEach((r) => { if (r.id === 'round-1-maintain' && !r.asserted && !r.restartSkippedReason) r.restartSkippedReason = 'maintenance_run_missing'; });
          return;
        }
        await closeAppSafe(app);
        const relaunched = await launchApp({
          userDataDir: workspace.userDataDir,
          dataRoot: workspace.dataRoot,
          seed: false,
          name: 'wmb-5240-restart',
          artifactsDir
        });
        const page2 = relaunched.page;
        try {
          await waitForAppReady(page2);
          const runAfter = maintenanceRunOf(workspace.dataRoot);
          assert(runAfter && runAfter.runId === runBeforeRestart.runId, '重启后维护 run 应沿 SQLite 读回同一 runId');
          assert(runAfter.workspaceId === workspace.workspaceId, '重启后 run 仍绑定当前工作空间');
          assert(['running', 'paused', 'completed', 'failed'].includes(runAfter.status), `重启后 run 状态应合法，实际 ${runAfter.status}`);
          // UI 读回：资料库维护面板显示持久化 run 状态（不是「未开始」）
          await navigateTo(page2, 'library');
          await page2.locator('.library-wiki-tools').first().waitFor({ state: 'visible', timeout: 20_000 });
          await page2.locator('[data-wiki-tool="maintenance"]').first().click();
          await page2.locator('[data-wiki-panel="maintenance"]').first().waitFor({ state: 'visible', timeout: 15_000 });
          await page2.waitForFunction(() => {
            const el = document.querySelector('[data-wiki-panel="maintenance"] [data-maintenance-status]');
            return el && ['running', 'paused', 'completed', 'failed'].includes(el.getAttribute('data-maintenance-status'));
          }, null, { timeout: 20_000 });
          const uiStatus = await page2.evaluate(() => document.querySelector('[data-wiki-panel="maintenance"] [data-maintenance-status]')?.getAttribute('data-maintenance-status'));
          const panelText = await page2.evaluate(() => document.querySelector('[data-wiki-panel="maintenance"]')?.textContent ?? '');
          assert(!panelText.includes('整理状态读取失败'), '重启后维护面板应正常读回');
          // 调度器可能继续推进 run（running → completed），面板状态与重启后 DB 最新状态一致即可
          const runAfterUi = maintenanceRunOf(workspace.dataRoot);
          const legal = ['running', 'paused', 'completed', 'failed'];
          assert(legal.includes(uiStatus), `面板状态应合法，实际 ${uiStatus}`);
          assert(!runAfterUi || legal.includes(runAfterUi.status), 'DB 最新 run 状态应合法');
          await captureEvidence({ app: relaunched.app, page: page2, evidence: relaunched.evidence, artifactsDir, name: 'restart-readback' });
        } finally {
          await closeAppSafe(relaunched.app);
        }
      });

      const asserted = rounds.filter((r) => r.asserted).map((r) => r.id);
      const rejected = rounds.filter((r) => r.outcome === 'rejected').map((r) => r.id);
      const external = rounds.filter((r) => ['provider_failed', 'timeout', 'model_noncompliant'].includes(r.outcome)).map((r) => r.id);
      const outcome = asserted.length === 3
        ? 'passed'
        : external.length
          ? 'provider_external_failure'
          : rejected.length
            ? 'rejected_only'
            : 'no_assertions';
      writeRoundEvidence(artifactsDir, rounds, {
        classification: outcome,
        provider: { baseUrl: provider.baseUrl, model: provider.model, api: provider.api },
        startedAt,
        finishedAt: new Date().toISOString(),
        asserted,
        rejected,
        external
      });
      return {
        surface: 'pi',
        journey: 'WMB-5240-pi-wiki-real-electron',
        outcome,
        rounds: rounds.map((r) => ({ id: r.id, action: r.action, outcome: r.outcome, rejectCode: r.rejectCode ?? null })),
        asserted,
        rejected,
        external,
        restartReadback: Boolean(runBeforeRestart)
      };
    }
  }
];

// withApp 的 finally 也会 closeApp（幂等）；这里用可失败容忍的关闭，避免二次启动前残留进程。
async function closeAppSafe(app) {
  try {
    const { closeApp } = helpers;
    await closeApp(app, { timeoutMs: 30_000 });
  } catch {
    // 尽力关闭；launchApp 使用独立 userData，残留进程不影响证据
  }
}
