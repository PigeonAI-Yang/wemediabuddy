purpose: Discover uses the last good X List snapshot while a manual refresh attempts to improve it; fails when an empty or partial live page makes cached cards disappear or reduces stored history.

Loop: WMB-4400 X refresh cache preservation
Symptom: Clicking `刷新动态` removed all visible posts even though cached posts existed.
Observation packet: packaged UK Discover, selected `英国资讯`; DOM showed no timeline cards and `还没有动态`; cache IPC and SQLite held 40 posts; repeat live refresh showed 20 and persisted only 20. Screenshots: `.ai/wmb-x-refresh-empty-before.png`, `.ai/wmb-x-refresh-empty-repro.png`.
Hypotheses: confirmed that Main and Renderer independently resolve refresh results; Main only rejects an exactly empty overwrite, Renderer always replaces visible posts, and a non-empty first page can shrink cache.
Bug type: timing-stale / state-missing at cache-to-view resolution.
Chain traced: `x-lists-view.tsx:readTimeline/applyLiveTimeline` -> preload `readXListTimeline` -> `ipc-x-lists.ts` -> `writeXListTimelineCacheIfImproved` -> SQLite/Renderer.
Breakpoint: Main returns raw live posts rather than the resolved last-good dataset, leaving Renderer to contradict persisted cache state.
Root cause: no single monotonic refresh contract for empty and partial results.
Files read: X Lists renderer, IPC, cache policy, focused cache/empty tests, real UK SQLite row.
Files changed: Main cache policy/IPC result, Renderer result type/copy, two focused regressions, loop state/report and task ledger.
Before/after gate: before DOM 0/cache 40 and later cache shrink 40->20; after deterministic empty/partial checks passed and packaged cold restart/real refresh stayed 20->20.
Owner check: real packaged Discover displayed cached cards before refresh and retained cards after the same button; screenshot `.ai/wmb-4400-refresh-after.png`.
Result: resolved dataset is now monotonic and shared by persistence and Renderer.
State update: complete.
Clean completion: yes.
Blocked reason: none.
