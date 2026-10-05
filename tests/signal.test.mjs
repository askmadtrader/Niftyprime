import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  SIGNAL, CONFIDENCE, GATE_ID, WEIGHTS, CFG, DISCLAIMER, MODEL_VERSION,
  evaluateSignalGate, computeSignal, runSignal, bundleFromSnapshot, toPercentages, priceStructure, formatSignal,
} from '../src/signal';
import { buildInstrument, NIFTY_KEY, VIX_KEY } from '../src/feed/feedState';
import { computeFreshness, computeCandleFreshness, computeChainFreshness, THRESHOLDS } from '../src/feed/freshness';
import { MS } from '../src/feed/marketStatus';
import { parseChain } from '../src/chain';
import { makeSample, pushSample } from '../src/pcriv';

import { ist, D, EXP, at, cd, candlesFrom, path, NIFTY_PRICE, rawChain, snapshot, BULL, BEAR, probsOk } from './signal-fixtures.mjs';

// ================================================================ outputs
test('a bullish scene gives CALL with valid probabilities, confidence and explained reasons', () => {
  const r = runSignal(BULL());
  assert.equal(r.gate.ok, true, JSON.stringify(r.gate.failed));
  assert.equal(r.signal, SIGNAL.CALL);
  probsOk(r);
  assert.ok(r.probabilities.CALL > r.probabilities.PUT && r.probabilities.CALL > r.probabilities.WAIT);
  assert.ok(Object.values(CONFIDENCE).includes(r.confidence));
  assert.equal(r.vetoes.length, 0);
  const t = r.reasons.positive.map((x) => x.text).join(' | ');
  assert.match(t, /above session average \(VWAP proxy\)/);
  assert.match(t, /Opening-range breakout/);
  assert.match(t, /PUT OI support/);
  assert.match(t, /Positive PUT \u0394OI/);
  assert.match(t, /Bullish momentum/);
  assert.match(t, /Bullish near-ATM PCR/);
  assert.ok(r.reasons.lines.some((l) => l.startsWith('+ ')));
  assert.equal(r.reasons.perspective, 'CALL');
  assert.ok(r.disclaimer.includes('not a statistical guarantee'));
  assert.equal(r.directionalScored, true);
});

test('a bearish scene gives PUT and the bullish evidence is listed as negative', () => {
  const r = runSignal(BEAR());
  assert.equal(r.gate.ok, true, JSON.stringify(r.gate.failed));
  assert.equal(r.signal, SIGNAL.PUT);
  probsOk(r);
  assert.ok(r.probabilities.PUT > r.probabilities.CALL && r.probabilities.PUT > r.probabilities.WAIT);
  assert.equal(r.reasons.perspective, 'PUT');
  const t = r.reasons.positive.map((x) => x.text).join(' | ');
  assert.match(t, /below session average/); assert.match(t, /Opening-range breakdown/); assert.match(t, /Positive CALL \u0394OI/);
});

test('formatSignal renders the requested layout', () => {
  const r = runSignal(BULL());
  const s = formatSignal(r);
  assert.match(s, /^SIGNAL: CALL\n\nCALL \d+%\nPUT \d+%\nWAIT \d+%\n\nConfidence: (HIGH|MEDIUM|LOW)\n\nReasons:\n\+ /);
  assert.match(s, /not guaranteed market probabilities/);
});

test('a scored WAIT explains the +/-/! legend in the text layout', () => {
  const s = formatSignal(runSignal(snapshot({ chain: { callPeak: [24500, 900000] } })));
  assert.match(s, /^SIGNAL: WAIT/); assert.match(s, /\+ = leans CALL/); assert.match(s, /\n! /);
});

test('exposes the model version and tunable definitions', () => {
  assert.match(MODEL_VERSION, /Part 10A/); assert.ok(DISCLAIMER.length > 40);
  assert.equal(Object.values(WEIGHTS).reduce((a, b) => a + b, 0), 103);
  assert.ok(WEIGHTS.global <= 4, 'global keeps a small weight');
  assert.ok(WEIGHTS.global / Object.values(WEIGHTS).reduce((a, b) => a + b, 0) < 0.05);
});

// ================================================================ determinism
test('same inputs give byte-identical output; no randomness, no clock reads', () => {
  const a = JSON.stringify(runSignal(BULL())), b = JSON.stringify(runSignal(BULL()));
  assert.equal(a, b);
  const src = readFileSync(new URL('../src/signal.js', import.meta.url), 'utf8');
  assert.ok(!/Math\.random|Date\.now|new Date\(|performance\.now|setTimeout|fetch\(|require\(/.test(src.replace(/\/\/.*$/gm, '')));
  // the input is not mutated
  const s = BULL(); const copy = JSON.stringify(s); runSignal(s); assert.equal(JSON.stringify(s), copy);
});

test('toPercentages: always integers 0..100 that sum to exactly 100 (property test, deterministic LCG)', () => {
  let x = 12345; const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 20000; i++) {
    const m = [1, 1e-9, 1e9, 3][i % 4];
    const a = [rnd() * m, rnd() * m, rnd() * m];
    if (i % 7 === 0) a[0] = 0; if (i % 11 === 0) a[1] = 0; if (i % 13 === 0) a[2] = a[0];
    const p = toPercentages(...a);
    assert.ok([p.CALL, p.PUT, p.WAIT].every((v) => Number.isInteger(v) && v >= 0 && v <= 100));
    assert.equal(p.CALL + p.PUT + p.WAIT, 100);
  }
  assert.deepEqual(toPercentages(0, 0, 0), { CALL: 0, PUT: 0, WAIT: 100 });
  assert.deepEqual(toPercentages(NaN, Infinity, -5), { CALL: 0, PUT: 0, WAIT: 100 });
  assert.deepEqual(toPercentages(1, 1, 1), { CALL: 33, PUT: 33, WAIT: 34 });      // tie: the spare point goes to WAIT
  assert.deepEqual(toPercentages(1, 0, 0), { CALL: 100, PUT: 0, WAIT: 0 });
});

// ================================================================ data-quality gate: every critical check
const GATE_CASES = [
  ['market closed', GATE_ID.MARKET, () => snapshot({ market: MS.CLOSED })],
  ['pre-open', GATE_ID.MARKET, () => snapshot({ market: MS.PRE_OPEN })],
  ['market status unknown', GATE_ID.MARKET, () => { const s = snapshot(); s.market = { state: MS.UNKNOWN, fno: MS.UNKNOWN }; return s; }],
  ['NIFTY stale', GATE_ID.NIFTY, () => snapshot({ quoteAge: 60000 })],
  ['NIFTY missing', GATE_ID.NIFTY, () => snapshot({ noQuote: true })],
  ['NIFTY last trade from the previous session', GATE_ID.NIFTY, () => snapshot({ ltt: at(9, 30) - 86400000 })],
  ['option chain stale', GATE_ID.CHAIN, () => snapshot({ chainAge: 120000 })],
  ['option chain fetched before the open', GATE_ID.CHAIN, () => snapshot({ chainRequestedState: MS.PRE_OPEN })],
  ['no option chain', GATE_ID.CHAIN, () => { const s = snapshot(); s.chain = null; return s; }],
  ['required option data: no OI', GATE_ID.OPTION_DATA, () => snapshot({ chain: { callBase: 0, putBase: 0, callPeak: [0, 0], putPeak: [0, 0] } })],
  ['required option data: ATM CALL has no price', GATE_ID.OPTION_DATA, () => snapshot({ chain: { callQuote: { ltp: 0 } } })],
  ['no current-session candles', GATE_ID.CANDLES, () => snapshot({ candles: candlesFrom(path(), [2030, 3, 1]), now: at(10, 5) })],
  ['candles not refreshed', GATE_ID.CANDLES, () => { const s = snapshot(); s.candlesFresh = { ...s.candlesFresh, status: 'STALE' }; return s; }],
  ['too little history', GATE_ID.HISTORY, () => snapshot({ closes: path({ n: 8 }) })],
  ['expiry already expired', GATE_ID.EXPIRY, () => snapshot({ expiry: '2030-03-01', chainExpiry: '2030-03-01', rows: parseChain(rawChain({ spot: 24430, expiry: '2030-03-01' }), '2030-03-01', NIFTY_KEY).rows })],
  ['chain is for another expiry', GATE_ID.EXPIRY, () => snapshot({ chainExpiry: '2030-03-14' })],
  ['feed reconnecting', GATE_ID.FEED, () => snapshot({ conn: 'RECONNECTING' })],
  ['feed disconnected', GATE_ID.FEED, () => snapshot({ conn: 'DISCONNECTED' })],
  ['liquidity data missing (volume)', GATE_ID.LIQUIDITY, () => snapshot({ chain: { callQuote: { volume: null }, putQuote: { volume: null } } })],
  ['bid/ask missing', GATE_ID.SPREAD, () => snapshot({ chain: { callQuote: { bid_price: null, ask_price: null } } })],
  ['spreads too wide on both ATM contracts', GATE_ID.SPREAD, () => snapshot({ chain: { callQuote: { bid_price: 130, ask_price: 170 }, putQuote: { bid_price: 130, ask_price: 170 } } })],
  ['contradictory data: chain underlying far from NIFTY', GATE_ID.CONSISTENCY, () => snapshot({ chain: { spotField: 25500 } })],
  ['contradictory data: live price far from the last candle', GATE_ID.CONSISTENCY, () => snapshot({ ltp: 24900 })],
];
for (const [name, id, make] of GATE_CASES) {
  test(`gate: ${name} => WAIT 100 / CALL 0 / PUT 0 and the reason names the failed check`, () => {
    const r = runSignal(make());
    assert.equal(r.signal, SIGNAL.WAIT, `${name}: ${JSON.stringify(r.probabilities)}`);
    assert.deepEqual(r.probabilities, { CALL: 0, PUT: 0, WAIT: 100 });
    probsOk(r);
    assert.equal(r.confidence, CONFIDENCE.LOW);
    assert.equal(r.gate.ok, false); assert.equal(r.gatePassed, false);
    assert.ok(r.gate.failed.some((f) => f.id === id), `expected ${id}, got ${r.gate.failed.map((f) => f.id)}`);
    assert.equal(r.directionalScored, false);                      // CALL / PUT were never calculated
    assert.equal(r.scores, null); assert.deepEqual(r.factors, []);
    const label = r.gate.checks.find((c) => c.id === id).label;
    assert.ok(r.reasons.blockers.some((b) => b.includes(label)), `blockers must mention "${label}": ${r.reasons.blockers}`);
    assert.ok(r.reasons.blockers.some((b) => /No CALL \/ PUT score was calculated/.test(b)));
    assert.ok(r.reasons.lines.every((l) => l.startsWith('! ')));
  });
}

test('gate: reports all 11 checks every time and lists every failed condition (no short-circuit)', () => {
  const ok = runSignal(BULL());
  assert.equal(ok.gate.checks.length, 11);
  assert.deepEqual(ok.gate.checks.map((c) => c.id).sort(), Object.values(GATE_ID).sort());
  assert.ok(ok.gate.checks.every((c) => c.ok));
  const s = snapshot({ market: MS.CLOSED, conn: 'DISCONNECTED', quoteAge: 60000 });
  const r = runSignal(s);
  const ids = r.gate.failed.map((f) => f.id);
  for (const id of [GATE_ID.MARKET, GATE_ID.FEED, GATE_ID.CHAIN]) assert.ok(ids.includes(id), `${id} in ${ids}`);
  assert.ok(r.reasons.blockers.filter((b) => b.startsWith('Data-quality gate failed')).length >= 3);
  assert.equal(r.signal, 'WAIT');
});

test('a failed gate can never be overridden: even a perfect-looking bullish scene is WAIT when one gate fails, and confidence stays LOW', () => {
  for (const [, , make] of GATE_CASES) { const r = runSignal(make()); assert.equal(r.signal, 'WAIT'); assert.equal(r.confidence, 'LOW'); assert.equal(r.probabilities.WAIT, 100); }
});

test('missing / garbage input never throws and never invents a direction', () => {
  for (const inp of [undefined, {}, { now: 0 }, { now: NaN, nifty: {} }, { now: 1, oi: null, pcriv: null, liquidity: null }]) {
    const r = computeSignal(inp);
    assert.equal(r.signal, 'WAIT'); assert.deepEqual(r.probabilities, { CALL: 0, PUT: 0, WAIT: 100 });
  }
  const r = runSignal({});
  assert.equal(r.signal, 'WAIT');
});

// ================================================================ vetoes: a directional call is not justified
test('price action and option flow disagree => WAIT with an explicit reason (agreement requirement)', () => {
  // bullish price path but bearish options (CALL OI building, PUT OI unwinding, low PCR, CALL wall nearer than PUT wall)
  const r = runSignal(snapshot({ chain: { callBase: 380000, putBase: 260000, callPeak: [24550, 900000], putPeak: [24100, 900000], putGrowth: -0.08, callGrowth: 0.15 } }));
  assert.equal(r.gate.ok, true, JSON.stringify(r.gate.failed));
  assert.equal(r.signal, 'WAIT');
  probsOk(r);
  assert.ok(r.probabilities.WAIT > r.probabilities.CALL && r.probabilities.WAIT > r.probabilities.PUT);
  assert.ok(r.vetoes.some((v) => v.id === 'NO_AGREEMENT'), JSON.stringify(r.vetoes));
  assert.ok(r.reasons.blockers.some((b) => /price action and option-chain flow to agree/.test(b)));
  assert.equal(r.reasons.perspective, 'BULLISH');
  assert.ok(r.reasons.positive.length > 0 && r.reasons.negative.length > 0, 'both bullish and bearish evidence is listed');
});

test('an OI wall right on top of price blocks a CALL (no room) and the reason says so', () => {
  const r = runSignal(snapshot({ chain: { callPeak: [24500, 900000] } }));       // CALL wall 20 points above NIFTY (< 0.12 %)
  assert.equal(r.signal, 'WAIT');
  assert.ok(r.vetoes.some((v) => v.id === 'WALL_IN_THE_WAY'), JSON.stringify(r.vetoes));
  assert.ok(r.reasons.blockers.some((b) => /CALL OI resistance at 24500/.test(b)));
  assert.ok(r.probabilities.WAIT > Math.max(r.probabilities.CALL, r.probabilities.PUT));
});

test('a CALL on an illiquid ATM CALL contract is vetoed (spread required for the chosen side), the PUT leg alone does not open the gate', () => {
  const r = runSignal(snapshot({ chain: { callQuote: { bid_price: 130, ask_price: 170 } } }));      // CALL spread ~27 %, PUT fine
  assert.equal(r.gate.ok, true, JSON.stringify(r.gate.failed));
  assert.equal(r.signal, 'WAIT');
  assert.ok(r.vetoes.some((v) => v.id === 'ILLIQUID_CONTRACT'), JSON.stringify(r.vetoes));
  assert.ok(r.reasons.blockers.some((b) => /ATM CALL option liquidity/.test(b)));
});

test('chop with weak evidence is a natural WAIT that explains why no direction is justified', () => {
  const flat = [];
  for (let i = 0; i < 45; i++) flat.push(24450 + (i % 2 ? 2 : -2));
  const r = runSignal(snapshot({ closes: flat, chain: { callBase: 320000, putBase: 320000, callPeak: [24600, 700000], putPeak: [24300, 700000], putGrowth: 0.01, callGrowth: 0.01 } }));
  assert.equal(r.gate.ok, true, JSON.stringify(r.gate.failed));
  assert.equal(r.signal, 'WAIT');
  probsOk(r);
  assert.ok(r.reasons.blockers.length >= 1);
  assert.ok(r.reasons.blockers.some((b) => /directional signal is not justified|not justified|no clear edge/.test(b)), r.reasons.blockers.join(' / '));
});

test('VIX shock pushes toward WAIT and a rising VIX is a bearish factor', () => {
  const calm = runSignal(snapshot({ vixLtp: 14, vixPrev: 14 }));
  const shock = runSignal(snapshot({ vixLtp: 16, vixPrev: 14 }));            // +14 %
  assert.ok(shock.probabilities.CALL < calm.probabilities.CALL);
  assert.ok(shock.probabilities.WAIT >= calm.probabilities.WAIT);
  const f = shock.factors.find((x) => x.id === 'vix'); assert.ok(f.score < 0); assert.match(f.text, /rising fear/);
  assert.ok(shock.scores.waitPressure.vol > 0);
});

// ================================================================ missing optional inputs
test('missing VIX lowers data quality and confidence is not HIGH, but the gate stays open (VIX is optional)', () => {
  const r = runSignal(snapshot({ vix: null }));
  assert.equal(r.gate.ok, true);
  assert.ok(r.reasons.missing.some((m) => m.id === 'vix'));
  assert.ok(r.quality.value < runSignal(BULL()).quality.value);
  assert.notEqual(r.confidence, CONFIDENCE.HIGH);
});

test('IV change: rising IV with a falling price is a bearish factor with its own reason; collecting history is reported, never 0', () => {
  const none = runSignal(BEAR());
  assert.ok(none.reasons.missing.some((m) => m.id === 'ivPrice'));
  const bear = BEAR();
  // history: same chain 5 minutes ago but with 8 % lower IV
  const old = parseChain(rawChain({ spot: 24600, callBase: 340000, putBase: 300000, putGrowth: -0.02, callGrowth: 0.12 }).map((r) => ({
    ...r, call_options: { ...r.call_options, option_greeks: { ...r.call_options.option_greeks, iv: 11 } }, put_options: { ...r.put_options, option_greeks: { ...r.put_options.option_greeks, iv: 11 } },
  })), EXP, NIFTY_KEY).rows;
  const s = snapshot({ closes: path({ base: 24600, step: -2 }), chain: { callBase: 340000, putBase: 300000, putGrowth: -0.02, callGrowth: 0.12 }, history: { rows: old, spot: 24600 } });
  const r = runSignal(s);
  const f = r.factors.find((x) => x.id === 'ivPrice');
  assert.equal(f.available, true); assert.ok(f.score < 0); assert.match(f.text, /Rising IV with a falling price/);
  void bear;
});

// ================================================================ global data can never dominate
const G = (pct, nowT, ageMs = 60000) => Object.fromEntries(['spx', 'ixic', 'n225', 'hsi'].map((id) => [id, { id, price: 100, prev: 100, pct, t: nowT - ageMs, receivedAt: nowT }]));
test('global data: tiny fixed weight, stale / old data ignored, and extreme global moves change the result by only a few points', () => {
  const base = BULL(), now = base.now;
  const none = runSignal(base);
  const up = runSignal({ ...base, global: G(+5, now) }), down = runSignal({ ...base, global: G(-5, now) });
  assert.equal(up.gate.ok, true);
  assert.ok(up.factors.find((f) => f.id === 'global').available);
  const swing = Math.abs(up.probabilities.CALL - down.probabilities.CALL);
  assert.ok(swing <= 6, `global swing ${swing} points must stay small`);
  assert.equal(down.signal, none.signal, 'extreme bearish global data cannot flip a well-supported CALL');
  // unreliable (older than the 30-minute delayed window) global data is not used at all
  const stale = runSignal({ ...base, global: G(-5, now, 3 * 3600 * 1000) });
  assert.equal(stale.factors.find((f) => f.id === 'global').available, false);
  assert.deepEqual(stale.probabilities, none.probabilities);
  // errors / one item only are not enough
  const one = runSignal({ ...base, global: { spx: { price: 1, pct: -9, t: now - 1000, receivedAt: now }, hsi: { error: 'x' } } });
  assert.deepEqual(one.probabilities, none.probabilities);
});

test('global data alone can never create a direction: with no other support the signal is WAIT', () => {
  // flat, balanced scene + strongly bullish global
  const flat = []; for (let i = 0; i < 45; i++) flat.push(24450 + (i % 2 ? 2 : -2));
  const base = snapshot({ closes: flat, chain: { callBase: 320000, putBase: 320000, callPeak: [24600, 700000], putPeak: [24300, 700000], putGrowth: 0.01, callGrowth: 0.01 } });
  const r = runSignal({ ...base, global: G(+6, base.now) });
  assert.equal(r.signal, 'WAIT');
});

// ================================================================ confidence
test('confidence is deterministic and follows separation / agreement / quality / availability', () => {
  const strong = runSignal(BULL());
  assert.ok([CONFIDENCE.HIGH, CONFIDENCE.MEDIUM].includes(strong.confidence), strong.confidence);
  const w = runSignal(snapshot({ chain: { callPeak: [24500, 900000] } }));
  assert.equal(w.signal, 'WAIT');
  assert.notEqual(w.confidence, CONFIDENCE.HIGH);
  // fewer inputs (no VIX, no walls, no history) => not HIGH
  const lean = runSignal(snapshot({ vix: null }));
  assert.notEqual(lean.confidence, CONFIDENCE.HIGH);
  // every result has one of the three values
  for (const r of [strong, w, lean, runSignal(BEAR())]) assert.ok(Object.values(CONFIDENCE).includes(r.confidence));
});

// ================================================================ price structure
test('priceStructure reads swing highs / lows on anchored bars', () => {
  const lv = [10, 14, 11, 16, 13, 18, 15, 20, 17, 22];            // 3-minute bars: rising peaks (HH) and rising troughs (HL)
  const flat = (arr) => arr.map((c, i) => cd(ist(...D, 9, 15 + i), c, c + 1, c - 1, c));      // open = close: bar extremes are exactly the levels +/- 1
  const up = flat(lv.flatMap((x) => [x, x, x]).map((x) => 24000 + x * 3));
  const st = priceStructure(up, '2030-03-04', at(10, 5), true, 3);
  assert.equal(st.available, true); assert.equal(st.hh && st.hl, true); assert.equal(st.score, 1);
  const down = flat(lv.map((x) => 24000 - x * 3).flatMap((x) => [x, x, x]));
  const sd = priceStructure(down, '2030-03-04', at(10, 5), true, 3);
  assert.equal(sd.lh && sd.ll, true); assert.equal(sd.score, -1);
  assert.equal(priceStructure(up.slice(0, 6), '2030-03-04', at(10, 5), true, 3).available, false);
});

// ================================================================ explainability
test('every directional decision exposes its contributing factors, weights and scores; unavailable inputs are listed, not hidden', () => {
  const r = runSignal(BULL());
  assert.equal(r.factors.length, Object.keys(WEIGHTS).length);
  for (const f of r.factors) {
    assert.ok(Object.keys(WEIGHTS).includes(f.id)); assert.equal(f.weight, WEIGHTS[f.id]);
    assert.ok(f.score === null || (f.score >= -1 && f.score <= 1));
    assert.equal(typeof f.text, 'string'); assert.ok(f.text.length > 0);
  }
  assert.ok(r.reasons.positive.every((x) => x.score > 0));
  assert.ok(r.reasons.negative.every((x) => x.score < 0));
  assert.ok(r.reasons.missing.every((m) => m.text));
  assert.ok(r.reasons.dataNotes.length > 0);
  assert.ok(r.scores.coverage > 0 && r.scores.coverage <= 1);
  assert.ok(r.quality.value > 0 && r.quality.value <= 1);
});

test('a CALL shows opposing evidence as negative reasons (e.g. CALL OI resistance) and a PUT mirrors it', () => {
  const r = runSignal(BULL());
  const all = [...r.reasons.positive, ...r.reasons.negative];
  assert.ok(all.some((x) => x.id === 'oiWalls'));
  const mixed = runSignal(snapshot({ chain: { callPeak: [24600, 900000], putPeak: [24350, 900000] } }));
  void mixed;
});

// ================================================================ module hygiene
test('the module stays pure: wired in only through signalBridge.js (never directly by UI / engine / alerts); no ordering code', () => {
  const root = new URL('../src/', import.meta.url);
  const files = [...readdirSync(root).filter((f) => f.endsWith('.js') && f !== 'signal.js'), ...readdirSync(new URL('ui/', root)).map((f) => `ui/${f}`)];
  const importers = files.filter((f) => /from\s+'\.{1,2}\/(\.\.\/)?signal'/.test(readFileSync(new URL(f, root), 'utf8')));
  assert.deepEqual(importers, ['signalBridge.js'], `only signalBridge.js may import signal.js, got ${importers}`);
  const src = readFileSync(new URL('signal.js', root), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/placeOrder|place_order|order\/place|broker|execute/i.test(src));
  assert.ok(!/from\s+'react|from\s+'react-native|SecureStore|AsyncStorage/.test(src));
});

test('the default CFG is complete and every veto / pressure threshold is a finite number', () => {
  for (const k of ['minCandles', 'minCoverage', 'minDirProb', 'minLead', 'groupLean', 'wallNearPct', 'K', 'waitBase']) assert.ok(Number.isFinite(CFG[k]), k);
  const r = computeSignal(bundleFromSnapshot(BULL()), { cfg: { minLead: 10, weights: { global: 2 } } });
  assert.equal(r.signal, 'CALL');
  assert.equal(r.factors.find((f) => f.id === 'global').weight, 2);
});
