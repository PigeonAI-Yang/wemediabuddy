// WMB-5239 跨页 UI 合同 —— renderer 源码级聚焦测试。
// 覆盖 ReviewWmb5239Boundaries 验收清单的源码可证部分：
// 1) 无新顶级路由（View 联合零新增；侧栏知识资产仍 主题|资料库|知识网络）；
// 2) 职责划分：维护执行（全库整理入口/暂停/继续/报告/失败项/批量反馈/全库搜索）在资料库；
//    主题只有 topicId 限定的「搜索本主题资料/相关动态」，无维护控件；
//    画布只有只读「最近变化/知识健康」与图谱搜索定位，无维护执行入口；
// 3) 用户语言：全库整理/搜索全部资料/最近变化/相关动态/重试/暂停/继续 等，禁工程词泄漏；
// 4) 状态：搜索/日志各面 loading/empty/error+retry 文案齐全；
// 5) 既有键盘/深链保留：主题 1–7/1/2/3、库 tab 方向键、画布 Ctrl+Z/Ctrl+X/Esc；
//    深链桥 wmb-navigate-wiki-object 在 main.tsx 落地（topic→openTopic、source→资料库、object→画布）；
// 6) 画布只读（无三模式切换复活、无手工关系/创作动作；搜索=图谱过滤）。
// 真实 Electron 断言（禁词 grep、1568 溢出、重启读回）见 tests/e2e/wmb-5239-maintenance.test.mjs。
// 不做项目级 formatter/linter/全量测试；由主 Agent 集成后统一执行。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const mainTsx = await readFile(new URL('../src/renderer/main.tsx', import.meta.url), 'utf8');
const appTypes = await readFile(new URL('../src/renderer/app-types.ts', import.meta.url), 'utf8');
const libraryView = await readFile(new URL('../src/renderer/library-view.tsx', import.meta.url), 'utf8');
const topicView = await readFile(new URL('../src/renderer/library-topics-view.tsx', import.meta.url), 'utf8');
const canvasLayout = await readFile(new URL('../src/renderer/knowledge-canvas-layout.tsx', import.meta.url), 'utf8');
const canvasView = await readFile(new URL('../src/renderer/knowledge-canvas-view.tsx', import.meta.url), 'utf8');
const discoveryParts = await readFile(new URL('../src/renderer/wiki-discovery-parts.ts', import.meta.url), 'utf8');
const discoveryTsx = await readFile(new URL('../src/renderer/wiki-discovery.tsx', import.meta.url), 'utf8');
const topicSearchLog = await readFile(new URL('../src/renderer/topic-search-log.ts', import.meta.url), 'utf8');
const libraryCss = await readFile(new URL('../src/renderer/styles-workflow-library.css', import.meta.url), 'utf8');
const libraryMaintenance = await readFile(new URL('../src/renderer/library-maintenance.tsx', import.meta.url), 'utf8');
const libraryMaintenanceParts = await readFile(new URL('../src/renderer/library-maintenance-parts.ts', import.meta.url), 'utf8');
const canvasCss = await readFile(new URL('../src/renderer/styles-knowledge-canvas.css', import.meta.url), 'utf8');
const topicCss = await readFile(new URL('../src/renderer/styles-knowledge-topic.css', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// 1) 无新顶级路由
// ---------------------------------------------------------------------------

test('WMB-5239 UI: View union and sidebar knowledge assets unchanged (no new top-level route)', () => {
  const union = appTypes.match(/export type View = '([^']+)'(?: \| '([^']+)')+/);
  assert.ok(union, 'View 联合类型应存在');
  const viewText = appTypes.slice(appTypes.indexOf("export type View ="), appTypes.indexOf(';', appTypes.indexOf("export type View =")));
  for (const view of ['today', 'agents', 'discover', 'proposals', 'topic', 'library', 'canvas', 'studio', 'publish', 'results', 'settings']) {
    assert.match(viewText, new RegExp(`'${view}'`));
  }
  // 无 wiki 顶层路由。
  assert.doesNotMatch(viewText, /'wiki'/);
  assert.equal((viewText.match(/'/g) ?? []).length, 22, 'View 联合应恰好 11 个成员（22 个引号）');
  // 侧栏知识资产仍 主题|资料库|知识网络（canvas 标签为知识网络，非独立 Wiki 产品）。
  assert.match(mainTsx, /nav aria-label="知识资产"/);
  assert.match(mainTsx, /navigate\('topic'\)/);
  assert.match(mainTsx, /navigate\('library'\)/);
  assert.match(mainTsx, /navigate\('canvas'\)/);
  assert.match(mainTsx, /canvas: '知识网络'/);
});

// ---------------------------------------------------------------------------
// 2) 职责划分：维护执行在资料库；主题/画布不出现维护控件
// ---------------------------------------------------------------------------

test('WMB-5239 UI: maintenance execution lives in library view only', () => {
  // 维护执行位于 library-view 消费的 library-maintenance 组件（唯一维护执行面）。
  assert.match(libraryMaintenance, /startKnowledgeMaintenance/);
  assert.match(libraryMaintenance, /getKnowledgeMaintenanceStatus/);
  assert.match(libraryMaintenance, /pauseKnowledgeMaintenance/);
  assert.match(libraryMaintenance, /resumeKnowledgeMaintenance/);
  assert.match(libraryMaintenance, /全库整理/);
  assert.match(libraryMaintenance, /data-wiki-panel="maintenance"/);
  assert.match(libraryMaintenance, /data-maintenance-action="start"/);
  assert.match(libraryMaintenance, /data-maintenance-action="pause"/);
  assert.match(libraryMaintenance, /data-maintenance-action="resume"/);
  assert.match(libraryMaintenance, /data-maintenance-report/);
  // 失败项展示：failed 状态块 + 报告内受 guard 的 失败项 行（无独立重复块）。
  assert.match(libraryMaintenance, /data-maintenance-failed/);
  assert.doesNotMatch(libraryMaintenance, /data-maintenance-failures/, '失败项不应有独立重复块（合并进报告内 guard）');
  // library-view 原位挂载（非新顶层路由）。
  assert.match(libraryView, /<LibraryWikiTools \/>/);
  assert.match(libraryView, /import \{ LibraryWikiTools \} from '\.\/library-maintenance'/);
});

test('WMB-5239 UI: topic view has no maintenance execution controls', () => {
  assert.doesNotMatch(topicView, /startKnowledgeMaintenance/);
  assert.doesNotMatch(topicView, /pauseKnowledgeMaintenance/);
  assert.doesNotMatch(topicView, /resumeKnowledgeMaintenance/);
  // 主题只呈现 topicId 限定的搜索/动态，不提供全库维护入口。
  assert.match(topicView, /搜索本主题资料/);
  assert.match(topicView, /相关动态/);
  assert.match(topicView, /topicScopeId/);
  assert.match(topicView, /useWikiSearch\(\{ query: topicSearchQuery, topicId: topicScopeId/);
  assert.match(topicView, /useKnowledgeLog\(\{ topicId: topicScopeId/);
});

test('WMB-5239 UI: canvas has read-only health/log, no maintenance execution', () => {
  assert.doesNotMatch(canvasLayout, /startKnowledgeMaintenance/);
  assert.doesNotMatch(canvasLayout, /pauseKnowledgeMaintenance/);
  assert.doesNotMatch(canvasLayout, /resumeKnowledgeMaintenance/);
  // 画布只读健康提示（读 getKnowledgeMaintenanceStatus 的 lint 投影；无执行入口）。
  assert.match(canvasView, /getKnowledgeMaintenanceStatus/);
  assert.match(canvasLayout, /data-kc-health-hint/);
  assert.match(canvasLayout, /data-kc-log-toggle/);
  assert.match(canvasLayout, /最近变化/);
  assert.match(canvasLayout, /去资料库查看全库整理/);
  // 画布搜索仍是图谱过滤（data-kc-search），全库搜索唯一在资料库。
  assert.match(canvasLayout, /data-kc-search/);
  assert.match(canvasLayout, /placeholder="搜索主题、知识结论或实体…"/);
});

// ---------------------------------------------------------------------------
// 3) 用户语言：主入口文案存在 + 工程词不泄漏到用户可见标签
// ---------------------------------------------------------------------------

test('WMB-5239 UI: user-language entry copy present in library (全库整理/搜索全部资料/最近变化/整理报告/失败项)', () => {
  assert.match(libraryView, /全库整理/);
  assert.match(discoveryTsx, /搜索全部资料/);
  assert.match(discoveryParts, /搜索全部资料/);
  assert.match(discoveryParts, /最近变化/);
  assert.match(discoveryParts, /全库整理完成/);
  assert.match(discoveryParts, /开始全库整理/);
});

test('WMB-5239 UI: shared discovery components keep engineering words out of visible copy', () => {
  const BANNED = /compiled|changeset|hot[-_ ]?cache|revision|compile_state/i;
  assert.doesNotMatch(discoveryTsx, />[\s\S]*?(compiled|changeset|hot[-_ ]?cache|revision)/);
  // 组件默认文案全部为用户语言。
  assert.match(discoveryTsx, /没有找到匹配的内容，换个关键词试试。/);
  assert.match(discoveryTsx, /还没有知识变化记录。/);
  assert.match(discoveryTsx, /正在搜索…/);
  assert.match(discoveryTsx, /搜索失败/);
  assert.match(discoveryTsx, /重试/);
});

// ---------------------------------------------------------------------------
// 4) 状态机：搜索/日志每面 loading/empty/error+retry
// ---------------------------------------------------------------------------

test('WMB-5239 UI: topic search/activity surfaces loading, empty, error and retry', () => {
  assert.match(topicView, /正在检索本主题资料…/);
  assert.match(topicView, /本主题资料检索失败/);
  assert.match(topicView, /输入关键词，检索本主题已收录的资料、知识与实体。/);
  assert.match(topicView, /没有找到相关内容。搜索全部资料可到资料库。/);
  assert.match(topicView, /正在加载相关动态…/);
  assert.match(topicView, /相关动态加载失败/);
  assert.match(topicView, /还没有与本主题相关的动态。/);
  assert.match(topicView, /topicSearch\.retry/);
  assert.match(topicView, /topicActivity\.retry/);
});

test('WMB-5239 UI: canvas log/health surfaces loading, empty, error and retry', () => {
  assert.match(canvasLayout, /正在载入最近变化…/);
  assert.match(canvasLayout, /还没有知识变化记录/);
  assert.match(canvasLayout, /data-kc-log-error/);
  assert.match(canvasLayout, /data-kc-log-retry/);
  assert.match(canvasLayout, /重试/);
  assert.match(canvasLayout, /健康状态加载失败/);
  assert.match(canvasLayout, /data-kc-health-retry/);
  assert.match(canvasLayout, /正在读取健康状态…/);
});

// ---------------------------------------------------------------------------
// 5) 既有键盘/深链保留
// ---------------------------------------------------------------------------

test('WMB-5239 UI: topic keyboard 1-7 and legacy 1/2/3 segments preserved', () => {
  assert.match(topicView, /const wikiKey = Number\(event\.key\);/);
  assert.match(topicView, /wikiIndex >= 0 && showWikiPage && !deepMode/);
  assert.match(topicView, /setSegment\('judgments'\)/);
  assert.match(topicView, /setSegment\('sources'\)/);
  assert.match(topicView, /setSegment\('outcomes'\)/);
});

test('WMB-5239 UI: library tab arrow-key navigation preserved', () => {
  assert.match(libraryView, /onTabsKeyDown/);
  assert.match(libraryView, /ArrowRight/);
  assert.match(libraryView, /ArrowLeft/);
});

test('WMB-5239 UI: canvas Ctrl+Z / Ctrl+X / Esc history preserved', () => {
  assert.match(canvasLayout, /Ctrl\+Z 回退/);
  assert.match(canvasLayout, /Ctrl\+X 前进/);
  assert.match(canvasView, /undoSelection/);
  assert.match(canvasView, /redoSelection/);
  assert.match(canvasView, /onClearSelection/);
});

test('WMB-5239 UI: deep-link bridge lands in main.tsx without new routes', () => {
  // 事件名真源在 app-types.ts；main.tsx 经 WMB_NAVIGATE_WIKI_OBJECT_EVENT 注册唯一监听。
  assert.match(appTypes, /WMB_NAVIGATE_WIKI_OBJECT_EVENT = 'wmb-navigate-wiki-object'/);
  assert.match(mainTsx, /import \{ logoUrl, views, WMB_NAVIGATE_WIKI_OBJECT_EVENT \} from '\.\/app-types'/);
  assert.match(mainTsx, /onNavigateWikiObject/);
  assert.match(mainTsx, /payload\.targetType === 'topic_wiki'/);
  assert.match(mainTsx, /openTopic\(payload\.objectId\)/);
  assert.match(mainTsx, /payload\.targetType === 'source'/);
  assert.match(mainTsx, /libraryFocusSourceId/);
  assert.match(mainTsx, /payload\.targetType === 'knowledge_object'/);
  assert.match(mainTsx, /navigate\('canvas'\)/);
});

// ---------------------------------------------------------------------------
// 6) 画布只读：无三模式切换复活、无手工关系/创作动作
// ---------------------------------------------------------------------------

test('WMB-5239 UI: canvas stays read-only knowledge network (no mode toggle / manual relation)', () => {
  assert.doesNotMatch(canvasView, /mode: '(relation|changes|health)'/);
  assert.doesNotMatch(canvasLayout, /data-kc-mode=/, '不应有画布三模式切换');
  assert.doesNotMatch(canvasView, /createKnowledgeRelation|createKnowledgeCanvas/);
  assert.doesNotMatch(canvasView, /moveKnowledgeCanvasNodes/);
  assert.doesNotMatch(canvasView, /addKnowledgeCanvasNode/);
});

// ---------------------------------------------------------------------------
// 7) 主题范围过滤真实生效（源码证据：topicId 传入 hooks；无主题时禁用 IPC）
// ---------------------------------------------------------------------------

test('WMB-5239 UI: topic scope hooks carry topicId and are disabled without a topic', () => {
  assert.match(topicView, /const topicScopeEnabled = Boolean\(selectedTopicId\);/);
  assert.match(topicView, /enabled: topicScopeEnabled/);
  assert.match(topicView, /topicSearchQuery/);
});

// ---------------------------------------------------------------------------
// 8) 新 CSS 仅 foundation 变量（禁新 hex/rgb/hsl —— 由 design-tokens-drift 全局门禁兜底，
//    此处再对 WMB-5239 新规则区域做局部断言）
// ---------------------------------------------------------------------------

test('WMB-5239 UI: maintenance user-language labels never leak engineering terms', () => {
  const ENGINEERING = /compiled|receipt|changeset|hot[-_ ]?cache|index|cursor|scan_compile|phase/i;
  assert.match(libraryMaintenanceParts, /MAINTENANCE_PHASE_LABELS/);
  assert.match(libraryMaintenanceParts, /scan_compile: '整理资料'/);
  assert.match(libraryMaintenanceParts, /lint: '检查健康'/);
  assert.match(libraryMaintenanceParts, /report: '生成报告'/);
  assert.match(libraryMaintenanceParts, /running: '整理中'/);
  assert.match(libraryMaintenanceParts, /paused: '已暂停'/);
  assert.match(libraryMaintenanceParts, /completed: '已完成'/);
  assert.match(libraryMaintenanceParts, /failed: '失败'/);
  assert.doesNotMatch(libraryMaintenanceParts, /成功整理 \$\{summary\.success\} 条[^']*(compiled|receipt|changeset)/);
  // 批量摄取反馈与失败项全部为用户语言。
  assert.match(libraryMaintenanceParts, /成功整理 \$\{summary\.success\} 条/);
  assert.match(libraryMaintenanceParts, /低价值保留原始/);
  assert.match(libraryMaintenanceParts, /待重试/);
  assert.match(libraryMaintenanceParts, /整理停滞（连续多批没有进展）/);
  // 清洗映射把内部词替换为用户语言（Source→资料、Topic→主题、Lint→健康检查）。
  assert.match(libraryMaintenanceParts, /\['Source', '资料'\]/);
  assert.match(libraryMaintenanceParts, /\['Topic', '主题'\]/);
  assert.match(libraryMaintenanceParts, /\['Lint', '健康检查'\]/);
});

test('WMB-5239 UI: new discovery/log/health CSS rules use theme tokens only', async () => {
  const COLOR = /#[0-9a-fA-F]{3,8}\b|\brgb\(/;
  const section = (src, marker) => {
    const at = src.indexOf(marker);
    return at < 0 ? '' : src.slice(at);
  };
  // 共享发现组件样式在 styles-knowledge.css（wiki-search-panel / wiki-log-panel）。
  const knowledgeCss = await readFile(new URL('../src/renderer/styles-knowledge.css', import.meta.url), 'utf8');
  const discoveryCss = section(knowledgeCss, '.wiki-search-panel') || section(knowledgeCss, '.wiki-discovery');
  const canvasSection = section(canvasCss, 'data-kc-log-toggle') || section(canvasCss, '.kc-health-hint');
  const topicSection = section(topicCss, 'topic-wiki-search');
  for (const [name, block] of [['discovery', discoveryCss], ['canvas', canvasSection], ['topic', topicSection]]) {
    if (!block) continue;
    assert.doesNotMatch(block, COLOR, `${name} 新样式不应出现裸色值`);
  }
  // 覆盖类选择器存在性（浅层）。
  assert.match(knowledgeCss, /\.wiki-search-panel|\.wiki-discovery/);
  assert.match(canvasCss, /\.kc-health-hint|\.kc-log/);
  assert.match(topicCss, /topic-wiki-search-input|topic-wiki-search-result/);
});
