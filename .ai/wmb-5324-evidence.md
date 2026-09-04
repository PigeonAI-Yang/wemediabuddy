# WMB-5324 System proxy adoption evidence

## Scope

Implemented and audited the system-proxy path without changing `TASKS.md` or the workspace orchestrator. Existing Owner changes in shared main-process files were preserved; proxy edits were limited to imports and child-process environment objects.

## Production path

- `src/main/index.ts` calls `await initSystemProxy()` immediately inside `app.whenReady()` before loading the selected workspace and starting Pi/runtime work.
- `src/main/proxy-config.ts` gives explicit `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` (including lowercase forms) precedence over Chromium/PAC resolution.
- Without explicit proxy variables, `session.defaultSession.resolveProxy()` is lazily loaded and queried for representative HTTPS origins (`api.github.com`, `www.gyan.dev`); PAC results continue past `DIRECT` to find a usable proxy entry.
- `PROXY`/`HTTPS` entries become HTTP proxy URLs; SOCKS entries become SOCKS5 URLs. Resolver calls have a bounded 1 second deadline and all failures fall back to a direct dispatcher without throwing through startup.
- The selected proxy is installed as the global undici dispatcher (`EnvHttpProxyAgent` for explicit environment configuration, `ProxyAgent` for system resolution). A direct `Agent` is selected for loopback, `.localhost`, `.local`, RFC1918, link-local, and invalid/non-HTTP origins, preventing local MCP/CDP traffic from crossing the external proxy.
- Child proxy variables are kept as a private snapshot and returned as a fresh object. They are injected into every Pi child construction path: desktop dock/knowledge compile, agent-runner desk/planner/results, research, role planner/organizer, workspace intelligence, and Pi runtime probing. Direct mode emits no override variables.
- `undici` is a fixed runtime dependency (`7.29.0`); Forge already includes `node_modules/undici` as an extra resource, and the loader falls back to `process.resourcesPath/undici` for packaged execution.

## Verification

1. `node --test tests/proxy-config.test.mjs`
   - 7 tests, 7 passed, 0 failed.
   - Covers proxy parsing, DIRECT/PAC handling, semicolon fallback, loopback/private bypass, distinct explicit HTTP/HTTPS/ALL proxy inheritance, direct fallback, and resolver adoption.
2. `node --test tests/media-runtime.test.mjs tests/pi-config.test.mjs tests/pi-config-fallback.test.mjs tests/illustration-workflow.test.mjs`
   - 40 tests executed, 40 passed, 0 failed.
   - The four files contain 40 executable `test(...)` declarations in the current checkout (the ticket text says 41; no test was skipped).
3. `npm run typecheck`
   - Passed after correcting the dispatcher `destroy` overload to pass `Error | null`.
4. Packaged-resource loader probe
   - `createRequire` against a `resources/undici`-shaped package root loaded successfully, confirming the fallback targets the copied package root rather than a nonexistent nested `node_modules` path.
5. Local HTTP proxy CONNECT smoke
   - `initSystemProxy(async () => 'PROXY 127.0.0.1:<port>')` installed the system dispatcher; a request to a public-origin hostname returned HTTP 200 with body `proxied-ok` through the local proxy. The temporary target/proxy were closed and the process environment was restored.

## Remaining package blocker

`npm run package` reached the existing `verify:xhs-resources` pre-gate but could not proceed because Windows Security quarantines the official `resources/xiaohongshu-mcp/xiaohongshu-mcp-windows-amd64.exe`. The file was restored from the manifest-pinned v2.1.1 release URL, then removed again by Windows Security before the repository hash verifier could read it. `Get-MpThreatDetection` confirms repeated detections for both the repository path and the installed app path. No security exclusion was added and no verifier/package gate was bypassed. Real packaged Electron acceptance therefore remains blocked on Owner restoration/allow-listing of that pinned binary.

No formatter, linter, full test suite, commit, or push was run for this task.
