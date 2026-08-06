# EVAL-CAP-014

- Capability: Built-in Pi executor — pinned Pi runtime with verified RPC startup; Pi uses only WMB-configured protocol/Base URL/API key/model; task-bound automatic grants; operator and lane Skills guide workflows.
- Tasks: WMB-4910-4911 (brief + four-question prompt), WMB-4913 (incremental watermark), WMB-4915 (carry refresh via dispatcher, anti-flail whitelist, authoritative cancel), WMB-4916 (nativeSearch flag + deep-dive gating); earlier executor foundations (M-1000, M-4600, WMB-4905) unchanged.
- Preconditions: AI root with an active Pi preset; a running daily judgment task.
- Steps:
  1. Build the daily judgment prompt and confirm the brief (identity/history/inventory/increment) plus the four-question mandate and the 9-tool whitelist.
  2. Confirm the whitelist names only tools registered in `.pi/extensions/wmb-mcp/` (incl. wmb_get_workbench/wmb_save_plan/wmb_get_knowledge_context/wmb_get_agent_task).
  3. Confirm judgeWatermark is written only after synthesis success and inherited across tasks via readLatestJudgeWatermark.
  4. Confirm carry refresh executes through the dispatcher in production (WMB_WRITE guard) and the brief itself is read-only.
  5. Confirm nativeSearch roundtrips through config save/update with preserve-on-undefined and gates prompt rule 9.
- Expected observable results: judgment prompt is self-contained and tool-safe; no direct writes outside dispatcher; grants stay task-bound (WMB-4905 contract intact).
- Command evidence: `tests/agent-runner.test.mjs` → 3 passed (brief blocks, watermark inheritance, nativeSearch branches); `tests/editorial-brief.test.mjs` → 5 passed; `tests/pi-config.test.mjs` → 7 passed (incl. nativeSearch roundtrip); `tests/pi-operator-install.test.mjs` → 4 passed; `tests/daily-scan-scheduler.test.mjs` → 5 passed; full suite 301/301; `npx tsc --noEmit` → clean.
- Manual/live evidence: real Pi session `daily-2026-08-06-1f62a2dc` proved extension tools live (wmb_get_current_workspace/wmb_list_workspaces succeed); tool-hallucination flailing observed and addressed via rule 8 whitelist + Skill anti-hallucination directives; clean completion of a full judgment under the hardened prompt is the WMB-4917 acceptance target.
- Result: pass
- Failure reason: none for the executor contract itself; full-cycle live completion tracked by WMB-4917.
- Pi operator Skill impact: updated — anti-hallucination whitelist and brief-first guidance added to wemedia-buddy-operator and wemedia-intelligence-engine.
