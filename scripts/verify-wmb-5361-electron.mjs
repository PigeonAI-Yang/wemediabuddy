import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { withApp } from '../tests/e2e/harness.mjs';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { upsertSource } from '../src/main/sources.ts';

const reasons = [
  ['reader_immediacy_benefit',20,16],['tension_curiosity_gap',20,15],['why_now_window',20,16],
  ['save_share_comment_motive',20,15],['evidence_credibility',15,12],['account_fit',5,4]
].map(([criterion,weight,score]) => ({ criterion,weight,score,reason:`${criterion} 真实理由` }));

const result = await withApp(async ({ page, artifactsDir, helpers, evidence }) => {
  await helpers.waitForAppReady(page,{timeoutMs:90_000});
  await helpers.navigateTo(page,'proposals');
  const detail = page.locator('[data-testid="proposal-detail"]');
  await detail.waitFor({state:'visible',timeout:30_000});
  const text = await detail.innerText();
  for (const label of ['为什么现在','目标读者','表达角度','核心观点','内容结构','来源证据','六维评分']) helpers.assert(text.includes(label),`详情 DOM 缺少 ${label}`);
  helpers.assert((await page.getByRole('button',{name:'设置 Pi 焦点'}).count())>0,'缺少独立 Pi 焦点动作');
  helpers.assert((await page.getByRole('button',{name:/收起详情|查看详情/}).count())>0,'缺少独立详情动作');
  await page.screenshot({path:path.join(artifactsDir,'proposal-detail.png'),fullPage:true});
  helpers.assert(evidence.pageerrors.length===0,`页面异常: ${evidence.pageerrors[0]?.message ?? ''}`);
  return {text,artifactsDir};
},{name:'wmb-5361-proposal-detail',keepRuntime:true,seedFixture:async ({dataRoot})=>{
  const db=migrateDatabase(path.join(dataRoot,'wmb.db'));
  try {
    const source=upsertSource(db,{title:'GLM-5.3 Flash 官方与实测证据',originalUrl:'https://example.test/glm',summary:'跨日证据'});
    saveCurrentPlan(db,{planDate:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date()),timezone:'Asia/Shanghai',summary:'完整详情',items:[{title:'100T 免费额度为什么值得重新判断',priority:1,whyNow:'正式身份刚刚揭晓',timeliness:'today',targetAudience:'正在做 AI 项目的人',angle:'把公告与实测放在一起',pointOfView:'免费额度的价值取决于可验证工作负载',platforms:['wechat'],formats:['article'],titleGuidance:'标题建议',openingGuidance:'首段兑现冲突',structureGuidance:'方向判断：为何现在→强观点→来源',effortEstimate:'40分钟',sourceIds:[source.id],availableMaterials:['官方公告','历史实测'],missingMaterials:['算力提供方核验'],scoreReasons:{status:'scored',score:78,reasons}}],candidateSources:[{sourceId:source.id,sourceRevision:source.revision}],sourceDecisions:[{sourceId:source.id,decision:'selected',reasonCode:'cross_day_identity',reason:'身份揭晓后重激活'}]});
  } finally {db.close();}
}});
await writeFile(path.join(result.artifactsDir,'result.json'),JSON.stringify(result.result,null,2));
console.log(JSON.stringify({ok:true,artifactsDir:result.artifactsDir}));
