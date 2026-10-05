// Open-interest analysis (Part 5). Pure functions: no network, no clock reads, no UI.
//
// Input is the parsed option chain of ONE expiry (src/chain.js): rows { expiry, strike, call, put } where each side
// carries the real Upstox `oi` (market_data.oi) and `prevOi` (market_data.prev_oi).
//
//   dOI = current OI - previous OI          (null when either value is missing / invalid: never 0, never guessed)
//
// Rules this module enforces:
//   - ONE expiry. The analysis is refused (ok:false) unless the chain is for the selected expiry and every row carries it.
//   - no strike is hardcoded: every strike, level and wall comes from the rows that were passed in.
//   - a missing / invalid OI is excluded and counted, never turned into 0.
//   - PCR, IV and the trading signal are NOT part of this module.
import { num } from './util';
import { normExpiry } from './contracts';

// A wall is a strike whose OI is at least WALL_SHARE of the biggest OI on its side of spot AND a local peak.
export const WALL_SHARE = 0.6;
export const MAX_WALLS = 3;

export const OI_REASON = {
  NO_EXPIRY: 'NO_EXPIRY',
  NO_CHAIN: 'NO_CHAIN',
  EXPIRY_MISMATCH: 'EXPIRY_MISMATCH',
  MIXED_EXPIRY: 'MIXED_EXPIRY',
  NO_VALID_OI: 'NO_VALID_OI',
};

const OI_TEXT = {
  NO_EXPIRY: 'No expiry selected',
  NO_CHAIN: 'Option chain not received yet',
  EXPIRY_MISMATCH: 'Chain on hand is not for the selected expiry',
  MIXED_EXPIRY: 'Chain contains rows of another expiry: analysis refused',
  NO_VALID_OI: 'No strike has a valid OI value',
};

// ---------------------------------------------------------------------------------------------------------
// Per-option numbers
// ---------------------------------------------------------------------------------------------------------
// OI is a count: finite and >= 0. 0 is a real value. Anything else (null, NaN, negative, text) is invalid.
const validCount = (v) => { const n = num(v); return n !== null && n >= 0 ? n : null; };

// One option -> { oi, prevOi, delta, issue }.   issue: null | 'MISSING_OI' | 'MISSING_PREV_OI'
//   delta = oi - prevOi, only when BOTH are valid.
export function oiOf(side) {
  const oi = validCount(side && side.oi);
  const prevOi = validCount(side && side.prevOi);
  const delta = oi !== null && prevOi !== null ? oi - prevOi : null;
  const issue = oi === null ? 'MISSING_OI' : prevOi === null ? 'MISSING_PREV_OI' : null;
  return { oi, prevOi, delta, issue };
}

export const deltaOi = (oi, prevOi) => {
  const a = validCount(oi), b = validCount(prevOi);
  return a !== null && b !== null ? a - b : null;
};

// ---------------------------------------------------------------------------------------------------------
// Selection helpers
// ---------------------------------------------------------------------------------------------------------
// Highest `pick(r)` over rows; ties go to the LOWER strike (rows are ascending). Rows with null are skipped.
// `minValue` = smallest value that counts (OI: > 0 means "someone holds this strike"; dOI buildup: > 0).
function best(rows, pick, minValue = 0) {
  let hit = null;
  for (const r of rows) {
    const v = pick(r);
    if (v === null || v === undefined) continue;
    if (!(v > minValue)) continue;
    if (!hit || v > hit.value) hit = { strike: r.strike, value: v };
  }
  return hit;
}
function worst(rows, pick) { // most negative dOI (largest unwinding); only values < 0 count
  let hit = null;
  for (const r of rows) {
    const v = pick(r);
    if (v === null || v === undefined || !(v < 0)) continue;
    if (!hit || v < hit.value) hit = { strike: r.strike, value: v };
  }
  return hit;
}

// OI walls on one side of spot.
//   side 'call' -> resistance: strikes at or above spot.   side 'put' -> support: strikes at or below spot.
// A wall must be >= `share` of the largest OI on that side and a local peak among its neighbours on that same side.
export function findWalls(rows, spot, side, { share = WALL_SHARE, max = MAX_WALLS } = {}) {
  if (typeof spot !== 'number' || !Number.isFinite(spot) || spot <= 0) return [];
  const key = side === 'put' ? 'put' : 'call';
  const valid = rows.filter((r) => r[key].oi !== null);              // strikes with a real OI, ascending
  const onSide = valid.filter((r) => (key === 'call' ? r.strike >= spot : r.strike <= spot));
  const top = onSide.reduce((m, r) => Math.max(m, r[key].oi), 0);
  if (!(top > 0)) return [];
  const sideTotal = onSide.reduce((s, r) => s + r[key].oi, 0);
  const walls = [];
  for (let i = 0; i < onSide.length; i++) {                           // neighbours are judged within the same side of spot
    const r = onSide[i], oi = r[key].oi;
    if (oi < share * top) continue;
    const left = i > 0 ? onSide[i - 1][key].oi : -Infinity, right = i < onSide.length - 1 ? onSide[i + 1][key].oi : -Infinity;
    if (oi < left || oi < right) continue;                            // still climbing: the peak is a neighbour
    walls.push({
      strike: r.strike, oi, prevOi: r[key].prevOi, delta: r[key].delta,
      pctOfMax: (oi / top) * 100, shareOfSide: sideTotal > 0 ? (oi / sideTotal) * 100 : null,
      distance: key === 'call' ? r.strike - spot : spot - r.strike,
    });
  }
  walls.sort((a, b) => b.oi - a.oi || a.strike - b.strike);
  return walls.slice(0, max);
}

// ---------------------------------------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------------------------------------
// analyzeOi({ rows, expiry, chainExpiry, spot })
//   rows         parsed chain rows (src/chain.js parseChain / verifyAgainstContracts output)
//   expiry       the SELECTED expiry 'YYYY-MM-DD'
//   chainExpiry  the expiry the stored chain was fetched for
//   spot         latest valid NIFTY price (chain.js validSpot) or null: needed only for the OI walls
// Shared one-expiry guard (also used by the PCR / IV / Greeks analysis): null when the chain may be analysed,
// otherwise the OI_REASON why not. Never filters rows: a chain with a foreign row is refused as a whole.
export function checkChain({ rows, expiry, chainExpiry } = {}) {
  const exp = normExpiry(expiry);
  if (!exp) return OI_REASON.NO_EXPIRY;
  if (!Array.isArray(rows) || !rows.length) return OI_REASON.NO_CHAIN;
  if (chainExpiry !== exp) return OI_REASON.EXPIRY_MISMATCH;
  if (rows.some((r) => !r || r.expiry !== exp)) return OI_REASON.MIXED_EXPIRY;
  return null;
}
export const chainReasonText = (reason) => OI_TEXT[reason] || null;

export function analyzeOi({ rows, expiry, chainExpiry, spot } = {}) {
  const fail = (reason) => ({ ok: false, reason, text: OI_TEXT[reason], expiry: expiry || null });
  const bad = checkChain({ rows, expiry, chainExpiry });
  if (bad) return fail(bad);
  const exp = normExpiry(expiry);

  const list = rows
    .filter((r) => typeof r.strike === 'number' && Number.isFinite(r.strike) && r.strike > 0)
    .slice().sort((a, b) => a.strike - b.strike);
  const out = list.map((r) => ({ strike: r.strike, call: oiOf(r.call), put: oiOf(r.put) }));

  const count = (side, issue) => out.filter((r) => r[side].issue === issue).length;
  const quality = {
    strikes: out.length,
    callMissingOi: count('call', 'MISSING_OI'), putMissingOi: count('put', 'MISSING_OI'),
    callMissingPrev: count('call', 'MISSING_PREV_OI'), putMissingPrev: count('put', 'MISSING_PREV_OI'),
    callDeltaCount: out.filter((r) => r.call.delta !== null).length, putDeltaCount: out.filter((r) => r.put.delta !== null).length,
  };
  const anyOi = out.some((r) => r.call.oi !== null || r.put.oi !== null);
  if (!anyOi) return { ...fail(OI_REASON.NO_VALID_OI), rows: out, quality };

  const c = (r) => r.call.oi, p = (r) => r.put.oi, cd = (r) => r.call.delta, pd = (r) => r.put.delta;
  const sumOf = (side) => out.reduce((s, r) => (r[side].oi !== null ? s + r[side].oi : s), 0);
  const sumDelta = (side) => (out.some((r) => r[side].delta !== null) ? out.reduce((s, r) => (r[side].delta !== null ? s + r[side].delta : s), 0) : null);

  // Walls need spot. Without a valid price the rest of the analysis still stands, the walls are simply unavailable.
  const hasSpot = typeof spot === 'number' && Number.isFinite(spot) && spot > 0;
  const callWalls = hasSpot ? findWalls(out, spot, 'call') : [];
  const putWalls = hasSpot ? findWalls(out, spot, 'put') : [];

  const hc = best(out, c), hp = best(out, p);
  const lcd = best(out, cd), lpd = best(out, pd);
  return {
    ok: true, reason: null, text: null, expiry: exp,
    rows: out, quality,
    highestCall: hc && { strike: hc.strike, oi: hc.value },
    highestPut: hp && { strike: hp.strike, oi: hp.value },
    largestCallDelta: lcd && { strike: lcd.strike, delta: lcd.value },        // biggest CALL OI buildup (largest positive dOI)
    largestPutDelta: lpd && { strike: lpd.strike, delta: lpd.value },
    largestCallUnwind: (() => { const w = worst(out, cd); return w && { strike: w.strike, delta: w.value }; })(),
    largestPutUnwind: (() => { const w = worst(out, pd); return w && { strike: w.strike, delta: w.value }; })(),
    totals: { callOi: sumOf('call'), putOi: sumOf('put'), callDelta: sumDelta('call'), putDelta: sumDelta('put') },
    spot: hasSpot ? spot : null,
    wallsAvailable: hasSpot,
    resistance: callWalls[0] || null, callWalls,
    support: putWalls[0] || null, putWalls,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Text helpers for the UI. null is always '--'; a real 0 stays '0'.
// ---------------------------------------------------------------------------------------------------------
// Indian digit grouping (56,36,475) without Intl, so it is identical on every device / JS engine.
export function fmtInt(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '--';
  const neg = v < 0; const s = String(Math.round(Math.abs(v)));
  const head = s.length > 3 ? s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + s.slice(-3) : s;
  return (neg ? '-' : '') + head;
}
export const fmtDelta = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '--' : (v > 0 ? '+' : '') + fmtInt(v));
