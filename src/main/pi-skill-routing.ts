const FACTUAL_WRITING = /写一篇|写正文|写稿|写文章|写口播稿|写(?:成)?小红书(?:文案|正文|笔记)?|基于.{0,20}(?:题材|资料).{0,12}(?:创作|写)|扩写成稿|深挖|事实核查|查证|补充(?:证据|案例|数据|细节)|增加细节|内容写(?:丰富|扎实)|写(?:丰富|扎实)|有理有据/;
const NON_FACTUAL = /纯虚构|虚构创作|写(?:一篇)?(?:小说|故事|诗歌|童话)|只(?:改|修改|检查)(?:错别字|标点|语法)|不做事实(?:研究|核查)/;

export function routePiSkillPrompt(raw: string): string {
  if (raw.startsWith('/skill:') || NON_FACTUAL.test(raw) || !FACTUAL_WRITING.test(raw)) return raw;
  return `/skill:evidence-grounded-writer [USER_MESSAGE]\n${raw}`;
}
