# StatePanel

Every async region renders exactly one of four states — loading, error with retry, honest empty, content. This is the WMB-5258 four-state contract; a loading region must never show empty copy ("没有资料" while IPC is still running is a bug).

```jsx
<StatePanel state="loading" />
<StatePanel state="error" action={{label:'重试',onClick:reload}} />
<StatePanel state="empty" title="今日还没有入库资料" body="先去发现页看看外面有什么值得跟的。" />
<StatePanel state="content">{rows}</StatePanel>
```

Loading: pulsing accent badge + 「正在读取…」, `role="status"`. Error: danger badge + retry button (secondary sm). Empty: muted badge + guide copy that tells the user what to do next, never "nothing here". Content: children fill the panel.
