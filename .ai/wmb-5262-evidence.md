# WMB-5262 evidence

## Scope

Four design artifacts only under `designs/publish-workspace-alternatives/`: one comparison overview plus three independent high-fidelity interactive Publish-page models. Formal renderer/product code, publication protocol, IPC, DB schema, permissions, Capability registry, dependencies, foundation brand tokens, Pi contract, and manual final-publication boundary are unchanged.

## User-locked brief

- Three genuinely different workspace models.
- Primary object: all-platform publishing operations board.
- Full chain: 待授权、待人工发布、需要接管、待对账、失败、已发布.
- Balance scan efficiency, single-draft review, and exception handling.
- Overview plus three independent pages.
- Pi collapsed by default and expandable.
- A/B restrained; C may be bold.

## Deliverables

- `designs/publish-workspace-alternatives/index.html`: comparison overview and trade-off matrix.
- `designs/publish-workspace-alternatives/queue-control.html`: A · 队列总控; dense task ledger + progressive detail + one-decision rail.
- `designs/publish-workspace-alternatives/immersive-review.html`: B · 沉浸终审; persistent all-platform inbox + dominant proofreading canvas + bottom signing bar.
- `designs/publish-workspace-alternatives/distribution-matrix.html`: C · 分发矩阵; content/version × platform/account matrix + focused action stage.
- `_d_meta.json` binds the compiled WeMediaBuddy design system copy under `_ds/`; C is `approved`, while the overview and A/B remain `needs-review` reference alternatives.

## Browser evidence

Real Chromium over `http://127.0.0.1:4311/publish-workspace-alternatives/`:

- 1600×960 overview: three model cards and comparison matrix; `overflowX=0`; console/page errors 0.
- A: 12 task rows cover all six states; initial primary `确认授权`; click transitions selected task `待授权 → 待人工发布`, primary becomes `打开并人工发布`; Pi `aria-expanded false → true`; theme dark → light; `overflowX=0`.
- B: six rows cover all six states; selected failed task `修复素材 → 待人工发布 → 确认重试 → 已发布`; final primary `查看回执`; success toast observed; `overflowX=0`.
- C: seven content rows × five platforms expose all six states; failed selected cell opens retry confirmation and transitions `失败 → 已发布`; primary becomes `查看数据`; success toast observed. Verification found `modalFooter` computed but not passed to `AppModal`; repaired by wiring `footer={modalFooter}` and reran the successful recovery flow.
- 1100×800: overview, A, B, C all `documentElement.scrollWidth - clientWidth = 0`; body width 1100; Pi default collapsed in A/B/C; console/page errors 0. C keeps the matrix internally scrollable while the page itself does not overflow.
- Color literal scan over all four HTML files found no one-off hex/rgb/hsl brand colors (the only regex hit was content text `#238`).
- `node --test tests/design-tokens-drift.test.mjs`: 3/3 PASS.

## Visual evidence

- Overview: `J:/Users/yangda01/Temp/omp-sshots-1557a3382201a0b6.webp`
- A · 队列总控: `J:/Users/yangda01/Temp/omp-sshots-1557a35b8e81a0b7.webp`
- B · 沉浸终审: `J:/Users/yangda01/Temp/omp-sshots-1557a36d1d41a0b8.webp`
- C · 分发矩阵: `J:/Users/yangda01/Temp/omp-sshots-1557a3c65a41a0b9.webp`
- C compact 1100×800: `J:/Users/yangda01/Temp/omp-sshots-1557a47d0681a0ba.webp`

## Review status

2026-08-15 Owner selected **C · 分发矩阵**. `distribution-matrix.html` is recorded as `approved`; no formal renderer implementation has started yet.
