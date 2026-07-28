# WeMediaBuddy Implementation Specification

- Status: approved design, implementation contract
- Date: 2026-07-27
- Product source: `PRD.md`
- Architecture source: `TECHNICAL_DESIGN.md`
- Scope: PRD current product range only

Keywords `must`, `must not`, and `only` are normative.

## 1. Completion boundary

WMB is complete when its research, planning, creation, platform-version handoff, metrics-on-supplied-URLs, and review loop pass. It must support these six manual-publication payloads, but real publication receipts are not a completion gate:

1. X pure text;
2. X text with one image;
3. X text with one video;
4. Xiaohongshu title, body, and at least one image;
5. Xiaohongshu title, body, and one video;
6. WeChat Official Account article actually published with an accessible article URL.

Threads, polls, mixed image/video posts, product links, locations, collections, scheduled platform publishing, live streams, audio, and paid articles are outside current scope.

WMB does not judge whether an Agent's writing is good. WMB must provide complete context, structured persistence, traceable references, and observable execution so an external Agent can perform the AI work.

## 2. Shared conventions

### 2.1 Identity and time

All persisted business objects must contain:

- stable string `id`;
- `created_at` and `updated_at` in UTC;
- optional `archived_at`;
- integer `revision` for mutable objects.

The UI displays time in `Asia/Shanghai`.

### 2.2 Writes, revisions, and idempotency

- Every business command is one SQLite transaction.
- Mutable-object writes must provide `expected_revision`.
- A stale write returns `REVISION_CONFLICT` with the current object and does not overwrite it.
- MCP write tools accept `request_id`. Replaying the same `request_id + tool` returns the original result.
- Content versions are immutable. Editing creates a new version.
- The main process serializes SQLite writes; no last-write-wins merge exists.

### 2.3 Result and error contract

Business commands, IPC mutations, and MCP tools return:

```json
{
  "ok": true,
  "data": {},
  "error": null
}
```

Failures return `ok: false`, `data: null`, and:

```json
{
  "code": "STABLE_ERROR_CODE",
  "message": "human-readable explanation",
  "details": {}
}
```

Required error codes:

- `REVISION_CONFLICT`
- `INVALID_STATE`
- `ACCOUNT_MISMATCH`
- `CONFIRMATION_REQUIRED`
- `CONFIRMATION_STALE`
- `BROWSER_NEEDS_USER`
- `PUBLICATION_UNKNOWN`
- `METRIC_UNAVAILABLE`
- `NOT_FOUND`
- `VALIDATION_ERROR`

## 3. Capability contracts

### CAP-001 Local desktop and data root

Links: REQ-001, REQ-013, AC-004.

On first run, WMB must require a data root. It creates or opens:

```text
<data-root>/
├─ wmb.db
├─ assets/
├─ browser-profile/
├─ logs/
└─ exports/
```

Requirements:

- runtime data must not be written into the Git repository;
- stored asset paths must be relative to the data root;
- Settings must show the resolved paths, database size, asset size, browser-profile size, and object counts;
- the user may close WMB, move the entire data root, and select the moved root on next start;
- WMB must validate an existing root before opening it and must not silently create a second database over an invalid root;
- application restart must preserve all committed objects, jobs, account identities, and publication evidence.

### CAP-002 Sources and daily workbench

Links: REQ-002, REQ-013, AC-001.

`source_feeds` represent recurring sites, accounts, or channels. `source_items` represent individual articles, posts, videos, tools, Skills, or documents.

A source item must store:

- original and canonical URL when available;
- registered source identity when the item came from the maintained source index, or a source identity when no URL exists;
- title, author, published time, and collected time;
- summary, categories, keywords, value judgment, IP relevance;
- creation angles, recommended platforms and formats;
- timeliness and priority;
- excerpt or Agent-provided evidence;
- originating Agent/client label when supplied.

Canonical URL is the primary dedupe key. Items without a URL use a deterministic content fingerprint. Re-ingesting an existing source updates analysis fields without creating a duplicate source identity.

Every enabled entry in the maintained source index must reference a packaged local identity asset. Today and Library render that asset inside one shared 48×48 source mark without recoloring or changing its aspect ratio. Company/platform sources use their registered brand mark; professional-account sources use their registered profile image. Unregistered sources use one neutral source icon. Generated initial-letter tiles are not allowed.

Today must show the selected date, source cards, source links, priority, plan items, pending human actions, and a create-content action.

### CAP-003 Topics and daily plans

Links: REQ-003, REQ-012, AC-002, AC-009.

A plan has `plan_date`, `timezone`, summary, revision, and items. Multiple revisions may exist for a date, but exactly one plan may be current.

Each plan item must contain:

- title and priority;
- why now and timeliness;
- target audience;
- angle and expected point of view;
- target platforms and formats;
- title/opening/structure guidance;
- effort estimate;
- cited `source_ids`;
- available and missing materials;
- optional cited `review_ids` and `method_finding_ids`.

A later current plan must contain at least one explicit historical review or method-finding reference once final reviews exist.

### CAP-004 Content, platform versions, and assets

Links: REQ-004, AC-004.

`content_projects` are creation containers. They link topics, plan items, sources, user notes, and decisions.

`content_versions` are immutable core drafts. `platform_versions` are explicit mutable objects linked to one core version and contain platform, format, revision, title/body payload, and ordered asset IDs.

Assets must store relative path, MIME type, byte count, SHA-256, origin, and available width, height, or duration. Identical hashes reuse one stored file.

File import must copy to a temporary file, hash it, atomically rename it, then commit the database record. Failed imports must not leave a referenced partial file.

Studio must show:

- content projects and their source/topic links;
- user notes and decisions;
- immutable core version history;
- X, Xiaohongshu, and WeChat platform tabs;
- asset preview and ordering;
- the current revision;
- a clear reload path on revision conflict; no merge editor is required.

### CAP-005 MCP and cross-Agent continuation

Links: REQ-001, REQ-005, AC-003.

WMB must expose a Streamable HTTP MCP endpoint on loopback only and show its URL and health in Settings.

Required MCP tools:

| Tool | Required behavior |
| --- | --- |
| `context.get_workbench` | Return current date work, pending actions, recent sources, current plan, recent reviews and method findings. |
| `sources.upsert_batch` | Add or update source items with dedupe results. |
| `sources.get` | Read one complete source item by ID. |
| `sources.search` | Search source items and return complete analysis fields. |
| `plans.get` | Read a dated/current plan with references. |
| `plans.save` | Save a complete plan revision with cited IDs. |
| `content.create` | Create a content project from a topic or plan item. |
| `content.get` | Return a project, current versions, references, decisions, and pending state. |
| `content.save_version` | Save a new core or platform version using expected revision. |
| `assets.list` | Return importable/attached assets and metadata. |
| `publishing.prepare` | Create a prepared publication; never confirm or execute it. |
| `publishing.get` | Read publication state, bound payload, attempts, and evidence. |
| `metrics.get` | Read publication and account snapshots. |
| `reviews.get` | Read reviews and method findings. |
| `reviews.save` | Save or finalize a review with evidence IDs and actions. |
| `work.list` | Return jobs and human actions. |

MCP must not expose final confirmation, raw SQL, arbitrary filesystem paths, arbitrary URL navigation, or a generic execute-command tool.

Cross-Agent acceptance:

1. Agent A creates sources, a plan, and a content version.
2. Agent A exits.
3. Agent B uses only WMB MCP data to identify the same work and save the next revision.
4. Agent A's stale revision write returns `REVISION_CONFLICT`.
5. The UI shows Agent B's committed version within five seconds while focused.

WMB may use a five-second UI poll plus immediate refresh after local mutation; no event bus is required.

### CAP-006 Browser and account identity

Links: REQ-006, REQ-013.

WMB must launch a visible installed Chrome/Chromium with the dedicated profile and a loopback CDP endpoint. It must not connect to the user's daily browser or copy its cookies.

If Chrome is not found, Settings must allow selecting an executable. WMB records and displays executable path, PID, profile path, CDP endpoint, and connection status.

Each adapter implements:

```text
identifyAccount
prepare
readBackPublication
collectMetrics
```

`identifyAccount` returns platform, stable account key, display name, login state, and evidence URL. Login state is one of `authenticated`, `unauthenticated`, `challenge`, or `unknown`.

Current scope permits at most one active account per platform. If the live browser identity differs from the stored active account, prepare and readback must stop with `ACCOUNT_MISMATCH`.

Login expiry, QR scan, CAPTCHA, challenge, or manual review moves the work to `needs_user` and opens the same visible browser for takeover.

### CAP-007 Manual publication safety

Links: REQ-007, AC-006.

MCP and the UI may present or copy the final platform payload. Neither triggers the platform's final publish action.

The Publish view shows the platform, immutable content version, exact title/body, and ordered assets for manual publication. Account detection, editor filling, upload readiness, and publication readback are optional conveniences, not completion requirements.

The prepared record binds:

- platform version ID and revision;
- account ID and stable key;
- ordered asset IDs and SHA-256 values;
- the later readback attempt.

Any bound change invalidates a saved handoff record. WMB never transitions to `publishing` by clicking a platform control.

Publication states and allowed transitions:

| From | To |
| --- | --- |
| `draft` | `prepared` |
| `prepared` | `awaiting_confirmation`, `draft` |
| `awaiting_confirmation` | `needs_user`, `published`, `unknown`, `draft` |
| `publishing` | `needs_user`, `unknown` |
| `failed` | `prepared` |
| `needs_user` | `prepared`, `published`, `unknown` |
| `unknown` | `published`, `failed` |

`published` is terminal. A new manual publication creates a new publication record.

When the user chooses to record a manual publication, stable readback identity is:

- X: status URL and status ID;
- Xiaohongshu: note URL and note ID;
- WeChat: accessible article URL and stable page identity when exposed.

A toast, click, navigation, or empty editor is not success.

Missing publication readback does not block content completion. If readback is attempted and ambiguous it enters `unknown`; WMB never clicks or retries the platform publish control.

### CAP-008 X adapter

Links: REQ-008, AC-005, AC-006, AC-007.

Required formats:

- non-empty pure text;
- non-empty text plus exactly one image;
- non-empty text plus exactly one video.

WMB must preserve the exact X payload and assets for manual publication. URL/ID readback is optional after the user publishes.

Required metrics when the authenticated author page exposes them:

- impressions/views;
- likes;
- replies;
- reposts.

Quotes, bookmarks, video-specific values, and other labels are stored as optional raw metrics.

### CAP-009 Xiaohongshu adapter

Links: REQ-009, AC-005, AC-006, AC-007.

Required formats:

- non-empty title and body with at least one image;
- non-empty title and body with exactly one video.

WMB must preserve the exact Xiaohongshu payload and assets for manual publication. Every Xiaohongshu AI operation uses the configured `xpzouying/xiaohongshu-mcp`; WMB has no direct Xiaohongshu browser adapter. URL/ID readback is optional.

Required metrics when the creator page exposes them:

- views;
- likes;
- comments;
- favorites.

Shares and other labels are optional raw metrics.

### CAP-010 WeChat Official Account adapter

Links: REQ-010, AC-005, AC-006, AC-007.

Required format is a non-empty article title and body with supported inline/cover assets.

The user manually publishes the article. An accessible article URL may be supplied afterward for validation, metrics, and review, but is not required to complete the content workflow.

Required metrics when the authenticated backend exposes them:

- reads/views;
- likes;
- recommendations/“在看”.

Shares, comments, and other labels are optional raw metrics.

### CAP-011 Metrics, jobs, and restart recovery

Links: REQ-011, REQ-013, AC-007.

A recorded publication URL may create metric jobs for 1h, 6h, 24h, and 72h after `published_at`.

Each snapshot stores:

- `scheduled_for` and real `captured_at`;
- source URL;
- normalized metrics;
- raw platform labels and values;
- per-field status.

Field status:

- `value`: page explicitly showed a numeric value, including zero;
- `unsupported`: the platform does not provide the field for this format;
- `unavailable`: the field is not currently visible or accessible;
- `parse_failed`: the label was present but could not be parsed.

Missing fields must not become zero.

`publication_id + scheduled_for` is unique. If WMB was closed, startup performs one overdue capture and records the real capture time; it does not create fake punctual snapshots or overwrite an existing snapshot.

Account follower and other account-level values go to `account_metric_snapshots`.

Job states are `pending`, `running`, `succeeded`, `failed`, and `needs_user`. Jobs include kind, due time, attempts, timestamps, last error, and dedupe key. Only metric collection may retry automatically.

On restart:

- safe running metric jobs return to pending;
- a publication interrupted while publishing becomes `needs_user` or `unknown`;
- WMB never automatically republishes.

Results must display capture time, scheduled time, source, normalized values, raw values, and field status.

### CAP-012 Reviews and feedback loop

Links: REQ-012, AC-008, AC-009.

A review references publication, content version, and real metric snapshot IDs.

Review state is `draft` or `final`. A final review must contain at least one concrete action in each list:

- `keep`;
- `stop`;
- `change`.

Method findings created from a review must retain the review link. Only final reviews and their findings are offered as default context to later plans.

If no post-publication snapshot exists, review remains pending/draft and WMB must not present it as a completed data-driven review.

Results must show reviews, findings, evidence snapshots, and backlinks from later plan items that used them.

### CAP-013 Operation visibility

Links: REQ-013.

The operation log stores:

- actor type: `ui`, `mcp`, or `scheduler`;
- optional Agent/client label;
- command;
- entity type and ID;
- before and after revision when applicable;
- timestamp;
- result and stable error code.

It must not duplicate complete sensitive content bodies or model reasoning.

Publish must show a state timeline, attempts, errors, `needs_user` takeover action, and `unknown` reconciliation action.

Settings must provide log-directory opening and current health for MCP, browser, database, jobs, and platform identities.

### CAP-014 Built-in Pi executor

Links: REQ-001, REQ-005, REQ-013.

WMB ships a pinned Pi runtime as an independent application resource. The Pi runtime can be replaced or upgraded separately from WMB business code, while WMB records the active version and verifies RPC startup before use.

Pi uses only the OpenAI-compatible Base URL, API key, and model configured in WMB. WMB must not read, copy, refresh, or invalidate another Agent's OAuth session.

Only explicit user intents that require research, judgment, writing, rewriting, or review create Pi tasks. Deterministic UI actions continue to call existing business commands directly.

Pi runs as one supervised RPC subprocess with LF-delimited JSON messages, streamed events, abort, shutdown, and restart-safe task state. Pi may write WMB business state only through the existing MCP tools; it must not write SQLite or business files directly and must not execute final publication.

Every main view shares one collapsible Pi conversation dock. Page changes preserve the conversation and active task. A text response or `agent_end` alone is not success; WMB marks a task successful only after required business objects read back through the existing business API.

## 4. UI and IPC contract

The five required views are Today, Studio, Publish, Results, and Settings.

Preload exposes narrow IPC for:

- workbench/entity reads and writes;
- publish preview, confirm, reconcile;
- browser start/open/takeover;
- safe job retry;
- settings read/update;
- open data/log directories.
- fixed Pi task start/read/cancel and Pi connection settings.

Renderer must not pass SQL, arbitrary command names, arbitrary filesystem paths, or arbitrary browser URLs.

Every mutation returns the complete latest object. Focused views poll for external MCP writes at most every five seconds.

## 5. Acceptance matrix

| Eval | Capability | Required receipt |
| --- | --- | --- |
| EVAL-001 | Sources and planning | Duplicate source readback, current plan, cited source IDs. |
| EVAL-002 | Cross-Agent continuation | Agent A/B transcript, revision conflict, UI readback. |
| EVAL-003 | X pure text | Exact manual-publication payload. |
| EVAL-004 | X image | Exact payload and bound image hash. |
| EVAL-005 | X video | Exact payload and bound video hash. |
| EVAL-006 | Xiaohongshu image | Exact title/body/image handoff through the required MCP workflow. |
| EVAL-007 | Xiaohongshu video | Exact title/body/video handoff through the required MCP workflow. |
| EVAL-008 | WeChat article | Exact article title/body handoff; URL validation is optional. |
| EVAL-009 | Stale confirmation | Changed content/account/asset rejects previous confirmation. |
| EVAL-010 | Unknown publication | Interrupted readback does not republish; reconciliation evidence persists. |
| EVAL-011 | Restart recovery | Data, jobs, login profile, and safe states survive restart. |
| EVAL-012 | Feedback loop | Final keep/stop/change review and later plan backlink. |
| EVAL-013 | Data-root visibility | Real paths, usage, counts, reopen after whole-root move. |

All six payload-format evals must pass. Platform authentication and real publication are outside the completion gate.
