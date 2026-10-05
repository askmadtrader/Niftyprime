// Probability-based CALL / PUT / WAIT signal engine (Part 10A). Pure functions: no network, no clock reads, no randomness, no UI.
//
// ANALYSIS ONLY. This module never places, prepares or suggests an order. It is NOT imported by the dashboard, controller or
// engine.js; Part 10B wires it in only through src/signalBridge.js (no UI file imports this module directly).
//
// The three numbers it returns are INTERNAL MODEL SCORES / ESTIMATED PROBABILITIES. They are not statistically guaranteed
// market probabilities and must never be presented as such (see DISCLAIMER).
//
// Pipeline (computeSignal):
//   1. DATA-QUALITY GATE  11 critical checks. If ANY fails -> WAIT 100 %, CALL 0, PUT 0. Nothing directional is scored.
//   2. FACTORS            each factor is a score in [-1, +1] (+ bullish / - bearish) with a fixed weight and a plain-language reason.
//   3. SCORES             callN = sum(w * max(s,0)) / nominal weight, putN likewise. A missing factor lowers the score (its weight
//                         stays in the denominator), it is never replaced by a guess.
//   4. WAIT PRESSURE      conflict, thin coverage, low data quality, chop, volatility shock, theta decay, thin liquidity.
//   5. PROBABILITIES      softmax(K*callN, K*putN, K*waitScore) -> integers 0..100 that sum to exactly 100 (largest remainder).
//   6. VETOES             conditions that make a directional call unjustified (no agreement, thin coverage, wall in the way,
//                         illiquid chosen contract, global-dependent edge ...). A veto forces WAIT to be the largest probability.
//   7. CONFIDENCE         HIGH / MEDIUM / LOW from separation, agreement, data quality and input availability (never overrides the gate).
//
// Same inputs -> same output, always.
import { clamp } from './util';
import { MS } from './feed/marketStatus';
import { isUsable, computeGlobalFreshness, FRESH } from './feed/freshness';
import { describeSeries, selectCandles } from './feed/session';
import { evaluateGate, GATE } from './feed/gate';
import { analyzeNifty, sessionMs, OPEN_MIN, aggregateAnchored } from './analytics';
import { analyzeOi, fmtDelta, fmtInt } from './oi';
import { analyzePcrIv, HIST } from './pcriv';
import { analyzeLiquidity, LIQ } from './liquidity';
import { normExpiry, isExpired } from './contracts';
import { validSpot } from './chain';

export const MODEL_VERSION = 'signal-v1 (Part 10A)';
export const SIGNAL = { CALL: 'CALL', PUT: 'PUT', WAIT: 'WAIT' };
export const CONFIDENCE = { HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW' };
// The percentages are internal model scores, never a promise of accuracy. PROBABILITY_NOTE is the exact wording the UI must show next to them.
export const PROBABILITY_NOTE = 'Internal model score / estimated probability; not a statistical guarantee.';
export const DISCLAIMER = `${PROBABILITY_NOTE} Not trading advice. Analysis only: no orders are placed.`;

// Gate check ids (all 11 are always evaluated and reported, so the UI can show every one).
export const GATE_ID = {
  MARKET: 'MARKET_STATUS', NIFTY: 'NIFTY_FRESHNESS', CHAIN: 'OPTION_CHAIN_FRESHNESS', OPTION_DATA: 'REQUIRED_OPTION_DATA',
  CANDLES: 'CURRENT_SESSION_CANDLES', HISTORY: 'MINIMUM_HISTORY', EXPIRY: 'EXPIRY_VALIDITY', FEED: 'FEED_CONNECTION',
  LIQUIDITY: 'LIQUIDITY_DATA', SPREAD: 'BID_ASK_SPREAD', CONSISTENCY: 'DATA_CONSISTENCY',
};
const GATE_LABEL = {
  MARKET_STATUS: 'Market status', NIFTY_FRESHNESS: 'NIFTY freshness', OPTION_CHAIN_FRESHNESS: 'Option-chain freshness',
  REQUIRED_OPTION_DATA: 'Required option data', CURRENT_SESSION_CANDLES: 'Current-session candles', MINIMUM_HISTORY: 'Minimum historical data',
  EXPIRY_VALIDITY: 'Selected expiry', FEED_CONNECTION: 'WebSocket / feed connection', LIQUIDITY_DATA: 'Liquidity data',
  BID_ASK_SPREAD: 'Bid/ask spread', DATA_CONSISTENCY: 'Data consistency',
};
const GATE_ORDER = [GATE_ID.MARKET, GATE_ID.FEED, GATE_ID.NIFTY, GATE_ID.CANDLES, GATE_ID.HISTORY, GATE_ID.CHAIN, GATE_ID.EXPIRY, GATE_ID.OPTION_DATA, GATE_ID.LIQUIDITY, GATE_ID.SPREAD, GATE_ID.CONSISTENCY];
const CODE_TO_CHECK = {
  [GATE.MARKET_CLOSED]: GATE_ID.MARKET, [GATE.PRE_OPEN]: GATE_ID.MARKET, [GATE.CLOSING_AUCTION]: GATE_ID.MARKET, [GATE.MARKET_UNKNOWN]: GATE_ID.MARKET, [GATE.FNO_NOT_OPEN]: GATE_ID.MARKET,
  [GATE.NIFTY_MISSING]: GATE_ID.NIFTY, [GATE.TS_INVALID]: GATE_ID.NIFTY, [GATE.NIFTY_STALE]: GATE_ID.NIFTY, [GATE.NIFTY_NOT_CURRENT]: GATE_ID.NIFTY,
  [GATE.FEED_DOWN]: GATE_ID.FEED, [GATE.FEED_RECONNECTING]: GATE_ID.FEED, [GATE.FEED_NOT_READY]: GATE_ID.FEED,
  [GATE.SESSION_UNAVAILABLE]: GATE_ID.CANDLES, [GATE.CANDLES_STALE]: GATE_ID.CANDLES,
};

// ---------------------------------------------------------------------------------------------------------
// Tunable model parameters. These are model DEFINITIONS (thresholds / weights), not market facts. All can be overridden through
// options.cfg (shallow merge; `weights` merges per key). They are the only "knobs": nothing else changes the result.
// ---------------------------------------------------------------------------------------------------------
export const WEIGHTS = {
  // price (NIFTY) group
  vwap: 12, openingRange: 12, momentum: 10, trend: 8, structure: 10,
  // options group
  oiWalls: 12, oiFlow: 12, pcrNear: 8, pcrTotal: 4, ivPrice: 6,
  // volatility + global
  vix: 6, global: 3,
};
export const GROUPS = { PRICE: 'PRICE', OPTIONS: 'OPTIONS', VOLATILITY: 'VOLATILITY', GLOBAL: 'GLOBAL' };
const GROUP_OF = {
  vwap: GROUPS.PRICE, openingRange: GROUPS.PRICE, momentum: GROUPS.PRICE, trend: GROUPS.PRICE, structure: GROUPS.PRICE,
  oiWalls: GROUPS.OPTIONS, oiFlow: GROUPS.OPTIONS, pcrNear: GROUPS.OPTIONS, pcrTotal: GROUPS.OPTIONS, ivPrice: GROUPS.OPTIONS,
  vix: GROUPS.VOLATILITY, global: GROUPS.GLOBAL,
};
export const CFG = {
  weights: WEIGHTS,
  // ---- gate
  minCandles: 30,                 // completed current-session 1-minute candles needed before any directional score
  maxCandleGapShare: 0.2,         // more than 20 % of the session's minutes missing => low-quality candle series
  priceCandleTolPct: 0.5,         // live tick vs last candle close further apart than this % => contradictory data
  chainSpotTolPct: 0.5,           // chain's own underlying price vs live NIFTY further apart than this % => contradictory data
  // ---- scoring scales
  vwapFullPct: 0.20,              // |price - VWAP| of 0.20 % = full score
  vwapProxyFactor: 0.85,          // a session-average proxy (NIFTY has no volume) is a weaker reference than a true VWAP
  trendFullPct: 0.08,             // EMA9 vs EMA21 gap of 0.08 % = full score
  structureTf: 3,                 // price-structure swings are read on 3-minute bars anchored at 09:15
  pcrFull: 0.35, pcrTotalFull: 0.4, pcrTrendAdj: 0.25,
  oiFlowFullActivity: 0.03,       // dOI activity (|put dOI|+|call dOI|) / window OI: 3 % or more = full conviction
  oiFlowMinActivityScale: 0.3, oiFlowMinStrikes: 3,
  wallNearPct: 0.12,              // a wall closer than 0.12 % of spot (~29 pts at 24,500) leaves no room
  wallFarPct: 0.30,
  vixFullPct: 5, vixShockPct: 8, vixHigh: 25,
  globalFullPct: 1.0, globalMinItems: 2, globalIds: ['spx', 'ixic', 'dji', 'n225', 'hsi', 'kospi'],
  thetaMaxPct: 12,                // ATM theta as % of premium per day: at/above this the decay cost is a full WAIT push
  // ---- probabilities
  K: 5, waitBase: 0.12,
  waitW: { chop: 0.20, vol: 0.20, decay: 0.10, liq: 0.15, coverage: 0.35, quality: 0.30 },
  chopRangePct: 0.15,
  // ---- decision
  minCoverage: 0.6, minDirProb: 40, minLead: 15, groupLean: 0.10, leanEps: 0.05, vetoWaitMultiple: 1.25,
  // ---- confidence ladder
  conf: { high: { lead: 35, agree: 0.8, quality: 0.85, coverage: 0.85 }, medium: { lead: 20, agree: 0.6, quality: 0.65, coverage: 0.7 } },
};
const mergeCfg = (o) => ({ ...CFG, ...(o || {}), weights: { ...WEIGHTS, ...((o && o.weights) || {}) }, waitW: { ...CFG.waitW, ...((o && o.waitW) || {}) }, conf: { ...CFG.conf, ...((o && o.conf) || {}) } });

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const pos = (x) => fin(x) && x > 0;
const lin = (x, full) => clamp(x / full, -1, 1);
const sgn = (x, eps = 0) => (x > eps ? 1 : x < -eps ? -1 : 0);
const f2 = (x, d = 2) => (fin(x) ? x.toFixed(d) : '--');
const sf = (x, d = 2) => (fin(x) ? (x > 0 ? '+' : '') + x.toFixed(d) : '--');
const round6 = (x) => Math.round(x * 1e6) / 1e6;

// ---------------------------------------------------------------------------------------------------------
// 1. DATA-QUALITY GATE
// ---------------------------------------------------------------------------------------------------------
// Everything is evaluated (no short-circuit) so the caller can show every failed condition. ok = every check passed.
export function evaluateSignalGate(inp = {}, options = {}) {
  const cfg = mergeCfg(options.cfg);
  const now = inp.now;
  const checks = Object.fromEntries(GATE_ORDER.map((id) => [id, { id, label: GATE_LABEL[id], ok: true, details: [] }]));
  const fail = (id, text) => { checks[id].ok = false; checks[id].details.push(text); };

  // --- 1, 2, 5, 8: reuse the Part 2 gate (same rules the dashboard shows). VIX is optional there, so it is not passed.
  const nowOk = fin(now) && now > 0;
  if (!nowOk) fail(GATE_ID.FEED, 'exchange-aligned clock unavailable');
  const g = evaluateGate({
    conn: inp.conn, market: inp.market, nifty: inp.quote, niftyFresh: inp.quoteFresh, serverNow: nowOk ? now : 0,
    candles: inp.candleInfo, candlesFresh: inp.candlesFresh, requireCandles: true,
  });
  g.codes.forEach((code, i) => fail(CODE_TO_CHECK[code] || GATE_ID.CONSISTENCY, g.reasons[i]));

  const nifty = inp.nifty || null;
  const chain = inp.chain || null;
  const oi = inp.oi || null, pc = inp.pcriv || null, lq = inp.liquidity || null;

  // --- 3: option-chain freshness (live market: LIVE / FRESH only; a snapshot or stale chain is never current)
  if (!chain || !Array.isArray(chain.rows) || !chain.rows.length) fail(GATE_ID.CHAIN, 'option chain not received');
  else if (!isUsable(chain.fresh)) fail(GATE_ID.CHAIN, `option chain is ${chain.fresh ? chain.fresh.status : 'UNAVAILABLE'}${chain.fresh && chain.fresh.reason ? ` (${chain.fresh.reason})` : ''}`);
  else if (chain.fresh.reason === 'SNAPSHOT_MARKET_NOT_OPEN') fail(GATE_ID.CHAIN, 'option chain is a market-closed snapshot');

  // --- 7: selected expiry
  const exp = normExpiry(inp.expiry);
  if (!exp) fail(GATE_ID.EXPIRY, 'no valid expiry selected');
  else {
    if (nowOk && isExpired(exp, now)) fail(GATE_ID.EXPIRY, `selected expiry ${exp} has expired`);
    if (chain && chain.chainExpiry !== exp) fail(GATE_ID.EXPIRY, 'option chain on hand is not for the selected expiry');
    if (chain && Array.isArray(chain.rows) && chain.rows.some((r) => !r || r.expiry !== exp)) fail(GATE_ID.EXPIRY, 'option chain contains rows of another expiry');
  }

  // --- 4: required option data
  const atm = atmRow(lq);
  if (!oi || !oi.ok) fail(GATE_ID.OPTION_DATA, `open-interest analysis unavailable${oi && oi.text ? `: ${oi.text}` : ''}`);
  else if (!(oi.totals.callOi > 0) || !(oi.totals.putOi > 0)) fail(GATE_ID.OPTION_DATA, 'CALL or PUT open interest is zero / missing');
  if (!pc || !pc.ok) fail(GATE_ID.OPTION_DATA, `PCR / IV analysis unavailable${pc && pc.text ? `: ${pc.text}` : ''}`);
  else {
    if (pc.pcr.near.value === null) fail(GATE_ID.OPTION_DATA, 'near-ATM PCR unavailable');
    if (pc.pcr.total.value === null) fail(GATE_ID.OPTION_DATA, 'total PCR unavailable');
    if (pc.iv.atmStrike === null) fail(GATE_ID.OPTION_DATA, 'ATM strike unavailable');
    else {
      if (pc.greeks.call.delta === null || pc.greeks.put.delta === null) fail(GATE_ID.OPTION_DATA, 'ATM delta (Greeks) missing');
    }
  }
  if (atm) {
    if (atm.call.metrics.ltp === null) fail(GATE_ID.OPTION_DATA, 'ATM CALL has no price');
    if (atm.put.metrics.ltp === null) fail(GATE_ID.OPTION_DATA, 'ATM PUT has no price');
  }

  // --- 6: minimum historical data (completed current-session candles + at least one usable momentum timeframe)
  const cs = nifty && nifty.session && Array.isArray(nifty.session.candles) ? nifty.session.candles : [];
  const completed = nowOk ? cs.filter((c) => c.t + 60000 <= now).length : 0;
  if (completed < cfg.minCandles) fail(GATE_ID.HISTORY, `only ${completed} completed current-session candles (need ${cfg.minCandles})`);
  if (nifty && nifty.momentum && nifty.momentum.available < 1) fail(GATE_ID.HISTORY, 'no momentum timeframe has enough completed bars');
  if (nifty && nifty.vwap && nifty.vwap.value === null) fail(GATE_ID.HISTORY, 'VWAP / session average unavailable');

  // --- 9, 10: liquidity + bid/ask spread of the two ATM contracts
  if (!lq || !lq.ok) {
    fail(GATE_ID.LIQUIDITY, `liquidity analysis unavailable${lq && lq.text ? `: ${lq.text}` : ''}`);
    fail(GATE_ID.SPREAD, 'bid/ask spread unavailable (no liquidity analysis)');
  } else if (!atm) {
    fail(GATE_ID.LIQUIDITY, 'ATM contracts not found in the liquidity analysis');
    fail(GATE_ID.SPREAD, 'ATM bid/ask not available');
  } else {
    for (const [name, leg] of [['CALL', atm.call], ['PUT', atm.put]]) {
      const m = leg.metrics;
      if (m.oi === null || m.volume === null || m.depthQty === null) fail(GATE_ID.LIQUIDITY, `ATM ${name}: ${[m.oi === null && 'OI', m.volume === null && 'volume', m.depthQty === null && 'depth'].filter(Boolean).join(', ')} missing`);
      if (m.crossed) fail(GATE_ID.SPREAD, `ATM ${name}: crossed bid/ask`);
      else if (m.spreadPct === null) fail(GATE_ID.SPREAD, `ATM ${name}: bid/ask missing`);
    }
    if (atm.call.tiers.spread === LIQ.POOR && atm.put.tiers.spread === LIQ.POOR) fail(GATE_ID.SPREAD, `spreads too wide on both ATM contracts (CALL ${f2(atm.call.metrics.spreadPct)}%, PUT ${f2(atm.put.metrics.spreadPct)}%)`);
  }

  // --- 11: contradictory / low-quality data
  if (!nifty || !nifty.ok) fail(GATE_ID.CONSISTENCY, 'NIFTY analysis unavailable');
  else {
    const p = nifty.price && nifty.price.value;
    if (!pos(p)) fail(GATE_ID.CONSISTENCY, 'no valid current NIFTY price');
    const last = cs.length ? cs[cs.length - 1].c : null;
    if (pos(p) && pos(last) && (Math.abs(p - last) / p) * 100 > cfg.priceCandleTolPct) fail(GATE_ID.CONSISTENCY, `live price ${f2(p)} and last candle close ${f2(last)} disagree by more than ${cfg.priceCandleTolPct}%`);
    const cst = nifty.ohlc && nifty.ohlc.candles;
    if (cst && cst.count + cst.missing > 0 && cst.missing / (cst.count + cst.missing) > cfg.maxCandleGapShare) fail(GATE_ID.CONSISTENCY, `${cst.missing} of ${cst.count + cst.missing} session minutes have no candle`);
  }
  if (chain && Array.isArray(chain.rows) && nifty && nifty.price && pos(nifty.price.value)) {
    const spots = chain.rows.map((r) => r && r.spot).filter(pos).sort((a, b) => a - b);
    if (spots.length) {
      const med = spots[Math.floor(spots.length / 2)];
      if ((Math.abs(med - nifty.price.value) / nifty.price.value) * 100 > cfg.chainSpotTolPct) fail(GATE_ID.CONSISTENCY, `option chain underlying ${f2(med)} and live NIFTY ${f2(nifty.price.value)} disagree by more than ${cfg.chainSpotTolPct}%`);
    }
  }

  const list = GATE_ORDER.map((id) => checks[id]);
  const failed = list.filter((c) => !c.ok);
  return {
    ok: failed.length === 0, checks: list, failed: failed.map((c) => ({ id: c.id, label: c.label, details: c.details })),
    reasons: failed.map((c) => `${c.label}: ${c.details.join('; ')}`),
  };
}

function atmRow(lq) {
  if (!lq || !lq.ok || !Array.isArray(lq.rows)) return null;
  return lq.rows.find((r) => r.atm) || null;
}

// ---------------------------------------------------------------------------------------------------------
// 2. FACTORS. Each returns { id, group, weight, score (-1..+1 | null), available, bias, text }.
// ---------------------------------------------------------------------------------------------------------
const EPS = 1e-9;
function mk(id, cfg, score, text, extra) {
  const ok = fin(score);
  const s = ok ? clamp(score, -1, 1) : null;
  return { id, group: GROUP_OF[id], weight: cfg.weights[id], score: s === null ? null : round6(s), available: ok, bias: !ok ? null : s > EPS ? 'BULLISH' : s < -EPS ? 'BEARISH' : 'NEUTRAL', text, ...(extra || null) };
}

function emaOf(vals, n) {
  if (vals.length < n) return null;
  const k = 2 / (n + 1);
  let e = vals.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < vals.length; i++) e = vals[i] * k + e * (1 - k);
  return e;
}

// Swing structure on `tf`-minute bars: last two swing highs and lows (a swing = bar extreme above/below both neighbours).
export function priceStructure(cs, date, now, live, tf) {
  const anchor = sessionMs(date, OPEN_MIN);
  const done = (cs || []).filter((c) => !live || (fin(now) && c.t + 60000 <= now));
  const bars = aggregateAnchored(done, tf, anchor);
  const hi = [], lo = [];
  for (let i = 1; i < bars.length - 1; i++) {
    if (bars[i].h > bars[i - 1].h && bars[i].h >= bars[i + 1].h) hi.push(bars[i].h);
    if (bars[i].l < bars[i - 1].l && bars[i].l <= bars[i + 1].l) lo.push(bars[i].l);
  }
  if (hi.length < 2 || lo.length < 2) return { available: false, bars: bars.length, highs: hi.length, lows: lo.length };
  const h = sgn(hi[hi.length - 1] - hi[hi.length - 2]), l = sgn(lo[lo.length - 1] - lo[lo.length - 2]);
  return { available: true, bars: bars.length, hh: h > 0, lh: h < 0, hl: l > 0, ll: l < 0, score: (h + l) / 2 };
}

function priceFactors(nifty, now, cfg) {
  const out = [];
  const A = nifty && nifty.ok ? nifty : null;
  const na = (id, why) => mk(id, cfg, null, why);

  // VWAP (or its honest proxy)
  if (A && A.vwap && A.vwap.position && fin(A.vwap.distPct)) {
    const label = A.vwap.method === 'VOLUME' ? 'VWAP' : 'session average (VWAP proxy)';
    const sc = A.vwap.position === 'AT' ? 0 : lin(A.vwap.distPct, cfg.vwapFullPct) * (A.vwap.method === 'VOLUME' ? 1 : cfg.vwapProxyFactor);
    out.push(mk('vwap', cfg, sc, A.vwap.position === 'AT' ? `NIFTY at ${label}` : `NIFTY ${A.vwap.position === 'ABOVE' ? 'above' : 'below'} ${label} (${sf(A.vwap.distPct)}%)`));
  } else out.push(na('vwap', 'VWAP unavailable'));

  // Opening range
  const or = A && A.openingRange;
  if (or && or.status === 'COMPLETE' && or.state) {
    const wide = pos(or.width) && fin(or.distance) && or.distance >= 0.25 * or.width;
    const sc = or.state === 'BREAKOUT' ? (wide ? 1 : 0.8) : or.state === 'BREAKDOWN' ? (wide ? -1 : -0.8) : 0;
    out.push(mk('openingRange', cfg, sc, or.state === 'BREAKOUT' ? `Opening-range breakout (+${f2(or.distance, 1)} pts above ${f2(or.high)})`
      : or.state === 'BREAKDOWN' ? `Opening-range breakdown (${f2(or.distance, 1)} pts below ${f2(or.low)})` : 'NIFTY inside the opening range (no breakout)'));
  } else out.push(na('openingRange', `opening range not usable${or && or.reason ? ` (${or.reason})` : ''}`));

  // Momentum (1m / 5m / 15m / 30m alignment, discounted when the latest bar fades)
  const mo = A && A.momentum;
  if (mo && mo.available > 0) {
    const base = { ALIGNED_UP: 1, LEANING_UP: 0.5, MIXED: 0, FLAT: 0, ALIGNED_DOWN: -1, LEANING_DOWN: -0.5 }[mo.alignment];
    if (base === undefined) out.push(na('momentum', 'momentum unavailable'));
    else {
      const dir = sgn(base), av = mo.frames.filter((f) => f.available);
      const aligned = av.filter((f) => (dir > 0 && f.state === 'POSITIVE') || (dir < 0 && f.state === 'NEGATIVE'));
      const fadeShare = aligned.length ? aligned.filter((f) => f.fading).length / aligned.length : 0;
      const sc = base * (1 - 0.3 * fadeShare);
      const tfs = aligned.map((f) => f.label).join(', ');
      out.push(mk('momentum', cfg, sc, dir > 0 ? `Bullish momentum (${mo.alignment.replace('_', ' ').toLowerCase()}: ${tfs}${fadeShare > 0 ? '; latest bar fading' : ''})`
        : dir < 0 ? `Bearish momentum (${mo.alignment.replace('_', ' ').toLowerCase()}: ${tfs}${fadeShare > 0 ? '; latest bar fading' : ''})`
        : mo.alignment === 'MIXED' ? 'Momentum mixed across timeframes' : 'Momentum flat'));
    }
  } else out.push(na('momentum', 'momentum unavailable'));

  // Trend: EMA9 vs EMA21 of completed 1-minute closes
  const cs = A && A.session && A.session.candles ? A.session.candles.filter((c) => !fin(now) || c.t + 60000 <= now) : [];
  const e9 = emaOf(cs.map((c) => c.c), 9), e21 = emaOf(cs.map((c) => c.c), 21);
  if (e9 !== null && e21 !== null && pos(e21)) {
    const gap = ((e9 - e21) / e21) * 100;
    out.push(mk('trend', cfg, lin(gap, cfg.trendFullPct), gap > 0.005 ? `Uptrend: EMA9 above EMA21 (${sf(gap, 3)}%)` : gap < -0.005 ? `Downtrend: EMA9 below EMA21 (${sf(gap, 3)}%)` : 'No trend: EMA9 ~ EMA21'));
  } else out.push(na('trend', 'needs 21 completed 1-minute candles'));

  // Structure
  const st = A ? priceStructure(A.session.candles, A.session.date, now, A.session.live, cfg.structureTf) : { available: false };
  if (st.available) {
    out.push(mk('structure', cfg, st.score, st.hh && st.hl ? 'Bullish structure (higher high + higher low)' : st.lh && st.ll ? 'Bearish structure (lower high + lower low)'
      : st.hh || st.hl ? 'Structure leans bullish (partial: higher high or higher low)' : st.lh || st.ll ? 'Structure leans bearish (partial: lower high or lower low)' : 'Structure flat'));
  } else out.push(na('structure', 'not enough swing points yet'));
  return out;
}

function optionFactors(nifty, oi, pc, cfg) {
  const out = [];
  const na = (id, why) => mk(id, cfg, null, why);
  const spot = nifty && nifty.price && nifty.price.value;

  // OI walls: PUT wall = support, CALL wall = resistance. Room to run is the distance to the opposing wall.
  if (oi && oi.ok && oi.wallsAvailable && pos(spot)) {
    const R = oi.resistance, S = oi.support;
    if (R && S) {
      const dR = R.distance, dS = S.distance, tot = dR + dS;
      const sc = tot > 0 ? (dR - dS) / tot : 0;
      const near = (dR / spot) * 100 <= cfg.wallNearPct ? ' (CALL wall is right on top: no room)' : (dS / spot) * 100 <= cfg.wallNearPct ? ' (PUT wall is right underneath)' : '';
      out.push(mk('oiWalls', cfg, sc, sc > 0 ? `PUT OI support at ${S.strike} (${f2(dS, 0)} pts away, OI ${fmtInt(S.oi)}) closer than CALL OI resistance at ${R.strike} (${f2(dR, 0)} pts)${near}`
        : sc < 0 ? `CALL OI resistance at ${R.strike} (${f2(dR, 0)} pts away, OI ${fmtInt(R.oi)}) closer than PUT OI support at ${S.strike} (${f2(dS, 0)} pts)${near}` : `CALL OI resistance ${R.strike} and PUT OI support ${S.strike} equally far`));
    } else if (R || S) {
      const w = R || S, p = (w.distance / spot) * 100;
      const room = clamp((p - cfg.wallNearPct) / (cfg.wallFarPct - cfg.wallNearPct) * 2 - 1, -1, 1) * 0.5;    // near wall = -0.5 .. far wall = +0.5 (room)
      const sc = R ? room : -room;
      out.push(mk('oiWalls', cfg, sc, R ? `Only a CALL OI resistance wall at ${R.strike} (${f2(R.distance, 0)} pts away); no PUT support wall` : `Only a PUT OI support wall at ${S.strike} (${f2(S.distance, 0)} pts away); no CALL resistance wall`));
    } else out.push(mk('oiWalls', cfg, 0, 'No significant OI wall on either side'));
  } else out.push(na('oiWalls', 'OI walls unavailable'));

  // OI flow: day change of OI (dOI) near ATM. PUT OI building / CALL OI unwinding = bullish; CALL OI building / PUT OI unwinding = bearish.
  const near = pc && pc.ok ? pc.pcr.near : null;
  if (oi && oi.ok && near && near.from !== null) {
    const win = oi.rows.filter((r) => r.strike >= near.from && r.strike <= near.to);
    const cD = win.filter((r) => r.call.delta !== null), pD = win.filter((r) => r.put.delta !== null);
    if (cD.length >= cfg.oiFlowMinStrikes && pD.length >= cfg.oiFlowMinStrikes) {
      const cSum = cD.reduce((s, r) => s + r.call.delta, 0), pSum = pD.reduce((s, r) => s + r.put.delta, 0);
      const winOi = win.reduce((s, r) => s + (r.call.oi || 0) + (r.put.oi || 0), 0);
      const act = Math.abs(cSum) + Math.abs(pSum);
      if (act === 0 || !(winOi > 0)) out.push(mk('oiFlow', cfg, 0, 'No OI change near ATM'));
      else {
        const net = (pSum - cSum) / act, scale = clamp((act / winOi) / cfg.oiFlowFullActivity, cfg.oiFlowMinActivityScale, 1);
        const d = `PUT \u0394OI ${fmtDelta(pSum)}, CALL \u0394OI ${fmtDelta(cSum)} (ATM \u00b15)`;
        out.push(mk('oiFlow', cfg, net * scale, net > 0.05 ? `${pSum > 0 ? 'Positive PUT \u0394OI (put writing)' : 'CALL OI unwinding'}: ${d}` : net < -0.05 ? `${cSum > 0 ? 'Positive CALL \u0394OI (call writing)' : 'PUT OI unwinding'}: ${d}` : `OI change balanced: ${d}`));
      }
    } else out.push(na('oiFlow', 'not enough strikes with previous-day OI near ATM'));
  } else out.push(na('oiFlow', 'OI change unavailable'));

  // PCR near ATM (+ its 5-minute trend when history exists) and total PCR
  if (near && near.value !== null) {
    const ch = pc.pcr.nearChange;
    const adj = ch && ch.status === HIST.READY ? (ch.trend === 'RISING' ? cfg.pcrTrendAdj : ch.trend === 'FALLING' ? -cfg.pcrTrendAdj : 0) : 0;
    const sc = lin(near.value - 1, cfg.pcrFull) * 0.75 + adj;
    out.push(mk('pcrNear', cfg, sc, `${sc > 0.05 ? 'Bullish' : sc < -0.05 ? 'Bearish' : 'Neutral'} near-ATM PCR ${f2(near.value)}${adj ? ` and ${ch.trend.toLowerCase()}` : ''}`));
  } else out.push(na('pcrNear', 'near-ATM PCR unavailable'));
  const tot = pc && pc.ok ? pc.pcr.total : null;
  if (tot && tot.value !== null) {
    const sc = lin(tot.value - 1, cfg.pcrTotalFull);
    out.push(mk('pcrTotal', cfg, sc, `${sc > 0.05 ? 'Bullish' : sc < -0.05 ? 'Bearish' : 'Neutral'} total PCR ${f2(tot.value)}`));
  } else out.push(na('pcrTotal', 'total PCR unavailable'));

  // IV change against the price move. Fear (IV up while price falls) is bearish; an orderly rally (IV up/down while price rises) mildly bullish.
  const m = nifty && nifty.momentum, f5 = m && m.frames ? (m.frames.find((f) => f.tf === 5 && f.available) || m.frames.find((f) => f.tf === 15 && f.available)) : null;
  const dir = f5 && f5.state !== 'FLAT' ? (f5.state === 'POSITIVE' ? 1 : -1) : (nifty && nifty.vwap && nifty.vwap.position && nifty.vwap.position !== 'AT' ? (nifty.vwap.position === 'ABOVE' ? 1 : -1) : 0);
  const ivc = pc && pc.ok ? pc.iv.change : null;
  if (ivc && ivc.status === HIST.READY && ivc.state) {
    const exp = ivc.state === 'EXPANDING', con = ivc.state === 'CONTRACTING';
    let sc = 0, t;
    if (dir < 0 && exp) { sc = -1; t = 'Rising IV with a falling price (fear: adverse for CALL buyers)'; }
    else if (dir > 0 && exp) { sc = 0.4; t = 'Rising IV with a rising price (participation confirms the move)'; }
    else if (dir > 0 && con) { sc = 0.2; t = 'Falling IV with a rising price (orderly rally)'; }
    else if (dir < 0 && con) { sc = -0.2; t = 'Falling IV with a falling price (orderly decline)'; }
    else t = `IV ${ivc.state.toLowerCase()}, price direction ${dir === 0 ? 'flat' : dir > 0 ? 'up' : 'down'}: no read`;
    out.push(mk('ivPrice', cfg, sc, t));
  } else out.push(na('ivPrice', 'IV change collecting history'));
  return out;
}

function volFactor(vix, cfg) {
  // vix = { quote, fresh }: only a LIVE / FRESH VIX of the current session counts.
  if (vix && vix.quote && isUsable(vix.fresh) && fin(vix.quote.pct)) {
    const p = vix.quote.pct, sc = -lin(p, cfg.vixFullPct);
    return mk('vix', cfg, sc, `India VIX ${f2(vix.quote.ltp)} (${sf(p)}% today): ${p > 0.2 ? 'rising fear' : p < -0.2 ? 'easing fear' : 'steady'}`, { vixPct: p, vixLevel: vix.quote.ltp });
  }
  return mk('vix', cfg, null, 'India VIX unavailable or not live');
}

function globalFactor(g, now, cfg) {
  const items = g && typeof g === 'object' ? cfg.globalIds.map((id) => ({ id, it: g[id] })).filter((x) => x.it) : [];
  const good = items.filter((x) => { const f = computeGlobalFreshness({ item: x.it, now }); return f.status === FRESH.FRESH && fin(x.it.pct); });
  if (good.length < cfg.globalMinItems) return mk('global', cfg, null, `Global cues not used (${good.length} fresh of ${cfg.globalMinItems} needed)`);
  const mean = good.reduce((s, x) => s + x.it.pct, 0) / good.length;
  return mk('global', cfg, lin(mean, cfg.globalFullPct), `Global equities ${mean > 0 ? 'positive' : mean < 0 ? 'negative' : 'flat'} (${sf(mean)}% avg of ${good.length}; small weight)`);
}

// ---------------------------------------------------------------------------------------------------------
// 4. WAIT pressure (all in 0..1) and data quality (0..1)
// ---------------------------------------------------------------------------------------------------------
function waitPressures(inp, nifty, atm, pc, vixF, cfg) {
  const P = {};
  // chop: tight 30-minute range, or price glued to VWAP inside the opening range
  const cs = nifty && nifty.session && nifty.session.candles ? nifty.session.candles.filter((c) => !fin(inp.now) || c.t + 60000 <= inp.now).slice(-30) : [];
  let chop = 0;
  if (cs.length >= 20) {
    const last = cs[cs.length - 1].c, rng = ((Math.max(...cs.map((c) => c.h)) - Math.min(...cs.map((c) => c.l))) / last) * 100;
    chop = clamp((cfg.chopRangePct - rng) / cfg.chopRangePct, 0, 1);
  }
  if (nifty && nifty.vwap && nifty.vwap.position === 'AT' && nifty.openingRange && nifty.openingRange.state === 'INSIDE') chop = Math.min(1, chop + 0.5);
  P.chop = chop;
  // volatility shock
  const vp = vixF && vixF.available ? vixF.vixPct : 0, vl = vixF && vixF.available ? vixF.vixLevel : 0;
  P.vol = clamp((vp >= cfg.vixShockPct ? 1 : vp >= cfg.vixShockPct / 2 ? 0.5 : 0) + (vl >= cfg.vixHigh ? 0.5 : 0), 0, 1);
  // theta decay of the ATM options (premium that melts: a poor environment for buying)
  const th = [];
  if (atm && pc && pc.ok) for (const [leg, g] of [[atm.call, pc.greeks.call], [atm.put, pc.greeks.put]]) if (fin(g.theta) && pos(leg.metrics.ltp)) th.push((Math.abs(g.theta) / leg.metrics.ltp) * 100);
  P.thetaPct = th.length ? th.reduce((a, b) => a + b, 0) / th.length : null;
  P.decay = P.thetaPct === null ? 0 : clamp((P.thetaPct - cfg.thetaMaxPct / 2) / (cfg.thetaMaxPct / 2), 0, 1);
  // thin liquidity / participation of the ATM contracts
  const tier = (t) => (t === LIQ.GOOD ? 0 : t === LIQ.FAIR ? 0.4 : t === LIQ.POOR ? 1 : 0.6);
  P.liq = atm ? (tier(atm.call.class) + tier(atm.put.class) + tier(atm.call.tiers.volume) + tier(atm.put.tiers.volume)) / 4 : 1;
  return P;
}

function dataQuality(inp, nifty, atm, pc, oi, vixF, cfg) {
  const items = []; let q = 1;
  const pen = (v, why) => { q -= v; items.push({ penalty: v, why }); };
  if (!vixF.available) pen(0.08, 'India VIX not used');
  const fr = (f) => f && f.status === FRESH.FRESH;
  if (fr(inp.quoteFresh)) pen(0.03, 'NIFTY tick is FRESH, not LIVE');
  if (fr(inp.candlesFresh)) pen(0.03, 'candles are FRESH, not LIVE');
  if (inp.chain && fr(inp.chain.fresh)) pen(0.05, 'option chain is FRESH, not LIVE');
  if (!pc || !pc.ok || pc.iv.change.status !== HIST.READY) pen(0.06, 'IV change still collecting history');
  if (!pc || !pc.ok || pc.pcr.nearChange.status !== HIST.READY) pen(0.04, 'PCR change still collecting history');
  if (!oi || !oi.ok || !oi.wallsAvailable) pen(0.08, 'OI walls unavailable');
  if (nifty && nifty.vwap && nifty.vwap.method !== 'VOLUME') pen(0.02, 'VWAP is a session-average proxy (index has no volume)');
  if (nifty && nifty.ohlc && nifty.ohlc.stale) pen(0.03, 'day range may be behind');
  if (atm && (atm.call.class !== LIQ.GOOD || atm.put.class !== LIQ.GOOD)) pen(0.05, 'ATM liquidity is not GOOD');
  if (atm && (atm.call.metrics.lotSize === null)) pen(0.05, 'lot size unknown');
  if (nifty && nifty.issues && nifty.issues.length) pen(Math.min(0.06, 0.02 * nifty.issues.length), 'NIFTY analysis reported issues');
  return { value: round6(clamp(q, 0, 1)), penalties: items };
}

// ---------------------------------------------------------------------------------------------------------
// 5. Probabilities
// ---------------------------------------------------------------------------------------------------------
// Three non-negative floats -> three integers in 0..100 that sum to EXACTLY 100 (largest remainder; ties go to WAIT, then PUT, then CALL).
export function toPercentages(c, p, w) {
  const v = [c, p, w].map((x) => (fin(x) && x > 0 ? x : 0));
  const sum = v[0] + v[1] + v[2];
  if (!(sum > 0)) return { CALL: 0, PUT: 0, WAIT: 100 };
  const raw = v.map((x) => (x / sum) * 100), fl = raw.map(Math.floor);
  let left = 100 - fl.reduce((a, b) => a + b, 0);
  const order = [2, 1, 0].map((i) => ({ i, r: raw[i] - fl[i] })).sort((a, b) => b.r - a.r);     // stable: equal remainders keep WAIT, PUT, CALL order
  for (let k = 0; left > 0; k = (k + 1) % 3, left--) fl[order[k].i] += 1;
  return { CALL: fl[0], PUT: fl[1], WAIT: fl[2] };
}

function softmax3(zc, zp, zw) {
  const m = Math.max(zc, zp, zw), a = Math.exp(zc - m), b = Math.exp(zp - m), c = Math.exp(zw - m), s = a + b + c;
  return { c: a / s, p: b / s, w: c / s };
}

// ---------------------------------------------------------------------------------------------------------
// WAIT result (gate failure or internal problem)
// ---------------------------------------------------------------------------------------------------------
function waitOnly(gate, why, extra) {
  const blockers = (gate && !gate.ok ? gate.reasons : []).map((t) => `Data-quality gate failed: ${t}`);
  if (why) blockers.push(why);
  blockers.push('No CALL / PUT score was calculated: a directional signal is not justified without complete, current data.');
  return build({
    signal: SIGNAL.WAIT, probabilities: { CALL: 0, PUT: 0, WAIT: 100 }, confidence: CONFIDENCE.LOW, gate,
    reasons: { perspective: 'BULLISH', positive: [], negative: [], blockers, neutral: [] }, factors: [], vetoes: [], scores: null, quality: null, ...(extra || null),
  });
}

function build(r) {
  const p = r.probabilities;
  const lines = [...r.reasons.positive.map((x) => `+ ${x.text}`), ...r.reasons.negative.map((x) => `- ${x.text}`), ...r.reasons.blockers.map((t) => `! ${t}`)];
  return {
    version: MODEL_VERSION, disclaimer: DISCLAIMER, kind: 'ESTIMATED_MODEL_SCORES',
    signal: r.signal, probabilities: p, callProbability: p.CALL, putProbability: p.PUT, waitProbability: p.WAIT,
    confidence: r.confidence, gate: r.gate || null,
    reasons: { ...r.reasons, lines },
    factors: r.factors || [], vetoes: r.vetoes || [], scores: r.scores || null, quality: r.quality || null,
    gatePassed: !!(r.gate && r.gate.ok), directionalScored: !!r.scores,
  };
}

// ---------------------------------------------------------------------------------------------------------
// MAIN: computeSignal(bundle, options)
// ---------------------------------------------------------------------------------------------------------
//   bundle = {
//     now,                           exchange-aligned clock (ms)                     REQUIRED
//     conn, market,                  feed connection state ('LIVE'...) and { state, fno } from market_info
//     quote, quoteFresh,             NIFTY feed instrument + computeFreshness()
//     candleInfo, candlesFresh,      describeSeries() info of the current candles + computeCandleFreshness()
//     nifty,                         analyzeNifty() result (Part 9)
//     chain, expiry,                 { rows, expiry, chainExpiry, fresh } and the SELECTED expiry
//     oi, pcriv, liquidity,          analyzeOi() / analyzePcrIv() / analyzeLiquidity() results (Parts 5-7)
//     vix: { quote, fresh },         India VIX instrument + its freshness (optional factor)
//     global,                        fetchGlobal() map (optional, small weight)
//   }
// options = { cfg }  (see CFG)
export function computeSignal(inp = {}, options = {}) {
  const cfg = mergeCfg(options.cfg);
  const gate = evaluateSignalGate(inp, options);
  if (!gate.ok) return waitOnly(gate);

  const nifty = inp.nifty, oi = inp.oi, pc = inp.pcriv, now = inp.now;
  const atm = atmRow(inp.liquidity);

  // ---- factors
  const vixF = volFactor(inp.vix, cfg);
  const gF = globalFactor(inp.global, now, cfg);
  const factors = [...priceFactors(nifty, now, cfg), ...optionFactors(nifty, oi, pc, cfg), vixF, gF];
  const W = Object.values(cfg.weights).reduce((a, b) => a + b, 0);
  const avail = factors.filter((f) => f.available);
  const availW = avail.reduce((s, f) => s + f.weight, 0);
  const callN = avail.reduce((s, f) => s + f.weight * Math.max(f.score, 0), 0) / W;
  const putN = avail.reduce((s, f) => s + f.weight * Math.max(-f.score, 0), 0) / W;
  const coverage = availW / W;
  const dirFactors = factors.filter((f) => f.id !== 'global');                                       // global never counts toward agreement / coverage
  const coverageCore = dirFactors.filter((f) => f.available).reduce((s, f) => s + f.weight, 0) / dirFactors.reduce((s, f) => s + f.weight, 0);
  const groupLean = {};
  for (const g of [GROUPS.PRICE, GROUPS.OPTIONS, GROUPS.VOLATILITY]) {
    const fs = factors.filter((f) => f.group === g && f.available), w = fs.reduce((s, f) => s + f.weight, 0);
    groupLean[g] = w > 0 ? round6(fs.reduce((s, f) => s + f.weight * f.score, 0) / w) : null;
  }

  // ---- WAIT pressure
  const P = waitPressures(inp, nifty, atm, pc, vixF, cfg);
  const q = dataQuality(inp, nifty, atm, pc, oi, vixF, cfg);
  const wp = cfg.waitW;
  const conflict = Math.min(callN, putN);
  const waitScore = cfg.waitBase + conflict + wp.chop * P.chop + wp.vol * P.vol + wp.decay * P.decay + wp.liq * P.liq + wp.coverage * (1 - coverageCore) + wp.quality * (1 - q.value);
  const sm = softmax3(cfg.K * callN, cfg.K * putN, cfg.K * waitScore);
  let fc = sm.c, fp = sm.p, fw = sm.w;
  if (![fc, fp, fw].every((x) => fin(x) && x >= 0)) return waitOnly(gate, 'Internal score was not a valid number: WAIT.');

  // ---- vetoes (only meaningful for the side the scores favour)
  const dir = fc > fp ? SIGNAL.CALL : fp > fc ? SIGNAL.PUT : null;
  const vetoes = [];
  if (dir) {
    const d = dir === SIGNAL.CALL ? 1 : -1, name = dir, other = dir === SIGNAL.CALL ? 'PUT' : 'CALL';
    const topP = (d > 0 ? fc : fp) * 100, lead = Math.abs(fc - fp) * 100;
    if (coverageCore < cfg.minCoverage) vetoes.push({ id: 'THIN_COVERAGE', text: `Only ${Math.round(coverageCore * 100)}% of the model inputs are available (need ${Math.round(cfg.minCoverage * 100)}%): ${name} is not justified.` });
    const pl = groupLean[GROUPS.PRICE], ol = groupLean[GROUPS.OPTIONS];
    const backs = (v) => v !== null && v * d >= cfg.groupLean;
    if (!backs(pl) || !backs(ol)) {
      const opp = (v) => v !== null && v * d <= -cfg.groupLean;
      vetoes.push({ id: 'NO_AGREEMENT', text: `${name} needs NIFTY price action and option-chain flow to agree: ${!backs(pl) ? `price action ${pl === null ? 'is unavailable' : opp(pl) ? `points ${other}` : 'is neutral'}` : ''}${!backs(pl) && !backs(ol) ? ' and ' : ''}${!backs(ol) ? `option flow ${ol === null ? 'is unavailable' : opp(ol) ? `points ${other}` : 'is neutral'}` : ''}.` });
    }
    if (topP < cfg.minDirProb) vetoes.push({ id: 'LOW_PROBABILITY', text: `${name} score ${Math.round(topP)}% is below the ${cfg.minDirProb}% needed for a directional signal.` });
    if (lead < cfg.minLead) vetoes.push({ id: 'LOW_SEPARATION', text: `CALL and PUT scores are only ${Math.round(lead)} points apart (need ${cfg.minLead}): no clear edge.` });
    // wall in the way: the opposing OI wall is right on top of price
    const spot = nifty.price.value, wall = dir === SIGNAL.CALL ? oi.resistance : oi.support;
    if (wall && (wall.distance / spot) * 100 <= cfg.wallNearPct) vetoes.push({ id: 'WALL_IN_THE_WAY', text: `${dir === SIGNAL.CALL ? 'CALL OI resistance' : 'PUT OI support'} at ${wall.strike} is only ${f2(wall.distance, 0)} pts away: no room for a ${name} move.` });
    // chosen contract must be tradable
    const leg = dir === SIGNAL.CALL ? atm.call : atm.put;
    if (leg.class === LIQ.POOR || leg.class === LIQ.UNAVAILABLE) vetoes.push({ id: 'ILLIQUID_CONTRACT', text: `ATM ${dir === SIGNAL.CALL ? 'CALL' : 'PUT'} option liquidity is ${leg.class} (spread ${f2(leg.metrics.spreadPct)}%): ${name} is not justified.` });
    // global can never decide: remove it and the edge must survive
    if (gF.available) {
      const wo = avail.filter((f) => f.id !== 'global'), c0 = wo.reduce((s, f) => s + f.weight * Math.max(f.score, 0), 0) / W, p0 = wo.reduce((s, f) => s + f.weight * Math.max(-f.score, 0), 0) / W;
      const s0 = softmax3(cfg.K * c0, cfg.K * p0, cfg.K * waitScore), still = (d > 0 ? s0.c > s0.p : s0.p > s0.c) && Math.abs(s0.c - s0.p) * 100 >= cfg.minLead;
      if (!still) vetoes.push({ id: 'GLOBAL_DEPENDENT', text: `The ${name} edge exists only because of global data (small, unreliable weight): not justified.` });
    }
    if (vetoes.length) {                                                                              // WAIT must be the largest, with a clear lead
      const top = Math.max(fc, fp), w2 = Math.max(fw, top * cfg.vetoWaitMultiple), s = fc + fp + w2;
      fc /= s; fp /= s; fw = w2 / s;
    }
  }
  const pct = toPercentages(fc, fp, fw);
  const sum = pct.CALL + pct.PUT + pct.WAIT;
  if (sum !== 100) return waitOnly(gate, 'Internal probability normalisation failed: WAIT.');

  // ---- signal: directional only when its (rounded) probability is strictly the largest AND no veto stands
  let signal = SIGNAL.WAIT;
  if (!vetoes.length) { if (pct.CALL > pct.PUT && pct.CALL > pct.WAIT) signal = SIGNAL.CALL; else if (pct.PUT > pct.CALL && pct.PUT > pct.WAIT) signal = SIGNAL.PUT; }

  // ---- confidence
  const topV = signal === SIGNAL.WAIT ? pct.WAIT : pct[signal];
  const second = signal === SIGNAL.WAIT ? Math.max(pct.CALL, pct.PUT) : Math.max(...['CALL', 'PUT', 'WAIT'].filter((k) => k !== signal).map((k) => pct[k]));
  const leadPts = topV - second;
  let agree = 1;
  if (signal !== SIGNAL.WAIT) {
    const d = signal === SIGNAL.CALL ? 1 : -1, lean = dirFactors.filter((f) => f.available && Math.abs(f.score) > cfg.leanEps);
    const tw = lean.reduce((s, f) => s + f.weight, 0);
    agree = tw > 0 ? lean.filter((f) => f.score * d > 0).reduce((s, f) => s + f.weight, 0) / tw : 0;
  }
  const lv = (t) => leadPts >= t.lead && agree >= t.agree && q.value >= t.quality && coverageCore >= t.coverage;
  let confidence = lv(cfg.conf.high) ? CONFIDENCE.HIGH : lv(cfg.conf.medium) ? CONFIDENCE.MEDIUM : CONFIDENCE.LOW;
  if (signal === SIGNAL.WAIT && vetoes.length) confidence = confidence === CONFIDENCE.HIGH ? CONFIDENCE.MEDIUM : confidence;   // a vetoed WAIT is a judgement call, never HIGH

  // ---- reasons
  const sig = signal === SIGNAL.PUT ? -1 : 1;
  const ordered = (list) => list.slice().sort((a, b) => b.weight * Math.abs(b.score) - a.weight * Math.abs(a.score) || a.id.localeCompare(b.id));
  const item = (f) => ({ id: f.id, group: f.group, text: f.text, weight: f.weight, score: f.score });
  const reasons = {
    perspective: signal === SIGNAL.PUT ? 'PUT' : signal === SIGNAL.CALL ? 'CALL' : 'BULLISH',
    positive: ordered(avail.filter((f) => f.score * sig > EPS)).map(item),
    negative: ordered(avail.filter((f) => f.score * sig < -EPS)).map(item),
    neutral: factors.filter((f) => f.available && Math.abs(f.score) <= EPS).map(item),
    missing: factors.filter((f) => !f.available).map((f) => ({ id: f.id, text: f.text })),
    blockers: [],
  };
  if (signal === SIGNAL.WAIT) {
    reasons.blockers.push(...vetoes.map((v) => v.text));
    if (!vetoes.length) {
      const parts = [];
      if (conflict > 0.08) parts.push(`bullish (${Math.round(callN * 100)}) and bearish (${Math.round(putN * 100)}) evidence both carry weight`);
      if (Math.max(callN, putN) < 0.25) parts.push('neither side has strong evidence');
      if (P.chop > 0.4) parts.push('NIFTY is chopping in a tight range');
      if (P.vol > 0.4) parts.push('India VIX is elevated or spiking');
      if (P.decay > 0.4) parts.push(`ATM premium decay is heavy (~${f2(P.thetaPct, 1)}%/day)`);
      if (P.liq > 0.5) parts.push('ATM option liquidity is thin');
      if (coverageCore < 0.85) parts.push(`${Math.round((1 - coverageCore) * 100)}% of model inputs are unavailable`);
      if (q.value < 0.85) parts.push('data quality is reduced');
      reasons.blockers.push(`WAIT (${pct.WAIT}%) is the highest score: a directional signal is not justified because ${parts.length ? parts.join('; ') : 'CALL and PUT do not clear WAIT by a clear margin'}.`);
    }
  } else if (reasons.negative.length === 0) reasons.notes = ['No factor opposes this direction.'];
  if (q.penalties.length) reasons.dataNotes = q.penalties.map((x) => x.why);
  if (gF.available) (reasons.dataNotes = reasons.dataNotes || []).push('Global cues included at a small fixed weight.');

  return build({
    signal, probabilities: pct, confidence, gate, reasons, factors, vetoes,
    scores: { callN: round6(callN), putN: round6(putN), waitScore: round6(waitScore), conflict: round6(conflict), coverage: round6(coverage), coverageCore: round6(coverageCore), groupLean, agreement: round6(agree), leadPoints: leadPts, waitPressure: P },
    quality: q,
  });
}

// ---------------------------------------------------------------------------------------------------------
// Convenience: build the bundle from raw app state and compute. Uses ONLY the existing pure analysis modules.
// ---------------------------------------------------------------------------------------------------------
//   snapshot = { now, conn, market, nifty (feed quote), niftyFresh, candles (any session), candlesFresh,
//                chain: { rows, expiry, chainExpiry, fresh, receivedAt } | null, expiry, lotSize, vix, vixFresh, global, pcrIvHistory }
export function bundleFromSnapshot(s = {}) {
  const now = s.now, ms = s.market ? s.market.state : MS.UNKNOWN;
  const sel = selectCandles(Array.isArray(s.candles) ? s.candles : [], now, ms);
  const nifty = analyzeNifty({ quote: s.nifty, quoteFresh: s.niftyFresh, candles: s.candles, candlesFresh: s.candlesFresh, marketState: ms, now, chain: s.chain || null });
  const spot = nifty.price && nifty.price.value !== null ? nifty.price.value : validSpot(s.nifty, s.niftyFresh);
  const ch = s.chain || {};
  const base = { rows: ch.rows, expiry: s.expiry, chainExpiry: ch.chainExpiry, spot };
  return {
    now, conn: s.conn, market: s.market, quote: s.nifty, quoteFresh: s.niftyFresh, candleInfo: sel.info, candlesFresh: s.candlesFresh,
    nifty, chain: s.chain || null, expiry: s.expiry,
    oi: analyzeOi(base),
    pcriv: analyzePcrIv({ ...base, history: s.pcrIvHistory, at: ch.receivedAt || (ch.fresh && ch.fresh.receivedAt) || now }),
    liquidity: analyzeLiquidity({ ...base, fresh: ch.fresh, lotSize: s.lotSize === undefined ? null : s.lotSize }),
    vix: { quote: s.vix || null, fresh: s.vixFresh || null },
    global: s.global || null,
  };
}
export function runSignal(snapshot, options) { return computeSignal(bundleFromSnapshot(snapshot), options); }

// Plain text in the requested layout:  SIGNAL / probabilities / confidence / reasons.
export function formatSignal(r) {
  const L = [`SIGNAL: ${r.signal}`, '', `CALL ${r.probabilities.CALL}%`, `PUT ${r.probabilities.PUT}%`, `WAIT ${r.probabilities.WAIT}%`, '', `Confidence: ${r.confidence}`, '', 'Reasons:'];
  if (r.signal === SIGNAL.WAIT && r.directionalScored) L.push('(+ = leans CALL / bullish, - = leans PUT / bearish, ! = why no direction is justified)');
  L.push(...r.reasons.lines, '', 'Estimated internal model scores, not guaranteed market probabilities.');
  return L.join('\n');
}
