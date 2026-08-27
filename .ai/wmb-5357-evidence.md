# WMB-5357 evidence — knowledge flywheel and approval repro

Date: 2026-08-28

Command:

`node --test --test-concurrency=1 tests/wmb-5357-knowledge-flywheel-repro.test.mjs`

Result: 4 pass / 0 fail.

Confirmed failures in the current production mechanism:

1. A Source without an existing `topic_source_links` row produces zero `knowledge.compile_source` operation and zero knowledge receipt.
2. Adding the Topic relation later through `recordKnowledgeBatch()` does not schedule compilation for the unchanged Source revision.
3. Adding identity/Topic information after the Planner watermark does not reactivate an older Source because `assembleEditorialBrief()` selects only `collected_at > watermark`.
4. Complete plan fields are persisted (`angle`, `point_of_view`, `target_audience`, `structure_guidance`, `source_ids_json`), but the approval list invokes `Opportunity` without `primary`, selecting its compact DOM branch.

No production code was changed for this repro task.
