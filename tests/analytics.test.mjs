import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  OPEN_MIN, OR_MINUTES, VOLUME_COVERAGE_MIN, SRC, ROC_BARS, FLAT_BASE_PCT, sessionMs, resolveSession, currentPrice, candleStats,
  computeOhlc, computeVwap, priceVsVwap, computeOpeningRange, aggregateAnchored, flatThreshold, computeMomentum, collectOiWalls,
  buildLevels, analyzeNifty,
} from '../src/analytics';
import { buildInstrument, NIFTY_KEY } from '../src/feed/feedState';
import { computeFreshness, computeCandleFreshness, computeChainFreshness, THRESHOLDS } from '../src/feed/freshness';
import { describeSeries } from '../src/feed/session';
import { MS } from '../src/feed/marketStatus';
import { parseChain } from '../src/chain';

// ---------------------------------------------------------------- fixtures (test data only; the app never fabricates candles)
const ist = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s) - 5.5 * 3600e3;
const D = [2030, 3, 4], DAY = '2030-03-04', PREV_DAY = '2030-03-01';   // Mon 04-Mar-2030 (previous session: Fri 01-Mar)
const at = (h, mi, s = 0) => ist(...D, h, mi, s);
const cd = (t, o, h, l, c, v = 0) => ({ t, o, h, l, c, v });
// n 1-minute candles from 09:15 IST on `day`: open = base + i*step, close = open + step
function run(n, { day = D, base = 22000, step = 5, v = 0, from = 0 } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const k = from + i, o = base + k * step, c = o + step;
    return cd(ist(...day, 9, 15 + k), o, Math.max(o, c) + 2, Math.min(o, c) - 2, c, v);
  });
}
// 1-minute candles from a list of closes (open = previous close)
function fromCloses(closes, day = D) {
  return closes.map((c, i) => { const o = i ? closes[i - 1] : c; return cd(ist(...day, 9, 15 + i), o, Math.max(o, c) + 1, Math.min(o, c) - 1, c, 0); });
}
const feedQuote = ({ ltp, ltt, cp = 21900, day, receivedAt, serverTs }) => buildInstrument(NIFTY_KEY,
  { ltpc: { ltp, ltt, cp }, ohlc: day ? [{ interval: '1d', open: day.o, high: day.h, low: day.l, ts: day.ts }] : [] }, null, receivedAt, serverTs);

// One consistent scene, built with the app's real freshness functions.
function scene({ candles, now, ltp = 22100, cp = 21900, day, market = MS.OPEN, quoteDate, link = 'OK', candlesReceivedAt, quoteAge = 1000, chainRows = null, chainExpiry = null, expiry = null, noQuote = false } = {}) {
  const ltt = quoteDate ? ist(...quoteDate.split('-').map(Number), 15, 29, 50) : now - 2000;
  const quote = noQuote ? null : feedQuote({ ltp, ltt, cp, day: day === undefined ? undefined : day && { ...day, ts: day.ts ?? ltt }, receivedAt: now - quoteAge, serverTs: now });
  const quoteFresh = computeFreshness({ inst: quote, conn: 'LIVE', marketState: market, now, serverNow: now, th: THRESHOLDS.nifty });
  const info = describeSeries(candles, now, market);
  const candlesFresh = computeCandleFreshness({ info, receivedAt: candlesReceivedAt ?? now - 2000, link, marketState: market, now, serverNow: now, tfMin: 1 });
  const chainFresh = chainRows ? computeChainFreshness({ chain: chainRows, receivedAt: now - 1000, requestedMarketState: market, link, marketState: market, now }) : null;
  const chain = chainRows ? { rows: chainRows, expiry, chainExpiry: chainExpiry ?? expiry, fresh: chainFresh } : null;
  return { quote, quoteFresh, candles, candlesFresh, marketState: market, now, chain };
}

// ================================================================ Open / High / Low / Previous close / Day range / Price
test('OHLC: open, high, low, previous close, day range and current price come from the live feed, each with its source', () => {
  const now = at(10, 0, 20), candles = run(46, { base: 22040, step: 1 });          // candles stay inside the feed's day range
  const a = analyzeNifty(scene({ candles, now, ltp: 22100, cp: 21900, day: { o: 22010, h: 22120, l: 21990 } }));
  assert.equal(a.price.value, 22100); assert.equal(a.price.source, SRC.FEED_LTP);
  assert.deepEqual([a.ohlc.open.value, a.ohlc.open.source], [22010, SRC.FEED]);
  assert.deepEqual([a.ohlc.high.value, a.ohlc.high.source], [22120, SRC.FEED]);
  assert.deepEqual([a.ohlc.low.value, a.ohlc.low.source], [21990, SRC.FEED]);
  assert.deepEqual([a.ohlc.prevClose.value, a.ohlc.prevClose.source], [21900, SRC.FEED_PREV]);
  assert.equal(a.ohlc.range.pts, 130);                                         // 22120 - 21990
  assert.ok(Math.abs(a.ohlc.pricePosPct - ((22100 - 21990) / 130) * 100) < 1e-9);
  assert.equal(a.ohlc.change.pts, 200); assert.ok(Math.abs(a.ohlc.change.pct - (200 / 21900) * 100) < 1e-9);
  assert.equal(a.session.live, true); assert.equal(a.session.date, DAY);
});

test('previous close is only the feed value: missing or zero => null (never 0, never taken from candles)', () => {
  const now = at(10, 0, 20), candles = run(46);
  for (const cp of [0, null, NaN]) {
    const a = analyzeNifty(scene({ candles, now, cp, day: { o: 22010, h: 22120, l: 21990 } }));
    assert.equal(a.ohlc.prevClose.value, null); assert.equal(a.ohlc.prevClose.source, null); assert.equal(a.ohlc.change, null);
  }
});

test("another day's 1d candle is never shown as today's range (quote of the previous session while the market is open)", () => {
  const now = at(10, 0, 20), candles = run(46);
  const prevTs = ist(2030, 3, 1, 15, 29, 50);
  const s = scene({ candles, now, quoteDate: PREV_DAY, day: { o: 1, h: 99999, l: 1, ts: prevTs } });
  const a = analyzeNifty(s);
  assert.equal(a.price.value, null);                                           // yesterday's tick is not a live price
  assert.equal(a.price.reason, 'OTHER_SESSION');
  assert.match(a.issues.join(' '), /different session/);
  assert.notEqual(a.ohlc.high.value, 99999); assert.notEqual(a.ohlc.low.value, 1); // feed range of Friday is ignored
  assert.equal(a.ohlc.high.source, SRC.CANDLES);                               // today's range comes from today's candles
  assert.equal(a.ohlc.prevClose.value, null);
});

test('without a feed day candle, open / high / low fall back to the current session candles and say so', () => {
  const now = at(10, 0, 20), candles = run(46);                                // 09:15 .. 10:00
  const a = analyzeNifty(scene({ candles, now, day: null }));
  const hi = Math.max(...candles.map((c) => c.h)), lo = Math.min(...candles.map((c) => c.l));
  assert.deepEqual([a.ohlc.open.value, a.ohlc.open.source], [candles[0].o, SRC.CANDLES]);
  assert.deepEqual([a.ohlc.high.value, a.ohlc.high.source], [hi, SRC.CANDLES]);
  assert.deepEqual([a.ohlc.low.value, a.ohlc.low.source], [lo, SRC.CANDLES]);
});

test('candle open is "the day open" only if the 09:15 candle exists; missing candles are reported', () => {
  const cs = run(30).filter((c) => c.t !== at(9, 15) && c.t !== at(9, 20));    // 09:15 and 09:20 missing
  const st = candleStats(cs, DAY);
  assert.equal(st.startsAtOpen, false); assert.equal(st.open, null); assert.equal(st.missing, 2); assert.equal(st.slots, 30);
  const now = at(9, 46, 20);
  const a = analyzeNifty(scene({ candles: cs, now, day: null }));
  assert.equal(a.ohlc.open.value, null);                                       // not the 09:16 open pretending to be the day open
  assert.match(a.ohlc.high.source, /2 candles missing/);
});

test('pre-open candles (before 09:15) are not part of the session range', () => {
  const pre = cd(at(9, 8), 21000, 21010, 20990, 21005);
  const cs = [pre, ...run(10)];
  const st = candleStats(cs, DAY);
  assert.equal(st.preOpenDropped, 1); assert.equal(st.count, 10); assert.ok(st.low > 21990);
});

test('a price beyond the known range extends it and is labelled; a lone price never invents a day range', () => {
  const lo = computeOhlc({ quote: null, session: { date: DAY, live: true }, price: { value: 22500 }, cs: [], candlesOk: false });
  assert.equal(lo.high.value, null); assert.equal(lo.low.value, null); assert.equal(lo.range.pts, null); // one price is not a high
  const now = at(10, 0, 20), candles = run(46);
  const a = analyzeNifty(scene({ candles, now, ltp: 22400, day: { o: 22010, h: 22120, l: 21990 } }));
  assert.deepEqual([a.ohlc.high.value, a.ohlc.high.source], [22400, SRC.PRICE_EXT]);   // feed range is behind the tick
  assert.equal(a.ohlc.low.value, 21990);
  const b = analyzeNifty(scene({ candles, now, ltp: 21950, day: { o: 22010, h: 22120, l: 21990 } }));
  assert.deepEqual([b.ohlc.low.value, b.ohlc.low.source], [21950, SRC.PRICE_EXT]);
});

test('when candles go beyond the feed range the larger extreme wins and keeps its own source', () => {
  const now = at(10, 0, 20), candles = run(46);                                // candle high = 22000+45*5+5+2 = 22232
  const a = analyzeNifty(scene({ candles, now, ltp: 22100, day: { o: 22010, h: 22100, l: 21990 } }));
  assert.deepEqual([a.ohlc.high.value, a.ohlc.high.source], [22232, SRC.CANDLES]);
});

test('current price: only a LIVE/FRESH tick of the described session; stale / disconnected / no timestamp => null with a reason', () => {
  const now = at(10, 0, 20), candles = run(46);
  const stale = analyzeNifty(scene({ candles, now, quoteAge: 60000 }));         // last tick received 60 s ago while the market is open
  assert.equal(stale.price.value, null); assert.equal(stale.price.status, 'STALE');
  assert.equal(stale.ohlc.stale, true);
  assert.ok(stale.issues.some((m) => /Current price unavailable/.test(m)));
  const s = scene({ candles, now });
  const bad = { ...s.quote, tsValid: false };
  assert.equal(currentPrice({ quote: bad, quoteFresh: s.quoteFresh, session: { date: DAY, live: true } }).reason, 'INVALID_TIMESTAMP');
  assert.equal(currentPrice({ quote: null, quoteFresh: null, session: { date: DAY, live: true } }).reason, 'NO_QUOTE');
  const none = analyzeNifty(scene({ candles, now, noQuote: true }));
  assert.equal(none.price.value, null); assert.equal(none.openingRange.state, null);
});

// ================================================================ VWAP
test('VWAP with real volume is sum(typical x volume) / sum(volume)', () => {
  const cs = [cd(1, 99, 102, 98, 100, 10), cd(2, 101, 106, 100, 103, 30), cd(3, 104, 112, 104, 106, 60)];
  // typical prices: 100, 103, 107.3333; weights 10, 30, 60  =>  (1000 + 3090 + 6440) / 100 = 105.3
  const v = computeVwap(cs);
  assert.equal(v.method, 'VOLUME'); assert.ok(Math.abs(v.value - 105.3) < 1e-9);
  assert.equal(v.label, 'VWAP'); assert.equal(v.volumeCoverage, 1); assert.equal(v.reason, null);
});

test('NIFTY index candles have no volume: VWAP is NOT claimed, a labelled session-average proxy is returned instead', () => {
  const cs = [cd(1, 99, 102, 98, 100, 0), cd(2, 101, 106, 100, 103, 0), cd(3, 104, 112, 104, 106, 0)];
  const v = computeVwap(cs);
  assert.equal(v.method, 'PROXY'); assert.equal(v.reason, 'NO_VOLUME');
  assert.ok(Math.abs(v.value - (100 + 103 + 322 / 3) / 3) < 1e-9);            // plain average of (H+L+C)/3
  assert.match(v.label, /proxy/i); assert.match(v.short, /no volume/i); assert.match(v.note, /no traded volume/i);
  assert.match(v.note, /not a true VWAP/i);
  assert.notEqual(v.label, 'VWAP');
  // the proxy must differ from a volume-weighted number when volume is attached to the same candles
  const w = computeVwap(cs.map((c, i) => ({ ...c, v: [10, 30, 60][i] })));
  assert.notEqual(w.value, v.value);
});

test('volume coverage rule: below 80 % of candles with volume => proxy; at or above => volume-weighted; invalid volume => proxy', () => {
  assert.equal(VOLUME_COVERAGE_MIN, 0.8);
  const mk = (n, withVol, bad) => Array.from({ length: n }, (_, i) => cd(i + 1, 100, 102, 98, 100 + (i % 3), i < withVol ? 50 : (bad && i === n - 1 ? -5 : 0)));
  const part = computeVwap(mk(10, 7));
  assert.equal(part.method, 'PROXY'); assert.equal(part.reason, 'PARTIAL_VOLUME'); assert.equal(part.volumeCoverage, 0.7);
  assert.match(part.note, /70%/);
  const ok = computeVwap(mk(10, 8));
  assert.equal(ok.method, 'VOLUME'); assert.equal(ok.volumeCoverage, 0.8);
  const bad = computeVwap(mk(10, 9, true));
  assert.equal(bad.method, 'PROXY'); assert.equal(bad.reason, 'INVALID_VOLUME');
  const none = computeVwap([]);
  assert.equal(none.value, null); assert.equal(none.reason, 'NO_CANDLES');
});

test('VWAP / proxy restarts each session: only the described session\'s candles are used', () => {
  const fri = run(375, { day: [2030, 3, 1], base: 21000 }), mon = run(46);
  const now = at(10, 0, 20);
  const a = analyzeNifty(scene({ candles: [...fri, ...mon], now }));
  const tp = mon.map((c) => (c.h + c.l + c.c) / 3);
  assert.ok(Math.abs(a.vwap.value - tp.reduce((s, x) => s + x, 0) / tp.length) < 1e-9);
  assert.equal(a.vwap.candles, 46);
  assert.equal(a.session.otherSessionCandles, 375);
  assert.ok(a.issues.some((m) => /375 candles from another session ignored/.test(m)));
});

test('price vs VWAP: ABOVE / BELOW / AT with the distance in %', () => {
  assert.deepEqual(priceVsVwap(101, 100), { position: 'ABOVE', distPct: 1 });
  assert.deepEqual(priceVsVwap(99, 100), { position: 'BELOW', distPct: -1 });
  assert.equal(priceVsVwap(100.01, 100).position, 'AT');
  assert.deepEqual(priceVsVwap(null, 100), { position: null, distPct: null });
});

// ================================================================ Opening range
const orCandles = () => { const cs = run(15, { base: 22000, step: 1 }); cs[7] = cd(at(9, 22), 22007, 22030, 21990, 22008); return cs; };   // spike candle: high 22030, low 21990

test('opening range = highest high / lowest low of the 15 one-minute candles 09:15-09:29 of the current session', () => {
  const cs = [...orCandles(), ...run(10, { base: 22020, step: 1, from: 15 })];
  const or = computeOpeningRange({ cs, date: DAY, now: at(9, 41), price: { value: 22015 } });
  assert.equal(or.status, 'COMPLETE'); assert.equal(or.high, 22030); assert.equal(or.low, 21990); assert.equal(or.width, 40);
  assert.equal(or.candles, 15); assert.equal(or.expected, OR_MINUTES); assert.equal(or.source, SRC.OR);
  assert.equal(OPEN_MIN, 555);
  // candles after 09:30 never widen the opening range
  const wide = [...cs, cd(at(9, 45), 22100, 23000, 21000, 22100)];
  const or2 = computeOpeningRange({ cs: wide, date: DAY, now: at(9, 50), price: { value: 22015 } });
  assert.deepEqual([or2.high, or2.low], [22030, 21990]);
});

test('opening range is FORMING (provisional, no breakout call) until 09:30 and until a candle after the window exists', () => {
  const part = run(8, { base: 22000, step: 1 });                               // 09:15 .. 09:22
  const f = computeOpeningRange({ cs: part, date: DAY, now: at(9, 22, 30), price: { value: 99999 } });
  assert.equal(f.status, 'FORMING'); assert.equal(f.provisional, true); assert.equal(f.candles, 8);
  assert.equal(f.state, null); assert.equal(f.breakout, null);                 // price far above, still no breakout call
  // 09:30:05: the window is over but the 09:30 candle is not in the data yet: the 09:29 candle may not be final
  const w = computeOpeningRange({ cs: run(15, { step: 1 }), date: DAY, now: at(9, 30, 5), price: { value: 99999 } });
  assert.equal(w.status, 'FORMING'); assert.equal(w.reason, 'WAITING_FOR_POST_OR_CANDLE'); assert.equal(w.state, null);
});

test('opening range with a missing candle is INCOMPLETE: partial values shown, no breakout call', () => {
  const cs = [...run(15, { step: 1 }).filter((c) => c.t !== at(9, 20)), ...run(5, { base: 22020, step: 1, from: 15 })];
  const or = computeOpeningRange({ cs, date: DAY, now: at(9, 36), price: { value: 99999 } });
  assert.equal(or.status, 'INCOMPLETE'); assert.equal(or.candles, 14); assert.equal(or.reason, 'MISSING_CANDLES');
  assert.ok(or.high !== null && or.provisional); assert.equal(or.state, null);
});

test('opening range UNAVAILABLE when the window is over and there is no candle in it (e.g. late start / wrong session)', () => {
  const late = run(10, { base: 22100, step: 1, from: 20 });                    // data only from 09:35
  const or = computeOpeningRange({ cs: late, date: DAY, now: at(9, 50), price: { value: 22100 } });
  assert.equal(or.status, 'UNAVAILABLE'); assert.equal(or.high, null); assert.equal(or.state, null);
  assert.equal(computeOpeningRange({ cs: [], date: null, now: at(9, 50), price: null }).status, 'UNAVAILABLE');
});

test('breakout / breakdown / inside range, with the edges counting as INSIDE', () => {
  const cs = [...orCandles(), ...run(10, { base: 22020, step: 1, from: 15 })];  // OR 21990 - 22030
  const st = (p) => computeOpeningRange({ cs, date: DAY, now: at(9, 41), price: p === null ? null : { value: p } });
  const up = st(22030.5); assert.equal(up.state, 'BREAKOUT'); assert.equal(up.breakout, 'UP'); assert.ok(Math.abs(up.distance - 0.5) < 1e-9);
  const dn = st(21989.5); assert.equal(dn.state, 'BREAKDOWN'); assert.equal(dn.breakout, 'DOWN'); assert.ok(Math.abs(dn.distance - 0.5) < 1e-9);
  assert.equal(st(22030).state, 'INSIDE');                                    // exactly on the high is not a breakout
  assert.equal(st(21990).state, 'INSIDE');                                    // exactly on the low is not a breakdown
  const mid = st(22010); assert.equal(mid.state, 'INSIDE'); assert.equal(mid.distance, 20);
  const none = st(null);                                                      // complete range, no price: nothing is guessed
  assert.equal(none.status, 'COMPLETE'); assert.equal(none.state, null); assert.equal(none.reason, 'NO_PRICE');
});

test('opening range uses the current session only: yesterday\'s candles never form today\'s range', () => {
  const fri = run(375, { day: [2030, 3, 1], base: 21000 });
  const a = analyzeNifty(scene({ candles: fri, now: at(9, 50, 20) }));        // market open Monday, only Friday's candles on hand
  assert.equal(a.openingRange.status, 'UNAVAILABLE'); assert.equal(a.openingRange.high, null);
  assert.equal(a.vwap.value, null); assert.equal(a.momentum.alignment, 'UNAVAILABLE');
  assert.ok(a.issues.some((m) => /another session/.test(m)));
});

// ================================================================ Momentum
test('bars are anchored at 09:15 (not at the epoch): a 60-minute bar covers 09:15-10:14, 5-minute bars start at :15', () => {
  const cs = run(60);
  const anchor = at(9, 15);
  const h = aggregateAnchored(cs, 60, anchor);
  assert.equal(h.length, 1); assert.equal(h[0].t, anchor); assert.equal(h[0].n, 60);
  assert.equal(h[0].o, cs[0].o); assert.equal(h[0].c, cs[59].c);
  assert.equal(h[0].h, Math.max(...cs.map((c) => c.h))); assert.equal(h[0].l, Math.min(...cs.map((c) => c.l)));
  const f = aggregateAnchored(cs, 5, anchor);
  assert.equal(f.length, 12); assert.equal(f[1].t, at(9, 20)); assert.equal(f[1].o, cs[5].o); assert.equal(f[1].c, cs[9].c);
  // an incomplete trailing bar is never emitted, and a bar with a hole in it is dropped
  assert.equal(aggregateAnchored(run(7), 5, anchor).length, 1);
  assert.equal(aggregateAnchored(cs.filter((c) => c.t !== at(9, 27)), 5, anchor).length, 11);
});

test('candles that are not on a whole-minute boundary are ignored by the bar builder, not rounded into a bar', () => {
  const anchor = at(9, 15);
  const cs = run(5).map((c, i) => (i === 2 ? { ...c, t: c.t + 30000 } : c));       // the 09:17 candle is stamped 09:17:30
  const bars = aggregateAnchored(cs, 5, anchor);
  assert.equal(bars.length, 0);                                                    // the 5-minute bar now has only 4 valid minutes, so it is incomplete
  assert.equal(aggregateAnchored(cs, 1, anchor).length, 4);
});

test('momentum: uptrend is POSITIVE on every available timeframe; the forming minute is excluded; 15m/30m wait for enough bars', () => {
  const cs = run(40);                                                         // 09:15 .. 09:54, +5 pts per minute
  const now = at(9, 54, 20);                                                  // the 09:54 candle is still forming
  const m = computeMomentum({ cs, date: DAY, now, live: true });
  const [m1, m5, m15, m30] = m.frames;
  // 1m: completed candles 09:15..09:53 (39 bars). last close = 22000+38*5+5 = 22195, 3 bars earlier = 22180
  assert.equal(m1.available, true); assert.equal(m1.bars, 39);
  assert.ok(Math.abs(m1.rocPct - (15 / 22180) * 100) < 1e-9); assert.equal(m1.state, 'POSITIVE');
  assert.equal(m1.asOf, at(9, 54));                                           // last COMPLETED bar ends 09:54:00, not the forming one
  // 5m: 7 complete bars (35 candles). last close = candle 34 close 22175, base (3 bars back) = candle 19 close 22100
  assert.equal(m5.bars, 7); assert.ok(Math.abs(m5.rocPct - (75 / 22100) * 100) < 1e-9); assert.equal(m5.state, 'POSITIVE');
  assert.equal(m15.available, false); assert.equal(m15.bars, 2); assert.equal(m15.reason, 'NEED_4_BARS');
  assert.equal(m30.available, false); assert.equal(m30.bars, 1);
  assert.equal(m.alignment, 'ALIGNED_UP'); assert.equal(m.available, 2);
  assert.equal(m1.fading, false);
});

test('momentum: downtrend is NEGATIVE / ALIGNED_DOWN, flat prices are FLAT', () => {
  const down = computeMomentum({ cs: run(40, { step: -5, base: 22500 }), date: DAY, now: at(9, 54, 20), live: true });
  assert.deepEqual(down.frames.filter((f) => f.available).map((f) => f.state), ['NEGATIVE', 'NEGATIVE']);
  assert.equal(down.alignment, 'ALIGNED_DOWN');
  const flat = computeMomentum({ cs: fromCloses(Array(40).fill(22000)), date: DAY, now: at(9, 54, 20), live: true });
  assert.deepEqual(flat.frames.filter((f) => f.available).map((f) => f.state), ['FLAT', 'FLAT']);
  assert.equal(flat.alignment, 'FLAT');
});

test('momentum: timeframes can disagree (MIXED) and a fading move is flagged', () => {
  // 30 minutes of +5/min then 10 minutes of -3/min: 1m has turned down, 5m is still up but its last bar is down
  const closes = [...Array.from({ length: 30 }, (_, i) => 22000 + 5 * i), ...Array.from({ length: 10 }, (_, i) => 22145 - 3 * (i + 1))];
  const m = computeMomentum({ cs: fromCloses(closes), date: DAY, now: at(9, 54, 20), live: true });
  const [m1, m5] = m.frames;
  assert.equal(m1.state, 'NEGATIVE'); assert.ok(Math.abs(m1.rocPct - ((22118 - 22127) / 22127) * 100) < 1e-9);
  assert.equal(m5.state, 'POSITIVE'); assert.ok(Math.abs(m5.rocPct - ((22130 - 22095) / 22095) * 100) < 1e-9);
  assert.equal(m5.fading, true); assert.ok(m5.lastBarPct < 0);
  assert.equal(m.alignment, 'MIXED'); assert.equal(m.up, 1); assert.equal(m.down, 1);
});

test('momentum: a single available timeframe is only LEANING; too few candles => UNAVAILABLE, never a made-up FLAT', () => {
  const one = computeMomentum({ cs: run(40), date: DAY, now: at(9, 54, 20), live: true, tfs: [1] });
  assert.equal(one.alignment, 'LEANING_UP');
  const few = computeMomentum({ cs: run(3), date: DAY, now: at(9, 18, 20), live: true });
  assert.equal(few.alignment, 'UNAVAILABLE'); assert.equal(few.available, 0);
  assert.ok(few.frames.every((f) => !f.available && f.rocPct === null && f.state === null));
  // not live (market closed): every candle is complete, including the last one
  const closed = computeMomentum({ cs: run(4), date: DAY, now: at(16, 0), live: false, tfs: [1] });
  assert.equal(closed.frames[0].bars, 4); assert.equal(closed.frames[0].available, true);
});

test('momentum: a missing BASE bar is a GAP (no silently longer window); a hole between base and last does not change an endpoint ROC', () => {
  const full = computeMomentum({ cs: run(40), date: DAY, now: at(9, 54, 20), live: true, tfs: [1] }).frames[0];
  const noBase = run(40).filter((c) => c.t !== at(9, 50));                    // 3 bars before the last completed bar (09:53) is 09:50
  const g = computeMomentum({ cs: noBase, date: DAY, now: at(9, 54, 20), live: true, tfs: [1] }).frames[0];
  assert.equal(g.available, false); assert.equal(g.reason, 'GAP'); assert.equal(g.rocPct, null); assert.equal(g.state, null);
  const mid = run(40).filter((c) => c.t !== at(9, 51));                       // hole between base and last: both endpoints exist
  const h = computeMomentum({ cs: mid, date: DAY, now: at(9, 54, 20), live: true, tfs: [1] }).frames[0];
  assert.equal(h.available, true); assert.equal(h.rocPct, full.rocPct);
});

test('flat threshold scales with the window: 0.03 % * sqrt(window / 3 minutes)', () => {
  assert.equal(ROC_BARS, 3); assert.equal(FLAT_BASE_PCT, 0.03);
  assert.ok(Math.abs(flatThreshold(1) - 0.03) < 1e-12);
  assert.ok(Math.abs(flatThreshold(5) - 0.03 * Math.sqrt(5)) < 1e-12);
  assert.ok(flatThreshold(30) > flatThreshold(15) && flatThreshold(15) > flatThreshold(5) && flatThreshold(5) > flatThreshold(1));
});

// ================================================================ Support / resistance + OI walls
const EXP = '2030-03-07';
let kk = 1;
const sideRaw = (oi, prev) => ({ instrument_key: `NSE_FO|${kk++}`, market_data: { ltp: 50, volume: 10, oi, prev_oi: prev } });
const rawRow = (strike, c, p) => ({ expiry: EXP, strike_price: strike, underlying_key: NIFTY_KEY, underlying_spot_price: 1, call_options: sideRaw(...c), put_options: sideRaw(...p) });
const chainList = () => [
  rawRow(24000, [100, 100], [900, 700]), rawRow(24100, [200, 150], [1500, 1400]),
  rawRow(24200, [300, 250], [3000, 2000]),   // PUT wall (peak 3000 below spot)
  rawRow(24300, [400, 380], [2900, 2950]),   // 2900 >= 60 % of 3000 but not a local peak
  rawRow(24400, [500, 450], [1000, 1100]), rawRow(24500, [800, 600], [1200, 1000]), rawRow(24600, [2000, 1500], [500, 520]),
  rawRow(24700, [4000, 3000], [400, 400]),   // CALL wall (peak 4000 above spot)
  rawRow(24800, [3900, 4300], [300, 300]), rawRow(24900, [1000, 1000], [200, 250]), rawRow(25000, [500, 800], [100, 100]),
];
const chainRows = () => parseChain(chainList(), EXP, NIFTY_KEY).rows;
const OI_BASE = 24450;                                                         // 24450 .. 24500 range, spot 24500
const liveScene = (over = {}) => scene({ candles: run(46, { base: OI_BASE, step: 1 }), now: at(10, 0, 20), ltp: 24500, cp: 24400, day: { o: 24450, h: 24510, l: 24440 }, chainRows: chainRows(), expiry: EXP, ...over });

test('support / resistance: every level is built from a real source and carries that source', () => {
  const s = liveScene(); const a = analyzeNifty(s);
  const L = a.levels;
  assert.equal(L.classified, true);
  const by = (kind) => L.all.flatMap((l) => l.parts).filter((p) => p.kind === kind);
  assert.deepEqual(by('DAY_HIGH').map((p) => [p.price, p.source]), [[24510, SRC.FEED]]);
  assert.deepEqual(by('DAY_LOW').map((p) => [p.price, p.source]), [[24440, SRC.FEED]]);
  const or = a.openingRange; assert.equal(or.status, 'COMPLETE');
  assert.deepEqual(by('OR_HIGH').map((p) => [p.price, p.source]), [[or.high, SRC.OR]]);
  assert.deepEqual(by('OR_LOW').map((p) => [p.price, p.source]), [[or.low, SRC.OR]]);
  assert.equal(by('VWAP').length, 1); assert.equal(by('VWAP')[0].price, a.vwap.value); assert.match(by('VWAP')[0].label, /proxy/i);
  assert.match(by('VWAP')[0].source, /Average of \(H\+L\+C\)\/3/);
  const cw = by('CALL_OI_WALL'), pw = by('PUT_OI_WALL');
  assert.deepEqual(cw.map((p) => [p.price, p.oi]), [[24700, 4000]]); assert.deepEqual(pw.map((p) => [p.price, p.oi]), [[24200, 3000]]);
  assert.match(cw[0].source, /Option chain OI, expiry 07-MAR-2030, OI 4,000/);
  for (const l of L.all) { assert.ok(l.sources.length >= 1 && l.sources.every((x) => typeof x === 'string' && x.length > 5)); assert.ok(l.label.length > 0); }
  assert.equal(L.oi.included, true); assert.equal(L.oi.expiry, EXP);
});

test('levels are split by the current price and sorted nearest first; the OI walls land on the right side', () => {
  const a = analyzeNifty(liveScene());
  const L = a.levels;
  assert.ok(L.resistances.every((l) => l.price > 24500)); assert.ok(L.supports.every((l) => l.price < 24500));
  assert.deepEqual(L.resistances.map((l) => l.price), [24510, 24700]);          // day high 10 pts away, CALL wall 200 pts away
  assert.equal(L.nearestResistance.price, 24510); assert.equal(L.nearestResistance.distance, 10);
  assert.ok(L.supports.some((l) => l.price === 24200 && /PUT OI wall/.test(l.label)));
  assert.ok(L.supports.some((l) => l.price === 24440 && /Day low/.test(l.label)));
  for (let i = 1; i < L.supports.length; i += 1) assert.ok(L.supports[i].distance >= L.supports[i - 1].distance);
  assert.equal(L.nearestSupport.price, L.supports[0].price);
});

test('identical prices become one level that lists all of its sources (e.g. day high == OR high)', () => {
  const ohlc = { high: { value: 24510, source: SRC.FEED }, low: { value: 24400, source: SRC.FEED } };
  const or = { status: 'COMPLETE', high: 24510, low: 24420 };
  const L = buildLevels({ price: { value: 24480 }, ohlc, vwap: { value: null }, or, oi: null });
  const hi = L.all.find((l) => l.price === 24510);
  assert.equal(hi.parts.length, 2); assert.equal(hi.label, 'Day high + OR high'); assert.deepEqual(hi.sources, [SRC.FEED, SRC.OR]);
  assert.equal(L.all.length, 3);
  // a forming / incomplete opening range is not a level yet
  const L2 = buildLevels({ price: { value: 24480 }, ohlc, vwap: { value: null }, or: { status: 'FORMING', high: 24500, low: 24460 }, oi: null });
  assert.equal(L2.all.length, 2);
});

test('without a price the levels are listed but NOT split into support / resistance, and OI walls are excluded', () => {
  const a = analyzeNifty(liveScene({ quoteAge: 60000 }));                      // stale tick
  assert.equal(a.price.value, null); assert.equal(a.levels.classified, false);
  assert.ok(a.levels.all.length >= 3); assert.ok(a.levels.all.every((l) => l.side === null && l.distance === null));
  assert.equal(a.levels.resistances.length, 0); assert.equal(a.levels.supports.length, 0);
  assert.equal(a.levels.oi.included, false); assert.equal(a.levels.oi.reason, 'NO_PRICE');
  assert.ok(!a.levels.all.some((l) => l.parts.some((p) => /OI_WALL/.test(p.kind))));
});

test('OI walls are excluded (with the reason) from a stale chain, a chain of another expiry, or no chain at all', () => {
  const price = { value: 24500 };
  const rows = chainRows(), fresh = { status: 'LIVE' };
  assert.equal(collectOiWalls({ chain: null, price }).reason, 'NO_CHAIN');
  assert.equal(collectOiWalls({ chain: { rows, expiry: EXP, chainExpiry: EXP, fresh: { status: 'STALE' } }, price }).reason, 'CHAIN_STALE');
  assert.equal(collectOiWalls({ chain: { rows, expiry: EXP, chainExpiry: EXP, fresh: null }, price }).reason, 'CHAIN_UNAVAILABLE');
  const other = collectOiWalls({ chain: { rows, expiry: '2030-03-14', chainExpiry: EXP, fresh }, price });
  assert.equal(other.included, false); assert.equal(other.reason, 'EXPIRY_MISMATCH'); assert.deepEqual(other.walls, []);
  const ok = collectOiWalls({ chain: { rows, expiry: EXP, chainExpiry: EXP, fresh }, price });
  assert.equal(ok.included, true); assert.deepEqual(ok.walls.map((w) => [w.side, w.strike]).sort(), [['CALL', 24700], ['PUT', 24200]]);
  // stale chain in the live scene: the day / OR / VWAP levels stay, the OI walls do not
  const a = analyzeNifty(liveScene({ chainRows: rows }) );
  assert.equal(a.levels.oi.included, true);
});

test('a chain snapshot taken with the market closed is used but labelled as a snapshot', () => {
  const now = ist(2030, 3, 4, 16, 5);
  const cs = run(375, { base: 24450, step: 0.1 });
  const s = scene({ candles: cs, now, market: MS.CLOSED, ltp: 24500, cp: 24400, day: { o: 24450, h: 24510, l: 24440, ts: ist(2030, 3, 4, 15, 29) }, quoteDate: DAY, chainRows: chainRows(), expiry: EXP });
  const a = analyzeNifty(s);
  assert.equal(a.session.live, false); assert.equal(a.levels.oi.included, true); assert.equal(a.levels.oi.snapshot, true);
  const wall = a.levels.all.flatMap((l) => l.parts).find((p) => p.kind === 'CALL_OI_WALL');
  assert.match(wall.source, /market-closed snapshot/);
});

// ================================================================ Session handling + integration
test('live happy path: all sections are filled from real inputs and nothing is a signal', () => {
  const a = analyzeNifty(liveScene());
  assert.equal(a.ok, true); assert.equal(a.session.kind, 'CURRENT'); assert.match(a.session.label, /^LIVE SESSION 04-MAR-2030$/);
  assert.equal(a.openingRange.status, 'COMPLETE'); assert.equal(a.openingRange.state, 'BREAKOUT');   // 24500 > OR high 24467
  assert.equal(a.vwap.method, 'PROXY'); assert.ok(['ABOVE', 'BELOW', 'AT'].includes(a.vwap.position));
  assert.equal(a.momentum.available >= 2, true);
  assert.deepEqual(a.issues, []);
  // part 9 explicitly stops short of a trading signal
  const json = JSON.stringify(a);
  assert.ok(!/"signal"|"recommendation"|"action"/.test(json));
  assert.ok(!('signal' in a) && !('confidence' in a));
});

test('market closed, previous session: values are labelled PREVIOUS SESSION and come from that session only', () => {
  const now = ist(2030, 3, 5, 8, 0);                                          // Tue 08:00, market not open yet
  const cs = run(375, { base: 22000, step: 0.2 });                            // Monday's full session
  const s = scene({ candles: cs, now, market: MS.PRE_OPEN, ltp: 22070, cp: 21950, quoteDate: DAY, day: { o: 22000, h: 22090, l: 21995, ts: ist(2030, 3, 4, 15, 29) } });
  const a = analyzeNifty(s);
  assert.equal(a.session.live, false); assert.equal(a.session.kind, 'PREVIOUS'); assert.match(a.session.label, /PREVIOUS SESSION 04-MAR-2030/);
  assert.equal(a.price.value, 22070); assert.equal(a.price.source, SRC.FEED_CLOSED);
  assert.equal(a.openingRange.status, 'COMPLETE'); assert.ok(['BREAKOUT', 'BREAKDOWN', 'INSIDE'].includes(a.openingRange.state));
  assert.equal(a.vwap.candles, 375);
});

test('live market with stale candles: VWAP, momentum and candle range are withheld; the finished opening range still stands', () => {
  const now = at(9, 50, 20);
  const cs = run(36);
  const a = analyzeNifty(scene({ candles: cs, now, candlesReceivedAt: now - 120000, day: null }));
  assert.equal(a.vwap.value, null); assert.equal(a.vwap.reason, 'CANDLES_NOT_USABLE');
  assert.equal(a.momentum.alignment, 'UNAVAILABLE'); assert.equal(a.momentum.available, 0);
  assert.equal(a.ohlc.high.value, null);                                       // no feed day candle and the candle set is not trusted
  assert.equal(a.openingRange.status, 'COMPLETE');                             // the 09:15-09:30 window cannot change any more
  assert.ok(a.issues.some((m) => /Candles are STALE/.test(m)));
});

test('REST link down while live: candles are DISCONNECTED, so candle-derived numbers are withheld, not shown as live', () => {
  const a = analyzeNifty(scene({ candles: run(46), now: at(10, 0, 20), link: 'DISCONNECTED' }));
  assert.equal(a.vwap.value, null); assert.equal(a.momentum.alignment, 'UNAVAILABLE');
  assert.ok(a.issues.some((m) => /Candles are DISCONNECTED/.test(m)));
});

test('resolveSession: live => today only; closed => the latest session present', () => {
  const now = at(10, 0);
  const fri = run(10, { day: [2030, 3, 1] }), mon = run(10);
  const live = resolveSession({ quote: null, candles: [...fri, ...mon], now, marketState: MS.OPEN });
  assert.equal(live.date, DAY); assert.equal(live.candles.length, 10); assert.equal(live.otherSessionCandles, 10);
  const stale = resolveSession({ quote: null, candles: fri, now, marketState: MS.OPEN });
  assert.equal(stale.date, DAY); assert.equal(stale.candles.length, 0);        // Friday's candles are not relabelled as today's
  const closed = resolveSession({ quote: null, candles: fri, now, marketState: MS.CLOSED });
  assert.equal(closed.date, '2030-03-01'); assert.equal(closed.kind, 'PREVIOUS'); assert.equal(closed.candles.length, 10);
  assert.equal(resolveSession({ quote: null, candles: [], now, marketState: MS.CLOSED }).date, null);
  assert.equal(resolveSession({ quote: null, candles: [], now: NaN, marketState: MS.OPEN }).date, null);
});

test('no data at all: ok is false and every number is null (never 0)', () => {
  const a = analyzeNifty({ quote: null, quoteFresh: null, candles: [], candlesFresh: null, marketState: MS.OPEN, now: at(10, 0) });
  assert.equal(a.ok, false);
  assert.equal(a.price.value, null); assert.equal(a.ohlc.open.value, null); assert.equal(a.ohlc.high.value, null);
  assert.equal(a.ohlc.low.value, null); assert.equal(a.ohlc.prevClose.value, null); assert.equal(a.ohlc.range.pts, null);
  assert.equal(a.vwap.value, null); assert.equal(a.openingRange.high, null); assert.equal(a.levels.all.length, 0);
  const empty = analyzeNifty();
  assert.equal(empty.ok, false);
});

test('invalid candles are dropped, never repaired', () => {
  const cs = [...run(20), cd(at(9, 40), 22100, 22090, 22110, 22100), cd(NaN, 1, 2, 0.5, 1)];   // high < low; NaN timestamp
  const a = analyzeNifty(scene({ candles: cs, now: at(9, 35, 20), day: null }));
  assert.equal(a.vwap.candles, 20);
});

test('sessionMs converts an IST date + minute-of-day to epoch ms', () => {
  assert.equal(sessionMs(DAY, OPEN_MIN), at(9, 15));
  assert.equal(sessionMs('nope', OPEN_MIN), null);
});

// ================================================================ Scope guards
test('part 9 does not touch the signal engine or the controller (no CALL / PUT signal yet)', async () => {
  const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.ok(!/analytics/.test(rd('../src/engine.js')), 'engine.js must not import the analytics module yet');
  assert.ok(!/from '\.\/analytics'/.test(rd('../src/controller.js')), 'controller.js must not import the analytics module yet');
  const mod = await import('../src/analytics');
  assert.deepEqual(Object.keys(mod).filter((k) => /signal|decide|recommend|confidence|order/i.test(k)), []);
  assert.ok(!/Date\.now\(\)|fetch\(/.test(rd('../src/analytics.js')), 'the module is pure: no clock reads, no network');
});
