import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

test('listKnowledgeTopics returns page shape with content/publication counts and hasMore', async () => {
  await promisify(execFile)(process.execPath, ['tests/knowledge-topics-list-child.mjs'], { cwd: process.cwd() });
});
