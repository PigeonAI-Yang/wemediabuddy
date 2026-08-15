# IconButton

Square icon-only action for dense rows (Today opportunity actions, editor toolbars). The accessible name is mandatory — never ship an icon without `label`. Use `variant="ghost"` inside cards/rows where a bordered square would shout; use `variant="danger"` only for destructive icon actions (e.g. 否掉这个机会).

```jsx
<IconButton label="否掉这个机会" variant="ghost"><XGlyph /></IconButton>
<IconButton label="开始创作" size="sm"><PenGlyph /></IconButton>
```

Sizes: md 38px / sm 32px. Glyph convention: 24 viewBox, stroke `currentColor`, stroke-width 1.7–1.85, round caps (source `.sidebar svg` / `.icon-action-button`).
