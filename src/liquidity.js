// Option liquidity and contract quality (Part 7). Pure functions: no network, no clock reads, no UI.
//
// Input is the parsed option chain of ONE expiry (src/chain.js). For contracts near ATM it looks at what Upstox really
// sent: LTP, OI, volume, bid, ask, bid qty, ask qty (and delta for the ranking), derives spread / spread % / depth, and
//   1. CLASSIFIES every contract:  GOOD | FAIR | POOR | UNAVAILABLE                      (analyzeLiquidity)
//   2. RANKS the suitable CE / PE contracts for later use                                  (rankContracts)
//
// This module does NOT create CALL / PUT signals and never places or prepares an order. It only says which contracts are
// liquid enough to be considered later. Rules it enforces:
//   - ONE expiry. A chain for another expiry (or with a foreign row) is refused, exactly like Parts 5 and 6 (checkChain).
//   - a missing value stays null and is reported as missing. It is never turned into 0 and never copied from another field.
//     Unknown liquidity is not good liquidity: a missing OI / volume / depth counts as POOR for that metric.
//   - no strike, lot size or price level is hardcoded: ATM comes from the live NIFTY price, the lot size from the Upstox
//     contract list. Without a lot size the depth is judged only as "something is quoted" and the class is capped at FAIR.
//   - freshness: Upstox sends NO per-contract timestamp, so freshness is the freshness of the chain the contract came from
//     (chainStatus: LIVE | STALE | PREVIOUS SESSION | UNAVAILABLE). A stale chain caps every contract at POOR; a
//     previous-session snapshot is graded but is not offered as selectable unless the caller explicitly allows it.
//   - the thresholds below are tunable DEFAULTS (not market facts). Every one can be overridden by the caller.
import { findAtm, chainStatus, CHAIN_STATUS, MAX_STRIKES } from './chain';
import { checkChain, chainReasonText } from './oi';
import { NEAR_STRIKES, fixed } from './pcriv';
import { FRESH } from './feed/freshness';

// ---------------------------------------------------------------------------------------------------------
// Definitions (one place, so the UI labels can quote them)
// ---------------------------------------------------------------------------------------------------------
export const LIQ = { GOOD: 'GOOD', FAIR: 'FAIR', POOR: 'POOR', UNAVAILABLE: 'UNAVAILABLE' };
export const CLASS_ORDER = { UNAVAILABLE: 0, POOR: 1, FAIR: 2, GOOD: 3 };
const POINTS = { GOOD: 2, FAIR: 1, POOR: 0 };

// spreadPct = (ask - bid) / mid * 100, lower is better. oi / volume are in units (not lots). depthLots = the SMALLER of
// bid qty and ask qty, divided by the lot size (what can really be traded at the top of the book on both sides).
export const DEFAULT_THRESHOLDS = {
  spreadPct: { good: 1, fair: 3 },
  oi: { good: 200000, fair: 50000 },
  volume: { good: 100000, fair: 20000 },
  depthLots: { good: 5, fair: 1 },
};

// How the ranking score (0..100) is made up. Sums to 1.
export const WEIGHTS = { proximity: 0.20, spread: 0.25, oi: 0.15, volume: 0.15, depth: 0.10, delta: 0.10, freshness: 0.05 };

// Ranking defaults. delta: |delta| must lie in [min, max]; the closer to `target` the better.
export const DEFAULT_DELTA = { min: 0.25, max: 0.75, target: 0.5 };
export const DEFAULT_MIN_CLASS = LIQ.FAIR;

export const LIQ_REASON = {
  // contract cannot be evaluated
  NO_CONTRACT: 'NO_CONTRACT', NO_LTP: 'NO_LTP', NO_BID: 'NO_BID', NO_ASK: 'NO_ASK', CROSSED_QUOTE: 'CROSSED_QUOTE', CHAIN_UNAVAILABLE: 'CHAIN_UNAVAILABLE',
  // quality findings
  WIDE_SPREAD: 'WIDE_SPREAD', THIN_DEPTH: 'THIN_DEPTH', LOW_OI: 'LOW_OI', LOW_VOLUME: 'LOW_VOLUME',
  MISSING_OI: 'MISSING_OI', MISSING_VOLUME: 'MISSING_VOLUME', MISSING_DEPTH: 'MISSING_DEPTH', NO_LOT_SIZE: 'NO_LOT_SIZE',
  STALE_CHAIN: 'STALE_CHAIN', SNAPSHOT_ONLY: 'SNAPSHOT_ONLY',
  // ranking exclusions
  BELOW_MIN_CLASS: 'BELOW_MIN_CLASS', DELTA_MISSING: 'DELTA_MISSING', DELTA_WRONG_SIGN: 'DELTA_WRONG_SIGN', DELTA_OUT_OF_RANGE: 'DELTA_OUT_OF_RANGE',
  // whole-analysis failures (besides the chain reasons of src/oi.js)
  NO_SPOT: 'NO_SPOT', SPOT_OUTSIDE_CHAIN: 'SPOT_OUTSIDE_CHAIN',
};

export const REASON_TEXT = {
  NO_CONTRACT: 'No contract data', NO_LTP: 'No last traded price', NO_BID: 'No bid', NO_ASK: 'No ask', CROSSED_QUOTE: 'Bid is above ask (invalid quote)',
  CHAIN_UNAVAILABLE: 'Chain freshness unavailable',
  WIDE_SPREAD: 'Wide bid/ask spread', THIN_DEPTH: 'Thin top-of-book quantity', LOW_OI: 'Low open interest', LOW_VOLUME: 'Low volume',
  MISSING_OI: 'OI not sent', MISSING_VOLUME: 'Volume not sent', MISSING_DEPTH: 'Bid/ask quantity not sent', NO_LOT_SIZE: 'Lot size unknown: depth not judged in lots',
  STALE_CHAIN: 'Chain is stale', SNAPSHOT_ONLY: 'Previous-session snapshot, not live',
  BELOW_MIN_CLASS: 'Liquidity below the required class', DELTA_MISSING: 'Delta not sent', DELTA_WRONG_SIGN: 'Delta has the wrong sign for this option type', DELTA_OUT_OF_RANGE: 'Delta outside the wanted range',
  NO_SPOT: 'Waiting for a valid NIFTY price from the live feed', SPOT_OUTSIDE_CHAIN: 'The NIFTY price is outside the strikes Upstox returned',
};
export const reasonText = (code) => REASON_TEXT[code] || chainReasonText(code) || null;

// ---------------------------------------------------------------------------------------------------------
// Small numeric helpers (null stays null)
// ---------------------------------------------------------------------------------------------------------
const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const count = (v) => { const n = fin(v); return n !== null && n >= 0 ? n : null; };   // OI / volume / qty / bid / ask: 0 is a real value
const pos = (v) => { const n = fin(v); return n !== null && n > 0 ? n : null; };      // LTP, lot size: 0 means "none"
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const round = (v, d) => { const m = Math.pow(10, d); return Math.round(v * m) / m; };

// Tunable thresholds: only finite numbers in the right order are accepted; anything else keeps the default.
export function mergeThresholds(over) {
  const out = {};
  for (const k of Object.keys(DEFAULT_THRESHOLDS)) {
    const d = DEFAULT_THRESHOLDS[k], o = over && over[k];
    const g = o ? fin(o.good) : null, f = o ? fin(o.fair) : null;
    const lowerIsBetter = k === 'spreadPct';
    const ok = g !== null && f !== null && g >= 0 && f >= 0 && (lowerIsBetter ? g < f : g > f);
    out[k] = ok ? { good: g, fair: f } : { ...d };
  }
  return out;
}

// The lot size, only when every CE/PE of the expiry agrees on one (src/contracts.js pairsForExpiry output). Otherwise null.
export function lotSizeFromPairs(pairs) {
  const sizes = new Set();
  for (const p of Array.isArray(pairs) ? pairs : []) [p && p.ce, p && p.pe].forEach((c) => { if (c && pos(c.lotSize) !== null) sizes.add(c.lotSize); });
  return sizes.size === 1 ? Array.from(sizes)[0] : null;
}

// ---------------------------------------------------------------------------------------------------------
// One option: raw quote numbers
// ---------------------------------------------------------------------------------------------------------
// `side` is one parsed chain side (src/chain.js parseSide). spread / spreadPct exist only for a valid two-sided quote.
export function quoteMetrics(side, lotSize) {
  const s = side || {};
  const ltp = pos(s.ltp), bid = count(s.bid), ask = count(s.ask), bidQty = count(s.bidQty), askQty = count(s.askQty);
  const lot = pos(lotSize);
  const twoSided = bid !== null && bid > 0 && ask !== null && ask > 0;
  const crossed = twoSided && ask < bid;
  const mid = twoSided && !crossed ? (bid + ask) / 2 : null;
  const spread = mid !== null ? round(ask - bid, 4) : null;
  const depthQty = bidQty !== null && askQty !== null ? Math.min(bidQty, askQty) : null;
  return {
    ltp, oi: count(s.oi), volume: count(s.vol), bid, ask, bidQty, askQty, delta: fin(s.delta),
    mid, spread, spreadPct: spread !== null ? (spread / mid) * 100 : null,
    depthQty, depthLots: depthQty !== null && lot !== null ? depthQty / lot : null, lotSize: lot,
    twoSided, crossed,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Freshness of the chain a contract came from
// ---------------------------------------------------------------------------------------------------------
// fresh = computeChainFreshness(...) from src/feed/freshness.js. Required: without it the chain is UNAVAILABLE and so is every contract.
export function freshnessOf({ rows, expiry, chainExpiry, fresh } = {}) {
  const st = chainStatus({ rows, chainExpiry, expiry, fresh });
  const live = st.status === CHAIN_STATUS.LIVE;
  const ageMs = fresh && Number.isFinite(fresh.ageMs) ? fresh.ageMs : null;
  return {
    status: st.status, reason: st.reason, text: st.text, ageMs,
    live, snapshot: st.status === CHAIN_STATUS.PREVIOUS, stale: st.status === CHAIN_STATUS.STALE, unavailable: st.status === CHAIN_STATUS.UNAVAILABLE,
    score: live ? (fresh && fresh.status === FRESH.LIVE ? 1 : 0.85) : st.status === CHAIN_STATUS.PREVIOUS ? 0.5 : 0,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------------------
const tierHigh = (v, t) => (v === null ? null : v >= t.good ? LIQ.GOOD : v >= t.fair ? LIQ.FAIR : LIQ.POOR);
const tierLow = (v, t) => (v === null ? null : v <= t.good ? LIQ.GOOD : v <= t.fair ? LIQ.FAIR : LIQ.POOR);
function depthTier(q, th) {
  if (q.depthQty === null) return null;
  if (q.depthLots === null) return q.depthQty > 0 ? LIQ.FAIR : LIQ.POOR;      // lot size unknown: only "is something quoted on both sides"
  return tierHigh(q.depthLots, th.depthLots);
}

// Class from the four tiers (a null tier = metric missing = counted as POOR):
//   POOR  if the SPREAD or the DEPTH is POOR (cannot be traded sensibly), or BOTH OI and volume are POOR (nobody is there)
//   GOOD  if the spread is GOOD, no tier is POOR and at most one tier is only FAIR
//   FAIR  otherwise
export function classFromTiers(t) {
  const s = t.spread || LIQ.POOR, d = t.depth || LIQ.POOR, o = t.oi || LIQ.POOR, v = t.volume || LIQ.POOR;
  if (s === LIQ.POOR || d === LIQ.POOR || (o === LIQ.POOR && v === LIQ.POOR)) return LIQ.POOR;
  const sum = POINTS[s] + POINTS[d] + POINTS[o] + POINTS[v];
  if (s === LIQ.GOOD && o !== LIQ.POOR && v !== LIQ.POOR && sum >= 7) return LIQ.GOOD;
  return LIQ.FAIR;
}

// Evaluate one side of one strike.  ctx = { type 'CE'|'PE', strike, lotSize, thresholds (merged), freshness }
export function evaluateSide(side, ctx = {}) {
  const th = ctx.thresholds || mergeThresholds();
  const fr = ctx.freshness || null;
  const q = quoteMetrics(side, ctx.lotSize);
  const out = {
    type: ctx.type || null, strike: ctx.strike === undefined ? null : ctx.strike, instrumentKey: (side && side.key) || null,
    class: LIQ.UNAVAILABLE, metrics: q, tiers: { spread: null, depth: null, oi: null, volume: null }, reasons: [], missing: [],
    freshness: fr && { status: fr.status, text: fr.text, ageMs: fr.ageMs },
  };
  // ---- can it be evaluated at all?
  const na = [];
  if (!side) na.push(LIQ_REASON.NO_CONTRACT);
  if (fr && fr.unavailable) na.push(LIQ_REASON.CHAIN_UNAVAILABLE);
  if (side) {
    if (q.ltp === null) na.push(LIQ_REASON.NO_LTP);
    if (q.bid === null || q.bid <= 0) na.push(LIQ_REASON.NO_BID);
    if (q.ask === null || q.ask <= 0) na.push(LIQ_REASON.NO_ASK);
    if (q.crossed) na.push(LIQ_REASON.CROSSED_QUOTE);
  }
  if (na.length) { out.reasons = Array.from(new Set(na)); return out; }

  // ---- tiers
  const t = out.tiers;
  t.spread = tierLow(q.spreadPct, th.spreadPct);
  t.depth = depthTier(q, th);
  t.oi = tierHigh(q.oi, th.oi);
  t.volume = tierHigh(q.volume, th.volume);
  const r = out.reasons;
  if (t.spread === LIQ.POOR) r.push(LIQ_REASON.WIDE_SPREAD);
  if (t.depth === null) { r.push(LIQ_REASON.MISSING_DEPTH); out.missing.push('depth'); } else if (t.depth === LIQ.POOR) r.push(LIQ_REASON.THIN_DEPTH);
  if (t.oi === null) { r.push(LIQ_REASON.MISSING_OI); out.missing.push('oi'); } else if (t.oi === LIQ.POOR) r.push(LIQ_REASON.LOW_OI);
  if (t.volume === null) { r.push(LIQ_REASON.MISSING_VOLUME); out.missing.push('volume'); } else if (t.volume === LIQ.POOR) r.push(LIQ_REASON.LOW_VOLUME);

  let cls = classFromTiers(t);
  if (q.lotSize === null && q.depthQty !== null) { r.push(LIQ_REASON.NO_LOT_SIZE); if (cls === LIQ.GOOD) cls = LIQ.FAIR; }   // depth was not judged in lots
  if (fr && fr.stale) { r.push(LIQ_REASON.STALE_CHAIN); cls = LIQ.POOR; }                                                   // a stale quote proves nothing
  if (fr && fr.snapshot) r.push(LIQ_REASON.SNAPSHOT_ONLY);
  out.class = cls;
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Whole chain: the contracts near ATM
// ---------------------------------------------------------------------------------------------------------
const fail = (reason, expiry) => ({ ok: false, reason, text: reasonText(reason), expiry: expiry || null });
const windowOf = (n) => { const v = Math.round(Number(n)); return Number.isFinite(v) ? Math.max(1, Math.min(MAX_STRIKES, v)) : NEAR_STRIKES; };

// analyzeLiquidity({ rows, expiry, chainExpiry, spot, fresh, lotSize, thresholds, window })
//   rows / expiry / chainExpiry  as in analyzeOi (the SELECTED expiry; anything else is refused)
//   spot     latest valid NIFTY price (chain.js validSpot): ATM needs it, otherwise "ATM UNAVAILABLE"
//   fresh    chain freshness (computeChainFreshness)       lotSize  number (lotSizeFromPairs) or null
//   window   strikes each side of ATM (default 5, the same "near ATM" as the PCR)
export function analyzeLiquidity({ rows, expiry, chainExpiry, spot, fresh, lotSize = null, thresholds, window = NEAR_STRIKES } = {}) {
  const bad = checkChain({ rows, expiry, chainExpiry });
  if (bad) return fail(bad, expiry);
  const hasSpot = typeof spot === 'number' && Number.isFinite(spot) && spot > 0;
  const ai = hasSpot ? findAtm(rows, spot) : -1;
  if (ai < 0) return fail(hasSpot ? LIQ_REASON.SPOT_OUTSIDE_CHAIN : LIQ_REASON.NO_SPOT, expiry);

  const n = windowOf(window), th = mergeThresholds(thresholds), fr = freshnessOf({ rows, expiry, chainExpiry, fresh });
  const lo = Math.max(0, ai - n), hi = Math.min(rows.length - 1, ai + n);
  const out = [];
  for (let i = lo; i <= hi; i++) {
    const r = rows[i];
    const ctx = (type) => ({ type, strike: r.strike, lotSize, thresholds: th, freshness: fr });
    out.push({ strike: r.strike, atm: i === ai, offset: i - ai, call: evaluateSide(r.call, ctx('CE')), put: evaluateSide(r.put, ctx('PE')) });
  }
  const tally = (key) => out.reduce((m, r) => { m[r[key].class] += 1; return m; }, { GOOD: 0, FAIR: 0, POOR: 0, UNAVAILABLE: 0 });
  return {
    ok: true, reason: null, text: null, expiry, spot, atmStrike: rows[ai].strike, window: n,
    freshness: fr, thresholds: th, lotSize: pos(lotSize),
    rows: out, summary: { CE: tally('call'), PE: tally('put') },
    clippedBelow: ai - n < 0, clippedAbove: ai + n > rows.length - 1,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------------------------------------
// Continuous 0..1 scores that agree with the tiers: GOOD threshold = 1.0, FAIR threshold = 0.5, nothing = 0.
const scoreHigh = (v, t) => (v === null ? 0 : v >= t.good ? 1 : v >= t.fair ? 0.5 + 0.5 * ((v - t.fair) / (t.good - t.fair)) : t.fair > 0 ? 0.5 * clamp01(v / t.fair) : 0);
const scoreLow = (v, t) => (v === null ? 0 : v <= t.good ? 1 : v <= t.fair ? 1 - 0.5 * ((v - t.good) / (t.fair - t.good)) : 0.5 * clamp01(1 - (v - t.fair) / t.fair));

function mergeDelta(over) {
  const o = over || {};
  const min = fin(o.min) !== null ? o.min : DEFAULT_DELTA.min, max = fin(o.max) !== null ? o.max : DEFAULT_DELTA.max;
  const target = fin(o.target) !== null ? o.target : DEFAULT_DELTA.target;
  return min > 0 && max <= 1 && min < max && target >= min && target <= max ? { min, max, target } : { ...DEFAULT_DELTA };
}

// Delta must have the sign of the option type (CE positive, PE negative, as Upstox sends them) and |delta| inside [min, max].
function deltaIssue(type, d, dl) {
  if (d === null) return LIQ_REASON.DELTA_MISSING;
  if ((type === 'CE' && d <= 0) || (type === 'PE' && d >= 0)) return LIQ_REASON.DELTA_WRONG_SIGN;
  const a = Math.abs(d);
  return a < dl.min || a > dl.max ? LIQ_REASON.DELTA_OUT_OF_RANGE : null;
}

// rankContracts(input, options)  -> the suitable CE and PE contracts, best first. Pure and reusable.
//   input    exactly the input of analyzeLiquidity ({ rows, expiry, chainExpiry, spot, fresh, lotSize, thresholds, window })
//   options  { types: ['CE','PE'], minClass: 'FAIR' | 'GOOD', delta: { min, max, target }, includeSnapshot: false }
// A contract is only ranked when ALL of these hold: it is within the ATM window, its liquidity class is at least `minClass`,
// the chain is live (a previous-session snapshot only with includeSnapshot, a stale chain never), and it has a delta of the
// right sign inside the wanted range. Everything else is listed in `rejected` with the reasons.
// The score (0..100, WEIGHTS) only orders suitable contracts: proximity to ATM, spread, OI, volume, depth, delta, freshness.
// Ties: higher score, then closer to ATM, then higher volume, then lower strike. The result carries no direction and no order.
export function rankContracts(input = {}, options = {}) {
  const a = analyzeLiquidity(input);
  const empty = { CE: [], PE: [], best: { CE: null, PE: null }, rejected: [], selectable: false };
  if (!a.ok) return { ...a, ...empty };

  const opt = options || {};
  const types = (Array.isArray(opt.types) ? opt.types : ['CE', 'PE']).filter((t, i, arr) => (t === 'CE' || t === 'PE') && arr.indexOf(t) === i);
  const use = types.length ? types : ['CE', 'PE'];
  const minClass = opt.minClass === LIQ.GOOD ? LIQ.GOOD : DEFAULT_MIN_CLASS;
  const dl = mergeDelta(opt.delta);
  const includeSnapshot = opt.includeSnapshot === true;
  const fr = a.freshness, th = a.thresholds;
  const selectable = fr.live || (fr.snapshot && includeSnapshot);
  const halfBand = Math.max(dl.target - dl.min, dl.max - dl.target);

  const res = { CE: [], PE: [] }, rejected = [];
  for (const row of a.rows) {
    for (const type of use) {
      const ev = type === 'CE' ? row.call : row.put;
      const why = [];
      if (fr.stale) why.push(LIQ_REASON.STALE_CHAIN);
      else if (fr.snapshot && !includeSnapshot) why.push(LIQ_REASON.SNAPSHOT_ONLY);
      if (ev.class === LIQ.UNAVAILABLE) why.push(...ev.reasons);
      else if (CLASS_ORDER[ev.class] < CLASS_ORDER[minClass]) why.push(LIQ_REASON.BELOW_MIN_CLASS, ...ev.reasons.filter((r) => r !== LIQ_REASON.STALE_CHAIN && r !== LIQ_REASON.SNAPSHOT_ONLY));
      const dIssue = deltaIssue(type, ev.metrics.delta, dl);
      if (dIssue) why.push(dIssue);
      if (why.length) { rejected.push({ type, strike: row.strike, class: ev.class, reasons: Array.from(new Set(why)) }); continue; }

      const m = ev.metrics, dist = Math.abs(row.offset);
      const depth = m.depthLots !== null ? scoreHigh(m.depthLots, th.depthLots) : (m.depthQty > 0 ? 0.5 : 0);
      const comp = {
        proximity: 1 - dist / (a.window + 1),
        spread: scoreLow(m.spreadPct, th.spreadPct), oi: scoreHigh(m.oi, th.oi), volume: scoreHigh(m.volume, th.volume), depth,
        delta: clamp01(1 - Math.abs(Math.abs(m.delta) - dl.target) / halfBand),
        freshness: fr.score,
      };
      const score = round(100 * Object.keys(WEIGHTS).reduce((s, k) => s + WEIGHTS[k] * comp[k], 0), 2);
      res[type].push({
        type, strike: row.strike, instrumentKey: ev.instrumentKey, atm: row.atm, distance: dist, offset: row.offset,
        score, components: comp, class: ev.class, metrics: m, tiers: ev.tiers, reasons: ev.reasons, freshness: ev.freshness,
      });
    }
  }
  for (const type of ['CE', 'PE']) {
    res[type].sort((x, y) => y.score - x.score || x.distance - y.distance || (y.metrics.volume || 0) - (x.metrics.volume || 0) || x.strike - y.strike);
    res[type].forEach((c, i) => { c.rank = i + 1; });
  }
  return {
    ok: true, reason: null, text: null, expiry: a.expiry, spot: a.spot, atmStrike: a.atmStrike, window: a.window,
    freshness: fr, thresholds: th, lotSize: a.lotSize, selectable,
    params: { types: use, minClass, delta: dl, includeSnapshot },
    CE: res.CE, PE: res.PE, best: { CE: res.CE[0] || null, PE: res.PE[0] || null },
    rejected, counts: { considered: a.rows.length * use.length, ranked: res.CE.length + res.PE.length, rejected: rejected.length },
    rows: a.rows, summary: a.summary,          // the classified ATM window, so a caller needs only one call
  };
}

// ---------------------------------------------------------------------------------------------------------
// Text helpers for the UI. null is always '--'; a real 0 stays '0'.
// ---------------------------------------------------------------------------------------------------------
export const fmtSpreadPct = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(2)}%` : '--');
export const fmtLots = (v) => fixed(v, 1);
export const fmtScore = (v) => fixed(v, 1);
