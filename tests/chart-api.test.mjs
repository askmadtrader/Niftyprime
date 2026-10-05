import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchChartCandles, fetchChartIntraday, ApiError } from '../src/api';

const KEY = 'NSE_INDEX|Nifty 50';
const TOKEN = 'SECRET-TOKEN-VALUE-123';
const NOW = Date.UTC(2026, 9, 5, 6, 0, 0);          // Mon 05-Oct-2026 11:30 IST
const row = (iso, o = 100, h = 105, l = 95, c = 102) => [iso, o, h, l, c, 0, 0];

// routes: [(url) => response | undefined]
function stub(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(url);
    for (const r of routes) { const x = r(url); if (x) return { status: x.status || 200, ok: (x.status || 200) < 300, json: async () => x.body }; }
    return { status: 200, ok: true, json: async () => ({ status: 'success', data: { candles: [] } }) };
  };
  return calls;
}
const ok = (candles) => ({ body: { status: 'success', data: { candles } } });
const isIntraday = (u) => u.includes('/intraday/');

test('intraday + chunked history are merged, de-duplicated and sorted oldest -> newest', async () => {
  const calls = stub([
    (u) => isIntraday(u) && ok([row('2026-10-05T09:16:00+05:30'), row('2026-10-05T09:15:00+05:30', 1, 9, 1, 5)]),
    (u) => !isIntraday(u) && ok([row('2026-10-05T09:15:00+05:30', 50, 60, 40, 55), row('2026-10-03T15:29:00+05:30'), row('2026-10-02T15:29:00+05:30')]),
  ]);
  const r = await fetchChartCandles(TOKEN, KEY, 1, NOW);
  const ts = r.candles.map((c) => new Date(c.t + 5.5 * 3600e3).toISOString().slice(0, 16));
  assert.equal(new Set(ts).size, ts.length, 'no duplicate timestamps');
  assert.deepEqual(ts, [...ts].sort());
  assert.ok(ts.includes('2026-10-02T15:29') && ts.includes('2026-10-05T09:16'));
  assert.equal(r.candles.find((c) => c.t === Date.parse('2026-10-05T09:15:00+05:30')).o, 1, 'intraday copy wins over the history copy');
  assert.equal(r.partial, false);
  assert.ok(calls.every((u) => !u.includes(TOKEN)), 'token only travels in the header');
});

test('1m history asks for 28 days (to-date first, then from-date); 15m for 84 days in 28-day chunks', async () => {
  let calls = stub([]);
  await fetchChartCandles(TOKEN, KEY, 1, NOW);
  const h1 = calls.filter((u) => !isIntraday(u));
  assert.equal(h1.length, 1);
  assert.match(h1[0], /\/v3\/historical-candle\/NSE_INDEX%7CNifty%2050\/minutes\/1\/2026-10-05\/2026-09-08$/);
  calls = stub([]);
  await fetchChartCandles(TOKEN, KEY, 15, NOW);
  const h15 = calls.filter((u) => !isIntraday(u));
  assert.equal(h15.length, 3);
  assert.match(h15[0], /minutes\/15\/2026-10-05\/2026-09-08$/);
  assert.match(h15[1], /minutes\/15\/2026-09-07\/2026-08-11$/);
  assert.match(h15[2], /minutes\/15\/2026-08-10\/2026-07-14$/);
});

test('1h uses the native Upstox hours/1 endpoint, never minutes/60', async () => {
  const calls = stub([]);
  await fetchChartCandles(TOKEN, KEY, 60, NOW);
  assert.ok(calls.length >= 2 && calls.every((u) => u.includes('/hours/1')));
  assert.ok(calls.every((u) => !u.includes('minutes/60')));
});

test('a failed history chunk gives partial data, not an error and not invented candles', async () => {
  stub([
    (u) => isIntraday(u) && ok([row('2026-10-05T09:15:00+05:30')]),
    (u) => u.includes('/2026-09-07/') && { status: 400, body: { errors: [{ message: 'range too large' }] } },
    (u) => !isIntraday(u) && ok([row('2026-10-02T15:29:00+05:30')]),
  ]);
  const r = await fetchChartCandles(TOKEN, KEY, 15, NOW);
  assert.equal(r.candles.length, 2); assert.equal(r.partial, true); assert.match(r.errors[0], /range too large/);
});

test('everything failing and nothing loaded => error; AUTH / RATE / NETWORK always propagate', async () => {
  stub([() => ({ status: 500, body: { errors: [{ message: 'boom' }] } })]);
  await assert.rejects(() => fetchChartCandles(TOKEN, KEY, 1, NOW), (e) => e instanceof ApiError && e.kind === 'SERVER');
  stub([(u) => !isIntraday(u) && { status: 401, body: {} }]);
  await assert.rejects(() => fetchChartCandles(TOKEN, KEY, 1, NOW), (e) => e.kind === 'AUTH');
  stub([(u) => isIntraday(u) && { status: 429, body: {} }]);
  await assert.rejects(() => fetchChartIntraday(TOKEN, KEY, 1), (e) => e.kind === 'RATE');
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  await assert.rejects(() => fetchChartCandles(TOKEN, KEY, 5, NOW), (e) => e.kind === 'NETWORK');
});

test('market closed / pre-open: empty intraday is fine, history still renders', async () => {
  stub([(u) => !isIntraday(u) && ok([row('2026-10-03T15:29:00+05:30'), row('2026-10-03T15:14:00+05:30')])]);
  const r = await fetchChartCandles(TOKEN, KEY, 15, NOW);
  assert.equal(r.candles.length, 2); assert.equal(r.partial, false);
  assert.equal(r.candles[0].t < r.candles[1].t, true);
});

test('malformed candle rows are dropped, not repaired', async () => {
  stub([(u) => isIntraday(u) && ok([row('2026-10-05T09:15:00+05:30'), row('2026-10-05T09:16:00+05:30', 100, 90, 95, 99), ['bad'], row('not-a-date')])]);
  const r = await fetchChartCandles(TOKEN, KEY, 1, NOW);
  assert.equal(r.candles.length, 1);
});

test('unsupported timeframe is rejected before any request', async () => {
  const calls = stub([]);
  await assert.rejects(() => fetchChartCandles(TOKEN, KEY, 7, NOW), (e) => e.kind === 'DATA');
  assert.equal(calls.length, 0);
});
