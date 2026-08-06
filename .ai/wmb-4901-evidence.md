# WMB-4901 / 4902 / 4903 evidence — Today mainline

Date: 2026-08-06

## What landed

- `src/renderer/today-run-view.ts` — pure `deriveTodayRunView` + phase→step map + copy matrix (K3 §13.4)
- `src/renderer/today-command-bar.tsx` — single command tower from view
- `src/renderer/today-blockers.tsx` — actionable blockers only
- `src/renderer/today-view.tsx` — assembles view; no competing `statusText` / `formatTodayActionLine` / fake pending cards
- Settings deep-link via `sessionStorage wmb.settingsSection` + `openSettings(section)` from Today
- `workbench.getToday` already returns `pendingActions: []` (kept)

## Owner freeze honored

1. Today serves one run → plan  
2. Single TodayRunView source  
3. No fake「创建今日运营方案」  
4. partial CTA「继续生成方案」  
5. ≤3 stats when idle  
6. needs_user primary「继续今日情报」

## Verification

```text
npm run typecheck                          # pass
node --test tests/today-run-view.test.mjs  # 11/11 pass
```

Fixtures covered: idle±plan, starting/scanning/judging, partial, needs_user, failed, done±ops, localStarting, statusLine==headline.

## Manual / live

- Renderer smoke after HMR: `node scripts/smoke-renderer.mjs` when dev server up.
- Expected UI: command bar headline matches empty-state body primary label; no ✋「创建今日运营方案」; partial shows「继续生成方案」; blocker card navigates Settings section.

## Pi operator Skill impact

no change — renderer projection and settings navigation only.
