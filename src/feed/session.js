// Trading-session detection. NSE sessions never cross midnight IST, so a data point belongs to the session
// whose IST calendar date equals the date of its own timestamp. "Today" comes from the exchange-aligned clock
// (device clock corrected by the feed's currentTs), never from the raw device clock alone.
import { istDate, fmtDMY } from '../util';

export const SESSION = { CURRENT: 'CURRENT', PREVIOUS: 'PREVIOUS', FUTURE: 'FUTURE', INVALID: 'INVALID' };
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000; // tolerate small clock error, reject timestamps from the future
const MIN_VALID_TS = Date.UTC(2015, 0, 1);

export function validTs(ts) {
  return typeof ts === 'number' && Number.isFinite(ts) && ts >= MIN_VALID_TS;
}

// Classify one timestamp. `now` must be the exchange-aligned clock.
export function classifyTs(ts, now) {
  if (!validTs(ts) || !validTs(now)) return { kind: SESSION.INVALID, date: null };
  if (ts > now + MAX_FUTURE_SKEW_MS) return { kind: SESSION.FUTURE, date: istDate(ts) };
  const date = istDate(ts);
  return { kind: date === istDate(now) ? SESSION.CURRENT : SESSION.PREVIOUS, date };
}

// Is the market in a phase where fresh ticks are expected (affects what may be used as "live")?
export const isLivePhase = (marketState) => marketState === 'NORMAL_OPEN';

// Summarise a candle series: latest session date, whether it is today's, and a UI label.
export function describeSeries(candles, now, marketState) {
  const valid = (Array.isArray(candles) ? candles : []).filter((c) => c && validTs(c.t));
  if (!valid.length) return { kind: SESSION.INVALID, date: null, lastT: 0, count: 0, label: 'NO DATA', usable: false };
  const lastT = valid.reduce((m, c) => (c.t > m ? c.t : m), 0);
  const { kind, date } = classifyTs(lastT, now);
  const label = labelFor(kind, date, marketState);
  return { kind, date, lastT, count: valid.length, label, usable: kind === SESSION.CURRENT };
}

export function labelFor(kind, date, marketState) {
  if (kind === SESSION.CURRENT) return isLivePhase(marketState) ? `LIVE SESSION ${fmtDMY(date)}` : `TODAY'S SESSION (MARKET ${marketState === 'PRE_OPEN' ? 'NOT OPEN YET' : 'CLOSED'}) ${fmtDMY(date)}`;
  if (kind === SESSION.PREVIOUS) return `PREVIOUS SESSION ${fmtDMY(date)}`;
  if (kind === SESSION.FUTURE) return 'INVALID TIMESTAMP (FUTURE)';
  return 'NO DATA';
}

// Keep only the candles of the latest session present in the series (never mixes days).
export function latestSessionCandles(candles) {
  const valid = (Array.isArray(candles) ? candles : []).filter((c) => c && validTs(c.t));
  if (!valid.length) return [];
  const day = istDate(valid.reduce((m, c) => (c.t > m ? c.t : m), 0));
  return valid.filter((c) => istDate(c.t) === day);
}

// Candles that may feed analytics right now.
//  - Market live: ONLY today's candles. Previous-session candles are dropped, never relabelled as live.
//  - Otherwise: the latest session (today's finished one, or the previous one), clearly labelled by `info`.
export function selectCandles(candles, now, marketState) {
  const latest = latestSessionCandles(candles);
  const info = describeSeries(latest, now, marketState);
  if (isLivePhase(marketState) && info.kind !== SESSION.CURRENT) return { candles: [], info: { ...info, usable: false, rejected: latest.length } };
  return { candles: latest, info };
}
