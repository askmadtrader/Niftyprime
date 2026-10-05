// PART 2: data freshness + current/previous session correctness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MS } from '../src/feed/marketStatus.js';
import { SESSION, describeSeries, selectCandles } from '../src/feed/session.js';
import { computeFreshness, computeCandleFreshness, computeChainFreshness, computeGlobalFreshness, usableForLive, THRESHOLDS, FRESH } from '../src/feed/freshness.js';
import { evaluateGate, GATE, WARN } from '../src/feed/gate.js';
import { asOfText, describeValue, sessionWord } from '../src/feed/stamp.js';
import { initialFeedState, applyFeedResponse, NIFTY_KEY, VIX_KEY } from '../src/feed/feedState.js';
import { ist } from './helpers.mjs';

const MON = ist(2026, 10, 5, 11, 0, 0);          // Monday 05-OCT-2026 11:00 IST, market open
const THU = ist(2026, 10, 1, 15, 29, 59);        // Thursday 01-OCT-2026 last trade
const SUN = ist(2026, 10, 4, 12, 0, 0);          // Sunday, market closed
const inst = (ltt, receivedAt, tsValid = true) => ({ ltp: 22400, ltt, receivedAt, tsValid });
const fr = (i, conn, ms, now, th = THRESHOLDS.nifty) => computeFreshness({ inst: i, conn, marketState: ms, now, serverNow: now, th });
const tick = (key, ltp, ltt, cp, extra = {}) => ({ type: 'live_feed', currentTs: ltt + 50, feeds: { [key]: { kind: 'indexFF', ltpc: { ltp, ltt, ltq: 0, cp }, ohlc: [], ...extra } }, marketInfo: null });

// ------------------------------------------------------------------ stamps on every value
test('stamps: instrument carries marketTs, receivedAt and tradingDate (IST)', () => {
  const t = ist(2026, 10, 5, 0, 5, 0);           // 00:05 IST on 05-OCT is still 04-OCT in UTC
  const q = applyFeedResponse(initialFeedState(), tick(NIFTY_KEY, 22421.95, t, 22300), t + 100).instruments[NIFTY_KEY];
  assert.equal(q.marketTs, t); assert.equal(q.receivedAt, t + 100); assert.equal(q.tradingDate, '2026-10-05');
});
test('stamps: freshness result carries marketTs, receivedAt, tradingDate and session', () => {
  const r = fr({ ...inst(MON - 500, MON - 400), tradingDate: '2026-10-05' }, 'LIVE', MS.OPEN, MON);
  assert.equal(r.marketTs, MON - 500); assert.equal(r.receivedAt, MON - 400); assert.equal(r.tradingDate, '2026-10-05'); assert.equal(r.session, SESSION.CURRENT);
});

// ------------------------------------------------------------------ current session
test('current session: LIVE -> FRESH -> STALE as ticks stop', () => {
  assert.equal(fr(inst(MON, MON), 'LIVE', MS.OPEN, MON + 2000).status, FRESH.LIVE);
  assert.equal(fr(inst(MON, MON), 'LIVE', MS.OPEN, MON + 10000).status, FRESH.FRESH);
  assert.equal(fr(inst(MON, MON), 'LIVE', MS.OPEN, MON + 45000).status, FRESH.STALE);
});
test('current session: VIX uses its own (looser) thresholds', () => {
  assert.equal(fr(inst(MON, MON), 'LIVE', MS.OPEN, MON + 20000, THRESHOLDS.vix).status, FRESH.LIVE);
  assert.equal(fr(inst(MON, MON), 'LIVE', MS.OPEN, MON + 90000, THRESHOLDS.vix).status, FRESH.FRESH);
  assert.equal(fr(inst(MON, MON), 'LIVE', MS.OPEN, MON + 300000, THRESHOLDS.vix).status, FRESH.STALE);
});
test('current session: live analytics may use LIVE/FRESH current-session values only while the market is open', () => {
  const live = fr(inst(MON - 300, MON - 200), 'LIVE', MS.OPEN, MON);
  assert.equal(usableForLive(live, MS.OPEN), true);
  assert.equal(usableForLive(live, MS.CLOSED), false);
  assert.equal(usableForLive(live, MS.PRE_OPEN), false);
  assert.equal(usableForLive(undefined, MS.OPEN), false);
});

// ------------------------------------------------------------------ previous session
test('previous session, market OPEN: a Thursday value is STALE (PREVIOUS_SESSION), never LIVE/FRESH, never usable', () => {
  const r = fr(inst(THU, MON - 100), 'LIVE', MS.OPEN, MON);
  assert.equal(r.status, FRESH.STALE); assert.equal(r.reason, 'PREVIOUS_SESSION'); assert.equal(r.session, SESSION.PREVIOUS); assert.equal(r.tradingDate, '2026-10-01');
  assert.equal(usableForLive(r, MS.OPEN), false);
});
test('previous session, market status UNKNOWN: also never live', () => {
  const r = fr(inst(THU, MON - 100), 'LIVE', MS.UNKNOWN, MON);
  assert.equal(r.status, FRESH.STALE);
});
test('previous session, market CLOSED: displayable (FRESH) but labelled PREVIOUS SESSION and not usable for live analytics', () => {
  const r = fr(inst(THU, SUN - 5000), 'LIVE', MS.CLOSED, SUN);
  assert.equal(r.status, FRESH.FRESH); assert.equal(r.session, SESSION.PREVIOUS);
  const d = describeValue(r, SUN, MS.CLOSED);
  assert.equal(d.badge, 'PREVIOUS SESSION'); assert.equal(d.label, 'PREVIOUS SESSION 01-OCT-2026'); assert.equal(d.liveUse, false);
  assert.equal(usableForLive(r, MS.CLOSED), false);
});
test('today after the close: CURRENT SESSION, but not live', () => {
  const t = ist(2026, 10, 5, 16, 0, 0); const last = ist(2026, 10, 5, 15, 29, 59);
  const r = fr(inst(last, t - 1000), 'LIVE', MS.CLOSED, t);
  assert.equal(r.session, SESSION.CURRENT); assert.equal(describeValue(r, t, MS.CLOSED).badge, 'CURRENT SESSION'); assert.equal(describeValue(r, t, MS.CLOSED).liveUse, false);
});
test('sessionWord covers all kinds', () => {
  assert.equal(sessionWord(SESSION.CURRENT), 'CURRENT SESSION'); assert.equal(sessionWord(SESSION.PREVIOUS), 'PREVIOUS SESSION');
  assert.equal(sessionWord(SESSION.FUTURE), 'INVALID TIMESTAMP'); assert.equal(sessionWord(SESSION.INVALID), 'NO DATA');
});

// ------------------------------------------------------------------ stale data
test('stale: exchange timestamp old while the socket still delivers', () => {
  const r = fr(inst(MON - 10 * 60e3, MON), 'LIVE', MS.OPEN, MON + 1000);
  assert.equal(r.status, FRESH.STALE); assert.equal(r.reason, 'EXCHANGE_TIMESTAMP_OLD');
});
test('stale: no recent tick; VIX stale does not close the gate but is reported as a warning', () => {
  const nifty = inst(MON - 500, MON - 400);
  const vix = inst(MON - 20 * 60e3, MON - 20 * 60e3);
  const vf = fr(vix, 'LIVE', MS.OPEN, MON, THRESHOLDS.vix);
  assert.equal(vf.status, FRESH.STALE);
  const g = evaluateGate({ conn: 'LIVE', market: { state: MS.OPEN, fno: MS.OPEN }, nifty, niftyFresh: fr(nifty, 'LIVE', MS.OPEN, MON), serverNow: MON, candles: { kind: SESSION.CURRENT, lastT: MON - 40e3 }, vixFresh: vf });
  assert.equal(g.ok, true); assert.deepEqual(g.warnings, [WARN.VIX_STALE]); assert.match(g.warningTexts[0], /India VIX is stale/);
});
test('stale VIX from a previous session is reported as VIX_NOT_CURRENT', () => {
  const nifty = inst(MON - 500, MON - 400);
  const vf = fr(inst(THU, MON - 100), 'LIVE', MS.OPEN, MON, THRESHOLDS.vix);
  const g = evaluateGate({ conn: 'LIVE', market: { state: MS.OPEN, fno: MS.OPEN }, nifty, niftyFresh: fr(nifty, 'LIVE', MS.OPEN, MON), serverNow: MON, candles: { kind: SESSION.CURRENT, lastT: MON - 40e3 }, vixFresh: vf });
  assert.deepEqual(g.warnings, [WARN.VIX_NOT_CURRENT]);
});
test('stale candles: bar older than its size + grace, or not re-fetched, while the market is open', () => {
  const info = (lastT) => ({ kind: SESSION.CURRENT, count: 50, lastT, date: '2026-10-05' });
  const cf = (lastT, receivedAt, tf = 1) => computeCandleFreshness({ info: info(lastT), receivedAt, link: 'OK', marketState: MS.OPEN, now: MON, serverNow: MON, tfMin: tf });
  assert.equal(cf(MON - 20e3, MON - 5000).status, FRESH.LIVE);
  assert.equal(cf(MON - 100e3, MON - 5000).status, FRESH.FRESH);
  assert.equal(cf(MON - 400e3, MON - 5000).status, FRESH.STALE);
  const nr = cf(MON - 20e3, MON - 90e3); assert.equal(nr.status, FRESH.STALE); assert.equal(nr.reason, 'NOT_REFRESHED');
  assert.equal(cf(MON - 20 * 60e3, MON - 5000, 30).status, FRESH.LIVE, 'a 30m bar opened 20 min ago is still forming');
});
test('stale option chain: received before the open, or not refreshed', () => {
  const chain = [{ strike: 22400 }];
  const cc = (age, req, ms = MS.OPEN, link = 'OK') => computeChainFreshness({ chain, receivedAt: MON - age, requestedMarketState: req, link, marketState: ms, now: MON });
  assert.equal(cc(5000, MS.OPEN).status, FRESH.LIVE);
  assert.equal(cc(40000, MS.OPEN).status, FRESH.FRESH);
  assert.equal(cc(90000, MS.OPEN).status, FRESH.STALE);
  const pre = cc(5000, MS.PRE_OPEN); assert.equal(pre.status, FRESH.STALE); assert.equal(pre.reason, 'RECEIVED_BEFORE_MARKET_OPEN');
  assert.equal(cc(5000, MS.OPEN, MS.CLOSED).reason, 'SNAPSHOT_MARKET_NOT_OPEN');
  assert.equal(cc(5000, MS.OPEN, MS.OPEN, 'DISCONNECTED').status, FRESH.DISCONNECTED);
  const r = cc(5000, MS.OPEN); assert.equal(r.marketTs, null); assert.equal(r.tradingDate, null); assert.equal(r.marketTsProvided, false, 'no exchange timestamp is invented');
});
test('stale global quote is "last close", never live', () => {
  assert.equal(computeGlobalFreshness({ item: { price: 1, t: MON - 5 * 60e3, receivedAt: MON }, now: MON }).status, FRESH.FRESH);
  const old = computeGlobalFreshness({ item: { price: 1, t: MON - 20 * 3600e3, receivedAt: MON }, now: MON });
  assert.equal(old.status, FRESH.STALE); assert.equal(old.reason, 'LAST_CLOSE');
});

// ------------------------------------------------------------------ missing data
test('missing: no instrument => UNAVAILABLE, "DATA UNAVAILABLE", no numbers invented', () => {
  const r = fr(undefined, 'LIVE', MS.OPEN, MON);
  assert.equal(r.status, FRESH.UNAVAILABLE); assert.equal(r.marketTs, null); assert.equal(r.tradingDate, null);
  const d = describeValue(r, MON, MS.OPEN);
  assert.equal(d.badge, 'DATA UNAVAILABLE'); assert.equal(d.label, 'DATA UNAVAILABLE'); assert.equal(d.liveUse, false); assert.match(d.asOf, /--:--:--/);
});
test('missing: reducer never stores a zero/absent price or day range; previous close absent => change null', () => {
  const t = MON;
  const s = applyFeedResponse(initialFeedState(), tick(NIFTY_KEY, 0, t, 22300), t);
  assert.equal(s.instruments[NIFTY_KEY], undefined);
  const q = applyFeedResponse(initialFeedState(), tick(NIFTY_KEY, 100, t, 0), t).instruments[NIFTY_KEY];
  assert.equal(q.change, null); assert.equal(q.open, null); assert.equal(q.high, null); assert.equal(q.low, null);
});
test('missing: candles/chain/global absent => UNAVAILABLE; gate reports VIX_MISSING (warning) and blocks on missing NIFTY', () => {
  assert.equal(computeCandleFreshness({ info: null, receivedAt: null, link: 'OK', marketState: MS.OPEN, now: MON, serverNow: MON }).status, FRESH.UNAVAILABLE);
  assert.equal(computeCandleFreshness({ info: describeSeries([], MON, MS.OPEN), receivedAt: MON, link: 'OK', marketState: MS.OPEN, now: MON, serverNow: MON }).status, FRESH.UNAVAILABLE);
  assert.equal(computeChainFreshness({ chain: null, receivedAt: 0, link: 'OK', marketState: MS.OPEN, now: MON }).status, FRESH.UNAVAILABLE);
  assert.equal(computeGlobalFreshness({ item: { error: 'HTTP 429' }, now: MON }).status, FRESH.UNAVAILABLE);
  assert.equal(computeGlobalFreshness({ item: undefined, now: MON }).status, FRESH.UNAVAILABLE);
  const nifty = inst(MON - 500, MON - 400);
  const ok = evaluateGate({ conn: 'LIVE', market: { state: MS.OPEN, fno: MS.OPEN }, nifty, niftyFresh: fr(nifty, 'LIVE', MS.OPEN, MON), serverNow: MON, candles: { kind: SESSION.CURRENT, lastT: MON - 40e3 }, vixFresh: fr(undefined, 'LIVE', MS.OPEN, MON) });
  assert.equal(ok.ok, true); assert.deepEqual(ok.warnings, [WARN.VIX_MISSING]);
  const bad = evaluateGate({ conn: 'LIVE', market: { state: MS.OPEN, fno: MS.OPEN }, nifty: null, niftyFresh: fr(undefined, 'LIVE', MS.OPEN, MON), serverNow: MON, candles: null });
  assert.equal(bad.ok, false); assert.equal(bad.signal, 'WAIT'); assert.ok(bad.codes.includes(GATE.NIFTY_MISSING));
});
test('disconnected: stored values are kept for display but marked DISCONNECTED (candles, chain too)', () => {
  assert.equal(fr(inst(MON, MON), 'RECONNECTING', MS.OPEN, MON + 100).status, FRESH.DISCONNECTED);
  const info = { kind: SESSION.CURRENT, count: 5, lastT: MON - 10e3, date: '2026-10-05' };
  assert.equal(computeCandleFreshness({ info, receivedAt: MON, link: 'DISCONNECTED', marketState: MS.OPEN, now: MON, serverNow: MON }).status, FRESH.DISCONNECTED);
});

// ------------------------------------------------------------------ invalid timestamps
test('invalid timestamps: missing/zero/pre-2015/NaN ltt => tsValid false, STALE (INVALID_TIMESTAMP), tradingDate null', () => {
  for (const bad of [0, NaN, Date.UTC(2001, 0, 1), -5]) {
    const q = applyFeedResponse(initialFeedState(), tick(NIFTY_KEY, 100, bad, 99), MON).instruments[NIFTY_KEY];
    assert.equal(q.tsValid, false); assert.equal(q.ltt, null); assert.equal(q.tradingDate, null);
    const r = fr(q, 'LIVE', MS.OPEN, MON); assert.equal(r.status, FRESH.STALE); assert.equal(r.reason, 'INVALID_TIMESTAMP'); assert.equal(r.tradingDate, null);
    assert.equal(fr(q, 'LIVE', MS.CLOSED, MON).status, FRESH.STALE, 'invalid timestamp is never FRESH, even when the market is closed');
  }
});
test('invalid timestamps: a timestamp from the future is STALE (FUTURE_TIMESTAMP), never LIVE', () => {
  const r = fr(inst(MON + 3600e3, MON), 'LIVE', MS.OPEN, MON);
  assert.equal(r.status, FRESH.STALE); assert.equal(r.reason, 'FUTURE_TIMESTAMP'); assert.equal(r.session, SESSION.FUTURE);
  assert.equal(fr(inst(MON + 3600e3, MON), 'LIVE', MS.CLOSED, MON).status, FRESH.STALE);
  const g = evaluateGate({ conn: 'LIVE', market: { state: MS.OPEN, fno: MS.OPEN }, nifty: inst(MON + 3600e3, MON), niftyFresh: r, serverNow: MON, candles: { kind: SESSION.CURRENT, lastT: MON - 1e3 } });
  assert.equal(g.ok, false); assert.ok(g.codes.includes(GATE.TS_INVALID));
});
test('invalid timestamps: candles with future / invalid last bar', () => {
  const cf = (lastT) => computeCandleFreshness({ info: { kind: SESSION.CURRENT, count: 3, lastT }, receivedAt: MON, link: 'OK', marketState: MS.OPEN, now: MON, serverNow: MON });
  assert.equal(cf(MON + 3600e3).reason, 'FUTURE_TIMESTAMP');
  assert.equal(cf(Date.UTC(2001, 0, 1)).reason, 'INVALID_TIMESTAMP');
});
test('invalid timestamps: invalid global quote timestamp', () => {
  for (const t of [null, 0, MON + 3600e3]) assert.equal(computeGlobalFreshness({ item: { price: 5, t, receivedAt: MON }, now: MON }).reason, 'INVALID_TIMESTAMP');
});

// ------------------------------------------------------------------ old candles are never today's live candles
const candlesOf = (y, mo, d, n) => Array.from({ length: n }, (_, i) => ({ t: ist(y, mo, d, 9, 15 + i), o: 1, h: 2, l: 0.5, c: 1.5, v: 0 }));
test('old candles: market open + only Thursday candles => dropped from live analytics, series flagged PREVIOUS, candle freshness STALE', () => {
  const sel = selectCandles(candlesOf(2026, 10, 1, 375), MON, MS.OPEN);
  assert.equal(sel.candles.length, 0); assert.equal(sel.info.usable, false); assert.equal(sel.info.kind, SESSION.PREVIOUS);
  const cf = computeCandleFreshness({ info: sel.info, receivedAt: MON, link: 'OK', marketState: MS.OPEN, now: MON, serverNow: MON });
  assert.equal(cf.status, FRESH.STALE); assert.equal(cf.reason, 'PREVIOUS_SESSION'); assert.equal(cf.session, SESSION.PREVIOUS);
});
test('old candles: market closed => shown, labelled PREVIOUS SESSION, FRESH but not live', () => {
  const sel = selectCandles(candlesOf(2026, 10, 1, 375), SUN, MS.CLOSED);
  assert.equal(sel.candles.length, 375); assert.equal(sel.info.label, 'PREVIOUS SESSION 01-OCT-2026');
  const cf = computeCandleFreshness({ info: sel.info, receivedAt: SUN, link: 'OK', marketState: MS.CLOSED, now: SUN, serverNow: SUN });
  assert.equal(cf.status, FRESH.FRESH); assert.equal(describeValue(cf, SUN, MS.CLOSED).liveUse, false);
});

// ------------------------------------------------------------------ day OHLC must belong to the tick's trading date
test('day OHLC: previous-day 1d candle is NOT shown as today\'s open/high/low', () => {
  const t = ist(2026, 10, 5, 11);
  const yday = { interval: '1d', open: 22000, high: 22900, low: 21900, close: 22300, vol: 0, ts: ist(2026, 10, 1) };
  const q = applyFeedResponse(initialFeedState(), tick(NIFTY_KEY, 22421.95, t, 22300, { ohlc: [yday] }), t).instruments[NIFTY_KEY];
  assert.equal(q.open, null); assert.equal(q.high, null); assert.equal(q.low, null);
});
test('day OHLC: same-day candle accepted; carried across ticks within the day; reset when the trading date changes', () => {
  const t = ist(2026, 10, 5, 11);
  const today = { interval: '1d', open: 22350, high: 22460, low: 22310, close: 22421.95, vol: 0, ts: ist(2026, 10, 5) };
  let s = applyFeedResponse(initialFeedState(), tick(NIFTY_KEY, 22421.95, t, 22300, { ohlc: [today] }), t);
  s = applyFeedResponse(s, tick(NIFTY_KEY, 22430, t + 1000, 22300), t + 1000);          // tick without ohlc
  assert.deepEqual([s.instruments[NIFTY_KEY].open, s.instruments[NIFTY_KEY].high, s.instruments[NIFTY_KEY].low], [22350, 22460, 22310]);
  const next = ist(2026, 10, 6, 9, 16);
  s = applyFeedResponse(s, tick(NIFTY_KEY, 22500, next, 22430), next);                   // next trading day, no ohlc yet
  const q = s.instruments[NIFTY_KEY];
  assert.equal(q.tradingDate, '2026-10-06'); assert.equal(q.open, null); assert.equal(q.high, null, 'yesterday\'s range is not carried into today');
});
test('day OHLC: no valid ltt => range cannot be dated, so it is not shown', () => {
  const t = ist(2026, 10, 5, 11);
  const today = { interval: '1d', open: 22350, high: 22460, low: 22310, close: 1, vol: 0, ts: ist(2026, 10, 5) };
  const q = applyFeedResponse(initialFeedState(), tick(NIFTY_KEY, 100, 0, 99, { ohlc: [today] }), t).instruments[NIFTY_KEY];
  assert.equal(q.high, null);
});

// ------------------------------------------------------------------ "Data as of HH:mm:ss IST"
test('Data as of: HH:mm:ss IST, date appended only when not today, explicit placeholder when invalid', () => {
  assert.equal(asOfText(ist(2026, 10, 5, 9, 5, 7), MON), 'Data as of 09:05:07 IST');
  assert.equal(asOfText(THU, SUN), 'Data as of 15:29:59 IST · 01-OCT-2026');
  assert.equal(asOfText(null, MON), 'Data as of --:--:-- IST (no valid timestamp)');
  assert.equal(asOfText(0, MON), 'Data as of --:--:-- IST (no valid timestamp)');
  assert.match(asOfText(MON + 3600e3, MON), /INVALID: future timestamp/);
});
test('Data as of: IST, not UTC (00:30 IST belongs to the IST date)', () => {
  assert.equal(asOfText(ist(2026, 10, 5, 0, 30, 0), ist(2026, 10, 5, 1, 0, 0)), 'Data as of 00:30:00 IST');
});
test('describeValue: chain without an exchange timestamp says so instead of inventing one', () => {
  const c = computeChainFreshness({ chain: [{ strike: 1 }], receivedAt: MON - 2000, requestedMarketState: MS.OPEN, link: 'OK', marketState: MS.OPEN, now: MON });
  const d = describeValue(c, MON, MS.OPEN);
  assert.match(d.asOf, /no exchange timestamp/); assert.equal(d.label, 'EXCHANGE TIMESTAMP NOT PROVIDED'); assert.equal(d.tradingDate, null);
});
