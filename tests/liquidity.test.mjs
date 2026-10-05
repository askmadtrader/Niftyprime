import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseChain, parseSide } from '../src/chain';
import { NIFTY_KEY } from '../src/api';
import { computeChainFreshness } from '../src/feed/freshness';
import { MS } from '../src/feed/marketStatus';
import {
  LIQ, LIQ_REASON, DEFAULT_THRESHOLDS, DEFAULT_DELTA, WEIGHTS, CLASS_ORDER,
  mergeThresholds, lotSizeFromPairs, quoteMetrics, freshnessOf, classFromTiers, evaluateSide, analyzeLiquidity, rankContracts,
  reasonText, fmtSpreadPct, fmtLots, fmtScore,
} from '../src/liquidity';

const EXP = '2030-03-07', OTHER = '2030-03-14';
const LOT = 75;
const NOW = 1_900_000_000_000;
let k = 9000;

// ---- fixtures: rows shaped like the Upstox Put/Call Option Chain response, parsed by the real Part 4 parser ----
const Q = (o = {}) => ({ ltp: 100, bid: 99.95, ask: 100.05, bidQty: 750, askQty: 750, oi: 500000, vol: 300000, ...o });   // GOOD on every metric
const rawSide = (o, delta) => ({
  instrument_key: `NSE_FO|${k++}`,
  market_data: { ltp: o.ltp, volume: o.vol, oi: o.oi, prev_oi: 1, bid_price: o.bid, ask_price: o.ask, bid_qty: o.bidQty, ask_qty: o.askQty },
  option_greeks: { delta, iv: 12 },
});
const cDelta = (s) => 0.5 + (24500 - s) / 1200;           // 24250 -> 0.708 ... 24750 -> 0.292
const STRIKES = []; for (let s = 24000; s <= 25000; s += 50) STRIKES.push(s);
const raw = (s, o = {}) => ({
  expiry: EXP, strike_price: s, underlying_key: NIFTY_KEY,
  call_options: rawSide(Q(o.c), o.cd === undefined ? cDelta(s) : o.cd),
  put_options: rawSide(Q(o.p), o.pd === undefined ? cDelta(s) - 1 : o.pd),
});
const grid = (fn = () => ({}), strikes = STRIKES) => strikes.map((s) => raw(s, fn(s) || {}));
const rowsOf = (list, expiry = EXP) => parseChain(list, expiry, NIFTY_KEY).rows;

const fresh = (ageMs = 3000, o = {}) => computeChainFreshness({ chain: [1], receivedAt: NOW - ageMs, requestedMarketState: MS.OPEN, link: 'OK', marketState: MS.OPEN, now: NOW, ...o });
const FRESH_LIVE = fresh(3000);            // status LIVE
const FRESH_60 = fresh(40000);             // status FRESH (still "LIVE" on the chain badge)
const FRESH_STALE = fresh(120000);         // STALE: not refreshed
const FRESH_DISC = fresh(3000, { link: 'DISCONNECTED' });
const FRESH_SNAP = fresh(3000, { marketState: MS.CLOSED });   // market closed: previous-session snapshot

const input = (rows, extra = {}) => ({ rows, expiry: EXP, chainExpiry: EXP, spot: 24510, fresh: FRESH_LIVE, lotSize: LOT, ...extra });
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const side = (o = {}) => parseSide({ instrument_key: 'NSE_FO|1', market_data: { ltp: o.ltp, volume: o.vol, oi: o.oi, bid_price: o.bid, ask_price: o.ask, bid_qty: o.bidQty, ask_qty: o.askQty }, option_greeks: { delta: o.delta } });
const ev = (o, ctx = {}) => evaluateSide(side(Q(o)), { type: 'CE', strike: 24500, lotSize: LOT, freshness: freshnessOf({ rows: [1], expiry: EXP, chainExpiry: EXP, fresh: FRESH_LIVE }), ...ctx });
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };

// =========================================================================================================
// Metrics
// =========================================================================================================
test('quote metrics: spread, spread %, mid and top-of-book depth in lots come from the real bid/ask/qty', () => {
  const m = quoteMetrics(side({ ltp: 100, bid: 99.9, ask: 100.1, bidQty: 300, askQty: 150, oi: 1000, vol: 50 }), LOT);
  near(m.mid, 100); near(m.spread, 0.2); near(m.spreadPct, 0.2);
  assert.equal(m.depthQty, 150); assert.equal(m.depthLots, 2);                      // the SMALLER side decides
  assert.equal(m.twoSided, true); assert.equal(m.crossed, false);
  assert.deepEqual([m.ltp, m.oi, m.volume, m.bid, m.ask, m.bidQty, m.askQty], [100, 1000, 50, 99.9, 100.1, 300, 150]);
  // spread % is relative to the mid price: the same spread on a cheap option is a much bigger cost
  near(quoteMetrics(side({ ltp: 5, bid: 4.9, ask: 5.1, bidQty: 75, askQty: 75 }), LOT).spreadPct, 4);
});

test('quote metrics: a missing value stays null, never 0, never copied from another field', () => {
  const m = quoteMetrics(side({ ltp: 50 }), LOT);
  for (const f of ['bid', 'ask', 'bidQty', 'askQty', 'oi', 'volume', 'mid', 'spread', 'spreadPct', 'depthQty', 'depthLots', 'delta']) assert.equal(m[f], null, f);
  const none = quoteMetrics(undefined, LOT);
  for (const f of ['ltp', 'bid', 'ask', 'oi', 'volume', 'spread', 'spreadPct']) assert.equal(none[f], null, f);
  // a real 0 volume / OI is a value, an LTP of 0 is "no price"
  const z = quoteMetrics(side({ ltp: 0, vol: 0, oi: 0, bid: 1, ask: 2, bidQty: 0, askQty: 5 }), LOT);
  assert.equal(z.volume, 0); assert.equal(z.oi, 0); assert.equal(z.ltp, null); assert.equal(z.depthQty, 0);
});

test('quote metrics: bid 0, ask 0 or a crossed book is not a two-sided market and has no spread', () => {
  for (const [bid, ask] of [[0, 100], [100, 0], [0, 0]]) {
    const m = quoteMetrics(side({ ltp: 100, bid, ask }), LOT);
    assert.equal(m.twoSided, false); assert.equal(m.spread, null); assert.equal(m.spreadPct, null);
  }
  const x = quoteMetrics(side({ ltp: 100, bid: 101, ask: 100 }), LOT);
  assert.equal(x.crossed, true); assert.equal(x.spread, null); assert.equal(x.spreadPct, null);
  // lot size unknown: depth in lots is unknown, the raw quantity is still reported
  for (const lot of [null, undefined, 0, -5, NaN]) { const d = quoteMetrics(side(Q()), lot); assert.equal(d.depthLots, null); assert.equal(d.depthQty, 750); }
});

// =========================================================================================================
// Classification GOOD / FAIR / POOR / UNAVAILABLE
// =========================================================================================================
test('GOOD: tight spread, real depth, high OI and volume', () => {
  const e = ev({});
  assert.equal(e.class, LIQ.GOOD); assert.deepEqual(e.tiers, { spread: LIQ.GOOD, depth: LIQ.GOOD, oi: LIQ.GOOD, volume: LIQ.GOOD });
  assert.deepEqual(e.reasons, []); assert.deepEqual(e.missing, []);
  assert.equal(e.type, 'CE'); assert.equal(e.strike, 24500); assert.ok(e.instrumentKey.startsWith('NSE_FO|'));
});

test('thresholds are inclusive at the GOOD and FAIR edges (spread 1% / 3%, OI 200k / 50k, volume 100k / 20k, depth 5 / 1 lots)', () => {
  assert.equal(ev({ bid: 99.5, ask: 100.5 }).tiers.spread, LIQ.GOOD);      // exactly 1.00 %
  assert.equal(ev({ bid: 99.4, ask: 100.6 }).tiers.spread, LIQ.FAIR);      // 1.2 %
  assert.equal(ev({ bid: 98.5, ask: 101.5 }).tiers.spread, LIQ.FAIR);      // exactly 3.00 %
  assert.equal(ev({ bid: 98.4, ask: 101.6 }).tiers.spread, LIQ.POOR);      // 3.2 %
  assert.equal(ev({ oi: 200000 }).tiers.oi, LIQ.GOOD); assert.equal(ev({ oi: 199999 }).tiers.oi, LIQ.FAIR);
  assert.equal(ev({ oi: 50000 }).tiers.oi, LIQ.FAIR); assert.equal(ev({ oi: 49999 }).tiers.oi, LIQ.POOR);
  assert.equal(ev({ vol: 100000 }).tiers.volume, LIQ.GOOD); assert.equal(ev({ vol: 99999 }).tiers.volume, LIQ.FAIR);
  assert.equal(ev({ vol: 20000 }).tiers.volume, LIQ.FAIR); assert.equal(ev({ vol: 19999 }).tiers.volume, LIQ.POOR);
  assert.equal(ev({ bidQty: 5 * LOT, askQty: 9 * LOT }).tiers.depth, LIQ.GOOD);
  assert.equal(ev({ bidQty: 5 * LOT - 1, askQty: 9 * LOT }).tiers.depth, LIQ.FAIR);
  assert.equal(ev({ bidQty: LOT, askQty: 9 * LOT }).tiers.depth, LIQ.FAIR);
  assert.equal(ev({ bidQty: LOT - 1, askQty: 9 * LOT }).tiers.depth, LIQ.POOR);          // less than one lot at the top on one side
});

test('FAIR: usable but with a weakness (spread 2%, or two metrics only FAIR)', () => {
  assert.equal(ev({ bid: 99, ask: 101 }).class, LIQ.FAIR);                                // spread FAIR: cannot be GOOD
  assert.equal(ev({ oi: 100000 }).class, LIQ.GOOD);                                       // ONE FAIR metric is still GOOD
  assert.equal(ev({ oi: 100000, vol: 50000 }).class, LIQ.FAIR);                           // two FAIR metrics are not
  assert.equal(ev({ oi: 1000 }).class, LIQ.FAIR);                                         // a POOR OI alone (volume fine) -> FAIR
  assert.equal(ev({ vol: 100 }).class, LIQ.FAIR);
});

test('POOR: wide spread, thin depth, or nobody there (OI and volume both POOR)', () => {
  const w = ev({ bid: 97.5, ask: 102.5 }); assert.equal(w.class, LIQ.POOR); assert.ok(w.reasons.includes(LIQ_REASON.WIDE_SPREAD));
  const d = ev({ bidQty: 10 }); assert.equal(d.class, LIQ.POOR); assert.ok(d.reasons.includes(LIQ_REASON.THIN_DEPTH));
  const n = ev({ oi: 1000, vol: 100 }); assert.equal(n.class, LIQ.POOR); assert.ok(n.reasons.includes(LIQ_REASON.LOW_OI) && n.reasons.includes(LIQ_REASON.LOW_VOLUME));
  // a real zero is POOR and reported as 0, not as missing
  const z = ev({ vol: 0 }); assert.equal(z.tiers.volume, LIQ.POOR); assert.equal(z.metrics.volume, 0); assert.deepEqual(z.missing, []);
});

test('missing OI / volume / depth: unknown liquidity is never GOOD, and is reported as missing (not as 0)', () => {
  const o = ev({ oi: null }); assert.equal(o.class, LIQ.FAIR); assert.deepEqual(o.missing, ['oi']); assert.equal(o.metrics.oi, null); assert.ok(o.reasons.includes(LIQ_REASON.MISSING_OI));
  const v = ev({ vol: undefined }); assert.equal(v.class, LIQ.FAIR); assert.deepEqual(v.missing, ['volume']); assert.ok(v.reasons.includes(LIQ_REASON.MISSING_VOLUME));
  assert.equal(ev({ oi: null, vol: null }).class, LIQ.POOR);
  const q = ev({ bidQty: null }); assert.equal(q.class, LIQ.POOR); assert.deepEqual(q.missing, ['depth']); assert.ok(q.reasons.includes(LIQ_REASON.MISSING_DEPTH));
});

test('UNAVAILABLE: no LTP, no bid, no ask, crossed book, or no contract at all', () => {
  const cases = [[{ ltp: null }, LIQ_REASON.NO_LTP], [{ ltp: 0 }, LIQ_REASON.NO_LTP], [{ bid: 0 }, LIQ_REASON.NO_BID], [{ bid: null }, LIQ_REASON.NO_BID],
    [{ ask: 0 }, LIQ_REASON.NO_ASK], [{ ask: null }, LIQ_REASON.NO_ASK], [{ bid: 101, ask: 100 }, LIQ_REASON.CROSSED_QUOTE]];
  for (const [o, reason] of cases) { const e = ev(o); assert.equal(e.class, LIQ.UNAVAILABLE, JSON.stringify(o)); assert.ok(e.reasons.includes(reason), JSON.stringify(o)); assert.deepEqual(e.tiers, { spread: null, depth: null, oi: null, volume: null }); }
  const none = evaluateSide(undefined, { type: 'PE', strike: 24500 }); assert.equal(none.class, LIQ.UNAVAILABLE); assert.ok(none.reasons.includes(LIQ_REASON.NO_CONTRACT));
  assert.ok(CLASS_ORDER.UNAVAILABLE < CLASS_ORDER.POOR && CLASS_ORDER.POOR < CLASS_ORDER.FAIR && CLASS_ORDER.FAIR < CLASS_ORDER.GOOD);
});

test('lot size unknown: depth is only "is something quoted", and the class is capped at FAIR', () => {
  const e = ev({}, { lotSize: null });
  assert.equal(e.tiers.depth, LIQ.FAIR); assert.equal(e.class, LIQ.FAIR); assert.ok(e.reasons.includes(LIQ_REASON.NO_LOT_SIZE)); assert.equal(e.metrics.depthLots, null);
  assert.equal(ev({ bidQty: 0 }, { lotSize: null }).tiers.depth, LIQ.POOR);
});

test('classFromTiers rule: spread/depth POOR -> POOR; both OI and volume POOR -> POOR; GOOD needs a GOOD spread and at most one FAIR', () => {
  const G = LIQ.GOOD, F = LIQ.FAIR, P = LIQ.POOR;
  const c = (spread, depth, oi, volume) => classFromTiers({ spread, depth, oi, volume });
  assert.equal(c(G, G, G, G), G); assert.equal(c(G, F, G, G), G); assert.equal(c(F, G, G, G), F); assert.equal(c(G, F, F, G), F);
  assert.equal(c(P, G, G, G), P); assert.equal(c(G, P, G, G), P); assert.equal(c(G, G, P, P), P); assert.equal(c(G, G, P, G), F);
  assert.equal(c(null, G, G, G), P); assert.equal(c(G, G, null, null), P);          // missing counts as POOR
});

test('thresholds are tunable; invalid overrides are ignored, not half-applied', () => {
  const t = mergeThresholds({ oi: { good: 1000, fair: 100 }, spreadPct: { good: 5, fair: 2 } /* wrong order */, volume: { good: 'x', fair: 1 }, depthLots: null });
  assert.deepEqual(t.oi, { good: 1000, fair: 100 });
  assert.deepEqual(t.spreadPct, DEFAULT_THRESHOLDS.spreadPct); assert.deepEqual(t.volume, DEFAULT_THRESHOLDS.volume); assert.deepEqual(t.depthLots, DEFAULT_THRESHOLDS.depthLots);
  assert.deepEqual(mergeThresholds(), DEFAULT_THRESHOLDS);
  assert.equal(ev({ oi: 60000 }, { thresholds: mergeThresholds({ oi: { good: 50000, fair: 10000 } }) }).tiers.oi, LIQ.GOOD);
  // the defaults object is never mutated by merging
  assert.deepEqual(DEFAULT_THRESHOLDS.oi, { good: 200000, fair: 50000 });
});

// =========================================================================================================
// Freshness
// =========================================================================================================
test('freshness comes from the chain badge (LIVE | STALE | PREVIOUS SESSION | UNAVAILABLE) with the chain age', () => {
  const f = (fr, over = {}) => freshnessOf({ rows: [1], expiry: EXP, chainExpiry: EXP, fresh: fr, ...over });
  const live = f(FRESH_LIVE); assert.equal(live.status, 'LIVE'); assert.equal(live.live, true); assert.equal(live.ageMs, 3000); assert.equal(live.score, 1);
  const mid = f(FRESH_60); assert.equal(mid.status, 'LIVE'); assert.equal(mid.score, 0.85); assert.equal(mid.ageMs, 40000);
  assert.equal(f(FRESH_STALE).status, 'STALE'); assert.equal(f(FRESH_STALE).stale, true);
  assert.equal(f(FRESH_DISC).status, 'STALE');                                    // connection lost: values kept but never live
  const snap = f(FRESH_SNAP); assert.equal(snap.status, 'PREVIOUS SESSION'); assert.equal(snap.snapshot, true); assert.equal(snap.live, false);
  assert.equal(f(undefined).status, 'UNAVAILABLE'); assert.equal(f(FRESH_LIVE, { chainExpiry: OTHER }).status, 'UNAVAILABLE');
});

test('a stale or disconnected chain caps every contract at POOR and nothing is ranked', () => {
  for (const fr of [FRESH_STALE, FRESH_DISC]) {
    const a = analyzeLiquidity(input(rowsOf(grid()), { fresh: fr }));
    assert.equal(a.ok, true); assert.equal(a.freshness.status, 'STALE');
    for (const r of a.rows) for (const e of [r.call, r.put]) { assert.equal(e.class, LIQ.POOR); assert.ok(e.reasons.includes(LIQ_REASON.STALE_CHAIN)); assert.equal(e.freshness.status, 'STALE'); }
    const r = rankContracts(input(rowsOf(grid()), { fresh: fr }));
    assert.equal(r.selectable, false); assert.equal(r.CE.length + r.PE.length, 0); assert.equal(r.best.CE, null); assert.equal(r.best.PE, null);
    assert.ok(r.rejected.every((x) => x.reasons.includes(LIQ_REASON.STALE_CHAIN)));
  }
});

test('a previous-session snapshot is graded but not selectable unless explicitly allowed', () => {
  const rows = rowsOf(grid());
  const a = analyzeLiquidity(input(rows, { fresh: FRESH_SNAP }));
  assert.equal(a.freshness.status, 'PREVIOUS SESSION'); assert.ok(a.rows.every((r) => r.call.class === LIQ.GOOD && r.put.class === LIQ.GOOD));
  assert.ok(a.rows[0].call.reasons.includes(LIQ_REASON.SNAPSHOT_ONLY));
  const off = rankContracts(input(rows, { fresh: FRESH_SNAP }));
  assert.equal(off.selectable, false); assert.equal(off.best.CE, null); assert.ok(off.rejected.every((x) => x.reasons.includes(LIQ_REASON.SNAPSHOT_ONLY)));
  const on = rankContracts(input(rows, { fresh: FRESH_SNAP }), { includeSnapshot: true });
  assert.equal(on.selectable, true); assert.equal(on.best.CE.strike, 24500); assert.equal(on.best.CE.components.freshness, 0.5);
  assert.ok(on.best.CE.score < rankContracts(input(rows)).best.CE.score);          // a snapshot never outranks live data
});

test('without chain freshness every contract is UNAVAILABLE (freshness is required, never assumed)', () => {
  const a = analyzeLiquidity(input(rowsOf(grid()), { fresh: undefined }));
  assert.equal(a.ok, true); assert.equal(a.freshness.status, 'UNAVAILABLE');
  assert.ok(a.rows.every((r) => r.call.class === LIQ.UNAVAILABLE && r.put.class === LIQ.UNAVAILABLE && r.call.reasons.includes(LIQ_REASON.CHAIN_UNAVAILABLE)));
  const r = rankContracts(input(rowsOf(grid()), { fresh: undefined })); assert.equal(r.CE.length + r.PE.length, 0);
});

// =========================================================================================================
// One expiry, ATM, window
// =========================================================================================================
test('one expiry only: a chain for another expiry, or with a foreign row, is refused; nothing is ranked', () => {
  const rows = rowsOf(grid());
  const a = analyzeLiquidity(input(rows, { chainExpiry: OTHER })); assert.equal(a.ok, false); assert.equal(a.reason, 'EXPIRY_MISMATCH');
  const mixed = rows.map((r, i) => (i === 3 ? { ...r, expiry: OTHER } : r));
  const b = rankContracts(input(mixed)); assert.equal(b.ok, false); assert.equal(b.reason, 'MIXED_EXPIRY'); assert.deepEqual(b.CE, []); assert.deepEqual(b.PE, []); assert.equal(b.best.CE, null);
  assert.equal(analyzeLiquidity(input(rows, { expiry: null })).reason, 'NO_EXPIRY');
  assert.equal(analyzeLiquidity(input([])).reason, 'NO_CHAIN');
  assert.ok(analyzeLiquidity(input(rows, { chainExpiry: OTHER })).text);
});

test('ATM comes from the live NIFTY price: no price or a price outside the chain means no analysis, never a guessed ATM', () => {
  const rows = rowsOf(grid());
  for (const bad of [null, undefined, 0, -1, NaN, '24500']) { const a = analyzeLiquidity(input(rows, { spot: bad })); assert.equal(a.ok, false); assert.equal(a.reason, LIQ_REASON.NO_SPOT); assert.ok(a.text); }
  assert.equal(analyzeLiquidity(input(rows, { spot: 99999 })).reason, LIQ_REASON.SPOT_OUTSIDE_CHAIN);
  const r = rankContracts(input(rows, { spot: null })); assert.equal(r.ok, false); assert.equal(r.best.CE, null);
});

test('window: ATM +/- 5 strikes by default, adjustable, clipped at the chain edge, nothing hardcoded', () => {
  const rows = rowsOf(grid());
  const a = analyzeLiquidity(input(rows));
  assert.equal(a.atmStrike, 24500); assert.equal(a.window, 5); assert.equal(a.rows.length, 11);
  assert.deepEqual([a.rows[0].strike, a.rows[10].strike], [24250, 24750]);
  assert.deepEqual(a.rows.filter((r) => r.atm).map((r) => r.strike), [24500]); assert.deepEqual(a.rows.map((r) => r.offset), [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5]);
  assert.equal(analyzeLiquidity(input(rows, { window: 2 })).rows.length, 5);
  assert.equal(analyzeLiquidity(input(rows, { window: 'x' })).window, 5);         // invalid -> default
  const edge = analyzeLiquidity(input(rows, { spot: 24010 }));
  assert.equal(edge.atmStrike, 24000); assert.equal(edge.rows.length, 6); assert.equal(edge.clippedBelow, true); assert.equal(edge.clippedAbove, false);
  // another strike grid works the same way
  const g = []; for (let s = 100; s <= 200; s += 25) g.push(s);
  const o = analyzeLiquidity(input(rowsOf(grid(() => ({}), g)), { spot: 151, window: 2 }));
  assert.equal(o.atmStrike, 150); assert.deepEqual(o.rows.map((r) => r.strike), [100, 125, 150, 175, 200].slice(0, 5));
});

test('summary counts the classes of the contracts near ATM, CE and PE separately', () => {
  const rows = rowsOf(grid((s) => (s === 24500 ? { c: { bid: 97.5, ask: 102.5 }, p: { bid: null } } : {})));
  const a = analyzeLiquidity(input(rows));
  assert.deepEqual(a.summary.CE, { GOOD: 10, FAIR: 0, POOR: 1, UNAVAILABLE: 0 });
  assert.deepEqual(a.summary.PE, { GOOD: 10, FAIR: 0, POOR: 0, UNAVAILABLE: 1 });
});

// =========================================================================================================
// Ranking
// =========================================================================================================
test('equally liquid contracts: the one at ATM wins, ties go to the lower strike; ranks run 1..n', () => {
  const rows = rowsOf(grid());
  const r = rankContracts(input(rows));
  assert.equal(r.ok, true); assert.equal(r.selectable, true); assert.equal(r.CE.length, 11); assert.equal(r.PE.length, 11);
  assert.equal(r.best.CE.strike, 24500); assert.equal(r.best.PE.strike, 24500);
  assert.deepEqual(r.CE.slice(0, 3).map((c) => c.strike), [24500, 24450, 24550]);      // equal distance: lower strike first
  assert.deepEqual(r.CE.map((c) => c.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.ok(r.CE.every((c, i) => i === 0 || r.CE[i - 1].score >= c.score));
  assert.equal(r.best.CE.type, 'CE'); assert.equal(r.best.PE.type, 'PE'); assert.equal(r.best.CE.atm, true);
  // the instrument keys are the real Upstox keys of that strike's CE / PE (so a later part can subscribe to / look up exactly this contract)
  const atm = rows.find((x) => x.strike === 24500);
  assert.equal(r.best.CE.instrumentKey, atm.call.key); assert.equal(r.best.PE.instrumentKey, atm.put.key); assert.notEqual(atm.call.key, atm.put.key);
  assert.equal(r.rows.length, 11); assert.deepEqual(r.rows, analyzeLiquidity(input(rows)).rows);     // same classified window as analyzeLiquidity
});

test('a perfect contract (ATM, all GOOD, delta 0.5, live chain) scores 100; weights add up to 1', () => {
  assert.equal(Object.values(WEIGHTS).reduce((s, w) => s + w, 0).toFixed(10), '1.0000000000');
  const r = rankContracts(input(rowsOf(grid())));
  assert.equal(r.best.CE.score, 100); assert.equal(r.best.PE.score, 100);
  assert.ok(r.CE.every((c) => c.score >= 0 && c.score <= 100));
  for (const c of r.CE) for (const v of Object.values(c.components)) assert.ok(v >= 0 && v <= 1, JSON.stringify(c.components));
  // 40 s old chain (still FRESH) is ranked a little below a 3 s old one
  assert.ok(rankContracts(input(rowsOf(grid()), { fresh: FRESH_60 })).best.CE.score < 100);
});

test('liquidity outweighs proximity: a FAIR ATM contract loses to a GOOD neighbour, and CE / PE are ranked independently', () => {
  const rows = rowsOf(grid((s) => (s === 24500 ? { c: { oi: 100000, vol: 50000 } } : {})));
  const r = rankContracts(input(rows));
  assert.equal(r.best.CE.strike, 24450); assert.equal(r.best.CE.class, LIQ.GOOD);
  assert.equal(r.best.PE.strike, 24500);                                               // the PE at ATM is still perfect
  const atm = r.CE.find((c) => c.strike === 24500); assert.equal(atm.class, LIQ.FAIR); assert.ok(atm.rank > 1);
});

test('POOR and UNAVAILABLE contracts are never ranked and are listed with their reasons', () => {
  const rows = rowsOf(grid((s) => (s === 24500 ? { c: { bid: 97.5, ask: 102.5 }, p: { bid: 0 } } : {})));
  const r = rankContracts(input(rows));
  assert.equal(r.best.CE.strike, 24450); assert.ok(!r.CE.some((c) => c.strike === 24500));
  assert.ok(!r.PE.some((c) => c.strike === 24500)); assert.equal(r.best.PE.strike, 24450);
  const ce = r.rejected.find((x) => x.type === 'CE' && x.strike === 24500); assert.equal(ce.class, LIQ.POOR);
  assert.ok(ce.reasons.includes(LIQ_REASON.BELOW_MIN_CLASS) && ce.reasons.includes(LIQ_REASON.WIDE_SPREAD));
  const pe = r.rejected.find((x) => x.type === 'PE' && x.strike === 24500); assert.equal(pe.class, LIQ.UNAVAILABLE); assert.ok(pe.reasons.includes(LIQ_REASON.NO_BID));
  assert.equal(r.counts.considered, 22); assert.equal(r.counts.ranked, 20); assert.equal(r.counts.rejected, 2);
  assert.ok(reasonText(LIQ_REASON.WIDE_SPREAD) && reasonText('EXPIRY_MISMATCH'));
});

test('minClass GOOD keeps FAIR contracts out; FAIR (default) lets them in', () => {
  const rows = rowsOf(grid((s) => (s === 24500 ? { c: { bid: 99, ask: 101 } } : {})));      // ATM CE spread 2 % = FAIR
  assert.ok(rankContracts(input(rows)).CE.some((c) => c.strike === 24500));
  const g = rankContracts(input(rows), { minClass: LIQ.GOOD });
  assert.ok(!g.CE.some((c) => c.strike === 24500)); assert.ok(g.rejected.some((x) => x.type === 'CE' && x.strike === 24500 && x.reasons.includes(LIQ_REASON.BELOW_MIN_CLASS)));
  assert.equal(g.params.minClass, LIQ.GOOD); assert.equal(rankContracts(input(rows), { minClass: 'whatever' }).params.minClass, LIQ.FAIR);
});

test('delta: must exist, have the sign of the option type, and lie in the wanted range', () => {
  const rows = rowsOf(grid((s) => {
    if (s === 24500) return { cd: null, pd: 0.5 };            // CE delta missing, PE delta positive (wrong sign)
    if (s === 24450) return { cd: -0.54, pd: -0.46 };         // CE delta negative (wrong sign)
    if (s === 24250) return { cd: 0.9 };                      // CE too deep ITM
    if (s === 24750) return { pd: -0.1 };                     // PE too far OTM
    return {};
  }));
  const r = rankContracts(input(rows));
  const why = (type, strike) => (r.rejected.find((x) => x.type === type && x.strike === strike) || {}).reasons;
  assert.deepEqual(why('CE', 24500), [LIQ_REASON.DELTA_MISSING]); assert.deepEqual(why('PE', 24500), [LIQ_REASON.DELTA_WRONG_SIGN]);
  assert.deepEqual(why('CE', 24450), [LIQ_REASON.DELTA_WRONG_SIGN]);
  assert.deepEqual(why('CE', 24250), [LIQ_REASON.DELTA_OUT_OF_RANGE]); assert.deepEqual(why('PE', 24750), [LIQ_REASON.DELTA_OUT_OF_RANGE]);
  assert.equal(r.best.CE.strike, 24550);                  // 24500 and 24450 CE are out, so the next one by ATM proximity
  assert.equal(r.best.PE.strike, 24450);                  // 24500 PE is out; the 24450 PE has a valid delta and is closest to the wanted 0.5
  // the delta range is configurable; the delta of a contract is the one Upstox sent (never derived)
  const tight = rankContracts(input(rowsOf(grid())), { delta: { min: 0.4, max: 0.6, target: 0.5 } });
  assert.deepEqual(tight.CE.map((c) => c.strike).sort((a, b) => a - b), [24400, 24450, 24500, 24550, 24600]);
  assert.ok(tight.CE.every((c) => Math.abs(c.metrics.delta) >= 0.4 && Math.abs(c.metrics.delta) <= 0.6));
  assert.deepEqual(rankContracts(input(rowsOf(grid())), { delta: { min: 0.9, max: 0.1 } }).params.delta, DEFAULT_DELTA);   // invalid -> default
});

test('tie-breaks are deterministic: score, then closer to ATM, then higher volume, then lower strike', () => {
  // 24450 and 24550 score the same (both above the GOOD volume threshold); the one with more volume goes first
  const rows = rowsOf(grid((s) => (s === 24550 ? { c: { vol: 900000 }, p: { vol: 900000 } } : {})));
  const r = rankContracts(input(rows));
  assert.deepEqual(r.CE.slice(0, 3).map((c) => c.strike), [24500, 24550, 24450]); assert.equal(r.CE[1].score, r.CE[2].score);
  assert.deepEqual(r.PE.slice(0, 3).map((c) => c.strike), [24500, 24550, 24450]);
  // same input -> same output, and the input is not touched
  const frozen = deepFreeze(rowsOf(grid()));
  assert.deepEqual(rankContracts(input(frozen)), rankContracts(input(frozen)));
});

test('types option ranks only the requested side; an empty or invalid list means both', () => {
  const rows = rowsOf(grid());
  const ce = rankContracts(input(rows), { types: ['CE'] });
  assert.equal(ce.CE.length, 11); assert.deepEqual(ce.PE, []); assert.equal(ce.best.PE, null); assert.deepEqual(ce.params.types, ['CE']); assert.equal(ce.counts.considered, 11);
  assert.deepEqual(rankContracts(input(rows), { types: ['PE'] }).CE, []);
  for (const t of [[], ['X'], 'CE', null]) { const r = rankContracts(input(rows), { types: t }); assert.equal(r.CE.length, 11); assert.equal(r.PE.length, 11); }
});

test('ranking uses the lot size from the Upstox contracts: more lots of depth ranks higher; unknown lot size is not guessed', () => {
  const shallow = rowsOf(grid((s) => (s === 24450 ? { c: { bidQty: 2 * LOT, askQty: 2 * LOT } } : {})));    // 2 lots = FAIR depth
  const r = rankContracts(input(shallow));
  const a = r.CE.find((c) => c.strike === 24450), b = r.CE.find((c) => c.strike === 24550);
  assert.equal(a.tiers.depth, LIQ.FAIR); assert.ok(a.components.depth < b.components.depth); assert.ok(a.score < b.score);
  const unknown = rankContracts(input(rowsOf(grid()), { lotSize: null }));
  assert.ok(unknown.CE.every((c) => c.class === LIQ.FAIR && c.metrics.depthLots === null && c.reasons.includes(LIQ_REASON.NO_LOT_SIZE)));
  assert.equal(unknown.lotSize, null);
});

test('lotSizeFromPairs: one agreed lot size, otherwise null', () => {
  const c = (lotSize) => ({ lotSize });
  assert.equal(lotSizeFromPairs([{ ce: c(75), pe: c(75) }, { ce: c(75), pe: c(75) }]), 75);
  assert.equal(lotSizeFromPairs([{ ce: c(75), pe: c(65) }]), null);
  assert.equal(lotSizeFromPairs([{ ce: c(75), pe: null }]), 75);
  for (const bad of [[], null, undefined, [{ ce: c(0), pe: c(null) }], [null]]) assert.equal(lotSizeFromPairs(bad), null);
});

// =========================================================================================================
// Scope guards
// =========================================================================================================
test('output only identifies liquid contracts: no CALL/PUT signal, direction or order anywhere in the result', () => {
  const r = rankContracts(input(rowsOf(grid())));
  const keys = new Set(); const walk = (o) => { if (o && typeof o === 'object') Object.entries(o).forEach(([k2, v]) => { keys.add(k2); walk(v); }); }; walk(r);
  const banned = /(signal|direction|action|order|buy|sell|bull|bear|recommend|trade|entry|target|stoploss)/i;
  // `target` exists only inside the delta preference (params.delta.target), which is a ranking input, not a price target
  const hits = Array.from(keys).filter((x) => banned.test(x) && x !== 'target');
  assert.deepEqual(hits, []);
  const a = analyzeLiquidity(input(rowsOf(grid()))); const ak = []; const w2 = (o) => { if (o && typeof o === 'object') Object.entries(o).forEach(([k2, v]) => { ak.push(k2); w2(v); }); }; w2(a);
  assert.deepEqual(ak.filter((x) => banned.test(x)), []);
});

test('the module is pure and not wired into signals or trading: no network, no clock, no UI, not imported by the engine or controller', () => {
  const src = readFileSync(new URL('../src/liquidity.js', import.meta.url), 'utf8');
  for (const bad of ['fetch(', 'WebSocket', 'Date.now', 'new Date', 'setTimeout', 'setInterval', 'react', 'SecureStore', 'Math.random']) assert.ok(!src.includes(bad), `liquidity.js must not use ${bad}`);
  const imports = (src.match(/from '([^']+)'/g) || []).map((m) => m.slice(6, -1));
  assert.deepEqual(imports.sort(), ['./chain', './feed/freshness', './oi', './pcriv']);
  // (engine.js mentions "liquidity" in prose and keeps its own older contract filter until the signal part; it must not IMPORT this module yet)
  for (const f of ['engine.js', 'controller.js', 'alerts.js', 'api.js']) assert.ok(!/from\s+'\.\/liquidity'/.test(readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')), `${f} must not import liquidity (no signal / order wiring in Part 7)`);
});

test('display text: a missing value is "--", a real 0 stays', () => {
  assert.equal(fmtSpreadPct(null), '--'); assert.equal(fmtSpreadPct(undefined), '--'); assert.equal(fmtSpreadPct(NaN), '--');
  assert.equal(fmtSpreadPct(0), '0.00%'); assert.equal(fmtSpreadPct(0.1234), '0.12%');
  assert.equal(fmtLots(null), '--'); assert.equal(fmtLots(10), '10.0'); assert.equal(fmtScore(null), '--'); assert.equal(fmtScore(87.456), '87.5');
});
