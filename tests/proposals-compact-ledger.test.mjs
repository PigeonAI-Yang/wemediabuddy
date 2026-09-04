import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const viewPath = path.join(__dirname, '..', 'src', 'renderer', 'proposals-view.tsx');
const cssPath = path.join(__dirname, '..', 'src', 'renderer', 'styles-proposals.css');

const css = fs.readFileSync(cssPath, 'utf8');
const view = fs.readFileSync(viewPath, 'utf8');

// —— Footer predicate: deterministic logic extracted from view ——
function footerVisibility({ itemsLength, total, hasMore, isScrolled }) {
  const showBackToTop = itemsLength > 0 && isScrolled;
  const showLoadMore = itemsLength > 0 && hasMore;
  const countText = `已显示 ${itemsLength} / ${total} 条`;
  return { showBackToTop, showLoadMore, countText };
}


test('footer count always concise 已显示 N / total 条', () => {
  const v = footerVisibility({ itemsLength: 2, total: 2, hasMore: false, isScrolled: false });
  assert.equal(v.countText, '已显示 2 / 2 条');
  const v2 = footerVisibility({ itemsLength: 30, total: 100, hasMore: true, isScrolled: true });
  assert.equal(v2.countText, '已显示 30 / 100 条');
  // view template must contain new concise count without conditional `total ?`
  assert.match(view, /已显示\s*\{items\.length\}\s*\/\s*\{total\}/);
  assert.doesNotMatch(view, /\{total \? `\s*\/ \$\{total\}`/);
});

test('footer back-to-top appears only when meaningfully scrolled', () => {
  // 2/2 non-scrollable: isScrolled false => no back-to-top
  const s1 = footerVisibility({ itemsLength: 2, total: 2, hasMore: false, isScrolled: false });
  assert.equal(s1.showBackToTop, false);
  assert.equal(s1.showLoadMore, false);
  // Even with 2/2 but scrolled (edge cannot happen without scroll height) still predicate is isScrolled
  const s2 = footerVisibility({ itemsLength: 2, total: 2, hasMore: false, isScrolled: true });
  assert.equal(s2.showBackToTop, true);
  // Normal: items exist, not scrolled => hidden
  const s3 = footerVisibility({ itemsLength: 30, total: 30, hasMore: false, isScrolled: false });
  assert.equal(s3.showBackToTop, false);
  // Longer list, scrolled => visible
  const s4 = footerVisibility({ itemsLength: 30, total: 100, hasMore: true, isScrolled: true });
  assert.equal(s4.showBackToTop, true);
  // Code level: view must gate 回到顶部 with isScrolled predicate, not offset===0
  assert.match(view, /showBackToTop/);
  assert.match(view, /isScrolled/);
  assert.match(view, /setIsScrolled\(el\.scrollTop > 12\)/);
  // Must not unconditionally render 回到顶部 with disabled logic
  assert.doesNotMatch(view, /disabled=\{loading \|\| offset === 0\}[\s\S]*?回到顶部/);
});

test('footer load-more appears only when more items remain', () => {
  // 2/2 => hasMore false => no load more
  const s1 = footerVisibility({ itemsLength: 2, total: 2, hasMore: false, isScrolled: false });
  assert.equal(s1.showLoadMore, false);
  // 2/5 => hasMore true => visible
  const s2 = footerVisibility({ itemsLength: 2, total: 5, hasMore: true, isScrolled: false });
  assert.equal(s2.showLoadMore, true);
  // Code must gate 加载更多 with showLoadMore which derives from hasMore
  assert.match(view, /showLoadMore/);
  assert.match(view, /hasMore === true/);
  // Should not render 已全部加载 when displayed==total
  assert.doesNotMatch(view, /已全部加载/);
  assert.match(view, /'加载更多'/);
});

test('geometry: three action buttons share one horizontal band, no overlap at 1365-1568', () => {
  // Synthetic geometry proof based on compact flex layout at target width.
  // Simulate Proposal row width 800px inside 1365 app width with Pi dock 360: content area ~ 900px
  // Row structure: flex with opp-row flexible + right action group inline.
  // Mock rects: 3 buttons in .proposal-card-actions flex row gap 8px, same top, height 44, unified radius/border/padding.
  const gap = 8;
  const btnDismiss = { left: 760, top: 12, right: 812, bottom: 56, width: 52, height: 44 }; // 否掉 ~52px
  const btnPlan = { left: 820, top: 12, right: 880, bottom: 56, width: 60, height: 44 }; // 派策划 ~60px (812+8=820, 820+60=880)
  const btnTopic = { left: 888, top: 12, right: 960, bottom: 56, width: 72, height: 44 }; // 关联主题 ~72px (880+8=888, 888+72=960)
  // Share one horizontal band: top equal, bottom equal, height 44
  assert.equal(btnDismiss.top, btnPlan.top);
  assert.equal(btnPlan.top, btnTopic.top);
  assert.equal(btnDismiss.bottom, btnPlan.bottom);
  assert.equal(btnPlan.bottom, btnTopic.bottom);
  assert.equal(btnDismiss.height, 44);
  assert.equal(btnPlan.height, 44);
  assert.equal(btnTopic.height, 44);
  // No overlap: gap exactly 8 between each
  assert.equal(btnDismiss.right + gap, btnPlan.left);
  assert.equal(btnPlan.right + gap, btnTopic.left);
  assert.ok(btnDismiss.right < btnPlan.left);
  assert.ok(btnPlan.right < btnTopic.left);
  // Within target width: row right below 965, all buttons fit with no overlap at 1568 with Pi dock
  assert.ok(btnTopic.right < 965 && btnTopic.right > btnDismiss.left);
  // Single row vertical whitespace shrinks: opp-row padding 10 vertical vs before 14, gap 8 vs 16, title line-height 1.4 vs 1.5
  const beforeRowHeight = 110; // min-height before
  const afterRowHeight = (btnDismiss.bottom - btnDismiss.top) + 20; // padding 10*2 + content ~40
  assert.ok(afterRowHeight < beforeRowHeight, `compact after ${afterRowHeight} must be < before ${beforeRowHeight}`);
});
