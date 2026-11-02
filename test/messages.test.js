// Friendly Vietnamese error mapping: server error code -> sentence shown in the panel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { friendlyError, describeConnection, cleanUsername, ERROR_MESSAGES, GENERIC_ERROR } from '../public/js/messages.js';
import { describeError } from '../src/tiktok.js';

const named = (name, message = 'x', extra = {}) => Object.assign(new Error(message), { name }, extra);

test('known error codes map to Vietnamese sentences', () => {
  assert.equal(friendlyError('user_offline'), 'Không tìm thấy phòng live — bạn đã bật LIVE chưa?');
  assert.equal(friendlyError('room_not_found'), friendlyError('user_offline'));
  assert.match(friendlyError('user_not_found'), /Không tìm thấy tên TikTok/);
  assert.match(friendlyError('network'), /Internet/);
  assert.match(friendlyError('rate_limited'), /Thử lại/);
  assert.match(friendlyError('server_unreachable'), /BAT-DAU/);
});

test('unknown or missing codes fall back to the generic message', () => {
  for (const code of ['nope', '', undefined, null, 42, 'toString', '__proto__', 'constructor']) {
    assert.equal(friendlyError(code), GENERIC_ERROR, String(code));
  }
});

test('no friendly message leaks English, JSON or stack traces', () => {
  for (const [code, text] of Object.entries({ ...ERROR_MESSAGES, generic: GENERIC_ERROR })) {
    assert.doesNotMatch(text, /[{}[\]]|Error|undefined|null|http/i, code);
    assert.match(text, /[ăâđêôơưàáạảãèéẹẻẽìíịỉĩòóọỏõùúụủũỳýỵỷỹ]/i, `${code} is Vietnamese`);
  }
});

test('every code the TikTok adapter can emit has a dedicated message', () => {
  const cases = [
    [named('UserOfflineError'), 'user_offline'],
    [named('InvalidUniqueIdError'), 'user_not_found'],
    [named('SignatureRateLimitError', 'too many'), 'rate_limited'],
    [named('ConnectTimeoutError', 'took too long'), 'timeout'],
    [named('TypeError', 'fetch failed'), 'network'],
    [named('Error', 'getaddrinfo ENOTFOUND www.tiktok.com'), 'network'],
    [named('Error', 'Failed to retrieve room id from page source'), 'room_not_found'],
    [named('WeirdError', 'something odd'), 'unknown'],
  ];
  for (const [err, code] of cases) {
    const d = describeError(err);
    assert.equal(d.code, code, err.message);
    assert.ok(d.message.length <= 300);
    if (code !== 'unknown') assert.notEqual(friendlyError(code), GENERIC_ERROR, `${code} has a specific message`);
  }
  for (const code of ['lib_load', 'stream_ended', 'invalid_username']) assert.ok(Object.hasOwn(ERROR_MESSAGES, code), code);
});

test('describeConnection gives a plain status line per state', () => {
  assert.deepEqual(describeConnection({ state: 'connecting', username: 'linh' }), { tone: 'busy', text: 'Đang kết nối @linh…', canRetry: false, connected: false });
  const ok = describeConnection({ state: 'connected', username: 'linh' });
  assert.equal(ok.text, 'Đã kết nối tới phòng live! (@linh)');
  assert.equal(ok.connected, true);
  const bad = describeConnection({ state: 'error', errorCode: 'user_offline', error: 'UserOfflineError: {"raw":1}' });
  assert.equal(bad.text, 'Không tìm thấy phòng live — bạn đã bật LIVE chưa?');
  assert.equal(bad.canRetry, true, 'error offers "Thử lại"');
  assert.doesNotMatch(bad.text, /raw|\{/, 'raw error never shown');
  assert.equal(describeConnection({ state: 'ended' }).canRetry, true);
  assert.equal(describeConnection({ state: 'disconnected' }).tone, 'error');
  assert.equal(describeConnection().tone, 'idle');
});

test('cleanUsername accepts @name, plain name and pasted TikTok links', () => {
  assert.equal(cleanUsername('  @linh.ng '), 'linh.ng');
  assert.equal(cleanUsername('linh_ng'), 'linh_ng');
  assert.equal(cleanUsername('https://www.tiktok.com/@linh.ng/live'), 'linh.ng');
  assert.equal(cleanUsername('Linh Nguyễn'), '');
  assert.equal(cleanUsername('a'), '');
  assert.equal(cleanUsername(undefined), '');
});
