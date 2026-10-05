import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChain, shouldAcceptChain, validSpot } from '../src/chain';
import { NIFTY_KEY } from '../src/api';
import { analyzeOi, oiOf, deltaOi, findWalls, fmtInt, fmtDelta, OI_REASON, WALL_SHARE } from '../src/oi';

const EXP = '2030-03-07', OTHER = '2030-03-14';
let k = 1;
// Row shaped like the Upstox Put/Call Option Chain response (market_data.oi / market_data.prev_oi).
const side = (oi, prev, over = {}) => ({ instrument_key: `NSE_FO|${k++}`, market_data: { ltp: 50, volume: 10, oi, prev_oi: prev, ...over } });
const raw = (strike, c, p, over = {}) => ({ expiry: EXP, strike_price: strike, underlying_key: NIFTY_KEY, underlying_spot_price: 1, call_options: side(...c), put_options: side(...p), ...over });
const rowsOf = (list, expiry = EXP) => parseChain(list, expiry, NIFTY_KEY).rows;
const run = (list, spot, over = {}) => analyzeOi({ rows: rowsOf(list), expiry: EXP, chainExpiry: EXP, spot, ...over });

// A chain whose shape is driven only by the data below (strike grid 24000..25000 step 100, spot 24500).
const sample = () => [
  raw(24000, [100, 100], [900, 700]),
  raw(24100, [200, 150], [1500, 1400]),
  raw(24200, [300, 250], [3000, 2000]),   // PUT peak 3000 (below spot)
  raw(24300, [400, 380], [2900, 2950]),   // 2900 >= 60% of 3000 but not a local peak
  raw(24400, [500, 450], [1000, 1100]),
  raw(24500, [800, 600], [1200, 1000]),
  raw(24600, [2000, 1500], [500, 520]),
  raw(24700, [4000, 3000], [400, 400]),   // CALL peak 4000 (above spot), delta +1000
  raw(24800, [3900, 4300], [300, 300]),   // 3900 >= 60% of 4000, not a local peak (neighbour 4000 is higher)
  raw(24900, [1000, 1000], [200, 250]),
  raw(25000, [500, 800], [100, 100]),     // CALL delta -300
];

test('dOI = current OI - previous OI, from the real oi / prev_oi', () => {
  assert.equal(deltaOi(450000, 400000), 50000);
  assert.equal(deltaOi(400000, 450000), -50000);
  assert.equal(deltaOi(0, 0), 0);                // a real zero change is 0, not "missing"
  assert.equal(deltaOi(0, 700), -700);
  const o = oiOf({ oi: 120, prevOi: 100 });
  assert.deepEqual(o, { oi: 120, prevOi: 100, delta: 20, issue: null });
  const r = run(sample(), 24500);
  const row = r.rows.find((x) => x.strike === 24700);
  assert.deepEqual([row.call.oi, row.call.prevOi, row.call.delta], [4000, 3000, 1000]);
  assert.deepEqual([row.put.oi, row.put.prevOi, row.put.delta], [400, 400, 0]);
  assert.equal(r.rows.find((x) => x.strike === 25000).call.delta, -300);
  assert.equal(r.rows.find((x) => x.strike === 24200).put.delta, 1000);
  // totals are sums of the per-option values
  assert.equal(r.totals.callDelta, sample().reduce((s, x) => s + (x.call_options.market_data.oi - x.call_options.market_data.prev_oi), 0));
});

test('missing / invalid OI is never turned into 0 and never invents a change', () => {
  assert.deepEqual(oiOf({ oi: null, prevOi: 100 }), { oi: null, prevOi: 100, delta: null, issue: 'MISSING_OI' });
  assert.deepEqual(oiOf({ oi: 100, prevOi: null }), { oi: 100, prevOi: null, delta: null, issue: 'MISSING_PREV_OI' });
  assert.deepEqual(oiOf(undefined), { oi: null, prevOi: null, delta: null, issue: 'MISSING_OI' });
  assert.equal(oiOf({ oi: NaN, prevOi: 5 }).delta, null);
  assert.equal(oiOf({ oi: -5, prevOi: 5 }).delta, null);
  assert.equal(oiOf({ oi: '12', prevOi: '10' }).delta, 2);   // numeric strings are numbers, as in the rest of the app
  assert.equal(deltaOi(null, 5), null); assert.equal(deltaOi(5, undefined), null); assert.equal(deltaOi('x', 1), null);

  const list = [
    raw(24400, [500, 450], [100, 100]),
    raw(24500, [undefined, 600], [undefined, undefined]),          // Upstox sent no OI at all for this strike
    raw(24600, [900, undefined], [700, 650]),                      // no prev_oi on the call
    raw(24700, [-3, 10], [200, 100]),                              // negative OI is invalid
  ];
  const r = run(list, 24500);
  assert.equal(r.ok, true);
  const by = (s) => r.rows.find((x) => x.strike === s);
  assert.equal(by(24500).call.oi, null); assert.equal(by(24500).put.oi, null);
  assert.equal(by(24600).call.delta, null); assert.equal(by(24600).call.oi, 900);
  assert.equal(by(24700).call.oi, null);
  assert.equal(r.quality.callMissingOi, 2); assert.equal(r.quality.putMissingOi, 1); assert.equal(r.quality.callMissingPrev, 1);
  assert.equal(r.highestCall.strike, 24600);                       // the missing ones are skipped, not treated as 0 or as the max
  assert.equal(r.largestCallDelta.strike, 24400);                  // only strikes with a computable change compete
  // nothing valid at all => refused, not zeros
  const none = run([raw(24500, [undefined, undefined], [undefined, undefined])], 24500);
  assert.equal(none.ok, false); assert.equal(none.reason, OI_REASON.NO_VALID_OI);
  // OI present but no prev_oi anywhere: highest OI works, every change is unavailable
  const noPrev = run([raw(24400, [10, undefined], [20, undefined]), raw(24500, [30, undefined], [5, undefined])], 24500);
  assert.equal(noPrev.ok, true); assert.equal(noPrev.highestCall.strike, 24500);
  assert.equal(noPrev.largestCallDelta, null); assert.equal(noPrev.largestPutDelta, null); assert.equal(noPrev.totals.callDelta, null);
});

test('highest CALL / PUT OI and largest CALL / PUT dOI report the real strike and value', () => {
  const r = run(sample(), 24500);
  assert.deepEqual(r.highestCall, { strike: 24700, oi: 4000 });
  assert.deepEqual(r.highestPut, { strike: 24200, oi: 3000 });
  assert.deepEqual(r.largestCallDelta, { strike: 24700, delta: 1000 });
  assert.deepEqual(r.largestPutDelta, { strike: 24200, delta: 1000 });
  assert.deepEqual(r.largestCallUnwind, { strike: 24800, delta: -400 });
  assert.deepEqual(r.largestPutUnwind, { strike: 24400, delta: -100 });
  assert.deepEqual([r.totals.callOi, r.totals.putOi], [13700, 12000]);
  // highest OI needs no spot at all
  assert.deepEqual(run(sample(), null).highestCall, { strike: 24700, oi: 4000 });
});

test('ties go to the lower strike; an all-zero side has no "highest"', () => {
  const r = run([raw(24400, [500, 0], [10, 0]), raw(24500, [500, 0], [10, 0]), raw(24600, [100, 0], [10, 0])], 24500);
  assert.equal(r.highestCall.strike, 24400); assert.equal(r.highestPut.strike, 24400);
  const z = run([raw(24400, [0, 0], [0, 0]), raw(24500, [0, 0], [0, 0])], 24500);
  assert.equal(z.ok, true); assert.equal(z.highestCall, null); assert.equal(z.highestPut, null); assert.equal(z.largestCallDelta, null);
});

test('OI walls: CALL resistance at/above spot, PUT support at/below spot, local peaks that hold >= 60% of the side maximum', () => {
  const r = run(sample(), 24500);
  assert.equal(r.wallsAvailable, true);
  assert.equal(r.resistance.strike, 24700); assert.equal(r.resistance.oi, 4000);
  assert.equal(r.resistance.distance, 200); assert.equal(r.resistance.prevOi, 3000); assert.equal(r.resistance.delta, 1000);
  assert.equal(r.support.strike, 24200); assert.equal(r.support.oi, 3000); assert.equal(r.support.distance, 300);
  assert.equal(r.resistance.pctOfMax, 100);
  // 24800 (3900) and 24300 (2900) are above the 60% bar but are slopes of a bigger neighbour, not walls
  assert.deepEqual(r.callWalls.map((w) => w.strike), [24700]);
  assert.deepEqual(r.putWalls.map((w) => w.strike), [24200]);
  assert.equal(WALL_SHARE, 0.6);
  // a second, separate peak that is big enough is also reported (strongest first)
  const two = run([raw(24500, [10, 0], [10, 0]), raw(24600, [5000, 0], [10, 0]), raw(24700, [100, 0], [10, 0]), raw(24800, [4000, 0], [10, 0]), raw(24900, [50, 0], [10, 0]), raw(25000, [2000, 0], [10, 0])], 24500);
  assert.deepEqual(two.callWalls.map((w) => w.strike), [24600, 24800]);
  assert.equal(two.callWalls[1].pctOfMax, 80);
  // the other side of spot never counts: a huge CALL OI below spot is not resistance, a huge PUT OI above spot is not support
  const wrong = run([raw(24300, [9999, 0], [10, 0]), raw(24500, [10, 0], [15, 0]), raw(24700, [20, 0], [9999, 0])], 24500);
  assert.equal(wrong.resistance.strike, 24700); assert.equal(wrong.resistance.oi, 20);
  assert.equal(wrong.support.strike, 24500); assert.equal(wrong.support.oi, 15);   // 24700's PUT OI of 9999 is above spot: not a neighbour on the support side
  assert.equal(wrong.highestCall.strike, 24300);          // ...but it is still the highest CALL OI overall
});

test('walls need a valid spot; without one they are unavailable (never guessed), the rest still works', () => {
  for (const bad of [null, undefined, 0, -1, NaN]) {
    const r = run(sample(), bad);
    assert.equal(r.ok, true); assert.equal(r.wallsAvailable, false);
    assert.equal(r.resistance, null); assert.equal(r.support, null); assert.deepEqual(r.callWalls, []);
    assert.equal(r.highestCall.strike, 24700);
  }
  assert.deepEqual(findWalls([], 24500, 'call'), []);
  // spot beyond the last strike: no CALL strike above it, so no resistance is invented
  const beyond = run(sample(), 26000);
  assert.equal(beyond.resistance, null); assert.equal(beyond.support.strike, 24200);
  // the spot used is the live-feed spot, never the chain's own underlying_spot_price (sample rows carry spot = 1)
  assert.equal(validSpot({ ltp: 24500, tsValid: true }, { session: 'CURRENT' }), 24500);
  assert.equal(run(sample(), validSpot({ ltp: 24500, tsValid: true }, null)).resistance.strike, 24700);
});

test('no strike is hardcoded: any strike grid and any spot give an answer derived from the rows only', () => {
  // a completely different grid (step 25, around 1000) and a different shape
  const g = [];
  const oiAt = { 950: [10, 5], 975: [20, 10], 1000: [30, 30], 1025: [900, 100], 1050: [40, 40], 1075: [50, 20] };
  const poAt = { 950: [700, 600], 975: [50, 50], 1000: [30, 30], 1025: [20, 20], 1050: [10, 10], 1075: [5, 5] };
  Object.keys(oiAt).forEach((s) => g.push(raw(Number(s), oiAt[s], poAt[s])));
  const r = run(g, 1003);
  assert.deepEqual(r.highestCall, { strike: 1025, oi: 900 });
  assert.deepEqual(r.highestPut, { strike: 950, oi: 700 });
  assert.deepEqual(r.largestCallDelta, { strike: 1025, delta: 800 });
  assert.equal(r.resistance.strike, 1025); assert.equal(r.support.strike, 950);
  // moving the data moves the answer: shift every strike by +777 and the same shape is found at the shifted strikes
  const shifted = g.map((x) => ({ ...x, strike_price: x.strike_price + 777 }));
  const r2 = run(shifted, 1003 + 777);
  assert.equal(r2.highestCall.strike, 1025 + 777); assert.equal(r2.support.strike, 950 + 777);
  // unsorted input is fine
  assert.equal(run([...sample()].reverse(), 24500).highestCall.strike, 24700);
});

test('every OI figure is for the SELECTED expiry: wrong chain expiry or mixed rows are refused, never merged', () => {
  // chain fetched for another expiry than the one selected
  const otherChain = rowsOf(sample().map((x) => ({ ...x, expiry: OTHER })), OTHER);   // a genuine chain for the OTHER expiry
  const stale = analyzeOi({ rows: otherChain, expiry: EXP, chainExpiry: OTHER, spot: 24500 });
  assert.equal(stale.ok, false); assert.equal(stale.reason, OI_REASON.EXPIRY_MISMATCH);
  assert.equal(analyzeOi({ rows: rowsOf(sample()), expiry: OTHER, chainExpiry: EXP, spot: 24500 }).reason, OI_REASON.EXPIRY_MISMATCH);
  // a row of another expiry smuggled into the stored chain: the whole analysis is refused (no silent filtering, no mixing)
  const mixed = rowsOf(sample()); mixed.push({ ...mixed[0], strike: 26000, expiry: OTHER, call: { ...mixed[0].call, oi: 99999999, prevOi: 1 } });
  const m = analyzeOi({ rows: mixed, expiry: EXP, chainExpiry: EXP, spot: 24500 });
  assert.equal(m.ok, false); assert.equal(m.reason, OI_REASON.MIXED_EXPIRY);
  assert.equal(m.highestCall, undefined);
  // the parser already drops other-expiry rows, so a real response with mixed rows never reaches the analysis
  const real = run([...sample(), raw(26000, [99999999, 1], [1, 1], { expiry: OTHER })], 24500);
  assert.equal(real.ok, true); assert.equal(real.expiry, EXP);
  assert.equal(real.rows.some((x) => x.strike === 26000), false); assert.equal(real.highestCall.strike, 24700);
  // two expiries with different OI give different, separate answers
  const a = analyzeOi({ rows: rowsOf([raw(24500, [100, 50], [10, 5])], EXP), expiry: EXP, chainExpiry: EXP, spot: 24500 });
  const b = analyzeOi({ rows: rowsOf([raw(24500, [777, 700], [10, 5], { expiry: OTHER })], OTHER), expiry: OTHER, chainExpiry: OTHER, spot: 24500 });
  assert.equal(a.highestCall.oi, 100); assert.equal(b.highestCall.oi, 777); assert.equal(a.expiry, EXP); assert.equal(b.expiry, OTHER);
  // a response that arrives after the user changed expiry is not stored, so it can never reach the analysis
  assert.equal(shouldAcceptChain(EXP, OTHER), false);
  // no expiry / no chain / unreadable expiry
  assert.equal(analyzeOi({ rows: rowsOf(sample()), expiry: null, chainExpiry: EXP }).reason, OI_REASON.NO_EXPIRY);
  assert.equal(analyzeOi({ rows: rowsOf(sample()), expiry: 'garbage', chainExpiry: 'garbage' }).reason, OI_REASON.NO_EXPIRY);
  assert.equal(analyzeOi({ rows: [], expiry: EXP, chainExpiry: EXP }).reason, OI_REASON.NO_CHAIN);
  assert.equal(analyzeOi({ rows: null, expiry: EXP, chainExpiry: EXP }).reason, OI_REASON.NO_CHAIN);
  assert.equal(analyzeOi().reason, OI_REASON.NO_EXPIRY);
});

test('display numbers: Indian grouping, signed changes, "--" for missing', () => {
  assert.equal(fmtInt(5636475), '56,36,475'); assert.equal(fmtInt(1234), '1,234'); assert.equal(fmtInt(999), '999');
  assert.equal(fmtInt(0), '0'); assert.equal(fmtInt(100000), '1,00,000'); assert.equal(fmtInt(12345678), '1,23,45,678');
  assert.equal(fmtInt(null), '--'); assert.equal(fmtInt(NaN), '--'); assert.equal(fmtInt(undefined), '--');
  assert.equal(fmtDelta(50000), '+50,000'); assert.equal(fmtDelta(-1200), '-1,200'); assert.equal(fmtDelta(0), '0'); assert.equal(fmtDelta(null), '--');
});
