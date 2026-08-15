# WmbCreatureMark

The WMB brand creature (exact geometry from `src/renderer/wmb-brand-mark.tsx`) shown in its orchestration states; use in the topbar, Today scout area, and Pi presence markers. It is decorative — `aria-hidden` — so never put meaning in the mark alone.

```jsx
<WmbCreatureMark state="working" />
<WmbCreatureMark state="scout" className="today-scout" />
```

Variants: `idle` (default), `connect` (scanning a source), `working` (busy with work-fx), `settling` (one-shot ease-in), `sleep` (idle long), `scout` (roaming). Motion respects `prefers-reduced-motion`.
