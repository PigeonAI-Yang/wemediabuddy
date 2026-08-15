# WMB-5269 completion evidence

Date: 2026-08-15

## Delivered contract

- Every formal source-ingestion route now durably registers body capture: `source-commands`, official-web intelligence wire, website channel, cached/live X List ingestion.
- Declared complete structured text is frozen immediately into the existing immutable `source_body_revisions` truth and `source_body_cache` projection. URL-only sources create durable asynchronous jobs. Missing text and URL becomes explicit `NO_BODY_SOURCE` rather than silently substituting the summary.
- Migration 71 adds durable capture jobs, immutable attempt history, queue/failure indexes, and persistent historical-backfill cursor.
- Worker preserves existing public-web safety: public-DNS validation on every hop, redirect limits, MIME/type restrictions, 2 MiB response cap, timeout, login/challenge detection, and no unsafe fallback.
- Automatic cycle is bounded to three attempts with exponential backoff and Retry-After floor. Stale running jobs recover after restart; new sources outrank historical backfill; historical claims are limited to one per minute.
- Terminal failures are visible in `资料库 → 采集异常`, with reason classification, retry eligibility, selected/reason/all retry scopes, and explicit exclusion of nonretryable security/auth/dead-link cases from bulk retry.
- Source detail no longer presents manual fetching as the daily ingestion model. It shows automatic archive state and retains only refresh/recovery actions. No Pi action or prompt is coupled to body capture.
- Historical backfill dispatcher requests use unique request identities per page; this prevents replay deduplication from stalling a multi-page backfill.

## Main files

- `src/shared/source-body-archive.ts`
- `src/main/db/source-body-archive-migrations.ts`
- `src/main/db/migrations.ts`
- `src/main/source-body-archive.ts`
- `src/main/source-commands.ts`
- `src/main/intelligence-wire.ts`
- `src/main/website-channel.ts`
- `src/main/x-list-execution.ts`
- `src/main/index.ts`
- `src/main/ipc-knowledge-content.ts`
- `src/preload/preload.ts`
- `src/renderer/global.d.ts`
- `src/renderer/library-view.tsx`
- `src/renderer/library-view-parts.ts`
- `src/renderer/styles-workflow-library.css`
- `tests/wmb-5269-source-body-archive.test.mjs`
- `tests/wmb-5212-library-renderer.test.mjs`
- `tests/e2e/library.test.mjs`

## Verification

- `node --test tests/wmb-5269-source-body-archive.test.mjs` — PASS 16/16. Covers migration, immediate structured-text freeze, URL queueing, no-source terminal state, claim/finish receipts, retry/backoff/Retry-After, nonretryable outcomes, restart recovery, paginated backfill/no duplicates, all retry scopes, failure pagination/filtering, production dispatch, and pause state.
- `node --test tests/migrations.test.mjs tests/wmb-5237-source-body-revisions.test.mjs` — PASS 8/8.
- `node --test tests/website-channel.test.mjs tests/intelligence-wire.test.mjs tests/x-list-channel.test.mjs tests/x-list-timeline-cache.test.mjs` — PASS 18/18.
- `node --test tests/wmb-5212-library-renderer.test.mjs tests/design-tokens-drift.test.mjs` — PASS 30/30; token drift PASS 3/3.
- `npm run typecheck` — PASS.
- Real Electron isolated-workspace scenario `LB-008-library-capture-failures` — PASS 1/1. Actual renderer displayed two classified terminal failures, counted one retryable and one excluded security failure, and disabled automatic selection for the excluded item. Receipt: `tests/e2e/.runtime/results.json`; scenario evidence root: `tests/e2e/.artifacts/LB-008-library-capture-failures-7p7Pqu`.
- Browser/process cleanup: E2E runner closed its isolated Electron page/application in `finally`; process query for `tests/e2e/.runtime` returned no live process. Managed dev process `wmb-5269-dev` stopped and `hub ps` reports `exited`.

## Boundaries

- Capability registry: no change. Capture scheduling and retry remain internal product/scheduler actions, not Agent-grantable capabilities.
- Pi operator Skill: no change. Body capture is deliberately independent of Pi.
- Dependencies and brand-level foundation tokens: no change.
