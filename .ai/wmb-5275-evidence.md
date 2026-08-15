# WMB-5275 Evidence

## Problem

Owner screenshot showed the same X post content three times:

1. A truncated source title ending at `mor`.
2. `工作摘要` with the complete text.
3. `正文摘录` with the same complete text split into paragraphs.

The three visual levels did not represent three distinct facts.

## Decision

`src/renderer/today-view-panels.tsx` now compares title, summary, and ready archived text after trimming, case normalization, and whitespace normalization.

- Exact matches collapse.
- A prefix is treated as a truncated duplicate only when it is at least 80 normalized characters and at least 65% of the longer text.
- For X/Twitter sources whose available fields form one duplicate family, the longest complete version becomes the only primary source text.
- Duplicate `工作摘要` and duplicate `正文摘录` sections are omitted.
- `正文已归档 · N 字` remains beside the unified text so persistence truth is not lost.
- Materially different summaries and archived bodies continue to render as separate sections.

No Source data, archive records, IPC, DB schema, permissions, capabilities, dependencies, or brand tokens changed.

## Verification

- `npm run typecheck`: PASS.
- `node --check tests/e2e/wmb-5251-modal-migration.test.mjs`: PASS.
- `node --test tests/design-tokens-drift.test.mjs`: 3/3 PASS.
- Real Electron `WMB-5270-today-inline-detail-contract`: 1/1 PASS.
  - Truncated X title + complete same-text summary + paragraph-form same-text archive collapsed to one complete post.
  - Duplicate summary/body section counts: 0/0.
  - Archive status remained visible.
  - A separate fixture with distinct title, summary, and archived body retained both sections.
  - Horizontal overflow: 0; page errors: 0.
  - Artifact: `tests/e2e/.artifacts/WMB-5270-today-inline-detail-contract-4lS7eT/`.
- Real Electron `WMB-5270-inline-detail-responsive`: 1/1 PASS.
  - Pi-expanded 1183×871 and minimum 1100×800 remained scrollable and horizontally contained.
  - Artifact: `tests/e2e/.artifacts/WMB-5270-inline-detail-responsive-1GNAWq/`.

The responsive test's right inset calculation was corrected to measure against `section.clientWidth`, excluding the vertical scrollbar gutter. This matches the existing section-relative bottom-inset contract and the actual content box.
