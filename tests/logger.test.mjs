import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, flog, recentLogs, clearLogs } from '../src/feed/logger.js';

test('redact: credentials by key name and by value shape', () => {
  const r = redact({ accessToken: 'abc', client_secret: 'x', api_secret: 'y', password: 'p', otp: '123456', mpin: '1234', Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.aaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb', ok: 'fine', url: 'wss://h/feeds?requestId=1&code=ONETIME' });
  for (const k of ['accessToken', 'client_secret', 'api_secret', 'password', 'otp', 'mpin', 'Authorization']) assert.equal(r[k], '[REDACTED]', k);
  assert.equal(r.ok, 'fine');
  assert.ok(!/ONETIME/.test(r.url));
  assert.equal(redact('Authorization failed: Bearer abc.def.ghi'), 'Authorization failed: Bearer [REDACTED]');
});
test('flog stores redacted data only', () => {
  clearLogs(); flog('x', { token: 'SECRET', n: 1 });
  assert.deepEqual(recentLogs()[0].data, { token: '[REDACTED]', n: 1 });
});
