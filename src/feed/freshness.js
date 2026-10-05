// Central freshness system. Every important source gets the same shape:
//   { status, ageMs, lastReceivedAt, lastMarketTs }
// status: LIVE | FRESH | STALE | DISCONNECTED | UNAVAILABLE
import { MS } from './marketStatus';
import { SESSION, classifyTs } from './session';
import { istDate } from '../util';

export const FRESH = { LIVE: 'LIVE', FRESH: 'FRESH', STALE: 'STALE', DISCONNECTED: 'DISCONNECTED', UNAVAILABLE: 'UNAVAILABLE' };

// Thresholds (ms). `liveMs`: LIVE if a tick arrived this recently. `freshMs`: FRESH up to here, STALE beyond.
// `marketLagMs`: max gap between the exchange timestamp (ltt) and the exchange-aligned clock while trading.
export const THRESHOLDS = {
  nifty: { liveMs: 5000, freshMs: 20000, marketLagMs: 120000 },
  vix: { liveMs: 30000, freshMs: 120000, marketLagMs: 600000 },
};

const CONNECTED_LIVE = new Set(['LIVE']);

// inst: instrument object from feedState (or undefined). conn: client state string. marketState: MS.* string.
// Every result carries the three stamps: marketTs (exchange time), receivedAt (device time) and tradingDate (IST),
// plus `session` (CURRENT | PREVIOUS | FUTURE | INVALID, judged on the exchange-aligned clock).
export function computeFreshness({ inst, conn, marketState, now, serverNow, th }) {
  const base = { status: FRESH.UNAVAILABLE, ageMs: null, lastReceivedAt: inst ? inst.receivedAt : null, lastMarketTs: inst ? inst.ltt : null,
    marketTs: null, receivedAt: inst ? inst.receivedAt : null, tradingDate: null, session: SESSION.INVALID };
  if (!inst) return base;
  const cls = inst.tsValid ? classifyTs(inst.ltt, serverNow) : { kind: SESSION.INVALID, date: null };
  const ageMs = Math.max(0, now - inst.receivedAt);
  const out = { ...base, ageMs, marketTs: inst.tsValid ? inst.ltt : null, tradingDate: cls.date, session: cls.kind };
  if (!CONNECTED_LIVE.has(conn)) { out.status = FRESH.DISCONNECTED; return out; }      // value kept for display, never presented as live
  if (!inst.tsValid || cls.kind === SESSION.INVALID) { out.status = FRESH.STALE; out.reason = 'INVALID_TIMESTAMP'; return out; }
  if (cls.kind === SESSION.FUTURE) { out.status = FRESH.STALE; out.reason = 'FUTURE_TIMESTAMP'; return out; }   // a trade "from the future" is corrupt, never LIVE
  if (marketState !== MS.OPEN && marketState !== MS.UNKNOWN) {
    // No ticks are expected outside trading. A value received on this connection is the exchange's latest.
    out.status = FRESH.FRESH; return out;
  }
  if (cls.kind === SESSION.PREVIOUS) { out.status = FRESH.STALE; out.reason = 'PREVIOUS_SESSION'; return out; }   // market live/unknown: yesterday's value is never live
  const mktLag = serverNow - inst.ltt;
  if (ageMs <= th.liveMs && mktLag <= th.marketLagMs) out.status = FRESH.LIVE;
  else if (ageMs <= th.freshMs && mktLag <= th.marketLagMs) out.status = FRESH.FRESH;
  else { out.status = FRESH.STALE; out.reason = mktLag > th.marketLagMs ? 'EXCHANGE_TIMESTAMP_OLD' : 'NO_RECENT_TICK'; }
  return out;
}

export const isUsable = (f) => !!f && (f.status === FRESH.LIVE || f.status === FRESH.FRESH);

// May this value feed LIVE analytics right now? Market open: only LIVE/FRESH values from the CURRENT session.
// Market closed/pre-open/auction: never (they may still be displayed, labelled by `session`).
export const usableForLive = (f, marketState) => !!f && marketState === MS.OPEN && isUsable(f) && f.session === SESSION.CURRENT;

// ---- candles (REST). series = describeSeries() info: { kind, date, lastT, count }. tfMin = candle size in minutes.
export const CANDLE_TH = { refreshMaxMs: 60000 };       // candles not re-fetched for this long while the market is open => STALE
export function computeCandleFreshness({ info, receivedAt, link, marketState, now, serverNow, tfMin = 1 }) {
  const base = { status: FRESH.UNAVAILABLE, ageMs: null, marketTs: null, receivedAt: receivedAt || null, tradingDate: null, session: SESSION.INVALID };
  if (!info || !info.count || !validLast(info.lastT)) return base;
  const cls = classifyTs(info.lastT, serverNow);
  const out = { ...base, marketTs: info.lastT, tradingDate: cls.date, session: cls.kind, ageMs: Math.max(0, serverNow - info.lastT) };
  if (cls.kind === SESSION.INVALID) { out.status = FRESH.STALE; out.reason = 'INVALID_TIMESTAMP'; return out; }
  if (cls.kind === SESSION.FUTURE) { out.status = FRESH.STALE; out.reason = 'FUTURE_TIMESTAMP'; return out; }
  if (link === 'DISCONNECTED') { out.status = FRESH.DISCONNECTED; return out; }
  if (marketState !== MS.OPEN) { out.status = FRESH.FRESH; return out; }              // closed: latest available session, labelled by `session`
  if (cls.kind === SESSION.PREVIOUS) { out.status = FRESH.STALE; out.reason = 'PREVIOUS_SESSION'; return out; }
  const barMs = tfMin * 60000;                                                       // the last bar opened at lastT and is still forming
  const recvAge = receivedAt ? now - receivedAt : Infinity;
  if (recvAge > CANDLE_TH.refreshMaxMs) { out.status = FRESH.STALE; out.reason = 'NOT_REFRESHED'; }
  else if (out.ageMs <= barMs + 30000) out.status = FRESH.LIVE;
  else if (out.ageMs <= barMs + 120000) out.status = FRESH.FRESH;
  else { out.status = FRESH.STALE; out.reason = 'NO_RECENT_CANDLE'; }
  return out;
}
const validLast = (t) => typeof t === 'number' && Number.isFinite(t) && t > 0;

// ---- option chain (REST). Upstox's chain response carries NO exchange timestamp, so marketTs / tradingDate are null
// ("not provided") and never invented. Freshness comes from when we received it and the market phase at request time.
export const CHAIN_TH = { liveMs: 20000, freshMs: 60000 };
export function computeChainFreshness({ chain, receivedAt, requestedMarketState, link, marketState, now }) {
  const base = { status: FRESH.UNAVAILABLE, ageMs: null, marketTs: null, receivedAt: receivedAt || null, tradingDate: null, session: SESSION.INVALID, marketTsProvided: false };
  if (!chain || !chain.length || !receivedAt) return base;
  const out = { ...base, ageMs: Math.max(0, now - receivedAt) };
  if (link === 'DISCONNECTED') { out.status = FRESH.DISCONNECTED; return out; }
  if (marketState !== MS.OPEN) { out.status = FRESH.FRESH; out.reason = 'SNAPSHOT_MARKET_NOT_OPEN'; return out; }
  if (requestedMarketState !== MS.OPEN) { out.status = FRESH.STALE; out.reason = 'RECEIVED_BEFORE_MARKET_OPEN'; return out; }
  if (out.ageMs <= CHAIN_TH.liveMs) out.status = FRESH.LIVE;
  else if (out.ageMs <= CHAIN_TH.freshMs) out.status = FRESH.FRESH;
  else { out.status = FRESH.STALE; out.reason = 'NOT_REFRESHED'; }
  return out;
}

// ---- global context (Yahoo, delayed/unofficial). item: { price, t (market ts ms), receivedAt } or { error }.
export const GLOBAL_TH = { delayedMs: 30 * 60000 };
export function computeGlobalFreshness({ item, now }) {
  const base = { status: FRESH.UNAVAILABLE, ageMs: null, marketTs: null, receivedAt: item && item.receivedAt || null, tradingDate: null, session: SESSION.INVALID };
  if (!item || item.error || typeof item.price !== 'number') return base;
  const ts = item.t;
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts < Date.UTC(2015, 0, 1) || ts > now + 5 * 60000) return { ...base, status: FRESH.STALE, reason: 'INVALID_TIMESTAMP' };
  const ageMs = Math.max(0, now - ts);
  const out = { ...base, ageMs, marketTs: ts, tradingDate: istDate(ts), session: ageMs <= GLOBAL_TH.delayedMs ? SESSION.CURRENT : SESSION.PREVIOUS };
  out.status = ageMs <= GLOBAL_TH.delayedMs ? FRESH.FRESH : FRESH.STALE;     // older than a delayed quote => last close, never "live"
  if (out.status === FRESH.STALE) out.reason = 'LAST_CLOSE';
  return out;
}
