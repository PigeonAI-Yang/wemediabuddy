# WMB-5138–5140 completion evidence

Date: 2026-08-09 (Asia/Shanghai)

## Scope

- WMB-5138: Windows Squirrel installer and compact bundled Pi runtime.
- WMB-5139: first-run onboarding plus safe in-app update, backup, recovery and install handoff.
- WMB-5140: release automation, final regression/build/package/UI acceptance and cleanup.

## Verification

- `npm test`: 593/593 passed, 0 failed (full suite before lifecycle-only extraction; production behavior unchanged by the extraction).
- `node --test --test-concurrency=1 tests/app-update.test.mjs tests/onboarding.test.mjs tests/squirrel-lifecycle.test.mjs tests/release-feed.test.mjs`: 28/28 passed, including strict `v<semver>` acceptance-feed validation.
- `npm run typecheck`: passed.
- `npm run check:capabilities`: passed; 20 internal commands, 17 grantable covered, 5 roles.
- `scripts/check.ps1`: passed after line-cap ratchet (`index.ts` 969, `global.d.ts` 572); task ledger, intake, capability and harness gates passed.
- `npm run build`: passed after release-review hardening; Electron Forge produced a fresh win32/x64 package and Squirrel distributables.
- Packaged smoke: rebuilt `WeMediaBuddy.exe` launched with an isolated user-data root and exposed a healthy renderer over CDP; the global downloaded-update banner was rendered with production CSS at 1440×900 and showed `稍后提醒` plus `立即重启更新` without overflow.
- Bundled runtime readback: package contains `resources/.r/node_modules/a/dist/cli.js`, `resources/.r/node_modules/pi-vision-tool/package.json`, and `.package-lock.sha256`.
- Isolated acceptance user-data directories were removed after smoke validation.
- Release-review follow-up: failed quit-time installation now clears shutdown state and recreates the app window; downloaded updates have a persistent app-level prompt; acceptance override tags reject non-`v<semver>` input before feed URL construction.
- Independent follow-up review `ReviewReleaseFixes`: approved all three closures with confidence 0.95; findings 0.

## Artifacts

- `J:\wmb-out\make\squirrel.windows\x64\WeMediaBuddy Setup.exe` — 193,148,416 bytes; SHA-256 `648502d3b34a1791418e712f4d32c617ca897d25e624e8e342e9e0a4c186f104`.
- `J:\wmb-out\make\squirrel.windows\x64\WeMediaBuddy-0.2.0-full.nupkg` — 197,689,408 bytes; SHA-256 `6a0ec68cefb36dbd90d3a76c93fccbfbcb831c4ab78008bc86a4c421638378ca`.
- `J:\wmb-out\make\squirrel.windows\x64\RELEASES` — 83 bytes; SHA-256 `89bcf1be0042ce7f312b14e2944c7872cf59e2233922f546db1cc7fced160e90`.

## Release contract

- `.github/workflows/release.yml` builds tagged Windows releases, verifies SHA-256 sums and uploads Forge/Squirrel artifacts through the configured GitHub publisher.
- `WMB_WINDOWS_CERTIFICATE_FILE` / `WMB_WINDOWS_CERTIFICATE_PASSWORD` remain optional repository secrets for Authenticode signing; unsigned local builds remain valid for acceptance.
- No Git tag or GitHub Release was created in this implementation session; publishing is intentionally driven by the version-tag workflow rather than an unreviewed external mutation.
