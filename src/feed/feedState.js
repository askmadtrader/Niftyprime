// Pure reducer: folds decoded FeedResponse frames into the app's market-data state. No I/O, fully unit-testable.
import { deriveMarketState } from './marketStatus';
import { validTs } from './session';
import { istDate } from '../util';

export const NIFTY_KEY = 'NSE_INDEX|Nifty 50';
export const VIX_KEY = 'NSE_INDEX|India VIX';
export const WATCH_KEYS = [NIFTY_KEY, VIX_KEY];

const MAX_CLOCK_OFFSET_MS = 6 * 3600 * 1000; // an offset larger than this means currentTs is garbage; ignore it

export function initialFeedState() {
  return {
    marketInfo: null, marketInfoAt: 0, marketInfoServerTs: 0, market: deriveMarketState(null),
    clockOffset: 0, clockSynced: false, serverTs: 0, lastMessageAt: 0,
    instruments: {}, messages: 0, decodeErrors: 0, invalidTicks: 0,
  };
}

const posNum = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

// Build the quote for one instrument from its ltpc (+ optional day OHLC). Returns null if the price is unusable.
export function buildInstrument(key, f, prev, receivedAt, serverTs) {
  const l = f && f.ltpc;
  if (!l || !posNum(l.ltp)) return null;
  const cp = posNum(l.cp) ? l.cp : null; // previous close; 0/absent => unknown, never assumed
  const change = cp !== null ? l.ltp - cp : null;
  const day = (f.ohlc || []).find((o) => o && String(o.interval).toLowerCase() === '1d') || null;
  const tsOk = validTs(l.ltt);
  const tradingDate = tsOk ? istDate(l.ltt) : null;     // IST trading date of the exchange timestamp
  // Day open/high/low are used ONLY when the 1d candle belongs to the same trading date as this tick. Upstox may
  // return the previous day's candle (docs: "a single candle representing the previous day"); that must never be
  // shown as today's range. A carried value from an earlier tick is kept only within the same trading date.
  const dayOk = !!day && tsOk && posNum(day.high) && posNum(day.low) && validTs(day.ts) && istDate(day.ts) === tradingDate;
  const keep = prev && prev.tradingDate && prev.tradingDate === tradingDate ? prev : null;
  return {
    key, ltp: l.ltp, cp, prev: cp, change, pct: cp !== null ? (change / cp) * 100 : null,
    ltt: tsOk ? l.ltt : null,                    // exchange "last traded time" (ms epoch); null when missing/invalid
    marketTs: tsOk ? l.ltt : null,               // alias: every value carries marketTs + receivedAt + tradingDate
    tradingDate, tsValid: tsOk,
    receivedAt, serverTs: serverTs || null,
    open: dayOk && posNum(day.open) ? day.open : (keep ? keep.open : null),
    high: dayOk ? day.high : (keep ? keep.high : null),
    low: dayOk ? day.low : (keep ? keep.low : null),
    dayTs: dayOk ? day.ts : (keep ? keep.dayTs : null),
    volume: null, ticks: (prev ? prev.ticks : 0) + 1,
  };
}

export function applyFeedResponse(state, resp, receivedAt) {
  const next = { ...state, instruments: { ...state.instruments }, messages: state.messages + 1, lastMessageAt: receivedAt };
  if (validTs(resp.currentTs)) {
    const off = resp.currentTs - receivedAt;
    next.serverTs = resp.currentTs;
    if (Math.abs(off) <= MAX_CLOCK_OFFSET_MS) { next.clockOffset = off; next.clockSynced = true; }
  }
  if (resp.type === 'market_info' || resp.marketInfo) {
    if (resp.marketInfo) {
      next.marketInfo = resp.marketInfo; next.marketInfoAt = receivedAt; next.marketInfoServerTs = resp.currentTs || 0;
      next.market = deriveMarketState(resp.marketInfo);
    }
  }
  Object.keys(resp.feeds || {}).forEach((key) => {
    if (!WATCH_KEYS.includes(key)) return;
    const inst = buildInstrument(key, resp.feeds[key], state.instruments[key], receivedAt, resp.currentTs);
    if (inst) next.instruments[key] = inst; else next.invalidTicks += 1;
  });
  return next;
}

// Exchange-aligned "now": device clock corrected by the offset learned from the feed's currentTs.
export const serverNow = (state, deviceNow = Date.now()) => deviceNow + (state.clockSynced ? state.clockOffset : 0);
