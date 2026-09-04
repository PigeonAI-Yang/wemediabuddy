# WMB-5337 Evidence — final implementation 2026-08-22

## Delivered behavior

- `src/main/daily-orchestration.ts` is the single A–E authority for scheduler, Today and MCP triggers.
- A reuses/creates yesterday draft and published-revision targets; B uses the installation BrowserProfile Zhihu reader and persists scans; C runs deterministic score/quota selection; D creates/reuses article identities and durable research/writer jobs; E creates/reuses the video-script derivative only after an article version exists.
- All orchestration mutations carry `{ workspaceId, source }` through `dispatchBusinessCommand`; deterministic IDs and persisted settlement make retries/restarts idempotent.
- One in-flight map deduplicates concurrent scheduler/Today/MCP triggers. Stage failures remain isolated. Settlement priority is `paused > needs_user > partial > completed`.
- Settlement persists per workspace/date and reports five stages plus target/completed/gap/skipped/carried/blocked/auto-selected/owner-selected counts.
- The orchestration graph contains no final publication action or platform write.

## Today surface

- `src/renderer/today-daily-cycle.tsx` is mounted in `TodayView`.
- Shows the Asia/Shanghai schedule, enable/disable control, editable time, one `立即执行` action, duplicate-click guard, running feedback, persisted latest settlement and A–E stage rows.
- `needs_user`, `partial`, `paused` and `failed` have explicit recovery copy and existing navigation affordances. No publication control was added.
- Styling is isolated in `styles-today-daily-cycle.css` and uses foundation semantic tokens only.

## Strongest verification

Command:

```text
node --test tests/wmb-5337-orchestration.test.mjs tests/wmb-5337-today-orchestration-ui.test.mjs
```

Result: **PASS 16/16** in 7.50s.

Covered contracts: shared in-flight authority, real A/B/D/E primitive invocation, cold-retry identity reuse, partial isolation, status priority, readable settlement, no publication path, Shanghai scheduling, existing renderer API use, schedule/run controls, persisted five-stage UI, keyboard accessibility and token discipline.

Browser proof: Vite-served production `TodayDailyCycle` rendered at 1672×1000 with a persisted partial settlement; width 1672px, height 643.5px, no horizontal overflow. Clicking `立即执行` changed the control to `编排进行中…`, set `disabled=true` and `aria-busy=true`, exposed `正在执行 A–E 五段编排，请稍候…`, then restored the idle control after settlement.

Resource cleanup: verification tab released; managed `omp.browser.headless` and `wmb-renderer-preview` both confirmed `exited`.

## Live workspace proof

- Installation-owned Edge BrowserProfile passed real Zhihu verification and the official `/hot` page persisted 30 observations and 30 Sources in the active data root.
- A real Today run settled `completed`: A `0`, B `30`, C `2/2` with gap `0`, D enqueued two reporter and two writer jobs, E correctly waited for an article version.
- A live failure exposed that `startMcp()` was not registered on `ActiveWorkspaceRuntime`; `src/main/index.ts` now calls `runtime.setMcp(mcp)` before initializing job schedulers. After restart, daily employee jobs advanced past `MCP_UNAVAILABLE` into real reporter/writer execution.
- Late scans now top up an existing partial cycle and deduplicate repeated observations by `source_item_id`; `node --test tests/wmb-5333-daily-cycle.test.mjs` passes **8/8** including the repeated-observation recovery case.
- Publication safety check: `publication_attempts` created after the run = **0**.
- CAP-028 remained effective: both selected projects stayed at `idea` with zero content versions because research/owner approval was not complete; no article, video script, platform version or publication was fabricated.
- Real score readback exposed one unresolved A2 issue: a duplicate-with-new-value candidate routed `boundary` but was persisted as `selection_mode='owner_approved'` without an Owner action. WMB-5338 remains blocked; this must be corrected or explicitly approved before final closure.

## Type integration note

The new Today callback diagnostic was fixed and disappeared on the second `npm run typecheck`. Repository typecheck remains blocked by 11 existing diagnostics in `ipc-intelligence-channels.ts`, `intelligence-channel-business-command.ts` and `zhihu-hot-channel.ts`; none are in the WMB-5337 changed files.

## Changed files

- `src/main/daily-orchestration.ts`
- `src/main/daily-orchestration-scheduler.ts`
- `src/main/index.ts`
- `src/main/daily-content-cycle.ts`
- `src/main/zhihu-hot-scoring.ts`
- `src/renderer/today-daily-cycle.tsx`
- `src/renderer/today-view.tsx`
- `src/renderer/styles-today-daily-cycle.css`
- `tests/wmb-5337-orchestration.test.mjs`
- `tests/wmb-5333-daily-cycle.test.mjs`
- `tests/wmb-5337-today-orchestration-ui.test.mjs`
- `.ai/wmb-5337-evidence.md`
- `TASKS.md`

No schema, dependency, capability, permission or publication-boundary change.
