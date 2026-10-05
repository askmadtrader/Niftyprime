// Basic live NIFTY option chain (Part 4). Pure functions: no network, no clock reads, no UI.
//
// Source: Upstox Put/Call Option Chain, GET /v2/option/chain?instrument_key=NSE_INDEX|Nifty 50&expiry_date=YYYY-MM-DD.
// Rules this module enforces:
//   - one chain = ONE expiry. Rows that belong to another expiry are dropped, never merged in.
//   - a missing value stays null (shown as "--"). It is never turned into 0, never copied from another field.
//   - ATM comes from the latest valid NIFTY price of the existing live feed (src/feed). The chain's own
//     underlying_spot_price is kept on the row but is never used for ATM.
import { num, f2, compact } from './util';
import { normExpiry } from './contracts';
import { FRESH } from './feed/freshness';
import { SESSION } from './feed/session';

export const DEFAULT_STRIKES = 10;
export const MAX_STRIKES = 30;

// ---------------------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------------------
const nonNeg = (v) => { const n = num(v); return n !== null && n >= 0 ? n : null; };   // OI, volume, quantities: 0 is a real value
const price = (v) => { const n = num(v); return n !== null && n > 0 ? n : null; };      // LTP: a 0 / negative price is "no price", not a price

// One side (call_options / put_options) of a chain row. Everything Upstox did not send stays null.
//   key / instrumentKey   instrument_key            ltp    market_data.ltp           oi     market_data.oi
//   vol                   market_data.volume        prevOi market_data.prev_oi       bid / ask  bid_price / ask_price
//   bidQty / askQty       bid_qty / ask_qty         close  close_price               iv, delta, theta, gamma, vega, pop  option_greeks
// (`key` is the name the analysis engine already uses; `instrumentKey` is the same value under its documented name.)
export function parseSide(o) {
  const m = (o && o.market_data) || {};
  const g = (o && o.option_greeks) || {};
  const key = o && typeof o.instrument_key === 'string' && o.instrument_key.trim() ? o.instrument_key.trim() : null;
  return {
    key, instrumentKey: key,
    ltp: price(m.ltp), vol: nonNeg(m.volume), oi: nonNeg(m.oi), prevOi: nonNeg(m.prev_oi),
    bid: nonNeg(m.bid_price), ask: nonNeg(m.ask_price), bidQty: nonNeg(m.bid_qty), askQty: nonNeg(m.ask_qty), close: num(m.close_price),
    iv: num(g.iv), delta: num(g.delta), theta: num(g.theta), gamma: num(g.gamma), vega: num(g.vega), pop: num(g.pop),
  };
}

// Raw `data` array of the chain response -> { rows, rejected, otherExpiry, duplicates }.
// `expiry` is the expiry that was REQUESTED ('YYYY-MM-DD'); every kept row is guaranteed to carry it.
export function parseChain(data, expiry, underlyingKey) {
  const req = normExpiry(expiry);
  const src = Array.isArray(data) ? data : [];
  const out = { rows: [], rejected: 0, otherExpiry: 0, duplicates: 0 };
  if (!req) { out.rejected = src.length; return out; }
  const seen = new Set();
  for (const r of src) {
    if (!r || typeof r !== 'object') { out.rejected += 1; continue; }
    const strike = num(r.strike_price);
    if (strike === null || strike <= 0) { out.rejected += 1; continue; }
    if (r.expiry !== undefined && r.expiry !== null && normExpiry(r.expiry) !== req) { out.otherExpiry += 1; continue; }
    if (underlyingKey && r.underlying_key && r.underlying_key !== underlyingKey) { out.rejected += 1; continue; }
    if (seen.has(strike)) { out.duplicates += 1; continue; }
    seen.add(strike);
    out.rows.push({ expiry: req, strike, pcr: num(r.pcr), spot: num(r.underlying_spot_price), call: parseSide(r.call_options), put: parseSide(r.put_options) });
  }
  out.rows.sort((a, b) => a.strike - b.strike);
  return out;
}

// Cross-check instrument keys against the real contract list (Part 3). A key that Upstox lists under another
// expiry / strike / option type means the row is not what it claims to be: the whole row is dropped.
// Keys the contract list does not know are kept (cannot be verified); an empty contract list verifies nothing.
export function verifyAgainstContracts(rows, contracts, expiry) {
  const list = Array.isArray(rows) ? rows : [];
  if (!Array.isArray(contracts) || !contracts.length) return { rows: list, mismatched: 0 };
  const byKey = new Map(); contracts.forEach((c) => { if (c && c.instrumentKey) byKey.set(c.instrumentKey, c); });
  const ok = (side, row, type) => {
    const c = side.key ? byKey.get(side.key) : null;
    return !c || (c.expiry === expiry && c.strike === row.strike && c.type === type);
  };
  const kept = list.filter((r) => ok(r.call, r, 'CE') && ok(r.put, r, 'PE'));
  return { rows: kept, mismatched: list.length - kept.length };
}

// A chain response may only be stored if the user is still looking at the expiry it was requested for.
export const shouldAcceptChain = (requestedExpiry, currentExpiry) => !!requestedExpiry && requestedExpiry === currentExpiry;

// ---------------------------------------------------------------------------------------------------------
// ATM + strike window
// ---------------------------------------------------------------------------------------------------------
// The latest VALID NIFTY price from the live feed: positive finite LTP with a valid exchange timestamp that is not
// from the future. It may be stale (the status badge says so) but it is never invented.
export function validSpot(nifty, niftyFresh) {
  if (!nifty || !Number.isFinite(nifty.ltp) || nifty.ltp <= 0 || !nifty.tsValid) return null;
  if (niftyFresh && (niftyFresh.session === SESSION.FUTURE || niftyFresh.session === SESSION.INVALID)) return null;
  return nifty.ltp;
}

export function clampStrikes(n) {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.max(1, Math.min(MAX_STRIKES, v)) : DEFAULT_STRIKES;
}

// Median gap between neighbouring strikes (null with fewer than 2 rows).
export function strikeStep(rows) {
  if (!rows || rows.length < 2) return null;
  const d = []; for (let i = 1; i < rows.length; i++) d.push(rows[i].strike - rows[i - 1].strike);
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)];
}

// Index of the strike nearest to `spot` (ties go to the lower strike). -1 when there is no usable answer: no rows, no spot,
// or a spot more than one strike step outside the chain (the chain does not cover the market, so no row may be called ATM).
export function findAtm(rows, spot) {
  if (!rows || !rows.length || typeof spot !== 'number' || !Number.isFinite(spot) || spot <= 0) return -1;
  let best = -1, bd = Infinity;
  rows.forEach((r, i) => { const d = Math.abs(r.strike - spot); if (d < bd) { bd = d; best = i; } });
  const step = strikeStep(rows);
  if (step && (spot < rows[0].strike - step || spot > rows[rows.length - 1].strike + step)) return -1;
  return best;
}

// The strikes to display: ATM +/- n rows of the chain. Rows the chain does not have are not invented, the window just clips.
export function buildChainView(rows, spot, n) {
  const k = clampStrikes(n);
  const list = Array.isArray(rows) ? rows : [];
  const base = { rows: [], atmStrike: null, atmIndex: -1, n: k, total: list.length, clippedBelow: false, clippedAbove: false, reason: null };
  if (!list.length) return { ...base, reason: 'NO_CHAIN' };
  if (spot === null || spot === undefined) return { ...base, reason: 'NO_SPOT' };
  const ai = findAtm(list, spot);
  if (ai < 0) return { ...base, reason: 'SPOT_OUTSIDE_CHAIN' };
  const lo = Math.max(0, ai - k), hi = Math.min(list.length - 1, ai + k);
  return { ...base, rows: list.slice(lo, hi + 1), atmStrike: list[ai].strike, atmIndex: ai - lo, clippedBelow: ai - k < 0, clippedAbove: ai + k > list.length - 1 };
}

// ---------------------------------------------------------------------------------------------------------
// Status badge: LIVE | STALE | PREVIOUS SESSION | UNAVAILABLE
// ---------------------------------------------------------------------------------------------------------
export const CHAIN_STATUS = { LIVE: 'LIVE', STALE: 'STALE', PREVIOUS: 'PREVIOUS SESSION', UNAVAILABLE: 'UNAVAILABLE' };

// fresh = computeChainFreshness(...) from src/feed/freshness.js (age, connection, market phase at request time).
// The chain must belong to the SELECTED expiry, otherwise it is UNAVAILABLE no matter how new it is.
export function chainStatus({ rows, chainExpiry, expiry, fresh }) {
  const na = (reason, text) => ({ status: CHAIN_STATUS.UNAVAILABLE, reason, text });
  if (!expiry) return na('NO_EXPIRY', 'No expiry selected');
  if (!rows || !rows.length) return na('NO_CHAIN', 'Option chain not received yet');
  if (chainExpiry !== expiry) return na('EXPIRY_MISMATCH', 'Chain on screen is not for the selected expiry');
  if (!fresh || fresh.status === FRESH.UNAVAILABLE) return na('NO_CHAIN', 'Option chain not received yet');
  const age = fresh.ageMs != null ? `${Math.round(fresh.ageMs / 1000)}s ago` : '';
  if (fresh.status === FRESH.DISCONNECTED) return { status: CHAIN_STATUS.STALE, reason: 'DISCONNECTED', text: 'Connection lost: last received values' + (age ? `, ${age}` : '') };
  if (fresh.status === FRESH.STALE) {
    return { status: CHAIN_STATUS.STALE, reason: fresh.reason || 'STALE', text: fresh.reason === 'RECEIVED_BEFORE_MARKET_OPEN' ? 'Received before the market opened' : `Not refreshed${age ? ' for ' + age.replace(' ago', '') : ''}` };
  }
  if (fresh.reason === 'SNAPSHOT_MARKET_NOT_OPEN') return { status: CHAIN_STATUS.PREVIOUS, reason: fresh.reason, text: 'Market not open: last session snapshot' };
  return { status: CHAIN_STATUS.LIVE, reason: null, text: age ? `Updated ${age}` : 'Updated just now' };
}

// ---------------------------------------------------------------------------------------------------------
// Cell text. A null value is always "--"; a real 0 stays "0".
// ---------------------------------------------------------------------------------------------------------
export const cellLtp = (v) => f2(v);          // 2 decimals, '--' for null
export const cellCount = (v) => compact(v);   // OI / volume: K, L, Cr, '--' for null
export function sideCells(side) {
  const s = side || {};
  return { ltp: cellLtp(s.ltp), oi: cellCount(s.oi), vol: cellCount(s.vol) };
}
