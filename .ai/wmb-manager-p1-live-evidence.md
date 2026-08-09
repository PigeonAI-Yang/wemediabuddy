# Manager Dialog P1 live evidence (2026-08-08)

## Pass
1. `startDailyIntelligence` creates `page_agents` ManagerTask and bridges legacy `daily_scan` child.
2. Second call returns `action=focus_existing`, `focusDialog=true` (serial lock).
3. Pi conversation file contains `【主管任务】` cards with live summary updates (reporter progress).
4. UI shows command-bar headline **主管编排中** and manager summary (e.g. 策划生成方案 5/5...).
5. Dock opens (`pi-collapsed=false`); body contains manager card text.

## Notes
- Child executor still legacy pipeline (P1 bridge).
- Structured ManagerTaskCard component still text-card; progress patches conversation + command bar.
- Screenshot: `.ai/wmb-manager-p1-live.png`
