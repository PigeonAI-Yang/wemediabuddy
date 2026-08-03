# WMB-3701 X List confirmation state

- Reproduced: the newest operation remained `awaiting_confirmation` with 20 pending items and no execution timestamps after both user clicks.
- Root cause: the shared X session exposed queued work as current before serial execution, allowing a later read to supersede the confirmation snapshot; the failure was not persisted.
- Fixed: activate session ownership inside the serial executor, persist confirmation capture failures, clear them when a retry starts, and reopen the newest operation with explicit step/result copy.
- Verified: focused tests 8/8, typecheck, package build, and identical packaged DOM across Settings → Today → Settings. No external X write was triggered by acceptance.
