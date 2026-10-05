// PCR, IV and option Greeks (Part 6). Pure functions: no network, no clock reads, no UI.
//
// Input is the parsed option chain of ONE expiry (src/chain.js). Every number is derived from the real Upstox
// market_data.oi and option_greeks.{iv, delta, gamma, theta, vega, pop}. Nothing is invented:
//   - a missing Greek / IV / OI is null and shows "--"; it is never 0 and never copied from another field;
//   - an IV of 0 or below is Upstox's "no IV" and is treated as missing;
//   - a change over time needs real history: until it exists the answer is COLLECTING HISTORY, never "0.00 FLAT";
//   - one expiry only: the chain must be for the selected expiry (src/oi.js checkChain) and history never crosses expiries.
import { findAtm } from './chain';
import { checkChain, chainReasonText } from './oi';

// ---------------------------------------------------------------------------------------------------------
// Definitions (all in one place so the UI labels can quote them)
// ---------------------------------------------------------------------------------------------------------
export const NEAR_STRIKES = 5;                 // near-ATM PCR = ATM +/- 5 strikes of the chain (11 strikes when the chain is wide enough)
export const WINDOW_MS = 5 * 60000;            // "5-minute" change
export const WINDOW_MIN_MS = 4 * 60000;        // the reference sample must be 4 .. 7 minutes old; the one closest to 5 min wins
export const WINDOW_MAX_MS = 7 * 60000;
export const SAMPLE_GAP_MS = 15000;            // at most one history sample per 15 s
export const HISTORY_MAX_AGE_MS = 40 * 60000;  // rolling: older samples are dropped
export const IV_MAP_STRIKES = 5;               // IV is remembered for ATM +/- 5 strikes so the change is measured on the same strike
export const PCR_FLAT = 0.02;                  // |PCR change| below this is FLAT
export const IV_STABLE_PCT = 3;                // |IV change| below 3 % (relative) is STABLE

export const HIST = { READY: 'READY', COLLECTING: 'COLLECTING_HISTORY', UNAVAILABLE: 'UNAVAILABLE' };
export const COLLECTING_TEXT = 'COLLECTING HISTORY';

const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);   // OI: 0 is real
const ivOf = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);     // IV <= 0 = no IV
const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ---------------------------------------------------------------------------------------------------------
// PCR = PUT OI / CALL OI
// ---------------------------------------------------------------------------------------------------------
// Only strikes where BOTH the CALL and the PUT OI are valid are counted, so one missing leg cannot tilt the ratio.
export function pcrOf(rows) {
  let putOi = 0, callOi = 0, strikes = 0;
  for (const r of rows) {
    const c = count(r.call && r.call.oi), p = count(r.put && r.put.oi);
    if (c === null || p === null) continue;
    callOi += c; putOi += p; strikes += 1;
  }
  return { value: strikes > 0 && callOi > 0 ? putOi / callOi : null, putOi, callOi, strikes };
}

export function computePcr(rows, spot, n = NEAR_STRIKES) {
  const total = { ...pcrOf(rows), label: 'Total PCR', range: 'all strikes returned for this expiry', rows: rows.length };
  const near = { value: null, putOi: null, callOi: null, strikes: 0, label: `Near-ATM PCR (ATM \u00b1${n} strikes)`, range: null, atmStrike: null, from: null, to: null, reason: null };
  if (typeof spot !== 'number' || !Number.isFinite(spot) || spot <= 0) near.reason = 'NO_SPOT';
  else {
    const ai = findAtm(rows, spot);
    if (ai < 0) near.reason = 'SPOT_OUTSIDE_CHAIN';
    else {
      const win = rows.slice(Math.max(0, ai - n), Math.min(rows.length - 1, ai + n) + 1);
      Object.assign(near, pcrOf(win), { atmStrike: rows[ai].strike, from: win[0].strike, to: win[win.length - 1].strike });
      near.range = `${near.from}\u2013${near.to}`;
    }
  }
  return { total, near };
}

// ---------------------------------------------------------------------------------------------------------
// IV at the ATM strike
// ---------------------------------------------------------------------------------------------------------
// ATM IV = mean of ATM CALL IV and ATM PUT IV, and only when BOTH exist. One-sided IV is not called "ATM IV".
export function ivOfRow(row) {
  const c = ivOf(row && row.call && row.call.iv), p = ivOf(row && row.put && row.put.iv);
  return { callIv: c, putIv: p, atmIv: c !== null && p !== null ? (c + p) / 2 : null, skew: c !== null && p !== null ? c - p : null };
}

// ---------------------------------------------------------------------------------------------------------
// Greeks of one option, exactly as Upstox sent them
// ---------------------------------------------------------------------------------------------------------
export function greeksOf(side) {
  const s = side || {};
  return { delta: fin(s.delta), gamma: fin(s.gamma), theta: fin(s.theta), vega: fin(s.vega), iv: ivOf(s.iv), pop: fin(s.pop) };
}

// ---------------------------------------------------------------------------------------------------------
// Rolling history
// ---------------------------------------------------------------------------------------------------------
// One sample of one chain: { t (receive time, ms), expiry, pcrTotal, pcrNear, atmStrike, ivMap }.
// ivMap[strike] = { c, p, a } for ATM +/- IV_MAP_STRIKES (values are null when Upstox sent none).
export function makeSample({ rows, expiry, spot, at } = {}) {
  if (!Array.isArray(rows) || !rows.length || !expiry || !Number.isFinite(at)) return null;
  const { total, near } = computePcr(rows, spot);
  const sample = { t: at, expiry, pcrTotal: total.value, pcrNear: near.value, atmStrike: near.atmStrike, ivMap: {} };
  if (near.atmStrike !== null) {
    const ai = findAtm(rows, spot);
    for (let i = Math.max(0, ai - IV_MAP_STRIKES); i <= Math.min(rows.length - 1, ai + IV_MAP_STRIKES); i++) {
      const v = ivOfRow(rows[i]);
      sample.ivMap[rows[i].strike] = { c: v.callIv, p: v.putIv, a: v.atmIv };
    }
  }
  return sample;
}

// Returns a NEW history array. Samples of any other expiry are dropped (history is never shared across expiries),
// old samples fall off, a sample closer than SAMPLE_GAP_MS to the last one is skipped, and a sample older than the
// last one (clock went backwards) is ignored.
export function pushSample(history, sample, { gapMs = SAMPLE_GAP_MS, maxAgeMs = HISTORY_MAX_AGE_MS } = {}) {
  const base = Array.isArray(history) ? history : [];
  if (!sample || !Number.isFinite(sample.t)) return base;
  const kept = base.filter((h) => h.expiry === sample.expiry && sample.t - h.t <= maxAgeMs);
  const last = kept[kept.length - 1];
  if (last && sample.t - last.t < gapMs) return kept;
  kept.push(sample);
  return kept;
}

// The history sample to compare with: same expiry, 4..7 minutes older than `at`, the one closest to 5 minutes.
// `spanMs` = how much history exists for this expiry (for the "collecting" progress text).
export function findReference(history, expiry, at) {
  const list = (Array.isArray(history) ? history : []).filter((h) => h.expiry === expiry && Number.isFinite(h.t) && h.t <= at);
  const spanMs = list.length ? at - list[0].t : 0;
  let ref = null, bd = Infinity;
  for (const h of list) {
    const age = at - h.t;
    if (age < WINDOW_MIN_MS || age > WINDOW_MAX_MS) continue;
    const d = Math.abs(age - WINDOW_MS);
    if (d < bd) { bd = d; ref = h; }
  }
  return { ref, ageMs: ref ? at - ref.t : null, spanMs, samples: list.length };
}

const collecting = (spanMs) => ({ status: HIST.COLLECTING, text: COLLECTING_TEXT, collectedMs: spanMs, neededMs: WINDOW_MS });
const unavailable = (reason) => ({ status: HIST.UNAVAILABLE, text: 'UNAVAILABLE', reason });

// Change of one value over ~5 minutes. Never returns a number unless BOTH the current and the old value are real.
export function changeOf(cur, old, found) {
  if (cur === null || cur === undefined) return unavailable('NO_CURRENT_VALUE');
  if (!found || !found.ref) return collecting(found ? found.spanMs : 0);
  if (old === null || old === undefined) return unavailable('NO_REFERENCE_VALUE');
  const abs = cur - old;
  return { status: HIST.READY, abs, pct: old > 0 ? (abs / old) * 100 : null, ageMs: found.ageMs, from: old, to: cur };
}

export function pcrTrend(abs) { return abs > PCR_FLAT ? 'RISING' : abs < -PCR_FLAT ? 'FALLING' : 'FLAT'; }
export function ivState(pct) { return pct === null || pct === undefined ? null : pct > IV_STABLE_PCT ? 'EXPANDING' : pct < -IV_STABLE_PCT ? 'CONTRACTING' : 'STABLE'; }

// ---------------------------------------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------------------------------------
// analyzePcrIv({ rows, expiry, chainExpiry, spot, history, at })
//   rows / expiry / chainExpiry  as in analyzeOi (the SELECTED expiry; anything else is refused)
//   spot     latest valid NIFTY price (chain.js validSpot) or null: ATM, near-ATM PCR and IV/Greeks need it
//   history  array kept with pushSample; `at` = receive time of `rows` (the "now" of the comparison)
export function analyzePcrIv({ rows, expiry, chainExpiry, spot, history, at } = {}) {
  const bad = checkChain({ rows, expiry, chainExpiry });
  if (bad) return { ok: false, reason: bad, text: chainReasonText(bad), expiry: expiry || null };

  const { total, near } = computePcr(rows, spot);
  const found = findReference(history, expiry, at);
  const refPcrTotal = found.ref ? found.ref.pcrTotal : null, refPcrNear = found.ref ? found.ref.pcrNear : null;
  const withTrend = (c) => (c.status === HIST.READY ? { ...c, trend: pcrTrend(c.abs) } : c);

  const pcr = {
    total, near,
    totalChange: withTrend(changeOf(total.value, refPcrTotal, found)),
    nearChange: withTrend(changeOf(near.value, refPcrNear, found)),
  };

  // ---- ATM, IV, Greeks
  const ai = typeof spot === 'number' && Number.isFinite(spot) && spot > 0 ? findAtm(rows, spot) : -1;
  const atmReason = ai >= 0 ? null : (typeof spot === 'number' && Number.isFinite(spot) && spot > 0 ? 'SPOT_OUTSIDE_CHAIN' : 'NO_SPOT');
  let iv = { atmStrike: null, reason: atmReason, callIv: null, putIv: null, atmIv: null, skew: null, change: unavailable(atmReason || 'NO_ATM'), callChange: unavailable('NO_ATM'), putChange: unavailable('NO_ATM') };
  let greeks = { strike: null, reason: atmReason, call: greeksOf(null), put: greeksOf(null) };
  if (ai >= 0) {
    const row = rows[ai];
    const cur = ivOfRow(row);
    const old = found.ref && found.ref.ivMap ? found.ref.ivMap[row.strike] : undefined;   // SAME strike, 5 min ago
    const pick = (k) => (old ? old[k] : null);
    const mk = (curV, k) => (found.ref && !old ? unavailable('ATM_STRIKE_NOT_IN_HISTORY') : changeOf(curV, pick(k), found));
    const change = mk(cur.atmIv, 'a');
    iv = {
      atmStrike: row.strike, reason: null, ...cur,
      change: change.status === HIST.READY ? { ...change, state: ivState(change.pct) } : change,
      callChange: mk(cur.callIv, 'c'), putChange: mk(cur.putIv, 'p'),
    };
    greeks = { strike: row.strike, reason: null, call: greeksOf(row.call), put: greeksOf(row.put) };
  }
  return { ok: true, reason: null, text: null, expiry, pcr, iv, greeks, history: { samples: found.samples, spanMs: found.spanMs, windowMs: WINDOW_MS } };
}

// ---------------------------------------------------------------------------------------------------------
// Text helpers: null is always "--", a real 0 stays "0.00".
// ---------------------------------------------------------------------------------------------------------
export const fixed = (v, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '--');
export const signedFixed = (v, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? (v > 0 ? '+' : '') + v.toFixed(d) : '--');
export const GREEK_DIGITS = { delta: 3, gamma: 5, theta: 2, vega: 2, iv: 2, pop: 1 };
export const fmtGreek = (name, v) => fixed(v, GREEK_DIGITS[name] === undefined ? 2 : GREEK_DIGITS[name]);

export function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--';
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}
// 'COLLECTING HISTORY (2m 10s of 5m)' for a collecting change, 'UNAVAILABLE' for an unavailable one, otherwise null.
export function historyText(change) {
  if (!change) return 'UNAVAILABLE';
  if (change.status === HIST.COLLECTING) return `${COLLECTING_TEXT} (${fmtDur(change.collectedMs)} of ${fmtDur(change.neededMs)})`;
  if (change.status === HIST.UNAVAILABLE) return 'UNAVAILABLE';
  return null;
}
