# FormField

Label + control + helper/error shell for 设置 (总机), onboarding, and Pi model configuration. The label is the programmatic name — placeholder text is never the label (WMB-5258 §4). Error swaps the helper, tints the control border danger, and announces with `role="alert"`.

```jsx
<FormField label="工作区名称" htmlFor="ws-name" helper="给本地资料库起个名字">
  <input id="ws-name" value={name} onChange={e => setName(e.target.value)} />
</FormField>
<FormField label="Pi API Key" htmlFor="pi-key" error="Key 不能为空">
  <input id="pi-key" type="password" />
</FormField>
```

Controls: 42px inputs/selects, 96px+ textareas, radius 7, `--surface-raised` fill; focus = accent border + soft accent outline. Switch rows follow the settings-switch pattern.
