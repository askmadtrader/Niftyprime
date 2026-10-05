import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { FeedClient } from '../src/feed/client.js';
import { decodeFeedResponse } from '../src/feed/proto.js';
import { initialFeedState, applyFeedResponse, serverNow, NIFTY_KEY, VIX_KEY, WATCH_KEYS } from '../src/feed/feedState.js';
import { computeFreshness, THRESHOLDS } from '../src/feed/freshness.js';
import { evaluateGate } from '../src/feed/gate.js';
import { selectCandles } from '../src/feed/session.js';
import { deriveStatus } from '../src/feed/status.js';
import { analyze, decide } from '../src/engine.js';
import { marketInfoFrame, indexTick, ist } from './helpers.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return; await wait(10); } throw new Error('timeout waiting for condition'); }

// ================================================================ real sockets, real binary frames
test('E2E over a real WebSocket: market_info -> snapshot -> ticks; drop -> reconnect -> resubscribe exactly once per connection', async () => {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.on('listening', r));
  const port = wss.address().port;
  const conns = []; // per connection: { subs: [json], binary: bool }
  const T0 = Date.now();
  wss.on('connection', (sock) => {
    const rec = { subs: [], binary: [], sock }; conns.push(rec);
    sock.on('message', (data, isBinary) => {
      rec.binary.push(isBinary); const req = JSON.parse(data.toString('utf8')); rec.subs.push(req);
      // Upstox order: 1) market_info  2) snapshot  3) live ticks
      sock.send(marketInfoFrame({ NSE_INDEX: 'NORMAL_OPEN', NSE_FO: 'NORMAL_OPEN', NSE_EQ: 'NORMAL_OPEN' }, Date.now()), { binary: true });
      const day = { o: 22350, h: 22460, l: 22310, ts: T0 - 3600e3 };
      sock.send(indexTick(NIFTY_KEY, 22400.5, Date.now(), 22300, Date.now(), day), { binary: true });
      sock.send(indexTick(VIX_KEY, 13.4, Date.now(), 13.1, Date.now()), { binary: true });
      rec.tickTimer = setInterval(() => { try { sock.send(indexTick(NIFTY_KEY, 22400.5 + conns.length, Date.now(), 22300, Date.now(), day), { binary: true }); } catch (e) { /* closed */ } }, 50);
    });
    sock.on('close', () => clearInterval(rec.tickTimer));
  });

  let fs = initialFeedState(); const states = [];
  const client = new FeedClient({
    authorize: async () => `ws://127.0.0.1:${port}/feeds?requestId=1&code=ONETIME`, // a real run would call /v3/feed/market-data-feed/authorize
    keys: WATCH_KEYS, primaryKey: NIFTY_KEY, WebSocketImpl: WebSocket,
    config: { baseMs: 50, maxMs: 200 }, isMarketOpen: () => fs.market.state === 'NORMAL_OPEN',
    onState: (s) => { states.push(s.conn); if (s.conn === 'CONNECTED') fs = { ...initialFeedState(), clockOffset: fs.clockOffset, clockSynced: fs.clockSynced }; },
    onFeed: (resp, at) => { if (resp) fs = applyFeedResponse(fs, resp, at); },
  });
  client.start();
  await until(() => client.state === 'LIVE');

  // --- data as the app would present it
  const now = Date.now();
  const q = fs.instruments[NIFTY_KEY]; const v = fs.instruments[VIX_KEY];
  assert.ok(q && q.ltp > 22400 && q.prev === 22300 && q.tsValid);
  assert.ok(v && v.ltp === 13.4 && Math.abs(v.change - 0.3) < 1e-9);
  assert.equal(fs.market.state, 'NORMAL_OPEN');
  assert.deepEqual([q.open, q.high, q.low], [22350, 22460, 22310]);
  assert.equal(conns.length, 1); assert.equal(conns[0].subs.length, 1);
  assert.deepEqual(conns[0].binary, [true], 'subscription arrived as a BINARY frame');
  assert.deepEqual(conns[0].subs[0].data.instrumentKeys, [NIFTY_KEY, VIX_KEY]);
  assert.equal(conns[0].subs[0].method, 'sub');
  let st = deriveStatus({ conn: 'CONNECTED', feed: { conn: client.state, connMsg: '' }, market: fs.market, niftyFresh: computeFreshness({ inst: q, conn: client.state, marketState: fs.market.state, now, serverNow: serverNow(fs, now), th: THRESHOLDS.nifty }) });
  assert.equal(st.key, 'LIVE');

  // --- kill the connection server-side: must go RECONNECTING, never keep showing LIVE
  conns[0].sock.terminate();
  await until(() => client.state === 'RECONNECTING' || conns.length > 1);
  assert.ok(states.includes('RECONNECTING'));
  st = deriveStatus({ conn: 'CONNECTED', feed: { conn: 'RECONNECTING', connMsg: 'x' }, market: fs.market, niftyFresh: { status: 'DISCONNECTED' } });
  assert.equal(st.key, 'RECONNECTING'); assert.match(st.sub, /temporarily unavailable/);

  // --- reconnect + resubscribe
  await until(() => client.state === 'LIVE' && conns.length === 2);
  assert.equal(conns[1].subs.length, 1, 'exactly one subscription on the new connection');
  assert.equal(conns[0].subs.length, 1, 'old connection never re-subscribed');
  assert.ok(fs.instruments[NIFTY_KEY].ltp > 22400);

  // --- stop => socket closed, server sees the close, no further connections
  client.stop();
  await wait(400);
  assert.equal(conns.length, 2); assert.equal(client.state, 'DISCONNECTED');
  wss.close();
});

// ================================================================ closed market -> WAIT, previous session labelled
const candlesOf = (y, mo, d, n) => Array.from({ length: n }, (_, i) => ({ t: ist(y, mo, d, 9, 15 + i), o: 22400 + i, h: 22405 + i, l: 22395 + i, c: 22402 + i, v: 0 }));
function run({ now, market, conn = 'LIVE', nifty, candles }) {
  const sNow = now;
  const nf = computeFreshness({ inst: nifty, conn, marketState: market.state, now, serverNow: sNow, th: THRESHOLDS.nifty });
  const sel = selectCandles(candles, sNow, market.state);
  const gate = evaluateGate({ conn, market, nifty, niftyFresh: nf, serverNow: sNow, candles: sel.info });
  let a = analyze({ now, sNow, gate, session: sel.info, quote: nifty, vix: null, candles: sel.candles, chain: null, chainAt: 0, global: null, history: [], settings: { strikes: 10, confThr: 60, sens: 'MED' }, expiry: null });
  a = decide(a, { strikes: 10, confThr: 60, sens: 'MED' }, null);
  return { a, gate, sel, nf };
}
test('MARKET CLOSED on Sunday with Thursday 01-OCT-2026 data: signal stays WAIT, previous session clearly labelled', () => {
  const now = ist(2026, 10, 4, 12, 0);
  const lastTrade = ist(2026, 10, 1, 15, 29, 59);
  const nifty = { ltp: 22421.95, prev: 22300, change: 121.95, pct: 0.55, ltt: lastTrade, tsValid: true, receivedAt: now - 5000 };
  const r = run({ now, market: { state: 'CLOSED', index: 'CLOSED', fno: 'CLOSED' }, nifty, candles: candlesOf(2026, 10, 1, 375) });
  assert.equal(r.a.signal, 'WAIT'); assert.equal(r.a.live, false); assert.equal(r.a.confidence, null); assert.equal(r.a.recommended, null);
  assert.equal(r.a.waitReason, 'Market closed — no live signal');
  assert.equal(r.a.session.label, 'PREVIOUS SESSION 01-OCT-2026');
  assert.equal(r.a.session.usable, false);
  assert.ok(r.a.tech, 'previous-session analytics may still be displayed');
  assert.equal(deriveStatus({ conn: 'CONNECTED', feed: { conn: 'LIVE', connMsg: '' }, market: { state: 'CLOSED' }, niftyFresh: r.nf }).key, 'MARKET CLOSED');
});
test('market OPEN but only previous-session candles exist: candles are dropped from live analytics (not relabelled as live)', () => {
  const now = ist(2026, 10, 5, 9, 20, 0);
  const nifty = { ltp: 22421.95, prev: 22300, change: 121.95, pct: 0.55, ltt: now - 800, tsValid: true, receivedAt: now - 700 };
  const r = run({ now, market: { state: 'NORMAL_OPEN', index: 'NORMAL_OPEN', fno: 'NORMAL_OPEN' }, nifty, candles: candlesOf(2026, 10, 1, 375) });
  assert.equal(r.a.signal, 'WAIT'); assert.equal(r.a.tech, null, 'no analytics derived from yesterday while the market is live');
  assert.match(r.a.waitReason, /Current-session candles unavailable/);
  assert.equal(r.sel.candles.length, 0);
});
test('feed disconnected during market hours: WAIT with disconnect reason, status DISCONNECTED', () => {
  const now = ist(2026, 10, 5, 11, 0, 0);
  const nifty = { ltp: 22421.95, prev: 22300, change: 121.95, pct: 0.55, ltt: now - 60e3, tsValid: true, receivedAt: now - 59e3 };
  const r = run({ now, conn: 'DISCONNECTED', market: { state: 'NORMAL_OPEN', index: 'NORMAL_OPEN', fno: 'NORMAL_OPEN' }, nifty, candles: candlesOf(2026, 10, 5, 100) });
  assert.equal(r.a.signal, 'WAIT'); assert.equal(r.a.waitReason, 'Live feed disconnected — no live signal');
  assert.equal(deriveStatus({ conn: 'CONNECTED', feed: { conn: 'DISCONNECTED', connMsg: 'closed' }, market: { state: 'NORMAL_OPEN' }, niftyFresh: r.nf }).key, 'DISCONNECTED');
});
test('stale NIFTY during market hours: STALE status and WAIT', () => {
  const now = ist(2026, 10, 5, 11, 0, 0);
  const nifty = { ltp: 22421.95, prev: 22300, change: 121.95, pct: 0.55, ltt: now - 50e3, tsValid: true, receivedAt: now - 50e3 };
  const r = run({ now, market: { state: 'NORMAL_OPEN', index: 'NORMAL_OPEN', fno: 'NORMAL_OPEN' }, nifty, candles: candlesOf(2026, 10, 5, 100) });
  assert.equal(r.nf.status, 'STALE'); assert.equal(r.a.signal, 'WAIT'); assert.equal(r.a.waitReason, 'NIFTY data is stale');
  assert.equal(deriveStatus({ conn: 'CONNECTED', feed: { conn: 'LIVE', connMsg: '' }, market: { state: 'NORMAL_OPEN' }, niftyFresh: r.nf }).key, 'STALE');
});
test('missing NIFTY and invalid timestamp: WAIT', () => {
  const now = ist(2026, 10, 5, 11, 0, 0); const m = { state: 'NORMAL_OPEN', index: 'NORMAL_OPEN', fno: 'NORMAL_OPEN' };
  const a = run({ now, market: m, nifty: undefined, candles: candlesOf(2026, 10, 5, 100) });
  assert.equal(a.a.signal, 'WAIT'); assert.equal(a.a.waitReason, 'NIFTY data unavailable'); assert.equal(a.a.spot, null);
  const b = run({ now, market: m, nifty: { ltp: 1, ltt: null, tsValid: false, receivedAt: now }, candles: candlesOf(2026, 10, 5, 100) });
  assert.equal(b.a.signal, 'WAIT'); assert.match(b.a.waitReason, /timestamp invalid/);
});
test('all live and current: gate opens and the engine proceeds (falls through to the existing option-chain checks)', () => {
  const now = ist(2026, 10, 5, 11, 0, 0);
  const nifty = { ltp: 22421.95, prev: 22300, change: 121.95, pct: 0.55, ltt: now - 800, tsValid: true, receivedAt: now - 700 };
  const cs = candlesOf(2026, 10, 5, 100).map((c, i) => ({ ...c, t: now - (100 - i) * 60e3 + 30e3 }));
  const r = run({ now, market: { state: 'NORMAL_OPEN', index: 'NORMAL_OPEN', fno: 'NORMAL_OPEN' }, nifty, candles: cs });
  assert.equal(r.gate.ok, true); assert.equal(r.nf.status, 'LIVE');
  assert.equal(r.a.waitReason, 'Option chain unavailable', 'only the (PART 2) option-chain check remains');
  assert.ok(r.a.tech);
});
