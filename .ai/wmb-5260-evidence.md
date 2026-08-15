# WMB-5260 — Baoyu whole-product frontend rethink

Date: 2026-08-15
Status: design-only prototype complete

## Decision

The old frontend was not primarily missing polish. It used an admin-console page grammar: nested selected controls, duplicated identity, giant workflow containers, microcopy, page-owned control dialects, machine fields in the main view, and a Pi dock that permanently reduced workspace width.

The replacement is one editorial operating environment with three room forms only:

1. desk/list — Today, Agents, Discover, Proposals, Results, Library;
2. reading/detail — Topics and source/topic detail;
3. workspace exception — Studio and Canvas.

All forms share one 56px topbar, grouped room navigation, one H1, one workspace scroll owner, one primary action, semantic tabs/filters/status, truthful four-state regions, and Pi as a non-resizing overlay.

## Deliverable

- `designs/wemedia-buddy-frontend-rethink/index.html`
- Single self-contained HTML; no external runtime, font, media, or network dependency.
- Exactly 11 formal rooms: 今日、智能体、发现、选题、主题、资料库、创作、发布、结果、画布、设置.
- Default state: `资料库` → `观察中`.
- Dark/light themes, 11-room switching, semantic tab keyboard navigation, source/decision/publish/principles modals, search/filtering, loading/error/empty/content state switch, Pi overlay, and technical-detail disclosures.

## Explicit deletion list

- nested selected chips;
- duplicated page identity;
- giant workflow-status boxes;
- color-only status;
- machine IDs/paths/models in the main view;
- page-owned button dialects;
- permanently width-subtracting Pi.

The in-artifact `设计原则` dialog names the same seven deletions and returns focus on Escape.

## Visual correction

The default Library view now has one masthead, one selected tab, one compact search/filter row, one slim operation strip with meaningful progress/count/pause, then a readable source table. It no longer repeats `观察中`, wraps the workflow in a large bordered panel, or presents ambiguous counters.

Independent review first found one real blocker: Today/Agents/Results markup used `.sec-title`, `.decide-*`, `.slim-*`, `.crew-*`, and `.stat-line` without CSS owners. The artifact was repaired with an 18px section tier, structured decision rows, compact notice rows, restrained crew marks, and a non-dashboard result-stat line. Re-review: PASS, blockers 0.

## Browser evidence

### 1600×960

- All 11 rooms: exactly one visible H1, exactly one visible primary action, workspace horizontal overflow 0.
- Four demo states × 11 rooms = 44 combinations: H1=1, primary=1, overflow=0; failures 0.
- Pi: workspace stayed 1396px before/after open (`widthDelta=0`); focus moved to `piInput`; Escape closed Pi and returned focus to `piToggle`.
- Theme: body changed from `rgb(11, 11, 11)` to `rgb(246, 245, 250)`; overflow remained 0.
- Library tab ArrowRight moved focus/selection from `lib-t1` to `lib-t2`.
- Source modal opened, Escape closed it, and focus returned to the `lib1` trigger.
- Principles dialog opened with the seven-item deletion list; Escape returned focus to `principlesBtn`.
- Console errors: 0; page errors: 0.

### 1100×800

- Navigation collapsed to 64px; labels hidden; workspace 1036px.
- All 11 rooms: one H1, one primary action, workspace overflow 0.
- Pi opened at 360px as an overlay; workspace remained 1036px (`widthDelta=0`); document overflow 0.
- All 14 data tables have visually hidden captions; all 82 header cells have `scope="col"`.
- Console errors: 0; page errors: 0.

## Captures

- Default dark Library: `J:/Users/yangda01/Temp/omp-sshots-155791f098050dd3.webp`
- Compact Library + Pi: `J:/Users/yangda01/Temp/omp-sshots-1557927982050dd4.webp`
- Light Library: `J:/Users/yangda01/Temp/omp-sshots-155792bbba050dd5.webp`
- Repaired Today: `J:/Users/yangda01/Temp/omp-sshots-1557947d9f450dda.webp`
- Repaired Agents: `J:/Users/yangda01/Temp/omp-sshots-1557947dc1850ddb.webp`
- Repaired Results: `J:/Users/yangda01/Temp/omp-sshots-1557947de2850ddc.webp`
- Topic list: `J:/Users/yangda01/Temp/omp-sshots-155792dbc6c50dd7.webp`
- Studio: `J:/Users/yangda01/Temp/omp-sshots-155792dbf9c50dd8.webp`
- Canvas: `J:/Users/yangda01/Temp/omp-sshots-155792dc25850dd9.webp`

## Scope

No production renderer, business protocol, database schema, permission, capability, dependency, publication boundary, or brand-level token changed. Prototype data is representative, not live product data. Production migration requires a separate authorized task.
