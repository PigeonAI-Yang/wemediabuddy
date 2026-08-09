import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAcceptanceFeedUrl } from '../src/main/release-feed.ts';

test('acceptance feed accepts only v-prefixed semantic versions', () => {
  assert.equal(buildAcceptanceFeedUrl(undefined), undefined);
  assert.equal(
    buildAcceptanceFeedUrl(' v0.2.0-rc.1+acceptance '),
    'https://github.com/PigeonAI-Yang/wemediabuddy/releases/download/v0.2.0-rc.1+acceptance'
  );
  for (const invalid of ['0.2.0', 'latest', 'https://example.com/feed', 'v01.2.3', 'v1.2', 'v1.2.3-01']) {
    assert.throws(() => buildAcceptanceFeedUrl(invalid), /必须是 v<semver>/);
  }
});
