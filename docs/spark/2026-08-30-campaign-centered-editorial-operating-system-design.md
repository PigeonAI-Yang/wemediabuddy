# WeMediaBuddy Campaign-Centered Editorial Operating System Design

- **Date:** 2026-08-30
- **Status:** Owner-approved product and architecture design; specification only, no implementation begins from this document
- **Core reference:** `docs/others/how-to-build-a-one-person-media-company-with-hermes-bots.md`
- **Product scope:** Re-center WMB around a self-compounding content-production method, not around the article's six-bot implementation pattern
- **Implementation authority:** `TASKS.md` remains the only construction permit and progress ledger

## 1. Decision

WeMediaBuddy will be re-centered from a collection of loosely connected source, planning, writing, platform-version and review flows into a **Campaign-centered editorial operating system for a one-person media company**.

The transformation is a product-core reset, not a Campaign page added over the existing ontology.

The new system will:

1. continuously capture important external signals, including new model releases, product changes, research, policy changes and audience questions;
2. turn selected signals into inspectable editorial opportunities rather than dumping raw information on the Owner;
3. organize long-term editorial accumulation under Topics;
4. run each bounded content action as a Campaign;
5. separate evidence, editorial angle, flagship expression, platform-native distribution and package review;
6. use two Owner gates: Campaign launch/angle approval and final package signoff;
7. let Agents automatically complete the bounded work between those gates;
8. feed publication results back into reusable Keep/Test/Stop editorial methods;
9. migrate existing business data into the new model and retire old write paths;
10. preserve manual final publication and all current workspace, dispatcher, grant and side-effect safety boundaries.

This design deliberately covers **content-production method only**. It does not add customers, qualified conversations, demand validation, products, services, sales or revenue as formal business objects.

## 2. Product thesis

Writing output is no longer the primary bottleneck. The scarce capability is the repeated editorial loop:

```text
signal → opportunity → evidence → angle → flagship expression
       → platform-native assets → package review → publication
       → performance review → updated editorial methods
```

WMB's accumulated advantage must therefore be the quality of its accepted editorial decisions, not the quantity of generated drafts.

A one-person media company is not defined by simulating six employees. It is defined by a system that can continuously:

- notice what matters;
- reject weak opportunities;
- build source-bound evidence;
- form a specific editorial claim for a specific reader;
- develop the deepest reusable expression of that claim;
- create different platform entryways rather than repeat one post;
- protect factual and tonal integrity across the package;
- learn from real results without converting one success into superstition.

## 3. Frozen Owner decisions

The following decisions were explicitly approved during design and must not be reinterpreted during implementation:

1. **Transformation depth:** re-center the WMB product core.
2. **Current scope:** content-production method only; no commercialization loop.
3. **Object hierarchy:** Topic governs Campaign.
4. **Signal boundary:** Topic is not a prerequisite for capturing new information.
5. **Owner approval model:** two gates — launch/angle approval and final package signoff.
6. **Primary surface:** Today remains the chief editor's desk; Campaign has a dedicated workroom.
7. **Content architecture:** flagship-first by default, with an explicit launch-time exemption for suitable Campaigns.
8. **Migration strategy:** in-place migration with a clean cutover; no permanent dual production system.
9. **Architecture approach:** Campaign becomes the authoritative aggregate root for one bounded editorial action.
10. **Agent organization:** preserve WMB's fixed role types; do not copy the source article's six-bot roster into the product ontology.

## 4. Goals and non-goals

### 4.1 Goals

- Make each publishable body of work traceable to an approved Campaign, Brief revision, Evidence Pack revision and editorial review.
- Preserve continuous intelligence capture and make its output actionable.
- Make Topic the durable home of a long-term question, editorial position, Campaign history and accepted methods.
- Make Campaign the sole production authority for one bounded editorial action.
- Prevent research, angle selection and writing from collapsing into one uninspectable generation step.
- Prevent platform adaptation from degrading into shortening or tone replacement.
- Keep the Owner focused on decisions, not raw-source processing or stage-by-stage supervision.
- Make failure, uncertainty, stale evidence and missing data truthful durable states.
- Make publication performance change future editorial behavior through controlled method proposals.
- Migrate all transports and workers to one Campaign domain without preserving legacy write paths.

### 4.2 Non-goals

This design does not add:

- customer, lead, conversation, demand, offer, product, service, sale or revenue objects;
- automated final publication;
- a visual multi-Agent choreography editor;
- a generic workflow engine, workflow DSL or arbitrary stage builder;
- six permanent Hermes-style bot identities;
- mandatory human approval at every internal stage;
- mandatory long-form flagship content for every Campaign;
- automatic permanent playbook changes from one result;
- a second database, microservice, multi-tenant backend or new transport;
- a replacement for current CommandEnvelope, dispatcher, task-grant or workspace authority architecture.

## 5. Authoritative business ontology

### 5.1 Signal

A Signal is an external fact or observation captured from a configured channel. Existing `source_items`, channel observations, source-body revisions and media/source provenance remain the underlying evidence identities.

A Signal answers:

- what happened;
- where it came from;
- when it happened;
- whether the source is available and verifiable.

A Signal is not automatically a Topic, Campaign or Today card.

### 5.2 Editorial Opportunity

An Editorial Opportunity is the durable result of judging one or more Signals for content value.

It answers:

- why the event may matter now;
- which reader problem it may address;
- what direct evidence exists;
- how quickly the opportunity will decay;
- whether WMB has a distinct editorial entryway;
- whether it belongs to an existing Topic;
- whether it justifies a new Topic or Campaign;
- why it should be watched or rejected when weak.

Allowed decisions:

- `rejected`
- `watching`
- `topic_update`
- `propose_topic`
- `campaign_candidate`

Raw Signals remain off Today unless they become an Owner-relevant Opportunity decision.

### 5.3 Topic

A Topic is the durable identity of a long-term question or editorial territory WMB intends to understand and potentially occupy.

A Topic owns:

- its long-term question;
- audience and editorial purpose;
- accepted sources and evidence relationships;
- viewpoint evolution;
- active, completed and rejected Campaigns;
- unresolved questions;
- accepted editorial methods;
- platform method summaries;
- proposed method changes awaiting approval.

A Topic is not required before a Signal can be captured. A new Signal can be routed to an existing Topic, propose a new Topic, create a short-lived Campaign under a broader Topic, remain watching or be rejected.

### 5.4 Campaign

A Campaign is the authoritative aggregate root for one bounded editorial action.

It owns:

- one Topic relationship;
- Campaign type;
- timeliness and decay boundary;
- target reader and reader outcome;
- central tension and thesis;
- required proof;
- flagship strategy or approved exemption;
- target platforms;
- all Evidence Packs, Brief revisions, content assets, package reviews, signoff decisions, publication bindings and performance reviews;
- current phase, status, revision, causation and recovery point.

A Campaign is not a generic project. It exists only to take a defined editorial opportunity through evidence, expression, distribution, review and learning.

### 5.5 Evidence Pack

An Evidence Pack is a versioned, source-bound research artifact. It records:

- the current event creating urgency;
- verified claims;
- inference;
- contradictions;
- unsupported claims;
- unknowns;
- quotations or timestamped clips;
- source links and revisions;
- mechanisms worth explaining;
- what the evidence does not prove.

Evidence Packs do not own headlines, sensational claims or the final editorial thesis.

### 5.6 Angle Brief

The Angle Brief is the Campaign's versioned editorial contract. It records:

- reader;
- reader outcome;
- current source or urgency;
- central tension;
- thesis;
- what becomes possible;
- flagship format;
- reusable object;
- proof required;
- sections or narrative architecture;
- platform entryways;
- flagship exemption when applicable;
- scope, expiry and stop conditions.

Owner launch approval freezes one exact Brief revision. A material change requires a new revision and renewed approval.

### 5.7 Content Asset

A Campaign contains one or more formal Content Assets:

- `flagship`
- `platform:x`
- `platform:xiaohongshu`
- `platform:wechat`
- `platform:zhihu`
- other explicitly registered product asset types

Every asset has its own identity, purpose, platform entryway, independent reader value, immutable versions, media bindings, Brief/Evidence references, review state and signoff state.

Platform assets may reference the flagship, but their authoritative creative basis is the shared Angle Brief and Evidence Pack. WMB must not encode mechanical derivation from the flagship as the product contract.

### 5.8 Editorial Review

An Editorial Review freezes a complete set of asset revisions and checks them together for:

- unsupported or newly introduced claims;
- evidence drift;
- repeated hooks, openings or arguments;
- platform assets with no independent value;
- Angle Brief drift;
- tone mismatch;
- stale evidence;
- mismatched calls to action;
- unapproved flagship exemption;
- unresolved Owner risk.

An asset revision created after the review invalidates that review for the changed package.

### 5.9 Performance Review and method proposal

A Performance Review references real publication records and metric snapshots. It produces:

- `keep`
- `test`
- `stop`
- `insufficient_evidence`

A method change is first a proposal. Agents cannot permanently update Topic or platform methods from one result.

## 6. Product flow

### 6.1 Intelligence flow

```text
captured Signal
  ↓ deduplicate, verify source, assess freshness
assessed Opportunity
  ├─ rejected
  ├─ watching
  ├─ update existing Topic
  ├─ propose new Topic
  └─ propose Campaign
```

Important new model releases, research, policies and product changes continue to be captured even when no Topic exists. Topic membership is a routing decision, not an intake gate.

### 6.2 Campaign lifecycle

```text
draft_proposal
  ↓
awaiting_launch_approval
  ├─ rejected
  ├─ deferred
  ├─ expired
  └─ approved
       ↓
researching
       ↓
angle_locked
       ↓
producing
       ↓
package_review
       ├─ revision_required
       └─ passed
            ↓
awaiting_signoff
            ├─ revision_required
            ├─ partially_signed_off
            └─ signed_off
                 ↓
ready_for_manual_publish
                 ↓
published_partially / published
                 ↓
observing
                 ↓
reviewed
                 ↓
completed
```

`needs_user` is a cross-phase blocking condition with an exact reason and recovery point. It never means success.

### 6.3 Owner gate 1: launch and angle approval

The Owner approves one exact Brief revision containing:

- Topic;
- why now;
- target reader;
- reader outcome;
- central tension;
- provisional thesis;
- consequential proof requirements;
- flagship form or exemption;
- target platforms;
- timeliness and stop conditions.

After approval, Agents may improve ordinary structure and wording within scope. The following require a new Brief revision and renewed approval:

- changing the target reader;
- changing the central thesis;
- materially changing the reader outcome;
- expanding target platforms;
- changing flagship strategy;
- continuing after the approved timeliness boundary;
- adopting a claim contradicted by new research.

### 6.4 Automatic production between gates

After launch approval, WMB automatically advances bounded work:

```text
complete Evidence Pack
→ lock working Angle Brief
→ create flagship or verify exemption
→ create platform-native assets
→ review the complete package
→ present signoff package
```

Each stage has:

- exact input revisions;
- exact output artifact;
- role owner;
- done condition;
- failure reason;
- referenced job/task identity;
- next-stage precondition.

A missing field returns the work to the responsible stage. The next role must not fill gaps with plausible assumptions.

### 6.5 Owner gate 2: package signoff

The Owner receives:

- flagship asset or approved exemption;
- all platform assets;
- consequential claim/source mapping;
- platform entryway and independent-value statements;
- editorial review findings;
- unresolved risks;
- proposed publication order.

The Owner may:

- sign off the complete package;
- sign off selected assets only;
- return specific assets;
- reject the Campaign;
- defer for timing or evidence.

Final platform publication remains manual.

## 7. Campaign types

### 7.1 Flagship Campaign

Used for deep methods, guides, major product judgments and durable explanations.

Requires:

- complete Evidence Pack;
- approved Angle Brief;
- flagship asset;
- one or more platform-native assets when platforms were approved;
- package review;
- Owner signoff.

### 7.2 Timely Campaign

Used for high-decay opportunities such as major model releases or urgent changes.

May omit a long-form flagship only when the launch approval records:

- explicit exemption;
- reason;
- timeliness boundary;
- at least one complete formal asset;
- narrower evidence and platform scope.

A failed flagship cannot be retroactively relabeled as an exemption.

### 7.3 Experimental Campaign

Used to test an angle, form or platform entryway.

Requires:

- a specific hypothesis;
- constrained assets and cost;
- a defined result to observe;
- a Performance Review that can create `test`, `stop` or `insufficient_evidence` but not automatically create a permanent `keep` rule.

All three types share one Campaign ontology and state model. They differ only in approved requirements and budgets.

## 8. Fixed-role responsibilities

WMB preserves its fixed cross-lane role types.

| Role | Campaign responsibility | Must not do |
| --- | --- | --- |
| Reporter | capture Signals, assess source truth, construct Evidence Packs, perform bounded successor research | approve thesis, silently fill missing evidence, publish |
| Strategist | judge Opportunities, draft Angle Briefs, conduct independent package review, prepare Performance Reviews | publish, approve its own Owner gates, rewrite unsupported claims as facts |
| Writer | create flagship and platform-native assets from approved Brief/Evidence revisions | change Campaign scope, alter proof requirements, organize Topic truth |
| Librarian | integrate accepted evidence, completed Campaign history and approved methods into Topic knowledge | select Campaign thesis, write primary assets, approve methods |
| Desk/Supervisor | validate stage prerequisites, issue bounded tasks, advance lifecycle, surface two Owner gates and truthful blockers | become a generic workflow engine, approve Owner decisions, publish |

Distribution and editing are task capabilities, not new permanent roles:

- platform distribution is performed by Writer tasks with separate platform briefs;
- complete-package review is performed by an independent Strategist task;
- the same active instance may not author an asset and approve the package containing that asset.

## 9. User experience and page responsibilities

### 9.1 Today: chief editor's desk

Today contains only:

1. `awaiting_launch_approval` Campaign proposals;
2. `awaiting_signoff` Campaign packages;
3. `needs_user`, expiring or failed Campaign decisions;
4. high-value read-only progress the Owner must know.

It does not contain raw Signals, ordinary worker progress, retry streams, internal stage boards or piles of unjudged sources.

### 9.2 Discovery

Discovery contains:

- captured Signals;
- source status;
- Opportunity assessment;
- rejection and watching reasons;
- routing to Topic or Campaign proposal.

Discovery is the front line, not the approval desk.

### 9.3 Topic

Topic contains:

- long-term question and editorial purpose;
- source/evidence relationships;
- active and historical Campaigns;
- unresolved questions;
- accepted Keep/Test/Stop methods;
- proposed method changes.

### 9.4 Campaign workroom

The Campaign workroom is a structured editorial case file, not a generic Kanban:

- Overview
- Research
- Angle
- Flagship
- Distribution
- Review
- Performance

It shows durable artifacts, decisions and traceability rather than Agent chat transcripts.

### 9.5 Studio

Studio ceases to be an independent business center. Its editor, media, annotation, illustration and platform-preview capabilities become asset-working capabilities inside a Campaign.

### 9.6 Publication and Results

Publication receives an exact signed-off asset revision and preserves current manual-final-publish boundaries.

Results are read and reviewed within the owning Campaign. A standalone Results page may remain as a cross-Campaign read model, but it cannot become a second review truth.

## 10. Logical data model

The design requires the following logical identities. Physical schema may use equivalent normalized tables, but it must preserve versioning, foreign-key, revision and uniqueness semantics.

### 10.1 Editorial Opportunities

`editorial_opportunities` stores:

- identity and workspace;
- source/observation bindings;
- event, urgency and audience question;
- evidence maturity;
- proposed Topic;
- decision and rejection/watching reason;
- decay time;
- revision and causation.

It references source truth rather than copying full source bodies.

### 10.2 Campaign aggregate

`campaigns` stores stable identity and current authority:

- Topic;
- type;
- phase and status;
- current Brief and Evidence revisions;
- launch/signoff decision references;
- timeliness and stop reason;
- current responsibility;
- revision and lifecycle timestamps.

### 10.3 Versioned artifacts

Logical stores:

- `campaign_brief_versions`
- `campaign_evidence_packs`
- `campaign_evidence_claims`
- `campaign_evidence_source_bindings`
- `campaign_assets`
- `campaign_asset_versions`
- `campaign_editorial_reviews`
- `campaign_editorial_review_items`
- `campaign_performance_reviews`
- `topic_method_proposals`

Approved/reviewed artifact versions are immutable. New work creates a successor version.

### 10.4 Existing infrastructure retained

The following remain authoritative in their current domain:

- source identities and source-body revisions;
- Topic identity;
- assets, provenance and media bindings;
- publications, confirmations and metric snapshots after rebinding to Campaign asset revisions;
- Agent tasks, grants and object boundaries;
- CommandEnvelope, dispatcher, receipts and audit;
- ActiveWorkspaceRuntime and workspace isolation;
- BrowserProfile binding and manual publication safety.

## 11. Command and authorization boundary

All mutations continue through:

```text
Owner UI / Pi / external Agent / scheduler
                    ↓
             CommandEnvelopeV1
                    ↓
                dispatcher
                    ↓
             Campaign domain
```

Representative product commands:

- `opportunity.assess`
- `campaign.propose`
- `campaign.approve_launch`
- `campaign.reject_launch`
- `campaign.save_evidence_pack`
- `campaign.save_brief_revision`
- `campaign.save_asset_version`
- `campaign.submit_package_review`
- `campaign.request_asset_revision`
- `campaign.signoff_assets`
- `campaign.defer_signoff`
- `campaign.bind_publication_result`
- `campaign.complete_performance_review`
- `topic.propose_method_update`
- `topic.approve_method_update`

Agent writes remain limited by task grant ∩ role capability ∩ exact Campaign/object boundary. Final publish, hard delete and external-platform side-effect red lines remain unchanged.

## 12. Orchestrator boundary

The workspace orchestrator may:

- accept an approved Campaign intent;
- dispatch product-defined stage tasks;
- validate prerequisite artifacts and revisions;
- resume interrupted work;
- project Owner gates and truthful blockers to Today;
- advance only when the current state and revisions match.

It must not:

- allow arbitrary user/model-defined stages;
- become a workflow editor;
- treat chat narration as state;
- invent Campaign scope;
- approve launch, signoff or permanent method changes;
- automate final publication.

## 13. Migration and clean cutover

### 13.1 Retained and enriched

- `source_items` remain source truth and Signal evidence.
- `topics` retain identity and gain long-term question/method capabilities.
- assets, source revisions, media archive/provenance and knowledge facts remain.
- dispatcher, grants, jobs, workspace runtime and browser safety remain.

### 13.2 Deterministic mapping

| Legacy object | New meaning |
| --- | --- |
| `plan_items` | Opportunity decision plus initial Campaign Brief revision |
| `content_projects` | migration source for Campaign and assets |
| `content_versions` | flagship asset versions |
| `platform_versions` | platform asset versions |
| `content_project_sources` | Evidence/source bindings |
| `reviews` and `method_findings` | Campaign Performance Reviews and Topic method candidates |
| `publications` and metric snapshots | bindings to exact Campaign asset revisions |
| `work_carry_items` | retired; replaced by Campaign/Topic Today projections |
| daily `plans` | historical run/batch context, no longer the production center |

Unlinked historical drafts become `imported` Campaigns. Migration must preserve their original timestamps, sources and authorship, mark absent evidence/approval as `legacy_unknown`, and never fabricate a complete modern Campaign history.

Rows that cannot be mapped uniquely enter migration quarantine with the original object intact and a precise reason.

### 13.3 Cutover invariant

After migration:

- UI, IPC, Pi, external MCP and scheduler create only Campaign-domain production facts;
- legacy production commands are removed from the dispatcher;
- legacy tables may remain only for bounded historical read or migration audit;
- no compatibility shim may maintain two writable production authorities;
- the old Studio, planning and Results surfaces are retired or redirected to Campaign read/write models.

## 14. Failure and recovery semantics

| Failure | Required durable result |
| --- | --- |
| Signal fetch failed | Signal/source attempt remains failed or unavailable; no verified Opportunity is fabricated |
| Evidence insufficient | Campaign remains researching or `needs_user`; missing claims are explicit |
| Evidence contradicts thesis | approved Brief becomes stale; downstream production stops; new launch approval required |
| One platform asset fails | package records the missing asset; Owner may exclude, return or wait |
| Flagship fails | Flagship Campaign cannot complete; no retroactive exemption |
| Review finds drift/repetition | exact asset revisions return to responsible stage |
| Timeliness expires | Campaign becomes expired; a timeless reframing requires new approval |
| Agent/runtime restarts | resume from durable artifact and revision, never from guessed chat state |
| Publication cannot be confirmed | publication remains unknown or `needs_user`, never silently published |
| Metrics unavailable | Performance Review becomes `insufficient_evidence` |
| Migration mapping ambiguous | quarantine; preserve original object; no fabricated relationship |

## 15. Editorial method governance

### 15.1 Keep

A Keep proposal requires:

- support across at least two Campaigns;
- comparable angle, structure or platform entryway;
- directionally consistent results;
- no obvious exceptional factor sufficient to explain the result alone;
- explicit applicability conditions.

### 15.2 Test

A Test proposal is appropriate for:

- one strong result;
- first positive signal for an entryway;
- promising but weak evidence;
- conflict with an accepted method;
- a new flagship or platform form.

It must define where and how the next Campaign will retest it.

### 15.3 Stop

A Stop proposal is appropriate when a pattern:

- repeatedly underperforms;
- produces duplicated platform assets;
- costs more than its additional value;
- repeatedly lacks evidence;
- conflicts with platform consumption behavior;
- has been invalidated by new facts.

All Topic or platform method changes require explicit approval.

## 16. Acceptance criteria

### AC-1: New information remains capturable

Given a significant official model release with no existing matching Topic, WMB:

- captures the original source;
- creates an Opportunity with evidence, urgency and audience question;
- can route it to an existing Topic, propose a new Topic, propose a timely Campaign, watch it or reject it;
- does not put the raw Signal on Today without an editorial decision.

### AC-2: Two Owner gates work

After the Owner approves a Campaign Brief:

- bounded research, asset creation and package review progress without stage-by-stage Owner clicks;
- material scope/thesis changes return to launch approval;
- only the complete package or a truthful blocker reaches signoff.

### AC-3: Platform assets are native, not mechanical rewrites

For one Campaign with X, Xiaohongshu and WeChat assets:

- each asset records a distinct entryway and independent value;
- all share the approved Brief/Evidence basis;
- package review detects repeated openings/arguments and unsupported new claims;
- each asset adds value for a reader who has consumed another asset.

### AC-4: Flagship exemption is controlled

A timely Campaign may omit a long-form flagship only when the approved launch revision contains the exemption, reason, timeliness and at least one required complete asset. Production failure cannot create an exemption.

### AC-5: Results change future editorial methods

After real publication and metric readback:

- review references exact publication and metric snapshots;
- one result can create Test, Stop or insufficient evidence, but not automatic permanent Keep;
- approved method changes become available to later Campaign Briefs.

### AC-6: Clean cutover

After migration:

- no product transport creates the legacy plan-item/content-project production chain;
- every new formal asset traces to Campaign, Brief revision, Evidence revision and review;
- historical data remains readable;
- ambiguous history is not fabricated;
- `work_carry_items` no longer owns long-term attention semantics.

### AC-7: Safety does not regress

- all writes pass the dispatcher;
- Agent writes cannot cross Campaign boundaries;
- approved revisions cannot be silently replaced;
- final publication remains manual;
- workspace switch/restart cannot write Campaign work into another root.

## 17. Delivery milestones

### M1: Campaign domain truth and migration contract

- define Opportunity, Campaign, Brief, Evidence, Asset and Review domain contracts;
- add durable schema, commands and read models;
- define deterministic legacy mapping and quarantine;
- prove migration is replay-safe and does not duplicate identities;
- keep current user path temporarily unchanged.

### M2: Signal → Opportunity → launch gate

- normalize channel output into Opportunity assessment;
- implement Reporter and Strategist intake responsibilities;
- show formal Campaign proposals on Today;
- support Topic progress and new-Topic proposals;
- stop creating new formal production objects through the old daily planning path.

This is the first user-visible slice of the new method.

### M3: Campaign workroom and automatic production

- deliver Research, Angle, Flagship, Distribution and Review workroom sections;
- run fixed-role tasks under a frozen approved Brief;
- enforce Campaign-type requirements;
- embed Studio capabilities inside Campaign assets;
- deliver the package signoff gate.

### M4: Publication, performance and method loop

- send signed-off asset revisions to existing manual publication preparation;
- bind publication and metrics to Campaign assets;
- deliver Keep/Test/Stop review;
- approve Topic/platform method changes;
- make accepted methods available to future Campaigns.

### M5: Full migration and legacy retirement

- migrate historical objects in place;
- cut UI, IPC, MCP, scheduler and Skills to Campaign commands;
- remove legacy write commands and obsolete surfaces;
- update `PRODUCT.md`, `PRD.md`, `SPEC.md`, `TECHNICAL_DESIGN.md` and the canonical WMB operator Skill;
- verify AC-1 through AC-7 in a current Windows package;
- close migration only after proving there is no second writable production truth.

## 18. Required specification consequences

Before implementation tasks are authorized, the approved design must be propagated into the normative product contracts:

1. revise `PRODUCT.md` so the primary lifecycle becomes Signal → Opportunity → Topic/Campaign → Evidence → Angle → Assets → Review → Publication → Method;
2. revise `PRD.md` requirements and acceptance criteria around Campaign authority and two Owner gates;
3. revise `SPEC.md` with precise command, schema, status, revision and migration contracts;
4. revise `TECHNICAL_DESIGN.md` with module ownership and dispatcher routes;
5. reconcile the existing workspace-orchestrator design so it advances approved Campaign intents rather than becoming a second business ontology;
6. add separately authorized implementation tasks to `TASKS.md` in milestone order;
7. update the canonical operator Skill only when the delivered observable workflow changes.

This design does not itself authorize those edits or any implementation.

## 19. Completion statement

The transformation is complete only when WMB can answer, from durable business facts:

1. What happened outside that is worth attention?
2. Which opportunities deserve a Campaign, and why?
3. Which Topic does the Campaign advance?
4. What reader, outcome, tension, thesis and evidence contract did the Owner approve?
5. Did Agents produce a deep flagship or approved exemption and genuinely distinct platform assets?
6. What exact package does the Owner need to sign off?
7. What real publication results changed the next Campaign's editorial methods?

If WMB only adds six named Agents, a Campaign board or more generated platform variants, this design has not been delivered.
