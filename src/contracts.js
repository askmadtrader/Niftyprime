// NIFTY option-contract discovery (Part 3). Pure functions only: no network, no clock reads except through `nowMs`.
//
// Source of truth: Upstox "Get Option Contracts" (GET /v2/option/contract?instrument_key=NSE_INDEX|Nifty 50).
// Every contract here was returned by Upstox. Nothing is generated, guessed or filled in:
//   - a row that fails validation is DROPPED (and counted), never repaired;
//   - a CE with no matching PE (or vice versa) is reported as an incomplete pair, never completed with a fake leg;
//   - weekly/monthly is only reported when Upstox sends the `weekly` flag.
import { istDate, ist, daysTo, fmtDMY, num } from './util';

// NSE index options stop trading at 15:30 IST on the expiry date. From that minute the expiry is over.
export const EXPIRY_CUTOFF_MIN = 15 * 60 + 30;

export const OPT = { CE: 'CE', PE: 'PE' };
export const KIND = { WEEKLY: 'WEEKLY', MONTHLY: 'MONTHLY' };

// Upstox sends 'YYYY-MM-DD'. Anything else (including an impossible calendar date) is rejected.
export function normExpiry(e) {
  if (typeof e !== 'string') return null;
  const m = e.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return e;
}

// One raw Upstox row -> contract model, or null when the row is not a usable contract.
//   instrumentKey  <- instrument_key        tradingSymbol <- trading_symbol      expiry <- expiry ('YYYY-MM-DD')
//   strike         <- strike_price          type          <- instrument_type ('CE' | 'PE')
//   lotSize        <- lot_size              tickSize      <- tick_size
//   weekly         <- weekly (true | false | null when Upstox did not send it)
//   kind           <- 'WEEKLY' | 'MONTHLY' | null (derived from `weekly` only)
export function toContract(r, underlyingKey) {
  if (!r || typeof r !== 'object') return null;
  const instrumentKey = typeof r.instrument_key === 'string' ? r.instrument_key.trim() : '';
  const tradingSymbol = typeof r.trading_symbol === 'string' ? r.trading_symbol.trim() : '';
  const expiry = normExpiry(r.expiry);
  const strike = num(r.strike_price);
  const type = r.instrument_type === OPT.CE || r.instrument_type === OPT.PE ? r.instrument_type : null;
  const lotSize = num(r.lot_size);
  const tickSize = num(r.tick_size);
  if (!instrumentKey || !tradingSymbol || !expiry || !type) return null;
  if (strike === null || strike <= 0 || lotSize === null || lotSize <= 0 || tickSize === null || tickSize <= 0) return null;
  // Guard against other underlyings sneaking into the list (e.g. a different index with the same prefix).
  if (underlyingKey && r.underlying_key && r.underlying_key !== underlyingKey) return null;
  const weekly = typeof r.weekly === 'boolean' ? r.weekly : null;
  return {
    instrumentKey, tradingSymbol, expiry, strike, type, lotSize, tickSize,
    weekly, kind: weekly === null ? null : weekly ? KIND.WEEKLY : KIND.MONTHLY,
  };
}

// Raw `data` array -> { contracts, rejected }. Duplicates (same instrument_key) are kept once.
export function parseContracts(data, underlyingKey) {
  const rows = Array.isArray(data) ? data : [];
  const seen = new Set(); const contracts = []; let rejected = 0;
  for (const r of rows) {
    const c = toContract(r, underlyingKey);
    if (!c) { rejected += 1; continue; }
    if (seen.has(c.instrumentKey)) continue;
    seen.add(c.instrumentKey); contracts.push(c);
  }
  contracts.sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : a.strike - b.strike || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0)));
  return { contracts, rejected };
}

// An expiry is over once its date is in the past, or once it is the expiry date and 15:30 IST has passed.
export function isExpired(expiry, nowMs = Date.now()) {
  const e = normExpiry(expiry);
  if (!e) return true; // an unreadable date is never a "valid future expiry"
  const today = istDate(nowMs);
  if (e < today) return true;
  if (e > today) return false;
  const t = ist(nowMs);
  return t.h * 60 + t.mi >= EXPIRY_CUTOFF_MIN;
}

// Distinct expiries found in the contracts: chronological, expired ones removed.
export function validExpiries(contracts, nowMs = Date.now()) {
  const set = new Set();
  (Array.isArray(contracts) ? contracts : []).forEach((c) => { if (c && !isExpired(c.expiry, nowMs)) set.add(c.expiry); });
  return Array.from(set).sort();
}

// Nearest valid future expiry from a list of date strings (or null when none is valid).
export function nearestExpiry(expiries, nowMs = Date.now()) {
  const v = (Array.isArray(expiries) ? expiries : []).filter((e) => !isExpired(e, nowMs)).sort();
  return v.length ? v[0] : null;
}

// Which expiry to use: keep the current one while it is still valid and still listed by Upstox,
// otherwise move to the nearest valid one (this is the automatic roll after expiry).
export function pickExpiry(current, expiries, nowMs = Date.now()) {
  const list = (Array.isArray(expiries) ? expiries : []).filter((e) => !isExpired(e, nowMs));
  if (current && list.includes(current)) return current;
  return nearestExpiry(list, nowMs);
}

// Weekly/monthly for one expiry, only if every contract on it agrees (null otherwise, never guessed).
export function expiryKind(contracts, expiry) {
  const kinds = new Set();
  (contracts || []).forEach((c) => { if (c.expiry === expiry) kinds.add(c.kind); });
  return kinds.size === 1 ? Array.from(kinds)[0] : null;
}

// Display model for an expiry: { date: 'DD-MMM-YYYY', days, text }.
export function describeExpiry(expiry, nowMs = Date.now()) {
  const e = normExpiry(expiry);
  if (!e) return null;
  const days = daysTo(e, nowMs);
  const date = fmtDMY(e);
  const left = days === 0 ? 'expires TODAY' : `${days} day${days === 1 ? '' : 's'} remaining`;
  return { expiry: e, date, days, text: `${date}  \u00b7  ${left}` };
}

// Pair CE and PE by (same expiry, same strike). Result is sorted by expiry then strike.
//   { expiry, strike, ce, pe, complete }   ce / pe are real contracts or null (never fabricated)
export function pairContracts(contracts) {
  const m = new Map();
  for (const c of Array.isArray(contracts) ? contracts : []) {
    if (!c) continue;
    const k = `${c.expiry}|${c.strike}`;
    let p = m.get(k);
    if (!p) { p = { expiry: c.expiry, strike: c.strike, ce: null, pe: null, complete: false }; m.set(k, p); }
    if (c.type === OPT.CE) p.ce = c; else if (c.type === OPT.PE) p.pe = c;
  }
  const out = Array.from(m.values());
  out.forEach((p) => { p.complete = !!(p.ce && p.pe); });
  return out.sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : a.strike - b.strike));
}

// Pairs for one expiry (only complete CE+PE pairs unless includeIncomplete).
export function pairsForExpiry(contracts, expiry, includeIncomplete = false) {
  return pairContracts((contracts || []).filter((c) => c.expiry === expiry)).filter((p) => includeIncomplete || p.complete);
}
