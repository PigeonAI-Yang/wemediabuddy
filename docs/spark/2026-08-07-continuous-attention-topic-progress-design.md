# M-5001 持续关注 → 主题进展投影

Date: 2026-08-07  
Status: implementation design (Owner scheduled via goal)  
Normative: PRODUCT C3/C4, PRD §2.0, SPEC §1.0, spark product-form constitution §5/§8

## 1. Goal

Replace Today「持续关注」long-horizon identity:

| From (debt) | To |
|---|---|
| `work_carry_items` mix plan_item + **source** | **Topic progress** projection |
| `storyKey` / `sameStory` as identity | `topics.id` |
| Bare high-value source desk dump | No bare-source promotion |
| Rail copy 事件/机会混称 | Glossary: 主题 / 选题 / 资料 |

## 2. Non-goals

- Do **not** delete `work_carry_items` — proposals open/dismissed/expired/restore still use plan_item carry state.
- Do **not** rewrite opportunity pool / chair.
- Do **not** add regex topic induction; multi-day bind stays LLM/`topicId` + existing multi-day auto-create.

## 3. Cutover seam

1. **Read path only for rail**: `listFermentingBundle` becomes topic-progress primary.
2. **Write path**: disable `seedCarryFromHighValueSources` (no new source carry for desk).
3. **Keep**: `refreshWorkCarry` expire/promote/merge for plan_item; `setCarryState` / dismiss for proposals.
4. **UI**: `FermentingRail` renders topic rows; create/open actions by `objectType==='topic'`.

## 4. Projection rules

A topic appears on Today continuous-attention when:

- `topics.status IN ('active','watching')` and not archived;
- AND at least one desk-worthy signal in window (default 14d):
  - linked open/unadopted plan_item carry still active/watching with why-watching; OR
  - `topic_source_links` gained a source in last 7d; OR
  - `topics.last_seen_at` within 14d AND (opportunityCount≥1 or sourceCount≥1);
- sorted by: watching last, then last_seen_at desc, cap `MAX_FERMENTING` (5).

Row shape (compat with existing Fermenting item fields):

- `objectType: 'topic'`
- `objectId` / `topicId`: topic id
- `title`: topic title
- `reason`: why-watching one-liner (新资料 / 未完结选题 / 主题观察)
- `aftershocks`: optional latest source title as progress
- `state`: map topic.status active→active, watching→watching
- `fermentedDays`: from first_seen_at
- `priority`: best linked open plan priority or null

`items` = active topic rows; `watchingItems` = watching topic rows.  
`topics[]` mirrors items+watching summary for Pi brief.  
`pinnedSources` = `[]` (no bare-source desk pins).

## 5. Backend changes

| Change | File |
|---|---|
| `listTopicProgressBundle` / rewrite `listFermentingBundle` | `ferment.ts` |
| No-op `seedCarryFromHighValueSources` | `ferment.ts` |
| On plan save multi-day topic bind: link sources → `topic_source_links` | `planning.ts` |
| Types if needed | `app-types.ts`, `global.d.ts` |

## 6. Frontend changes

| Change | File |
|---|---|
| Rail renders topic rows; empty copy 主题 | `today-view-panels.tsx` |
| createFromCarry: topic → create project with topicId or open library topic | `today-view.tsx` |
| Glossary microcopy | rail head:「持续关注 · 主题」 |

## 7. Tests

- Update `tests/ferment.test.mjs`: multi-day plan → topic on rail (objectType topic), not bare source.
- New: high-value source alone does **not** appear on rail after refresh.
- New: topic progress lists reason + fermentedDays.
- Keep proposals/pool tests green (carry state machine untouched).

## 8. Task chain

1. WMB-5001 — design + ledger (this doc)
2. WMB-5002 — backend projection + stop source seed + topic source link on plan save
3. WMB-5003 — FermentingRail UI + glossary + create path
4. WMB-5004 — tests + evidence

## 9. Gate

- Today continuous-attention cards are topics (or empty), never bare sources.
- Proposals dismiss/restore still works.
- Focused ferment + desk tests pass; typecheck if TS touched.
