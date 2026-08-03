purpose: Discover opens persisted X List knowledge immediately and contacts X only for an explicit fresh read.
fails-when: Opening or remounting X Lists starts the shared browser, calls the live index reader, or hides an existing root-local cache.

Loop: WMB-4105
Symptom: Restarted X Lists repeatedly showed a read prompt and behaved as if no cache existed.
Observation packet: The UK-root DB had an 8-List index plus timeline cache; packaged `getCachedXListIndex` still took about 18.5 seconds.
Hypotheses: Cache IPC incorrectly resolved a live X context and renderer mount unconditionally revalidated.
Bug type: side-effect/timing.
Chain traced: SQLite cache -> cached IPC -> XListsView mount -> selected binding -> timeline cache -> DOM.
Breakpoint: Cache-only reads called `currentXListContext`; mount called `readXListIndex` after cache load.
Root cause: Cached display and live identity validation were conflated.
Files changed: X List IPC cache boundaries, renderer mount effect, focused regression, operator Skill.
Before/after gate: Packaged cache read 18.5s -> 7.9ms; remount 413ms, live index calls 0, 8 Lists and 20 cached posts visible.
Owner check: Explicit refresh and every external mutation still perform live identity/account validation; cached state stays data-root/account labeled.
Result: X Lists is restart-persistent and cache-first.
State update: complete.
Clean completion: yes.
Blocked reason: none; the touched renderer file remains a pre-existing oversized source and this task reduced rather than expanded it.
