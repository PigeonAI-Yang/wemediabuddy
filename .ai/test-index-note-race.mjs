
// Pure logic check for index refresh note races (no browser).
import assert from 'node:assert/strict';

function isIgnorableIndexError(message) {
  return /已切换到更新的 X 操作|旧请求已取消|superseded/i.test(String(message));
}

function noteFromIndexError(message, cachedCount) {
  if (isIgnorableIndexError(message)) return null; // keep previous note
  if (!cachedCount) return message;
  const short = /超时/.test(message) ? '后台刷新超时' : (/占用|冷却/.test(message) ? '后台繁忙' : '后台刷新失败');
  return `${short}，继续显示缓存 · ${cachedCount} 个 List。`;
}

// Stale superseded must not overwrite cache success note.
assert.equal(noteFromIndexError('已切换到更新的 X 操作，旧请求已取消。', 6), null);
assert.equal(noteFromIndexError('X 操作超时（45s）。请重试。', 6), '后台刷新超时，继续显示缓存 · 6 个 List。');
assert.equal(noteFromIndexError('X 正在冷却，12 秒后再试。', 6), '后台繁忙，继续显示缓存 · 6 个 List。');
assert.equal(noteFromIndexError('boom', 0), 'boom');

// Generation gate: older failure after newer success is dropped.
let note = '已更新 @KimbomArtist 的 6 个可见 List。';
let gen = 2;
const apply = (requestId, nextNote) => {
  if (requestId !== gen) return; // stale
  if (nextNote == null) return;
  note = nextNote;
};
apply(1, noteFromIndexError('X 操作超时（45s）。请重试。', 6)); // stale gen
assert.equal(note, '已更新 @KimbomArtist 的 6 个可见 List。');
apply(2, noteFromIndexError('已切换到更新的 X 操作，旧请求已取消。', 6));
assert.equal(note, '已更新 @KimbomArtist 的 6 个可见 List。');
console.log(JSON.stringify({ ok: true }));
