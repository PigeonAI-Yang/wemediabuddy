# TabList

Room-level tab navigation with the full keyboard contract: roving tabindex, ArrowLeft/Right wrap, Home/End jump. Used by 选题台账 (今日可批/待处理/已批) and 资料库 sections. Filters are a different control — use ChipFilter for pressed chips.

```jsx
<TabList tabs={[{id:'today',label:'今日可批',count:3},{id:'shelved',label:'待处理',count:9}]}
         selectedId={tab} onSelect={setTab} ariaLabel="选题台账" />
```

Selected tab: accent-soft label + 2px accent underline + tinted count pill (`.proposal-tab` grammar, 40px row). Each tab exposes `aria-controls` pointing at its panel.
