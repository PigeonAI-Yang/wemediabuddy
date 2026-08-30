# WeMediaBuddy Campaign-Centered Editorial Operating System Design

- **Date:** 2026-08-30
- **Revision:** 2 — repaired after adversarial implementability audit
- **Status:** revised design awaiting Owner review; no Campaign implementation task is authorized by this document
- **Core reference:** `docs/others/how-to-build-a-one-person-media-company-with-hermes-bots.md`
- **Audit:** `docs/audits/2026-08-30-campaign-centered-editorial-operating-system-adversarial-audit.md`
- **Implementation authority:** `TASKS.md` remains the only construction permit and progress ledger

## 1. Decision

WeMediaBuddy will be re-centered as a **Campaign-centered editorial operating system for a one-person media company**.

The product will continuously:

```text
capture Signals
→ judge Editorial Opportunities
→ advance long-term Topics
→ launch bounded Campaigns
→ build source-bound Evidence Packs
→ freeze an approved Angle Brief
→ create a flagship expression or approved exemption
→ create platform-native assets
→ review the complete package
→ obtain human signoff
→ prepare manual publication
→ observe real performance
→ propose Keep / Test / Stop editorial methods
```

The center is the editorial method and its compounding judgment, not the number or names of Agents.

This is a clean business-ontology cutover. It is **not** permission to replace every mature physical content table. Campaign becomes the new business authority while the existing content project/version subsystem is retained as the subordinate physical asset store during this migration.

## 2. Frozen product decisions

The following decisions are fixed for this design revision:

1. **Product-core reset:** Campaign is not an overlay page over the legacy planning flow.
2. **Scope:** content-production method only; no customer, lead, product, service, sale or revenue objects.
3. **Hierarchy:** Topic governs modern production Campaigns.
4. **Signal intake:** Topic is not required before capturing or judging new information.
5. **Human gates:** each Campaign has exactly two human Owner gates — launch/angle approval and asset-package signoff.
6. **Separate governance action:** permanent Topic/platform method changes also require human Owner approval, but this is not a third Campaign production gate.
7. **Primary surfaces:** Today remains the chief editor's desk; Campaign has a structured workroom.
8. **Content architecture:** flagship-first by default; a timely Campaign may have a launch-approved exemption.
9. **Agent organization:** preserve WMB's fixed role types; do not copy a six-bot roster into the product ontology.
10. **Orchestration:** one workspace Actor remains the sole control authority, but Campaign work uses separate typed intents rather than reopening a terminal discovery root.
11. **Physical storage:** retain `content_projects`, `content_versions` and `platform_versions` as the asset subsystem in this migration.
12. **Cutover:** temporary dual-read is allowed; dual-write is prohibited; writer authority switches once behind a durable fence.
13. **Current-work boundary:** Campaign runtime implementation must not expand WMB-5367 or any active Workspace Orchestrator task. R1 code work depends on completion of the current WMB-5365 milestone chain through WMB-5373, unless the Owner explicitly supersedes that chain at a separate checkpoint.

## 3. Goals and non-goals

### 3.1 Goals

- Preserve capture of important new model releases, product updates, research, policies and audience questions.
- Stop raw Signals from becoming Today clutter.
- Make every modern publishable asset traceable to Campaign, approved Brief revision, Evidence Pack revision, author task, package review and human signoff.
- Separate research truth, editorial judgment, writing, platform distribution and review.
- Let the system automatically perform bounded internal work between two human gates.
- Prevent platform adaptation from becoming shortening or tone replacement.
- Preserve historical publications, media, illustration, investigation, derivative and knowledge references.
- Make stale evidence, partial signoff, unknown publication and insufficient metrics truthful durable states.
- Make performance produce controlled method proposals rather than superstition.
- Remove legacy production write authority in one atomic cutover.

### 3.2 Non-goals

This design does not add:

- automated final publication;
- a generic workflow engine or workflow DSL;
- a multi-Agent choreography editor;
- six permanent bot identities;
- mandatory human approval for internal research, outline or drafting steps;
- mandatory long-form content for every Campaign;
- automatic permanent method updates;
- a second database, microservice or multi-tenant backend;
- a full physical replacement of mature content/version/publication tables;
- Campaign runtime behavior inside the current WMB-5367 task.

## 4. Authority law

This section intentionally revises the previous supervisor-internal approval assumption for the three decisions below. Before Campaign implementation, the same law must be propagated to PRODUCT, PRD and SPEC.

| Decision | Prepares and presents | Final actor | Agent/MCP authority |
| --- | --- | --- | --- |
| Campaign launch and Angle Brief approval | Strategist + desk | **human Owner UI** | read/prepare only; cannot approve |
| Campaign asset/package signoff | Strategist + desk | **human Owner UI** | read/prepare only; cannot sign off |
| permanent Topic/platform method update | Strategist/Librarian + desk | **human Owner UI** | proposal only; cannot approve |
| internal task dispatch and stage advancement | workspace Actor + desk | software control plane | bounded by approved Campaign revision |
| final platform publication | WMB prepares | **human on platform** | no final-click command exists |

### 4.1 Owner-only command invariant

These mutations are Owner-UI-only:

- `campaign.approve_launch`
- `campaign.reject_launch`
- `campaign.defer_launch`
- `campaign.signoff_assets`
- `campaign.defer_signoff`
- `topic.approve_method_update`
- `topic.reject_method_update`

The same request attempted by Pi, external MCP, scheduler, Reporter, Strategist, Writer, Librarian or desk must produce stable zero-write `CAMPAIGN_OWNER_UI_REQUIRED`.

Desk may prepare and present exact decisions but owns no equivalent standing-write approval command.

### 4.2 Decision receipts

Every human decision writes an immutable receipt containing:

- workspace and runtime identity;
- Campaign/Topic identity;
- expected aggregate revision;
- exact Brief, asset or method proposal revisions;
- normalized decision payload hash;
- request ID and actor evidence;
- decision result;
- created time and causation.

Identical replay returns the original receipt. Same request ID with a different hash returns `REQUEST_REPLAY_CONFLICT` and writes no business mutation.

## 5. Authoritative business ontology

### 5.1 Signal

A Signal is an external fact or observation captured from configured channels. Existing `source_items`, channel observations, source-body revisions and provenance remain the source identities.

A Signal answers only:

- what happened;
- where and when it was observed;
- whether the source is retrievable and verifiable.

A Signal is not automatically a Topic, Campaign or Today card.

### 5.2 Editorial Opportunity

An Editorial Opportunity is the durable editorial judgment over one or more Signals.

It records:

- event and urgency;
- target audience question;
- evidence maturity;
- distinct editorial entryway;
- decay time;
- proposed Topic when known;
- action and reason.

Allowed action:

- `rejected`
- `watching`
- `topic_update`
- `propose_topic`
- `campaign_candidate`

`proposed_topic_id` is nullable. Opportunity intake must not invent a Topic merely to satisfy a foreign key.

### 5.3 Topic

A Topic is the durable identity of a long-term question or editorial territory.

It owns:

- long-term question;
- audience and editorial purpose;
- source/evidence relationships;
- viewpoint evolution;
- modern and imported Campaign history;
- unresolved questions;
- approved editorial methods;
- proposed method updates.

### 5.4 Campaign

A Campaign is the business aggregate root for one bounded editorial action.

It owns:

- Topic binding policy;
- Campaign type;
- timeliness and stop conditions;
- target reader and reader outcome;
- central tension and thesis;
- proof requirements;
- flagship strategy or exemption;
- target platforms;
- current approved Brief and Evidence revisions;
- subordinate asset workspaces and asset versions;
- review and signoff decisions;
- publication bindings;
- performance review and method proposals;
- current aggregate phase, condition and revision.

### 5.5 Topic binding rule

`campaign.topic_id` follows these rules:

1. it may be null while Campaign phase is `proposal`;
2. it may remain null for an imported legacy Campaign with migration state `legacy_unknown`;
3. a modern Campaign cannot leave human launch approval without a Topic;
4. launch approval atomically performs exactly one of:
   - bind an existing Topic at an expected revision;
   - approve a proposed new Topic, create it and bind it;
   - reject or defer the Campaign;
5. a stale Topic/proposal revision produces zero writes.

Modern Campaign production never runs topicless.

### 5.6 Evidence Pack

A versioned Evidence Pack records:

- verified claims;
- inference;
- contradictions;
- unsupported claims;
- unknowns;
- source and source-revision bindings;
- quotations/timestamped clips;
- mechanisms worth explaining;
- what the evidence does not prove.

It does not own the headline or final thesis.

### 5.7 Angle Brief

The versioned Angle Brief is the Campaign editorial contract. It records:

- reader;
- reader outcome;
- current source/urgency;
- central tension;
- thesis;
- reusable object;
- required proof;
- flagship format or exemption;
- narrative architecture;
- platform entryways;
- scope, expiry and stop conditions.

Human launch approval freezes one exact Brief revision and Topic binding.

### 5.8 Physical asset subsystem

Campaign is the business authority, but assets continue to use the mature physical subsystem:

- `content_projects`: subordinate asset workspaces;
- `content_versions`: immutable flagship/core versions;
- `platform_versions`: platform asset versions;
- existing media, illustration, investigation, derivative, publication and knowledge references remain valid.

A content project is no longer an independent modern production authority. New project/version writes require a Campaign command and an approved Campaign revision.

### 5.9 Campaign asset metadata

Each formal Campaign asset has metadata binding an existing physical version to the Campaign contract:

- asset logical ID;
- Campaign ID;
- physical kind: `content_version` or `platform_version`;
- physical version ID;
- platform when applicable;
- approved Brief version ID/hash;
- Evidence Pack version ID/hash;
- entryway type;
- reader promise;
- primary claim IDs;
- evidence subset IDs;
- reusable object;
- novelty statement against sibling assets;
- author actor/job ID;
- review/signoff/publication state.

This metadata provides the Campaign semantics without replacing the physical content tables.

### 5.10 Editorial Review

An Editorial Review freezes an exact set of Campaign asset metadata/version references and checks:

- unsupported or new claims;
- evidence drift;
- repeated hooks/openings/arguments;
- sibling assets with no independent value;
- Brief drift;
- tone mismatch;
- stale evidence;
- unapproved flagship exemption;
- unresolved Owner risk.

Review provenance includes `reviewerJobId/actor`. Dispatcher rejects a review when the reviewer job equals the author job of any included asset with `CAMPAIGN_REVIEW_SELF_APPROVAL`.

### 5.11 Performance Review and method proposal

A Performance Review references exact publication and metric snapshots. It may produce:

- `keep_proposal`
- `test_proposal`
- `stop_proposal`
- `insufficient_evidence`

Permanent method updates are separate immutable proposals and require human Owner approval.

## 6. Typed orchestration under one workspace Actor

Campaign does not reopen the current discovery root. The same per-workspace Actor controls three typed intent families.

### 6.1 Intent A — `discover_opportunities`

```text
received
→ preflight
→ scan
→ freeze Signal snapshot
→ judge Opportunities
→ freeze Campaign proposal projection
→ awaiting_launch_decision
→ human approve/reject/defer
→ terminal
```

Outputs:

- rejected/watching/topic-update Opportunities;
- Campaign proposals;
- exact `eligibleCampaignProposalIds` projection.

This replaces `eligiblePlanItemIds` as the modern approval truth after cutover. The two identities must never remain concurrently writable.

### 6.2 Intent B — `campaign_production`

Created exactly once from an approved Campaign/Brief decision receipt.

```text
received
→ validate approved Campaign/Brief/Topic fence
→ evidence
→ flagship or approved exemption
→ platform assets
→ independent package review
→ freeze signoff projection
→ awaiting_signoff_decision
→ human signoff/return/defer
→ terminal
```

A production intent is linked by:

- `campaignId`;
- `approvedBriefVersionId/hash`;
- `approvedTopicId/revision`;
- `predecessorIntentId`;
- unique production generation.

Launch-decision transaction writes an outbox event carrying the deterministic production intent identity. The Actor creates or recovers exactly one production intent from that event.

### 6.3 Intent C — `campaign_observation`

Created from real publication bindings, not from signoff alone.

```text
received
→ validate publication/asset revisions
→ collect metric snapshots
→ freeze comparison context
→ create Performance Review
→ optionally create method proposal
→ terminal
```

Method proposal approval is a later human governance action; it does not keep the observation root alive.

### 6.4 Root and gate invariants

- Each typed intent has its own root and stage FSM.
- A terminal root never reopens.
- `waiting_owner` must carry explicit `decisionKind`:
  - `campaign_launch`
  - `campaign_signoff`
- Method proposals are Today governance cards outside a running Campaign root.
- All intents share the same workspace Actor row, epoch, mailbox, lease, resource admission, receipts, events, outbox/inbox and cutover fence.
- A worker never creates the next worker task. Actor/desk creates each bounded task from durable predecessor artifacts.
- Multi-stage Campaign production is orchestrator progression, not employee-to-employee automatic delegation.
- The existing narrow research-successor rule remains the only worker-stage successor exception unless separately revised.

### 6.5 Dependency on the active Orchestrator milestone

- R0 documentation reconciliation may proceed while WMB-5367–WMB-5373 continue.
- Campaign runtime R1 cannot begin until WMB-5373 passes, unless the Owner explicitly supersedes that milestone chain.
- Campaign work must not alter WMB-5367 acceptance, files or state machine scope.
- The Campaign orchestrator amendment is a new separately authorized task after the current Actor foundation is proven.

## 7. Closed state models

One scalar Campaign status is insufficient. The system uses separate aggregate, asset and decision/review state models.

### 7.1 Campaign aggregate FSM

Campaign stores `phase` and `condition` separately.

`phase`:

- `proposal`
- `production`
- `signoff`
- `publication`
- `observation`
- `closed`

`condition`:

- `active`
- `awaiting_owner`
- `needs_user`
- `deferred`
- `expired`
- `failed`
- `cancelled`
- `complete`
- `legacy_unknown`

Allowed principal transitions:

```text
proposal/active
→ proposal/awaiting_owner
→ production/active | proposal/deferred | closed/cancelled

production/active
→ production/needs_user | signoff/awaiting_owner | closed/expired | closed/failed

signoff/awaiting_owner
→ production/active          (returned assets)
→ publication/active         (one or more assets signed off)
→ signoff/deferred
→ closed/cancelled

publication/active
→ observation/active         (real publication exists)
→ publication/needs_user     (unknown publication)

observation/active
→ closed/complete | observation/needs_user
```

Transition predicates must be specified in SPEC. Terminal condition never returns to active; renewed work creates a successor Campaign or explicit revision workflow.

### 7.2 Asset FSM

Each logical Campaign asset has:

- `planned`
- `drafting`
- `review_required`
- `review_passed`
- `revision_required`
- `signed_off`
- `excluded`
- `publication_ready`
- `published`
- `failed`
- `cancelled`

Only exact asset versions are reviewed and signed.

### 7.3 Decision and review records

Immutable decision identities:

- launch decision;
- package review;
- signoff decision per asset version;
- publication binding/readback;
- method proposal decision.

A signoff decision can independently mark each reviewed asset version:

- `signed_off`
- `revision_required`
- `excluded`
- `deferred`

### 7.4 Stale propagation

- A material approved Brief successor makes all downstream unpublished asset review/signoff decisions stale.
- An Evidence Pack successor identifies changed claim IDs.
- Assets referencing changed claims become review/signoff stale.
- An asset-version successor invalidates that asset's review/signoff and every package review containing the old revision.
- Unchanged signed assets remain valid only when the original signoff receipt explicitly permits independent release.
- A published asset is never rewritten; correction creates a successor asset/publication action with preserved history.

### 7.5 Partial signoff example

For X, Xiaohongshu and WeChat assets, the Owner may:

- sign off X;
- request Xiaohongshu revision;
- exclude WeChat.

X may proceed to manual publication when its signoff permits independent release. Xiaohongshu returns to production, receives a new version, independent review and new signoff. WeChat remains excluded. No decision is overwritten.

## 8. Fixed-role responsibilities and task provenance

| Role | Responsibility | Prohibited |
| --- | --- | --- |
| Reporter | capture Signals, source verification, Evidence Pack, bounded research | thesis approval, unsupported completion, publication |
| Strategist | Opportunity judgment, Angle Brief, independent package review, Performance Review | human gate approval, self-review, publication |
| Writer | flagship/core and platform-native assets | Campaign scope change, proof-policy change, package approval |
| Librarian | accepted evidence, Campaign history and approved methods into Topic knowledge | thesis selection, primary writing, method approval |
| Desk/Supervisor | validate prerequisites, issue bounded tasks, advance typed intents, present human gates | human decision substitution, generic workflow invention, publication |

Every artifact stores actor and job provenance. Human-authored/imported artifacts use explicit actor types and never fabricate job IDs.

## 9. Campaign types

### 9.1 Flagship Campaign

Requires:

- approved Topic/Brief;
- complete Evidence Pack;
- flagship/core version;
- every approved platform asset;
- independent package review;
- human signoff.

### 9.2 Timely Campaign

May omit a long-form flagship only when the approved launch receipt freezes:

- exemption reason;
- timeliness boundary;
- narrowed proof requirement;
- required platform asset set;
- at least one complete formal asset.

A production failure cannot create a retroactive exemption.

### 9.3 Experimental Campaign

Requires:

- specific hypothesis;
- constrained cost/assets;
- observation window;
- comparison rule;
- outcome capable of producing Test, Stop or insufficient evidence, but not automatic permanent Keep.

All types share the same ontology and state models.

## 10. User surfaces

### 10.1 Today

Today shows only:

- Campaign launch decisions;
- Campaign signoff packages;
- permanent method proposals;
- truthful `needs_user`, expiring or failed decisions;
- high-value read-only progress.

It does not show raw Signals, worker logs, generic internal stages or unjudged source piles.

### 10.2 Discovery

Discovery shows:

- Signals and source status;
- Opportunity judgments;
- rejection/watching reasons;
- Topic/Campaign routing.

### 10.3 Topic

Topic shows:

- long-term question and editorial purpose;
- source/evidence relationships;
- modern/imported Campaigns;
- unresolved questions;
- approved methods and pending method proposals.

### 10.4 Campaign workroom

Structured sections:

- Overview
- Research
- Angle
- Flagship
- Distribution
- Review
- Publication
- Performance

The workroom displays durable artifacts and decisions, not Agent chat as business truth.

### 10.5 Studio, Publish and Results

- Studio capabilities become asset-working capabilities inside Campaign.
- Publish consumes exact signed asset versions and preserves manual final publication.
- Results may retain a cross-Campaign read model but cannot own a second review truth.

Internal project-investigation outline/direction artifacts may remain as Agent work artifacts, but their existing approval states must be migrated to internal checks or historical records. They must not create additional mandatory human Campaign gates.

## 11. Physical data model

### 11.1 New domain tables

Logical required identities:

- `editorial_opportunities`
- `editorial_opportunity_sources`
- `campaigns`
- `campaign_brief_versions`
- `campaign_evidence_packs`
- `campaign_evidence_claims`
- `campaign_evidence_source_bindings`
- `campaign_project_bindings`
- `campaign_asset_metadata`
- `campaign_editorial_reviews`
- `campaign_editorial_review_items`
- `campaign_signoff_decisions`
- `campaign_publication_bindings`
- `campaign_performance_reviews`
- `topic_method_proposals`
- `legacy_campaign_mappings`
- `campaign_migration_quarantine`
- `workspace_campaign_cutover_state`

Physical schema may normalize further, but it must preserve the contracts below.

### 11.2 Retained physical asset tables

Retain:

- `content_projects`
- `content_versions`
- `platform_versions`
- existing media-binding tables;
- illustration and Pi-image tables;
- project investigation tables;
- derivative tables;
- publications, confirmations, snapshots and metric tables;
- knowledge usage and dossier references.

These tables no longer authorize modern production by themselves after cutover.

### 11.3 Campaign/project binding

`campaign_project_bindings` contains:

- `campaign_id` FK;
- `project_id` FK;
- binding role: `primary | supporting | legacy_peer`;
- created reason and migration mapping;
- unique `project_id` so one physical project belongs to one Campaign;
- partial unique one `primary` project per modern Campaign.

Modern Campaigns use exactly one primary project. Imported Campaigns may temporarily contain multiple `legacy_peer` projects when one historical plan item had multiple projects; repair may later choose a primary without rewriting history.

### 11.4 Asset metadata binding

`campaign_asset_metadata` references exactly one physical version:

- either `content_version_id` or `platform_version_id`, never both or neither;
- unique physical version reference;
- Campaign and project binding;
- Brief/Evidence revisions and hashes;
- platform entryway and novelty fields;
- author provenance;
- logical asset state and revision.

Existing media/publication FKs remain on the physical version. Campaign uses the metadata binding to recover business meaning.

### 11.5 Review and signoff

A package review stores:

- Campaign and aggregate revision;
- reviewer provenance;
- exact ordered set of asset metadata IDs and physical version IDs;
- Brief/Evidence hashes;
- item findings and package conclusion;
- immutable review hash.

Signoff stores one immutable row per asset version decision under one Owner decision receipt.

### 11.6 Cutover fence

`workspace_campaign_cutover_state` contains one workspace row:

- `legacy_authoritative`
- `migration_rehearsal`
- `campaign_ready`
- `campaign_authoritative`
- `maintenance`
- `failed`

All modern and legacy production commands read this row in the dispatcher transaction.

Before cutover:

- legacy writes allowed;
- Campaign production writes rejected outside rehearsal copy.

After atomic cutover:

- Campaign writes allowed;
- legacy production writes return `LEGACY_PRODUCTION_WRITE_DISABLED` with zero business write.

No production state permits both writers.

## 12. Command contracts

The table below is the minimum normative command surface to propagate into SPEC before code work.

| Command | Allowed actor | Required fence | Main transaction result |
| --- | --- | --- | --- |
| `opportunity.assess` | Reporter/Strategist/desk with task grant | Signal snapshot + Opportunity revision | Opportunity revision and decision receipt |
| `campaign.propose` | Strategist/desk with task grant | Opportunity revision + proposed Brief hash | Campaign proposal + Brief v1 |
| `campaign.approve_launch` | Owner UI only | Campaign/Brief/Topic expected revisions | immutable launch receipt + Campaign production eligibility + outbox |
| `campaign.reject_launch` | Owner UI only | Campaign/Brief expected revisions | immutable rejection receipt + terminal proposal state |
| `campaign.defer_launch` | Owner UI only | Campaign/Brief expected revisions | immutable defer receipt + deferred state |
| `campaign.save_evidence_pack` | Reporter with Campaign task grant | production intent + Campaign/Brief fence | new immutable Evidence Pack revision |
| `campaign.create_project_binding` | desk/Actor internal command | approved Campaign + cutover state | primary project/binding or canonical replay |
| `campaign.save_core_version` | Writer with Campaign task grant | approved Brief/Evidence + project binding | content version + Campaign asset metadata |
| `campaign.save_platform_version` | Writer with Campaign task grant | approved Brief/Evidence + project binding | platform version + Campaign asset metadata |
| `campaign.submit_package_review` | Strategist with review task grant | exact asset revision set + distinct reviewer | immutable package review and findings |
| `campaign.signoff_assets` | Owner UI only | Campaign + review + exact asset revisions | per-asset immutable decisions + publication eligibility |
| `campaign.defer_signoff` | Owner UI only | Campaign + review revision | immutable defer receipt |
| `campaign.bind_publication_result` | Owner UI/browser readback adapter under existing safety contract | signed asset + publication identity | Campaign publication binding; unknown remains unknown |
| `campaign.complete_performance_review` | Strategist with observation task grant | exact publication/metric snapshots | immutable Performance Review + optional method proposal |
| `topic.approve_method_update` | Owner UI only | Topic + proposal expected revisions | immutable method version/decision |
| `topic.reject_method_update` | Owner UI only | Topic + proposal expected revisions | immutable rejection decision; approved method unchanged |

### 12.1 Stable errors

Minimum stable Campaign errors:

- `CAMPAIGN_OWNER_UI_REQUIRED`
- `CAMPAIGN_STATE_CONFLICT`
- `CAMPAIGN_REVISION_CONFLICT`
- `CAMPAIGN_SCOPE_STALE`
- `CAMPAIGN_TOPIC_REQUIRED`
- `CAMPAIGN_BRIEF_STALE`
- `CAMPAIGN_EVIDENCE_STALE`
- `CAMPAIGN_ASSET_STALE`
- `CAMPAIGN_REVIEW_STALE`
- `CAMPAIGN_REVIEW_SELF_APPROVAL`
- `CAMPAIGN_SIGNOFF_REQUIRED`
- `CAMPAIGN_FLAGSHIP_EXEMPTION_REQUIRED`
- `CAMPAIGN_CUTOVER_NOT_ACTIVE`
- `LEGACY_PRODUCTION_WRITE_DISABLED`
- `CAMPAIGN_MIGRATION_QUARANTINED`
- existing workspace/grant/replay errors where applicable.

Every mutation returns canonical readback proving the exact committed revisions. Text narration is never success evidence.

## 13. Migration contract

### 13.1 Measured baseline

The audit read the active data root and found:

| Object/condition | Count |
| --- | ---: |
| plan items | 490 |
| content projects | 466 |
| content versions | 545 |
| platform versions | 11 |
| publications | 12 |
| reviews | 3 |
| method findings | 2 |
| plan items without project | 37 |
| projects without plan item | 12 |
| plan items with multiple projects | 1 |
| topicless plan items | 325 |
| topicless projects | 322 |
| projects with multiple content versions | 26 |
| maximum versions on one project | 12 |

This baseline is evidence, not a permanent fixture. Migration rehearsal must recapture counts from its own source snapshot.

### 13.2 Deterministic category rules

| Legacy category | Campaign result |
| --- | --- |
| plan item with one linked project | one imported Campaign; project binding; plan data becomes legacy Brief evidence |
| plan item with multiple linked projects | one imported Campaign with all projects as `legacy_peer`; no invented primary |
| plan item without project | imported Campaign proposal with no assets |
| project without plan item | imported Campaign with project binding and `legacy_unknown` launch history |
| approved plan item | legacy launch status recorded as `legacy_approved`, not fabricated human Campaign receipt |
| draft/ready plan item | imported proposal preserving exact old status |
| topicless legacy object | `topic_id=NULL`, migration condition `legacy_unknown` |
| content versions | preserved unchanged; create metadata bindings in version order |
| platform versions | preserved unchanged; create platform metadata bindings |
| publication/review/method finding | preserve existing rows; create Campaign bindings through physical versions/publications |
| ambiguous/inconsistent FK or duplicate mapping | quarantine with reason; original row remains readable |

### 13.3 Mapping identity

`legacy_campaign_mappings` has unique `(legacy_object_type, legacy_object_id)` and stores:

- Campaign ID;
- migration version;
- source snapshot hash;
- classification rule;
- result hash;
- created time.

Replay with the same source snapshot returns the same mapping. Different source facts after rehearsal require a new migration generation; they do not rewrite a completed mapping silently.

### 13.4 Reconciliation invariant

For every legacy object type:

```text
source_count
= migrated_count
+ quarantined_count
+ intentionally_retained_without_campaign_count
```

Unclassified count must be zero.

### 13.5 Rehearsal and rollback

- Rehearsal runs only on a copied data root with Campaign writer disabled in production.
- Rehearsal verifies all dependent publication/media/illustration/investigation/derivative/knowledge references.
- Before atomic cutover, rollback is restoration to the untouched legacy-authoritative root/copy.
- After Campaign-authoritative writes exist, silent downgrade to a legacy binary is prohibited; incompatible rollback enters `maintenance` and requires an explicit forward repair/rebase plan.

## 14. Cutover contract

### 14.1 Build-behind-fence rule

The complete minimal Campaign vertical path is implemented and proven while normal production remains `legacy_authoritative`.

Temporary dual-read is allowed for comparison. No command writes both legacy and Campaign truths.

### 14.2 Atomic writer cutover

One dispatcher transaction or equivalently fenced migration bundle:

1. verifies migration rehearsal and current source fingerprint;
2. confirms required Campaign schema/build version;
3. sets `workspace_campaign_cutover_state=campaign_authoritative`;
4. activates Campaign producer allowlist;
5. disables legacy production command allowlist;
6. writes cutover receipt/event/readback.

Late legacy writers observe the current fence and write zero business rows.

### 14.3 No production gap

- Before cutover, the existing production flow remains usable.
- At cutover, the complete Campaign path already exists.
- No committed application version approves Campaign work without a runnable production path.
- No committed application version permits two active production writers.

## 15. Editorial review and platform-native acceptance

Each platform asset must persist:

- `entrywayType`: capability, proof, mechanism, workflow, risk, result, personal context or registered extension;
- reader promise;
- primary claim set;
- Evidence subset;
- reusable object;
- novelty statement against each sibling asset.

Package review produces itemized findings, not a single model score.

Acceptance uses adversarial golden packages:

- identical opening copied across platforms;
- paraphrased but substantively identical argument;
- unsupported fact introduced during adaptation;
- stale source;
- platform asset that only quotes the flagship;
- genuinely distinct proof/mechanism/workflow entryways.

Tests prove that required metadata and durable findings are produced and that known defects are blocked. They do not claim a deterministic machine can prove universal creative quality.

## 16. Keep / Test / Stop governance

Every method proposal freezes:

- platform/account;
- Campaign type;
- metric names and raw snapshot IDs;
- observation window;
- comparison cohort;
- known confounders;
- applicability scope;
- supporting Campaign IDs;
- contradicting Campaign IDs.

### 16.1 Keep proposal

Requires:

- at least two comparable Campaigns;
- directionally consistent results;
- comparable platform/account and observation windows, or an explicit normalization contract;
- no known exceptional factor sufficient to explain the result alone;
- explicit applicability limits.

Incomparable evidence remains Test or insufficient evidence.

### 16.2 Test proposal

Used for one strong result, first signal, conflicting evidence or a new format/entryway. It must define the next eligible Campaign and comparison method.

### 16.3 Stop proposal

Used for repeatedly weak, duplicative, costly, unsupported, platform-mismatched or factually invalidated patterns.

All permanent changes require human Owner approval.

## 17. Failure and recovery semantics

| Failure | Durable result |
| --- | --- |
| Signal fetch failed | failed/unavailable Signal attempt; no verified Opportunity |
| Evidence insufficient | production remains active/needs_user with missing claim IDs |
| Evidence contradicts thesis | Brief becomes stale; downstream mutation fenced; new launch decision required |
| one asset fails | other asset states remain truthful; signoff package shows exact missing/failed item |
| flagship fails | Flagship Campaign cannot complete; no retroactive exemption |
| review finds drift/repetition | exact asset versions return to revision_required |
| timeliness expires | Campaign closes expired; timeless reframing is a successor Campaign/new launch decision |
| author reviews own asset | stable zero-write rejection |
| runtime restarts | resume from intent/artifact/revision, never chat |
| publication unknown | unknown/needs_user; never published |
| metrics unavailable | insufficient_evidence |
| migration ambiguous | quarantine; original remains readable |
| old writer after cutover | `LEGACY_PRODUCTION_WRITE_DISABLED`, zero business write |

## 18. Revised delivery sequence

### R0 — Contract closure and normative propagation

Documentation/design only; may occur while current Orchestrator work continues.

Deliver:

- authority revision in PRODUCT/PRD/SPEC;
- typed intent amendment to Workspace Orchestrator design;
- Campaign/Asset/Decision FSM transition tables in SPEC;
- physical storage and FK dependency contract;
- command schemas, actor allowlists, transaction bundles and errors;
- migration manifest and acceptance matrix;
- new TASKS entries in dependency order.

R0 acceptance: an implementer can answer every actor, row, transition, fence, migration category and proof command without inference.

### R1 — Domain and physical bindings behind disabled Campaign authority

**Dependency:** WMB-5373 complete, unless explicitly superseded.

Deliver:

- Opportunity/Campaign/Brief/Evidence/Review domain tables;
- bindings to retained content project/version subsystem;
- read models and migration classifier;
- `workspace_campaign_cutover_state` remaining `legacy_authoritative`;
- no normal production Campaign writes.

### R2 — Complete minimal Campaign vertical path behind the fence

Deliver:

```text
official Signal
→ Opportunity
→ Campaign proposal
→ human launch approval
→ Evidence Pack
→ flagship or approved exemption
→ one platform asset
→ independent package review
→ human signoff
→ existing manual publication preparation
```

Also deliver crash/replay, stale revision and actor authorization checks. Campaign producer remains disabled for normal production.

### R3 — Real-data migration rehearsal

On a copied current root:

- recapture baseline;
- classify all legacy rows;
- run migration and reconciliation;
- validate every dependent historical reference;
- run the complete vertical Campaign scenario;
- prove rollback before production cutover.

### R4 — Atomic clean cutover

One separately authorized milestone:

- activate Campaign writer authority;
- route UI, IPC, MCP and scheduler to Campaign commands;
- disable legacy production writes;
- switch Today/Discovery/Studio/Results projections;
- preserve historical reads and quarantine;
- prove old writers fail closed.

### R5 — Package acceptance and breadth

- verify current Windows package;
- add remaining platform asset breadth;
- add campaign observation and method loop;
- retire obsolete code/UI only after caller census proves zero legacy writers;
- update canonical operator Skill for delivered behavior.

## 19. Acceptance matrix

| ID | Scenario | Unique proof |
| --- | --- | --- |
| CAM-A01 | important new Signal with no Topic | one Opportunity; no raw Today card; atomic Topic+Campaign launch |
| CAM-A02 | non-human launch/signoff/method approval | stable `CAMPAIGN_OWNER_UI_REQUIRED`, zero business write |
| CAM-A03 | crash between launch receipt and production intent | exactly one recovered production intent |
| CAM-A04 | evidence contradicts approved thesis | Brief stale; downstream writes fenced; new launch required |
| CAM-A05 | author reviews own asset | `CAMPAIGN_REVIEW_SELF_APPROVAL` and durable audit |
| CAM-A06 | three-asset partial signoff | signed/returned/excluded states and immutable receipts |
| CAM-A07 | asset edited after review | affected review/signoff stale; frozen unaffected behavior preserved |
| CAM-A08 | timely flagship exemption | succeeds only when exemption existed in approved launch receipt |
| CAM-A09 | legacy migration rehearsal | source=migrated+quarantined+retained; zero unclassified |
| CAM-A10 | old writer after cutover | UI/IPC/MCP/scheduler all fail with zero write |
| CAM-A11 | publication unknown | no published state; unknown survives restart |
| CAM-A12 | incomparable method evidence | Keep rejected/downgraded to Test or insufficient evidence |
| CAM-A13 | workspace switch during production | late old-root writes rejected; no cross-root Campaign rows |
| CAM-A14 | duplicate/claim-drift golden packages | exact durable review findings and blocked signoff eligibility |
| CAM-A15 | historical dependent artifacts | publications/media/illustration/investigation/derivatives/knowledge resolve unchanged |
| CAM-A16 | no production gap | pre-cutover legacy path works; cutover version has complete Campaign path |
| CAM-A17 | no dual writer | fence census and dynamic attempts prove exactly one writer authority |
| CAM-A18 | plan item with multiple projects | one imported Campaign, multiple legacy_peer bindings, no invented primary |
| CAM-A19 | topicless legacy migration | legacy_unknown preserved; modern production remains topic-required |
| CAM-A20 | packaged real model-release flow | actual Windows package completes Signal→signoff with durable IDs/readback |

## 20. Go/no-go gate

Campaign runtime implementation is GO only when:

- [ ] this repaired design is Owner-approved;
- [ ] R0 normative propagation is complete;
- [ ] WMB-5367 scope remained unchanged;
- [ ] WMB-5373 is complete or explicitly superseded;
- [ ] typed Campaign intent families and gate projections are specified;
- [ ] Owner-vs-desk authority is command-enforced;
- [ ] Topic binding and legacy topicless rules are specified;
- [ ] retained physical asset strategy and dependent FKs are covered;
- [ ] Campaign/Asset/Decision FSMs and stale propagation are specified;
- [ ] migration manifest reconciles a fresh real-data baseline;
- [ ] cutover has no production gap and no dual-write state;
- [ ] command contracts and stable errors are normative;
- [ ] CAM-A01 through CAM-A20 have mapped verification scenarios;
- [ ] separately authorized TASKS entries exist.

## 21. Required normative consequences

R0 must update:

1. `PRODUCT.md` — new editorial lifecycle, human gate law and Campaign authority;
2. `PRD.md` — requirements and acceptance for Signal/Opportunity/Topic/Campaign and two gates;
3. `SPEC.md` — schema, command, FSM, actor, receipt, error, cutover and migration contracts;
4. `TECHNICAL_DESIGN.md` — module ownership and retained physical asset subsystem;
5. Workspace Orchestrator design — typed intent families under the same Actor;
6. `TASKS.md` — dependency-ordered R1–R5 implementation tasks only after R0 approval;
7. canonical WMB operator Skill — only after observable behavior is delivered.

This document does not itself authorize those edits or implementation.

## 22. Completion statement

The transformation is complete only when WMB can truthfully answer from durable facts:

1. What happened outside that is worth attention?
2. Which Opportunity deserves a Campaign, and why?
3. Which Topic does the modern Campaign advance?
4. What exact reader, outcome, thesis and evidence contract did the human Owner approve?
5. Which exact physical asset versions were produced, by which tasks, from which Brief/Evidence revisions?
6. Did independent review find unsupported claims, drift or duplicated platform value?
7. Which exact assets did the human Owner sign off, return, exclude or defer?
8. What was manually published, and what remains unknown?
9. What comparable evidence supports Keep, Test or Stop?
10. Which approved method is available to the next Campaign?

If WMB only adds named Agents, a Campaign board, extra generated variants or a parallel write path, this design has not been delivered.
