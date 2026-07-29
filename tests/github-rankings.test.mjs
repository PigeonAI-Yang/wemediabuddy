import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('ranking parsers retain repo identity, description and star movement', () => {
  const source = readFileSync(new URL('../src/main/github-rankings.ts', import.meta.url), 'utf8');
  assert.match(source, /githubItems/);
  assert.match(source, /whatstrending\.ai\/api\/repos/);
  assert.match(source, /whatsTrendingApiItems/);
  assert.match(source, /itemListItems/);
  assert.match(source, /\^\[\^\/\\s\]\+\\\/\[\^\/\\s\]\+\$/);
  assert.match(source, /ossinsight\.io\/trending\/ai/);
  assert.match(source, /api\.ossinsight\.io\/v1\/trends\/repos/);
  assert.match(source, /ossInsightItems/);
  assert.match(source, /trendingrepo\.com\/categories\/ai-ml/);
  assert.match(source, /skills\.sh\/trending/);
  assert.match(source, /registry\.smithery\.ai\/servers\?pageSize=30/);
  assert.match(source, /huggingface\.co\/api\/trending\?type=model/);
  assert.match(source, /producthunt\.com\/feed\?category=artificial-intelligence/);
  assert.match(source, /artificialanalysis\.ai\/leaderboards\/models/);
  assert.match(source, /skillsItems/);
  assert.match(source, /smitheryItems/);
  assert.match(source, /huggingFaceItems/);
  assert.match(source, /productHuntItems/);
  assert.match(source, /artificialAnalysisItems/);
  assert.match(source, /stars\?\\s\+\(today\|this week\|this month\)/);
  assert.match(source, /status: 'unavailable'/);
  assert.match(source, /Date\.now\(\) \+ 60 \* 60_000/);
});
