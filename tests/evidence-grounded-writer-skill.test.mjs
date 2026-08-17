import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('evidence-grounded writer triggers factual creation and enforces the full verification loop', async () => {
  const skill = await readFile('skills/evidence-grounded-writer/SKILL.md', 'utf8');
  assert.doesNotMatch(skill, /\b(?:TODO|TBD)\b/);
  assert.match(skill, /写一篇/);
  assert.match(skill, /即使用户没有主动要求核查/);
  assert.match(skill, /不用于纯虚构创作/);
  assert.match(skill, /先研究再写作/);
  assert.match(skill, /主张账本/);
  assert.match(skill, /搜索摘要、标题、账号简介/);
  assert.match(skill, /发现渠道没有统一权威等级/);
  assert.match(skill, /丰富来自新增有效信息/);
  assert.match(skill, /从成稿反向复核/);
  assert.match(skill, /正式成稿/);
  assert.match(skill, /内部核查结果/);
  assert.match(skill, /不得包含主张账本、研究过程、证据缺口、核查清单、残余不确定项、免责声明/);
  assert.match(skill, /若收窄后已无独立价值，则停止成稿/);
  assert.match(skill, /鲜明判断、超前愿景、情绪张力和读者行动/);
  assert.match(skill, /强观点不等于伪造事实/);
  assert.match(skill, /不能因为内部核查而把正文写成论文/);
});

test('evidence-grounded writer UI metadata stays implicit and names the exact Skill', async () => {
  const metadata = await readFile('skills/evidence-grounded-writer/agents/openai.yaml', 'utf8');
  assert.match(metadata, /display_name: "可信内容写作"/);
  assert.match(metadata, /\$evidence-grounded-writer/);
  assert.doesNotMatch(metadata, /Use -grounded-writer/);
});
