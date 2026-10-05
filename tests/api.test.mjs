import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeFeed, ApiError } from '../src/api';

const SECRET = 'SECRET-TOKEN-VALUE-123';
function stubFetch(status, body) {
  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return { status, ok: status >= 200 && status < 300, json: async () => body }; };
  return calls;
}
const ok = (data) => ({ status: 'success', data });

test('authorizeFeed calls the V3 authorize endpoint; token goes only in the Authorization header', async () => {
  const calls = stubFetch(200, ok({ authorized_redirect_uri: 'wss://example.test/feeds?requestId=r&code=c' }));
  const url = await authorizeFeed(SECRET);
  assert.equal(url, 'wss://example.test/feeds?requestId=r&code=c');
  assert.equal(calls[0].url, 'https://api.upstox.com/v3/feed/market-data-feed/authorize');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer ' + SECRET);
  assert.ok(!calls[0].url.includes(SECRET));
});

test('authorizeFeed accepts the camelCase field Upstox also returns', async () => {
  stubFetch(200, ok({ authorizedRedirectUri: 'wss://example.test/feeds?code=c' }));
  assert.equal(await authorizeFeed(SECRET), 'wss://example.test/feeds?code=c');
});

test('authorizeFeed rejects a response without a wss:// URL', async () => {
  stubFetch(200, ok({ authorized_redirect_uri: 'https://not-a-socket' }));
  await assert.rejects(() => authorizeFeed(SECRET), (e) => e instanceof ApiError && e.kind === 'DATA');
  stubFetch(200, ok({}));
  await assert.rejects(() => authorizeFeed(SECRET), (e) => e.kind === 'DATA');
});

test('401 = AUTH (expired session); 403 = FORBIDDEN (retryable, must not look like an expired session)', async () => {
  stubFetch(401, { status: 'error' });
  await assert.rejects(() => authorizeFeed(SECRET), (e) => e.kind === 'AUTH' && e.status === 401);
  stubFetch(403, { status: 'error' });
  await assert.rejects(() => authorizeFeed(SECRET), (e) => e.kind === 'FORBIDDEN' && e.status === 403 && !/expired/i.test(e.message));
});

test('429 and 5xx surface as RATE / SERVER (retryable by the feed client)', async () => {
  stubFetch(429, {});
  await assert.rejects(() => authorizeFeed(SECRET), (e) => e.kind === 'RATE');
  stubFetch(500, { errors: [{ message: 'boom' }] });
  await assert.rejects(() => authorizeFeed(SECRET), (e) => e.kind === 'SERVER');
});

test('error messages never contain the token', async () => {
  for (const s of [401, 403, 429, 500]) {
    stubFetch(s, {});
    try { await authorizeFeed(SECRET); } catch (e) { assert.ok(!String(e.message).includes(SECRET)); }
  }
});
