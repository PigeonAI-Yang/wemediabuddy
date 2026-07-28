export function validateWechatArticleUrl(articleUrl: string): URL {
  const url = new URL(articleUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'mp.weixin.qq.com' || !url.pathname.startsWith('/s')) throw new Error('请输入发布后的微信公众号文章链接。');
  return url;
}
