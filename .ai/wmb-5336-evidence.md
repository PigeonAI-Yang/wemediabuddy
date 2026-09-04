# WMB-5336 Evidence

Date: 2026-08-22

## Delivered contract

- One `video_script` derivative identity per Content Project.
- Append-only derivative versions bound to an exact source `content_versions.id`.
- Content-adaptive `format_decision_json`; no fixed video template.
- Writer `video_script` task, permissions, prompt, durable readback, and MCP save/finalize commands.
- Final script promotes its bound daily target to `completed`.
- A newer article version makes the ready script `stale`, regresses the target to `scripting`, and requires a new aligned script version.
- Studio shows article and video-script outputs side by side, including the actual script title/body, format decision, version alignment, and readiness state.

## Behavioral proof

### Lifecycle and Writer contract

Command:

```text
node --test tests/wmb-5336-content-derivative.test.mjs
```

Result: PASS 2/2.

Covered: adaptive tutorial shape; immutable update/delete triggers; exact article binding; completed projection; article-v2 stale regression; aligned script-v2 completion; Writer `video_script` readback and MCP prompt contract.

### Real Electron Studio surface

Command:

```text
node tests/e2e/runner.mjs --file tests/e2e/studio.test.mjs --scenario ST-009-studio-dual-output
```

Result: PASS 1/1.

Evidence directory: `tests/e2e/.artifacts/ST-009-studio-dual-output-Q97DaK`

Observed: real Electron Studio opened the seeded project; article and video script rendered side by side; script title/body and adaptive decision were visible; projection was `script_ready`, aligned, and not stale; no page errors.
### Repository typecheck boundary

`npm run typecheck` remains red with 26 diagnostics in six sibling WMB-5331..WMB-5335 files: `ipc-daily-content-cycle.ts`, `ipc-intelligence-channels.ts`, `intelligence-channel-business-command.ts`, `zhihu-hot-channel.ts`, `ipc-daily-content-article.ts`, and `zhihu-hot-scoring.ts`. No WMB-5336 derivative, Writer, MCP, preload, renderer, or Studio E2E file appears in the final diagnostic set. These existing chain diagnostics are not hidden by the WMB-5336 acceptance result.


## Runtime cleanup

The managed development Electron runtime was stopped after E2E. `hub ps` reported `wmb5336-dev` and all listed test browser/Electron processes as `exited` or `failed`, with none `ready` or `running`.
