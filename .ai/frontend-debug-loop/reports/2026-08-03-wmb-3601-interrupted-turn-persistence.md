purpose: Keep a submitted Pi exchange visible across restart, including completed output already committed by Pi.
fails-when: The same cold restart returns an older conversation snapshot than its canonical session.

Loop: wmb-3601-interrupted-turn-persistence
Symptom: The final user message and interrupted reply disappeared after restart.
Observation packet: The exact user text and following assistant/tool entries existed in the active Pi JSONL; the active conversation snapshot and DOM stopped earlier.
Hypotheses: New-format segmented snapshots bypassed session reprojection; supported by a focused failing cold-read test and the live files.
Bug type: timing-stale.
Chain traced: Pi JSONL -> conversation cold read -> IPC -> renderer messages -> DOM.
Breakpoint: `readConversationFile` trusted stale segmented JSON; `pi:chat` persisted only after settlement.
Root cause: Format presence was incorrectly used as freshness, and no pre-await pending turn was durable.
Files read: `src/main/pi-conversation.ts`, `src/main/pi-persistence.ts`, `src/main/ipc-pi-dock.ts`, real conversation/session files.
Files changed: `src/main/pi-conversation.ts`, `src/main/ipc-pi-dock.ts`, `tests/pi-conversation.test.mjs`.
Before/after gate: before exact user text absent from DOM; after cold packaged restart exact text and eight following assistant segments restored.
Owner check: Real UK state used; no platform mutation; normal/legacy/pending/error paths checked.
Result: fixed.
State update: WMB-3601 done; WMB-3602 next.
Clean completion: yes
Blocked reason: none.
