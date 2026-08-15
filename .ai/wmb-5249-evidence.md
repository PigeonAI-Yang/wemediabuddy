# WMB-5249 — Zhihu article publication pilot

Date: 2026-08-15
Owner: main

## Delivered

- Added `zhihu` to the persisted platform schema, platform catalog, Studio annotations, workspace browser binding snapshots, publication snapshot dispatch, preload bridge, and renderer platform tabs.
- Added authenticated Zhihu identity inspection from the dedicated browser profile.
- Added native Zhihu article preparation: opens an isolated `/write` page, pastes paragraph-preserving Draft.js HTML/plain text, serializes body/title/cover autosaves, reads all three back, and returns the platform draft URL.
- Supports zero or one explicitly marked JPEG/PNG cover from the immutable publication snapshot. Other asset contracts fail before browser connection; internal media tokens are removed only when they correspond to that frozen cover.
- The adapter never clicks Zhihu's publish/submit control. Owner retains final publication.

## Defect found by the real pilot

The initial deterministic DOM insertion passed fake tests but failed in the live Draft.js editor: the editor normalized it to an empty block. A subsequent title autosave could also overwrite body state when both fields were changed together. The production path now dispatches a native clipboard `paste` with both `text/plain` and paragraph-preserving escaped `text/html`, then serializes body, title, and cover saves. The upstream cover selector (`input.UploadPicture-input`) was verified against the live editor; production waits for and reads back `img[alt="封面图"]` before returning.

## Verification

### Focused contract and type verification

Command:

```text
node --test --test-concurrency=1 tests/wmb-5249-zhihu-platform.test.mjs && npm run typecheck
```

Result: 16/16 tests passed; TypeScript passed. Coverage includes migration preservation/fresh schema, platform domain, Studio annotations, all four login states, unsupported-cover pre-side-effect rejection, one-cover upload/readback, unauthenticated/challenge stops, escaped paragraph paste payload, exact title/body readback, no publish click, identity evidence, cover snapshot freezing, publication state transition, and preload wiring.

### Adjacent publication regressions

Command:

```text
node --test --test-concurrency=1 tests/wmb-5237-publication-media.test.mjs tests/workspace-profile-ensure-upgrade.test.mjs tests/pi-platform-version-tool.test.mjs tests/studio-platform-tabs.test.mjs tests/wmb-5253-return-to-edit.test.mjs tests/publishing.test.mjs tests/wmb-5183-command-boundary.test.mjs tests/workspace-platform-boundaries.test.mjs
```

Result: 38/38 tests passed.

### Real Zhihu browser acceptance

Dedicated authenticated Edge profile, CDP `127.0.0.1:19334`.

Adapter input:

- title: `WMB 知乎封面发布试点最终验收（勿发布）`
- body: `第一段：验证标题、正文与封面写入。\n\n第二段：应用必须停在最终发布前。`
- cover asset: `b73afc1a-d2c3-4cb8-9833-73df9273c16d` (`image/png`, 1254×1254)

Adapter result:

- draft URL: `https://zhuanlan.zhihu.com/p/2071808539996300832/edit`
- exact title/body readback returned
- `assetIds: ["b73afc1a-d2c3-4cb8-9833-73df9273c16d"]`

The draft URL was then reloaded independently. Exact persisted title and paragraph-separated body were read back. `img[alt="封面图"]` remained present at 150×100 with a Zhihu-hosted draft URL; the `发布` button remained present and untouched. Screenshot: `J:/Users/yangda01/Temp/omp-sshots-1557c4ace7b5228b.webp`.

No publish action was performed.

## Scope boundaries

No MultiPost runtime integration. No automatic publication. No inline-body image or video support in this first pilot; exactly one explicit JPEG/PNG cover is supported. No capability or permission expansion. No brand-token change.
