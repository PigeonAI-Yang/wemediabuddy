# PageCommand

The canonical 96px room command card that opens every desk/list room (今日、选题、发现、智能体、结果). It carries the room's decision summary, stat navigation (clickable stats act as filtered views), and at most one primary action — One Violet.

```jsx
<PageCommand title="选题台账" summary="今日值得批的方案"
  stats={[{key:'today',label:'今日可批',value:3,active:true,onSelect:showToday},
          {key:'shelved',label:'待处理',value:9,onSelect:showShelved}]}
  actions={[{label:'新建选题',variant:'primary',onClick:create}]} />
```

Compact: 108px below 1100px. Stats are `strong` value + `span` label; active stat tints accent-soft. Never more than one `variant="primary"` action.
