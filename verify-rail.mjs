import { chromium } from 'playwright-core';
import fs from 'node:fs';

const DEBUG_PORT = 9322;
const REJECTED_TITLES = [
  'AI 服务先交付一张客户会反复打开的结果页',
  'AI 生成的图，为什么更适合交付成 HTML',
  '团队用 AI 开发，先把需求讲到不用问 AI',
  '让 AI 代填表之前，先把任务切成可检查的低风险步骤',
  '一个抠图工具，怎样变成能交付的轻量服务',
  '工具调用失败时，先查参数和停止条件，不要急着换模型',
  '先用“五要素”判断一项工作值不值得做成 AI Agent',
  '国家数字图书馆应该成为内容获取流程的第一步',
  '服装店尺码问答库，先交付一份能直接回复顾客的建议包',
];
async function run(){
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
  const page = browser.contexts()[0].pages()[0];
  const railText = await page.locator('.fermenting-rail').textContent().catch(()=> '') || '';
  const bodyText = await page.textContent('body').catch(()=> '') || '';
  const railInner = await page.evaluate(()=>{
    const el = document.querySelector('.fermenting-rail');
    return el ? el.innerText : '';
  });
  console.log('railText snippet', railText.slice(0,1000));
  console.log('railInner snippet', railInner.slice(0,1000));
  console.log('hasHeader', bodyText.includes('持续关注 · 主题 · 0'));
  console.log('hasEmpty', bodyText.includes('没有需要持续关注的主题。'));
  const foundInRail = REJECTED_TITLES.filter(t=> railText.includes(t) || railInner.includes(t));
  const foundInBody = REJECTED_TITLES.filter(t=> bodyText.includes(t));
  console.log('foundInRail', foundInRail);
  console.log('foundInBody', foundInBody);
  // also check that rail shows 0 count via h2
  const headerText = await page.locator('.fermenting-rail h2').textContent().catch(()=> '') || '';
  console.log('headerText', headerText);
  const emptyCopy = await page.locator('.fermenting-rail .empty-copy').textContent().catch(()=> '') || '';
  console.log('emptyCopy', emptyCopy);
  await browser.close();
}
run();
