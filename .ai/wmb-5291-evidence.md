# WMB-5291 — Deep-research-backed investigation reporter

## Delivered

- Added the project-owned `skills/deep-research/` Skill.
- The Skill requires active web search, opening and reading source pages, claim-specific source selection, counterevidence, authentic independent cases, preserved scope qualifiers, and honest `unresolved` / `source_unavailable` outcomes.
- Search snippets, titles, model memory, and unread URLs are explicitly excluded from evidence.
- The research Pi runtime now starts with `--skill <canonical-or-packaged>/deep-research` through the same packaged-skill resolver used by WMB Pi skills.
- The discovery prompt now requires `wmb_search_web`, then `wmb_read_web_page` for every selected web candidate, plus supporting and contradicting/limiting searches for each claim.
- Candidate URLs are still fetched again by the machine runner and written through `dispatchSourceUpsertBatch`; only successful Source SSOT readback receives a `sourceId`.
- Existing budgets, reporter read-tool whitelist, single-round limit, evidence thresholds, two Owner approvals, writer gate, and publication boundary remain unchanged.

## Verification

- `node --test tests/wmb-5172-research-runner.test.mjs` — PASS, 22/22.
  - Includes `WMB-5291: research runtime mounts the packaged deep-research skill`.
  - Confirms Skill content, runtime `--skill` wiring, provider/model arguments, prompt whitelist, structured candidate/claim contracts, source write idempotence, evidence thresholds, and truthful unavailable/unresolved behavior.
- `npm run typecheck` — PASS.

## Operational boundary

This change guarantees that future project-investigation reporter Pi processes are explicitly equipped and instructed to perform public-web research. It does not claim that any prior investigation run used the new Skill; rerunning a reporter task is required to generate new evidence under this contract.

## Live-run trace — project `9f90156d-a25c-49c4-b308-54d946667dea`

- Active workspace DB: `J:\PigeonYang\WeMediaBuddyData\wmb.db`; inspected version `f02e52db-b833-41c3-a56c-25419de31022` (version 4, `2026-08-16T02:46:04.008Z`).
- Project relation truth contains only source IDs `1569111c-a15d-4a74-9e6c-c6db6581b5e1` and `753a98e3-4dfb-41d2-95db-5e5bae3aed00`. The version-4 body cites five X URLs.
- The three additional cited records (`8132ffbe-9bab-4de2-98dc-2745673c0bd2`, `d504143d-a684-45e1-9aca-5bb637cea577`, `6b3e2225-c5a5-43ac-bc98-a232d6b055af`) predated this writing run and came from `intelligence_channels.x_scan_commit`; they were not created by project investigation.
- There is no `project_investigations` row and no `investigation_packages` row for this project. Therefore no project-investigation reporter ran and `deep-research` was not mounted for this execution.
- Writer task `bfa1cc95-72be-4056-8718-66443ceee8a8` reported a bounded inline research attempt (`planned=8`, `processed=8`, `verified=4`, `failed=4`, `saved=0`) and then failed on Pi timeout. Its event explicitly states that new web evidence could not be saved because the `studio_draft` grant only permitted `content.save_version`.
- The manager then spawned job `d672630d-41dc-445b-b2d0-0433bb9509b3` with role `reporter`, but ordinary role routing resolved it to `daily_scan`, not the `research` intent. This did not create an evidence package or project source linkage.
- The succeeding writer job `b5e5f9b2-fb05-403f-a963-d154d2ea85ab` was explicitly instructed: `只执行写作与保存，不再联网搜索、不保存资料`. Its only business write was `content.save_version`; it reused five existing WMB records named in the brief.
- Automatic project association currently occurs when a real investigation reporter reaches terminal state with an EvidencePack: `recordInvestigationReporterTerminal()` calls `linkPackageSourceIds()` before persisting `investigation_packages`. `content.save_version` neither accepts source IDs nor updates `content_project_sources`.

## Diagnosis

This run did not exercise the WMB-5291 deep-research path. It used an inline `studio_draft` research attempt, a misrouted ordinary reporter/daily-scan job, then a write-only Studio task using pre-existing sources. The article is evidence-informed, but its project source relation is incomplete. The integration gap is the handoff: Studio/evidence-grounded writing does not reliably invoke the `research` successor route, and core-version saving cannot reconcile source IDs used by the manuscript.
