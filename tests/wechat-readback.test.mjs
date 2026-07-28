import assert from 'node:assert/strict';
import test from 'node:test';
import { validateWechatArticleUrl } from '../src/main/platforms/wechat-url.ts';

test('WeChat readback accepts only published article URLs', () => {
  assert.equal(validateWechatArticleUrl('https://mp.weixin.qq.com/s/example').hostname, 'mp.weixin.qq.com');
  assert.throws(() => validateWechatArticleUrl('https://example.com/s/example'), /公众号文章链接/);
  assert.throws(() => validateWechatArticleUrl('http://mp.weixin.qq.com/s/example'), /公众号文章链接/);
});
