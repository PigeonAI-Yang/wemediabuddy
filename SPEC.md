# WeMediaBuddy Implementation Specification

- Status: approved design, implementation contract
- Date: 2026-07-27
- Scope revision: 2026-08-03 workspace intelligence channels
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

WMB is niche-agnostic inside the self-media boundary. The existing AI lane, the UK lane, and later user-created lanes use the same fixed business loop through isolated workspaces defined by CAP-018 and CAP-019.

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
- `X_LIST_UNKNOWN`
- `METRIC_UNAVAILABLE`
- `NOT_FOUND`
- `VALIDATION_ERROR`
- `WORKSPACE_BUSY`
- `WORKSPACE_NOT_FOUND`
- `WORKSPACE_ID_MISMATCH`
- `WORKSPACE_SWITCH_FAILED`
- `PROFILE_STALE`
- `OFFICIAL_PACK_UNAVAILABLE`

## 3. Capability contracts

### CAP-001 Local desktop and data root

Links: REQ-001, REQ-013, AC-004.

On first run, WMB must require a data root. It creates or opens:

```text
<data-root>/
├─ wmb.db
├─ assets/
├─ browser-profile/
├─ pi-agent/
├─ xiaohongshu-mcp/
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

Links: REQ-002, REQ-013, REQ-020, REQ-021, AC-001, AC-016.

`source_feeds` represent recurring sites, accounts, or channels. `source_items` represent individual articles, posts, videos, tools, Skills, or documents.

The fixed website and X Lists channel modules reuse this model. A root-local website configuration references one `source_feed`, stores the user's input plus resolved canonical entry URL, enabled/resolution state, last truthful error and revision, and may be created only after a real trial read and exact UI confirmation. X Lists continue to use the existing `x_list_bindings → source_feed_id` identity. Neither module creates a second source store.

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

The current plan must retain every deduplicated result that meets the opportunity standard; it must not impose a fixed item-count cap. `priority` is an integer from `0` through `7`, mapped to `SSS`, `S`, `A`, `B`, `C`, `D`, `E`, and `F`. Items are read back in ascending numeric priority, preserving source order within the same grade. Information below the opportunity threshold remains a source item and must not be promoted merely to increase the plan size.

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
| `x_lists.*` | In every valid self-media workspace, list/read current-root Lists and bindings, prepare permitted operations, and collect a bounded bound-List timeline; never confirm an external write. |

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

Pi uses only the API protocol, Base URL, API key, and model configured in WMB. Current protocols are OpenAI Responses and OpenAI Chat Completions. WMB must not read, copy, refresh, or invalidate another Agent's OAuth session.

Settings may save multiple named API presets for the current WMB installation. Exactly one configured preset is active for new Pi processes in every workspace; switching presets stops the current Pi process before the next turn. API keys remain encrypted locally and are never returned to the renderer. Presets are installation preferences, while Pi conversations, tasks, generated runtime files and business context remain bound to their data root.
Settings must fetch model IDs from the configured protocol's `/models` endpoint using that protocol's authentication headers and let the user select one; manual model entry remains available when the endpoint cannot enumerate models.
DeepSeek V4 Flash, GPT-5.6 Luna and MiMo-V2.5-Pro are common Pi choices, not hard-coded aliases or fallback routes. WMB must pass the exact provider-returned or user-entered model ID and must surface an unavailable model, protocol or provider as an error or `needs_user` without silent substitution.

Only explicit user intents that require research, judgment, writing, rewriting, or review create Pi tasks. Deterministic UI actions continue to call existing business commands directly.

Pi runs as one supervised RPC subprocess with LF-delimited JSON messages, streamed events, abort, shutdown, and restart-safe task state. Pi may write WMB business state only through the existing MCP tools; it must not write SQLite or business files directly and must not execute final publication.

Every main view shares one collapsible Pi conversation dock. Page changes preserve the conversation and active task. A text response or `agent_end` alone is not success; WMB marks a task successful only after the intent-specific evidence reads back through the existing business API. Daily intelligence uses CAP-021 source-check receipts and may succeed with zero new source items and an empty plan; Studio and Results keep their required business-object gates.

普通 Pi 对话不设 WMB 级总时限：仅在 Pi 发出 `agent_settled`、用户显式 `abort`，或 Pi 返回真实错误/退出时结束。生成期间编辑框保持可用；空编辑框的主按钮为停止方块，非空编辑框发送 Pi 原生 `steer`，`Alt+Enter` 发送原生 `followUp`。WMB 只展示 Pi 的 `queue_update` 队列，不自建逐条取消、重排或伪撤回。历史撤回和重发必须由 Pi 原生 `fork` 创建新分支，不能只裁剪本地聊天记录；固定业务 Agent 的显式任务时限不受此条影响。

### CAP-015 Long-term knowledge compounding

Links: REQ-002, REQ-003, REQ-004, REQ-011, REQ-012, REQ-014, AC-001, AC-002, AC-009, AC-010.

Every source has two independent states: verification (`pending`, `verified`, `disputed`, `rejected`) and management (`active`, `watching`, `expired`, `archived`). Opportunity, content and publication use are derived from existing relations rather than copied into another status.

Library reads sources through an independent bounded, paged query with search and both state filters. It must not reuse the Today source limit.

Topics have a stable canonical key, kind (`theme` or `event`), management status and explicit source relations (`primary`, `supporting`, `background`, `contradicting`). Repeated recording of the same topic/source/relation is idempotent.

A bounded historical-context read follows the existing chain from topic/source to plan opportunity, content project, publication and final review. It reports observed relations and must not claim causal impact.

Rediscovery is deterministic and shows at least: high-priority unused sources, watching sources and sources pending verification for more than seven days. UI, IPC, MCP and built-in Pi use the same business functions for these reads and writes.

### CAP-016 Knowledge canvas and direct page context

Links: REQ-002, REQ-003, REQ-004, REQ-014, REQ-015, AC-001, AC-002, AC-009, AC-010, AC-011.

A knowledge canvas is a persistent working view over existing WMB business objects. Canvas nodes reference allowed real object IDs or contain a canvas note; removing a node must not delete the referenced object. One object may appear in multiple canvases, and each canvas stores its own layout and viewport.

Semantic relations have explicit direction, type and optional label. Relation truth is stored separately from per-canvas visibility. Creating, relabelling, hiding and archiving a relation are distinct operations. Pi-proposed relations remain suggestions until the user confirms them.

The canvas supports adding real objects, dragging, pan/zoom, click and Shift multi-selection, rectangular selection and explicit typed connection. Layout and relationship writes use optimistic revisions and batch business commands.

Pi context follows the same direct-selection interaction on every page. With no selected object, the bounded current-page read model is the context. With one or more checked/selected objects, only those objects and relations whose two endpoints are selected are context. Multi-selection is explicit; clicking page whitespace clears it and restores current-page context.

WMB resolves the context immediately before a Pi turn and sends the exact IDs, types, current revisions/content and internal relations. WMB must not silently expand a non-empty selection. The submitted Pi session turn is the exact-use record; WMB must not create an additional package, snapshot object, version family or duplicate use receipt.

A creative brief or content project created from that context stores its actual evidence/source references as part of that existing business object. UI, IPC, MCP and built-in Pi call the same business functions; MCP mutations are atomically idempotent by `request_id`.

### CAP-017 X List workspace

Links: REQ-001, REQ-002, REQ-005, REQ-006, REQ-013, REQ-016, AC-001, AC-012.

「发现」中的 X Lists 是所有自媒体工作空间固定具备的列表管理与情报接入工作台，不是通用 X 客户端。它从当前 data-root 已选择的专用 X 登录态实时读取三类可访问 List：用户创建、用户关注、用户在其中。稳定身份是 workspace ID、账号、X List ID 与规范 URL；名称不是身份。WMB 只在当前根持久化用户绑定为发现信源的 List 及每次操作的证据，不镜像全部成员或完整动态历史。

X Lists 是通用情报来源能力，不由 `WorkspaceProfileV1.platforms` 启停，也不因工作空间未选择 X 作为发布平台而消失。每个根独立保存浏览器配置、登录态、List 绑定、缓存、操作记录和收集得到的资料；不得继承、转发或命中其他根的账号、List、缓存或 source feed。既有 `AI前沿` binding 转为 AI 根中可见、可管理的普通来源配置；UK、游戏资讯或其他赛道使用相同模块但只能读取本根用户明确启用的 List。

用户创建的 List 支持创建、读取详情、编辑名称/描述/公开性、删除、分页查看成员以及按精确 handle 串行批量添加或移除成员。非当前账号拥有的 List 仅支持读取详情、成员和时间线，以及接入/移出 WMB 发现；WMB 不自动执行退出别人 List、拉黑创建者、私信、推荐搜索、置顶或任何未列出的 X 社交动作。

每个外部写入先读取当前账号、List 身份/所有者、权限和必要的页面快照，生成冻结的变更集。创建、编辑、删除和成员批处理都必须由 UI 最终确认；MCP 和 Pi 只能读取或准备，不能确认。确认绑定账号、List、变更前快照和精确 diff；其中任一项变化使确认失效。删除还要求用户输入当前 List 名称再次确认。批量成员操作只需一次确认，但每个成员都要有平台读回结果。

执行始终使用可见的专用 X 页面、单个可操作标签和串行节奏；用户可以随时接管或请求停止，停止只在当前原子页面动作完成后生效。平台出现登录、验证码、挑战、权限不足或选择器无法安全确认时，操作进入 `needs_user`。点击后无法读回实际状态时，操作进入 `unknown`，停止后续项目且不自动重试。操作状态为 `prepared`、`awaiting_confirmation`、`running`、`succeeded`、`partial`、`needs_user`、`unknown` 或 `failed`，与发布和指标 jobs 分开保存。

绑定到发现的 List 可以由用户显式触发一次有上限的最新动态读取，也可参加用户显式启动的 CAP-021 今日情报；每条动态通过既有 `source_feeds` / `source_items` 写入并带 List 来源。除一次显式动作按 CAP-022 创建的三个有界指标复查窗口外，不创建定时或全量抓取。解除绑定不改动 X List，也不删除已经入库的资料。

通用 `x_lists.*` UI/IPC、MCP 和 Pi 读写准备能力使用同一业务命令，在每个有效自媒体工作空间可用，并在每次调用时重新验证当前 workspace、data-root、根内账号和 List 绑定。缺少登录、账号不匹配、挑战或权限不足进入准确的 `needs_user`；账号不匹配的稳定 reason/error code 为 `ACCOUNT_MISMATCH`，不得借用其他根账号或静默回退。MCP/Pi 不暴露确认工具，最终外部写入仍只由 UI 精确确认。

读、准备或采集在平台动作前发现缺少登录或账号不匹配时，直接返回 `needs_user`，且不写根内 binding、cache、operation、source feed/item、业务对象、registry/profile 或平台状态。只有一个已经由用户明确启动并持久化的 operation/job 在执行中失去前置条件时，才可幂等更新该原记录为 `needs_user`；不得另建重复 operation/job 或写入其他表。缺模型任务沿用 CAP-019 的同一条“仅更新原任务状态”规则。

### CAP-018 Isolated data-root workspaces and one active runtime

Links: REQ-001, REQ-013, REQ-017, REQ-019, AC-013, AC-014.

A workspace is one complete WMB data root, not a tenant row inside a shared database. The application-level registry stores only stable workspace identity, display name, resolved root path, the active selection, and a crash-recovery switch journal. The root's existing `app_meta` stores the matching `workspace_id`; a missing root or identity mismatch must be rejected rather than inferred from its path or name.

The existing user data root is registered in place as the AI workspace. Registration may add workspace identity and profile records, but must not move or copy files, rewrite business object IDs, or change existing uniqueness semantics. A new UK or custom workspace uses a separate root and may contain the same URLs, dates, object IDs, account names and asset hashes without collision.

Exactly one workspace runtime may be active. SQLite, MCP, Pi, Chrome, Xiaohongshu MCP, scheduler, jobs and renderer reads are all bound to that root. A switch is rejected with `WORKSPACE_BUSY` while a Pi/content/intelligence/review task is running, an external browser write cannot be safely interrupted, or the current mutation queue cannot be drained. An allowed switch closes the mutation gate, rejects new mutations, waits for committed database/file writes, validates the target root and identity read-only, records `previous_workspace_id + pending_workspace_id`, stops every root-bound runtime, closes the database and MCP server, then relaunches the Electron application. It does not rebind a live renderer to another root.

Startup marks a pending switch as attempting, opens and migrates the target root through the normal transactional path, and commits the active selection only after core database and business readback succeeds. A target failure restores and opens the previous root; a process exit while attempting is treated as a failed switch on the next start. Schema/migration metadata and diagnostic logs may change during a failed attempt, but content business objects must not. If the previous root also cannot reopen, WMB reports recovery failure and must not claim success.

Each successful switch starts a new process and a new random MCP URL. Every old HTTP connection, stream and URL must close and must never forward to the new root. Inactive roots run no background process or scheduled write. Safe overdue jobs use the existing real-time recovery rule when that root is activated again; unsafe jobs remain `needs_user`/`unknown` and are never replayed. Listing and explicit relink after a move are in scope; rename, archive, permanent deletion and parallel runtimes are not.

One shared business read returns the authoritative current workspace/capability snapshot to UI, IPC, MCP and Pi. It is derived from the active registry entry and that root's effective profile, and includes workspace identity, resolved data-root identity, profile ID/revision, selected intelligence/creation packs, publishing-platform subset, fixed capability availability and current website/X Lists readiness summary used by the renderer and runtime. Identity-sensitive surfaces must not reconstruct or cache a competing snapshot.

### CAP-019 Official workspace profiles and AI proposals

Links: REQ-018, REQ-019, AC-015.

AI and UK are versioned official templates shipped with WMB. `WorkspaceProfileV1` has only these fields: stable profile ID, integer revision, optional official template ID/version, display name, audience, content goal, plain-text editorial brief, exactly one official intelligence-pack ID/version, one creation-pack ID/version, and one or more currently supported platforms. The intelligence-pack selection supplies audience/editorial context and truly lane-specific presentation such as AI rankings; fixed website/X Lists collectors and the CAP-021 daily orchestration are shared. Text fields are context, never executable configuration. Review remains fixed WMB behavior until real lane differences justify another field. A profile cannot contain arbitrary code, file paths, tool names, new business stages, cross-stage graphs, or a generic `module.run` instruction. Third-party plugins and a free workflow builder are outside scope.

The platform subset controls new plan platform selections, platform versions, publishing actions and platform-specific runtimes. It does not hide historical records or control shared intelligence inputs. Website and X Lists modules remain fixed root-local WMB capabilities rather than profile fields or plugins; every intelligence pack may consume only sources explicitly enabled in the current root.

Each root stores one effective profile revision. An Agent task or job records the profile revision it starts with, and profile activation is rejected while a profile-bound task is running; WMB does not keep multiple pack runtimes or implement old-pack compatibility. An Agent may read the compile-time official catalog and create a complete proposal from the user's natural-language self-media goal, but WMB only validates its finite fields, references and state; it does not claim the proposed content strategy is correct. AI and UK official templates can also be created directly from UI without a configured model.

Unconfirmed proposals are session-bound Main-process state and disappear on restart. Confirmation binds the proposal ID, normalized proposal hash, base effective-profile revision, official catalog version, selected pack versions, platform selection and the exact displayed diff. Any change or missing session proposal makes the confirmation stale and returns `PROFILE_STALE`; a missing packaged capability returns `OFFICIAL_PACK_UNAVAILABLE`. MCP and Pi may list workspaces, read the current workspace and catalog, and submit a proposal. They must not confirm, activate, delete, or supply an arbitrary root path.

For an existing root, UI confirmation updates its effective profile in one root-local transaction. If that root is active, confirmation then uses the bounded relaunch protocol to replace every profile-bound runtime and MCP URL; it never rebinds the live process or leaves the old URL serving the new revision. For a new workspace, the UI alone selects an empty root; WMB idempotently writes a root identity, schema and effective profile before atomically adding it to the registry. A crash before registry insertion leaves no visible/active workspace and the candidate root can be safely revalidated and relinked; the current active root is unchanged. Activating a new or inactive workspace remains a separate normal relaunch switch.

The UK template must route creation and opportunity judgment through UK-approved audience/editorial context. Its deterministic website/X Lists scan uses the same CAP-020 modules as every root and only the sources explicitly configured in UK. Acceptance proves zero calls and zero writes through AI-only rankings, creation routes or other genuinely AI-only entries; it no longer treats website collection or fixed channel execution as an AI-only capability. Missing model credentials or platform login makes the attempted task persist the existing `needs_user` state with a stable reason plus workspace/profile revision; WMB must not silently substitute another model, tool, account or pack.

The finite compile-time intelligence-pack mapping is also the auditable AI-only inventory. It covers only truly lane-specific presentation and judgment/creation routes, including AI rankings. Website/X Lists configuration, scanning, readiness and receipt presentation are fixed shared capabilities and must not be hidden or dispatched by pack. UK/game DOM modules, IPC, MCP registration/direct calls and runtime dispatch still fail closed for the remaining AI-only entries with zero write.

### CAP-020 Root-local intelligence channel configuration

Links: REQ-020, REQ-021, REQ-022, AC-016, AC-018.

WMB ships exactly two compile-time intelligence channel modules in this scope: `official_web` and `x_lists`. They are fixed business capabilities, not installable plugins, profile fields or arbitrary module execution. Their definitions are shared by the installation; every source configuration, account identity, enabled state, resolution status, revision, receipt and collected item remains inside the active data root.

The website module accepts a public-site name or URL. It resolves one or more real candidates, canonicalizes the selected content-entry URL, performs a bounded trial read, and returns the exact title/URL/readability result before confirmation. A name is never guessed into a URL, the same canonical URL cannot create two active website configurations in one root, and an unreadable/login/challenge/dynamic source returns an accurate reason instead of becoming ready. Official templates may propose a visible initial website list, but it is not a permanent whitelist.

The X Lists module accepts a List name, URL or ID and resolves only against the current root account's real accessible List index. A unique ID/URL match may be selected directly; same-name matches return every account/List-ID/canonical-URL candidate and require user choice. Confirmation reuses CAP-017 binding and account validation rather than creating another List identity.

UI, Pi and external Agents use shared prepare/read commands. Pi or MCP may prepare one exact batched add/enable/disable/remove diff but cannot confirm it. UI confirmation binds workspace ID, profile revision, source module, stable source identities and the displayed diff; any change returns `CONFIRMATION_STALE` with zero write. Removing or disabling a source preserves existing source items.

### CAP-021 Shared daily intelligence orchestration and receipts

Links: REQ-020, REQ-022, AC-017, AC-018.

One shared daily entry freezes the current workspace/profile revision, every enabled website/X Lists source, and every selected source revision. Today does not expose channel selection or management; it starts the complete enabled set configured in Discover. Deterministic channel preflight and scans happen before lane-specific opportunity judgment. Independent source reads may run concurrently; each source produces one durable receipt containing task/workspace/source identity, module, checked time, status, candidate/save counts and stable error details.

Preflight returns `needs_user` without launching Pi when no enabled source is runnable because of missing configuration, login or account identity. Once scanning starts, one source failure never rolls back another source's committed receipt or items. Task aggregation is: `succeeded` when at least one selected source was truthfully checked, including zero candidates and an empty current plan; `partial` when at least one source was checked and another failed or needs user; `needs_user` when every selected source is blocked; `failed` only when orchestration/runtime failure prevents any trustworthy check receipt. Non-empty plan items must still reference real source items. Placeholder heartbeat source items are forbidden.

### CAP-022 Root-local X post trend observations

Links: REQ-011, REQ-023, AC-007, AC-019.

After the user explicitly starts daily intelligence or one X List trend observation, WMB may create only three bounded non-AI follow-up reads for each selected, frozen List at +15m, +60m and +180m. No observation is created before that explicit action. Reads remain visible, serial and bound to the active workspace, data root, browser account, List binding and binding revision; they do not wake Pi or run in an inactive root.

UI, Pi and external MCP call the same explicit-start business command. The caller may select only currently enabled root-local List bindings and cannot supply an arbitrary URL, account, root, cadence or job payload. No additional confirmation is required because the command performs read-only platform access, but it still creates only the bounded root-local jobs defined here.

Every returned post continues to reuse its canonical `source_item`. A separate append-only X post metric snapshot stores source item, account/List/binding identity, scheduled and real capture times, normalized values, raw labels/page evidence and per-field status. Missing values are never zero. Replaying one observation job is idempotent, while a later real capture appends rather than overwrites. The latest List cache remains disposable and is never the historical source of truth.

A trend read is deterministic. Two snapshots at least ten minutes apart with visible, non-decreasing views produce `views_per_hour`; three comparable snapshots also produce the change between consecutive interval velocities. Missing, reversed, decreasing or insufficient samples return `data_insufficient` with a stable reason and no inferred score. Pi may use only these persisted facts when explaining why an opportunity is timely.

On restart, at most the latest still-relevant overdue observation for a List may run and it records the real capture time. Older windows finish with `OBSERVATION_WINDOW_EXPIRED` and write no snapshot. A root switch stops new claims, drains the current atomic read, terminates the old browser/runtime and rejects every late response with zero snapshot/cache/source/receipt write. One List failure does not roll back another List's committed snapshots.

Topic/event aggregation, plan opportunities and content projects reuse CAP-003, CAP-004 and CAP-015. Trend evidence references real source and snapshot IDs. It may recommend an editorial format or angle but never performs replies, likes, quotes, reposts or final publication.

## 4. UI and IPC contract

The required primary views remain Today, Discover, Studio, Publish, Results, and Settings. Discover includes one fixed intelligence-channel workspace for website and X Lists source configuration; it is not a plugin manager.

Preload exposes narrow IPC for:

- workbench/entity reads and writes;
- publish preview, confirm, reconcile;
- browser start/open/takeover;
- safe job retry;
- settings read/update;
- open data/log directories.
- fixed Pi task start/read/cancel and Pi connection settings.
- fixed X List reads, preparation and UI-only confirmation.
- website/X Lists channel configuration reads, website resolution/trial read, daily preflight, scan receipts and source-change preparation with UI-only confirmation.
- X post trend snapshot reads and explicit bounded-observation start/read/stop; no arbitrary cadence, URL, account or root.
- workspace list, current identity, relaunch-based safe switch, moved-root relink, proposal preparation and UI-only profile activation.

Renderer must not pass SQL, arbitrary command names, arbitrary filesystem paths, or arbitrary browser URLs.

The UI must keep the active workspace identity visible wherever account, MCP or data-root identity matters. A switch relaunches the application and opens the target root with fresh renderer state.

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
| EVAL-014 | Knowledge compounding | 250-source pagination, dual-state stale-write rejection, cross-day topic idempotency and topic/source-to-review readback. |
| EVAL-015 | Knowledge canvas | Persistent real-object layout and typed relations, current-page default, exact multi-selection excluding a sentinel, Pi-session context identity without package/use writes, project evidence backlink, stale-write rejection and 250-node/1100px operation; opening an empty Canvas creates no business object until an explicit user action. |
| EVAL-016 | X List workspace | AI、UK、游戏资讯三个真实根的 MCP `tools/list` 均包含不带确认权限的通用 `x_lists.*`；a valid profile fixture whose publishing platforms exclude X still exposes X Lists; each active workspace uses only its root-local selected X profile to read owned/followed/member List identities; an owned List member batch is frozen, UI-confirmed, serially read back and stoppable. Changing root/account/profile between prepare and confirm makes the old confirmation stale with zero platform/business write. A same-root account-A warm `read-post`/timeline cache followed by account B with the same List ID/URL returns only B data, or accurate `needs_user` with the specified zero-write preflight when B lacks login. A bound List timeline writes traceable current-root source items; identical account/List/URL/cache/source-feed fixtures remain mutually invisible across roots; unsafe external-list actions remain absent. |
| EVAL-017 | AI root enrollment | A sealed pre-enrollment manifest binds Git/diff ownership, acceptance-script and package hashes, resolved root/schema, stable business projections, asset/export hashes, login readback and Pi sessions. Post-enrollment differs only by declared workspace/profile/migration metadata and runtime logs; current capability receipts remain valid. |
| EVAL-018 | Workspace switch and isolation | AI/UK duplicate-value fixtures remain isolated; an in-flight mutation or unsafe task rejects switching; a safe switch relaunches, terminates old HTTP streams/sessions and the complete old process tree, uses a new MCP URL, and leaves the inactive root's DB/WAL/files/jobs unchanged across a due-time observation window. Confirming a new profile revision for the active root uses the same bounded relaunch result: every old profile-bound runtime/process and MCP URL/stream closes, and only the new URL exposes the new capability snapshot. The fresh UI and new MCP read the same authoritative current workspace/capability snapshot; top/status, Publish account and MCP connection surfaces show that identity, and duplicate object IDs or persisted view state do not select an object or intelligence subsection from the previous root. Each persisted empty shared view cold-reopens through one polling window with unchanged business tables, revisions and root files until an explicit action. Injected failure and process-kill at each switch-journal phase restore the original root; moved-root relink and identity mismatch are proven. |
| EVAL-019 | Official profiles and new lanes | Without a configured model, UI creates the fixed UK template; UK completes a linked source → plan → content → X pure-text platform version through UI/Pi/external MCP while every inventoried genuinely AI-only route stays at zero. AI positively retains rankings, while AI/UK/game all expose the same root-local website/X Lists channel surface and never share source configuration, account, cache or items. Studio, Publish and Results show only enabled new actions; UI, IPC, MCP and platform runtimes reject new work outside the current publishing-platform subset with zero write while preserving historical readback. A non-self-media proposal and each stale confirmation binding are rejected with zero registry/root/profile change. 游戏资讯根 is confirmed manually in the real UI, cold-reopened, and completes the same linked text chain; interrupted candidate-root initialization leaves registry/active unchanged and is safely revalidated. Missing model or X login produces one persistent, accurately attributed `needs_user` with stable reason/workspace/profile revision, no duplicate unchanged attempt, fallback or cross-root write. |
| EVAL-020 | Website channel configuration | UI/API resolve an arbitrary public website name or URL to real candidates, trial-read the selected canonical entry, reject a duplicate canonical URL, preserve an unreadable reason, and read back the enabled root-local source without creating a source item merely for the check. |
| EVAL-021 | X List channel resolution | Name, URL and ID inputs resolve only against the current root account; same-name fixtures return every account/List-ID/URL candidate without guessing, and confirmation reuses the exact existing binding while missing login and account change produce zero-write `needs_user`/stale results. |
| EVAL-022 | Shared daily orchestration | Today exposes no channel-management controls, readiness/configuration guidance or module selection and starts every enabled website/X Lists source configured in Discover. Preflight failure is reported only after an explicit start. Each selected source produces a durable receipt. All checked with zero candidates succeeds with an empty plan; one checked plus one failed is partial and preserves success; all blocked returns needs_user before Pi starts; no trustworthy receipt is failed. |
| EVAL-023 | Channel authorization and root isolation | Pi/external MCP prepares an exact batched source diff but exposes no confirm tool; UI confirmation binds workspace/profile/source identities and exact diff, stale confirmation writes zero, and identical AI/UK URL/List fixtures, receipts and collected items remain mutually invisible after cold switches. |
| EVAL-024 | X post metric history and trend | A current Windows package with a real logged-in X profile reads one bound List at least three times. One canonical source item retains three append-only snapshots with raw labels, field status and real capture times; exact two-point velocity and three-point velocity change read back, while null/parse-failed/decreasing/short/insufficient samples produce no fake trend. |
| EVAL-025 | Bounded observation and opportunity lineage | One explicit start creates only the three frozen follow-up windows per selected List; replay is idempotent, account/root/binding changes and late responses write zero, inactive roots do not run, partial List failure preserves success, and a multi-source event opportunity exposes trend evidence through Today and retains the same plan/topic/source chain when UI or MCP creates content. |

All six payload-format evals must pass. Platform authentication and real publication are outside the completion gate.
