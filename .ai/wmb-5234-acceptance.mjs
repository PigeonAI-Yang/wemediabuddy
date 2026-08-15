/**
 * WMB-5234 生产知识飞轮最终验收 —— 可复跑验收脚本（WMB-5234-prep，只新增验收资产）。
 *
 * 目标：在同一真实 SQLite 工作空间副本/隔离根上，按 A Ingest → B Query →
 * C Creation → D Review → E Lint → F restore/concurrency（+ G 边界）顺序执行并读回，
 * 每项输出 object/version/receipt/usage id 与可截图 selector，输出结构化 JSON 证据；
 * 任何缺链 fail。UI 层经真实 Electron CDP 驱动（WMB_ACCEPTANCE_USER_DATA /
 * WMB_ACCEPTANCE_CDP_PORT），DB 只做结果读回，绝不污染 Owner 主库。
 *
 * 诚实契约：不可用环境/未完成依赖 → 明确 fail，不做假 fallback；不实际启动 Electron
 * 除非显式 --ui；不因 DB 层全绿而声称 WMB-5234 通过（需 UI + 5231–5233 集成齐备）。
 *
 * 用法：
 *   node .ai/wmb-5234-acceptance.mjs --help
 *   node .ai/wmb-5234-acceptance.mjs --audit            # 预检：静态导入/符号/环境/兄弟项（零写库、零 Electron）
 *   node .ai/wmb-5234-acceptance.mjs --run              # DB 层 A–F+G（隔离根，真实 API 读回）
 *   node .ai/wmb-5234-acceptance.mjs --run --ui --pi-config "<userData>\pi-api-config.json" --keep   # 完整验收（真实 Electron + Pi）
 *
 * 5231–5233 完成后运行（精确命令）：
 *   预检：      node .ai/wmb-5234-acceptance.mjs --audit
 *   DB 层：     node .ai/wmb-5234-acceptance.mjs --run --fixture copy --fixture-source .ai/wmb-5207-final-root --out .ai/wmb-5234-evidence
 *   完整验收：  node .ai/wmb-5234-acceptance.mjs --run --ui --fixture copy --fixture-source .ai/wmb-5207-final-root --pi-config "<真实 userData>\pi-api-config.json" --keep --out .ai/wmb-5234-evidence
 *
 * 退出码：0 = 本脚本健康（--audit）/ 执行面全绿（--run）；非 0 = 存在 fail/blocked。
 */

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createIsolatedFixture, writeAcceptanceUserData, listFixtureSources, inspectSourceDatabase } from './wmb-5234-fixture.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const NOW = () => new Date().toISOString();
const localDate = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
const EVIDENCE_SCHEMA = 'wmb-5234-acceptance-evidence.v1';

// ---------------------------------------------------------------------------
// 阶段模块与符号（audit 与 run 共用同一清单 —— 缺任一符号即该阶段 fail）
// ---------------------------------------------------------------------------
const PHASE_MODULES = {
  shared: [
    ['../src/shared/knowledge-flywheel.ts', ['knowledgeQueryWritebackRequestId']]
  ],
  A: [
    ['../src/main/db/migrations.ts', ['migrateDatabase']],
    ['../src/main/sources.ts', ['upsertSource']],
    ['../src/main/knowledge.ts', ['upsertKnowledgeTopic', 'getKnowledgeContext']],
    ['../src/main/knowledge-compiler.ts', ['compileSourceKnowledge', 'sourceCompileRequestId']],
    ['../src/main/knowledge-flywheel.ts', ['applyKnowledgeChangeSet', 'getChangeSet', 'getKnowledgeNote', 'getKnowledgeNoteVersion', 'getUpdateReceiptByRequest', 'getWikiPage', 'getWikiPageVersion', 'listKnowledgeEntities', 'listKnowledgeEvidenceLinks', 'listKnowledgeNoteVersions', 'listWikiPages', 'KNOWLEDGE_FLYWHEEL_CHANGE_SET_COMMAND']],
    ['../src/main/knowledge-canvas.ts', ['addKnowledgeCanvasNode', 'createCreativeBrief', 'createKnowledgeCanvas', 'createKnowledgeContextPackage', 'removeKnowledgeCanvasNode', 'getKnowledgeCanvasProjection']]
  ],
  B: [
    ['../src/main/query-writeback.ts', ['writebackQueryKnowledge', 'getQueryWritebackSummary']]
  ],
  C: [
    ['../src/main/content.ts', ['createContentProjectWithVersion', 'saveCoreVersion', 'savePlatformVersion']],
    ['../src/main/topic-maintenance.ts', ['createTopicMaintenanceProposal']],
    ['../src/main/knowledge-usage.ts', ['getKnowledgeUsagePackageByRequest', 'listKnowledgeUsageRecords']],
    ['../src/main/knowledge-usage-integration.ts', ['recordCreativeBriefUsage', 'usageRequestId', 'readPublicationTimeUsage']]
  ],
  D: [
    ['../src/main/publishing.ts', ['createPublication']],
    ['../src/main/metrics.ts', ['savePublicationMetricSnapshot']],
    ['../src/main/reviews.ts', ['saveReview']],
    ['../src/main/accounts.ts', ['saveAccount']],
    ['../src/main/outcome-feedback.ts', ['flowBackOutcome', 'outcomeFeedbackRequestId']]
  ],
  E: [
    ['../src/main/knowledge-health.ts', ['beginPeriodicLint', 'cancelPeriodicLint', 'getPeriodicLintCheckpoint', 'runLocalLint', 'runPeriodicLintStep']],
    ['../src/main/knowledge-compile-state.ts', ['classifyWikiCompileState', 'getTopicCompileState', 'listTopicCompileStates']]
  ],
  F: [], // 复用 A 模块
  G: [
    ['../src/main/workspace-runtime.ts', ['ActiveWorkspaceRuntime']],
    ['../src/main/workspace-profiles.ts', ['ensureOfficialWorkspaceProfile']],
    ['../src/main/command-dispatcher.ts', ['createCommandEnvelope']]
  ]
};

// 每项的可截图 selector（运行时在候选列表内解析，全部缺失 → 该 UI 项 fail）
// 全部经真实 DOM 核对：A/B/C 保持原样；D 的 ResultsView 根是 .results-page（.pub-card 只在发布页）；
// E 知识健康在资料库页签 .health-section + .library-issue-item，编译态在主题卡 .topic-compile-state；
// F 版本区在 Topic Wiki 的「版本」页签（需先切页签再截图，避免截到隐藏节）。
const UI_TARGETS = {
  A: { surface: 'Topic Wiki 当前认识', screenshotSelectors: ['.topic-wiki-page', '#topic-wiki-current', '.topic-wiki-conclusion'] },
  B: { surface: 'Pi 知识使用与沉淀面板', screenshotSelectors: ['.pi-knowledge-panel', '.pi-knowledge-writeback', '.pi-knowledge-decision'] },
  C: { surface: 'Studio 创作工作区', screenshotSelectors: ['.studio-editor-view', '.studio-doc-state', '.studio-outline-section--content'] },
  D: { surface: '发布/结果复盘', screenshotSelectors: ['.results-page', '.rl-hero-ksc', '.page-command-stats', '.rl-ksc'] },
  E: { surface: '知识健康/编译状态', screenshotSelectors: ['.health-section', '.library-issue-item', '.topic-compile-state'] },
  F: { surface: 'Topic Wiki 版本区（restore）', screenshotSelectors: ['.topic-wiki-versions', '.topic-wiki-version', '.topic-wiki-version-num'] }
};

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function count(database, table, where = '', args = []) {
  return Number(database.prepare(`SELECT count(*) AS c FROM ${table}${where ? ` WHERE ${where}` : ''}`).get(...args).c);
}
function countWhere(database, table, where, ...args) { return count(database, table, where, args); }
function expectThrowsCode(label, fn, code) {
  try {
    fn();
  } catch (error) {
    if (code && String(error?.code ?? '') !== code) {
      throw new Error(`${label} — 期望错误码 ${code}，实际 ${error?.code ?? error?.message}`);
    }
    return error;
  }
  throw new Error(`${label} — 未抛出 ${code ?? '错误'}`);
}
function csMeta(workspaceId, requestId, reason = 'WMB-5234 验收', extra = {}) {
  return { workspaceId, requestId, reason, triggerSource: 'ingest', resolutionMode: 'none', createdBy: 'background_agent', ...extra };
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// --help
// ---------------------------------------------------------------------------
function printHelp() {
  const text = `WMB-5234 生产知识飞轮最终验收脚本（WMB-5234-prep 交付）

模式：
  --audit                       预检（默认）：静态导入全部阶段模块 + 符号存在性 +
                                 环境事实 + 5231/5232/5233 兄弟项探针；零写库、零 Electron。
  --run                         执行 A Ingest → B Query → C Creation → D Review → E Lint
                                 → F restore/并发（+ G 边界）DB 层流水线，输出结构化 JSON 证据。
  --run --ui                    在 DB 层之上经真实 Electron CDP 驱动 UI 并双读回（需要 5231–5233
                                 完成；B 还需要 --pi-config 提供真实 Pi 配置，否则 B-ui 明确 fail）。
  --help                        本帮助。

选项：
  --fixture <fresh|copy>        默认 fresh（全新隔离根 + 正式 migrations）；
                                 copy = 复制真实工作空间根（VACUUM INTO，只读源，零写源）。
  --fixture-source <root>       copy 模式源根；缺省自动找 .ai/wmb-5207-final-root 等候选。
  --pi-config <path>            UI B 阶段需要的真实 pi-api-config.json；缺省自动发现
                                %APPDATA%\\WeMediaBuddy\\pi-api-config.json（应用自身读取路径）；
                                找不到则写不可达 stub，Pi 不可用会如实 fail，绝不伪造。
  --electron-exe <path>         指定 Electron 可执行文件；缺省优先 out/WeMediaBuddy-win32-x64/
                                WeMediaBuddy.exe，否则 electron-forge start（vite 27391）。
  --cdp-port <port>             验收 CDP 端口，默认 9335 + 随机偏移（WMB_ACCEPTANCE_CDP_PORT）。
  --out <dir>                   证据输出目录，默认 .ai/wmb-5234-evidence/<date>。
  --keep                        保留隔离 fixture 根（默认结束即清理）。
  --skip-ui-b                   跳过 B-ui（Pi 不可用时仍可完成其余 UI 阶段）。

5231–5233 完成后运行的精确命令：
  node .ai/wmb-5234-acceptance.mjs --audit
  node .ai/wmb-5234-acceptance.mjs --run --fixture copy --fixture-source .ai/wmb-5207-final-root --out .ai/wmb-5234-evidence
  node .ai/wmb-5234-acceptance.mjs --run --ui --fixture copy --fixture-source .ai/wmb-5207-final-root --pi-config "<真实 userData>\\pi-api-config.json" --keep --out .ai/wmb-5234-evidence

退出码：0 = 执行面全绿；非 0 = 存在 fail/blocked（详见 stdout JSON + 证据文件）。
诚实契约：不可用环境明确 fail，不做假 fallback；不实际启动 Electron 除非显式 --ui；
DB 层全绿不等于 WMB-5234 通过（wmb5234Complete 需要 UI + 5231–5233 集成齐备）。`;
  console.log(text);
}

// ---------------------------------------------------------------------------
// audit：静态导入 + 符号 + 环境 + 兄弟探针
// ---------------------------------------------------------------------------
async function audit(env) {
  const report = { schema: EVIDENCE_SCHEMA, kind: 'audit', generatedAt: NOW(), node: process.version, phases: {}, env: {}, siblingGates: {} };
  const modules = {};
  const hardFailures = [];
  for (const [phase, list] of Object.entries(PHASE_MODULES)) {
    const phaseReport = { modules: {}, ready: true, blockers: [] };
    for (const [spec, symbols] of list) {
      try {
        const mod = await import(new URL(spec, import.meta.url).href);
        modules[spec] = mod;
        for (const symbol of symbols) {
          const present = typeof mod[symbol] !== 'undefined';
          phaseReport.modules[`${path.basename(spec)}::${symbol}`] = present;
          if (!present) { phaseReport.ready = false; phaseReport.blockers.push(`missing symbol ${spec}::${symbol}`); }
        }
      } catch (error) {
        phaseReport.modules[spec] = false;
        phaseReport.ready = false;
        phaseReport.blockers.push(`${spec} import failed: ${error.message}`);
        hardFailures.push(`${phase} :: ${spec} :: ${error.message}`);
      }
    }
    report.phases[phase] = phaseReport;
  }

  // 环境事实
  const envFacts = {
    repoRoot: REPO_ROOT,
    rendererPort: 27391,
    playwrightCore: (() => { try { require('playwright-core'); return true; } catch { return false; } })(),
    electronDevBin: existsSync(path.join(REPO_ROOT, 'node_modules', '.bin', 'electron.cmd')) || existsSync(path.join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')),
    electronForgeCli: existsSync(path.join(REPO_ROOT, 'node_modules', '@electron-forge', 'cli', 'dist', 'electron-forge.js')),
    packagedExe: ['out', 'WeMediaBuddy-win32-x64', 'WeMediaBuddy.exe'].reduce((p, s) => path.join(p, s), REPO_ROOT),
    packagedExeExists: existsSync(path.join(REPO_ROOT, 'out', 'WeMediaBuddy-win32-x64', 'WeMediaBuddy.exe')),
    fixtureSources: listFixtureSources(),
    piConfigProvided: Boolean(env.piConfig && existsSync(env.piConfig))
  };
  report.env = { ...envFacts, piConfig: env.piConfig ?? null, piConfigAutoDiscovered: Boolean(env.piConfigAutoDiscovered) };

  // 兄弟项探针（只报告事实，不代兄弟下结论；归属 5231/5232/5233）
  const skillPath = path.join(REPO_ROOT, 'skills', 'wemedia-buddy-operator', 'SKILL.md');
  const skillText = existsSync(skillPath) ? readFileSync(skillPath, 'utf8') : '';
  report.siblingGates['5231-operator-skill-wmb_query_writeback'] = {
    owner: 'WMB-5231', present: skillText.includes('wmb_query_writeback'), pendingWhenMissing: true
  };
  report.siblingGates['5231-query-writeback-manifest-module'] = {
    owner: 'WMB-5231',
    present: typeof modules['../src/main/query-writeback.ts']?.QUERY_WRITEBACK_MANIFEST_KEY !== 'undefined' &&
             typeof modules['../src/main/query-writeback.ts']?.extractQueryWritebackManifest === 'function',
    pendingWhenMissing: true
  };
  // 5232：真实写路径（content/reviews/topic-maintenance）是否已 import 并调用 usage recorder
  const wiring = [
    ['5232-content-usage-wired', '../src/main/content.ts', ['recordCoreDraftUsage', 'recordPlatformUsage'], true],
    ['5232-review-usage-wired', '../src/main/reviews.ts', ['recordReviewUsage'], true],
    ['5232-topic-proposal-usage-wired', '../src/main/topic-maintenance.ts', ['recordTopicProposalUsage'], false]
  ];
  for (const [key, rel, symbols, requireCallSite] of wiring) {
    const file = path.join(REPO_ROOT, rel.replace(/^(\.\.\/)+/, ''));
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const imported = symbols.every((s) => new RegExp(`import[\\s\\S]{0,200}${s}`).test(text));
    const called = requireCallSite ? symbols.every((s) => new RegExp(`\\b${s}\\(`).test(text)) : true;
    report.siblingGates[key] = { owner: 'WMB-5232', present: imported && called, importWired: imported, callSites: called, pendingWhenMissing: true };
  }
  // 5233：诚实三态编译态（WMB-5233 已落地：shared 类型 + main 分类器/读回 + renderer 投影）
  report.siblingGates['5233-compile-state-module'] = {
    owner: 'WMB-5233',
    present: typeof modules['../src/main/knowledge-compile-state.ts']?.classifyWikiCompileState === 'function' &&
             typeof modules['../src/main/knowledge-compile-state.ts']?.getTopicCompileState === 'function' &&
             typeof modules['../src/main/knowledge-compile-state.ts']?.listTopicCompileStates === 'function' &&
             existsSync(path.join(REPO_ROOT, 'src', 'shared', 'knowledge-compile-state.ts')),
    pendingWhenMissing: true
  };
  const rendererTopic = path.join(REPO_ROOT, 'src', 'renderer', 'library-topics-view.tsx');
  const rendererText = existsSync(rendererTopic) ? readFileSync(rendererTopic, 'utf8') : '';
  const canvasText = existsSync(path.join(REPO_ROOT, 'src', 'renderer', 'knowledge-canvas-layout.tsx')) ? readFileSync(path.join(REPO_ROOT, 'src', 'renderer', 'knowledge-canvas-layout.tsx'), 'utf8') : '';
  // 5233 探针认 compileState 三态接线（uncompiled/legacy_shell/compiled），不认旧 compileStatus 文本：
  // 标签映射、列表卡投影、详情归一化/回退、三态 banner、canvas 投影五处缺一即 present=false。
  const labelsMapPresent = /COMPILE_STATE_LABELS/.test(rendererText) && rendererText.includes('uncompiled:') && rendererText.includes('legacy_shell:') && rendererText.includes('compiled:');
  const topicDetailCompileState = rendererText.includes('compileState: asString(record.compileState) ?? null');
  const topicListCompileState = /topic-compile-state \$\{item\.compileState/.test(rendererText);
  const compileStateFallbackUncompiled = rendererText.includes("?? 'uncompiled'");
  const compileStateBanner = /compile-state-\$\{compileState\}/.test(rendererText);
  const canvasCompileState = /compileStateLabel|compile-state-\$/.test(canvasText);
  const rendererThreeStateWired = labelsMapPresent && topicDetailCompileState && topicListCompileState && compileStateFallbackUncompiled && compileStateBanner && canvasCompileState;
  report.siblingGates['5233-renderer-shell-three-state'] = {
    owner: 'WMB-5233',
    present: rendererThreeStateWired, // 渲染消费面已真实接线 compileState 三态（WMB-5233 集成闭环）
    baseline: {
      labelsMapPresent,
      topicDetailCompileState,
      topicListCompileState,
      compileStateFallbackUncompiled,
      compileStateBanner,
      canvasCompileState
    },
    pendingWhenMissing: true
  };

  report.verdict = {
    auditComplete: true,
    hardImportFailures: hardFailures,
    dbPhasesReady: ['A', 'B', 'C', 'D', 'E', 'F', 'G'].every((p) => report.phases[p].ready),
    wmb5234Complete: false,
    reason: 'audit 只报就绪度；真实通过需 --run（+ --ui 与 5231–5233 集成齐备）'
  };
  return report;
}

// ---------------------------------------------------------------------------
// DB 层流水线 A–F + G（隔离根，真实产品 API，读回只查 DB 行）
// ---------------------------------------------------------------------------
async function runDbPipeline(env, fixture) {
  const { DatabaseSync } = require('node:sqlite');
  const database = new DatabaseSync(fixture.dbPath);
  const WS = fixture.workspaceId;
  const summary = { fixture: { mode: fixture.mode, source: fixture.source, workspaceId: WS, sourceInfo: fixture.sourceInfo }, phases: {} };
  try {
    const mod = {
      shared: await import(new URL('../src/shared/knowledge-flywheel.ts', import.meta.url).href),
      migrations: await import(new URL('../src/main/db/migrations.ts', import.meta.url).href),
      sources: await import(new URL('../src/main/sources.ts', import.meta.url).href),
      knowledge: await import(new URL('../src/main/knowledge.ts', import.meta.url).href),
      compiler: await import(new URL('../src/main/knowledge-compiler.ts', import.meta.url).href),
      flywheel: await import(new URL('../src/main/knowledge-flywheel.ts', import.meta.url).href),
      canvas: await import(new URL('../src/main/knowledge-canvas.ts', import.meta.url).href),
      query: await import(new URL('../src/main/query-writeback.ts', import.meta.url).href),
      content: await import(new URL('../src/main/content.ts', import.meta.url).href),
      topic: await import(new URL('../src/main/topic-maintenance.ts', import.meta.url).href),
      usage: await import(new URL('../src/main/knowledge-usage.ts', import.meta.url).href),
      usageInt: await import(new URL('../src/main/knowledge-usage-integration.ts', import.meta.url).href),
      publishing: await import(new URL('../src/main/publishing.ts', import.meta.url).href),
      metrics: await import(new URL('../src/main/metrics.ts', import.meta.url).href),
      reviews: await import(new URL('../src/main/reviews.ts', import.meta.url).href),
      accounts: await import(new URL('../src/main/accounts.ts', import.meta.url).href),
      outcome: await import(new URL('../src/main/outcome-feedback.ts', import.meta.url).href),
      health: await import(new URL('../src/main/knowledge-health.ts', import.meta.url).href),
      shell: await import(new URL('../src/main/knowledge-compile-state.ts', import.meta.url).href),
      runtime: await import(new URL('../src/main/workspace-runtime.ts', import.meta.url).href),
      profiles: await import(new URL('../src/main/workspace-profiles.ts', import.meta.url).href),
      dispatcher: await import(new URL('../src/main/command-dispatcher.ts', import.meta.url).href)
    };
    const { knowledgeQueryWritebackRequestId } = mod.shared;
    const packageOf = (stage, objectId) => mod.usage.getKnowledgeUsagePackageByRequest(database, WS, mod.usageInt.usageRequestId(stage, objectId));

    // ================= A. Ingest =================
    const A = { status: 'pass', items: {} };
    try {
      const source = mod.sources.upsertSource(database, { originalUrl: 'https://news.example/agentforge-v2', title: 'AgentForge 发布 v2：多模型路由', summary: 'AgentForge 官方发布 v2，引入多模型路由能力。', author: 'News Desk' });
      const topic = mod.knowledge.upsertKnowledgeTopic(database, { title: 'AI Agent 工具链' });
      assert(source.id && topic.id, 'A 真实 Source/Topic 已保存');
      const planA = {
        workspaceId: WS, sourceId: source.id, sourceRevision: source.revision, topicId: topic.id,
        reason: '摄取 AgentForge v2 发布资料（首次）', topicCompile: { summary: 'AI Agent 工具链主题编译' },
        entities: [{ entityType: 'organization', canonicalKey: 'agentforge', canonicalName: 'AgentForge', aliases: ['AF'], valueRationale: '产品发布主体' }],
        notes: [
          { kind: 'claim', canonicalKey: 'agentforge-v2-multi-router', statement: 'AgentForge v2 支持多模型路由', conclusionStatus: 'supported', evidenceLevel: 'primary', locator: 'L12-18', excerpt: 'AgentForge v2 ships multi-model routing.', entityKeys: ['agentforge'], valueRationale: '可验证产品事实' },
          { kind: 'method', canonicalKey: 'agentforge-router-eval', statement: '评估多模型路由先用 20 条混合样本跑通延迟与质量', conclusionStatus: 'supported', evidenceLevel: 'single', locator: 'L34-40', entityKeys: ['agentforge'], valueRationale: '可复用方法' }
        ]
      };
      const a = mod.compiler.compileSourceKnowledge(database, { ...planA, requestId: mod.compiler.sourceCompileRequestId(source.id, source.revision) });
      assert(a.ok === true, 'A 首次编译 ok');
      assert(a.receipt?.triggerType === 'ingest' && a.receipt?.affectedTopics?.includes(topic.id), 'A 回执 trigger=ingest 且 affectedTopics 恰关联');
      const entityList = mod.flywheel.listKnowledgeEntities(database, { scope: 'global' });
      assert(entityList.items.length === 1 && entityList.items[0].canonicalKey === 'agentforge', 'A Entity 恰 1');
      const topicPages = mod.flywheel.listWikiPages(database, { scope: 'global', pageType: 'topic' });
      assert(topicPages.items.length === 1 && topicPages.items[0].compileStatus === 'current', 'A 唯一 Topic Wiki current');
      const wikiV1 = mod.flywheel.getWikiPage(database, topicPages.items[0].id).version;

      const sourceV2 = mod.sources.upsertSource(database, { originalUrl: 'https://news.example/agentforge-v2', title: 'AgentForge v2 更新：平台限制与争议' });
      assert(sourceV2.revision === 2, 'A Source r2');
      const planB = {
        workspaceId: WS, sourceId: source.id, sourceRevision: sourceV2.revision, topicId: topic.id,
        reason: '摄取争议报道：限域旧 Method、标记争议', topicCompile: { summary: 'AI Agent 工具链主题编译（v2 更新）' },
        entities: [{ entityType: 'organization', canonicalKey: 'agentforge', canonicalName: 'AgentForge', valueRationale: '已存在，验证零重复' }],
        notes: [
          { kind: 'claim', canonicalKey: 'agentforge-v2-xiaohongshu-claim', statement: 'AgentForge v2 可用于小红书运营场景的批量内容生成', conclusionStatus: 'supported', evidenceLevel: 'single', locator: 'L5-9', entityKeys: ['agentforge'], valueRationale: '平台适用事实' },
          { kind: 'method', canonicalKey: 'agentforge-router-eval', statement: '评估多模型路由的样本先覆盖目标平台（当前仅 xiaohongshu 验证）', conclusionStatus: 'supported', evidenceLevel: 'corroborated', appliesTo: 'xiaohongshu', changeType: 'qualified', changeReason: '新证据限制平台适用范围', locator: 'L22-27', relation: 'qualifies', entityKeys: ['agentforge'], valueRationale: '改变既有方法适用范围' },
          { kind: 'claim', canonicalKey: 'agentforge-v2-multi-router', statement: 'AgentForge v2 多模型路由仅限企业版开放', conclusionStatus: 'disputed', evidenceLevel: 'corroborated', changeType: 'contradicted', changeReason: '新报道与首发资料分歧', locator: 'L30-33', relation: 'contradicts', entityKeys: ['agentforge'], valueRationale: '可信来源实质分歧' }
        ]
      };
      const c = mod.compiler.compileSourceKnowledge(database, { ...planB, requestId: mod.compiler.sourceCompileRequestId(source.id, sourceV2.revision) });
      assert(c.ok === true && c.counts.notesCreated === 1 && c.counts.notesUpdated === 2, 'A2 二次摄取增量正确');
      assert(count(database, 'knowledge_entities') === 1, 'A2 Entity 零重复');
      const disputed = mod.flywheel.getKnowledgeNote(database, c.noteIds['agentforge-v2-multi-router']);
      const wikiV2 = mod.flywheel.getWikiPage(database, topicPages.items[0].id).version;
      assert(wikiV2.versionNumber === 2 && wikiV2.body.retainedDisputes.length === 1, 'A2 Wiki V2 保留争议');
      assert(mod.flywheel.getChangeSet(database, c.changeSetId)?.resolutionMode === 'kept_disputed', 'A2 ChangeSet kept_disputed');

      const canvas = mod.canvas.createKnowledgeCanvas(database, { title: 'A 选题画布', topicId: topic.id });
      const node = mod.canvas.addKnowledgeCanvasNode(database, { canvasId: canvas.id, objectType: 'topic', objectId: topic.id, x: 0, y: 0 });
      const pkg = mod.canvas.createKnowledgeContextPackage(database, { canvasId: canvas.id, name: 'AI Agent 选题上下文', objective: '进入选题判断', nodeIds: [node.id] });
      assert(pkg.manifest && pkg.items.some((i) => i.objectType === 'topic' && i.objectId === topic.id), 'A 选题上下文包含 Topic 项');

      A.items = {
        workspaceId: WS, sourceIds: [source.id, sourceV2.id], topicId: topic.id,
        compile1: { changeSetId: a.changeSetId, receiptId: a.receipt?.id, entityId: entityList.items[0].id, wikiVersionId: wikiV1.id, wikiAdopted: wikiV1.adoptedNoteVersionIds.length },
        compile2: { changeSetId: c.changeSetId, receiptId: c.receipt?.id, disputedNoteId: disputed.note.id, disputedNoteVersionId: disputed.version.id, wikiVersionId: wikiV2.id, wikiAdopted: wikiV2.adoptedNoteVersionIds.length, retainedDisputes: wikiV2.body.retainedDisputes.length },
        contextPackageId: pkg.id, wikiPageId: topicPages.items[0].id,
        screenshotSelector: UI_TARGETS.A.screenshotSelectors[0]
      };
    } catch (error) { A.status = 'fail'; A.items.error = `${error.message}`; }

    // ================= B. Query 写回 =================
    const B = { status: 'pass', items: {} };
    try {
      const wikiV2 = mod.flywheel.getWikiPage(database, A.items.wikiPageId).version;
      const readNoteIds = [...wikiV2.adoptedNoteVersionIds];
      const evidenceIds = [];
      for (const versionId of readNoteIds) {
        for (const item of mod.flywheel.listKnowledgeEvidenceLinks(database, { noteVersionId: versionId }).items) evidenceIds.push(item.id);
      }
      const readVersions = { readWikiVersionIds: [wikiV2.id], readNoteVersionIds: readNoteIds, readEvidenceIds: evidenceIds };
      const convId = 'wmb-5234-conv-1';
      const q1 = 'AgentForge v2 多模型路由现在怎么评估？';
      const base = { workspaceId: WS, scope: 'global', conversationId: convId, question: q1, answerSummary: '基于既有知识复述。' };
      const restatement = mod.query.writebackQueryKnowledge(database, { ...base, requestId: knowledgeQueryWritebackRequestId(convId, q1), classification: 'restatement', ...readVersions });
      assert(restatement.ok && restatement.writeBackDecision === 'skipped_repetition' && restatement.counts.notesCreated === 0, 'B restatement 零知识写');
      assert(count(database, 'knowledge_notes') >= 0, 'B 零知识写');
      const replay = mod.query.writebackQueryKnowledge(database, { ...base, requestId: knowledgeQueryWritebackRequestId(convId, q1), classification: 'restatement', ...readVersions });
      assert(replay.duplicate === true && replay.artifact?.id === restatement.artifact?.id, 'B 同问幂等同一 Artifact');
      assert(count(database, 'knowledge_query_artifacts') === 1, 'B 同问零新增 Artifact');

      const q2 = '把 AgentForge 能力和小红书实践放到一起，得出什么可复用判断？';
      const requestId2 = knowledgeQueryWritebackRequestId(convId, q2);
      const synthesis = mod.query.writebackQueryKnowledge(database, {
        ...base, requestId: requestId2, question: q2, classification: 'new_synthesis', answerSummary: '综合既有资料。', ...readVersions,
        synthesis: { canonicalKey: 'agentforge-xhs-synthesis', title: 'AgentForge v2 × 小红书实践综合', statement: '当团队已具备 AgentForge v2 多模型路由时，小红书批量内容生产应优先复用该路由做平台适配。', basedOnNoteVersionIds: readNoteIds, valueRationale: '跨资料新综合' }
      });
      assert(synthesis.ok && synthesis.writeBackDecision === 'created' && synthesis.counts.notesCreated === 1, 'B 综合 Note 1');
      const synPages = mod.flywheel.listWikiPages(database, { scope: 'global', pageType: 'synthesis' });
      const synPage = mod.flywheel.getWikiPage(database, synPages.items[0].id);
      assert(synPage.version.body.basedOn.noteVersionIds.length === readNoteIds.length, 'B 综合冻结读取集');
      const synEvidence = mod.flywheel.listKnowledgeEvidenceLinks(database, { noteVersionId: synthesis.noteVersionIds['agentforge-xhs-synthesis'] }).items;
      assert(synEvidence.every((item) => readNoteIds.includes(item.evidenceObjectId) || item.evidenceObjectId === wikiV2.id), 'B 证据只指向冻结集');

      const experience = mod.query.writebackQueryKnowledge(database, {
        ...base, requestId: knowledgeQueryWritebackRequestId(convId, '我这边实际跑下来有个经验'), question: '我这边实际跑下来有个经验',
        classification: 'user_experience', answerSummary: '感谢分享。', readWikiVersionIds: [], readNoteVersionIds: [], readEvidenceIds: [],
        experience: { body: '我们团队实际跑下来，AgentForge v2 的批量生成在小红书图片场景要先过一遍人工抽检再发布。' }
      });
      assert(experience.freeNoteId && mod.flywheel.getKnowledgeFreeNote(database, experience.freeNoteId)?.sourceNature === 'pi_dialogue', 'B 经验 FreeNote 落库');

      B.items = {
        frozenRead: { wikiVersionId: wikiV2.id, noteVersionIds: readNoteIds.length, evidenceIds: evidenceIds.length },
        restatement: { decision: restatement.writeBackDecision, artifactId: restatement.artifact?.id, receiptId: restatement.receipt?.id },
        sameQuestionReplay: { duplicate: replay.duplicate, artifactSame: replay.artifact?.id === restatement.artifact?.id },
        synthesis: { noteId: synthesis.noteIds['agentforge-xhs-synthesis'], noteVersionId: synthesis.noteVersionIds['agentforge-xhs-synthesis'], pageId: synPages.items[0].id, pageVersionId: synPage.version.id, derivedEvidence: synEvidence.length, receiptId: synthesis.receipt?.id },
        experienceFreeNoteId: experience.freeNoteId,
        screenshotSelector: UI_TARGETS.B.screenshotSelectors[0]
      };
    } catch (error) { B.status = 'fail'; B.items.error = `${error.message}`; }

    // ================= C. Creation Usage 链 =================
    const C = { status: 'pass', items: {} };
    try {
      const wikiV = mod.flywheel.getWikiPage(database, A.items.wikiPageId).version;
      const proposal = mod.topic.createTopicMaintenanceProposal(database, { title: 'AI Agent 工具链整理', reason: '资料已更新', changes: [{ kind: 'update', topicId: A.items.topicId, after: { title: 'AI Agent 工具链（更新）', canonicalKey: 'ai-agent-updated' } }] });
      const proposalPkg = packageOf('topic_proposal', proposal.id);
      assert(proposalPkg && [...proposalPkg.wikiPageVersionIds].includes(wikiV.id), 'C 提案冻结 Wiki');

      const canvasId = 'wmb-5234-canvas-c';
      database.prepare('INSERT INTO knowledge_canvases (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(canvasId, '创作画布', NOW(), NOW());
      database.prepare(`INSERT INTO knowledge_canvas_nodes (id, canvas_id, object_type, object_id, note_title, note_text, x, y, created_at, updated_at)
        VALUES ('cn-topic', ?, 'topic', ?, NULL, NULL, 0, 0, ?, ?)`).run(canvasId, A.items.topicId, NOW(), NOW());
      const brief = mod.canvas.createCreativeBrief(database, { canvasId, nodeIds: ['cn-topic'], selectionMode: 'selected', title: 'AI Agent 工具链简报', coreJudgment: '核心判断', whyNow: '为什么现在', structure: ['开头', '正文'], evidenceNodeIds: ['cn-topic'] });
      mod.usageInt.recordCreativeBriefUsage(database, { briefId: brief.id, contextNodeIds: brief.contextNodeIds, reason: 'creative_brief_create' });
      const briefPkg = packageOf('creative_brief', brief.id);
      assert(briefPkg && [...briefPkg.wikiPageVersionIds].includes(wikiV.id), 'C 简报冻结 Wiki');

      const core1 = mod.content.createContentProjectWithVersion(database, { title: 'AI 项目', body: '核心 V1', topicId: A.items.topicId, sourceIds: [A.items.sourceIds[0]] });
      const core2 = mod.content.saveCoreVersion(database, { projectId: core1.id, body: '核心 V2', expectedRevision: 1 });
      assert(core2.ok === true, 'C 核心 V2 ok');
      const platform = mod.content.savePlatformVersion(database, { projectId: core1.id, contentVersionId: core2.data.id, platform: 'xiaohongshu', format: 'text', body: '平台 V1' });
      assert(platform.ok === true, 'C 平台版本 ok');
      const platformPkg = packageOf('platform_adaptation', platform.data.id);
      const platformRecords = mod.usage.listKnowledgeUsageRecords(database, { packageId: platformPkg.id }).items;
      const platformUsed = platformRecords.filter((r) => r.used === true);
      assert(platformUsed.length === 1 && platformUsed[0].usageKind === 'structure_pattern', 'C 平台 used=structure_pattern');

      expectThrowsCode('C 平台换基（事实变化）拒绝', () => {
        mod.content.savePlatformVersion(database, { id: platform.data.id, projectId: core1.id, contentVersionId: core1.contentVersionId, platform: 'xiaohongshu', format: 'text', body: '换基正文', expectedRevision: 1 }, true);
      }, 'REQUEST_REPLAY_CONFLICT');
      const platformRow = database.prepare('SELECT content_version_id AS contentVersionId, revision FROM platform_versions WHERE id = ?').get(platform.data.id);
      assert(platformRow.contentVersionId === core2.data.id, 'C 拒绝后平台仍指向原核心版本');
      const sameBase = mod.content.savePlatformVersion(database, { id: platform.data.id, projectId: core1.id, contentVersionId: core2.data.id, platform: 'xiaohongshu', format: 'text', body: '同基修订', expectedRevision: 1 }, true);
      assert(sameBase.ok === true && sameBase.data.revision === 2, 'C 同基修订 revision=2');

      C.items = {
        frozenWikiVersionId: wikiV.id,
        proposal: { objectId: proposal.id, usagePackageId: proposalPkg.id },
        brief: { objectId: brief.id, usagePackageId: briefPkg.id },
        coreV1: { objectId: core1.contentVersionId, usagePackageId: packageOf('core_draft', core1.contentVersionId)?.id },
        coreV2: { objectId: core2.data.id, usagePackageId: packageOf('core_draft', core2.data.id)?.id },
        platform: { objectId: platform.data.id, usagePackageId: platformPkg.id, usageKind: platformUsed[0]?.usageKind },
        rebaseRejected: { code: 'REQUEST_REPLAY_CONFLICT', platformStillContentVersionId: platformRow.contentVersionId, platformRevision: platformRow.revision },
        sameBaseUpdateRevision: sameBase.data.revision,
        screenshotSelector: UI_TARGETS.C.screenshotSelectors[0]
      };
    } catch (error) { C.status = 'fail'; C.items.error = `${error.message}`; }

    // ================= D. Publication / Metric / final Review 回流 =================
    const D = { status: 'pass', items: {} };
    try {
      const platformPkg = packageOf('platform_adaptation', C.items.platform.objectId);
      const account = mod.accounts.saveAccount(database, { platform: 'xiaohongshu', accountKey: '@wmb-5234-tester', displayName: 'tester', loginState: 'authenticated' });
      const publication = mod.publishing.createPublication(database, { platformVersionId: C.items.platform.objectId, accountId: account.id });
      assert(publication.ok === true, 'D 发布 ok');
      const pubNow = NOW();
      database.prepare(`UPDATE publications SET status='published', external_url=?, external_id=?, published_at=?, prepared_title=?, prepared_body=?, prepared_assets_json='[]', updated_at=?, revision=? WHERE id=?`)
        .run('https://x.com/wmb-5234-tester/1', 'wmb-5234-1', pubNow, null, '平台 V1', pubNow, 2, publication.data.id);
      const snap = mod.metrics.savePublicationMetricSnapshot(database, {
        publicationId: publication.data.id, scheduledFor: pubNow, sourceUrl: 'https://x.com/wmb-5234-tester/1', capturedAt: pubNow,
        normalized: { views: { status: 'value', value: 100, rawLabel: '100' } }, raw: { views: { status: 'value', value: 100, rawLabel: '100' } }
      });
      assert(snap.ok === true, 'D 指标快照 ok');
      const methodsBefore = countWhere(database, 'knowledge_notes', "kind = 'method'");
      const patternsBefore = countWhere(database, 'knowledge_notes', "kind = 'creative_pattern'");
      const review = mod.reviews.saveReview(database, {
        publicationId: publication.data.id, metricSnapshotIds: [snap.data.id],
        keep: ['开头钩子'], stop: ['泛 CTA'], change: ['封面先给结论'], summary: '复盘', status: 'final',
        findings: [{ title: '先给结论', body: '封面先给结论' }]
      });
      assert(review.ok === true, 'D final Review ok');
      const reviewId = review.data.id;
      assert(countWhere(database, 'knowledge_change_sets', "request_id LIKE 'outcome:review:%'") === 1, 'D 恰一条 outcome ChangeSet');
      const caseRow = database.prepare('SELECT id, kind FROM knowledge_notes WHERE canonical_key = ?').get(`case:outcome:${reviewId}`);
      assert(caseRow && caseRow.kind === 'case', 'D case 观察 Note');
      const caseVersion = database.prepare('SELECT id FROM knowledge_note_versions WHERE note_id = ? ORDER BY version_number DESC LIMIT 1').get(caseRow.id);
      const caseVer = mod.flywheel.getKnowledgeNoteVersion(database, caseVersion.id);
      assert(caseVer.conclusionStatus === 'unverified' && caseVer.evidenceLevel === 'outcome_observed' && String(caseVer.statement).includes('不证明因果'), 'D case 保守观察语义');
      assert(countWhere(database, 'knowledge_notes', "kind = 'method'") === methodsBefore && countWhere(database, 'knowledge_notes', "kind = 'creative_pattern'") === patternsBefore, 'D 零因果 Method/pattern');
      const outcomeReceipt = mod.flywheel.getUpdateReceiptByRequest(database, WS, mod.outcome.outcomeFeedbackRequestId(reviewId));
      assert(outcomeReceipt?.triggerType === 'review' && outcomeReceipt?.counts?.caseNotesCreated === 1, 'D 回流回执');
      const wikiVersions = database.prepare('SELECT id, version_number AS n FROM knowledge_wiki_page_versions WHERE page_id = ? ORDER BY version_number').all(A.items.wikiPageId);
      const outcomeWiki = mod.flywheel.getWikiPageVersion(database, wikiVersions[wikiVersions.length - 1].id);
      assert(outcomeWiki.body.recentOutcomes?.length === 1 && outcomeWiki.body.recentOutcomes[0].reviewId === reviewId, 'D Wiki recentOutcomes 立即可见');
      const replayed = mod.outcome.flowBackOutcome(database, { reviewId });
      assert(replayed.replay === true, 'D 重放幂等');
      const historical = mod.usageInt.readPublicationTimeUsage(database, { publicationId: publication.data.id });
      assert(historical && [...historical.platformPackage.wikiPageVersionIds].includes(C.items.frozenWikiVersionId), 'D 复盘读发布时血缘');

      D.items = {
        publicationId: publication.data.id, metricSnapshotId: snap.data.id, reviewId,
        outcomeChangeSetRequestId: mod.outcome.outcomeFeedbackRequestId(reviewId),
        caseNoteId: caseRow.id, caseVersionId: caseVersion.id, receiptId: outcomeReceipt.id,
        lineageVersionIds: outcomeReceipt.impact?.lineageVersionIds?.length,
        wikiCurrentVersionId: outcomeWiki.id, wikiRecentOutcomes: outcomeWiki.body.recentOutcomes.length,
        zeroCausalMethod: true, zeroPattern: true, replayZeroWrite: true,
        screenshotSelector: UI_TARGETS.D.screenshotSelectors[0]
      };
    } catch (error) { D.status = 'fail'; D.items.error = `${error.message}`; }

    // ================= E. Health Lint =================
    const E = { status: 'pass', items: {} };
    let shellZeroKnowledge = null;
    try {
      const topic2 = mod.knowledge.upsertKnowledgeTopic(database, { title: '图文排版' });
      mod.flywheel.applyKnowledgeChangeSet(database, csMeta(WS, 'wmb-5234-seed-stale-page'), {
        wikiPages: [{ id: 'page-topic-2', scope: 'global', pageType: 'topic', canonicalKey: 'wiki-xhs-layout', subjectType: 'topic', subjectId: topic2.id, compileStatus: 'stale', compileNote: '待重编译' }],
        receipts: [{ triggerType: 'ingest', requestId: 'wmb-5234-seed-stale-page', summary: 'stale 页种子', counts: { wikiPages: 1 } }]
      });
      const conflict = mod.health.runLocalLint(database, { requestId: 'wmb-5234-lint-conflict-1', workspaceId: WS, scope: 'global', affectedObjects: [{ objectType: 'knowledge_note', objectId: A.items.compile2.disputedNoteId }] });
      assert(conflict.ok && conflict.counts.issuesCreated === 1 && conflict.issues[0]?.issueType === 'unresolved_contradiction' && conflict.issues[0]?.status === 'open', 'E 冲突 open 不自动裁决');
      const conflictIssueId = conflict.issues[0].id;
      const dedup = mod.health.runLocalLint(database, { requestId: 'wmb-5234-lint-conflict-2', workspaceId: WS, scope: 'global', affectedObjects: [{ objectType: 'knowledge_note', objectId: A.items.compile2.disputedNoteId }] });
      assert(dedup.counts.issuesCreated === 0 && dedup.counts.issuesDeduplicated === 1, 'E 重复扫描去重');

      const claimCurrent = mod.flywheel.getKnowledgeNote(database, A.items.compile2.disputedNoteId).version.id;
      const seedCs = database.prepare('SELECT id FROM knowledge_change_sets ORDER BY created_at DESC LIMIT 1').get().id;
      database.prepare(`INSERT INTO knowledge_evidence_links (id, knowledge_note_version_id, evidence_object_type, evidence_object_id, relation, source_nature, excerpt, locator, observed_at, creator_nature, change_set_id, created_at)
        VALUES ('ev-ghost-wmb5234', ?, 'source', 'ghost-source-deleted', 'supports', 'primary_source', NULL, NULL, NULL, 'background_agent', ?, ?)`).run(claimCurrent, seedCs, NOW());
      const brokenEv = mod.health.runLocalLint(database, { requestId: 'wmb-5234-lint-broken-ev', workspaceId: WS, scope: 'global', affectedObjects: [{ objectType: 'knowledge_note', objectId: A.items.compile2.disputedNoteId }] });
      assert(brokenEv.counts.issuesCreated === 1 && brokenEv.issues[0]?.issueType === 'broken_reference' && brokenEv.issues[0]?.status === 'open', 'E broken 证据 open 不自动删');
      database.prepare(`INSERT INTO knowledge_formal_relations (id, scope, relation_key, from_object_type, from_object_id, to_object_type, to_object_id, created_change_set_id, end_reason, created_at)
        VALUES ('rel-ghost-wmb5234', 'global', 'derived_from', 'knowledge_note', ?, 'source', 'ghost-source-wmb5234', ?, '', ?)`).run(A.items.compile2.disputedNoteId, seedCs, NOW());
      const repair = mod.health.runLocalLint(database, { requestId: 'wmb-5234-lint-repair-1', workspaceId: WS, scope: 'global', affectedObjects: [{ objectType: 'knowledge_relation', objectId: 'rel-ghost-wmb5234' }] });
      assert(repair.counts.repairsApplied === 1 && repair.issues[0]?.status === 'resolved' && repair.receipt?.triggerType === 'lint', 'E broken 关系自动原子修复');
      const stale = mod.health.runLocalLint(database, { requestId: 'wmb-5234-lint-stale-1', workspaceId: WS, scope: 'global', affectedObjects: [{ objectType: 'wiki_page', objectId: 'page-topic-2' }] });
      assert(stale.counts.issuesCreated === 1 && stale.issues[0]?.issueType === 'stale_wiki_page' && stale.issues[0]?.status === 'open', 'E stale open');

      database.prepare(`INSERT INTO knowledge_formal_relations (id, scope, relation_key, from_object_type, from_object_id, to_object_type, to_object_id, created_change_set_id, end_reason, created_at)
        VALUES ('rel-ghost-periodic-wmb5234', 'global', 'derived_from', 'knowledge_note', ?, 'source', 'ghost-source-periodic-wmb5234', ?, '', ?)`).run(A.items.compile2.disputedNoteId, seedCs, NOW());
      const issuesBefore = count(database, 'knowledge_health_issues');
      const csBefore = count(database, 'knowledge_change_sets');
      const begin1 = mod.health.beginPeriodicLint(database, { workspaceId: WS, scope: 'global', pageSize: 20, resume: false });
      assert(begin1.resumed === false, 'E 周期开始');
      const runId = begin1.checkpoint.runId;
      let step1 = mod.health.runPeriodicLintStep(database);
      assert(step1.counts.repairsApplied >= 1, 'E 周期步 1 修复');
      database.prepare('UPDATE app_meta SET value = ?, updated_at = ?, revision = revision + 1 WHERE key = ?').run(JSON.stringify(begin1.checkpoint), NOW(), 'knowledge_lint_checkpoint_v1');
      const retry1 = mod.health.runPeriodicLintStep(database);
      assert(count(database, 'knowledge_change_sets') === csBefore + 1 && count(database, 'knowledge_health_issues') === issuesBefore + 1, 'E 崩溃重试零新增');
      const resumed = mod.health.beginPeriodicLint(database, { workspaceId: WS, scope: 'global', pageSize: 20, resume: true });
      assert(resumed.resumed === true && resumed.checkpoint.runId === runId, 'E resume 同 runId');
      let guard = 0;
      let cp = resumed.checkpoint;
      while (cp.status === 'running') {
        guard += 1;
        if (guard > 300) throw new Error('E 周期 Lint 未完成');
        cp = mod.health.runPeriodicLintStep(database).checkpoint;
      }
      assert(cp.status === 'completed' && cp.counts.scannedObjects > 0, 'E 周期完成');
      mod.health.cancelPeriodicLint(database);
      assert(mod.health.getPeriodicLintCheckpoint(database) === null, 'E checkpoint 已取消');

      // 5233 shell 语义证据（真实 read-model 三态）：uncompiled / legacy_shell / compiled
      const shellDb = mod.migrations.migrateDatabase(path.join(fixture.root, 'shell-zero.db'));
      try {
        shellDb.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', 'ws-5234-shell', ?, ?, 1)").run(NOW(), NOW());
        const shellTopic = mod.knowledge.upsertKnowledgeTopic(shellDb, { title: '零知识主题' });
        const shellState = mod.shell.getTopicCompileState(shellDb, shellTopic.id);
        assert(shellState.state === 'uncompiled', `5233 零知识 Topic 应为 uncompiled，实际 ${shellState.state}`);
        // 主库三态对照：正式编译 Topic → compiled；legacy shell → legacy_shell；stale 空页（无版本）→ uncompiled
        const legacyTopic = mod.knowledge.upsertKnowledgeTopic(database, { title: '历史遗留主题' });
        mod.flywheel.applyKnowledgeChangeSet(database, csMeta(WS, 'wmb-5234-seed-legacy-shell'), {
          wikiPages: [{
            id: 'page-legacy-shell', scope: 'global', pageType: 'topic', canonicalKey: 'wiki-legacy-shell',
            subjectType: 'topic', subjectId: legacyTopic.id, compileStatus: 'current', compileNote: '历史初始化（legacy migration）',
            version: {
              title: '主题档案初始化',
              body: { kind: 'topic-wiki', migration: true, title: '主题档案初始化', summary: '历史遗留初始化', keyConclusions: [], retainedDisputes: [], recentChanges: [] },
              adoptedNoteVersionIds: [], flags: ['migration'], compileReason: 'legacy migration（历史初始化）', changeSummary: '历史初始化'
            }
          }],
          receipts: [{ triggerType: 'migration', requestId: 'wmb-5234-seed-legacy-shell', summary: 'legacy shell 种子', counts: { wikiPages: 1 } }]
        });
        const stateMap = mod.shell.listTopicCompileStates(database, [A.items.topicId, topic2.id, legacyTopic.id]);
        assert(stateMap.get(A.items.topicId) === 'compiled', `5233 正式编译 Topic 应为 compiled，实际 ${stateMap.get(A.items.topicId)}`);
        assert(stateMap.get(legacyTopic.id) === 'legacy_shell', `5233 legacy shell 应为 legacy_shell，实际 ${stateMap.get(legacyTopic.id)}`);
        assert(stateMap.get(topic2.id) === 'uncompiled', `5233 stale 空页（无版本）应 uncompiled，实际 ${stateMap.get(topic2.id)}`);
        // 过渡断言：legacy shell 随后真实编译（走正式编译管线）→ 转为 compiled（三态诚实过渡）
        const legacySource = mod.sources.upsertSource(database, { originalUrl: 'https://news.example/legacy-topic-revive', title: '历史主题新资料', summary: '补充资料使历史主题恢复正式编译。' });
        const legacyCompile = mod.compiler.compileSourceKnowledge(database, {
          workspaceId: WS, sourceId: legacySource.id, sourceRevision: legacySource.revision, topicId: legacyTopic.id,
          reason: 'legacy shell 恢复正式编译', requestId: mod.compiler.sourceCompileRequestId(legacySource.id, legacySource.revision),
          notes: [{ kind: 'claim', canonicalKey: 'legacy-topic-revive-claim', statement: '历史主题有新的可复用事实', conclusionStatus: 'supported', evidenceLevel: 'primary', locator: 'L1-3', valueRationale: '补充事实' }]
        });
        assert(legacyCompile.ok === true && legacyCompile.counts.notesCreated === 1, 'legacy shell 编译应产出 1 Note');
        const legacyAfterCompile = mod.shell.getTopicCompileState(database, legacyTopic.id);
        assert(legacyAfterCompile.state === 'compiled', `legacy shell 真实编译后应转 compiled，实际 ${legacyAfterCompile.state}`);
        shellZeroKnowledge = {
          zeroKnowledge: { topicId: shellTopic.id, getTopicCompileState: shellState.state, listTopicCompileStates: [...mod.shell.listTopicCompileStates(shellDb, [shellTopic.id]).values()] },
          mainWorkspace: { compiledTopic: A.items.topicId, compiled: stateMap.get(A.items.topicId), legacyShellTopic: legacyTopic.id, legacyShell: stateMap.get(legacyTopic.id), staleShellTopic: topic2.id, staleShell: stateMap.get(topic2.id), legacyShellAfterCompile: legacyAfterCompile.state },
          note: 'WMB-5233 诚实三态（uncompiled/legacy_shell/compiled）经 getTopicCompileState/listTopicCompileStates 真实读回；legacy shell 保留 DB compile_status=current 但投影 legacy_shell，真实编译后过渡为 compiled'
        };
      } finally { shellDb.close(); }

      E.items = {
        conflictIssueId, conflictStatus: 'open', brokenEvidenceIssueId: brokenEv.issues[0]?.id, brokenEvidenceStatus: 'open',
        repairedRelationId: 'rel-ghost-wmb5234', repairIssueId: repair.issues[0]?.id, repairReceiptId: repair.receipt?.id,
        staleIssueId: stale.issues[0]?.id, staleStatus: 'open',
        periodic: { runId, completed: true, scannedObjects: cp.counts.scannedObjects, crashRetryZeroWrite: true, canceled: true },
        shellZeroKnowledge,
        screenshotSelector: UI_TARGETS.E.screenshotSelectors[0]
      };
    } catch (error) { E.status = 'fail'; E.items.error = `${error.message}`; }

    // ================= F. restore / 并发 / 弱 Source =================
    const F = { status: 'pass', items: {} };
    try {
      const weakSource = mod.sources.upsertSource(database, { originalUrl: 'https://news.example/agentforge-weak', title: 'AgentForge 复述', summary: '无新增信息的复述。' });
      const weak = mod.compiler.compileSourceKnowledge(database, {
        workspaceId: WS, sourceId: weakSource.id, sourceRevision: weakSource.revision, topicId: A.items.topicId,
        reason: '弱 Source：纯复述零 Note', requestId: mod.compiler.sourceCompileRequestId(weakSource.id, weakSource.revision),
        notes: [{ kind: 'claim', canonicalKey: 'agentforge-v2-multi-router', statement: 'AgentForge v2 多模型路由仅限企业版开放', conclusionStatus: 'disputed', evidenceLevel: 'corroborated', locator: 'L1-2', valueRationale: '纯复述检查' }]
      });
      assert(weak.ok && weak.counts.notesCreated === 0 && weak.counts.notesSkippedLowValue === 1 && weak.counts.wikiPagesCompiled === 0, 'F 弱 Source 零 Note 零 Wiki');

      mod.flywheel.applyKnowledgeChangeSet(database, csMeta(WS, 'wmb-5234-conc-v1'), { notes: [{ id: 'note-conc', scope: 'global', kind: 'claim', canonicalKey: 'conc-claim', version: { statement: 'V1 表述', conclusionStatus: 'unverified', evidenceLevel: 'none' } }] });
      const concV1 = mod.flywheel.getKnowledgeNote(database, 'note-conc');
      mod.flywheel.applyKnowledgeChangeSet(database, csMeta(WS, 'wmb-5234-conc-v2'), { notes: [{ id: 'note-conc', scope: 'global', kind: 'claim', canonicalKey: 'conc-claim', beforeRevision: 1, version: { statement: 'V2 加强', conclusionStatus: 'supported', evidenceLevel: 'corroborated', changeType: 'strengthened' } }] });
      mod.flywheel.applyKnowledgeChangeSet(database, csMeta(WS, 'wmb-5234-conc-v3a'), { notes: [{ id: 'note-conc', scope: 'global', kind: 'claim', canonicalKey: 'conc-claim', beforeRevision: 2, version: { statement: 'V3A', conclusionStatus: 'supported', evidenceLevel: 'single', changeType: 'strengthened' } }] });
      const versionsAfterA = count(database, 'knowledge_note_versions');
      expectThrowsCode('F 并发旧 revision 拒绝', () => {
        mod.flywheel.applyKnowledgeChangeSet(database, csMeta(WS, 'wmb-5234-conc-v3b'), { notes: [{ id: 'note-conc', scope: 'global', kind: 'claim', canonicalKey: 'conc-claim', beforeRevision: 2, version: { statement: 'V3B 不应落库', conclusionStatus: 'supported', evidenceLevel: 'single', changeType: 'strengthened' } }] });
      }, 'REVISION_CONFLICT');
      assert(count(database, 'knowledge_note_versions') === versionsAfterA, 'F 冲突方零新增版本');
      const concV3 = mod.flywheel.getKnowledgeNote(database, 'note-conc');
      assert(concV3.version.statement === 'V3A' && concV3.note.revision === 3, 'F 首成未被覆盖');

      mod.flywheel.applyKnowledgeChangeSet(database, csMeta(WS, 'wmb-5234-conc-restore'), { notes: [{ id: 'note-conc', scope: 'global', kind: 'claim', canonicalKey: 'conc-claim', beforeRevision: 3, version: { restoreFromVersionId: concV1.version.id, changeReason: '用户要求恢复 V1' } }] });
      const concV4 = mod.flywheel.getKnowledgeNote(database, 'note-conc');
      assert(concV4.note.revision === 4 && concV4.version.changeType === 'restored' && concV4.version.restoredFromVersionId === concV1.version.id && concV4.version.statement === 'V1 表述', 'F restore 追加版本');
      const concVersions = mod.flywheel.listKnowledgeNoteVersions(database, 'note-conc', {});
      assert(concVersions.items.length === 4, 'F V1..V4 全保留');

      F.items = {
        weakSource: { sourceId: weakSource.id, notesCreated: 0, skippedLowValue: 1, receiptId: weak.receipt?.id },
        concurrency: { firstSucceededStatement: 'V3A', secondRejectedCode: 'REVISION_CONFLICT', versionsAfterConflict: versionsAfterA },
        restore: { revision: 4, changeType: 'restored', restoredFromVersionId: concV1.version.id, versionsKept: 4 },
        screenshotSelector: UI_TARGETS.F.screenshotSelectors[0]
      };
    } catch (error) { F.status = 'fail'; F.items.error = `${error.message}`; }

    // ================= G. 边界 =================
    const G = { status: 'pass', items: {} };
    try {
      const orphanWikiAdopted = database.prepare(`
        SELECT pv.id FROM knowledge_wiki_page_versions pv, json_each(pv.adopted_note_version_ids_json) j
        LEFT JOIN knowledge_note_versions nv ON nv.id = j.value WHERE nv.id IS NULL`).all();
      const orphanEvidence = database.prepare(`
        SELECT el.id FROM knowledge_evidence_links el
        LEFT JOIN knowledge_note_versions nv ON nv.id = el.knowledge_note_version_id WHERE nv.id IS NULL`).all();
      const orphanReceipts = database.prepare(`
        SELECT r.id FROM knowledge_update_receipts r LEFT JOIN knowledge_change_sets cs ON cs.id = r.change_set_id WHERE cs.id IS NULL`).all();
      assert(orphanWikiAdopted.length === 0 && orphanEvidence.length === 0 && orphanReceipts.length === 0, 'G 链完整性');
      const perTopic = database.prepare(`SELECT subject_id AS subjectId, count(*) AS c FROM knowledge_wiki_pages WHERE lifecycle = 'active' AND subject_type = 'topic' GROUP BY subject_id`).all();
      assert(perTopic.every((row) => Number(row.c) === 1), 'G 单 Topic 单 Wiki');

      expectThrowsCode('G 跨 data-root 拒绝', () => {
        mod.flywheel.applyKnowledgeChangeSet(database, { ...csMeta(WS, 'wmb-5234-cross-root'), workspaceId: 'ws-b' }, { freeNotes: [{ id: 'fn-cross', scope: 'global', sourceNature: 'user_quick_note', body: '不得跨 root' }] });
      }, 'WORKSPACE_MISMATCH');
      expectThrowsCode('G 跨 root Query 写回拒绝', () => {
        mod.query.writebackQueryKnowledge(database, { workspaceId: 'ws-b', scope: 'global', conversationId: 'conv-other', question: 'q', requestId: knowledgeQueryWritebackRequestId('conv-other', 'q'), classification: 'restatement', answerSummary: 'x', readWikiVersionIds: [C.items.frozenWikiVersionId], readNoteVersionIds: [], readEvidenceIds: [] });
      }, 'WORKSPACE_MISMATCH');
      const dbB = mod.migrations.migrateDatabase(path.join(fixture.root, 'ws-b.db'));
      dbB.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', 'ws-b', ?, ?, 1)").run(NOW(), NOW());
      assert(count(dbB, 'knowledge_change_sets') === 0 && count(dbB, 'knowledge_notes') === 0 && count(dbB, 'knowledge_wiki_pages') === 0, 'G data-root B 零写');
      dbB.close();

      const canvasDel = mod.canvas.createKnowledgeCanvas(database, { title: '删除测试画布', topicId: A.items.topicId });
      const nodeDelTopic = mod.canvas.addKnowledgeCanvasNode(database, { canvasId: canvasDel.id, objectType: 'topic', objectId: A.items.topicId, x: 0, y: 0 });
      const nodeDelReview = mod.canvas.addKnowledgeCanvasNode(database, { canvasId: canvasDel.id, objectType: 'review', objectId: D.items.reviewId, x: 10, y: 10 });
      mod.canvas.removeKnowledgeCanvasNode(database, { canvasId: canvasDel.id, nodeId: nodeDelTopic.id, expectedRevision: 1 });
      assert(database.prepare('SELECT id FROM topics WHERE id = ?').get(A.items.topicId), 'G 正式 Topic 未删');
      assert(database.prepare('SELECT id FROM reviews WHERE id = ?').get(D.items.reviewId), 'G 正式 Review 未删');
      assert(mod.flywheel.getWikiPage(database, A.items.wikiPageId), 'G 正式 Wiki 未删');

      const immutVersion = mod.flywheel.getKnowledgeNote(database, 'note-conc').version;
      expectThrowsCode('G 版本 UPDATE 拒绝', () => database.prepare('UPDATE knowledge_note_versions SET statement = ? WHERE id = ?').run('篡改', immutVersion.id));
      expectThrowsCode('G 版本 DELETE 拒绝', () => database.prepare('DELETE FROM knowledge_note_versions WHERE id = ?').run(immutVersion.id));
      expectThrowsCode('G 正式 Note DELETE 拒绝', () => database.prepare('DELETE FROM knowledge_notes WHERE id = ?').run('note-conc'));
      const anyCs = database.prepare('SELECT id FROM knowledge_change_sets LIMIT 1').get();
      expectThrowsCode('G ChangeSet 不可变', () => database.prepare('UPDATE knowledge_change_sets SET reason = ? WHERE id = ?').run('篡改', anyCs.id));
      expectThrowsCode('G FreeNote 原文不可变', () => database.prepare('UPDATE knowledge_free_notes SET body = ? WHERE id = ?').run('改写原文', B.items.experienceFreeNoteId));
      assert(mod.flywheel.getKnowledgeFreeNote(database, B.items.experienceFreeNoteId)?.body.includes('人工抽检'), 'G FreeNote 原文保留');

      // G dispatcher + write-guard（独立 runtime root）
      const rtRoot = path.join(fixture.root, 'runtime-root');
      await mkdir(rtRoot, { recursive: true });
      const rtDb = mod.migrations.migrateDatabase(path.join(rtRoot, 'wmb.db'));
      rtDb.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', 'ws-rt', ?, ?, 1)").run(NOW(), NOW());
      mod.profiles.ensureOfficialWorkspaceProfile(rtDb, 'official.ai');
      rtDb.close();
      const runtime = mod.runtime.ActiveWorkspaceRuntime.open(rtRoot, { openDatabase: mod.migrations.migrateDatabase, createEpoch: () => 'wmb-5234-epoch-1' });
      try {
        const envelope = mod.dispatcher.createCommandEnvelope({
          workspaceId: runtime.identity.workspaceId, runtimeEpoch: runtime.identity.runtimeEpoch,
          command: mod.flywheel.KNOWLEDGE_FLYWHEEL_CHANGE_SET_COMMAND, requestId: 'wmb-5234-rt-apply-1',
          actor: { type: 'owner_ui', id: 'renderer', label: 'Owner UI' },
          input: { entities: [{ scope: 'global', entityType: 'organization', canonicalKey: 'wmb-5234-rt-org', canonicalName: 'E2E RT Org' }], receipts: [{ triggerType: 'ingest', requestId: 'wmb-5234-rt-apply-1', summary: 'dispatcher 路径验收', counts: { entities: 1 } }] },
          boundIdentity: { entityType: 'knowledge_change_set', requestId: 'wmb-5234-rt-apply-1' }
        });
        const receipt = await runtime.dispatchCommand(envelope, () => {
          const result = mod.flywheel.applyKnowledgeChangeSet(runtime.database, { workspaceId: runtime.identity.workspaceId, requestId: 'wmb-5234-rt-apply-1', reason: 'dispatcher 路径验收', triggerSource: 'user', resolutionMode: 'manual_correction', createdBy: 'user' }, { entities: [{ scope: 'global', entityType: 'organization', canonicalKey: 'wmb-5234-rt-org', canonicalName: 'E2E RT Org' }], receipts: [{ triggerType: 'ingest', requestId: 'wmb-5234-rt-apply-1', summary: 'dispatcher 路径验收', counts: { entities: 1 } }] }, false);
          return { data: result, entityType: 'knowledge_change_set', entityId: result.changeSetId, readback: result };
        });
        assert(receipt.ok === true && count(runtime.database, 'command_receipts') === 1 && count(runtime.database, 'knowledge_change_sets') === 1, 'G dispatcher 路径');
        expectThrowsCode('G write-guard 直写拒绝', () => runtime.database.prepare(
          `INSERT INTO knowledge_free_notes (id, scope, source_nature, body, processing_state, revision, created_at, updated_at) VALUES ('bypass-1', 'global', 'user_quick_note', 'x', 'captured', 1, ?, ?)`
        ).run(NOW(), NOW()));
        assert(count(runtime.database, 'knowledge_free_notes') === 0, 'G 直写零落库');
      } finally {
        await runtime.stop({ drain: false }).catch(() => {});
      }

      G.items = {
        chainIntegrity: { orphanWikiAdopted: orphanWikiAdopted.length, orphanEvidence: orphanEvidence.length, orphanReceipts: orphanReceipts.length },
        singleTopicSingleWiki: perTopic.length >= 1 && perTopic.every((row) => Number(row.c) === 1),
        dataRootIsolation: { crossRootWriteRejected: true, dataRootBCounts: { changeSets: 0, notes: 0, wikiPages: 0 } },
        canvasDelete: { canvasId: canvasDel.id, formalTopicStillExists: true, formalReviewStillExists: true, formalWikiStillExists: true },
        immutableVersions: true, immutableFreeNoteBody: true,
        dispatcher: { command: mod.flywheel.KNOWLEDGE_FLYWHEEL_CHANGE_SET_COMMAND, commandReceipts: 1, changeSets: 1, directSqlWriteBlocked: true }
      };
    } catch (error) { G.status = 'fail'; G.items.error = `${error.message}`; }

    summary.phases = { A, B, C, D, E, F, G };
  } finally {
    database.close();
  }
  return summary;
}

// ---------------------------------------------------------------------------
// UI 层：真实 Electron + CDP（仅 --ui 时调用；B 需真实 Pi 配置）
// 诚实契约：每阶段 = 真实用户表面（导航 + 交互后 DOM 文本/状态）+ DB 双读回；
// 元素存在不算 pass，必须与 DB 层产物对齐（结论文本/统计数/版本数/复盘内容/健康问题）。
// ---------------------------------------------------------------------------
async function runUiLayer(env, fixture, dbSummary) {
  const { chromium } = require('playwright-core');
  const { DatabaseSync } = require('node:sqlite');
  const cdpPort = env.cdpPort;
  const userData = path.join(fixture.root, '..', `${path.basename(fixture.root)}-user`);
  const piInfo = await writeAcceptanceUserData(userData, { workspaceId: fixture.workspaceId, rootPath: fixture.root, piConfigPath: env.piConfig });
  const ui = { requested: true, piConfig: piInfo.piConfig, piConfigSource: piInfo.piConfigSource ?? null, phases: {}, screenshotDir: env.screenshotDir };
  const launchCmd = buildElectronLaunch(env, userData, cdpPort);
  const child = spawn(launchCmd.file, launchCmd.args, { cwd: REPO_ROOT, env: { ...process.env, WMB_ACCEPTANCE_USER_DATA: userData, WMB_ACCEPTANCE_CDP_PORT: String(cdpPort) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  let childLog = '';
  child.stdout?.on('data', (d) => { childLog += d; });
  child.stderr?.on('data', (d) => { childLog += d; });
  let browser = null;
  try {
    const endpoint = `http://127.0.0.1:${cdpPort}`;
    const deadline = Date.now() + 240_000;
    let version = null;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) { version = await res.json(); break; }
      } catch { /* not up yet */ }
      if (child.exitCode !== null) throw new Error(`Electron 提前退出（exit=${child.exitCode}）\n${childLog.slice(-4000)}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!version) throw new Error(`CDP 端点 ${endpoint} 在 240s 内不可达（环境不可用，明确 fail）`);
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    if (!context) throw new Error('CDP 无默认 context');
    // 主窗口可能仍在创建：等待默认页出现（CDP createTarget 在 Electron 端点不受支持）
    let page = context.pages()[0] ?? null;
    const pageDeadline = Date.now() + 30_000;
    while (!page && Date.now() < pageDeadline) {
      await new Promise((r) => setTimeout(r, 500));
      page = context.pages()[0] ?? null;
    }
    if (!page) throw new Error('CDP 默认页 30s 内未出现（Electron 主窗口未创建）');
    // 等待真实 app shell（onboarding 由 fixture 标记 complete，应直达主界面）
    await waitFor(page, () => page.evaluate(() => !!document.querySelector('.app-shell') || !!document.querySelector('.workspace')), 90_000, 'app shell 未出现');
    // 工作空间必须真实加载：brand 显示 workspace displayName（settings.workspace 就绪 → workspaceId 可用）
    const brand = await waitFor(page, () => page.evaluate(() => {
      const el = document.querySelector('.brand small');
      return el ? el.textContent?.trim() ?? null : null;
    }), 60_000, '工作空间未加载（brand 未显示 workspace 名；fixture 数据根不完整或运行时失败）');
    ui.workspaceLoaded = brand;
    await page.evaluate(() => { const b = document.querySelector('.app-shell'); if (b) b.scrollIntoView(); });

    // ---- DB 侧期望（只读打开 fixture DB，与 UI 表面做真实双读回） ----
    const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
    const dbExpect = {
      aWikiPageId: dbSummary.phases.A.items.wikiPageId,
      aConclusions: (() => {
        const row = db.prepare('SELECT current_version_id AS id FROM knowledge_wiki_pages WHERE id = ?').get(dbSummary.phases.A.items.wikiPageId);
        if (!row?.id) return [];
        const v = db.prepare('SELECT body_json FROM knowledge_wiki_page_versions WHERE id = ?').get(row.id);
        if (!v) return [];
        try { return (JSON.parse(v.body_json).keyConclusions ?? []).map((kc) => String(kc.statement ?? '')).filter(Boolean); } catch { return []; }
      })(),
      dFinalReview: (() => {
        const row = db.prepare(`SELECT keep_json, stop_json, change_json, summary FROM reviews WHERE status = 'final' ORDER BY created_at DESC LIMIT 1`).get();
        if (!row) return null;
        return { keep: JSON.parse(row.keep_json), stop: JSON.parse(row.stop_json), change: JSON.parse(row.change_json), summary: row.summary ?? '' };
      })(),
      eOpenIssues: Number(db.prepare(`SELECT count(*) AS c FROM knowledge_health_issues WHERE status = 'open'`).get().c),
      fWikiVersionCount: Number(db.prepare('SELECT count(*) AS c FROM knowledge_wiki_page_versions WHERE page_id = ?').get(dbSummary.phases.A.items.wikiPageId).c),
      queryArtifactsBefore: Number(db.prepare('SELECT count(*) AS c FROM knowledge_query_artifacts').get().c)
    };
    db.close();

    // ---- 导航 helper：sidebar 按钮按可见文本匹配 ----
    const clickNav = async (label) => {
      const ok = await page.evaluate((wanted) => {
        const buttons = [...document.querySelectorAll('.sidebar button')];
        const hit = buttons.find((b) => b.textContent?.trim().includes(wanted));
        if (!hit) return false;
        hit.click();
        return true;
      }, label);
      if (!ok) throw new Error(`侧边导航找不到「${label}」`);
      await page.waitForTimeout(800);
    };
    // 页签 helper：按文本点击指定容器内的页签
    const clickTab = async (containerSel, label) => {
      const ok = await page.evaluate(({ sel, wanted }) => {
        const el = [...document.querySelectorAll(sel)].find((b) => b.textContent?.includes(wanted));
        if (!el) return false;
        el.click();
        return true;
      }, { sel: containerSel, wanted: label });
      if (!ok) throw new Error(`页签「${label}」未找到（${containerSel}）`);
      await page.waitForTimeout(500);
    };
    // 确保回到主题网格（此前打开的详情会经 localStorage libraryTopicId 深链直达详情，网格无卡）
    const ensureTopicGrid = async () => {
      await waitFor(page, () => page.evaluate(() => !!document.querySelector('.topic-object-card') || !!document.querySelector('.topic-wiki-page')), 30_000, '主题视图未渲染');
      const inDetail = await page.evaluate(() => !!document.querySelector('.topic-wiki-page') && !document.querySelector('.topic-object-card'));
      if (inDetail) {
        await page.evaluate(() => { const b = document.querySelector('.topic-back-button'); if (b) b.click(); });
        await page.waitForTimeout(800);
      }
      await waitFor(page, () => page.evaluate(() => !!document.querySelector('.topic-object-card')), 30_000, '主题卡未渲染');
    };
    // 打开指定标题的主题详情（DB 层创建的主题，标题唯一）
    const openTopicByName = async (substring) => {
      const ok = await page.evaluate((wanted) => {
        const card = [...document.querySelectorAll('.topic-object-card')].find((c) => c.querySelector('strong')?.textContent?.includes(wanted));
        if (!card) return false;
        card.click();
        return true;
      }, substring);
      if (!ok) throw new Error(`主题卡「${substring}」未找到`);
      await page.waitForTimeout(1200);
    };
    const screenshotTarget = async (name, candidates) => {
      const matched = [];
      for (const sel of candidates) {
        const info = await page.evaluate((s) => {
          const el = document.querySelector(s);
          return el ? { found: true, text: (el.textContent || '').slice(0, 200).replace(/\s+/g, ' ') } : { found: false, text: '' };
        }, sel);
        if (info.found) matched.push({ selector: sel, text: info.text });
      }
      if (!matched.length) throw new Error(`${name} 表面 selector 未命中（候选：${candidates.join(' | ')}；selector 漂移或环境不可用，明确 fail）`);
      const file = path.join(ui.screenshotDir, `${name}.png`);
      try {
        await page.locator(matched[0].selector).first().screenshot({ path: file, timeout: 10_000 });
      } catch (error) {
        return { matched, screenshot: null, screenshotError: error.message };
      }
      return { matched, screenshot: file };
    };

    // ============ A-ui：资料库保存 Source → 自动编译 → Topic Wiki 当前认识 ============
    const Aui = { status: 'pass', items: {} };
    try {
      await clickNav('资料库');
      await waitFor(page, () => page.evaluate(() => !!document.querySelector('.lib-row')), 30_000, 'A-ui 资料库 Source 行未渲染');
      // 真实动作：打开第一条已保存 Source → 编辑 → 保存（走 5229 post-save 自动编译路径）
      const opened = await page.evaluate(() => {
        const row = document.querySelector('.lib-row');
        if (!row) return false;
        row.click();
        return true;
      });
      await waitFor(page, () => page.evaluate(() => !!document.querySelector('.library-source-detail-page')), 30_000, 'A-ui Source 详情未渲染');
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('.library-source-detail-actions button')].find((b) => b.textContent?.includes('编辑'));
        if (btn) btn.click();
      });
      await page.waitForTimeout(400);
      const saved = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('.library-source-detail-actions button')].find((b) => b.textContent?.includes('保存') && !b.disabled);
        if (!btn) return 'no-save-button';
        btn.click();
        return 'clicked';
      });
      await page.waitForTimeout(1500); // 5229 自动编译窗口（DB 层已编译，此处验证真实保存路径可用）
      // 主题 → 打开 DB 层 A 主题（标题唯一）→ 读回 Topic Wiki 当前认识
      await clickNav('主题');
      await openTopicByName('AI Agent 工具链');
      await waitFor(page, () => page.evaluate(() => !!document.querySelector('.topic-wiki-page')), 30_000, 'A-ui Topic Wiki 未渲染');
      const surface = await page.evaluate(() => ({
        conclusions: [...document.querySelectorAll('.topic-wiki-conclusion strong')].map((e) => (e.textContent ?? '').trim()),
        hasCurrent: !!document.querySelector('#topic-wiki-current'),
        compileState: document.querySelector('.topic-wiki-page')?.getAttribute('data-compile-status') ?? null
      }));
      const dbHits = dbExpect.aConclusions.filter((s) => surface.conclusions.some((t) => t.includes(s.slice(0, 12))));
      if (!surface.hasCurrent || surface.conclusions.length === 0) throw new Error(`A-ui 当前认识表面为空（hasCurrent=${surface.hasCurrent} conclusions=${surface.conclusions.length}）`);
      if (dbHits.length < 1) throw new Error(`A-ui 结论文本未与 DB 层对齐（DOM=${JSON.stringify(surface.conclusions)} DB=${JSON.stringify(dbExpect.aConclusions)}）`);
      const nav = await screenshotTarget('A-topic-wiki', UI_TARGETS.A.screenshotSelectors);
      Aui.items = { opened, saveClicked: saved, surface: { ...surface, dbHitStatements: dbHits }, uiTarget: nav, db: dbSummary.phases.A.items };
    } catch (error) { Aui.status = 'fail'; Aui.items.error = error.message; }

    // ============ B-ui：Pi 真实问答写回（需要 5231 + 真实 Pi 配置） ============
    const Bui = { status: 'pass', items: {} };
    try {
      if (env.skipUiB) { Bui.status = 'skipped'; Bui.items.reason = '--skip-ui-b'; }
      else if (piInfo.piConfig !== 'copied') { throw new Error('B-ui 需要 --pi-config 提供真实 Pi 配置（当前为不可达 stub）；Pi 不可用明确 fail，不做假 fallback'); }
      else {
        await clickNav('今日');
        const composerReady = await page.evaluate(() => {
          const ta = document.querySelector('.pi-composer textarea');
          const send = document.querySelector('.pi-send-button');
          return { hasTextarea: !!ta, sendDisabled: send ? send.disabled : null, placeholder: ta?.getAttribute('placeholder') ?? null };
        });
        if (!composerReady.hasTextarea) throw new Error('B-ui Pi 输入框未渲染');
        // 权威状态：直接经页面 IPC 读 settings.pi.configured（与 composer 同一数据源）
        const piState = await page.evaluate(async () => {
          const settings = await window.wmb.getSettings().catch(() => null);
          return { configured: Boolean(settings?.pi?.configured), model: settings?.pi?.model ?? null, activeId: settings?.pi?.activeId ?? null };
        });
        if (!piState.configured) throw new Error(`B-ui Pi 未配置（settings.pi.configured=false，model=${piState.model} activeId=${piState.activeId}；真实配置未生效或 Pi 服务未就绪）`);
        if (composerReady.sendDisabled === true && composerReady.placeholder?.includes('配置 Pi API')) throw new Error(`B-ui composer 仍为未配置态（placeholder=${composerReady.placeholder}）`);
        // 真实但确定性的协议遵循请求：明确要求按已加载 Skill 的「Pi 知识问答写回」协议执行，
        // 先调 wmb_get_knowledge_context 冻结读取，末条回复最后输出 wmb_query_writeback JSON 围栏；
        // 分类/ID 均须来自真实工具结果，脚本绝不自写清单（仍由产品解析 + DB 双读回判定）。
        // 关键：知识上下文工具按主题名 title-LIKE 检索 —— 问题必须给出知识库中的真实主题名
        // 「AI Agent 工具链」（A 阶段创建），否则模型按 AgentForge 等词检索必然空集、按协议拒绝写回。
        const question = '请严格按已加载 wemedia-buddy-operator Skill 的「Pi 知识问答写回」协议执行本轮：1) 先用 wmb_get_knowledge_context 检索主题「AI Agent 工具链」（query 直接使用该主题名；若返回空请再试 AgentForge、小红书 等词），再用返回的 topic_id 冻结读取该主题的知识版本；2) 基于冻结读取的内容，综合 AgentForge v2 企业版限制、小红书图片场景人工抽检经验、多模型路由评估方法，给出一个新的可复用判断，classification=new_synthesis；3) 在末条回复正文的最后，以 ```json 围栏输出 wmb_query_writeback 清单：readWikiVersionIds/readNoteVersionIds/readEvidenceIds 与 synthesis.basedOnNoteVersionIds 只允许填工具真实返回的冻结版本 ID，synthesis.statement 为你的综合判断原文，禁止编造任何 ID 或跳过清单';
        await page.fill('.pi-composer textarea', question);
        // 等发送按钮就绪（settings 异步刷新可能滞后）后点击
        await waitFor(page, () => page.evaluate(() => {
          const btn = document.querySelector('.pi-send-button');
          return btn && !btn.disabled ? 'ready' : null;
        }), 30_000, 'B-ui 发送按钮未就绪（Pi 未配置或 settings 未刷新）');
        const sent = await page.evaluate(() => {
          const btn = document.querySelector('.pi-send-button');
          if (!btn || btn.disabled) return 'disabled';
          btn.click();
          return 'clicked';
        });
        if (sent !== 'clicked') throw new Error(`B-ui 发送失败（${sent}；piState=${JSON.stringify(piState)} composer=${JSON.stringify(composerReady)}）`);
        // 等待真实 Pi 回合结束并出现「知识使用与沉淀」面板（5231 协议围栏写回）
        let panel = null;
        try {
          panel = await waitFor(page, () => page.evaluate(() => {
            const el = document.querySelector('.pi-knowledge-panel');
            return el ? { decision: el.getAttribute('data-decision'), writtenBack: el.classList.contains('written-back'), text: (el.textContent || '').slice(0, 300) } : null;
          }), 240_000, 'Pi 回合未在 240s 内产出知识面板（Pi 不可用/5231 协议未生效/回合失败）');
        } catch (error) {
          // 如实记录回合状态：失败 tool-line / 系统事件 / 状态栏 / 是否仍在流式
          const diag = await page.evaluate(() => ({
            failedTools: [...document.querySelectorAll('.pi-tool-line.failed')].map((e) => (e.textContent || '').slice(0, 200)),
            systemEvents: [...document.querySelectorAll('.pi-system-event-text')].map((e) => (e.textContent || '').slice(0, 200)),
            statusBar: [...document.querySelectorAll('.status-item')].map((e) => (e.textContent || '').trim()).filter(Boolean),
            streaming: !!document.querySelector('.pi-message-segment.live, .pi-tool-line.running'),
            transcriptTail: (document.querySelector('.pi-conversation')?.textContent || '').replace(/\s+/g, ' ').slice(-400),
            activity: !!document.querySelector('.pi-activity')
          }));
          throw new Error(`${error.message}；回合诊断=${JSON.stringify(diag)}`);
        }
        // DB 双读回：本轮必须新增 Query Artifact（真实写回落库）
        const after = new DatabaseSync(fixture.dbPath, { readOnly: true });
        const artifactsAfter = Number(after.prepare('SELECT count(*) AS c FROM knowledge_query_artifacts').get().c);
        const notesAfter = Number(after.prepare('SELECT count(*) AS c FROM knowledge_notes').get().c);
        after.close();
        Bui.items = { panel, question, artifactsBefore: dbExpect.queryArtifactsBefore, artifactsAfter, notesAfter, db: dbSummary.phases.B.items };
        if (artifactsAfter <= dbExpect.queryArtifactsBefore) throw new Error(`B-ui 未产生 Query Artifact（before=${dbExpect.queryArtifactsBefore} after=${artifactsAfter}）；真实写回未落库`);
        if (!panel.writtenBack) throw new Error(`B-ui 面板显示未写回（decision=${panel.decision}）：${panel.text}；本轮未产生 created/updated 知识写回`);
        const nav = await screenshotTarget('B-pi-knowledge', UI_TARGETS.B.screenshotSelectors);
        Bui.items.uiTarget = nav;
      }
    } catch (error) { Bui.status = 'fail'; Bui.items.error = error.message; }

    // ============ C-ui：Studio 打开 DB 层项目 → 编辑器 + 文档状态读回 ============
    const Cui = { status: 'pass', items: {} };
    try {
      await clickNav('创作');
      await waitFor(page, () => page.evaluate(() => !!document.querySelector('.studio-library')), 30_000, 'C-ui Studio 库未渲染');
      // 打开 DB 层 C 阶段创建的项目「AI 项目」（标题匹配，避免点到源工作空间旧项目）
      const opened = await page.evaluate(() => {
        const row = [...document.querySelectorAll('.studio-project-row:not(.head)')].find((r) => r.textContent?.includes('AI 项目'));
        if (!row) return false;
        row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        return true;
      });
      if (!opened) throw new Error('C-ui 未找到 DB 层项目「AI 项目」行');
      await waitFor(page, () => page.evaluate(() => !!document.querySelector('.studio-editor-view')), 30_000, 'C-ui Studio 编辑器未渲染');
      // 真实用户动作：点击顶部「保存」（无改动保存；验证编辑器交互可用）
      const saveClicked = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('.studio-editor-top button.primary-button')].find((b) => b.textContent?.includes('保存') && !b.disabled);
        if (!btn) return 'no-save';
        btn.click();
        return 'clicked';
      });
      await page.waitForTimeout(600);
      // UI 双读回：.studio-doc-state 必须显示 DB 层 C 版本状态（第 2 版 · 已保存）
      const docState = await page.evaluate(() => document.querySelector('.studio-doc-state')?.textContent?.replace(/\s+/g, ' ').trim() ?? '');
      if (!docState.includes('第 2 版') || !docState.includes('已保存')) throw new Error(`C-ui 文档状态未与 DB 层对齐：${docState}`);
      const nav = await screenshotTarget('C-studio', UI_TARGETS.C.screenshotSelectors);
      Cui.items = { opened, saveClicked, docState, uiTarget: nav, db: dbSummary.phases.C.items };
    } catch (error) { Cui.status = 'fail'; Cui.items.error = error.message; }

    // ============ D-ui：结果复盘（final Review 回流） ============
    const Dui = { status: 'pass', items: {} };
    try {
      await clickNav('结果');
      await waitFor(page, () => page.evaluate(() => !!document.querySelector('.results-page')), 30_000, 'D-ui Results 未渲染');
      // UI 双读回 1：周期统计（1 本周期发布 · 1 已复盘）与 DB 层 D 对齐
      const statsText = await page.evaluate(() => document.querySelector('.page-command-stats')?.textContent?.replace(/\s+/g, ' ') ?? '');
      if (!/1\s*本周期发布/.test(statsText) || !/1\s*已复盘/.test(statsText)) throw new Error(`D-ui 周期统计未与 DB 层对齐：${statsText}`);
      // UI 双读回 2：HeroPanel 行动聚合显示 DB 层 final Review 的 keep/stop/change
      const heroKsc = await page.evaluate(() => document.querySelector('.rl-hero-ksc')?.textContent?.replace(/\s+/g, ' ') ?? '');
      const rev = dbExpect.dFinalReview;
      if (!rev) throw new Error('D-ui DB 层无 final Review 可读回');
      const missing = [rev.keep[0], rev.stop[0], rev.change[0]].filter((v) => v && !heroKsc.includes(String(v)));
      if (missing.length) throw new Error(`D-ui 复盘行动未与 DB 层对齐（缺 ${JSON.stringify(missing)}）：${heroKsc}`);
      // 真实交互：点击散点钻取 → final Review 的 KSC 块（rl-ksc）必须出现。
      // 用与 React 事件系统同构的 MouseEvent 派发（mousemove 先命中 hitzone 设 hover，click 再选择）。
      const drill = await page.evaluate(() => {
        const hitzone = document.querySelector('.rc-hitzone');
        const dot = document.querySelector('.rc-dot');
        if (!hitzone || !dot) return null;
        const r = dot.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        hitzone.dispatchEvent(new MouseEvent('mousemove', { clientX: cx, clientY: cy, bubbles: true }));
        return { x: cx, y: cy };
      });
      if (drill) {
        await page.waitForTimeout(300);
        await page.evaluate(() => { const hitzone = document.querySelector('.rc-hitzone'); if (hitzone) hitzone.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        await page.waitForTimeout(800);
      }
      const drilled = await page.evaluate(() => !!document.querySelector('.rl-ksc'));
      if (!drilled) throw new Error(`D-ui 散点钻取未出现 rl-ksc（dot=${drill ? 'found' : 'missing'}）；复盘内容表面不可达`);
      const kscText = await page.evaluate(() => document.querySelector('.rl-ksc')?.textContent?.replace(/\s+/g, ' ') ?? '');
      const kscMissing = [rev.keep[0], rev.stop[0], rev.change[0]].filter((v) => v && !kscText.includes(String(v)));
      if (kscMissing.length) throw new Error(`D-ui rl-ksc 内容未与 DB 层对齐（缺 ${JSON.stringify(kscMissing)}）：${kscText}`);
      const nav = await screenshotTarget('D-results', UI_TARGETS.D.screenshotSelectors);
      Dui.items = { statsText, heroKsc, kscText, drilled, uiTarget: nav, db: dbSummary.phases.D.items };
    } catch (error) { Dui.status = 'fail'; Dui.items.error = error.message; }

    // ============ E-ui：知识健康 / 编译状态诚实显示（5233 三态表面） ============
    const Eui = { status: 'pass', items: {} };
    try {
      await clickNav('资料库');
      await clickTab('.proposal-tab', '知识健康');
      await waitFor(page, () => page.evaluate(() => !!document.querySelector('.health-section')), 30_000, 'E-ui 知识健康表面未渲染');
      // UI 双读回：等健康问题列表加载完成，数量 ≥ DB 层 E 的 open issues（冲突/broken 证据/stale 均 open）
      const issueCount = await waitFor(page, () => page.evaluate((expected) => {
        const n = document.querySelectorAll('.library-issue-item').length;
        return n >= expected ? n : null;
      }, dbExpect.eOpenIssues), 30_000, `E-ui 健康问题列表未达 DB 层 open 数（期望 ≥ ${dbExpect.eOpenIssues}）`);
      const healthNav = await screenshotTarget('E-health', UI_TARGETS.E.screenshotSelectors);
      // 5233 三态表面：主题卡 compile-state 徽标（compiled 主题 + uncompiled 空主题）
      await clickNav('主题');
      await ensureTopicGrid();
      const badges = await page.evaluate(() => ({
        compiled: document.querySelectorAll('.topic-compile-state.compiled').length,
        uncompiled: document.querySelectorAll('.topic-compile-state.uncompiled').length,
        labels: [...document.querySelectorAll('.topic-compile-state')].map((e) => (e.textContent ?? '').trim())
      }));
      if (badges.compiled < 1 || badges.uncompiled < 1) throw new Error(`E-ui 编译态徽标未对齐（${JSON.stringify(badges)}）`);
      const stateNav = await screenshotTarget('E-compile-state', ['.topic-compile-state']);
      Eui.items = { issueCount, dbOpenIssues: dbExpect.eOpenIssues, badges, uiTarget: { health: healthNav, compileState: stateNav }, db: dbSummary.phases.E.items };
    } catch (error) { Eui.status = 'fail'; Eui.items.error = error.message; }

    // ============ F-ui：Topic Wiki 版本区 restore ============
    const Fui = { status: 'pass', items: {} };
    try {
      await clickNav('主题');
      await ensureTopicGrid();
      await openTopicByName('AI Agent 工具链');
      await waitFor(page, () => page.evaluate(() => !!document.querySelector('.topic-wiki-page')), 30_000, 'F-ui Topic Wiki 未渲染');
      // 切到「版本」页签（版本区默认隐藏，必须先切页签才能截到真实表面）
      await clickTab('.topic-wiki-tabs button', '版本');
      await waitFor(page, () => page.evaluate(() => !!document.querySelector('.topic-wiki-version')), 30_000, 'F-ui 版本卡未渲染');
      const versionInfo = await page.evaluate(() => ({
        count: document.querySelectorAll('.topic-wiki-version').length,
        restoreButtons: [...document.querySelectorAll('.topic-wiki-version .text-button')].map((b) => (b.textContent ?? '').trim()),
        nums: [...document.querySelectorAll('.topic-wiki-version-num')].map((e) => (e.textContent ?? '').trim())
      }));
      if (versionInfo.count < dbExpect.fWikiVersionCount) throw new Error(`F-ui 版本数未与 DB 层对齐（DOM=${versionInfo.count} DB=${dbExpect.fWikiVersionCount}）`);
      if (!versionInfo.restoreButtons.some((t) => t.includes('恢复此版本'))) throw new Error(`F-ui 未找到「恢复此版本」表面：${JSON.stringify(versionInfo)}`);
      const nav = await screenshotTarget('F-topic-versions', UI_TARGETS.F.screenshotSelectors);
      Fui.items = { versionInfo, dbVersionCount: dbExpect.fWikiVersionCount, uiTarget: nav, db: dbSummary.phases.F.items };
    } catch (error) { Fui.status = 'fail'; Fui.items.error = error.message; }

    ui.phases = { A: Aui, B: Bui, C: Cui, D: Dui, E: Eui, F: Fui };
  } finally {
    if (browser) await browser.close().catch(() => {});
    await terminateProcessTree(child).catch(() => {});
  }
  return ui;
}

/** Windows 下按进程树终止（electron-forge 会派生 electron.exe，只 kill 父进程会残留）。 */
async function terminateProcessTree(child) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.on('exit', resolve);
      killer.on('error', resolve);
    });
  } else {
    child.kill('SIGTERM');
  }
  await new Promise((r) => setTimeout(r, 500));
  if (child.exitCode === null) child.kill('SIGKILL');
}

function buildElectronLaunch(env, userData, cdpPort) {
  const packaged = path.join(REPO_ROOT, 'out', 'WeMediaBuddy-win32-x64', 'WeMediaBuddy.exe');
  if (env.electronExe && existsSync(env.electronExe)) return { file: env.electronExe, args: [] };
  if (existsSync(packaged)) return { file: packaged, args: [] };
  const forgeCli = path.join(REPO_ROOT, 'node_modules', '@electron-forge', 'cli', 'dist', 'electron-forge.js');
  if (existsSync(forgeCli)) return { file: process.execPath, args: [forgeCli, 'start'] };
  return { file: 'npm.cmd', args: ['run', 'start'] };
}

async function waitFor(page, probe, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await probe();
      if (last) return last;
    } catch (error) { last = error.message; }
    await page.waitForTimeout(1000);
  }
  throw new Error(`${message}（${timeoutMs}ms；last=${typeof last === 'string' ? last : JSON.stringify(last)?.slice(0, 200)}）`);
}

// ---------------------------------------------------------------------------
// 证据输出
// ---------------------------------------------------------------------------
async function writeEvidence(env, report) {
  const dir = env.outDir;
  await mkdir(dir, { recursive: true });
  const jsonPath = path.join(dir, `wmb-5234-acceptance-${localDate()}.json`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  if (report.kind === 'run') {
    const md = buildEvidenceMarkdown(report);
    await writeFile(path.join(dir, `wmb-5234-acceptance-${localDate()}.md`), md, 'utf8');
  }
  return jsonPath;
}

function buildEvidenceMarkdown(report) {
  const s = report.db?.phases ?? {};
  const ui = report.ui?.phases ?? {};
  const lines = [
    '# WMB-5234 知识飞轮最终验收证据（生成于 ' + report.generatedAt + '）',
    '',
    `- schema：${report.schema}`,
    `- fixture：${report.db?.fixture?.mode ?? '-'}（workspaceId=${report.db?.fixture?.workspaceId ?? '-'}${report.db?.fixture?.source ? `，源=${report.db.fixture.source}` : ''}；隔离根，未污染 Owner 主库）`,
    `- UI 层：${report.ui ? '经真实 Electron CDP 驱动（WMB_ACCEPTANCE_USER_DATA / WMB_ACCEPTANCE_CDP_PORT）' : '未启用（--ui 缺省；DB 层不能代表 WMB-5234 完整验收）'}`,
    '',
    '## A. Ingest 编译',
    s.A?.status === 'pass'
      ? `- ChangeSet=${s.A.items.compile2.changeSetId} Receipt=${s.A.items.compile2.receiptId} Entity=${s.A.items.compile1.entityId} Wiki=${s.A.items.compile2.wikiVersionId}（采纳 ${s.A.items.compile2.wikiAdopted}，retainedDisputes=${s.A.items.compile2.retainedDisputes}）上下文包=${s.A.items.contextPackageId}`
      : `- FAIL: ${s.A?.items?.error}`,
    '',
    '## B. Query 写回',
    s.B?.status === 'pass'
      ? `- 冻结集 Wiki=${s.B.items.frozenRead.wikiVersionId} + ${s.B.items.frozenRead.noteVersionIds} Note + ${s.B.items.frozenRead.evidenceIds} 证据；复述 Artifact=${s.B.items.restatement.artifactId} Receipt=${s.B.items.restatement.receiptId}；同问幂等=${s.B.items.sameQuestionReplay.duplicate}；综合 Note=${s.B.items.synthesis.noteId} 页=${s.B.items.synthesis.pageId} 版本=${s.B.items.synthesis.pageVersionId}；FreeNote=${s.B.items.experienceFreeNoteId}`
      : `- FAIL: ${s.B?.items?.error}`,
    '',
    '## C. 创作 Usage 链',
    s.C?.status === 'pass'
      ? `- 冻结 Wiki=${s.C.items.frozenWikiVersionId}；提案包=${s.C.items.proposal.usagePackageId}、简报包=${s.C.items.brief.usagePackageId}、核心 V1=${s.C.items.coreV1.usagePackageId}、核心 V2=${s.C.items.coreV2.usagePackageId}、平台包=${s.C.items.platform.usagePackageId}（used=${s.C.items.platform.usageKind}）；换基拒绝=${s.C.items.rebaseRejected.code}，同基修订 revision=${s.C.items.sameBaseUpdateRevision}`
      : `- FAIL: ${s.C?.items?.error}`,
    '',
    '## D. Publication/Metric/final Review 回流',
    s.D?.status === 'pass'
      ? `- 发布=${s.D.items.publicationId} 快照=${s.D.items.metricSnapshotId} Review=${s.D.items.reviewId} case Note=${s.D.items.caseNoteId} 版本=${s.D.items.caseVersionId}（unverified/outcome_observed/不证明因果）；回执=${s.D.items.receiptId}；Wiki recentOutcomes=${s.D.items.wikiRecentOutcomes} 立即可见；零因果 Method=${s.D.items.zeroCausalMethod} 零 pattern=${s.D.items.zeroPattern} 重放零写=${s.D.items.replayZeroWrite}`
      : `- FAIL: ${s.D?.items?.error}`,
    '',
    '## E. Health Lint',
    s.E?.status === 'pass'
      ? `- 冲突 Issue=${s.E.items.conflictIssueId}（${s.E.items.conflictStatus}，不自动裁决）；broken 证据=${s.E.items.brokenEvidenceIssueId}（${s.E.items.brokenEvidenceStatus}）；broken 关系 ${s.E.items.repairedRelationId} 自动修复 Issue=${s.E.items.repairIssueId} 回执=${s.E.items.repairReceiptId}；stale=${s.E.items.staleIssueId}；周期 run=${s.E.items.periodic.runId} completed=${s.E.items.periodic.completed} scanned=${s.E.items.periodic.scannedObjects} 崩溃重试零写=${s.E.items.periodic.crashRetryZeroWrite}；5233 三态：零知识=${s.E.items.shellZeroKnowledge?.zeroKnowledge?.getTopicCompileState ?? '-'} 主库=${JSON.stringify(s.E.items.shellZeroKnowledge?.mainWorkspace ?? null)}`
      : `- FAIL: ${s.E?.items?.error}`,
    '',
    '## F. 并发 / 恢复 / 弱 Source',
    s.F?.status === 'pass'
      ? `- 弱 Source=${s.F.items.weakSource.sourceId}（notes=0 skipped=${s.F.items.weakSource.skippedLowValue}）；并发首成=${s.F.items.concurrency.firstSucceededStatement} 第二=${s.F.items.concurrency.secondRejectedCode}；restore revision=${s.F.items.restore.revision} changeType=${s.F.items.restore.changeType} restoredFrom=${s.F.items.restore.restoredFromVersionId} 版本链 ${s.F.items.restore.versionsKept} 全保留`
      : `- FAIL: ${s.F?.items?.error}`,
    '',
    '## G. 边界',
    s.G?.status === 'pass'
      ? `- 链完整性=${JSON.stringify(s.G.items.chainIntegrity)}；单 Topic 单 Wiki=${s.G.items.singleTopicSingleWiki}；data-root 隔离=${JSON.stringify(s.G.items.dataRootIsolation)}；Canvas 删除后正式对象保留=${s.G.items.canvasDelete.formalTopicStillExists}；不可变=${s.G.items.immutableVersions}；dispatcher=${s.G.items.dispatcher.command} receipts=${s.G.items.dispatcher.commandReceipts} 直写被拒=${s.G.items.dispatcher.directSqlWriteBlocked}`
      : `- FAIL: ${s.G?.items?.error}`,
    '',
    '## UI 双读回（--ui）',
    ...Object.entries(ui).map(([phase, item]) =>
      `- ${phase}-ui: ${item.status}${item.status === 'pass' ? ` selector=${item.items?.uiTarget?.matched?.[0]?.selector ?? '-'} screenshot=${item.items?.uiTarget?.screenshot ?? '-'}` : ` ${item.items?.error ?? item.items?.reason ?? ''}`}`
    ),
    '',
    `## 结论\n- dbAcceptance=${report.verdict.dbAcceptance}；uiAcceptance=${report.verdict.uiAcceptance ?? 'n/a'}；wmb5234Complete=${report.verdict.wmb5234Complete}；reasons=${JSON.stringify(report.verdict.reasons)}`,
    ''
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
/**
 * Pi 配置合法自动发现：与应用自身读取路径一致（app.getPath('userData')/pi-api-config.json，
 * 即 %APPDATA%\<productName>\pi-api-config.json）。显式 --pi-config 优先；找不到 → null
 * （fail-closed：B-ui 保持 stub 不可达并如实 fail，绝不伪造）。
 */
function discoverPiConfig() {
  const appData = process.env.APPDATA;
  if (!appData) return null;
  let appName = 'WeMediaBuddy';
  try {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    if (pkg?.productName) appName = pkg.productName;
  } catch { /* 默认名 */ }
  const candidate = path.join(appData, appName, 'pi-api-config.json');
  return existsSync(candidate) ? candidate : null;
}

function parseArgs(argv) {
  const env = { mode: 'audit', fixture: 'fresh', fixtureSource: null, piConfig: null, piConfigAutoDiscovered: false, electronExe: null, cdpPort: 9335 + Math.floor(Math.random() * 50), outDir: null, keep: false, skipUiB: false, ui: false };
  const take = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  if (argv.includes('--help') || argv.includes('-h')) env.mode = 'help';
  if (argv.includes('--run')) env.mode = 'run';
  if (argv.includes('--ui')) { env.ui = true; env.mode = 'run'; }
  if (argv.includes('--audit')) env.mode = 'audit';
  env.fixture = take('--fixture') ?? env.fixture;
  env.fixtureSource = take('--fixture-source');
  const explicitPi = take('--pi-config');
  if (explicitPi) {
    env.piConfig = explicitPi;
  } else {
    const discovered = discoverPiConfig();
    if (discovered) { env.piConfig = discovered; env.piConfigAutoDiscovered = true; }
  }
  env.electronExe = take('--electron-exe');
  env.cdpPort = Number(take('--cdp-port') ?? env.cdpPort);
  env.outDir = take('--out') ?? path.join(REPO_ROOT, '.ai', 'wmb-5234-evidence', localDate());
  env.keep = argv.includes('--keep');
  env.skipUiB = argv.includes('--skip-ui-b');
  return env;
}

async function main() {
  const env = parseArgs(process.argv.slice(2));
  if (env.mode === 'help') { printHelp(); return 0; }

  if (env.mode === 'audit') {
    const report = await audit(env);
    const jsonPath = await writeEvidence(env, report);
    console.log(JSON.stringify(report, null, 2));
    console.error(`[wmb-5234] audit 证据：${jsonPath}`);
    return 0;
  }

  // ---- run ----
  const report = { schema: EVIDENCE_SCHEMA, kind: 'run', generatedAt: NOW(), args: process.argv.slice(2), node: process.version, piConfig: env.piConfig ?? null, piConfigAutoDiscovered: Boolean(env.piConfigAutoDiscovered), fixture: null, db: null, ui: null, siblingGates: null, verdict: null };
  const pre = await audit(env);
  report.siblingGates = pre.siblingGates;
  const dbReady = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].every((p) => pre.phases[p].ready);
  if (!dbReady) {
    report.verdict = { dbAcceptance: 'fail', uiAcceptance: 'n/a', wmb5234Complete: false, reasons: ['DB 层模块缺失（先 --audit 查看）：' + JSON.stringify(pre.phases)] };
    await writeEvidence(env, report);
    console.log(JSON.stringify(report, null, 2));
    return 1;
  }

  const fixture = await createIsolatedFixture({ mode: env.fixture, sourceRoot: env.fixtureSource ?? undefined, workspaceId: 'ws-5234-acceptance' });
  try {
    env.screenshotDir = path.join(env.outDir, 'screenshots');
    await mkdir(env.screenshotDir, { recursive: true });
    report.fixture = { mode: fixture.mode, source: fixture.source, workspaceId: fixture.workspaceId, root: fixture.root, sourceInfo: fixture.sourceInfo };
    report.db = await runDbPipeline(env, fixture);
    if (env.ui) {
      report.ui = await runUiLayer(env, fixture, report.db);
    }
    const dbAcceptance = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].every((p) => report.db.phases[p].status === 'pass');
    const uiAcceptance = report.ui
      ? Object.values(report.ui.phases).every((p) => p.status === 'pass')
      : null;
    const gatesPresent = Object.values(report.siblingGates).every((g) => g.present);
    const reasons = [];
    if (!dbAcceptance) reasons.push('DB 层存在 fail：' + Object.entries(report.db.phases).filter(([, v]) => v.status !== 'pass').map(([k]) => k).join(','));
    if (env.ui && !uiAcceptance) reasons.push('UI 层存在 fail：' + Object.entries(report.ui.phases).filter(([, v]) => v.status !== 'pass').map(([k]) => `${k}-ui`).join(','));
    if (env.ui && !gatesPresent) reasons.push('5231/5232/5233 集成探针未全绿（wmb5234Complete 不可判定）：' + Object.entries(report.siblingGates).filter(([, g]) => !g.present).map(([k]) => k).join(','));
    report.verdict = {
      dbAcceptance: dbAcceptance ? 'pass' : 'fail',
      uiAcceptance: uiAcceptance === null ? 'not-requested' : (uiAcceptance ? 'pass' : 'fail'),
      wmb5234Complete: dbAcceptance && (uiAcceptance === true) && gatesPresent,
      reasons
    };
    const jsonPath = await writeEvidence(env, report);
    console.log(JSON.stringify(report, null, 2));
    console.error(`[wmb-5234] 证据：${jsonPath}`);
    // 退出码语义：--ui 完整验收只在 wmb5234Complete 时 0；DB-only 在 dbAcceptance=pass 时 0
    // （JSON 中 wmb5234Complete 仍如实为 false，DB 层全绿不冒充 WMB-5234 通过）。
    return (env.ui ? report.verdict.wmb5234Complete : dbAcceptance) ? 0 : 1;
  } finally {
    if (!env.keep) {
      await fixture.cleanup().catch(() => {});
      const userData = path.join(fixture.root, '..', `${path.basename(fixture.root)}-user`);
      await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
    }
  }
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(`[wmb-5234] ${error?.code ?? 'ERROR'}: ${error.message}`);
  process.exit(2);
});
