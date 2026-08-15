# RoleCard

The crew roster's full-card button (智能体班组): the card IS the button — no nested interactive elements, keyboard reachable, opens the detail modal. Five roles stay visible (桌助/记者/策划/写手/资料员 + 主管席); empty roles show 「当前无任务」, never a fabricated idle state.

```jsx
<RoleCard labelZh="记者" roomZh="前线 · 发现" status="running" word="扫描中"
          percent="42%" summary="今日热点扫描" onOpen={openRole} />
```

Status colors double-encode with words (running amber, needs-user blue, ok green, bad red). Progress rail: determinate `--progress` width or indeterminate slide; reduced-motion freezes both. 228px min-height, 5-up grid at 170px min columns.
