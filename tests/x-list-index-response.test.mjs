import assert from 'node:assert/strict';
import test from 'node:test';
import { extractListsFromManagementPayload } from '../src/main/platforms/x-list-browser.ts';

test('management timeline response resolves a list without a DOM list anchor', () => {
  // Current X list cards are role=link divs with no /i/lists/<id> anchor. The
  // management timeline response remains the authoritative read-only ID source.
  const payload = {
    data: {
      viewer: {
        lists_management: {
          timeline: {
            instructions: [{
              entries: [{
                entryId: 'list-2082851520417255750',
                content: {
                  itemContent: {
                    list: {
                      id_str: '2082851520417255750',
                      name: 'AI前沿',
                      mode: 'Public',
                      following: true,
                      is_member: false,
                      member_count: 18,
                      user_results: { result: { core: { screen_name: 'KimbomArtist' } } }
                    }
                  }
                }
              }]
            }]
          }
        }
      }
    }
  };

  assert.deepEqual(extractListsFromManagementPayload(payload), [{
    listId: '2082851520417255750',
    canonicalUrl: 'https://x.com/i/lists/2082851520417255750',
    name: 'AI前沿',
    ownerHandle: '@KimbomArtist',
    kind: 'owned'
  }]);
});
