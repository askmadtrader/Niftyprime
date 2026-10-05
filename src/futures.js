// NIFTY futures (current / next month) from Upstox. Real contracts only: nothing is guessed or derived from the index.
// Source: GET /v2/instruments/search?query=NIFTY&exchanges=NSE&segments=FO&instrument_types=FUT&expiry=current_month|next_month
import { NIFTY_KEY } from './feed/feedState';

const EXPIRY_CLOSE_MIN = 15 * 60 + 30; // futures stop trading 15:30 IST on expiry day
const IST_MS = 330 * 60000;

// 'YYYY-MM-DD' -> epoch ms of 15:30 IST that day, or null
export function expiryEndMs(d) {
  const m = typeof d === 'string' && d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], 0, EXPIRY_CLOSE_MIN, 0) - IST_MS;
  return Number.isFinite(t) ? t : null;
}

// Keeps only genuine NIFTY 50 index futures that have not expired; returns the nearest one, or null.
export function pickNiftyFuture(rows, nowMs) {
  const ok = (Array.isArray(rows) ? rows : []).filter((r) => r
    && r.instrument_type === 'FUT' && r.segment === 'NSE_FO'
    && typeof r.instrument_key === 'string' && r.instrument_key.startsWith('NSE_FO|')
    && (r.underlying_key === NIFTY_KEY || (!r.underlying_key && r.underlying_symbol === 'NIFTY'))
    && expiryEndMs(r.expiry) !== null && expiryEndMs(r.expiry) > nowMs);
  if (!ok.length) return null;
  ok.sort((a, b) => expiryEndMs(a.expiry) - expiryEndMs(b.expiry));
  const r = ok[0];
  return { key: r.instrument_key, tradingSymbol: r.trading_symbol || 'NIFTY FUT', expiry: r.expiry, lotSize: Number(r.lot_size) > 0 ? Number(r.lot_size) : null };
}

// Futures premium over the index (points and %). Both prices must be valid; never 0-filled.
export function basis(futPrice, spot) {
  const ok = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  if (!ok(futPrice) || !ok(spot)) return null;
  const pts = futPrice - spot;
  return { pts, pct: (pts / spot) * 100 };
}
