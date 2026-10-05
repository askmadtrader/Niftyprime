// PART 10B: signal engine tests + safe integration. Pure Node, no device, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { SIGNAL, CONFIDENCE, GATE_ID, WEIGHTS, DISCLAIMER, PROBABILITY_NOTE, runSignal, formatSignal } from '../src/signal';
import {
  snapshotFromState, evaluateSignal, validateSignalResult, failSafeSignal, toUiSignal, mergeSignalIntoAnalysis, staleReasons, withdrawIfStale,
  PROBABILITY_NOTE as BRIDGE_NOTE,
} from '../src/signalBridge';
import { detectAlerts } from '../src/alerts';
import { MS } from '../src/feed/marketStatus';
import { selectCandles } from '../src/feed/session';
import { at, path, candlesFrom, snapshot, BULL, BEAR, probsOk } from './signal-fixtures.mjs';

// ---------------------------------------------------------------- helpers
const NOW = at(10, 0, 20);                                        // the fixtures' default clock (45 completed candles)
const wide = { bid_price: 100, ask_price: 140, bid_qty: 75, ask_qty: 75 };
const thin = { bid_qty: 1, ask_qty: 1, volume: 10, oi: 500 };
const mapSn = (s, fn) => ({ ...s, chain: { ...s.chain, rows: s.chain.rows.map(fn) } });          // corrupt the parsed chain rows of a scene
const atmOf = (s) => Math.round(s.nifty.ltp / 50) * 50;
const failedIds = (r) => r.gate.failed.map((f) => f.id);
const bearOpts = (extra = {}) => ({
  closes: path({ base: 24600, step: -2 }), vixLtp: 15, vixPrev: 14,
  chain: { callBase: 340000, putBase: 300000, callPeak: [24700, 900000], putPeak: [24300, 900000], putGrowth: -0.02, callGrowth: 0.12, ...extra },
});
// Bearish base scene with the scene-specific overrides applied on top (the chain override is MERGED so the bearish chain survives).
const bearBase = (o) => { const b = bearOpts(); return snapshot({ ...b, ...(o || {}), chain: { ...b.chain, ...((o && o.chain) || {}) } }); };
const bullBase = (o) => snapshot(o);
const same = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));

// Store-shaped state (what the controller hands the bridge), built from a fixture snapshot with the app's own selectCandles.
function stateFrom(sn) {
  const ms = sn.market.state;
  return {
    sNow: sn.now, feed: { conn: sn.conn }, market: sn.market, nifty: sn.nifty, niftyFresh: sn.niftyFresh,
    candles: sn.candles, candlesFresh: sn.candlesFresh, candlesInfo: selectCandles(sn.candles, sn.now, ms).info,
    chain: sn.chain ? sn.chain.rows : null, chainExpiry: sn.chain ? sn.chain.chainExpiry : null, chainFresh: sn.chain ? sn.chain.fresh : null, chainAt: sn.chain ? sn.chain.receivedAt : 0,
    expiry: sn.expiry, pairs: [{ ce: { lotSize: sn.lotSize }, pe: { lotSize: sn.lotSize } }],
    vix: sn.vix, vixFresh: sn.vixFresh, global: sn.global, pcrIvHistory: sn.pcrIvHistory,
  };
}

// ================================================================ 1. DATA-QUALITY GATES: every one of the 12 conditions gives WAIT
// [name, scene builder, check id that must have failed, text the blocker must contain]
const GATES = [
  ['1 market closed', (b) => b({ market: MS.CLOSED }), GATE_ID.MARKET, 'Market status'],
  ['1b pre-open', (b) => b({ market: MS.PRE_OPEN }), GATE_ID.MARKET, 'Market status'],
  ['2 stale NIFTY', (b) => b({ ltt: NOW - 600000, quoteAge: 600000, now: NOW }), GATE_ID.NIFTY, 'NIFTY freshness'],
  ['2b NIFTY missing', (b) => b({ noQuote: true }), GATE_ID.NIFTY, 'NIFTY freshness'],
  ['3 stale option chain', (b) => b({ chainAge: 600000 }), GATE_ID.CHAIN, 'Option-chain freshness'],
  ['3b option chain missing', (b) => { const s = b(); s.chain = null; return s; }, GATE_ID.CHAIN, 'Option-chain freshness'],
  ['4 no OI anywhere', (b) => mapSn(b(), (r) => ({ ...r, call: { ...r.call, oi: null, prevOi: null }, put: { ...r.put, oi: null, prevOi: null } })), GATE_ID.OPTION_DATA, 'Required option data'],
  ['4b ATM delta missing', (b) => { const s = b(); return mapSn(s, (r) => (r.strike === atmOf(s) ? { ...r, call: { ...r.call, delta: null }, put: { ...r.put, delta: null } } : r)); }, GATE_ID.OPTION_DATA, 'ATM delta'],
  ['4c ATM price missing', (b) => { const s = b(); return mapSn(s, (r) => (r.strike === atmOf(s) ? { ...r, call: { ...r.call, ltp: null }, put: { ...r.put, ltp: null } } : r)); }, GATE_ID.OPTION_DATA, 'no price'],
  ['5 no current-session candles', (b) => b({ candles: [], now: NOW }), GATE_ID.CANDLES, 'Current-session candles'],
  ['5b only previous-session candles', (b) => b({ candles: candlesFrom(path(), [2030, 3, 1]), now: NOW }), GATE_ID.CANDLES, 'Current-session candles'],
  ['6 insufficient history', (b) => b({ closes: path({ n: 5 }) }), GATE_ID.HISTORY, 'Minimum historical data'],
  ['7 expired selected expiry', (b) => b({ expiry: '2030-03-01' }), GATE_ID.EXPIRY, 'Selected expiry'],
  ['7b chain belongs to another expiry', (b) => b({ chainExpiry: '2030-03-14' }), GATE_ID.EXPIRY, 'Selected expiry'],
  ['8 WebSocket disconnected', (b) => b({ conn: 'DISCONNECTED' }), GATE_ID.FEED, 'feed connection'],
  ['8b WebSocket reconnecting', (b) => b({ conn: 'RECONNECTING' }), GATE_ID.FEED, 'feed connection'],
  ['9 liquidity data unavailable (OI + volume)', (b) => b({ chain: { callQuote: { volume: null, oi: null }, putQuote: { volume: null, oi: null } } }), GATE_ID.LIQUIDITY, 'Liquidity data'],
  ['9b depth unavailable', (b) => b({ chain: { callQuote: { bid_qty: null, ask_qty: null }, putQuote: { bid_qty: null, ask_qty: null } } }), GATE_ID.LIQUIDITY, 'Liquidity data'],
  ['10 bid/ask unavailable (both legs)', (b) => b({ chain: { callQuote: { bid_price: null, ask_price: null }, putQuote: { bid_price: null, ask_price: null } } }), GATE_ID.SPREAD, 'Bid/ask spread'],
  ['10b bid/ask unavailable (one leg)', (b) => b({ chain: { callQuote: { bid_price: null, ask_price: null } } }), GATE_ID.SPREAD, 'Bid/ask spread'],
  ['10c both legs spread far too wide', (b) => b({ chain: { callQuote: wide, putQuote: wide } }), GATE_ID.SPREAD, 'Bid/ask spread'],
  ['11 chain underlying contradicts NIFTY', (b) => b({ chain: { spotField: 24800 } }), GATE_ID.CONSISTENCY, 'Data consistency'],
  ['11b live price contradicts last candle', (b) => b({ ltp: 24700 }), GATE_ID.CONSISTENCY, 'Data consistency'],
  ['12 low-quality candle series (gaps)', (b) => { const closes = path(); return b({ closes, candles: candlesFrom(closes).filter((c, i) => i % 3 !== 1), now: NOW }); }, GATE_ID.CONSISTENCY, 'Data consistency'],
];

for (const [name, build, id, text] of GATES) {
  test(`gate: ${name} => WAIT 100 / CALL 0 / PUT 0, LOW confidence, blocker names the failed check`, () => {
    for (const [side, base] of [['bullish', bullBase], ['bearish', bearBase]]) {
      const sn = build((o) => base(o));
      const r = runSignal(sn);
      assert.equal(r.signal, SIGNAL.WAIT, `${side}: ${name}`);
      assert.deepEqual(r.probabilities, { CALL: 0, PUT: 0, WAIT: 100 }, side);
      assert.equal(r.confidence, CONFIDENCE.LOW);
      assert.equal(r.gate.ok, false);
      assert.ok(failedIds(r).includes(id), `${side}: expected ${id}, got ${failedIds(r)}`);
      assert.equal(r.directionalScored, false, 'no directional score is calculated when the gate fails');
      assert.ok(r.reasons.blockers.some((b) => b.includes(text)), `${side}: blockers must name "${text}": ${r.reasons.blockers.join(' | ')}`);
      assert.equal(r.reasons.positive.length + r.reasons.negative.length, 0);
      assert.equal(r.vetoes.length, 0);
      probsOk(r);
      assert.deepEqual(validateSignalResult(r), []);
      const u = toUiSignal(r);                                  // the UI sees the same failed check
      assert.equal(u.gateOk, false);
      assert.ok(u.gateFailed.some((g) => g.id === id));
    }
  });
}

test('gate: the uncorrupted base scenes really are directional (so a WAIT above is caused by the corruption, not by the scene)', () => {
  assert.equal(runSignal(bullBase()).signal, SIGNAL.CALL);
  assert.equal(runSignal(bearBase()).signal, SIGNAL.PUT);
});

test('gate: all 12 required conditions are covered by at least one scene above', () => {
  const covered = new Set(GATES.map(([n]) => parseInt(n, 10)));
  for (let i = 1; i <= 12; i++) assert.ok(covered.has(i), `condition ${i}`);
});

test('gate: a corrupted scene can never produce CALL or PUT, whatever the underlying direction (bullish x bearish x every corruption)', () => {
  let n = 0;
  for (const [name, build] of GATES) {
    for (const base of [bullBase, bearBase]) {
      const r = runSignal(build((o) => base(o)));
      assert.equal(r.signal, SIGNAL.WAIT, name);
      assert.equal(r.probabilities.CALL + r.probabilities.PUT, 0, name);
      n += 1;
    }
  }
  assert.equal(n, GATES.length * 2);
});

test('gate: the full gate is reported even when several checks fail at once (no short-circuit)', () => {
  const r = runSignal(snapshot({ conn: 'DISCONNECTED', chainAge: 600000, market: MS.CLOSED }));
  assert.equal(r.gate.checks.length, 11);
  for (const id of [GATE_ID.MARKET, GATE_ID.FEED, GATE_ID.CHAIN]) assert.ok(failedIds(r).includes(id), id);
});

test('a healthy scene passes all 11 gate checks', () => {
  for (const sn of [BULL(), BEAR()]) { const r = runSignal(sn); assert.equal(r.gate.ok, true, JSON.stringify(r.gate.failed)); assert.equal(r.gate.checks.length, 11); assert.ok(r.gate.checks.every((c) => c.ok)); }
});

// ================================================================ 2. DIRECTIONAL FIXTURES
test('direction 1: strong bullish setup => CALL', () => {
  const r = runSignal(BULL());
  assert.equal(r.signal, SIGNAL.CALL);
  assert.ok(r.probabilities.CALL > r.probabilities.PUT && r.probabilities.CALL > r.probabilities.WAIT);
  assert.ok(r.reasons.positive.length >= 3);
  probsOk(r);
});

test('direction 2: strong bearish setup => PUT', () => {
  const r = runSignal(BEAR());
  assert.equal(r.signal, SIGNAL.PUT);
  assert.ok(r.probabilities.PUT > r.probabilities.CALL && r.probabilities.PUT > r.probabilities.WAIT);
  assert.ok(r.reasons.positive.length >= 3);
  probsOk(r);
});

test('direction 3: neutral / mixed setups => WAIT', () => {
  const flat = snapshot({ closes: path({ step: 0, orSwing: 6 }), chain: { putGrowth: 0, callGrowth: 0, callBase: 320000, putBase: 320000, callPeak: [24700, 600000], putPeak: [24300, 600000] } });
  const rf = runSignal(flat);
  assert.equal(rf.gate.ok, true); assert.equal(rf.signal, SIGNAL.WAIT); assert.ok(rf.reasons.blockers.length >= 1); probsOk(rf);
  // price rising, but option-chain flow points the other way
  const mixed = runSignal(snapshot({ chain: { callBase: 340000, putBase: 300000, putGrowth: -0.05, callGrowth: 0.10 } }));
  assert.equal(mixed.gate.ok, true); assert.equal(mixed.signal, SIGNAL.WAIT);
  assert.ok(mixed.vetoes.some((v) => v.id === 'NO_AGREEMENT'), 'price and option flow disagree');
  assert.ok(mixed.reasons.blockers.join(' ').includes('option flow points PUT'));
  probsOk(mixed);
});

test('direction 4: bullish NIFTY vs CALL OI resistance is handled deterministically: wall on top of price => WAIT, a farther wall only costs CALL score', () => {
  const base = runSignal(snapshot());
  const near = runSignal(snapshot({ chain: { callPeak: [24500, 1200000] } }));        // spot 24478: wall 22 pts away
  assert.equal(base.signal, SIGNAL.CALL);
  assert.equal(near.signal, SIGNAL.WAIT);
  assert.deepEqual(near.vetoes.map((v) => v.id), ['WALL_IN_THE_WAY']);
  assert.ok(near.reasons.blockers.join(' ').includes('CALL OI resistance at 24500'));
  assert.ok(near.probabilities.WAIT > near.probabilities.CALL, 'veto makes WAIT the largest');
  assert.ok(near.confidence !== CONFIDENCE.HIGH);
  // sweep the wall away from price: result never gets MORE bullish as the wall gets closer, and the veto flips exactly once
  let prevCall = -1, flips = 0, prevSig = null;
  for (const k of [24500, 24550, 24600, 24650, 24700, 24800]) {
    const r = runSignal(snapshot({ chain: { callPeak: [k, 1200000] } }));
    assert.ok(r.probabilities.CALL >= prevCall, `CALL score must not fall as the wall moves away (${k})`);
    prevCall = r.probabilities.CALL;
    if (prevSig && r.signal !== prevSig) flips += 1;
    prevSig = r.signal;
    assert.ok([...r.reasons.positive, ...r.reasons.negative].some((x) => x.id === 'oiWalls'), `the wall at ${k} is in the reasons`);
    probsOk(r);
  }
  assert.equal(flips, 1);
  const far = runSignal(snapshot({ chain: { callPeak: [24550, 1200000] } }));            // 72 pts away: CALL survives, with the wall as opposing evidence
  assert.equal(far.signal, SIGNAL.CALL);
  assert.ok(far.probabilities.CALL < base.probabilities.CALL + 1);
  for (const o of [{ callPeak: [24500, 1200000] }, { callPeak: [24550, 1200000] }]) same(runSignal(snapshot({ chain: o })), runSignal(snapshot({ chain: o })));
});

test('direction 5: bearish NIFTY vs PUT OI support is handled deterministically (mirror of 4)', () => {
  const closes = path({ base: 24580, step: -2 });                                        // spot 24518
  const mk = (k) => snapshot({ ...bearOpts({ putPeak: [k, 1200000] }), closes });
  const base = runSignal(snapshot({ ...bearOpts({ putPeak: [24300, 900000] }), closes }));
  const near = runSignal(mk(24500));                                                      // support 18 pts below price
  assert.equal(base.signal, SIGNAL.PUT);
  assert.equal(near.signal, SIGNAL.WAIT);
  // support right under price also neutralises the option-flow reading, so NO_AGREEMENT may stand next to WALL_IN_THE_WAY; both are stated
  assert.ok(near.vetoes.some((v) => v.id === 'WALL_IN_THE_WAY'));
  assert.ok(near.reasons.blockers.join(' ').includes('PUT OI support at 24500'));
  assert.ok(near.probabilities.WAIT > near.probabilities.PUT);
  let prevPut = -1;
  for (const k of [24500, 24450, 24400, 24350, 24300, 24200]) {
    const r = runSignal(mk(k));
    assert.ok(r.probabilities.PUT >= prevPut, `PUT score must not fall as the support moves away (${k})`);
    prevPut = r.probabilities.PUT;
    assert.ok([...r.reasons.positive, ...r.reasons.negative].some((x) => x.id === 'oiWalls'));
    probsOk(r);
  }
  same(runSignal(mk(24500)), runSignal(mk(24500)));
});

test('direction 6: strong directional setup with poor liquidity => WAIT (gate or contract veto, never a direction)', () => {
  const scenes = {
    'both spreads wide (gate)': { chain: { callQuote: wide, putQuote: wide } },
    'chosen CALL leg wide (veto)': { chain: { callQuote: wide } },
    'thin depth / volume / OI (veto)': { chain: { callQuote: thin, putQuote: thin } },
  };
  for (const [n, o] of Object.entries(scenes)) {
    const r = runSignal(snapshot(o));
    assert.equal(r.signal, SIGNAL.WAIT, n);
    assert.ok(!r.gate.ok || r.vetoes.some((v) => v.id === 'ILLIQUID_CONTRACT'), n);
    assert.ok(r.reasons.blockers.length >= 1, n);
    probsOk(r);
  }
  // mirror: bearish setup, the PUT leg illiquid
  const rp = runSignal(snapshot(bearOpts({ putQuote: wide })));
  assert.equal(rp.signal, SIGNAL.WAIT);
  assert.ok(rp.vetoes.some((v) => v.id === 'ILLIQUID_CONTRACT'));
  assert.ok(rp.reasons.blockers.join(' ').includes('ATM PUT'));
});

test('direction 7: strong directional setup with stale data => WAIT', () => {
  for (const sn of [snapshot({ ltt: NOW - 600000, quoteAge: 600000, now: NOW }), snapshot({ chainAge: 600000 }), snapshot({ ...bearOpts(), chainAge: 600000 })]) {
    const r = runSignal(sn);
    assert.equal(r.signal, SIGNAL.WAIT);
    assert.deepEqual(r.probabilities, { CALL: 0, PUT: 0, WAIT: 100 });
  }
});

test('direction 8: market closed with otherwise bullish data => WAIT', () => {
  const open = runSignal(snapshot());
  assert.equal(open.signal, SIGNAL.CALL);                                                  // control: the very same data while the market is open
  for (const market of [MS.CLOSED, MS.PRE_OPEN, MS.CAS, MS.UNKNOWN]) {
    const r = runSignal(snapshot({ market }));
    assert.equal(r.signal, SIGNAL.WAIT, market);
    assert.ok(failedIds(r).includes(GATE_ID.MARKET), market);
  }
});

// ================================================================ 3. PROBABILITIES
// Deterministic LCG (no Math.random) drives scene perturbations.
function lcg(seed) { let x = seed >>> 0; return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; }; }
function randomScene(rnd) {
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const bear = rnd() < 0.5;
  const step = pick([-3, -2, -1, 0, 1, 2, 3]);
  const closes = path({ base: 24420 + Math.floor(rnd() * 120), step, n: 20 + Math.floor(rnd() * 25), orSwing: pick([2, 4, 8]) });
  const chain = {
    callBase: 200000 + Math.floor(rnd() * 300000), putBase: 200000 + Math.floor(rnd() * 300000),
    callPeak: [pick([24500, 24550, 24600, 24700, 24800]), 400000 + Math.floor(rnd() * 900000)], putPeak: [pick([24200, 24300, 24400, 24450, 24500]), 400000 + Math.floor(rnd() * 900000)],
    putGrowth: pick([-0.1, -0.02, 0, 0.05, 0.12]), callGrowth: pick([-0.1, -0.02, 0, 0.05, 0.12]),
    ...(rnd() < 0.15 ? { callQuote: pick([wide, thin]) } : null), ...(rnd() < 0.15 ? { putQuote: pick([wide, thin]) } : null),
  };
  void bear;
  return snapshot({
    closes, chain, vixLtp: pick([11, 14, 18, 26]), vixPrev: 14, ...(rnd() < 0.15 ? { vix: null } : null),
    ...(rnd() < 0.15 ? { chainAge: pick([1000, 70000, 600000]) } : null), ...(rnd() < 0.1 ? { market: pick([MS.CLOSED, MS.PRE_OPEN]) } : null), ...(rnd() < 0.1 ? { conn: 'DISCONNECTED' } : null),
    ...(rnd() < 0.2 ? { global: { spx: { pct: 0.8, at: NOW - 1000 }, ixic: { pct: 1.1, at: NOW - 1000 } } } : null),
  });
}

test('probabilities: every result (fixtures + 600 deterministic random scenes) is integer 0..100 and CALL + PUT + WAIT = 100', () => {
  const rnd = lcg(20261005);
  const seen = { CALL: 0, PUT: 0, WAIT: 0, gateFail: 0 };
  const scenes = [BULL(), BEAR(), ...Array.from({ length: 600 }, () => randomScene(rnd))];
  for (const sn of scenes) {
    const r = runSignal(sn);
    probsOk(r);
    for (const k of ['CALL', 'PUT', 'WAIT']) { assert.ok(r.probabilities[k] >= 0 && r.probabilities[k] <= 100); assert.ok(Number.isInteger(r.probabilities[k])); }
    assert.equal(r.probabilities.CALL + r.probabilities.PUT + r.probabilities.WAIT, 100);
    assert.deepEqual(validateSignalResult(r), [], `${r.signal} ${JSON.stringify(r.probabilities)}`);
    seen[r.signal] += 1; if (!r.gate.ok) seen.gateFail += 1;
  }
  assert.ok(seen.CALL > 0 && seen.PUT > 0 && seen.WAIT > 0, `the sweep must exercise all three outcomes: ${JSON.stringify(seen)}`);
  assert.ok(seen.gateFail > 0);
});

test('probabilities: a directional result always has its own probability strictly largest; a WAIT result never hides a larger direction without a veto', () => {
  const rnd = lcg(77);
  for (let i = 0; i < 400; i++) {
    const r = runSignal(randomScene(rnd)), p = r.probabilities;
    if (r.signal === SIGNAL.CALL) assert.ok(p.CALL > p.PUT && p.CALL > p.WAIT);
    if (r.signal === SIGNAL.PUT) assert.ok(p.PUT > p.CALL && p.PUT > p.WAIT);
    if (r.signal === SIGNAL.WAIT && r.gate.ok && Math.max(p.CALL, p.PUT) > p.WAIT) assert.ok(r.vetoes.length > 0, 'a direction that out-scores WAIT may only be withheld by a stated veto');
  }
});

// ================================================================ 4. DETERMINISM
test('determinism: identical input gives identical signal, probabilities, confidence and reasons (25 runs per scene, fresh objects each time)', () => {
  const scenes = {
    bull: () => snapshot(), bear: () => snapshot(bearOpts()), wall: () => snapshot({ chain: { callPeak: [24500, 1200000] } }),
    mixed: () => snapshot({ chain: { callBase: 340000, putBase: 300000, putGrowth: -0.05, callGrowth: 0.10 } }), closed: () => snapshot({ market: MS.CLOSED }),
    flat: () => snapshot({ closes: path({ step: 0, orSwing: 6 }) }),
  };
  for (const [n, build] of Object.entries(scenes)) {
    const ref = runSignal(build());
    for (let i = 0; i < 25; i++) {
      const r = runSignal(build());
      assert.equal(r.signal, ref.signal, n);
      assert.deepEqual(r.probabilities, ref.probabilities, n);
      assert.equal(r.confidence, ref.confidence, n);
      same(r.reasons, ref.reasons);
      same(r, ref);
    }
    const shared = build();                                                                   // the very same object, repeatedly (engine must not mutate its input)
    const before = JSON.stringify(shared);
    const a = runSignal(shared), b = runSignal(shared);
    same(a, b); assert.equal(JSON.stringify(shared), before, `${n}: input was mutated`);
  }
});

test('determinism: the bridge path (state -> evaluateSignal -> UI view) is repeatable and matches the engine exactly', () => {
  for (const sn of [BULL(), BEAR(), snapshot({ chainAge: 600000 })]) {
    const ref = runSignal(sn);
    for (let i = 0; i < 10; i++) { const r = evaluateSignal(stateFrom(sn)); same(r, ref); same(toUiSignal(r), toUiSignal(ref)); }
  }
});

test('determinism: no randomness and no clock reads anywhere in the engine or the bridge', () => {
  for (const f of ['signal.js', 'signalBridge.js']) {
    const src = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/Math\.random|Date\.now|new Date\(\)|performance\.now|crypto\./.test(src), `${f} must not use randomness or the device clock`);
  }
});

// ================================================================ 5. EXPLAINABILITY
test('explain: every directional result has reasons (and each reason is a complete, weighted, scored item)', () => {
  for (const sn of [BULL(), BEAR()]) {
    const r = runSignal(sn);
    assert.notEqual(r.signal, SIGNAL.WAIT);
    assert.ok(r.reasons.positive.length > 0);
    for (const x of r.reasons.positive) { assert.ok(typeof x.text === 'string' && x.text.length > 10); assert.ok(x.weight > 0); assert.ok(Number.isFinite(x.score)); assert.ok(x.id in WEIGHTS); }
    assert.ok(r.reasons.lines.length >= r.reasons.positive.length);
    assert.ok(r.reasons.lines.some((l) => l.startsWith('+ ')));
    // the direction of every positive reason matches the signal, and opposing evidence is listed as negative
    const sign = r.signal === SIGNAL.CALL ? 1 : -1;
    assert.ok(r.reasons.positive.every((x) => x.score * sign > 0));
    assert.ok(r.reasons.negative.every((x) => x.score * sign < 0));
  }
});

test('explain: a WAIT always explains the blocking condition (gate failure, veto, or natural WAIT)', () => {
  // gate failures name the failed check (also covered per scene above)
  for (const [, build] of GATES) {
    const r = runSignal(build((o) => snapshot(o)));
    assert.ok(r.reasons.blockers.length >= 2 && r.reasons.blockers[0].startsWith('Data-quality gate failed:'));
    assert.ok(r.reasons.lines.some((l) => l.startsWith('! Data-quality gate failed')));
  }
  // vetoed WAIT names the veto
  const v = runSignal(snapshot({ chain: { callPeak: [24500, 1200000] } }));
  assert.ok(v.reasons.blockers.some((b) => b.includes('no room for a CALL move')));
  // natural WAIT states why no direction is justified
  const n = runSignal(snapshot({ closes: path({ step: 0, orSwing: 6 }), chain: { putGrowth: 0, callGrowth: 0, callBase: 320000, putBase: 320000, callPeak: [24700, 600000], putPeak: [24300, 600000] } }));
  assert.equal(n.signal, SIGNAL.WAIT);
  assert.ok(n.reasons.blockers.length >= 1 && n.reasons.blockers.every((b) => b.length > 20));
  // across the sweep, no WAIT is ever silent
  const rnd = lcg(5);
  for (let i = 0; i < 300; i++) { const r = runSignal(randomScene(rnd)); if (r.signal === SIGNAL.WAIT) assert.ok(r.reasons.blockers.length > 0 && r.reasons.lines.some((l) => l.startsWith('! '))); }
});

test('explain: reasons correspond to the input data (strikes, prices, bias) and nothing is reported that the input does not hold', () => {
  const sn = BULL();
  const strikes = new Set(sn.chain.rows.map((r) => String(r.strike)));
  const r = runSignal(sn);
  const wall = r.reasons.positive.concat(r.reasons.negative).find((x) => x.id === 'oiWalls');
  assert.ok(wall, 'an OI wall reason exists');
  const nums = wall.text.match(/\b2\d{4}\b/g) || [];
  assert.ok(nums.length > 0 && nums.every((x) => strikes.has(x)), `strikes in "${wall.text}" must exist in the chain`);
  // wall reason names the real peak strikes of the fixture
  assert.match(r.reasons.positive.map((x) => x.text).join(' '), /24300/);
  // dOI reason: the fixture's PUT OI grows (+12 %) and CALL OI falls (-2 %) => bullish flow; flip the data => the reason flips
  const flipped = runSignal(snapshot({ chain: { putGrowth: -0.1, callGrowth: 0.12 } }));
  assert.ok(!flipped.reasons.positive.some((x) => x.id === 'oiFlow'), 'bearish OI flow must not be reported as supporting a CALL');
  // factor scores keep the bias the input implies
  const f = (res, id) => res.factors.find((x) => x.id === id);
  assert.ok(f(r, 'oiFlow').score > 0 && (!f(flipped, 'oiFlow').available || f(flipped, 'oiFlow').score < 0));
  const down = runSignal(snapshot(bearOpts()));
  assert.ok(f(r, 'vwap').score > 0 && f(down, 'vwap').score < 0, 'price vs session average follows the candles');
  assert.ok(f(r, 'momentum').score > 0 && f(down, 'momentum').score < 0);
});

test('explain: nothing is fabricated: absent VIX / global / IV history are reported as missing, never as evidence', () => {
  const r = runSignal(snapshot({ vix: null }));
  assert.ok(r.gate.ok);
  const all = [...r.reasons.positive, ...r.reasons.negative, ...r.reasons.neutral];
  assert.ok(!all.some((x) => x.id === 'vix'), 'no VIX reason without VIX data');
  assert.ok(r.reasons.missing.some((x) => x.id === 'vix'));
  assert.ok(!all.some((x) => x.id === 'global'), 'no global reason without global data');
  assert.ok(r.reasons.missing.some((x) => x.id === 'global'));
  assert.ok(!all.some((x) => x.id === 'ivPrice'), 'no IV-vs-price reason without 5 minutes of IV history');
  assert.ok(r.reasons.missing.some((x) => x.id === 'ivPrice'));
  // an unavailable factor carries no score and no bias
  for (const f of r.factors.filter((x) => !x.available)) { assert.equal(f.score, null); assert.equal(f.bias, null); }
  // every reported factor is a known, documented indicator (no invented ones)
  const rnd = lcg(11);
  for (let i = 0; i < 100; i++) { const x = runSignal(randomScene(rnd)); for (const f of x.factors) assert.ok(f.id in WEIGHTS, `unknown factor ${f.id}`); }
  // the text layout never mentions an indicator the engine did not evaluate
  assert.ok(!/RSI|MACD|Bollinger|stochastic/i.test(formatSignal(runSignal(snapshot()))));
});

test('explain: with VIX data present the VIX reason follows the data (rising VIX is bearish, falling is bullish)', () => {
  const up = runSignal(snapshot({ vixLtp: 17, vixPrev: 14 })), dn = runSignal(snapshot({ vixLtp: 12, vixPrev: 14 }));
  const v = (r) => r.factors.find((x) => x.id === 'vix');
  assert.ok(v(up).available && v(dn).available);
  assert.ok(v(up).score < v(dn).score);
});

// ================================================================ 6. PROBABILITY DISCLAIMER
test('disclaimer: the percentages are labelled as internal model scores / estimated probabilities, not guarantees', () => {
  assert.equal(PROBABILITY_NOTE, 'Internal model score / estimated probability; not a statistical guarantee.');
  assert.equal(BRIDGE_NOTE, PROBABILITY_NOTE);
  assert.ok(DISCLAIMER.startsWith(PROBABILITY_NOTE));
  for (const sn of [BULL(), BEAR(), snapshot({ market: MS.CLOSED })]) {
    const r = runSignal(sn);
    assert.ok(r.disclaimer.startsWith(PROBABILITY_NOTE));
    assert.equal(toUiSignal(r).disclaimer, PROBABILITY_NOTE);
  }
  assert.equal(toUiSignal(failSafeSignal('x')).disclaimer, PROBABILITY_NOTE);
  // the UI renders the engine's wording next to the percentages
  const card = readFileSync(new URL('../src/ui/SignalCard.js', import.meta.url), 'utf8');
  const explain = readFileSync(new URL('../src/ui/ExplainCard.js', import.meta.url), 'utf8');
  assert.ok(card.includes('u.disclaimer'));
  assert.ok(explain.includes('u.disclaimer') || explain.includes(PROBABILITY_NOTE));
  for (const src of [card, explain, readFileSync(new URL('../src/alerts.js', import.meta.url), 'utf8')]) {
    assert.ok(!/accura(te|cy)|guaranteed (profit|win|return)|sure (thing|win)|win rate|will (rise|fall|go up|go down)/i.test(src.replace(/not a statistical guarantee/gi, '')), 'no accuracy / certainty claims in the UI');
  }
  assert.ok(!/% confidence/.test(readFileSync(new URL('../src/alerts.js', import.meta.url), 'utf8')), 'confidence is a label, not a percentage');
});

// ================================================================ 7. BRIDGE: validation + fail-safe
test('bridge: evaluateSignal equals runSignal on the same data (state shape is the controller\'s store shape)', () => {
  for (const sn of [BULL(), BEAR(), snapshot({ market: MS.CLOSED }), snapshot({ chainAge: 600000 }), snapshot({ chain: { callPeak: [24500, 1200000] } })]) {
    same(evaluateSignal(stateFrom(sn)), runSignal(sn));
  }
  const st = stateFrom(BULL());
  const snap = snapshotFromState(st);
  assert.equal(snap.now, st.sNow); assert.equal(snap.conn, 'LIVE'); assert.equal(snap.lotSize, 75); assert.equal(snap.expiry, st.expiry);
  // a chain stored for another expiry is never handed to the engine
  assert.equal(snapshotFromState({ ...st, chainExpiry: '2030-03-14' }).chain, null);
  assert.equal(evaluateSignal({ ...st, chainExpiry: '2030-03-14' }).signal, SIGNAL.WAIT);
});

test('bridge: garbage, empty and throwing state never throws and never gives a direction', () => {
  const bad = [undefined, null, {}, { sNow: NaN }, { feed: null, market: null }, { sNow: 'x', chain: 'y', candles: 5, nifty: 7 }, stateFrom(snapshot({ noQuote: true }))];
  for (const s of bad) { const r = evaluateSignal(s); assert.equal(r.signal, SIGNAL.WAIT); assert.deepEqual(r.probabilities, { CALL: 0, PUT: 0, WAIT: 100 }); assert.ok(r.reasons.blockers.length); }
  const boom = { get sNow() { throw new Error('boom'); } };                                    // an exception inside the engine path
  const r = evaluateSignal(boom);
  assert.equal(r.signal, SIGNAL.WAIT); assert.equal(r.failSafe, true);
  assert.ok(r.reasons.blockers[0].includes('boom'));
  assert.equal(r.confidence, CONFIDENCE.LOW);
});

test('bridge: validateSignalResult rejects every way a result could wrongly show a direction', () => {
  const good = runSignal(BULL());
  assert.deepEqual(validateSignalResult(good), []);
  const mut = (f) => { const c = JSON.parse(JSON.stringify(good)); f(c); return validateSignalResult(c); };
  assert.ok(mut((c) => { c.probabilities.WAIT += 1; }).some((m) => /sum/.test(m)));
  assert.ok(mut((c) => { c.probabilities.CALL = -1; c.probabilities.WAIT += 70 + 1; }).length);
  assert.ok(mut((c) => { c.probabilities.CALL = 101; }).length);
  assert.ok(mut((c) => { c.probabilities.CALL = 70.5; }).length);
  assert.ok(mut((c) => { c.gatePassed = false; }).some((m) => /gate/.test(m)));
  assert.ok(mut((c) => { c.gate.ok = false; }).some((m) => /gate/.test(m)));
  assert.ok(mut((c) => { c.vetoes = [{ id: 'X', text: 'x' }]; }).some((m) => /veto/.test(m)));
  assert.ok(mut((c) => { c.probabilities = { CALL: 30, PUT: 20, WAIT: 50 }; }).some((m) => /largest/.test(m)));
  assert.ok(mut((c) => { c.reasons.positive = []; }).some((m) => /reasons/.test(m)));
  assert.ok(mut((c) => { c.signal = 'BUY'; }).some((m) => /unknown signal/.test(m)));
  assert.ok(mut((c) => { c.confidence = 85; }).some((m) => /confidence/.test(m)));
  assert.deepEqual(validateSignalResult(null), ['no result']);
  assert.deepEqual(validateSignalResult({}), ['no probabilities']);
  assert.deepEqual(validateSignalResult(failSafeSignal('x')), []);
});

test('bridge: the safety net is really applied: a faulty engine result can never reach the UI as CALL / PUT', () => {
  const st = stateFrom(BULL());
  const good = runSignal(BULL());
  const tamper = (f) => () => { const c = JSON.parse(JSON.stringify(good)); f(c); return c; };
  const faults = {
    'gate failed but direction given': tamper((c) => { c.gatePassed = false; c.gate.ok = false; }),
    'probabilities do not sum to 100': tamper((c) => { c.probabilities.WAIT += 5; }),
    'probability above 100': tamper((c) => { c.probabilities.CALL = 120; }),
    'a veto stands': tamper((c) => { c.vetoes = [{ id: 'WALL_IN_THE_WAY', text: 'x' }]; }),
    'direction is not the largest probability': tamper((c) => { c.probabilities = { CALL: 30, PUT: 20, WAIT: 50 }; }),
    'direction without reasons': tamper((c) => { c.reasons.positive = []; }),
    'engine returns nothing': () => undefined,
    'engine throws': () => { throw new Error('engine bug'); },
  };
  assert.equal(evaluateSignal(st, undefined, () => good).signal, SIGNAL.CALL, 'a valid result passes through untouched');
  for (const [name, engine] of Object.entries(faults)) {
    const r = evaluateSignal(st, undefined, engine);
    assert.equal(r.signal, SIGNAL.WAIT, name);
    assert.deepEqual(r.probabilities, { CALL: 0, PUT: 0, WAIT: 100 }, name);
    assert.equal(r.failSafe, true, name);
    assert.equal(r.confidence, CONFIDENCE.LOW, name);
    assert.ok(r.reasons.blockers[0].startsWith('Signal engine problem'), name);
  }
});

test('bridge: the UI view carries SIGNAL, CALL/PUT/WAIT, CONFIDENCE, REASONS and gate status, copied from the engine', () => {
  const r = runSignal(BULL()), u = toUiSignal(r);
  assert.equal(u.signal, r.signal);
  assert.deepEqual([u.callProbability, u.putProbability, u.waitProbability], [r.probabilities.CALL, r.probabilities.PUT, r.probabilities.WAIT]);
  assert.equal(u.confidence, r.confidence);
  assert.deepEqual(u.positive, r.reasons.positive); assert.deepEqual(u.negative, r.reasons.negative); assert.deepEqual(u.blockers, r.reasons.blockers);
  assert.equal(u.gateOk, true); assert.equal(u.gateChecks.length, 11); assert.deepEqual(u.gateFailed, []);
  const w = toUiSignal(runSignal(snapshot({ conn: 'DISCONNECTED' })));
  assert.equal(w.gateOk, false); assert.ok(w.gateFailed.length >= 1 && w.gateFailed.every((g) => g.label && g.details.length));
  assert.equal(w.directionalScored, false);
});

// ================================================================ 8. INTEGRATION INTO THE EXISTING ANALYSIS OBJECT / UI / ALERTS
const legacy = (o) => ({ live: true, signal: 'WAIT', confidence: null, waitReason: 'legacy', notes: [], recommended: null, spot: 24478, ...o });
const rec = (side) => ({ side, strike: 24500, ltp: 140, reason: 'legacy contract' });

test('integration: the new engine overrides the legacy decision (signal, confidence, probabilities, reasons, gate)', () => {
  const call = runSignal(BULL());
  const a1 = mergeSignalIntoAnalysis(legacy({ signal: 'PUT', confidence: 91, recommended: rec('PUT') }), call);
  assert.equal(a1.signal, 'CALL'); assert.equal(a1.confidence, call.confidence); assert.deepEqual(a1.probabilities, call.probabilities);
  assert.equal(a1.recommended, null, 'a legacy PUT contract is never shown under a CALL signal');
  assert.ok(a1.ui && a1.ui.gateOk && a1.ui.positive.length);
  const a2 = mergeSignalIntoAnalysis(legacy({ signal: 'CALL', confidence: 80, recommended: rec('CALL') }), runSignal(snapshot({ chainAge: 600000 })));
  assert.equal(a2.signal, 'WAIT'); assert.equal(a2.recommended, null, 'no contract card under WAIT'); assert.equal(a2.probabilities.WAIT, 100);
  assert.ok(a2.waitReason.includes('Option-chain freshness'));
  const a3 = mergeSignalIntoAnalysis(legacy({ signal: 'CALL', recommended: rec('CALL') }), call);
  assert.equal(a3.recommended.side, 'CALL', 'a matching legacy contract suggestion is kept');
  const a4 = mergeSignalIntoAnalysis(legacy({ signal: 'WAIT' }), call);
  assert.equal(a4.signal, 'CALL'); assert.equal(a4.recommended, null); assert.ok(a4.notes.length, 'direction without a contract explains why no contract is shown');
});

test('integration: legacy fields other cards depend on survive the merge', () => {
  const a = mergeSignalIntoAnalysis(legacy({ tech: { vwap: 1 }, oi: { x: 1 }, session: { label: 'S' }, spot: 24478 }), runSignal(BULL()));
  assert.deepEqual(a.tech, { vwap: 1 }); assert.deepEqual(a.oi, { x: 1 }); assert.deepEqual(a.session, { label: 'S' }); assert.equal(a.spot, 24478); assert.equal(a.live, true);
});

test('integration: alerts fire from the NEW signal only, with label + model score (no % confidence)', () => {
  const wait = mergeSignalIntoAnalysis(legacy(), runSignal(snapshot({ chainAge: 600000 })));
  const call = mergeSignalIntoAnalysis(legacy({ signal: 'WAIT' }), runSignal(BULL()));
  const ev = detectAlerts(wait, call);
  const types = ev.map((e) => e.type);
  assert.ok(types.includes('callSignal') && types.includes('waitToCall'));
  const msg = ev.find((e) => e.type === 'callSignal').msg;
  assert.match(msg, /CALL signal \((HIGH|MEDIUM|LOW) confidence, model score \d+%\)/);
  // legacy engine says CALL, new engine says WAIT => no CALL alert
  const legacyCall = mergeSignalIntoAnalysis(legacy({ signal: 'CALL', confidence: 90 }), runSignal(snapshot({ chainAge: 600000 })));
  assert.equal(detectAlerts(wait, legacyCall).filter((e) => /Signal$|^waitTo/.test(e.type)).length, 0);
  const put = mergeSignalIntoAnalysis(legacy(), runSignal(BEAR()));
  assert.ok(detectAlerts(wait, put).some((e) => e.type === 'putSignal'));
});

test('integration: a direction on screen is withdrawn as soon as its data stops being current (between engine cycles)', () => {
  const sn = BULL(), st = stateFrom(sn);
  const shown = mergeSignalIntoAnalysis(legacy(), runSignal(sn));
  assert.equal(shown.signal, 'CALL');
  assert.deepEqual(staleReasons(st), []);
  assert.equal(withdrawIfStale(shown, st), shown, 'still-current data keeps the same object (no needless re-render)');
  const cases = {
    'feed disconnected': { ...st, feed: { conn: 'DISCONNECTED' } },
    'feed reconnecting': { ...st, feed: { conn: 'RECONNECTING' } },
    'market closed': { ...st, market: { state: MS.CLOSED, fno: MS.CLOSED } },
    'chain stale': stateFrom(snapshot({ chainAge: 600000 })),
    'NIFTY stale': stateFrom(snapshot({ ltt: NOW - 600000, quoteAge: 600000, now: NOW })),
    'no chain': { ...st, chainFresh: null },
  };
  for (const [n, s] of Object.entries(cases)) {
    const out = withdrawIfStale(shown, s);
    assert.equal(out.signal, 'WAIT', n); assert.deepEqual(out.probabilities, { CALL: 0, PUT: 0, WAIT: 100 }, n);
    assert.equal(out.recommended, null, n); assert.ok(out.waitReason.includes('Data no longer current'), n);
    assert.equal(out.ui.gateOk, false, n);
  }
  const w = mergeSignalIntoAnalysis(legacy(), runSignal(snapshot({ conn: 'DISCONNECTED' })));
  assert.equal(withdrawIfStale(w, { ...st, feed: { conn: 'DISCONNECTED' } }), w, 'WAIT is left alone');
  assert.equal(withdrawIfStale(null, st), null);
});

test('integration: the controller and the UI are wired to the new engine through the bridge, and the UI never imports the engine directly', () => {
  const read = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
  const ctl = read('controller.js');
  assert.match(ctl, /from '\.\/signalBridge'/);
  assert.match(ctl, /mergeSignalIntoAnalysis\(a, evaluateSignal\(/);
  assert.ok(ctl.indexOf('decide(a, s.settings, vixUse)') < ctl.indexOf('mergeSignalIntoAnalysis(a, evaluateSignal('), 'the new engine has the last word');
  assert.ok(ctl.indexOf('mergeSignalIntoAnalysis(a, evaluateSignal(') < ctl.indexOf('detectAlerts(prevAnalysis, a)'), 'alerts use the merged signal');
  assert.match(ctl, /withdrawIfStale\(/); assert.match(ctl, /analysis cycle failed/);
  for (const f of ['ui/SignalCard.js', 'ui/ExplainCard.js']) assert.match(read(f), /a\.ui|\.ui\b/);
  assert.match(read('ui/SignalCard.js'), /callProbability/); assert.match(read('ui/SignalCard.js'), /putProbability/); assert.match(read('ui/SignalCard.js'), /waitProbability/);
  assert.match(read('ui/SignalCard.js'), /gateOk/); assert.match(read('ui/SignalCard.js'), /u\.confidence/);
  const importers = [...readdirSync(new URL('../src/', import.meta.url)).filter((f) => f.endsWith('.js')), ...readdirSync(new URL('../src/ui/', import.meta.url)).map((f) => `ui/${f}`)]
    .filter((f) => /from\s+'\.{1,2}\/(\.\.\/)?signal'/.test(read(f)));
  assert.deepEqual(importers, ['signalBridge.js']);
});

// ================================================================ 9. NO AUTOMATIC TRADING
test('safety: no order placement, broker execution or automatic trading code exists anywhere in the app', () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : [new URL(e.name, dir)]));
  const files = [...walk(new URL('../src/', import.meta.url)).filter((u) => u.pathname.endsWith('.js')), new URL('../App.js', import.meta.url)];
  assert.ok(files.length > 30);
  for (const u of files) {
    const src = readFileSync(u, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/place_?order|order\/place|\/v2\/order|\/order\b|modify_?order|cancel_?order|brokerage|auto_?trad|autoTrad|executeOrder|submitOrder|sendOrder|createOrder/i.test(src), `${u.pathname} contains order / trading code`);
  }
  // the API layer only issues GETs and the feed authorisation; no write-style order endpoints
  const api = readFileSync(new URL('../src/api.js', import.meta.url), 'utf8');
  assert.ok(!/\borders?\b/i.test(api.replace(/\/\/.*$/gm, '')), 'api.js has no order endpoint');
});
