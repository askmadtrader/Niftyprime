import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseChain, parseSide } from '../src/chain';
import { NIFTY_KEY } from '../src/api';
import {
  pcrOf, computePcr, ivOfRow, greeksOf, makeSample, pushSample, findReference, changeOf, analyzePcrIv, pcrTrend, ivState,
  fixed, signedFixed, fmtGreek, fmtDur, historyText, HIST, COLLECTING_TEXT, NEAR_STRIKES, WINDOW_MS, SAMPLE_GAP_MS, HISTORY_MAX_AGE_MS,
} from '../src/pcriv';

const EXP = '2030-03-07', OTHER = '2030-03-14';
let k = 1;
const gk = (g) => ({ vega: 1.1, theta: -2.2, gamma: 0.00123, delta: 0.5, iv: 12, pop: 41.5, ...g });
const side = (oi, g, md = {}) => ({ instrument_key: `NSE_FO|${k++}`, market_data: { ltp: 50, volume: 10, oi, prev_oi: 1, ...md }, option_greeks: g === null ? undefined : gk(g) });
const raw = (strike, coi, poi, cg, pg, over = {}) => ({ expiry: EXP, strike_price: strike, underlying_key: NIFTY_KEY, call_options: side(coi, cg), put_options: side(poi, pg), ...over });
const rowsOf = (list, expiry = EXP) => parseChain(list, expiry, NIFTY_KEY).rows;
const T0 = 1_900_000_000_000;
const min = (m) => m * 60000;

// 21 strikes 24000..25000 step 50; CALL OI 100/strike, PUT OI 200/strike unless overridden by `fn`
const grid = (fn = () => ({})) => { const a = []; for (let s = 24000; s <= 25000; s += 50) { const o = fn(s) || {}; a.push(raw(s, o.c === undefined ? 100 : o.c, o.p === undefined ? 200 : o.p, o.cg || {}, o.pg || {})); } return a; };

test('total PCR = total PUT OI / total CALL OI over the selected expiry', () => {
  const rows = rowsOf(grid());
  const p = pcrOf(rows);
  assert.equal(p.callOi, 2100); assert.equal(p.putOi, 4200); assert.equal(p.strikes, 21); assert.equal(p.value, 2);
  const rows2 = rowsOf([raw(24500, 300, 150, {}, {}), raw(24550, 100, 250, {}, {})]);
  assert.equal(pcrOf(rows2).value, 400 / 400);
  assert.equal(pcrOf(rowsOf([raw(24500, 0, 0, {}, {})])).value, null);            // CALL OI total 0: no ratio, not Infinity / 0
  assert.equal(pcrOf([]).value, null);
  // a strike with one leg missing is left out of BOTH sums (a missing OI is never 0)
  const half = rowsOf([raw(24500, 100, 200, {}, {}), raw(24550, undefined, 999, {}, {}), raw(24600, 100, 200, {}, {})]);
  const h = pcrOf(half); assert.equal(h.strikes, 2); assert.equal(h.putOi, 400); assert.equal(h.value, 2);
});

test('near-ATM PCR uses a clearly defined range: ATM +/- 5 strikes, labelled, separate from total PCR', () => {
  const rows = rowsOf(grid((s) => (s >= 24250 && s <= 24750 ? { c: 100, p: 300 } : { c: 100, p: 100 })));   // PCR 3 near ATM, 1 outside
  const { total, near } = computePcr(rows, 24512);
  assert.equal(NEAR_STRIKES, 5);
  assert.equal(near.atmStrike, 24500); assert.equal(near.from, 24250); assert.equal(near.to, 24750); assert.equal(near.strikes, 11);
  assert.equal(near.value, 3); assert.equal(near.range, '24250\u201324750');
  assert.ok(near.label.includes('Near-ATM') && near.label.includes('ATM \u00b15 strikes'));
  assert.equal(total.label, 'Total PCR'); assert.equal(total.range, 'all strikes returned for this expiry');
  assert.equal(total.value, (11 * 300 + 10 * 100) / 2100);
  assert.notEqual(total.value, near.value);
  // the window clips at the chain edge and never pads
  const edge = computePcr(rows, 24050).near; assert.equal(edge.from, 24000); assert.equal(edge.to, 24300); assert.equal(edge.strikes, 7);
  // other grids work the same (nothing hardcoded)
  const other = rowsOf([100, 125, 150, 175, 200].map((s) => raw(s, 10, 20, {}, {})));
  assert.deepEqual([computePcr(other, 150).near.from, computePcr(other, 150).near.to], [100, 200]);
  // no usable spot: near-ATM is unavailable (null), total still works
  for (const bad of [null, undefined, 0, NaN, 99999]) {
    const c = computePcr(rows, bad); assert.equal(c.near.value, null); assert.ok(c.near.reason); assert.ok(c.total.value > 0);
  }
  assert.equal(computePcr(rows, null).near.reason, 'NO_SPOT'); assert.equal(computePcr(rows, 99999).near.reason, 'SPOT_OUTSIDE_CHAIN');
});

test('PCR history: insufficient history says COLLECTING HISTORY, never 0.00 / FLAT', () => {
  const rows = rowsOf(grid());
  const a0 = analyzePcrIv({ rows, expiry: EXP, chainExpiry: EXP, spot: 24500, history: [], at: T0 });
  for (const c of [a0.pcr.totalChange, a0.pcr.nearChange, a0.iv.change]) {
    assert.equal(c.status, HIST.COLLECTING); assert.equal(c.text, COLLECTING_TEXT);
    assert.equal(c.abs, undefined); assert.equal(c.trend, undefined);               // no number, no FLAT
    assert.ok(historyText(c).startsWith('COLLECTING HISTORY'));
  }
  // 2 minutes of history is still not enough, and says how far it got
  let h = []; for (let i = 0; i <= 8; i++) h = pushSample(h, makeSample({ rows, expiry: EXP, spot: 24500, at: T0 + i * 15000 }));
  const a2 = analyzePcrIv({ rows, expiry: EXP, chainExpiry: EXP, spot: 24500, history: h, at: T0 + 8 * 15000 });
  assert.equal(a2.pcr.nearChange.status, HIST.COLLECTING); assert.equal(a2.pcr.nearChange.collectedMs, 120000);
  assert.equal(historyText(a2.pcr.nearChange), 'COLLECTING HISTORY (2m 00s of 5m 00s)');
  // 4+ minutes of history: now a real change (here truly unchanged => a real 0.00 FLAT is allowed)
  for (let i = 9; i <= 20; i++) h = pushSample(h, makeSample({ rows, expiry: EXP, spot: 24500, at: T0 + i * 15000 }));
  const a5 = analyzePcrIv({ rows, expiry: EXP, chainExpiry: EXP, spot: 24500, history: h, at: T0 + 20 * 15000 });   // 5:00
  assert.equal(a5.pcr.totalChange.status, HIST.READY); assert.equal(a5.pcr.totalChange.abs, 0); assert.equal(a5.pcr.totalChange.trend, 'FLAT');
  // a history that exists but is too RECENT or too OLD for a 5-minute comparison is still "collecting"
  assert.equal(findReference(h, EXP, T0 + 20 * 15000 + min(9)).ref, null);
  assert.equal(findReference(h, EXP, T0 + 20 * 15000 + min(9)).spanMs > 0, true);
  // current value missing => UNAVAILABLE (not collecting, not 0)
  assert.equal(changeOf(null, 1, { ref: {} }).status, HIST.UNAVAILABLE);
  assert.equal(changeOf(1, null, { ref: {}, ageMs: 1 }).status, HIST.UNAVAILABLE);
});

test('rolling PCR history: ~5-minute change, rising / falling / flat, closest reference wins', () => {
  const mk = (putOi, at, spot = 24500) => makeSample({ rows: rowsOf(grid(() => ({ c: 100, p: putOi }))), expiry: EXP, spot, at });
  let h = [];
  h = pushSample(h, mk(100, T0));                      // PCR 1.0
  h = pushSample(h, mk(110, T0 + min(1)));
  h = pushSample(h, mk(120, T0 + min(5)));             // PCR 1.2: exactly 5 min before the last
  h = pushSample(h, mk(130, T0 + min(8)));
  const nowRows = rowsOf(grid(() => ({ c: 100, p: 150 })));                          // PCR 1.5 now
  const a = analyzePcrIv({ rows: nowRows, expiry: EXP, chainExpiry: EXP, spot: 24500, history: h, at: T0 + min(10) });
  // samples aged 10, 9, 5, 2 min => the 5-min-old one (PCR 1.2) is the reference
  assert.equal(a.pcr.totalChange.status, HIST.READY); assert.equal(a.pcr.totalChange.ageMs, min(5));
  assert.ok(Math.abs(a.pcr.totalChange.from - 1.2) < 1e-9); assert.ok(Math.abs(a.pcr.totalChange.abs - 0.3) < 1e-9);
  assert.equal(a.pcr.totalChange.trend, 'RISING'); assert.equal(a.pcr.nearChange.trend, 'RISING');
  assert.equal(pcrTrend(-0.05), 'FALLING'); assert.equal(pcrTrend(0.01), 'FLAT'); assert.equal(pcrTrend(-0.02), 'FLAT'); assert.equal(pcrTrend(0.021), 'RISING');
  // pushSample: throttled, rolling, immutable, ignores a sample from the past
  const s1 = mk(100, T0), s2 = mk(100, T0 + SAMPLE_GAP_MS - 1), s3 = mk(100, T0 + SAMPLE_GAP_MS);
  const base = [s1]; const after = pushSample(base, s2); assert.equal(after.length, 1); assert.notEqual(after, null);
  assert.equal(pushSample(base, s3).length, 2); assert.equal(base.length, 1);
  assert.equal(pushSample([s3], s1).length, 1);                                       // a sample older than the last one is ignored
  assert.equal(pushSample([s3], s1)[0], s3);
  const old = pushSample([s1], mk(100, T0 + HISTORY_MAX_AGE_MS + 1)); assert.equal(old.length, 1); assert.equal(old[0].t, T0 + HISTORY_MAX_AGE_MS + 1);
  assert.deepEqual(pushSample(undefined, null), []);
  assert.equal(makeSample({ rows: [], expiry: EXP, spot: 1, at: T0 }), null); assert.equal(makeSample({ rows: nowRows, expiry: EXP, spot: 1, at: NaN }), null);
});

test('IV: ATM CALL IV, ATM PUT IV, ATM IV and CALL IV - PUT IV from the real ATM strike', () => {
  const rows = rowsOf(grid((s) => (s === 24500 ? { cg: { iv: 14 }, pg: { iv: 12 } } : { cg: { iv: 20 }, pg: { iv: 20 } })));
  const a = analyzePcrIv({ rows, expiry: EXP, chainExpiry: EXP, spot: 24512, history: [], at: T0 });
  assert.equal(a.iv.atmStrike, 24500); assert.equal(a.iv.callIv, 14); assert.equal(a.iv.putIv, 12); assert.equal(a.iv.atmIv, 13); assert.equal(a.iv.skew, 2);
  assert.equal(analyzePcrIv({ rows, expiry: EXP, chainExpiry: EXP, spot: 24540, history: [], at: T0 }).iv.atmStrike, 24550);   // ATM follows spot
  // negative skew
  const neg = rowsOf(grid(() => ({ cg: { iv: 10 }, pg: { iv: 13.5 } })));
  assert.equal(analyzePcrIv({ rows: neg, expiry: EXP, chainExpiry: EXP, spot: 24500, history: [], at: T0 }).iv.skew, -3.5);
  // one side missing (or 0 = no IV): that side is null, ATM IV and skew are unavailable, nothing is copied from the other leg
  for (const bad of [undefined, null, 0, -1, NaN]) {
    const r = rowsOf(grid(() => ({ cg: { iv: bad }, pg: { iv: 12 } })));
    const v = analyzePcrIv({ rows: r, expiry: EXP, chainExpiry: EXP, spot: 24500, history: [], at: T0 }).iv;
    assert.equal(v.callIv, null); assert.equal(v.putIv, 12); assert.equal(v.atmIv, null); assert.equal(v.skew, null);
  }
  assert.deepEqual(ivOfRow(null), { callIv: null, putIv: null, atmIv: null, skew: null });
  // no spot / spot outside the chain: no ATM, no IV, no Greeks (nothing guessed)
  for (const bad of [null, 99999]) {
    const v = analyzePcrIv({ rows, expiry: EXP, chainExpiry: EXP, spot: bad, history: [], at: T0 });
    assert.equal(v.iv.atmStrike, null); assert.equal(v.iv.atmIv, null); assert.ok(v.iv.reason); assert.equal(v.greeks.strike, null); assert.equal(v.greeks.call.delta, null);
    assert.ok(v.pcr.total.value > 0);
  }
});

test('IV history: ~5-minute ATM IV change on the SAME strike; COLLECTING HISTORY until it exists', () => {
  const at = (iv, spot, t) => ({ rows: rowsOf(grid((s) => ({ cg: { iv: s === 24500 ? iv : 30 }, pg: { iv: s === 24500 ? iv : 30 } }))), spot, t });
  const past = at(10, 24500, T0);
  let h = pushSample([], makeSample({ rows: past.rows, expiry: EXP, spot: past.spot, at: T0 }));
  const now = at(11, 24500, T0 + min(5));
  const a = analyzePcrIv({ rows: now.rows, expiry: EXP, chainExpiry: EXP, spot: 24500, history: h, at: T0 + min(5) });
  assert.equal(a.iv.change.status, HIST.READY); assert.ok(Math.abs(a.iv.change.abs - 1) < 1e-9); assert.ok(Math.abs(a.iv.change.pct - 10) < 1e-9);
  assert.equal(a.iv.change.state, 'EXPANDING'); assert.equal(a.iv.callChange.status, HIST.READY); assert.equal(a.iv.putChange.status, HIST.READY);
  assert.equal(ivState(-4), 'CONTRACTING'); assert.equal(ivState(1), 'STABLE'); assert.equal(ivState(null), null);
  // too early: collecting
  const early = analyzePcrIv({ rows: now.rows, expiry: EXP, chainExpiry: EXP, spot: 24500, history: h, at: T0 + min(2) });
  assert.equal(early.iv.change.status, HIST.COLLECTING); assert.equal(early.iv.change.abs, undefined);
  // spot moved to the next strike: the change is measured on the NEW ATM strike's own earlier IV (not strike-shift noise)
  const rowsMoved = rowsOf(grid((s) => ({ cg: { iv: s === 24550 ? 15 : 30 }, pg: { iv: s === 24550 ? 15 : 30 } })));
  const hh = pushSample([], makeSample({ rows: rowsOf(grid((s) => ({ cg: { iv: s === 24550 ? 14 : 30 }, pg: { iv: s === 24550 ? 14 : 30 } }))), expiry: EXP, spot: 24500, at: T0 }));
  const m = analyzePcrIv({ rows: rowsMoved, expiry: EXP, chainExpiry: EXP, spot: 24551, history: hh, at: T0 + min(5) });
  assert.equal(m.iv.atmStrike, 24550); assert.equal(m.iv.change.status, HIST.READY); assert.equal(m.iv.change.from, 14); assert.equal(m.iv.change.abs, 1);
  // past sample had no IV on that strike => UNAVAILABLE, never a made-up change
  const hNoIv = pushSample([], makeSample({ rows: rowsOf(grid(() => ({ cg: { iv: 0 }, pg: { iv: 0 } }))), expiry: EXP, spot: 24500, at: T0 }));
  assert.equal(analyzePcrIv({ rows: now.rows, expiry: EXP, chainExpiry: EXP, spot: 24500, history: hNoIv, at: T0 + min(5) }).iv.change.status, HIST.UNAVAILABLE);
});

test('Greeks: delta, gamma, theta, vega, IV and POP are the real Upstox values; missing is null / "--"', () => {
  const parsed = parseSide({ instrument_key: 'NSE_FO|1', market_data: { ltp: 5 }, option_greeks: { delta: 0.4512, gamma: 0.000123, theta: -12.34, vega: 7.89, iv: 13.21, pop: 38.6 } });
  assert.equal(parsed.pop, 38.6);                                                    // POP now survives parsing
  assert.deepEqual(greeksOf(parsed), { delta: 0.4512, gamma: 0.000123, theta: -12.34, vega: 7.89, iv: 13.21, pop: 38.6 });
  const rows = rowsOf(grid((s) => (s === 24500 ? { cg: { delta: 0.51, gamma: 0.0011, theta: -9.5, vega: 8.25, iv: 12.4, pop: 47.2 }, pg: { delta: -0.49, gamma: 0.0012, theta: -8.75, vega: 8.3, iv: 13.1, pop: 52.8 } } : {})));
  const g = analyzePcrIv({ rows, expiry: EXP, chainExpiry: EXP, spot: 24500, history: [], at: T0 }).greeks;
  assert.equal(g.strike, 24500);
  assert.deepEqual(g.call, { delta: 0.51, gamma: 0.0011, theta: -9.5, vega: 8.25, iv: 12.4, pop: 47.2 });
  assert.deepEqual(g.put, { delta: -0.49, gamma: 0.0012, theta: -8.75, vega: 8.3, iv: 13.1, pop: 52.8 });
  // nothing sent => nothing shown: every field null, every cell "--"
  const none = greeksOf(parseSide({ instrument_key: 'NSE_FO|2', market_data: { ltp: 5 } }));
  Object.entries(none).forEach(([f, v]) => { assert.equal(v, null, f); assert.equal(fmtGreek(f, v), '--'); });
  assert.deepEqual(greeksOf(undefined), { delta: null, gamma: null, theta: null, vega: null, iv: null, pop: null });
  // partial: only what was sent; the rest stays null (no derived / default / copied value)
  const partial = greeksOf(parseSide({ market_data: {}, option_greeks: { delta: 0.3, iv: 0 } }));
  assert.equal(partial.delta, 0.3); assert.equal(partial.iv, null);
  ['gamma', 'theta', 'vega', 'pop'].forEach((f) => assert.equal(partial[f], null, f));
  // a REAL zero Greek is shown as zero, not "--"
  assert.equal(greeksOf({ delta: 0, gamma: 0, theta: 0, vega: 0, pop: 0, iv: 12 }).delta, 0); assert.equal(fmtGreek('delta', 0), '0.000');
  // junk values never become numbers
  const junk = greeksOf({ delta: NaN, gamma: Infinity, theta: undefined, vega: null, iv: NaN, pop: undefined });
  Object.values(junk).forEach((v) => assert.equal(v, null));
  // a missing Greek on the ATM row of a real chain response stays missing
  const r2 = rowsOf(grid((s) => (s === 24500 ? { cg: { gamma: undefined, pop: undefined } } : {})));
  const g2 = analyzePcrIv({ rows: r2, expiry: EXP, chainExpiry: EXP, spot: 24500, history: [], at: T0 }).greeks;
  assert.equal(g2.call.gamma, null); assert.equal(g2.call.pop, null); assert.equal(g2.call.delta, 0.5);
});

test('everything uses the selected expiry: wrong / mixed chain refused, history never crosses expiries', () => {
  const rows = rowsOf(grid());
  const other = rowsOf(grid().map((x) => ({ ...x, expiry: OTHER })), OTHER);
  const bad = analyzePcrIv({ rows: other, expiry: EXP, chainExpiry: OTHER, spot: 24500, history: [], at: T0 });
  assert.equal(bad.ok, false); assert.equal(bad.reason, 'EXPIRY_MISMATCH'); assert.equal(bad.pcr, undefined); assert.equal(bad.greeks, undefined);
  const mixed = [...rows, { ...rows[0], strike: 26000, expiry: OTHER }];
  assert.equal(analyzePcrIv({ rows: mixed, expiry: EXP, chainExpiry: EXP, spot: 24500, history: [], at: T0 }).reason, 'MIXED_EXPIRY');
  assert.equal(analyzePcrIv({ rows, expiry: null, chainExpiry: EXP }).reason, 'NO_EXPIRY');
  assert.equal(analyzePcrIv({ rows: [], expiry: EXP, chainExpiry: EXP }).reason, 'NO_CHAIN');
  assert.equal(analyzePcrIv().ok, false);
  // a real response with rows of another expiry: they are dropped by the parser and never reach PCR / IV
  const withForeign = rowsOf([...grid(), raw(24500, 99999999, 1, {}, {}, { expiry: OTHER, strike_price: 26000 })]);
  assert.equal(pcrOf(withForeign).callOi, 2100);
  // history from another expiry is invisible: no reference => collecting; pushSample drops it
  const sOther = makeSample({ rows: other, expiry: OTHER, spot: 24500, at: T0 });
  const a = analyzePcrIv({ rows, expiry: EXP, chainExpiry: EXP, spot: 24500, history: [sOther], at: T0 + min(5) });
  assert.equal(a.pcr.totalChange.status, HIST.COLLECTING); assert.equal(a.history.samples, 0);
  const merged = pushSample([sOther], makeSample({ rows, expiry: EXP, spot: 24500, at: T0 + min(5) }));
  assert.deepEqual(merged.map((x) => x.expiry), [EXP]);
  // two expiries, different PCR: separate answers
  const e1 = analyzePcrIv({ rows: rowsOf([raw(24500, 100, 300, {}, {})]), expiry: EXP, chainExpiry: EXP, spot: 24500, history: [], at: T0 });
  const e2 = analyzePcrIv({ rows: rowsOf([raw(24500, 100, 50, {}, {}, { expiry: OTHER })], OTHER), expiry: OTHER, chainExpiry: OTHER, spot: 24500, history: [], at: T0 });
  assert.equal(e1.pcr.total.value, 3); assert.equal(e2.pcr.total.value, 0.5);
});

test('display text: "--" for missing, fixed digits per Greek, durations', () => {
  assert.equal(fixed(null), '--'); assert.equal(fixed(undefined), '--'); assert.equal(fixed(NaN), '--'); assert.equal(fixed(0), '0.00'); assert.equal(fixed(1.2345), '1.23');
  assert.equal(signedFixed(0.034), '+0.03'); assert.equal(signedFixed(-1), '-1.00'); assert.equal(signedFixed(null), '--');
  assert.equal(fmtGreek('gamma', 0.001234), '0.00123'); assert.equal(fmtGreek('delta', -0.4949), '-0.495'); assert.equal(fmtGreek('pop', 47.25), '47.3'); assert.equal(fmtGreek('theta', null), '--');
  assert.equal(fmtDur(130000), '2m 10s'); assert.equal(fmtDur(45000), '45s'); assert.equal(fmtDur(NaN), '--');
  assert.equal(historyText({ status: HIST.READY }), null); assert.equal(historyText(null), 'UNAVAILABLE');
});

test('Part 6 code never zero-fills a missing value and never labels collecting history as flat', () => {
  for (const f of ['../src/pcriv.js', '../src/ui/PcrIvCard.js']) {
    const t = readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\/\/[^\n]*/g, '');
    assert.ok(!/(\|\||\?\?)\s*0\b/.test(t), `${f} contains a "|| 0" / "?? 0" fallback`);
  }
  assert.equal(WINDOW_MS, 300000);
});
