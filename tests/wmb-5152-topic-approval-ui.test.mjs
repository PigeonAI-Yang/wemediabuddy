import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/renderer/topic-maintenance-ledger.tsx', import.meta.url), 'utf8');
const topicView = await readFile(new URL('../src/renderer/library-topics-view.tsx', import.meta.url), 'utf8');
const topicCss = `${await readFile(new URL('../src/renderer/styles-knowledge.css', import.meta.url), 'utf8')}\n${await readFile(new URL('../src/renderer/styles-knowledge-topic.css', import.meta.url), 'utf8')}`;

test('topic approval ledger uses explicit primary and secondary actions', () => {
  assert.match(source, /decision === 'approve' \? window\.wmb\.approveTopicMaintenanceProposal : window\.wmb\.rejectTopicMaintenanceProposal/);
  assert.match(source, /onClick=\{\(\) => void decide\(item, 'approve'\)\}/);
  assert.match(source, /onClick=\{\(\) => void decide\(item, 'reject'\)\}/);
  assert.match(source, /className="primary-button"[\s\S]*?busy\?\.decision === 'approve'[\s\S]*?'正在批准…'/);
  assert.match(source, /className="secondary-button"[\s\S]*?busy\?\.decision === 'reject'[\s\S]*?'正在驳回…'/);
});

test('editor view translates status and hides technical semantics behind a second disclosure', () => {
  assert.doesNotMatch(source, /待你批准/);
  assert.match(source, /资料员建议/);
  assert.match(source, /批准后影响/);
  assert.match(source, /className="topic-maintenance-technical"/);
  assert.match(source, /<summary>技术明细<\/summary>/);
  assert.match(source, /<h4>主题变化<\/h4>/);
  assert.match(source, /`状态：\$\{beforeStatus\} → \$\{afterStatus\}`/);
  assert.match(source, /主题状态不变，仅调整关联内容/);
  assert.match(source, /说明：\$\{String\(previous\.summary \?\? '无'\)\} → \$\{String\(next\.summary \?\? '无'\)\}/);
  assert.match(source, /类型：\$\{topicKindLabels/);
  assert.match(source, /主题识别方式已更新/);
  assert.doesNotMatch(source, /function TopicRows/);
  assert.doesNotMatch(source, /<TopicRows title="变更前主题"/);
  assert.doesNotMatch(source, /<TopicRows title="批准后主题"/);
  assert.match(source, /<h4>批准前关联<\/h4><TechnicalDetails state=\{item\.snapshot\.before\}/);
  assert.match(source, /<h4>批准后关联<\/h4><TechnicalDetails state=\{item\.snapshot\.after\}/);
  assert.match(source, /row\.relation/);
  assert.doesNotMatch(source, /<small>\{item\.status\}/);
  assert.doesNotMatch(source, /批准冻结版本/);
  assert.doesNotMatch(source, /审核完整冻结变更/);
});

test('stale lifecycle stays concise and never gives the Owner fake work', () => {
  assert.match(source, /label: '历史未生效'/);
  assert.match(source, /label: '资料员正在重新整理'/);
  assert.match(source, /label: '重新整理未完成'/);
  assert.match(source, /label: '已由新版接替'/);
  assert.match(source, /你无需操作/);
  assert.match(source, /无需你手工整理主题/);
  assert.match(source, /资料员重新提交/);
  assert.doesNotMatch(source, /请资料员重新整理后提交/);
  assert.match(source, /resumeTopicMaintenanceReproposal/);
  assert.match(source, /resumeTopicMaintenanceReproposal\(\{ id: item\.id \}\)/);
  assert.match(source, /重新交给资料员/);
  assert.match(source, /item\.reproposal\?\.status === 'needs_user'/);
});

test('topic home opens maintenance as a separate subpage after the status filters', () => {
  assert.doesNotMatch(topicView, /<div className="topic-home"[\s\S]*?<TopicMaintenanceLedger \/>[\s\S]*?className="topic-home-toolbar/);
  assert.match(topicView, /className="topic-status-filters[\s\S]*?className="topic-maintenance-entry"/);
  assert.match(topicView, /整理台账<\/button>/);
  assert.match(topicView, /className="topic-maintenance-page"/);
  assert.match(topicView, /← 主题/);
  assert.match(topicView, /maintenanceOpen \? maintenanceView : homeView/);
});

test('approval errors remain announced', () => {
  assert.match(source, /role="alert"/);
  assert.match(source, /正在加载整理记录…/);
  assert.match(source, /暂无整理记录。/);
  assert.match(source, /if \(!result\?\.ok\) \{ setError\([\s\S]*?return; \}\s*load\(\);/);
  assert.match(source, /finally \{ setBusy\(null\); \}/);
});

test('topic home keeps search and filters compact while approval actions stay in the visible card header', () => {
  assert.doesNotMatch(topicView, /<h1>主题<\/h1>/);
  assert.doesNotMatch(source, /<h2>主题整理提案台账<\/h2>/);
  assert.match(source, /item\.status === 'proposed' \? null : <span className="topic-maintenance-status"/);
  assert.match(source, /state: 'approved', label: '已批准并生效'/);
  assert.match(source, /state: 'rejected', label: '已驳回'/);
  assert.ok(topicView.indexOf('placeholder="搜索主题"') < topicView.indexOf('className="topic-status-filters studio-filter-row"'));
  assert.match(topicCss, /\.topic-home-toolbar\.library-topic-list-toolbar\s*\{[^}]*display:\s*flex;/);
  assert.match(topicCss, /\.topic-home-toolbar\s*>\s*input\[type="search"\]\s*\{[^}]*flex:\s*0 1 360px;/);
  assert.match(topicCss, /\.topic-maintenance-ledger\s*\{[^}]*flex:\s*none;/);
  assert.match(source, /className="topic-maintenance-head-side"/);
  assert.ok(source.indexOf('className="topic-maintenance-actions"') < source.indexOf('className="topic-maintenance-summary"'));
  assert.match(source, /className="topic-maintenance-reason"/);
  assert.doesNotMatch(source, /<strong>\{item\.title\}<\/strong><p>\{item\.reason\}<\/p>/);
  const headerIndex = source.indexOf('className="topic-maintenance-head"');
  const actionsIndex = source.indexOf('className="topic-maintenance-actions"');
  const summaryIndex = source.indexOf('className="topic-maintenance-summary"');
  const technicalIndex = source.indexOf('className="topic-maintenance-technical"');
  const reasonIndex = source.indexOf('className="topic-maintenance-reason"');
  assert.ok(headerIndex >= 0 && actionsIndex > headerIndex && actionsIndex < summaryIndex, '批准/驳回动作必须位于卡片可见头部，而非折叠明细');
  assert.ok(technicalIndex > summaryIndex && reasonIndex > technicalIndex, '原始说明只进入二级技术明细，不挤占摘要');
  assert.match(topicCss, /\.topic-maintenance-row\{[^}]*grid-template-areas:"head" "summary" "diff" "warning"/, '卡片区块顺序固定，动作头部不被摘要覆盖');
  assert.match(topicCss, /\.topic-maintenance-head\{[^}]*flex-wrap:wrap/, '窄宽度下头部必须换行防裁切');
  assert.match(topicCss, /\.topic-maintenance-head-side\{[^}]*margin-left:auto/, '动作组保持在头部尾侧');
  assert.match(topicCss, /\.topic-maintenance-actions\{[^}]*justify-content:flex-end/, '批准动作保持可见对齐');
  assert.match(topicCss, /@media\(max-width:800px\)\{[^}]*\.topic-maintenance-head\{[^}]*flex-direction:column/, '小屏头部改为纵向，避免动作被截断');
  assert.match(topicCss, /\.topic-maintenance-actions button\{flex:1\}/, '小屏批准与驳回按钮平分可用宽度');
});
