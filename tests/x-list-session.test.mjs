import assert from 'node:assert/strict';
import test from 'node:test';
import { cubicBezier, isPyaireaderXProfile, isXHomeUrl, parseXListId, xListUrl } from '../src/main/platforms/x-list-primitives.ts';

test('X List session accepts only the Pyaireader profile and stable List URLs', () => {
  assert.equal(isPyaireaderXProfile({ id: 'edge:pyaireader-default', cdpUrl: 'http://127.0.0.1:9334/' }), true);
  assert.equal(isPyaireaderXProfile({ id: 'edge:Default', cdpUrl: 'http://127.0.0.1:9334' }), false);
  assert.equal(parseXListId('https://x.com/i/lists/1234567890'), '1234567890');
  assert.equal(parseXListId('https://x.com/i/lists/not-a-list'), null);
  assert.equal(xListUrl('1234567890'), 'https://x.com/i/lists/1234567890');
  assert.equal(isXHomeUrl('https://x.com/home'), true);
  assert.equal(isXHomeUrl('https://x.com/i/lists/1234567890'), false);
});

test('human pointer curve starts and ends at the intended coordinates', () => {
  const start = { x: 10, y: 20 };
  const end = { x: 110, y: 220 };
  assert.deepEqual(cubicBezier(start, { x: 20, y: 80 }, { x: 90, y: 160 }, end, 0), start);
  assert.deepEqual(cubicBezier(start, { x: 20, y: 80 }, { x: 90, y: 160 }, end, 1), end);
});
