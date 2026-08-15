# AppModal

The one modal layer in the product (WMB-5251): portal to body, a single focus trap, Esc + backdrop + close-button policy, body scroll lock, focus return on close, and compact degradation to fullscreen under 800×700. Feature code customizes only `children` / `footer` / `className` — never rebuild backdrop or focus behavior. No nested AppModals.

```jsx
<AppModal open={open} title="智能体详情" size="large" onRequestClose={close}>
  <p>员工详情、任务台账与授权状态。</p>
</AppModal>
```

Sizes: confirm 520px / standard 700px / large min(1040px, vw−64) / fullscreen. Danger confirms use `role="alertdialog"` with a danger primary in `footer`.
