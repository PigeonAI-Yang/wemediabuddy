# StatusPill

Compact status readout pairing a 6px dot with a word — color is never the only signal. Use for run phases (扫描中/等待资源/已完成/失败可重试), page status (今日情报运行中), and list item states.

```jsx
<StatusPill tone="warn">扫描中</StatusPill>
<StatusPill tone="needs-user">等你批</StatusPill>
<StatusPill tone="bad" live>入库失败，可重试</StatusPill>
```

Tones: idle (muted), ok (success), warn (status-running amber), needs-user (info blue), bad (danger red), active (accent violet). For live async regions pass `live` to get `role="status"`. Words come from the shared status vocabulary — machine codes never leak into the pill.
