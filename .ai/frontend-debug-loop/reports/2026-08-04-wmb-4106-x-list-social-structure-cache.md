purpose: X List cards retain repost and quote relationships across cache writes and restarts.
fails-when: A live repost/quote becomes an ordinary post after SQLite persistence.

Loop: WMB-4106
Symptom: Repost and quote presentation appeared to regress.
Observation packet: Real AI-list live result had 3 reposts and 12 quotes, while the same cached batch had 20 null post kinds.
Hypotheses: Timeline cache normalization deleted social-structure fields.
Bug type: mapping wrong.
Chain traced: X GraphQL -> live parser -> cache normalizer -> SQLite -> cache IPC -> renderer social cards.
Breakpoint: `normalizePayload` copied base post/media/metrics but omitted `postKind`, `repostedBy` and `quotedPost`.
Root cause: Cache serialization lagged behind the richer post model.
Files changed: timeline-cache normalizer and focused cache regression.
Before/after gate: Packaged real UI shows 3 repost labels and 12 nested quote cards; persisted readback retains the fields.
Owner check: Current visible setting restored to only UK information; diagnostic AI cache removed; the current UK batch itself contains 40 ordinary tweets.
Result: Social post structure survives persistence.
State update: complete.
Clean completion: yes.
Blocked reason: none.
