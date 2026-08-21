// WMB-5212 Topic Wiki renderer —— renderer 聚焦合同测试。
// 覆盖：Wiki-first 默认详情顺序（当前认识→最近变化→证据→创作影响→待研究→完整档案→版本）、
// 后端投影消费（getTopicWikiDetail）、stale/failed/disputed/inference 可见、版本恢复走既有
// ChangeSet 写路径（restoreFromVersionId 追加新版本）、dataChanged 订阅替代手动刷新、
// 深链保持 topicId 开详情、原 dossier 仍可达、键盘/响应式/主题、无新顶层路由/平行 Topic。
// WMB-5242：产品语言锁定 —— 顶级“主题”保留、不新增 Wiki 路由、四页签保留、主用户文案
// （资料员持续维护/当前认识/已整理或等待整理）存在、主流程不出现 尚无正式 Wiki/正式编译/编译失败/知识风险。
// 不做项目级 formatter/linter/全量测试；由主 Agent 集成后统一执行。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const view = await readFile(new URL('../src/renderer/library-topics-view.tsx', import.meta.url), 'utf8');
const helpers = await readFile(new URL('../src/renderer/library-topics-helpers.ts', import.meta.url), 'utf8').catch(() => '');
const constants = await readFile(new URL('../src/renderer/library-topics-constants.ts', import.meta.url), 'utf8').catch(() => '');
const parts = await readFile(new URL('../src/renderer/library-topics-parts.tsx', import.meta.url), 'utf8').catch(() => '');
const wiki = await readFile(new URL('../src/renderer/library-topics-wiki.tsx', import.meta.url), 'utf8').catch(() => '');
const topicView = view + helpers + constants + parts + wiki;
const appShell = await readFile(new URL('../src/renderer/main.tsx', import.meta.url), 'utf8');
const appTypes = await readFile(new URL('../src/renderer/app-types.ts', import.meta.url), 'utf8');
const topicCss = await readFile(new URL('../src/renderer/styles-knowledge-topic.css', import.meta.url), 'utf8');
const sharedTypes = await readFile(new URL('../src/shared/knowledge-topic-library.ts', import.meta.url), 'utf8');

test('WMB-5212 UI: Wiki-first default detail order is fixed (当前认识→最近变化→证据→创作影响→待研究→完整档案→版本)', () => {
  // 章节顺序常量：一份数组驱动渲染与键盘，顺序不得漂移。
  assert.match(topicView, /const WIKI_SECTION_ORDER = \['current', 'changes', 'evidence', 'impact', 'research', 'dossier', 'versions'\]/);
  assert.match(topicView, /current: '当前认识'/);
  assert.match(topicView, /changes: '最近变化'/);
  assert.match(topicView, /evidence: '证据'/);
  assert.match(topicView, /impact: '创作影响'/);
  assert.match(topicView, /research: '待研究'/);
  assert.match(topicView, /dossier: '完整档案'/);
  assert.match(topicView, /versions: '版本'/);
  // 详情渲染按顺序输出全部章节 id（aria-labelledby + 可聚焦章节）。
  const currentIdx = topicView.indexOf('id="topic-wiki-current"');
  const changesIdx = topicView.indexOf('id="topic-wiki-changes"');
  const evidenceIdx = topicView.indexOf('id="topic-wiki-evidence"');
  const impactIdx = topicView.indexOf('id="topic-wiki-impact"');
  const researchIdx = topicView.indexOf('id="topic-wiki-research"');
  const dossierIdx = topicView.indexOf('id="topic-wiki-dossier"');
  const versionsIdx = topicView.indexOf('id="topic-wiki-versions"');
  for (const idx of [currentIdx, changesIdx, evidenceIdx, impactIdx, researchIdx, dossierIdx, versionsIdx]) {
    assert.ok(idx >= 0, 'Wiki 章节必须存在');
  }
  assert.ok(currentIdx < changesIdx && changesIdx < evidenceIdx && evidenceIdx < impactIdx, '前三章顺序固定');
  assert.ok(impactIdx < researchIdx && researchIdx < dossierIdx && dossierIdx < versionsIdx, '后四章顺序固定');
});

test('WMB-5226 UI: four product tabs (概览/资料/变化/版本) replace the sticky section nav; sections, keyboard and deep links kept', () => {
  // 页签常量与文案（一份数组驱动渲染）。
  assert.match(topicView, /const WIKI_TAB_ORDER = \['overview', 'sources', 'changes', 'versions'\] as const/);
  assert.match(topicView, /overview: '概览'/);
  assert.match(topicView, /changes: '变化'/);
  assert.match(topicView, /versions: '版本'/);
  // 七章节 → 所属页签映射（键盘 1–7 与深链接仍可跨页签直达章节）。
  assert.match(topicView, /current: 'overview'/);
  assert.match(topicView, /changes: 'changes'/);
  assert.match(topicView, /evidence: 'sources'/);
  assert.match(topicView, /research: 'sources'/);
  assert.match(topicView, /dossier: 'sources'/);
  assert.match(topicView, /versions: 'versions'/);
  // 页签真实计数：资料=档案来源数、变化=receipts.total、版本=versions.total。
  assert.match(topicView, /tab === 'sources' \? \(counts\.sources \?\? 0\)/);
  assert.match(topicView, /wikiDetail\.receipts\.total/);
  assert.match(topicView, /wikiDetail\.versions\.total/);
  // 概览容纳 已有资料（sourcesPreview 两条真实来源）+ 最近变化（receipts 轻时间线）。
  assert.match(topicView, /已有资料/);
  assert.match(topicView, /sourcesPreview\.slice\(0, 2\)/);
  assert.match(topicView, /receipts\.slice\(0, 3\)/);
  assert.match(topicView, /展开剩余 \{sourcesPreview\.length - 2\} 份资料/);
  // 唯一主 CTA：让 Pi 出选题方案；去创作降级进更多菜单。
  assert.match(topicView, /让 Pi 出选题方案/);
  assert.match(topicView, /去创作/);
  // 无技术文案：不出现 Wiki 字样加载/失败/兜底文案。
  assert.doesNotMatch(topicView, /正在加载 Wiki/);
  assert.doesNotMatch(topicView, /Wiki 加载失败/);
  assert.doesNotMatch(topicView, /尚无编译 Wiki/);
});

test('WMB-5242 UI: product language locked (主题 nav kept, no wiki route, 资料员持续维护/当前认识/已整理或等待整理 present, engineering phrases absent)', () => {
  // 顶级导航仍叫“主题”，且不新增 Wiki 路由/视图（View 联合类型与 pageLabels 均无 wiki）。
  assert.match(appShell, /topic: '主题'/);
  const viewTypeLine = appTypes.split('\n').find((line) => line.includes('type View ='));
  assert.ok(viewTypeLine, 'app-types 必须声明 View 联合类型');
  assert.match(viewTypeLine ?? '', /'topic'/);
  assert.doesNotMatch(viewTypeLine ?? '', /'wiki'/);
  const pageLabelsLine = appShell.split('\n').find((line) => line.includes('const pageLabels'));
  assert.ok(pageLabelsLine, 'main.tsx 必须声明 pageLabels');
  assert.doesNotMatch(pageLabelsLine ?? '', /wiki:/);
  // 主用户文案必须存在：资料员持续维护 / 当前认识 / 整理状态语言（已整理 或 等待整理）。
  assert.match(topicView, /资料员持续维护/);
  assert.match(topicView, /当前认识/);
  assert.match(topicView, /已整理/);
  assert.match(topicView, /等待整理/);
  // 整理状态映射：compiling→正在整理新资料，stale→有新资料待更新，failed→整理失败。
  assert.match(topicView, /compiling: '正在整理新资料'/);
  assert.match(topicView, /stale: '有新资料待更新'/);
  assert.match(topicView, /failed: '整理失败'/);
  // 主流程不得出现工程/失败措辞：尚无正式 Wiki / 正式编译 / 编译失败 / 知识风险。
  assert.doesNotMatch(topicView, /尚无正式 Wiki/);
  assert.doesNotMatch(topicView, /正式编译/);
  assert.doesNotMatch(topicView, /编译失败/);
  assert.doesNotMatch(topicView, /知识风险/);
  // 列表与详情保留 当前综合/更新时间/整理状态 的用户可见钩子（DOM 钩子不漂移）。
  assert.match(topicView, /topic-object-card-summary/);
  assert.match(topicView, /topic-object-card-meta/);
  assert.match(topicView, /topic-compile-state/);
  assert.match(topicView, /topic-object-meta/);
});

test('WMB-5212 UI: default detail consumes the frozen backend projection getTopicWikiDetail', () => {
  assert.match(topicView, /window\.wmb\.getTopicWikiDetail\(\{ topicId, \.\.\.WIKI_DETAIL_LIMITS \}\)/);
  // 有界投影：五类列表全部限流，不无界拉取。
  assert.match(topicView, /const WIKI_DETAIL_LIMITS = \{[\s\S]*?versionsLimit: 30,[\s\S]*?receiptsLimit: 10,[\s\S]*?evidenceLimit: 30,[\s\S]*?questionsLimit: 30,[\s\S]*?healthLimit: 20,[\s\S]*?usageLimit: 20/);
  // 共享契约类型被消费（渲染端零 JSON 解析；body 由主进程解析）。
  assert.match(topicView, /import type \{[^}]*TopicWikiDetail/);
  assert.ok(sharedTypes.includes('export type TopicWikiDetail ='), '共享契约声明 TopicWikiDetail');
  assert.ok(sharedTypes.includes('export type TopicWikiBody ='), '共享契约声明 TopicWikiBody');
});

test('WMB-5212 UI: stale/failed/disputed/inference all have observable UI (semantic labels, not color-only)', () => {
  // 整理状态：stale/failed/compiling 显式横幅 + 原因（不显示半成品正文）。
  // WMB-5242：stale→有新资料待更新，failed→整理失败（不再出现 待重编译/编译失败）。
  assert.match(topicView, /COMPILE_STATUS_LABELS: Record<string, string> = \{[\s\S]*?stale: '有新资料待更新',[\s\S]*?failed: '整理失败'/);
  assert.match(topicView, /topic-wiki-compile-banner/);
  assert.match(topicView, /wikiDetail\.wiki\?\.compileNote/);
  // 风险汇总：disputed / contradicted / inference 计数 + stale/failed 布尔（语义标签）。
  assert.match(topicView, /RISK_KIND_LABELS\.disputed/);
  assert.match(topicView, /RISK_KIND_LABELS\.contradicted/);
  assert.match(topicView, /RISK_KIND_LABELS\.inference/);
  assert.match(topicView, /wikiRisks\.disputed > 0 \? <span className="library-topic-badge warn">/);
  assert.match(topicView, /wikiRisks\.contradicted > 0 \? <span className="library-topic-badge danger">/);
  assert.match(topicView, /wikiRisks\.inference > 0 \? <span className="library-topic-badge info">/);
  assert.match(topicView, /RISK_KIND_LABELS\.stale/);
  // 结论状态语义标签（不只有颜色）：status-ok/warn/danger/info + data-status。
  assert.match(topicView, /CONCLUSION_STATUS_LABELS\[status\]/);
  assert.match(topicView, /data-status=\{status\}/);
  assert.match(topicView, /CONCLUSION_STATUS_CLASS/);
  // 争议（kept_disputed）独立展示，不自动裁决。
  assert.match(topicView, /retainedDisputes/);
  assert.match(topicView, /未解决争议/);
  assert.match(topicView, /这些主张仍在对抗中，未自动裁决/);
});

test('WMB-5212 UI: version timeline + restore goes through the existing ChangeSet write path (appends new version)', () => {
  assert.match(topicView, /恢复此版本/);
  assert.match(topicView, /restoreWikiVersion/);
  // 恢复 = 既有写命令 submitKnowledgeChangeSet，wikiPages[].version.restoreFromVersionId 追加新版本。
  assert.match(topicView, /window\.wmb\.submitKnowledgeChangeSet\(\{/);
  assert.match(topicView, /restoreFromVersionId: version\.id/);
  assert.match(topicView, /beforeRevision: page\.revision/);
  assert.match(topicView, /triggerSource: 'user'/);
  // 设计 §2.7：恢复明确说明会生成新版本，不覆盖历史。
  assert.match(topicView, /恢复会生成一个以 V\$\{version\.versionNumber\} 内容为基础的新版本（不覆盖历史）/);
  assert.match(topicView, /version\.id === wikiPage\?\.currentVersionId/);
  // 差异可展开查看（readableDiff），aria 明确。
  assert.match(topicView, /readableDiff/);
  assert.match(topicView, /<summary>查看差异<\/summary>/);
});

test('WMB-5212 UI: dataChanged subscription replaces manual refresh on topics/knowledge/receipt scopes', () => {
  assert.match(topicView, /window\.wmb\.onDataChanged/);
  assert.match(topicView, /scope === 'topics' \|\| scope === 'knowledge' \|\| scope === 'receipt' \|\| scope === 'library'/);
  assert.match(topicView, /setWikiReloadToken\(\(value\) => value \+ 1\)/);
  assert.match(topicView, /setSegmentReloadToken\(\(value\) => value \+ 1\)/);
  assert.match(topicView, /setDeepReloadToken\(\(value\) => value \+ 1\)/);
});

test('WMB-5212 UI: deep link keeps the real topicId and opens the accurate Topic Wiki', () => {
  // 既有深链事件保持 topicId 语义；initialTopicId 挂载深链也保留。
  assert.match(topicView, /const OPEN_TOPIC_EVENT = 'wmb-open-library-topic'/);
  assert.match(topicView, /custom\.detail\?\.topicId/);
  assert.match(topicView, /initialTopicId/);
  // Wiki 详情按 topicId 加载（不引入平行身份/新顶层路由）。
  assert.doesNotMatch(topicView, /wmb-open-topic-wiki/);
  assert.doesNotMatch(topicView, /navigate\('topic-wiki'\)/);
});

test('WMB-5212 UI: original dossier stays reachable (deep mode + fallback when no wiki)', () => {
  // 完整档案入口：Wiki 页内一键深查 + 更多菜单保留。
  assert.match(topicView, /打开完整档案/);
  assert.match(topicView, /setDeepMode\(true\)/);
  // 无编译 Wiki 时兜底显示既有档案，不显示半成品（WMB-5226 去除技术文案；WMB-5233 诚实三态）。
  // uncompiled 用户语言 =「尚未整理」（WMB-5242 去除 尚未编译）：空壳不显示已编译/当前。
  assert.match(topicView, /尚未整理/);
  assert.match(topicView, /以下为现有档案/);
  // WMB-5233：三态用户语言与诚实空壳横幅（legacy_shell = 初始档案，绝不显示已编译/当前）。
  assert.match(topicView, /COMPILE_STATE_LABELS/);
  assert.match(topicView, /legacy_shell: '初始档案'/);
  assert.match(topicView, /uncompiled: '等待整理'/);
  assert.match(topicView, /compile-state-\$\{compileState\}/);
  assert.match(topicView, /isMigration \? COMPILE_STATE_LABELS\.legacy_shell : '当前'/);
  // 既有八类 dossier 分类与 deep 模式原样保留。
  assert.match(topicView, /DOSSIER_CATEGORY_ORDER/);
  assert.match(topicView, /library-topic-deep-tabs/);
  assert.match(topicView, /getKnowledgeTopicDossier/);
});

test('WMB-5212 UI: keyboard reaches every wiki section (1-7) and keeps legacy segment keys', () => {
  assert.match(topicView, /const wikiKey = Number\(event\.key\);/);
  assert.match(topicView, /wikiIndex >= 0 && showWikiPage && !deepMode/);
  assert.match(topicView, /scrollToWikiSection\(WIKI_SECTION_ORDER\[wikiIndex\]\)/);
  // 无 Wiki 兜底仍保留 1/2/3 分段快捷键。
  assert.match(topicView, /setSegment\('judgments'\)/);
  assert.match(topicView, /setSegment\('sources'\)/);
  assert.match(topicView, /setSegment\('outcomes'\)/);
});

test('WMB-5212 UI: wiki page styles use theme tokens only, responsive nav, no bare color bypass', () => {
  assert.match(topicCss, /\.topic-wiki-page\{/);
  assert.match(topicCss, /\.topic-wiki-tabs\{/);
  assert.match(topicCss, /\.topic-wiki-tabs button\.active\{/);
  assert.match(topicCss, /\.topic-wiki-compile-banner\.stale\{/);
  assert.match(topicCss, /\.topic-wiki-compile-banner\.failed\{/);
  assert.match(topicCss, /\.topic-wiki-version\.current\{/);
  assert.match(topicCss, /\.topic-wiki-diff pre\{/);
  // 新视觉规则只使用主题 token（var(--*) / color-mix），不出现裸色值旁路。
  const section = topicCss.slice(topicCss.indexOf('/* ===== WMB-5212 M3'));
  assert.ok(section.length > 0, '样式文件应含 WMB-5212 章节');
  assert.doesNotMatch(section, /#[0-9a-fA-F]{3,6}/);
  assert.doesNotMatch(section, /rgb\(\s*\d+\s+\d+\s+\d+\s*\)/);
  // 窄容器 nav 可横向滚动不溢出；滚动锚点适配 sticky nav；布局按内容容器折叠。
  assert.match(section, /overflow-x:auto/);
  assert.match(section, /scroll-margin-top/);
  assert.match(section, /@container topic-wiki-content \(max-width:760px\)/);
});
