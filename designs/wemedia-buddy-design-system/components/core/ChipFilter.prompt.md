# ChipFilter

A pressed-chip filter for scoping a list (今日「仅看可批」、选题台账「按批次」、资料库「按状态」). It is NOT a tab — navigation uses TabList; filtering uses ChipFilter with `aria-pressed`. Optional count badge mirrors `.proposal-tab-count` styling.

```jsx
<ChipFilter label="仅看可批" pressed={onlyApproval} onToggle={setOnlyApproval} />
<ChipFilter label="全部" count={12} pressed />
```

Pressed state: accent-faint fill, accent-soft label, accent-mixed border. Sizes md 40px / sm 32px. Group chips in a `.filter-row` (gap 9px, wrap).
