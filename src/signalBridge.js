// Signal bridge (Part 10B). Pure functions: app state -> signal engine (Part 10A) -> the fields the existing UI reads.
//
// ANALYSIS ONLY. Nothing here places, prepares or suggests an order, and nothing here talks to a broker.
//
// Safety net: the engine's result is re-validated here before the UI ever sees it. A directional signal is accepted only if
//   - the data-quality gate passed,
//   - CALL / PUT / WAIT are integers in 0..100 that sum to exactly 100,
//   - the signal is consistent with the probabilities (a directional signal is strictly the largest probability),
//   - no veto stands and the result carries at least one supporting reason.
// Anything else (including an exception inside the engine) becomes a WAIT with the problem named as the blocker, so a bug
// or a bad input can never turn into a CALL / PUT.
import { runSignal, SIGNAL, CONFIDENCE, MODEL_VERSION, PROBABILITY_NOTE } from './signal';
import { lotSizeFromPairs } from './liquidity';
import { evaluateGate } from './feed/gate';
import { isUsable } from './feed/freshness';

export { PROBABILITY_NOTE };

// Raw store state -> the snapshot runSignal() expects. `s` is store.get() AFTER the feed / candle / chain freshness was published.
// The chain is passed only if it belongs to the selected expiry; the engine re-checks this itself.
export function snapshotFromState(s) {
  const sameExpiry = !!s.expiry && s.chainExpiry === s.expiry;
  return {
    now: s.sNow, conn: s.feed ? s.feed.conn : undefined, market: s.market,
    nifty: s.nifty, niftyFresh: s.niftyFresh,
    candles: s.candles, candlesFresh: s.candlesFresh,
    chain: sameExpiry && s.chain ? { rows: s.chain, expiry: s.expiry, chainExpiry: s.chainExpiry, fresh: s.chainFresh, receivedAt: s.chainAt } : null,
    expiry: s.expiry, lotSize: lotSizeFromPairs(s.pairs),
    vix: s.vix, vixFresh: s.vixFresh, global: s.global, pcrIvHistory: s.pcrIvHistory,
  };
}

// Independent invariant check. Returns a list of problems (empty = the result may be shown as is).
export function validateSignalResult(r) {
  const bad = [];
  if (!r || typeof r !== 'object') return ['no result'];
  const p = r.probabilities;
  if (!p) return ['no probabilities'];
  for (const k of ['CALL', 'PUT', 'WAIT']) if (!Number.isInteger(p[k]) || p[k] < 0 || p[k] > 100) bad.push(`${k} probability ${p[k]} is not an integer in 0..100`);
  if (!bad.length && p.CALL + p.PUT + p.WAIT !== 100) bad.push(`probabilities sum to ${p.CALL + p.PUT + p.WAIT}, not 100`);
  if (!Object.values(SIGNAL).includes(r.signal)) bad.push(`unknown signal ${r.signal}`);
  if (!Object.values(CONFIDENCE).includes(r.confidence)) bad.push(`unknown confidence ${r.confidence}`);
  if (r.signal === SIGNAL.CALL || r.signal === SIGNAL.PUT) {
    if (!r.gatePassed || !r.gate || r.gate.ok !== true) bad.push('directional signal without a passed data-quality gate');
    if (r.vetoes && r.vetoes.length) bad.push('directional signal while a veto stands');
    const other = r.signal === SIGNAL.CALL ? SIGNAL.PUT : SIGNAL.CALL;
    if (p && !(p[r.signal] > p[other] && p[r.signal] > p.WAIT)) bad.push('directional signal is not the largest probability');
    if (!r.reasons || !Array.isArray(r.reasons.positive) || !r.reasons.positive.length) bad.push('directional signal without supporting reasons');
  }
  return bad;
}

// A WAIT that says why (used when the engine throws or its result fails validation).
export function failSafeSignal(why, prefix = 'Signal engine problem') {
  const text = `${prefix}: ${why}. WAIT.`;
  return {
    version: MODEL_VERSION, kind: 'ESTIMATED_MODEL_SCORES', disclaimer: PROBABILITY_NOTE,
    signal: SIGNAL.WAIT, probabilities: { CALL: 0, PUT: 0, WAIT: 100 }, callProbability: 0, putProbability: 0, waitProbability: 100,
    confidence: CONFIDENCE.LOW, gate: null, gatePassed: false, directionalScored: false,
    reasons: { perspective: 'BULLISH', positive: [], negative: [], neutral: [], missing: [], blockers: [text], lines: [`! ${text}`] },
    factors: [], vetoes: [], scores: null, quality: null, failSafe: true,
  };
}

// State -> validated result. Never throws.
export function evaluateSignal(s, options, engine = runSignal) {   // `engine` is injectable only so the safety net below can be tested
  let r;
  try { r = engine(snapshotFromState(s || {}), options); } catch (e) { return failSafeSignal(`engine error (${(e && e.message) || 'unknown'})`); }
  const bad = validateSignalResult(r);
  return bad.length ? failSafeSignal(bad.join('; ')) : r;
}

// Flat, UI-friendly view of a result. Every field is copied from the engine result, nothing is derived or invented.
export function toUiSignal(r) {
  const gate = r.gate || null;
  const failed = gate && Array.isArray(gate.failed) ? gate.failed : [];
  return {
    signal: r.signal,
    callProbability: r.probabilities.CALL, putProbability: r.probabilities.PUT, waitProbability: r.probabilities.WAIT,
    confidence: r.confidence,
    positive: r.reasons.positive || [], negative: r.reasons.negative || [], blockers: r.reasons.blockers || [], missing: r.reasons.missing || [],
    reasonLines: r.reasons.lines || [],
    gateOk: !!r.gatePassed, gateFailed: failed, gateChecks: gate && gate.checks ? gate.checks : null,
    factors: r.factors || [], directionalScored: !!r.directionalScored,
    disclaimer: PROBABILITY_NOTE, failSafe: !!r.failSafe, version: r.version,
  };
}

// Put the engine's decision into the analysis object the existing cards / alerts read. The legacy engine's own CALL / PUT / WAIT is
// OVERRIDDEN: the visible signal, the alert trigger and the "recommended contract" all follow the new engine. A legacy contract
// recommendation is kept only when it is for the same side as the new signal; otherwise it is dropped (no contradictory card).
export function mergeSignalIntoAnalysis(a, r) {
  const ui = toUiSignal(r);
  const dir = r.signal !== SIGNAL.WAIT;
  const rec = dir && a.recommended && a.recommended.side === r.signal ? a.recommended : null;
  const waitReason = dir ? '' : (ui.blockers[0] || 'No directional signal is justified.');
  return {
    ...a,
    signal: r.signal, confidence: r.confidence, probabilities: r.probabilities, ui, engine: r,
    recommended: rec, waitReason,
    notes: dir && !rec ? ['Signal engine gives a direction, but no contract passed the liquidity / spread / delta filters near ATM. Do not force a trade.'] : [],
  };
}

// Between two engine cycles (every ~5 s) the feed can drop or go stale. This cheap guard re-applies the SAME Part 2 gate plus the chain
// freshness to the live store state, so a CALL / PUT that was valid at the last cycle is withdrawn the moment its data is no longer
// current, instead of staying on screen until the next cycle. Returns the reasons (empty = nothing to withdraw).
export function staleReasons(s) {
  if (!s) return ['no state'];
  const g = evaluateGate({ conn: s.feed ? s.feed.conn : undefined, market: s.market, nifty: s.nifty, niftyFresh: s.niftyFresh, serverNow: s.sNow, candles: s.candlesInfo, candlesFresh: s.candlesFresh, requireCandles: true });
  const out = g.ok ? [] : [...g.reasons];
  if (!isUsable(s.chainFresh)) out.push(`option chain is ${s.chainFresh ? s.chainFresh.status : 'UNAVAILABLE'}`);
  return out;
}

// Returns the analysis to store: unchanged when its direction is still backed by current data, else the same analysis as a WAIT.
export function withdrawIfStale(a, s) {
  if (!a || a.signal === SIGNAL.WAIT) return a;
  const why = staleReasons(s);
  return why.length ? mergeSignalIntoAnalysis(a, failSafeSignal(why.join('; '), 'Data no longer current')) : a;
}
