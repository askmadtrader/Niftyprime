import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveMarketState, segmentState, MS } from '../src/feed/marketStatus.js';
import { classifyTs, SESSION, selectCandles, describeSeries, latestSessionCandles, validTs } from '../src/feed/session.js';
import { computeFreshness, THRESHOLDS, FRESH, isUsable } from '../src/feed/freshness.js';
import { evaluateGate, GATE } from '../src/feed/gate.js';
import { initialFeedState, applyFeedResponse, serverNow, NIFTY_KEY, VIX_KEY } from '../src/feed/feedState.js';
import { fmtDMY } from '../src/util.js';
import { ist } from './helpers.mjs';

const info = (segmentStatus, cas, pre) => ({ segmentStatus, casMarketStatus: cas || {}, preOpenSessionStatus: pre || {} });

// ---------------------------------------------------------------- market status
test('market status comes from market_info segments, mapped to app states', () => {
  assert.equal(deriveMarketState(info({ NSE_INDEX: 'NORMAL_OPEN' })).state, MS.OPEN);
  assert.equal(deriveMarketState(info({ NSE_INDEX: 'PRE_OPEN_START' })).state, MS.PRE_OPEN);
  assert.equal(deriveMarketState(info({ NSE_INDEX: 'PRE_OPEN_END' })).state, MS.PRE_OPEN);
  assert.equal(deriveMarketState(info({ NSE_INDEX: 'NORMAL_CLOSE' })).state, MS.CLOSED);
  assert.equal(deriveMarketState(info({ NSE_INDEX: 'CLOSING_START' })).state, MS.CAS);
  assert.equal(deriveMarketState(info({ NSE_INDEX: 'CLOSING_END' })).state, MS.CLOSED);
  assert.equal(deriveMarketState(null).state, MS.UNKNOWN);
  assert.equal(deriveMarketState(info({ MCX_FO: 'NORMAL_OPEN' })).state, MS.UNKNOWN, 'unrelated segments never decide NSE status');
});
test('market status falls back NSE_INDEX -> NSE_FO -> NSE_EQ and reports F&O separately', () => {
  const m = deriveMarketState(info({ NSE_FO: 'NORMAL_OPEN', NSE_EQ: 'NORMAL_CLOSE' }));
  assert.equal(m.state, MS.OPEN); assert.equal(m.source, 'NSE_FO');
  const n = deriveMarketState(info({ NSE_INDEX: 'NORMAL_OPEN', NSE_FO: 'NORMAL_CLOSE' }));
  assert.equal(n.state, MS.OPEN); assert.equal(n.fno, MS.CLOSED);
});
test('closing auction session (CAS) statuses', () => {
  for (const s of ['CTS_CLOSE', 'CAS_LM_START', 'CAS_M_STOP']) assert.equal(segmentState(info({ NSE_EQ: 'NORMAL_CLOSE' }, { NSE_EQ: { status: s } }), 'NSE_EQ'), MS.CAS, s);
  assert.equal(segmentState(info({ NSE_EQ: 'NORMAL_CLOSE' }, { NSE_EQ: { status: 'CAS_STOP' } }), 'NSE_EQ'), MS.CLOSED);
  assert.equal(segmentState(info({ NSE_EQ: 'NORMAL_OPEN' }, { NSE_EQ: { status: 'CAS_STOP' } }), 'NSE_EQ'), MS.OPEN, 'CAS never overrides explicit NORMAL_OPEN');
});

// ---------------------------------------------------------------- sessions
const MON_LIVE = ist(2026, 10, 5, 11, 0, 0);          // Monday 11:00 IST
test('current-session detection (IST calendar date, not UTC date)', () => {
  assert.equal(classifyTs(ist(2026, 10, 5, 9, 15), MON_LIVE).kind, SESSION.CURRENT);
  assert.equal(classifyTs(ist(2026, 10, 5, 0, 5), ist(2026, 10, 5, 23, 55)).kind, SESSION.CURRENT, '00:05 IST is the previous UTC day but the same IST day');
  assert.equal(classifyTs(MON_LIVE - 1000, MON_LIVE).date, '2026-10-05');
});
test('previous-session detection (Thursday 01-OCT data viewed on Sunday / Monday morning)', () => {
  const thuClose = ist(2026, 10, 1, 15, 29, 59);
  assert.equal(classifyTs(thuClose, ist(2026, 10, 4, 12)).kind, SESSION.PREVIOUS);
  assert.equal(classifyTs(thuClose, ist(2026, 10, 5, 8, 59)).kind, SESSION.PREVIOUS);
  assert.equal(classifyTs(thuClose, ist(2026, 10, 4, 12)).date, '2026-10-01');
  assert.equal(fmtDMY('2026-10-01'), '01-OCT-2026');
});
test('invalid / future timestamps are rejected', () => {
  for (const bad of [0, -5, NaN, undefined, null, '1700000000000', Infinity, 1000]) assert.equal(classifyTs(bad, MON_LIVE).kind, SESSION.INVALID, String(bad));
  assert.equal(classifyTs(MON_LIVE + 3600e3, MON_LIVE).kind, SESSION.FUTURE);
  assert.equal(classifyTs(MON_LIVE + 60e3, MON_LIVE).kind, SESSION.CURRENT, 'a minute of clock skew is tolerated');
  assert.equal(validTs(0), false);
});
const candles = (y, mo, d, n) => Array.from({ length: n }, (_, i) => ({ t: ist(y, mo, d, 9, 15 + i), o: 1, h: 2, l: 0.5, c: 1.5, v: 0 }));
test('market live: previous-session candles are NEVER usable as live analytics', () => {
  const prev = candles(2026, 10, 1, 30);
  const sel = selectCandles(prev, MON_LIVE, MS.OPEN);
  assert.equal(sel.candles.length, 0);
  assert.equal(sel.info.usable, false);
  assert.equal(sel.info.kind, SESSION.PREVIOUS);
});
test('market live: today candles pass; a mixed series is cut to the latest session only', () => {
  const mixed = [...candles(2026, 10, 1, 20), ...candles(2026, 10, 5, 10)];
  const sel = selectCandles(mixed, MON_LIVE, MS.OPEN);
  assert.equal(sel.candles.length, 10); assert.equal(sel.info.kind, SESSION.CURRENT);
  assert.equal(latestSessionCandles(mixed).length, 10);
});
test('market closed: previous-session candles are shown but labelled PREVIOUS SESSION DD-MMM-YYYY', () => {
  const sel = selectCandles(candles(2026, 10, 1, 30), ist(2026, 10, 4, 12), MS.CLOSED);
  assert.equal(sel.candles.length, 30);
  assert.equal(sel.info.label, 'PREVIOUS SESSION 01-OCT-2026');
  assert.equal(sel.info.usable, false);
  assert.equal(describeSeries([], MON_LIVE, MS.OPEN).label, 'NO DATA');
});
test('after the close the same day is labelled as today\'s finished session, not as previous or live', () => {
  const sel = selectCandles(candles(2026, 10, 5, 30), ist(2026, 10, 5, 16, 5), MS.CLOSED);
  assert.ok(sel.info.label.startsWith("TODAY'S SESSION (MARKET CLOSED)"), sel.info.label);
});

// ---------------------------------------------------------------- feed state
const tick = (key, ltp, ltt, cp, extra = {}) => ({ type: 'live_feed', currentTs: ltt + 50, feeds: { [key]: { kind: 'indexFF', ltpc: { ltp, ltt, ltq: 0, cp }, ohlc: [], ...extra } }, marketInfo: null });
test('reducer: LTP, previous close, change, change %, timestamps', () => {
  const t = ist(2026, 10, 5, 11, 0, 0);
  const s = applyFeedResponse(initialFeedState(), tick(NIFTY_KEY, 22421.95, t, 22300), t + 120);
  const q = s.instruments[NIFTY_KEY];
  assert.equal(q.ltp, 22421.95); assert.equal(q.prev, 22300);
  assert.ok(Math.abs(q.change - 121.95) < 1e-9); assert.ok(Math.abs(q.pct - (121.95 / 22300) * 100) < 1e-9);
  assert.equal(q.ltt, t); assert.equal(q.receivedAt, t + 120); assert.equal(q.tsValid, true);
});
test('reducer: zero / negative / NaN prices are rejected, never stored as 0', () => {
  const t = ist(2026, 10, 5, 11);
  for (const bad of [0, -1, NaN]) {
    const s = applyFeedResponse(initialFeedState(), tick(NIFTY_KEY, bad, t, 22300), t);
    assert.equal(s.instruments[NIFTY_KEY], undefined); assert.equal(s.invalidTicks, 1);
  }
  const keep = applyFeedResponse(applyFeedResponse(initialFeedState(), tick(NIFTY_KEY, 100, t, 99), t), tick(NIFTY_KEY, 0, t + 1, 99), t + 1);
  assert.equal(keep.instruments[NIFTY_KEY].ltp, 100, 'a bad tick never overwrites a good value');
});
test('reducer: missing previous close -> change unknown (null), not 0; missing ltt -> tsValid=false', () => {
  const t = ist(2026, 10, 5, 11);
  const q = applyFeedResponse(initialFeedState(), tick(NIFTY_KEY, 100, 0, 0), t).instruments[NIFTY_KEY];
  assert.equal(q.change, null); assert.equal(q.pct, null); assert.equal(q.ltt, null); assert.equal(q.tsValid, false);
});
test('reducer: India VIX tracked separately; unrelated instruments ignored; market_info sets status; clock offset learned', () => {
  const t = ist(2026, 10, 5, 11);
  let s = applyFeedResponse(initialFeedState(), { type: 'market_info', currentTs: t + 3000, feeds: {}, marketInfo: info({ NSE_INDEX: 'NORMAL_OPEN', NSE_FO: 'NORMAL_OPEN' }) }, t);
  assert.equal(s.market.state, MS.OPEN); assert.equal(s.clockOffset, 3000); assert.equal(s.clockSynced, true);
  assert.equal(serverNow(s, t + 10), t + 3010);
  s = applyFeedResponse(s, { type: 'live_feed', currentTs: t + 3500, feeds: { [VIX_KEY]: { kind: 'ltpc', ltpc: { ltp: 13.4, ltt: t + 3400, ltq: 0, cp: 13.1 }, ohlc: [] }, 'NSE_FO|1': { kind: 'ltpc', ltpc: { ltp: 5, ltt: t, ltq: 1, cp: 4 }, ohlc: [] } }, marketInfo: null }, t + 500);
  assert.equal(s.instruments[VIX_KEY].ltp, 13.4); assert.equal(Object.keys(s.instruments).length, 1);
});
test('reducer: absurd currentTs does not corrupt the clock offset', () => {
  const t = ist(2026, 10, 5, 11);
  const s = applyFeedResponse(initialFeedState(), { type: 'live_feed', currentTs: t + 30 * 86400e3, feeds: {}, marketInfo: null }, t);
  assert.equal(s.clockSynced, false); assert.equal(serverNow(s, t), t);
});
test('reducer: day OHLC from the 1d candle of the index full feed', () => {
  const t = ist(2026, 10, 5, 11);
  const f = tick(NIFTY_KEY, 22421.95, t, 22300, { ohlc: [{ interval: '1d', open: 22350, high: 22460, low: 22310, close: 22421.95, vol: 0, ts: ist(2026, 10, 5) }] });
  const q = applyFeedResponse(initialFeedState(), f, t).instruments[NIFTY_KEY];
  assert.deepEqual([q.open, q.high, q.low], [22350, 22460, 22310]);
});

// ---------------------------------------------------------------- freshness
const mkInst = (ltt, receivedAt, tsValid = true) => ({ ltp: 1, ltt, receivedAt, tsValid });
const fr = (inst, conn, ms, now, th = THRESHOLDS.nifty) => computeFreshness({ inst, conn, marketState: ms, now, serverNow: now, th });
test('freshness: LIVE -> FRESH -> STALE as ticks stop (market open)', () => {
  const t = MON_LIVE;
  assert.equal(fr(mkInst(t, t), 'LIVE', MS.OPEN, t + 2000).status, FRESH.LIVE);
  assert.equal(fr(mkInst(t, t), 'LIVE', MS.OPEN, t + 10000).status, FRESH.FRESH);
  const s = fr(mkInst(t, t), 'LIVE', MS.OPEN, t + 45000);
  assert.equal(s.status, FRESH.STALE); assert.equal(s.ageMs, 45000); assert.equal(s.lastReceivedAt, t); assert.equal(s.lastMarketTs, t);
});
test('freshness: socket delivering but exchange timestamp old => STALE (replayed/old data is not live)', () => {
  const t = MON_LIVE;
  const r = fr(mkInst(t - 10 * 60e3, t), 'LIVE', MS.OPEN, t + 1000);
  assert.equal(r.status, FRESH.STALE); assert.equal(r.reason, 'EXCHANGE_TIMESTAMP_OLD');
});
test('freshness: DISCONNECTED / UNAVAILABLE / invalid timestamp', () => {
  const t = MON_LIVE;
  for (const c of ['RECONNECTING', 'DISCONNECTED', 'ERROR', 'CONNECTING', 'CONNECTED', 'SUBSCRIBED']) assert.equal(fr(mkInst(t, t), c, MS.OPEN, t + 100).status, FRESH.DISCONNECTED, c);
  assert.equal(fr(undefined, 'LIVE', MS.OPEN, t).status, FRESH.UNAVAILABLE);
  assert.equal(fr(mkInst(null, t, false), 'LIVE', MS.OPEN, t).status, FRESH.STALE);
  assert.equal(isUsable(fr(mkInst(t, t), 'LIVE', MS.OPEN, t)), true);
  assert.equal(isUsable(fr(mkInst(t, t), 'RECONNECTING', MS.OPEN, t)), false);
});
test('freshness: closed market, connected => snapshot is the latest the exchange has (FRESH, never LIVE)', () => {
  const t = ist(2026, 10, 4, 12);
  const r = fr(mkInst(ist(2026, 10, 1, 15, 29, 59), t - 600e3), 'LIVE', MS.CLOSED, t);
  assert.equal(r.status, FRESH.FRESH);
});

// ---------------------------------------------------------------- data-quality gate
const okIn = () => {
  const t = MON_LIVE; const nifty = mkInst(t - 500, t - 400);
  return { conn: 'LIVE', market: { state: MS.OPEN, fno: MS.OPEN }, nifty, niftyFresh: fr(nifty, 'LIVE', MS.OPEN, t), serverNow: t, candles: { kind: SESSION.CURRENT, lastT: t - 40e3 } };
};
test('gate: passes only when everything is live and current', () => {
  const g = evaluateGate(okIn());
  assert.equal(g.ok, true); assert.equal(g.reason, null); assert.deepEqual(g.codes, []);
});
const blocks = (name, mut, code, text) => test(`gate blocks (WAIT): ${name}`, () => {
  const i = okIn(); mut(i);
  const g = evaluateGate(i);
  assert.equal(g.ok, false); assert.equal(g.signal, 'WAIT'); assert.ok(g.codes.includes(code), `${g.codes}`);
  if (text) assert.equal(g.reason, text);
});
blocks('market closed', (i) => { i.market = { state: MS.CLOSED, fno: MS.CLOSED }; }, GATE.MARKET_CLOSED, 'Market closed — no live signal');
blocks('pre-open', (i) => { i.market = { state: MS.PRE_OPEN, fno: MS.PRE_OPEN }; }, GATE.PRE_OPEN);
blocks('closing auction', (i) => { i.market = { state: MS.CAS, fno: MS.CAS }; }, GATE.CLOSING_AUCTION);
blocks('market status unknown', (i) => { i.market = { state: MS.UNKNOWN, fno: MS.UNKNOWN }; }, GATE.MARKET_UNKNOWN);
blocks('F&O segment not open', (i) => { i.market = { state: MS.OPEN, fno: MS.CLOSED }; }, GATE.FNO_NOT_OPEN);
blocks('WebSocket disconnected', (i) => { i.conn = 'DISCONNECTED'; i.niftyFresh = { status: FRESH.DISCONNECTED }; }, GATE.FEED_DOWN, 'Live feed disconnected — no live signal');
blocks('reconnecting', (i) => { i.conn = 'RECONNECTING'; i.niftyFresh = { status: FRESH.DISCONNECTED }; }, GATE.FEED_RECONNECTING);
blocks('feed not live yet', (i) => { i.conn = 'SUBSCRIBED'; }, GATE.FEED_NOT_READY);
blocks('NIFTY stale', (i) => { i.niftyFresh = { status: FRESH.STALE }; }, GATE.NIFTY_STALE);
blocks('NIFTY missing', (i) => { i.nifty = null; i.niftyFresh = { status: FRESH.UNAVAILABLE }; }, GATE.NIFTY_MISSING);
blocks('NIFTY timestamp invalid', (i) => { i.nifty = { ...i.nifty, ltt: null, tsValid: false }; }, GATE.TS_INVALID);
blocks('NIFTY timestamp from the future', (i) => { i.nifty = { ...i.nifty, ltt: i.serverNow + 3600e3 }; }, GATE.TS_INVALID);
blocks('NIFTY last trade belongs to a previous session', (i) => { i.nifty = { ...i.nifty, ltt: ist(2026, 10, 1, 15, 29) }; }, GATE.NIFTY_NOT_CURRENT);
blocks('current-session candles unavailable (only previous-session candles)', (i) => { i.candles = { kind: SESSION.PREVIOUS, lastT: ist(2026, 10, 1, 15, 29) }; }, GATE.SESSION_UNAVAILABLE);
blocks('no candles at all', (i) => { i.candles = null; }, GATE.SESSION_UNAVAILABLE);
blocks('candles stale', (i) => { i.candles = { kind: SESSION.CURRENT, lastT: i.serverNow - 400e3 }; }, GATE.CANDLES_STALE);

test('gate: disconnected + closed -> disconnect is the primary reason; all reasons still listed', () => {
  const i = okIn(); i.conn = 'DISCONNECTED'; i.market = { state: MS.CLOSED, fno: MS.CLOSED };
  const g = evaluateGate(i);
  assert.equal(g.codes[0], GATE.FEED_DOWN); assert.ok(g.reasons.length >= 2);
});
