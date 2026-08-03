import assert from 'node:assert/strict';
import test from 'node:test';
import { routePiSkillPrompt } from '../src/main/pi-skill-routing.ts';

test('factual writing keywords deterministically invoke the evidence Skill and preserve visible user text', () => {
  const prompts = [
    '请基于这个题材写一篇内容丰富扎实的文章',
    '把这些资料写成小红书文案',
    '补充案例和数据，扩写成稿',
    '帮我事实核查后写口播稿'
  ];
  for (const prompt of prompts) {
    const routed = routePiSkillPrompt(prompt);
    assert.match(routed, /^\/skill:evidence-grounded-writer \[USER_MESSAGE\]\n/);
    assert.equal(routed.slice(routed.indexOf('[USER_MESSAGE]\n') + '[USER_MESSAGE]\n'.length), prompt);
  }
});

test('routing leaves fiction, spelling-only edits, ordinary chat and explicit Skill commands alone', () => {
  const prompts = ['写一篇小说', '只改错别字', '你好', '/skill:another-skill do it', '写一篇纯虚构故事'];
  for (const prompt of prompts) assert.equal(routePiSkillPrompt(prompt), prompt);
});
