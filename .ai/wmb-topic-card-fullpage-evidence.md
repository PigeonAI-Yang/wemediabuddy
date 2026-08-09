# Topic card grid + full-page detail evidence

Date: 2026-08-07  
Spec: `docs/spark/2026-08-07-topic-card-fullpage-design.md`

## Delivered

1. Topic home is card grid (`topic-layout-home` / `topic-object-card`), no left list pane.
2. Card click opens full-page detail with `← 主题` (`backToGrid` clears selection).
3. Detail keeps 判断 / 证据 / 回流 segments and dossier loaders.
4. Primary CTA **让 Pi 出选题方案** opens Pi dock + binds topic context + dispatches `wmb-pi-generate`.
5. Deep link: mount `initialTopicId` once + `wmb-open-library-topic` still open detail.
6. Search / status filters / load-more remain on home.
7. No schema / plan_items write path.

## Files

- `src/renderer/library-topics-view.tsx`
- `src/renderer/main.tsx` (`onOpenPi`, `piConfigured`)
- `src/renderer/styles-knowledge.css`
- `src/renderer/styles-knowledge-topic.css`

## Verification

```text
npx tsc --noEmit
# EXIT:0

rg topic-list-pane src/renderer/library-topics-view.tsx
# no matches
```

App restarted (`wmb-dev`) after change.
