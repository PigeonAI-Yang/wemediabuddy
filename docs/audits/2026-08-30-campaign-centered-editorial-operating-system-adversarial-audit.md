# Campaign-Centered Editorial Operating System — Adversarial Implementability Audit

- **Date:** 2026-08-30
- **Audited design:** `docs/spark/2026-08-30-campaign-centered-editorial-operating-system-design.md`
- **Audit type:** adversarial architecture, migration, authority, state-machine and acceptance review
- **Verdict:** **NO-GO for implementation as currently specified; concept is sound, implementation contract is not closed**
- **Required next state:** revise the design through the P0 closure requirements in this report before adding Campaign implementation tasks to `TASKS.md`

> **Post-audit status:** Revision 2 of the audited design now incorporates the recommended typed intent split, Owner-only authority law, nullable proposal/legacy Topic binding, retained physical asset subsystem, closed multi-axis state models, deterministic migration categories, atomic cutover fence and CAM-A01–CAM-A20 acceptance matrix. Runtime implementation remains blocked until Revision 2 is Owner-approved and its R0 normative propagation is complete.

## 1. Executive conclusion

The design successfully captures the intended self-media method:

- continuous Signal capture remains;
- Topic represents long-term editorial territory;
- Campaign represents one bounded editorial action;
- evidence, angle, flagship expression, platform-native assets, package review and performance learning are separated;
- the Owner is not asked to supervise every internal stage;
- the system does not devolve into six named bots or a generic workflow editor.

That product direction is coherent.

The design is **not yet safe to implement** because it leaves six load-bearing questions unresolved:

1. the active Workspace Orchestrator contract terminates after candidate approval, while the Campaign design expects the same control plane to continue through research, writing, review and a second Owner gate;
2. Campaign Owner gates conflict with current frozen authority rules that assign internal approvals to the software supervisor and restrict the current orchestrator's Owner interactions;
3. Campaign requires one Topic while both the design's own new-signal scenario and the live database contain large numbers of topicless objects;
4. the proposed replacement asset schema ignores a broad existing foreign-key and feature dependency graph around `content_projects`, `content_versions` and `platform_versions`;
5. the milestone order stops the old production path before the new production path exists;
6. one Campaign `phase/status` is insufficient to represent independent asset revisions, partial signoff, partial publication and stale package review.

Starting implementation before closing these points would predictably create one of three failures:

- a second orchestration truth beside the currently active Actor migration;
- a second content truth beside existing project/version/publication tables;
- a UI that appears Campaign-centered while old IPC/MCP/scheduler paths continue producing legacy objects.

The safe decision is therefore:

> **Preserve the approved product direction, but add a mandatory M0 contract-closure milestone. Do not fold Campaign semantics into the currently active WMB-5367 task.**

## 2. Evidence baseline

### 2.1 Active implementation state

`TASKS.md` currently records:

- WMB-5365 Workspace Orchestrator baseline: done;
- WMB-5366 durable storage: done;
- **WMB-5367 Actor core: doing**;
- WMB-5368–WMB-5373: queued through FSM, Manager/Today projection, clean cutover, recovery and adversarial acceptance.

The current orchestrator design is not an abstract future idea. Its schema has already landed and its Actor implementation is active work.

The currently frozen orchestrator lifecycle is:

```text
preflight → scan → judge → PlanScope/Projection → waiting_owner
          → approve/reject → succeeded
```

Its explicit scope says Writer/publication are later controlled work. Its frozen Owner boundary says `waiting_owner` is only for real eligible candidates, and candidate approval terminates the root.

The Campaign design instead requires:

```text
launch approval
→ research
→ flagship/platform production
→ package review
→ signoff approval
→ publication/observation/review
```

These are not the same state machine.

### 2.2 Live migration cardinalities

Read-only queries against the active data root produced:

| Object | Count |
| --- | ---: |
| `plan_items` | 490 |
| `content_projects` | 466 |
| `content_versions` | 545 |
| `platform_versions` | 11 |
| `publications` | 12 |
| `reviews` | 3 |
| `method_findings` | 2 |

Relationship facts:

| Condition | Count |
| --- | ---: |
| plan items without a content project | 37 |
| unlinked content projects (`plan_item_id IS NULL`) | 12 |
| plan items with multiple content projects | 1 |
| topicless plan items | 325 |
| topicless content projects | 322 |
| projects with multiple content versions | 26 |
| maximum content versions on one project | 12 |

Current planning status:

| Status | Count |
| --- | ---: |
| approved | 451 |
| draft | 35 |
| ready_for_review | 4 |

Dependent artifact facts:

| Object | Count |
| --- | ---: |
| project investigations | 1 |
| content media bindings | 78 |
| platform media bindings | 4 |
| illustration runs | 3 |
| content derivatives | 3 |
| publication snapshots | 3 |
| publication confirmations | 8 |

These counts disprove any migration assumption of simple one-to-one `plan_item → project → campaign` identity or universal Topic ownership.

### 2.3 Existing physical dependency graph

The existing creation tables are referenced by at least these durable domains:

- publication records, attempts, snapshots and browser operations;
- content and platform media bindings;
- illustration runs and items;
- Pi image batches and placements;
- media recommendations;
- knowledge context uses and project context packages;
- creative briefs;
- project investigations, outlines, directions, research rounds and decisions;
- daily content targets;
- content derivatives and derivative versions;
- knowledge dossier queries, reviews and method findings.

Therefore, replacing `content_projects/content_versions/platform_versions` with new Campaign asset tables is not a local schema change. It is a cross-domain migration.

## 3. Severity model

- **P0 Blocker:** implementation would create contradictory authority, non-migratable data, dual truth or an unclosable state machine.
- **P1 Major:** implementation could proceed mechanically but acceptance would be subjective, recovery would be ambiguous or later rework would be likely.
- **P2 Improvement:** does not block the first safe implementation contract but should be made explicit for maintainability.

## 4. P0 blockers

### P0-1. Workspace Orchestrator contract collision

**Evidence**

- Current orchestrator: candidate approval ends the intent/root as `succeeded`.
- Current frozen rule: `waiting_owner` is only valid for eligible plan candidates.
- Campaign design §6/§12: after launch approval the orchestrator continues through research, writing, package review and a second `awaiting_signoff` gate.
- WMB-5367 is already implementing the current Actor contract.

**Failure if implemented directly**

One of the following would occur:

1. a terminal discovery root would be illegally reopened;
2. Campaign production would be added as an untracked child path outside Actor authority;
3. `waiting_owner` would silently acquire a second incompatible meaning;
4. WMB-5367–WMB-5373 would expand mid-flight into a different product state machine.

All four violate current design and scope controls.

**Required closure**

The Campaign design must choose an explicit control model. Recommended:

```text
Intent A: discover_opportunities
  preflight → scan → judge → campaign proposal projection
  → Owner launch decision → terminal

Intent B: campaign_production
  created from the approved Campaign/Brief revision
  → evidence → assets → package review
  → Owner signoff projection → terminal

Intent C: campaign_observation
  created from real publication bindings
  → metric observation → performance review/method proposal → terminal
```

All three intents use the **same per-workspace Actor authority**, mailbox, leases, receipts, outbox and fencing. They are separate typed product FSMs linked by `campaignId + predecessorIntentId`, not one reopened root and not worker-to-worker chaining.

The orchestrator design must be amended before Campaign implementation to define:

- allowed intent kinds;
- root/stage FSM per kind;
- gate projection type per kind;
- identity/hash registry additions;
- cancellation and stale-revision behavior across predecessor intents;
- Manager/Today read models for multiple decision kinds.

**Acceptance proof**

A crash after launch approval but before production dispatch must recover exactly one `campaign_production` intent. A crash after package review must recover the same signoff projection. No discovery root is reopened and no duplicate production intent exists.

### P0-2. Human Owner gates conflict with frozen authority rules

**Evidence**

The Campaign design freezes two human Owner gates and an explicit method-change approval. Current product contracts also state:

- software supervisor/desk holds full internal standing write authority;
- internal approvals are performed by the supervisor;
- current orchestrator Owner interaction is restricted to candidate approval and required-channel repair;
- employees do not approve Owner decisions.

The design names representative commands but does not declare their allowed actor classes or whether they are UI-only gates.

**Failure if unresolved**

- Desk may automatically sign off a Campaign the human expected to review.
- Pi/MCP may receive an internal command that effectively bypasses the human gate.
- Existing capability-registry rules may reject the intended Owner action or mistakenly permit Agent execution.
- “Two Owner gates” could become display copy without an enforceable authorization boundary.

**Required closure**

Add a new explicit authority law to PRODUCT/PRD/SPEC:

| Decision | Prepares/presents | Final actor | Agent/MCP access |
| --- | --- | --- | --- |
| Campaign launch/Angle Brief approval | desk | human Owner UI | prepare/read only; cannot approve |
| Campaign asset/package signoff | desk | human Owner UI | prepare/read only; cannot sign off |
| Topic/platform permanent method update | librarian/strategist/desk | human Owner UI | proposal only; cannot approve |
| final platform publish | WMB prepares | human on platform | no final-click command exists |

`campaign.approve_launch`, `campaign.signoff_assets` and `topic.approve_method_update` must be Owner-UI-only mutations with exact expected revisions and immutable decision receipts. Desk may issue no equivalent standing-write command.

This is an intentional revision of the current supervisor-internal approval lock and must be recorded as such rather than implied inside one feature design.

**Acceptance proof**

The same exact command attempted by Pi, external MCP, scheduler, worker or desk must produce stable zero-write authorization failure. The human UI action with the expected revision succeeds once and replays idempotently.

### P0-3. Mandatory Topic ownership contradicts intake and live data

**Evidence**

- Design §5.4 says Campaign owns “one Topic relationship”.
- AC-1 requires a significant new model release with no existing Topic to become a Campaign proposal.
- The live database contains 325 topicless plan items and 322 topicless projects.
- The migration design says unlinked historical drafts become imported Campaigns but does not define Topic behavior.

**Failure if unresolved**

- Urgent opportunities cannot be proposed until an unrelated Topic workflow completes.
- Migration must invent Topics, reject hundreds of existing objects or violate the Campaign schema.
- A proposal and new Topic may be committed in separate transactions, leaving orphaned or stale approvals.

**Required closure**

Freeze these rules:

1. `editorial_opportunity.proposed_topic_id` is nullable.
2. `campaign.topic_id` may be null only while status is `draft_proposal/awaiting_launch_approval` or migration status is `legacy_unknown`.
3. A new production Campaign cannot leave launch approval without a Topic.
4. Owner launch approval must atomically perform exactly one of:
   - bind an existing Topic revision;
   - approve and create a proposed Topic, then bind it;
   - reject/defer the Campaign.
5. Imported legacy Campaigns may remain topicless with `legacy_unknown`; they cannot be represented as fully compliant modern Campaigns until explicitly repaired.

**Acceptance proof**

A new model release with no Topic produces one proposal. Approving “create new Topic + launch Campaign” commits both objects and their binding in one dispatcher transaction. A stale Topic proposal produces zero writes.

### P0-4. Asset replacement strategy is physically incomplete

**Evidence**

The design introduces `campaign_assets/campaign_asset_versions` and says existing creation objects are migration sources. Existing tables are deeply referenced across publishing, media, knowledge, investigations, illustration and derivatives. Live data includes version history, media bindings, publication receipts and investigation artifacts.

**Failure if implemented as written**

- Foreign keys must be rebuilt across many unrelated domains.
- Existing immutable publication snapshots can lose their original object identity.
- Media/illustration/knowledge features can silently become orphaned.
- A “clean” logical model can require a high-risk 2.4 GB database rewrite.
- Implementation scope expands far beyond the five stated milestones.

**Required closure**

The design must choose one physical strategy. Recommended safe strategy:

> **Campaign becomes the new business authority, while existing `content_projects`, `content_versions` and `platform_versions` remain the physical asset subsystem during this migration.**

Under this model:

- add `campaign_id` binding/association with exact uniqueness rules;
- treat `content_project` as a subordinate Campaign asset workspace, not an independent production authority;
- retain immutable `content_versions` as flagship/core asset versions;
- retain `platform_versions` as platform asset versions but add/freeze Campaign Brief, Evidence Pack, entryway and independent-value references;
- require all new asset writes to enter through Campaign commands;
- preserve existing publication/media/illustration/knowledge FKs;
- retire old direct project/version commands without immediately replacing every physical table.

A later table-renaming or asset-schema normalization may be a separate migration after Campaign behavior is proven. It must not be hidden inside this product cutover.

If full physical replacement is still desired, the design must provide a complete table-by-table FK rebuild, object-ID mapping, rollback and package validation contract before implementation.

**Acceptance proof**

After cutover, every existing publication, media binding, illustration run, project investigation, derivative and knowledge usage still resolves to the same historical content. New writes cannot create a project/version without a Campaign authority and approved revision.

### P0-5. Current milestone order creates a production gap

**Evidence**

- M2 says the old daily planning path stops creating new formal production objects.
- M3 is where the Campaign workroom, asset production and signoff gate are delivered.

**Failure if followed literally**

Between M2 and M3, WMB can approve Campaigns but has no complete new production path. Avoiding this gap would force an undocumented legacy fallback or dual write, both prohibited by the design.

**Required closure**

Replace the milestone order with a build-behind-fence strategy:

1. build and verify new domain/read models without routing production traffic;
2. build the complete minimal Campaign vertical path behind a disabled cutover fence;
3. rehearse migration and full behavior on a copied real data root;
4. atomically activate Campaign routing and disable legacy writers in one cutover milestone;
5. retain only historical reads and explicit quarantine afterward.

Temporary dual-read is allowed. **Dual-write is not.** The old writer remains authoritative until the atomic cutover; the new writer remains disabled until it is end-to-end complete.

**Acceptance proof**

At every committed version before cutover, the legacy path remains fully usable. At the cutover commit, one durable fence makes exactly one writer authoritative. There is no version in which approved work has no production path and no version with two active writers.

### P0-6. Campaign lifecycle is not a closed state model

**Evidence**

The design stores one Campaign phase/status but also permits:

- multiple independently versioned assets;
- partial signoff;
- asset-specific revision requests;
- partial publication over time;
- package-review invalidation after one asset changes;
- stale Brief/Evidence propagation;
- defer, reject, expire and resume.

These states are orthogonal. One scalar lifecycle cannot truthfully represent them.

**Failure if unresolved**

- A signed X asset and rejected WeChat asset cannot be represented without inventing ambiguous Campaign states.
- Editing one asset may incorrectly invalidate already signed assets or fail to invalidate the package review.
- Partial publication can mark the Campaign published while unsigned assets still exist.
- Restart recovery cannot determine the exact next action.

**Required closure**

Define three explicit state machines:

1. **Campaign aggregate FSM** — proposal, active production, awaiting signoff, publishing/observing, reviewed, terminal.
2. **Asset FSM** — planned, drafting, review_required, review_passed, revision_required, signed_off, excluded, publication_ready, published, failed.
3. **Decision/review FSM** — launch decision revision, package review revision-set, signoff decision per asset revision, method proposal decision.

Freeze stale propagation rules:

- Brief material revision invalidates all downstream un-published asset approvals.
- Evidence revision invalidates only assets whose referenced claims changed, unless package policy requires full re-review.
- Asset revision invalidates that asset's review/signoff and any package review whose revision set included it.
- Signed-off unaffected assets remain valid only when the signoff decision explicitly permits independent asset release.

**Acceptance proof**

A package with three assets must support: sign off X, return Xiaohongshu, exclude WeChat, publish X, revise Xiaohongshu, re-review only the required set, then publish it later without corrupting the original X decision or publication history.

## 5. P1 major findings

### P1-1. Opportunity and current PlanScope identities are not reconciled

The current orchestrator freezes `PlanScope`, `TodayRecommendationProjection` and `eligiblePlanItemIds`. The Campaign design adds `editorial_opportunities` and Campaign proposals but does not state which object replaces `plan_items` in the frozen projection.

**Required change:** define the post-migration projection identity, recommended as `eligibleCampaignProposalIds`, and define whether Opportunity is pre-proposal evidence or the approval object itself. Do not retain both `eligiblePlanItemIds` and `eligibleCampaignProposalIds` as writable approval truths.

### P1-2. Automatic multi-stage production is not reconciled with the single-hop employee rule

Current product law prohibits employee-to-employee automatic multi-hop, with one narrow research-successor exception. The Campaign design describes automatic Reporter → Strategist → Writer → Strategist → Librarian progress.

**Required change:** state that workers never delegate to each other. The workspace Actor/desk creates each new bounded task from durable Campaign prerequisites. Add capability, grant, object-key and budget contracts for each stage. Any extension of the research-only successor exception must be an explicit product-law revision, not an implementation inference.

### P1-3. The package-review independence rule is not durable

“The same active instance may not author and approve the package” is not implementable without provenance fields.

**Required change:** every asset version stores `authorJobId/actor`; every review stores `reviewerJobId/actor`; dispatcher validation rejects a review when reviewer job equals any included authored asset job. Define behavior for human-authored assets and imported legacy versions.

### P1-4. AC-3 is not falsifiable enough

“Each asset adds value for a reader who consumed another asset” is a sound editorial principle but not a deterministic acceptance criterion.

**Required change:** require structured fields per asset:

- entryway type;
- primary reader promise;
- primary claim set;
- evidence subset;
- reusable object;
- novelty statement against sibling assets.

Package review must produce explicit duplicate/novelty findings. Acceptance must use adversarial golden packages containing copied openings, unsupported claims, near-duplicate arguments and genuinely distinct platform entries. The test proves the review contract and durable findings, not metaphysical content quality.

### P1-5. Keep/Test/Stop lacks comparable metric semantics

“At least two Campaigns” is not sufficient when platforms, observation windows, reach sources and content types differ.

**Required change:** method proposals must freeze:

- platform/account;
- metric names and raw snapshots;
- observation window;
- Campaign type;
- comparison cohort;
- known confounders;
- applicability scope;
- supporting and contradicting Campaign IDs.

A Keep proposal with incomparable windows or platforms must fail closed or remain Test.

### P1-6. Existing Project Investigation introduces hidden extra gates

The current database and code already contain project investigation states including outline approval, direction approval, research review and ready-to-write. The Campaign design promises two Owner gates.

**Required change:** map or retire Project Investigation states explicitly. Internal outline/direction checks may remain Agent artifacts, but they cannot surface as extra mandatory Owner approvals. Existing investigation history must migrate without being mislabeled as Campaign launch/signoff approval.

### P1-7. Representative commands are not implementation contracts

The command list omits schemas, actors, expected revisions, idempotency identity, state preconditions, output receipts and error codes.

**Required change:** before implementation, SPEC must define each new mutation with:

- request schema;
- actor allowlist;
- task/grant requirement;
- object boundary key;
- expected revisions and hashes;
- state transition;
- transaction bundle;
- replay identity;
- stable errors;
- readback proving success.

### P1-8. Migration rules are not cardinality-complete

The design says deterministic mapping but does not define:

- 37 plan items with no project;
- 12 projects with no plan item;
- one plan item with multiple projects;
- hundreds of topicless objects;
- draft and ready-for-review plans;
- multiple core versions;
- reviews/method findings linked through publication rather than directly to projects;
- objects created during migration rehearsal.

**Required change:** create a machine-readable migration decision table with one rule and expected count for every category. A rehearsal must reconcile source count = migrated + quarantined + intentionally retained, with zero unclassified rows.

## 6. P2 improvements

### P2-1. Name the exact first vertical slice

The first runnable Campaign slice should be frozen as:

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
→ manual publication preparation
```

Multi-platform package breadth and method learning can expand after this slice proves the authority and artifact chain.

### P2-2. Separate editorial method from knowledge-note storage

Topic methods may reuse the current knowledge flywheel, but a method proposal, approved method version and supporting evidence set need explicit identities. Do not store permanent editorial rules only as free-form notes.

### P2-3. Define retention and archive behavior

Completed/rejected/expired Campaigns, superseded Briefs, stale reviews and quarantined imports need retention/read behavior. Hard delete remains prohibited, but archive and UI visibility should be explicit.

## 7. Required M0 contract-closure milestone

No Campaign implementation task should enter `doing` until M0 is complete.

### M0 deliverables

1. **Normative product revision**
   - revise PRODUCT/PRD/SPEC authority rules for the human launch, signoff and method gates;
   - preserve manual final publication;
   - state that the two gates are per Campaign and method approval is a separate governance action.

2. **Orchestrator amendment**
   - define typed `discover_opportunities`, `campaign_production` and `campaign_observation` intent families under the same Actor;
   - define gate projections and terminal boundaries;
   - state how this amendment depends on or follows WMB-5367–WMB-5373;
   - prohibit adding Campaign behavior inside the current WMB-5367 scope.

3. **Physical storage decision**
   - approve reuse of existing project/version/platform tables as the subordinate asset subsystem, or deliver a complete FK rebuild plan;
   - define Campaign bindings and uniqueness.

4. **Closed FSM specification**
   - Campaign, Asset and Decision/Review transition matrices;
   - stale propagation;
   - partial signoff/publication;
   - cancellation, expiration and recovery.

5. **Migration manifest**
   - complete dependency census;
   - category rules and expected counts from a real-data baseline;
   - quarantine schema;
   - replay, crash and rollback rules;
   - no dual-write invariant.

6. **Command contracts**
   - exact schemas, actor boundaries, revisions, transaction bundles, receipts and errors.

7. **Acceptance matrix**
   - map every requirement to one strongest test or real scenario;
   - add the missing adversarial scenarios in §9 below.

### M0 acceptance

M0 passes only when a reviewer can answer without inference:

- Which durable intent owns each stage?
- Which human/desk/worker actor may execute each decision?
- Which physical row stores each artifact?
- What happens to every existing FK consumer?
- What exact state changes when one asset is returned and another is signed?
- What exact cutover version changes writer authority?
- How is every legacy row classified?
- Which command and readback prove each transition?

## 8. Revised delivery sequence

The original M1–M5 order should be replaced with the following sequence.

### R0 — Contract closure

Complete M0 above. Documentation and design only. No Campaign production code.

### R1 — Domain and physical bindings behind a disabled fence

- add Campaign/Opportunity identities and versioned Brief/Evidence/Review contracts;
- bind Campaign to the retained physical asset subsystem;
- implement read models and migration classifier;
- leave legacy production authority unchanged;
- no new UI route creates Campaign production facts.

### R2 — Complete minimal Campaign vertical path behind the fence

- implement the three typed intent families or the approved equivalent;
- implement launch gate, bounded production, independent review and signoff gate;
- integrate one flagship/exemption and one platform asset;
- integrate current manual publication preparation;
- keep the cutover fence disabled in normal production.

### R3 — Real-data migration rehearsal

On a copied current data root:

- run classifier and migration;
- reconcile all row categories and dependent artifacts;
- run crash/replay/stale-revision cases;
- run the full vertical Campaign scenario;
- prove rollback to the pre-cutover copy because no new production authority has been activated.

### R4 — Atomic clean cutover

In one authorized milestone:

- activate Campaign writer authority;
- route UI/IPC/MCP/scheduler to Campaign commands;
- reject every legacy production write with stable cutover error;
- switch Today/Discovery/Studio/Results projections;
- preserve historical reads and quarantine.

No dual-write interval.

### R5 — Package acceptance and expansion

- verify real Windows packaged scenarios;
- add remaining platform assets and method loop breadth;
- retire obsolete UI/code only after the package proves no caller still depends on legacy writes;
- update canonical operator Skill for delivered behavior.

## 9. Missing adversarial acceptance scenarios

Add at least these scenarios to the design/specification acceptance matrix:

| ID | Scenario | Required proof |
| --- | --- | --- |
| CAM-A01 | new Signal with no Topic | one Opportunity; no raw Today card; atomic Topic+Campaign launch decision |
| CAM-A02 | non-human launch attempt | stable zero-write authorization rejection |
| CAM-A03 | crash between launch receipt and production intent | exactly one recovered production intent |
| CAM-A04 | evidence contradicts approved thesis | Brief stale; downstream writes fenced; new launch decision required |
| CAM-A05 | author tries to review own asset | dispatcher rejection with durable audit |
| CAM-A06 | three-asset partial signoff | independent signed/returned/excluded states and exact revision receipts |
| CAM-A07 | asset edited after review | affected review/signoff stale; unaffected independent asset behavior follows frozen policy |
| CAM-A08 | timely flagship exemption | succeeds only when exemption existed in approved Brief |
| CAM-A09 | legacy cardinality rehearsal | every source row classified; exact counts; zero unclassified rows |
| CAM-A10 | old writer after cutover | stable zero-write cutover-fence rejection from UI, IPC, MCP and scheduler |
| CAM-A11 | publication unknown | no published state; `unknown/needs_user` readback survives restart |
| CAM-A12 | incomparable method evidence | Keep rejected or downgraded to Test |
| CAM-A13 | workspace switch during production | old-root late writes rejected; new root remains isolated |
| CAM-A14 | package duplicate/claim drift fixtures | durable review findings identify exact assets/claims |
| CAM-A15 | existing publication/media/illustration history | all historical references resolve after migration |

## 10. Go/no-go checklist

Implementation is **GO** only when all boxes are true:

- [ ] current WMB-5367 scope remains unchanged;
- [ ] orchestrator amendment defines Campaign intent families and two gate projections;
- [ ] human-vs-desk authority law is explicitly revised and command-enforced;
- [ ] Topic binding rule handles new and legacy topicless objects;
- [ ] physical asset strategy is chosen and dependent FK domains are covered;
- [ ] Campaign/Asset/Decision FSMs are complete;
- [ ] cutover sequence has no production gap and no dual write;
- [ ] migration manifest reconciles the measured live categories;
- [ ] command schemas and stable errors exist in SPEC;
- [ ] adversarial acceptance matrix is complete;
- [ ] new implementation tasks are entered into TASKS only after the above contracts are approved.

Until then, the design remains an approved **product direction**, not an executable implementation contract.

## 11. Final verdict

**Product method:** pass.

**Architecture direction:** conditional pass.

**Migration design:** fail until P0-3, P0-4 and P0-5 are closed.

**Orchestration integration:** fail until P0-1 is closed.

**Authority model:** fail until P0-2 is closed.

**State/acceptance completeness:** fail until P0-6 and P1 findings are closed.

The shortest safe path is not to discard the design. It is to add the M0 closure milestone, preserve the current Actor implementation boundary, reuse the proven physical content subsystem under new Campaign authority, and perform one atomic writer cutover only after a full real-data rehearsal.
