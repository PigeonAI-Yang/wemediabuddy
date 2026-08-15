# Button

The shared action control for the 主编台 — every action hierarchy in the product goes through one owner. Use `variant="primary"` at most once per view (One Violet); `secondary` for the next tier; `text` for quiet inline actions; `danger` for destructive confirms.

```jsx
<Button variant="primary" onClick={startIntelligence}>开始今日情报</Button>
<Button variant="secondary">重新侦察</Button>
<Button variant="danger" size="sm">删除并归档</Button>
```

Variants: primary (accent fill, `--accent-ink` label), secondary (raised surface + strong border), text (transparent, accent-soft), danger (red fill `--danger-button`). Sizes: md 40px / sm 32px. Disabled state is shared (`opacity .5`, no press). Danger + disabled never both apply.
