import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('an empty initial X List page is retryable but never paginated', async () => {
  const source = await readFile(new URL('../src/renderer/x-lists-view.tsx', import.meta.url), 'utf8');
  assert.match(source, /setPostsHasMore\(mapped\.length > 0 && Boolean\(result\.hasMore\)\)/);
  assert.match(source, /posts\.length === 0[\s\S]*?当前没有可读动态[\s\S]*?重新读取/);
  assert.match(source, /postsHasMore && <div className="x-timeline-more"/);
});
