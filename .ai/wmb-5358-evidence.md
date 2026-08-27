# WMB-5358 evidence — durable knowledge routing and compilation

Date: 2026-08-28

- Reused `jobs` for durable `knowledge_route` and per-Topic `knowledge_compile` work.
- Added stable dedupe, CAS claim, bounded fan-out, stale revision/link evidence, restart recovery and old-root teardown drain.
- Connected Source revisions, body-ready scheduling, unified Topic link/move writes and valuable orphan backfill.
- Focused command covering routing, compiler, backfill, Topic maintenance and workspace switching: 40 pass / 0 fail.
- `npm run typecheck`: PASS.
- Independent review findings for new revisions, orphan backfill, stale Topic links and root-switch lifecycle received focused regressions.
