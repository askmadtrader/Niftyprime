import { num, istDate } from './util';
import { parseContracts } from './contracts';
import { parseChain } from './chain';
import { mergeCandles, TF_CONFIG } from './chartmath';

const BASE = 'https://api.upstox.com';
import { NIFTY_KEY, VIX_KEY } from './feed/feedState';
export { NIFTY_KEY, VIX_KEY };

export class ApiError extends Error {
  constructor(kind, msg, status) { super(msg); this.kind = kind; this.status = status; }
}

export async function upstox(path, token, params) {
  let url = BASE + path;
  if (params) url += '?' + Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 12000);
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json', Authorization: 'Bearer ' + token }, signal: ctl.signal });
  } catch (e) {
    throw new ApiError('NETWORK', 'Network error: ' + (e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || 'unknown'));
  } finally { clearTimeout(to); }
  let j = null;
  try { j = await res.json(); } catch (e) { j = null; }
  if (res.status === 401 || res.status === 403) throw new ApiError('AUTH', 'Session expired or invalid. Login again.', res.status);
  if (res.status === 429) throw new ApiError('RATE', 'Rate limited by Upstox. Slowing down.', 429);
  if (!res.ok) {
    const m = j && j.errors && j.errors[0] && j.errors[0].message;
    throw new ApiError('SERVER', m || `Upstox API error ${res.status}`, res.status);
  }
  if (!j || j.status !== 'success') throw new ApiError('DATA', 'Malformed response from Upstox');
  return j.data;
}

// Live NIFTY / India VIX quotes come ONLY from the Upstox Market Data Feed V3 WebSocket (src/feed/*).
// Returns the single-use wss:// URL for the feed. The URL carries a one-time code: never log it.
export async function authorizeFeed(token) {
  let data;
  try {
    data = await upstox('/v3/feed/market-data-feed/authorize', token);
  } catch (e) {
    // 401 = invalid/expired token (stop retrying, ask for login). 403 = access refused for another reason (app
    // permission, plan, proxy): retry with backoff and say so, but never delete a possibly valid session token.
    if (e instanceof ApiError && e.status === 403) {
      throw new ApiError('FORBIDDEN', 'Upstox refused the live-feed request (403). Check Market Data Feed access for this app. Retrying.', 403);
    }
    throw e;
  }
  const url = data && (data.authorized_redirect_uri || data.authorizedRedirectUri);
  if (typeof url !== 'string' || !/^wss:\/\//i.test(url)) throw new ApiError('DATA', 'Feed authorization returned no WebSocket URL');
  return url;
}

function parseCandles(arr) {
  return (Array.isArray(arr) ? arr : []).map((c) => ({
    t: Date.parse(c[0]), o: num(c[1]), h: num(c[2]), l: num(c[3]), c: num(c[4]), v: num(c[5]) || 0,
  })).filter((c) => Number.isFinite(c.t) && c.o !== null && c.h !== null && c.l !== null && c.c !== null)
    .sort((a, b) => a.t - b.t);
}

// Today's intraday candles; if none (closed/holiday/pre-open) fall back to the last available session.
export async function fetchCandles(token, key, interval) {
  const k = encodeURIComponent(key);
  let live = [];
  try {
    const d = await upstox(`/v3/historical-candle/intraday/${k}/minutes/${interval}`, token);
    live = parseCandles(d && d.candles);
  } catch (e) {
    if (e.kind === 'AUTH' || e.kind === 'RATE' || e.kind === 'NETWORK') throw e;
    live = [];
  }
  if (live.length) return { candles: live, fromHistory: false };
  const now = Date.now();
  const d = await upstox(`/v3/historical-candle/${k}/minutes/${interval}/${istDate(now)}/${istDate(now - 8 * 86400000)}`, token);
  const all = parseCandles(d && d.candles);
  if (!all.length) return { candles: [], fromHistory: true };
  const day = istDate(all[all.length - 1].t);
  return { candles: all.filter((c) => istDate(c.t) === day), fromHistory: true };
}

// All live NIFTY option contracts from Upstox (every listed expiry, CE and PE). Validated rows only; see contracts.js.
// Returns { contracts, rejected }. An empty list is returned as-is: the caller must treat it as "no data", never invent contracts.
export async function fetchContracts(token) {
  const data = await upstox('/v2/option/contract', token, { instrument_key: NIFTY_KEY });
  return parseContracts(data, NIFTY_KEY);
}

// NIFTY futures contracts (current + next month). Parsing/selection lives in futures.js.
export async function fetchNiftyFutures(token) {
  const out = [];
  for (const expiry of ['current_month', 'next_month']) {
    const rows = await upstox('/v2/instruments/search', token, { query: 'NIFTY', exchanges: 'NSE', segments: 'FO', instrument_types: 'FUT', expiry, page_number: 1, records: 30 });
    if (Array.isArray(rows)) out.push(...rows);
  }
  return out;
}

// The real option chain of ONE expiry (GET /v2/option/chain). Returns { rows, rejected, otherExpiry, duplicates }; every row
// carries the requested expiry. Parsing and validation live in chain.js.
export async function fetchChain(token, expiry) {
  const data = await upstox('/v2/option/chain', token, { instrument_key: NIFTY_KEY, expiry_date: expiry });
  return parseChain(data, expiry, NIFTY_KEY);
}

// ---------------------------------------------------------------------------------------------------------
// Chart history (Part 8). Separate from fetchCandles(), which feeds the signal engine and is left untouched.
// Intraday (today) + historical (previous sessions, fetched in chunks that respect Upstox's per-request range limit),
// merged by candle timestamp. A failed history chunk is reported as `partial`, never filled in.
// ---------------------------------------------------------------------------------------------------------
const dayShift = (now, n) => istDate(now - n * 86400000);
const FATAL = new Set(['AUTH', 'RATE', 'NETWORK']);

function chartPath(k, cfg) { return `${k}/${cfg.unit}/${cfg.interval}`; }

// Today's candles only (used by the 15 s refresh).
export async function fetchChartIntraday(token, key, tf) {
  const cfg = TF_CONFIG[tf]; if (!cfg) throw new ApiError('DATA', 'Unsupported chart timeframe');
  try {
    const d = await upstox(`/v3/historical-candle/intraday/${chartPath(encodeURIComponent(key), cfg)}`, token);
    return parseCandles(d && d.candles);
  } catch (e) {
    if (e && FATAL.has(e.kind)) throw e;
    return [];
  }
}

// Full chart history for one timeframe: { candles, partial, errors }.
export async function fetchChartCandles(token, key, tf, now = Date.now()) {
  const cfg = TF_CONFIG[tf]; if (!cfg) throw new ApiError('DATA', 'Unsupported chart timeframe');
  const k = encodeURIComponent(key);
  const ranges = [];
  for (let off = 0; off < cfg.lookbackDays; off += cfg.chunkDays) {
    const to = dayShift(now, off), from = dayShift(now, Math.min(off + cfg.chunkDays - 1, cfg.lookbackDays - 1));
    ranges.push([to, from]);
  }
  const jobs = [
    fetchChartIntraday(token, key, tf).then((c) => ({ ok: true, c })),
    ...ranges.map(([to, from]) => upstox(`/v3/historical-candle/${chartPath(k, cfg)}/${to}/${from}`, token)
      .then((d) => ({ ok: true, c: parseCandles(d && d.candles) }))),
  ].map((p) => p.catch((e) => ({ ok: false, e })));
  const res = await Promise.all(jobs);
  const fatal = res.find((r) => !r.ok && r.e && FATAL.has(r.e.kind));
  if (fatal) throw fatal.e;
  const failed = res.filter((r) => !r.ok);
  const candles = mergeCandles(...res.slice(1).filter((r) => r.ok).map((r) => r.c), res[0].ok ? res[0].c : []); // intraday last => wins on duplicates
  if (!candles.length && failed.length) throw failed[0].e;
  return { candles, partial: failed.length > 0, errors: failed.map((r) => (r.e && r.e.message) || 'error') };
}
