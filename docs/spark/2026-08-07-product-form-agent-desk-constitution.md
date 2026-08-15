# 产品形态宪法：Agent 主路径自媒体协同终端

Date: 2026-08-07  
Status: Owner-aligned constitution (docs lock)  
Normative copies: `PRODUCT.md`, `PRD.md` §2.0, `SPEC.md` §1.0, `AGENTS.md` Project goal

## 1. Why this document exists

Session 2026-08-07 exposed repeated design drift:

- Today「持续关注」混入未成选题的资料，把 **做选题** 甩回主编；
- 讨论在「关注=选题 / 关注=主题 / 关注=资料钉」之间撕裂；
- 实现与话术容易滑回 **传统软件 / 人写为主 IDE**，偏离「AI 驱动人机协同终端」。

Owner 明确：WMB 不是 VS Code 型工具，而应对齐 **Codex Desktop 型**——Agent 主路径，人定事、批事、担责。

## 2. Form statement

**WMB = AI-driven self-media human-agent collaborative terminal.**

| | VS Code 型（拒绝） | Codex Desktop 型（对齐） |
|---|---|---|
| 主路径劳动者 | 人 | Agent |
| 人的主业 | 直接生产 | 目标、批准、派工、监工、终审、担责 |
| UI 中心 | 大手写画布 | 呈报、批准、派工、巡视、必要时共写 |
| 失败模式 | 人被原料淹没 | Agent 未呈报可批对象 |

## 3. Editorial office map

| Page | Room | Desk rule |
|---|---|---|
| Today | 主编桌 | Only must-decide / must-know submissions |
| Discover | 前线 | Look outside; not primary approval desk |
| Proposals | 策划提案夹 | Full opportunity ledger |
| Topics | 专题档案室 | Long-horizon attention home |
| Library | 资料室 | Evidence; not default opportunity drafting desk |
| Studio | 写字间 | Dispatched drafting; human may supervise |
| Publish | 签发台 | Human final platform click |
| Results | 评报栏 | Review feeds next round |
| Canvas | 关系墙 | Structure, optional |
| Settings | 总机 | Models, channels, accounts |

## 4. Object layers

```
资料 (evidence)
  → Agent 判断
       → 选题 (one-shot approvable brief) → 人批 → 创作项目 (drafts)
       → 主题 (long-horizon container) when worth lasting attention
```

- One topic : many sources, opportunities, content projects, reviews.
- Long-horizon attention **formal identity = Topic**.
- Topic induction = LLM editorial judgment, not regex primary.

## 5. Continuous attention (target vs debt)

**Target:** Today continuous-attention = projection of **topics** that still warrant the editor’s eye (new progress / expiring / must-know).

**Forbidden:** Untriaged sources on the desk that force the human to invent opportunity briefs.

**Debt (must not extend):** Current Today「持续关注」rail is still backed by legacy `work_carry_items` / ferment carry mixing `plan_item` + `source`, with UI merge via `storyKey` / `sameStory` heuristics. That mechanism is **not** the product long-horizon identity. Do not add features on top of bare-source desk dumps or storyKey-as-topic. Migrate under a dedicated follow-up milestone:

1. Replace continuous-attention **data source** from carry/storyKey rail → **topic / topic-progress projection**.
2. Retire or demote desk promotion of bare high-value `source` rows that lack an opportunity brief.
3. Keep any remaining one-shot `plan_item` “still open” signals out of the long-horizon identity slot (those belong to proposals/chair, not “主题关注”).

## 6. Background vs foreground work

| Background | Foreground Pi |
|---|---|
| Scan, file, lane gate, topic induction, opportunity draft, progress flags | Page-local co-write, corrections, dispatched tasks |
| Output structured desk submissions | Uses page context + grants |
| Must not spam desk with half-work | Must not fake authority or silent platform side effects |

## 7. Implementation governance

1. New Today / fermenting / topic / opportunity / Pi-desk work must cite `PRODUCT.md` C1–C7 or PRD §2.0 / SPEC §1.0 in design notes.
2. Agents read `AGENTS.md` project goal before those surfaces.
3. Feature PRs that reintroduce human-primary raw-material desks fail product review even if tests pass.
4. Code changes for continuous-attention rewrite are **out of scope of this docs lock**; track as follow-up milestone after Owner schedules it.

## 8. Open implementation follow-ups (not done here)

Canonical list (PLAN M-5000 must match these four):

1. **Replace** Today continuous-attention backend/UI: drop reliance on `work_carry_items` + `storyKey`/`sameStory` as long-horizon identity; project **topic progress** instead.
2. **Backend**: when agent marks long-horizon worth, upsert/merge **topic** + link evidence (LLM editorial induction, not regex primary).
3. **Stop** promoting bare high-value sources onto the desk without an opportunity brief.
4. **UI glossary**: 关注 / 主题 / 选题 / 资料 copy alignment on Today and related pages.

## 9. Owner lock record

- 2026-08-07: form = Codex Desktop-like agent-primary terminal, not VS Code-like.
- 2026-08-07: editor desk metaphor confirmed; long-horizon attention → topic.
- 2026-08-07: dumping untriaged sources on desk = offloading opportunity work onto human = defect.
