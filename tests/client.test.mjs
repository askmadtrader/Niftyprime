import test from 'node:test';
import assert from 'node:assert/strict';
import { FeedClient, CONN } from '../src/feed/client.js';
import { decodeFeedResponse } from '../src/feed/proto.js';
import { clearLogs, recentLogs } from '../src/feed/logger.js';
import { ltpcTick, marketInfoFrame, toArrayBuffer, NIFTY, VIX } from './helpers.mjs';

// ---- fakes -------------------------------------------------------------------------------------------
class FakeWS {
  static all = [];
  constructor(url) { this.url = url; this.sent = []; this.closed = false; this.binaryType = ''; FakeWS.all.push(this); }
  send(d) { if (this.closed) throw new Error('closed'); this.sent.push(d); }
  close() { this.closed = true; }
  // test drivers
  open() { this.onopen && this.onopen(); }
  msg(u8) { this.onmessage && this.onmessage({ data: toArrayBuffer(u8) }); }
  drop(code = 1006) { this.onclose && this.onclose({ code, reason: '' }); }
  fail() { this.onerror && this.onerror({ message: 'boom' }); }
}
function clock() {
  let t = 1_000_000; let id = 0; const timers = new Map();
  return {
    now: () => t, setTimeoutFn: (fn, ms) => { id += 1; timers.set(id, { fn, at: t + ms }); return id; },
    clearTimeoutFn: (i) => timers.delete(i), pending: () => timers.size,
    advance(ms) { const end = t + ms; for (;;) { const next = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; t = next[1].at; timers.delete(next[0]); next[1].fn(); } t = end; },
    nextDelay() { return Math.min(...[...timers.values()].map((v) => v.at - t)); },
  };
}
const flush = () => new Promise((r) => setImmediate(r));
function make(over = {}) {
  FakeWS.all = []; clearLogs();
  const clk = clock(); const states = []; const feeds = []; let authCalls = 0;
  const c = new FeedClient({
    authorize: over.authorize || (async () => { authCalls += 1; return `wss://feed.example/test?code=SECRET-ONE-TIME-${authCalls}`; }),
    WebSocketImpl: FakeWS, keys: [NIFTY, VIX], primaryKey: NIFTY, random: () => 0.5, // jitter 0 at 0.5
    now: clk.now, setTimeoutFn: clk.setTimeoutFn, clearTimeoutFn: clk.clearTimeoutFn,
    isMarketOpen: over.isMarketOpen || (() => true),
    onState: (s) => states.push(s.conn), onFeed: (r) => feeds.push(r), onAuthError: over.onAuthError,
    config: over.config,
  });
  return { c, clk, states, feeds, auths: () => authCalls };
}

test('lifecycle: CONNECTING -> CONNECTED -> SUBSCRIBED -> LIVE; binary subscription sent exactly once', async () => {
  const { c, states } = make();
  c.start(); await flush();
  const ws = FakeWS.all[0];
  assert.equal(ws.binaryType, 'arraybuffer');
  ws.open();
  assert.equal(ws.sent.length, 1);
  assert.ok(ws.sent[0] instanceof Uint8Array, 'subscription must be a BINARY frame, not text');
  const req = JSON.parse(Buffer.from(ws.sent[0]).toString('utf8'));
  assert.equal(req.method, 'sub'); assert.equal(req.data.mode, 'full'); assert.deepEqual(req.data.instrumentKeys, [NIFTY, VIX]); assert.equal(typeof req.guid, 'string');
  ws.msg(marketInfoFrame({ NSE_INDEX: 'NORMAL_OPEN' }));
  assert.equal(c.state, CONN.SUBSCRIBED, 'market_info alone does not make the feed LIVE');
  ws.msg(ltpcTick(NIFTY, 22421.95, 1_000_000, 22300, 1_000_100));
  assert.equal(c.state, CONN.LIVE);
  assert.deepEqual(states, ['CONNECTING', 'CONNECTED', 'SUBSCRIBED', 'LIVE']);
});

test('start() twice does not open a second socket or send a second subscription', async () => {
  const { c } = make();
  c.start(); c.start(); await flush(); c.start(); await flush();
  assert.equal(FakeWS.all.length, 1);
  FakeWS.all[0].open();
  assert.equal(FakeWS.all[0].sent.length, 1);
});

test('drop -> RECONNECTING with exponential backoff (1s,2s,4s,8s... capped), re-authorizes each time, resubscribes once per socket', async () => {
  const { c, clk, states, auths } = make();
  c.start(); await flush(); FakeWS.all[0].open(); FakeWS.all[0].msg(ltpcTick(NIFTY, 100, 1_000_000, 99, 1_000_000));
  assert.equal(c.state, CONN.LIVE);
  const delays = [];
  for (let i = 0; i < 7; i++) {
    const ws = FakeWS.all[FakeWS.all.length - 1];
    ws.drop();
    assert.equal(c.state, CONN.RECONNECTING);
    delays.push(clk.nextDelay());
    clk.advance(clk.nextDelay()); await flush();
    // new socket created, NOT yet opened (so backoff keeps growing)
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  assert.equal(auths(), 8, 'a fresh single-use URL is requested for every connection');
  assert.ok(states.includes('RECONNECTING'));
  // every socket opened gets exactly one subscription
  const last = FakeWS.all[FakeWS.all.length - 1]; last.open();
  assert.equal(last.sent.length, 1);
  last.msg(ltpcTick(NIFTY, 101, 1_000_000, 99, 1_000_000));
  assert.equal(c.state, CONN.LIVE);
  // healthy again => backoff resets to 1s
  last.drop();
  assert.equal(clk.nextDelay(), 1000);
});

test('old sockets are fully disposed: handlers detached, closed, and late events from them are ignored', async () => {
  const { c, clk } = make();
  c.start(); await flush();
  const a = FakeWS.all[0]; a.open();
  const lateMsg = a.onmessage; const lateClose = a.onclose;
  a.drop(); // c tears down a
  assert.equal(a.closed, true); assert.equal(a.onmessage, null); assert.equal(a.onopen, null); assert.equal(a.onclose, null); assert.equal(a.onerror, null);
  clk.advance(1000); await flush();
  const b = FakeWS.all[1]; b.open(); b.msg(ltpcTick(NIFTY, 100, 1_000_000, 99, 1_000_000));
  assert.equal(c.state, CONN.LIVE);
  // a zombie callback from the dead socket must not change anything
  lateClose && lateClose({ code: 1006 }); lateMsg && lateMsg({ data: toArrayBuffer(ltpcTick(NIFTY, 5, 1, 1, 1)) });
  assert.equal(c.state, CONN.LIVE);
  assert.equal(FakeWS.all.length, 2);
});

test('error followed by close does not schedule two reconnects', async () => {
  const { c, clk } = make();
  c.start(); await flush(); const a = FakeWS.all[0]; a.open();
  const onerr = a.onerror, onclose = a.onclose;
  onerr({ message: 'x' }); onclose({ code: 1006 });
  assert.equal(clk.pending(), 1, 'exactly one retry timer');
  clk.advance(1000); await flush();
  assert.equal(FakeWS.all.length, 2);
});

test('stop() closes the socket, clears every timer, and nothing reconnects afterwards', async () => {
  const { c, clk } = make();
  c.start(); await flush(); const a = FakeWS.all[0]; a.open(); a.drop();
  assert.equal(clk.pending(), 1);
  c.stop();
  assert.equal(clk.pending(), 0, 'no leaked timers');
  clk.advance(120000); await flush();
  assert.equal(FakeWS.all.length, 1); assert.equal(c.state, CONN.DISCONNECTED);
  // stop while connected
  const m = make(); m.c.start(); await flush(); const w = FakeWS.all[0]; w.open();
  m.c.stop(); assert.equal(w.closed, true); assert.equal(w.onmessage, null); assert.equal(m.clk.pending(), 0);
});

test('stop() during an in-flight authorize never creates a socket', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const { c } = make({ authorize: async () => { await gate; return 'wss://x/?code=Q'; } });
  c.start(); c.stop(); release(); await flush();
  assert.equal(FakeWS.all.length, 0);
});

test('authorize AUTH failure (expired token): ERROR, onAuthError, and NO retry loop', async () => {
  let authErr = null;
  const { c, clk, states } = make({ authorize: async () => { const e = new Error('Session expired'); e.kind = 'AUTH'; throw e; }, onAuthError: (e) => { authErr = e; } });
  c.start(); await flush();
  assert.equal(c.state, CONN.ERROR); assert.ok(authErr); assert.equal(clk.pending(), 0); assert.equal(FakeWS.all.length, 0);
  assert.ok(states.includes('ERROR'));
});

test('authorize network failure retries with backoff', async () => {
  let n = 0;
  const { c, clk } = make({ authorize: async () => { n += 1; if (n < 3) { const e = new Error('Network error'); e.kind = 'NETWORK'; throw e; } return 'wss://x/?code=Q'; } });
  c.start(); await flush();
  assert.equal(c.state, CONN.RECONNECTING);
  clk.advance(1000); await flush(); assert.equal(c.state, CONN.RECONNECTING);
  clk.advance(2000); await flush(); assert.equal(FakeWS.all.length, 1);
});

test('watchdog: socket silent while the market is open => treated as dead and reconnected', async () => {
  const { c, clk } = make();
  c.start(); await flush(); const a = FakeWS.all[0]; a.open(); a.msg(ltpcTick(NIFTY, 100, 1_000_000, 99, 1_000_000));
  clk.advance(25000); assert.equal(c.state, CONN.LIVE);
  clk.advance(10000);
  assert.equal(c.state, CONN.RECONNECTING); assert.equal(a.closed, true);
  assert.ok(recentLogs().some((l) => /silent/i.test(l.event)));
});

test('watchdog does NOT fire when the market is closed (no ticks are expected)', async () => {
  const { c, clk } = make({ isMarketOpen: () => false });
  c.start(); await flush(); const a = FakeWS.all[0]; a.open(); a.msg(ltpcTick(NIFTY, 100, 1_000_000, 99, 1_000_000));
  clk.advance(600000);
  assert.equal(c.state, CONN.LIVE); assert.equal(FakeWS.all.length, 1);
});

test('a corrupt frame is reported, does not crash, and does not drop the connection', async () => {
  const { c, feeds } = make();
  c.start(); await flush(); const a = FakeWS.all[0]; a.open();
  a.msg(new Uint8Array([0x0a, 0xff, 0xff, 0xff, 0xff, 0x0f]));
  assert.equal(feeds[0], null); assert.equal(c.state, CONN.SUBSCRIBED);
  a.msg(ltpcTick(NIFTY, 100, 1_000_000, 99, 1_000_000));
  assert.equal(c.state, CONN.LIVE);
});

test('logs never contain the access token or the one-time websocket code', async () => {
  const { c } = make();
  c.start(); await flush(); const a = FakeWS.all[0]; a.open(); a.msg(ltpcTick(NIFTY, 100, 1_000_000, 99, 1_000_000)); a.drop();
  const blob = JSON.stringify(recentLogs());
  assert.ok(!/SECRET-ONE-TIME/.test(blob));
  const events = recentLogs().map((l) => l.event);
  for (const want of ['Market feed connected', 'Subscription request sent', 'Subscription confirmed (first data received)', 'NIFTY tick received (feed LIVE)', 'Reconnect attempt scheduled']) assert.ok(events.includes(want), want);
});

test('authorize FORBIDDEN (403, not an expired session): RECONNECTING with backoff, onAuthError NOT called, token kept', async () => {
  let authErr = 0; let n = 0;
  const { c, clk, states } = make({ authorize: async () => { n += 1; const e = new Error('refused'); e.kind = 'FORBIDDEN'; throw e; }, onAuthError: () => { authErr += 1; } });
  c.start(); await flush();
  assert.equal(c.state, CONN.RECONNECTING);
  assert.equal(authErr, 0);
  clk.advance(1000); await flush();
  assert.equal(n, 2); // retried
  c.stop();
  assert.equal(states[states.length - 1], CONN.DISCONNECTED);
});
