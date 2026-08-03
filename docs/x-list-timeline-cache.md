# X List Timeline Browse Cache

Status: approved for implementation (WMB-1605)  
Date: 2026-07-31  
Depends on: WMB-1603 / WMB-1604 (index cache + bound collection)

## Problem

List index already has stale-while-revalidate persistence. Timeline posts do not.

Current behavior:

- Bound lists can show already-collected `source_items` after explicit collect.
- Unbound / never-collected lists always hit live X.
- Reopening a list never restores the last viewed screen unless it was collected into the asset library.

That feels unlike a browser, and forces extra live X traffic.

## Goals

1. Opening a previously viewed List shows the last preview screen immediately.
2. Browse cache is disposable acceleration, never source-of-truth.
3. Asset library (`source_items`) stays explicit collect-only.
4. Long-term use cannot accumulate unbounded cache rows or payload bytes.
5. Failures never overwrite a good snapshot.
6. Live X refresh stays paced through the humanization path.

## Non-goals

- Automatic background refresh of every List timeline on page entry.
- Writing browse views into `source_items`.
- Infinite scroll history inside the browse cache.
- True headless-as-default browser mode.

## Layer model

```text
Open List timeline
  L1 browse cache     -> x_list_timeline_cache (preview only, disposable)
  L2 collected assets -> source_items via binding (paged, durable)
  L3 live X read      -> expensive; writes L1 on success
```

| Layer | Purpose | Retention | Loss impact |
| --- | --- | --- | --- |
| L1 | Fast reopen / fewer X hits | Hard caps + TTL | Slightly slower UI |
| L2 | Traceable discovery assets | Product cleanup rules | Lose collected evidence |
| L3 | Fresh page read | Not stored directly | Uses paced browser access |

## Schema

Migration 30:

```sql
CREATE TABLE x_list_timeline_cache (
  account_key TEXT NOT NULL,
  list_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  posts_count INTEGER NOT NULL,
  payload_bytes INTEGER NOT NULL,
  fetched_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('live', 'collect')),
  schema_version INTEGER NOT NULL,
  fingerprint TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (account_key, list_id)
);
CREATE INDEX x_list_timeline_cache_accessed ON x_list_timeline_cache(last_accessed_at);
CREATE INDEX x_list_timeline_cache_account_accessed ON x_list_timeline_cache(account_key, last_accessed_at);
```

Payload shape (`schema_version = 1`):

```ts
{
  accountKey: string
  listId: string
  detail?: { name?: string; canonicalUrl?: string } | null
  posts: Array<{
    url: string
    authorHandle: string | null
    text: string
    postedAt: string | null
  }>
}
```

Rules:

- One row per `(account_key, list_id)` only. No historical versions.
- `posts` capped at 50 before write.
- Each `text` truncated to 2000 chars before write.
- Reject/omit posts missing `url`.
- `payload_bytes` stores UTF-8 byte length of final JSON.
- Max payload 256 KiB; if larger after truncation, drop trailing posts until under cap.

## Caps and eviction

Enforced on every write and on explicit cleanup / startup touch:

| Cap | Value |
| --- | --- |
| Posts / row | 50 |
| Payload / row | 256 KiB |
| Rows / account | 30 |
| Rows global | 80 |
| Soft display TTL | 12 hours (still show, mark stale) |
| Empty-result TTL | 45 minutes |
| Future-dated `fetched_at` skew | > now + 5 minutes => invalid |

Eviction order:

1. Invalid schema / unreadable JSON
2. Future-skew timestamps
3. Rows exceeding empty TTL when `posts_count = 0`
4. Other accounts first when over global cap
5. Oldest `last_accessed_at` (LRU)
6. Within same access time, older `fetched_at`

Access touch:

- Read path may update `last_accessed_at`.
- Throttle writes to at most once / 10 minutes / row to avoid hot-list disk thrash.

## Read path

For selected List:

1. Read L1 for current account + list.
2. If L1 valid:
   - show immediately with `更新于 fetched_at`
   - if older than soft TTL, UI marks stale but does **not** auto live-refresh
3. If bound and user wants more history: page L2 (`listSourcesByFeed`) independently.
4. Live L3 only when:
   - no L1, or
   - user clicks refresh, or
   - L1 empty-result expired
5. Successful L3/live or collect preview composition writes/replaces L1.
6. Failed L3 **does not** overwrite existing non-empty L1.

## Write path

Write sources:

- `readXListTimeline` success -> `source='live'`
- `collectBoundXListTimeline` success -> compose preview from returned/collected posts -> `source='collect'` (optional but preferred so reopen stays warm)

Never write L1 from partial/error pages (login wall, challenge, rate limit).

Fingerprint:

- hash of ordered post URLs (+ optional first 64 chars of texts)
- if fingerprint unchanged, refresh `fetched_at` / `last_accessed_at` without rewriting giant identical payload when practical

## UI contract

Labels:

- `缓存 · 更新于 …` for L1
- `已采集` for L2 rows
- `刚刚读取` for fresh L3 before/around cache write

Actions:

- `刷新动态` -> explicit L3
- `加载更多已采集` -> L2 only
- `采集一批动态` -> L2 write + L1 preview refresh
- Settings: `清理 List 浏览缓存` clears L1 only

No multi-list prefetch. No homepage background timeline storm.

## IPC / API

- `x-lists:get-cached-timeline` `{ accountKey, listId }` -> cache row or null
- existing `x-lists:list-cached-timeline` remains L2 asset paging (name kept; means collected)
- `x-lists:clear-timeline-cache` optional `{ accountKey? }` 
- live read handlers write L1 after success
- settings diagnostics may expose row count + total bytes

## Account-safety coupling

- L1 hit => zero X request
- Live refresh uses existing quiet browser + humanization guard/lease
- Default: no automatic multi-list timeline revalidation
- Optional future auto-refresh must reuse the existing paced browser path and stay off by default

## Failure and edge cases

| Case | Behavior |
| --- | --- |
| Account switch | Only current account rows are shown; foreign rows remain until global LRU eviction |
| Unbind list | L1 may remain; L2 untouched |
| List deleted / private | Keep last good L1; show stale + error on refresh failure |
| needs_user / cooldown | Do not overwrite good L1 |
| Confirmed empty list | Store empty with short TTL |
| Schema bump | Drop unreadable rows |
| Clock skew backward/forward | Invalid future fetched_at dropped |
| Multi-window refresh | Last successful write wins; failures do not clobber |
| Disk pressure | Caps enforce small table; clear button available |

## Verification

1. Migration 30 applied; counts 30.
2. Focused tests:
   - write/read roundtrip
   - per-account and global cap eviction
   - failure does not overwrite good snapshot
   - empty TTL shorter than normal
   - payload post truncation
3. Typecheck.
4. UI path: reopen list shows L1 without live call when cache present.

## Implementation map

- `docs/x-list-timeline-cache.md` (this file)
- `src/main/db/migrations.ts` v30
- `src/main/x-list-timeline-cache.ts`
- `src/main/ipc-x-lists.ts` + preload + `global.d.ts`
- `src/renderer/x-lists-view.tsx`
- settings clear action
- `tests/x-list-timeline-cache.test.mjs`
- migration count assertions

## Decision summary

Browse cache exists to make reopen fast and reduce X traffic.  
Collected sources remain the only durable evidence store.  
Hard caps beat “TTL only”.  
Failed live reads never poison the last good screen.
