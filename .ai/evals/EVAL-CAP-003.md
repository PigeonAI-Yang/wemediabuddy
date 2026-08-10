# EVAL-CAP-003

- Capability: Topics and daily plans — one current plan per date with fully-shaped items (title, priority, whyNow, timeliness, audience, angle, pointOfView, platforms/formats, guidance, effort, cited source_ids, materials, topic/review/method-finding links); rolling opportunity pool reads across dates with truthful termination.
- Tasks: WMB-4910 (editorial brief assembly), WMB-4911 (four-question judgment mandate), WMB-4914 (opportunity pool semantics + dismiss path); earlier plan foundations (M-200 chain) unchanged.
- Preconditions: seed DB with sources, plans across dates, carry rows, projects, publications.
- Steps:
  1. Save plans on two dates and confirm exactly one current plan per date; items keep all required fields and validate real sourceIds.
  2. Assemble the editorial brief and confirm identity/history/inventory/increment blocks with bounded SQL.
  3. Confirm the judgment prompt carries the four-question mandate and knowledge-context-first rule.
  4. Read the opportunity pool and confirm adopted (project-linked), dismissed, expired-carry, and timeliness-expired items are excluded; evergreen items are not recency-bound.
  5. Dismiss a non-seeded plan item and confirm a dismissed fingerprint row is written and reseeding never revives it.
  6. Publish on a topic and confirm same-topic pool items demote to the tail with annotation within 24h.
- Expected observable results: pool membership equals "unterminated" exactly; dismiss is permanent against reseeding; plan validation unchanged (real sources, current-per-date).
- Command evidence: `tests/opportunity-pool.test.mjs` → 5 passed (union/termination, no-revive, demotion, expired-carry, getToday pool); `tests/editorial-brief.test.mjs` → 5 passed; `tests/agent-runner.test.mjs` → 3 passed; full suite `npm test` → 295/295; `npx tsc --noEmit` → clean; `node scripts/check-ledger.mjs` → PASS after this file.
- Manual/live evidence: none required for this capability slice (unit/fixture coverage with real SQLite; UI projection lands in WMB-4915).
- Result: pass
- Failure reason: none.
- Pi operator Skill impact: updated at WMB-4911 — brief/four-question/knowledge-context mandate added to operator Skill.

## WMB-5150 / EVAL-031 — Topic maintenance approval (2026-08-10)

- Capability slice: librarian submits frozen topic-maintenance proposals; Owner approves/rejects in Topic ledger; approval applies atomically; stale proposals zero-write; agents can never apply.
- Preconditions: real SQLite fixture with duplicate topics 「Agent 工作流」「Agent工作流方法」, plus linked source_items/plan_items/content_projects/work_carry_items/knowledge_canvases/knowledge_domain_topics/reviews chain.
- Steps:
  1. Create a merge proposal; assert formal topics and all relations remain byte-identical (zero write before decision).
  2. Reject the proposal; assert status `rejected` and every topic/link revision unchanged.
  3. Re-propose and approve; assert one atomic apply: old topic `archived`, source links/plan items/content projects/work-carry items/canvases/domain topics and the review-derived project all point at the retained topic, and zero formal references remain on the merged topic.
  4. Concurrent revision change before approve (topic updated, relation membership changed, or topic deleted) → status `stale` with zero partial write.
  5. Invalid merge graphs (self-merge, duplicate source, cycle/contradiction) fail closed at proposal time.
  6. Role gate: librarian receives `knowledge.topic_maintenance_propose`; desk/planner/librarian never receive `knowledge.topic_maintenance_approve/reject` (Owner-only, `agentGrantable:false`).
  7. Topic page renders the full proposal ledger; Today projects the pending count; desk prompt and Pi operator Skill instruct 呈报待批 and forbid pushing manual editing back to Owner.
- Expected observable results: `topic_maintenance_proposals` rows transition `proposed → approved/rejected/stale` with revision bumps and `decided_at`; approval happens inside one savepoint; any failure rolls back to zero domain writes; no agent role can reach the decision commands (no MCP registration, no task grant).
- Command evidence: `tests/wmb-5150-topic-maintenance.test.mjs` → 5/5 pass; full `npm test` → 670/670; typecheck, capability, intake, ledger, lightweight harness, package, renderer smoke and diff checks pass.
- Pi operator Skill impact: updated — propose/list/get playbook + 呈报待批 rule registered; canonical, both data-root mirrors and regenerated package resource carry revision `a0ed3996344a3ef79f7e0f0618abbb9fa2e011a9aad059737966086e822241f6`.
- Manual/live evidence: `.ai/wmb-5150-ui-acceptance.mjs` on an isolated data root proves full expanded frozen diff, enabled Owner decision, no inner/document horizontal overflow at 1440 and 1100, and Today pending entry; screenshots and complete receipts are in `.ai/wmb-5150-evidence.md`.
- Result: pass.
- Failure reason: none; initial independent-review findings were fixed and the final rereview passed.

## WMB-5158–5160 / EVAL-031 closure — Precise conflict, durable reproposal and separate ledger page (2026-08-10)

- Proposal generation persists one v2 conflict contract; approval consumes that contract and ignores unrelated graph drift. True result-changing conflict atomically writes stale evidence plus one durable reproposal job and performs zero formal topic writes.
- The durable job keeps one logical `job_id`, rotates `run_id` per attempt/resume, freezes at `maxWorkers=0`, retries with bounded delay, survives cold start and permits at most one successor. The stale parent never revives or auto-applies.
- Topic home contains only search, status filters and the adjacent `整理台账` entry. The separate ledger page shows current approvals, automatic reproposal, exhausted recovery and history; only exhausted recovery exposes `重新交给资料员`, which requeues the same durable job without approving the old proposal.
- Canonical operator Skill plus desk/librarian prompts require automatic latest-fact reproposal with `supersedesProposalId` and forbid asking the Owner to edit topics manually.
- Command evidence: `tests/wmb-5150-topic-maintenance.test.mjs` 13/13, `tests/wmb-5152-topic-approval-ui.test.mjs` 6/6, combined UI/Skill 12/12, full `npm test` 685/685, typecheck/capability/lightweight/smoke PASS.
- Live evidence: isolated Electron proved no ledger on Topic home, `整理台账` immediately follows filters, exhausted recovery changes `needs_user → pending` with attempts reset to 0 and stable jobId, Back returns to Topic, DPR=1 and no horizontal overflow. A second isolated Electron flow proved approve→stale/pending→successor→Owner approve→archived with completed outbox and exact successor link.
- Result: pass.
