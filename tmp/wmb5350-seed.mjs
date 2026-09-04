import fs from 'node:fs';
import path from 'node:path';
import { seedWorkspace } from '../tests/e2e/harness.mjs';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';
import { createPlanningDraftFromTarget, submitPlanItemForReview } from '../src/main/planning-stage.ts';

const userDataDir = 'J:/PigeonYang/WeMediaBuddy/tmp/wmb5350-e2e-userdata';
const dataRoot = 'J:/PigeonYang/WeMediaBuddy/tmp/wmb5350-e2e-data';
fs.rmSync(userDataDir, { recursive: true, force: true });
fs.rmSync(dataRoot, { recursive: true, force: true });
seedWorkspace({ userDataDir, dataRoot, displayName: 'WMB-5350 策划验收', seedPi: true, onboarding: true });
const realConfig = 'C:/Users/yangda01/AppData/Roaming/WeMediaBuddy/pi-api-config.json';
if (fs.existsSync(realConfig)) fs.copyFileSync(realConfig, path.join(userDataDir, 'pi-api-config.json'));
const realLocalState = 'C:/Users/yangda01/AppData/Roaming/WeMediaBuddy/Local State';
if (fs.existsSync(realLocalState)) fs.copyFileSync(realLocalState, path.join(userDataDir, 'Local State'));
const db = migrateDatabase(path.join(dataRoot, 'wmb.db'));
try {
  const source = upsertSource(db, {
    originalUrl: 'https://example.com/ai-copyright-evidence-2026',
    title: '2026 年生成式 AI 版权责任的新判例与平台规则',
    author: 'Acceptance Desk',
    publishedAt: '2026-08-23T02:00:00.000Z',
    summary: '法院判例与平台规则同时收紧，创作者需要重新评估训练数据、引用与商业发布风险。',
    categories: ['AI', '版权'],
    keywords: ['生成式AI', '版权', '创作者'],
    valueJudgment: '直接影响 AI 内容创作者的发布合规与商业化。',
    ipRelevance: '适合面向中文 AI 创作者做证据驱动的实操解读。',
    creationAngles: '从创作者今天必须修改的三项工作流切入。',
    recommendedPlatforms: ['wechat', 'xiaohongshu'],
    recommendedFormats: ['article'],
    timeliness: 'today',
    priority: 2,
    verificationStatus: 'verified'
  }, false);
  const { planItemId } = createPlanningDraftFromTarget(db, {
    title: 'AI 创作者今天必须重做的 3 个版权工作流',
    sourceIds: [source.id],
    planDate: '2026-08-23',
    origin: 'planner'
  });
  submitPlanItemForReview(db, {
    planItemId,
    expectedRevision: 1,
    by: 'planner',
    reason: 'Planner 已完成证据化策划，提交 Yann 审核',
    item: {
      title: 'AI 创作者今天必须重做的 3 个版权工作流',
      priority: 2,
      whyNow: '2026-08-23 新判例与平台规则形成同日窗口，创作者的旧流程已出现可执行风险。',
      timeliness: 'today',
      targetAudience: '使用生成式 AI 生产并商业发布内容的中文创作者',
      angle: '不泛谈法律概念，只检查训练素材、引用证据与最终签发三个工作环节。',
      pointOfView: 'AI 能生成内容，但证据链与最终发布责任不能外包给模型。',
      platforms: ['wechat', 'xiaohongshu'],
      formats: ['article'],
      titleGuidance: '保留“今天必须重做”和明确数字，避免夸大判例范围。',
      openingGuidance: '先给出一个因旧引用流程导致发布受阻的具体场景，再说明规则变化。',
      structureGuidance: '变化事实 → 三个风险环节 → 每个环节的替代动作 → 发布前检查表。',
      effortEstimate: 'M',
      sourceIds: [source.id],
      availableMaterials: ['判例摘要', '平台规则原文', '创作者旧流程对照'],
      missingMaterials: ['核验判例适用法域与生效时间', '补充平台规则原文逐条引用'],
      scoreReasons: {
        status: 'scored',
        score: 78,
        reasons: [
          { criterion: 'evidence_coverage', weight: 25, score: 18, reason: '已有一手摘要与平台规则，仍需补法域和原文定位。' },
          { criterion: 'timeliness', weight: 20, score: 18, reason: '同日政策与判例窗口。' },
          { criterion: 'audience_fit', weight: 20, score: 16, reason: '直接命中 AI 内容创作者。' },
          { criterion: 'angle_novelty', weight: 15, score: 12, reason: '从工作流整改而非泛法律解读切入。' },
          { criterion: 'effort_feasibility', weight: 15, score: 10, reason: '材料大体可得，需 Reporter 补证。' },
          { criterion: 'compliance', weight: 5, score: 4, reason: '明确限制法域与结论边界。' }
        ]
      }
    }
  });
  fs.writeFileSync(path.join(dataRoot, 'acceptance.json'), JSON.stringify({ planItemId, sourceId: source.id }, null, 2));
  console.log(JSON.stringify({ userDataDir, dataRoot, planItemId, sourceId: source.id }));
} finally {
  db.close();
}
