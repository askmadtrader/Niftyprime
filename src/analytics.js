// NIFTY intraday analytics (Part 9). Pure functions: no network, no clock reads, no React.
//
// Everything is computed from REAL inputs handed in by the caller: the live-feed quote (Part 1/2), the current-session
// 1-minute candles, and the option chain's OI walls (Part 5). Nothing is generated, interpolated or repaired.
//
//   - OHLC / previous close / day range / current price   (each value carries its SOURCE)
//   - VWAP: volume-weighted only when real volume exists; otherwise a clearly labelled session-average PROXY
//   - Opening range 09:15-09:30 IST from the current session's candles, and breakout / breakdown / inside
//   - Support / resistance from day high, day low, opening range, VWAP and significant OI walls (every level labelled)
//   - Short-term momentum on 1m / 5m / 15m / 30m, aggregated from the same 1-minute candles
//
// NOT here: the CALL / PUT signal. engine.js is untouched and keeps its own older technicals until the signal part.
import { istDate, istMinutes, fmtDMY } from './util';
import { mergeCandles } from './chartmath';
import { analyzeOi, fmtInt } from './oi';
import { isUsable } from './feed/freshness';
import { MS, MARKET_STATE_LABEL } from './feed/marketStatus';
import { SESSION, labelFor } from './feed/session';

// ---- tunable defaults (definitions / thresholds, not market facts)
export const OPEN_MIN = 9 * 60 + 15;      // NSE normal session opens 09:15 IST (minutes since midnight)
export const OR_MINUTES = 15;             // opening range = first 15 minutes: 09:15 - 09:30
export const VOLUME_COVERAGE_MIN = 0.8;   // VWAP is volume-weighted only if >= 80 % of the candles carry volume
export const MOMENTUM_TFS = [1, 5, 15, 30];
export const ROC_BARS = 3;                // momentum = change of the close over the last 3 COMPLETED bars of that timeframe
export const FLAT_BASE_PCT = 0.03;        // |ROC| below 0.03 % * sqrt(window minutes / 3) counts as FLAT (1m: 0.030 %, 5m: 0.067 %, 15m: 0.116 %, 30m: 0.164 %)
export const AT_VWAP_PCT = 0.02;          // within +/-0.02 % of VWAP = "AT"
export const LEVEL_MERGE_TOL = 0.005;     // levels closer than this (points) are the same level

const MIN = 60000;
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const pos = (x) => fin(x) && x > 0;

// Source texts shown next to every number.
export const SRC = {
  FEED: 'Live feed (Upstox 1d candle)',
  FEED_PREV: 'Live feed (previous close)',
  FEED_LTP: 'Live feed (last traded price)',
  FEED_CLOSED: 'Live feed (last price, market closed)',
  CANDLES: '1-minute candles',
  PRICE_EXT: 'Live price (day range from feed/candles is behind)',
  OR: 'Opening range 09:15-09:30 (1-minute candles)',
};

// IST calendar date + minutes-since-midnight -> epoch ms
export function sessionMs(date, minuteOfDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  if (!m || !fin(minuteOfDay)) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], 0, minuteOfDay) - 5.5 * 3600 * 1000;
}

// Plain-language text for the reason codes this module reports (shown in the UI, never parsed).
export const REASON_TEXT = {
  NO_QUOTE: 'no price received from the live feed', INVALID_TIMESTAMP: 'the last tick has no valid exchange time', NO_SESSION: 'no trading session identified',
  OTHER_SESSION: 'the last tick is from a different session', PREVIOUS_SESSION: 'the last tick is from the previous session', FUTURE_TIMESTAMP: 'the last tick has a future timestamp',
  EXCHANGE_TIMESTAMP_OLD: 'the last tick is old', NO_RECENT_TICK: 'no tick received recently', STALE: 'the last tick is stale', DISCONNECTED: 'the live feed is disconnected', UNAVAILABLE: 'no data',
  NO_CANDLES: 'no candles for this session', CANDLES_NOT_USABLE: 'candles are not live', NO_VOLUME: 'NIFTY is an index with no traded volume', PARTIAL_VOLUME: 'only some candles carry volume', INVALID_VOLUME: 'candle volume is invalid',
  WINDOW_RUNNING: 'the 09:15-09:30 window is still running', WAITING_FOR_POST_OR_CANDLE: 'waiting for the first candle after 09:30', MISSING_CANDLES: 'a candle inside 09:15-09:30 is missing',
  NO_OR_CANDLES: 'no candles in 09:15-09:30', NO_PRICE: 'no valid current price', GAP: 'a candle needed for the look-back is missing', NEED_4_BARS: 'needs 4 completed bars',
};
export const reasonText = (code) => (code ? REASON_TEXT[code] || String(code) : '');

const val = (value, source, extra) => ({ value: fin(value) ? value : null, source: fin(value) ? source : null, ...(extra || null) });

// ---------------------------------------------------------------------------------------------------------
// Session resolution: which trading date are we describing, and is it live?
// ---------------------------------------------------------------------------------------------------------
//   Market OPEN  -> only TODAY's data may be used. Yesterday's candles / quote are dropped, never relabelled as live.
//   Otherwise    -> the latest session present (quote or candles), labelled TODAY'S SESSION (MARKET CLOSED) or PREVIOUS SESSION.
export function resolveSession({ quote, candles, now, marketState } = {}) {
  const live = marketState === MS.OPEN;
  const today = fin(now) && now > 0 ? istDate(now) : null;
  const quoteDate = quote && quote.tsValid && quote.tradingDate ? quote.tradingDate : null;
  const all = mergeCandles(Array.isArray(candles) ? candles : []);
  const candleDate = all.length ? istDate(all[all.length - 1].t) : null;
  const date = live ? today : ([quoteDate, candleDate].filter(Boolean).sort().pop() || null);
  const kind = !date ? SESSION.INVALID : date === today ? SESSION.CURRENT : SESSION.PREVIOUS;
  const label = !date ? 'NO DATA' : live && kind === SESSION.CURRENT ? `LIVE SESSION ${fmtDMY(date)}` : labelFor(kind, date, marketState);
  const dropped = date ? all.filter((c) => istDate(c.t) !== date).length : all.length;
  return {
    date, kind, live, today, label, marketState: marketState || MS.UNKNOWN, marketLabel: MARKET_STATE_LABEL[marketState] || MARKET_STATE_LABEL[MS.UNKNOWN],
    quoteDate, candleDate, otherSessionCandles: dropped,
    candles: date ? all.filter((c) => istDate(c.t) === date) : [],
  };
}

// ---------------------------------------------------------------------------------------------------------
// Current price
// ---------------------------------------------------------------------------------------------------------
// The price of the described session from the live feed, and only while that tick is LIVE / FRESH. No fallback to a
// candle close: a stale tick is reported as unavailable, not replaced by a number that looks current.
export function currentPrice({ quote, quoteFresh, session }) {
  const none = (reason) => ({ value: null, source: null, status: quoteFresh ? quoteFresh.status : 'UNAVAILABLE', reason, marketTs: null, receivedAt: null });
  if (!quote || !pos(quote.ltp)) return none('NO_QUOTE');
  if (!quote.tsValid) return none('INVALID_TIMESTAMP');
  if (!session || !session.date) return none('NO_SESSION');
  if (quote.tradingDate !== session.date) return none('OTHER_SESSION');
  if (!isUsable(quoteFresh)) return none(quoteFresh && quoteFresh.reason ? quoteFresh.reason : (quoteFresh ? quoteFresh.status : 'UNAVAILABLE'));
  return {
    value: quote.ltp, source: session.live ? SRC.FEED_LTP : SRC.FEED_CLOSED, status: quoteFresh.status, reason: null,
    marketTs: quote.marketTs || quote.ltt || null, receivedAt: quote.receivedAt || null,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Open / High / Low / Previous close / Day range
// ---------------------------------------------------------------------------------------------------------
// Candle statistics of ONE session. Candles before 09:15 are pre-open prints: not part of the traded session.
export function candleStats(cs, date) {
  const openMs = sessionMs(date, OPEN_MIN);
  const list = (cs || []).filter((c) => openMs !== null && c.t >= openMs);
  if (!list.length) return null;
  const first = list[0], last = list[list.length - 1];
  const slots = Math.floor((last.t - openMs) / MIN) + 1;           // minutes from the open to the newest candle
  return {
    count: list.length, slots, missing: Math.max(0, slots - list.length), preOpenDropped: cs.length - list.length,
    startsAtOpen: first.t === openMs,
    open: first.t === openMs ? first.o : null,                    // only the 09:15 candle's open is "the day's open"
    high: Math.max(...list.map((c) => c.h)), low: Math.min(...list.map((c) => c.l)),
    lastT: last.t, list,
  };
}

export function computeOhlc({ quote, session, price, cs, candlesOk }) {
  const q = quote && session.date && quote.tradingDate === session.date ? quote : null;     // never another day's range
  const cst = candlesOk && cs.length ? candleStats(cs, session.date) : null;
  const gapNote = cst && cst.missing > 0 ? ` (${cst.missing} candle${cst.missing === 1 ? '' : 's'} missing)` : '';
  const stale = !!(session.live && !(price && price.value !== null));                       // live market but no usable tick: feed range may be behind

  const feedHigh = q && pos(q.high) ? q.high : null, feedLow = q && pos(q.low) ? q.low : null;
  const hiC = [], loC = [];
  if (feedHigh !== null) hiC.push({ v: feedHigh, src: SRC.FEED }); if (feedLow !== null) loC.push({ v: feedLow, src: SRC.FEED });
  if (cst) { hiC.push({ v: cst.high, src: SRC.CANDLES + gapNote }); loC.push({ v: cst.low, src: SRC.CANDLES + gapNote }); }
  const pick = (list, better) => list.reduce((b, x) => (!b || better(x.v, b.v) ? x : b), null);   // ties keep the earlier (feed) source
  let hi = pick(hiC, (a, b) => a > b), lo = pick(loC, (a, b) => a < b);
  // A traded price can never lie outside the day's range. If the price is beyond the range we have, the range source is
  // behind: extend to the price and say so. Never used when there is no range at all (one price is not a day high).
  if (hi && price && price.value !== null && price.value > hi.v) hi = { v: price.value, src: SRC.PRICE_EXT };
  if (lo && price && price.value !== null && price.value < lo.v) lo = { v: price.value, src: SRC.PRICE_EXT };

  const feedOpen = q && pos(q.open) ? q.open : null;
  const open = feedOpen !== null ? val(feedOpen, SRC.FEED) : cst && cst.open !== null ? val(cst.open, SRC.CANDLES) : val(null);
  const prevClose = q && pos(q.prev) ? val(q.prev, SRC.FEED_PREV) : val(null);
  const high = hi ? val(hi.v, hi.src) : val(null), low = lo ? val(lo.v, lo.src) : val(null);

  const rangePts = high.value !== null && low.value !== null ? high.value - low.value : null;
  const p = price && price.value !== null ? price.value : null;
  return {
    open, high, low, prevClose, stale,
    range: { pts: rangePts, source: rangePts !== null ? 'High - Low' : null },
    pricePosPct: rangePts !== null && rangePts > 0 && p !== null ? ((p - low.value) / rangePts) * 100 : null,   // 0 = at the low, 100 = at the high
    change: p !== null && prevClose.value !== null ? { pts: p - prevClose.value, pct: ((p - prevClose.value) / prevClose.value) * 100 } : null,
    candles: cst ? { count: cst.count, missing: cst.missing, startsAtOpen: cst.startsAtOpen, preOpenDropped: cst.preOpenDropped } : null,
  };
}

// ---------------------------------------------------------------------------------------------------------
// VWAP (or, honestly, its proxy)
// ---------------------------------------------------------------------------------------------------------
//   volume-weighted:  VWAP = sum(typical * volume) / sum(volume),  typical = (H + L + C) / 3
//   NIFTY is an INDEX: it has no traded volume, Upstox sends 0. Weighting by 0 or by an invented volume would be fake, so
//   without real volume the value is the plain session AVERAGE of the typical price (a time-weighted proxy) and it is
//   labelled that way everywhere. Volume is "real" only if >= 80 % of the candles carry a valid volume > 0.
export function computeVwap(cs) {
  const list = Array.isArray(cs) ? cs : [];
  if (!list.length) return { value: null, method: null, label: 'VWAP', short: 'VWAP', source: null, candles: 0, volumeCoverage: null, reason: 'NO_CANDLES', note: 'No candles for this session.' };
  const tp = (c) => (c.h + c.l + c.c) / 3;
  const volOk = (c) => fin(c.v) && c.v >= 0;
  const withVol = list.filter((c) => volOk(c) && c.v > 0).length;
  const invalid = list.some((c) => c.v !== undefined && c.v !== null && !volOk(c));
  const coverage = withVol / list.length;
  const base = { candles: list.length, volumeCoverage: coverage, asOf: list[list.length - 1].t };
  if (!invalid && coverage >= VOLUME_COVERAGE_MIN) {
    let pv = 0, v = 0;
    for (const c of list) if (c.v > 0) { pv += tp(c) * c.v; v += c.v; }
    return { ...base, value: pv / v, method: 'VOLUME', label: 'VWAP', short: 'VWAP (volume-weighted)', source: `Typical price x volume, ${list.length} 1-minute candles`, reason: null, note: 'Volume-weighted: sum(typical price x volume) / sum(volume).' };
  }
  const reason = invalid ? 'INVALID_VOLUME' : withVol === 0 ? 'NO_VOLUME' : 'PARTIAL_VOLUME';
  const why = reason === 'NO_VOLUME' ? 'NIFTY is an index with no traded volume' : reason === 'PARTIAL_VOLUME' ? `only ${Math.round(coverage * 100)}% of candles carry volume` : 'candle volume is invalid';
  const avg = list.reduce((s, c) => s + tp(c), 0) / list.length;
  return {
    ...base, value: avg, method: 'PROXY', label: 'Session avg (VWAP proxy)', short: 'Session avg (VWAP proxy, no volume)',
    source: `Average of (H+L+C)/3, ${list.length} 1-minute candles`, reason,
    note: `PROXY, not a true VWAP: ${why}, so every candle has equal weight. This is the session average of (H+L+C)/3.`,
  };
}

export function priceVsVwap(price, vwap) {
  if (!pos(price) || !pos(vwap)) return { position: null, distPct: null };
  const distPct = ((price - vwap) / vwap) * 100;
  return { position: Math.abs(distPct) < AT_VWAP_PCT ? 'AT' : distPct > 0 ? 'ABOVE' : 'BELOW', distPct };
}

// ---------------------------------------------------------------------------------------------------------
// Opening range (09:15 - 09:30 IST) from the CURRENT session's candles
// ---------------------------------------------------------------------------------------------------------
//   FORMING     the window is still running (or the first post-09:30 candle has not arrived): provisional numbers, no breakout call
//   COMPLETE    the window is over, a candle after it exists, and all 15 one-minute candles are present
//   INCOMPLETE  the window is over but a candle is missing: partial numbers are shown, no breakout call
//   UNAVAILABLE the window is over and there is no candle in it at all
//   Breakout / breakdown / inside is decided ONLY for a COMPLETE range and a usable price. price == OR high/low is INSIDE.
export function computeOpeningRange({ cs, date, now, price, minutes = OR_MINUTES }) {
  const startMs = sessionMs(date, OPEN_MIN), endMs = startMs === null ? null : startMs + minutes * MIN;
  const base = { status: 'UNAVAILABLE', high: null, low: null, width: null, candles: 0, expected: minutes, startMs, endMs, source: SRC.OR, provisional: false, breakout: null, state: null, distance: null, reason: null };
  if (startMs === null) return { ...base, reason: 'NO_SESSION' };
  const inWin = (cs || []).filter((c) => c.t >= startMs && c.t < endMs);
  const slots = new Set(inWin.map((c) => Math.floor((c.t - startMs) / MIN)));
  const have = slots.size;
  const hi = have ? Math.max(...inWin.map((c) => c.h)) : null, lo = have ? Math.min(...inWin.map((c) => c.l)) : null;
  const over = fin(now) && now >= endMs;
  const hasAfter = (cs || []).some((c) => c.t >= endMs);
  const out = { ...base, high: hi, low: lo, width: have ? hi - lo : null, candles: have };
  if (!over || !hasAfter) {
    if (over && !hasAfter && !have) return { ...out, status: 'UNAVAILABLE', reason: 'NO_OR_CANDLES' };
    return { ...out, status: 'FORMING', provisional: have > 0, reason: over ? 'WAITING_FOR_POST_OR_CANDLE' : 'WINDOW_RUNNING' };
  }
  if (!have) return { ...out, status: 'UNAVAILABLE', reason: 'NO_OR_CANDLES' };
  if (have < minutes) return { ...out, status: 'INCOMPLETE', provisional: true, reason: 'MISSING_CANDLES' };
  const done = { ...out, status: 'COMPLETE' };
  if (!price || price.value === null) return { ...done, reason: 'NO_PRICE' };
  const p = price.value;
  if (p > hi) return { ...done, state: 'BREAKOUT', breakout: 'UP', distance: p - hi };
  if (p < lo) return { ...done, state: 'BREAKDOWN', breakout: 'DOWN', distance: lo - p };
  return { ...done, state: 'INSIDE', breakout: null, distance: Math.min(hi - p, p - lo) };      // distance to the nearer edge
}

// ---------------------------------------------------------------------------------------------------------
// Momentum from actual candles
// ---------------------------------------------------------------------------------------------------------
// Bars are built from the 1-minute candles, anchored at 09:15 (NOT at the epoch: a 60-minute bucket aligned to the epoch
// would start at :30 in IST). A bar is complete only if all of its minutes are present. The forming minute is excluded.
export function aggregateAnchored(cs, tf, anchorMs) {
  const ms = tf * MIN, by = new Map();
  for (const c of cs || []) {
    if (!fin(anchorMs) || c.t < anchorMs || (c.t - anchorMs) % MIN !== 0) continue;
    const k = Math.floor((c.t - anchorMs) / ms);
    const b = by.get(k);
    if (!b) by.set(k, { k, t: anchorMs + k * ms, o: c.o, h: c.h, l: c.l, c: c.c, n: 1 });
    else { b.h = Math.max(b.h, c.h); b.l = Math.min(b.l, c.l); b.c = c.c; b.n += 1; }     // cs is sorted: later candle = later close
  }
  return [...by.values()].filter((b) => b.n === tf).sort((a, b) => a.k - b.k);
}

export const flatThreshold = (tf, bars = ROC_BARS) => FLAT_BASE_PCT * Math.sqrt((tf * bars) / 3);

export function computeMomentum({ cs, date, now, live, tfs = MOMENTUM_TFS }) {
  const anchor = sessionMs(date, OPEN_MIN);
  const done = (cs || []).filter((c) => !live || (fin(now) && c.t + MIN <= now));           // live: the forming minute is not a close yet
  const frames = tfs.map((tf) => {
    const label = `${tf}m`, windowMin = tf * ROC_BARS;
    const bars = aggregateAnchored(done, tf, anchor);
    const f = { tf, label, windowMin, bars: bars.length, available: false, rocPct: null, lastBarPct: null, state: null, fading: false, thresholdPct: flatThreshold(tf), asOf: null, reason: null };
    if (bars.length < ROC_BARS + 1) return { ...f, reason: `NEED_${ROC_BARS + 1}_BARS` };
    const last = bars[bars.length - 1];
    const base = bars.find((b) => b.k === last.k - ROC_BARS);
    if (!base || !pos(base.c)) return { ...f, reason: 'GAP' };
    const prev = bars.find((b) => b.k === last.k - 1);
    const rocPct = ((last.c - base.c) / base.c) * 100;
    const lastBarPct = prev && pos(prev.c) ? ((last.c - prev.c) / prev.c) * 100 : null;
    const state = rocPct > f.thresholdPct ? 'POSITIVE' : rocPct < -f.thresholdPct ? 'NEGATIVE' : 'FLAT';
    const fading = lastBarPct !== null && ((state === 'POSITIVE' && lastBarPct < 0) || (state === 'NEGATIVE' && lastBarPct > 0));
    return { ...f, available: true, rocPct, lastBarPct, state, fading, asOf: last.t + tf * MIN };
  });
  const av = frames.filter((f) => f.available);
  const up = av.filter((f) => f.state === 'POSITIVE').length, dn = av.filter((f) => f.state === 'NEGATIVE').length, flat = av.filter((f) => f.state === 'FLAT').length;
  let alignment = 'UNAVAILABLE';
  if (av.length) {
    if (up && dn) alignment = 'MIXED';
    else if (up) alignment = av.length >= 2 && up === av.length ? 'ALIGNED_UP' : 'LEANING_UP';
    else if (dn) alignment = av.length >= 2 && dn === av.length ? 'ALIGNED_DOWN' : 'LEANING_DOWN';
    else alignment = 'FLAT';
  }
  return { frames, alignment, available: av.length, up, down: dn, flat, method: `Close-to-close % change over the last ${ROC_BARS} completed bars, bars built from 1-minute candles anchored at 09:15` };
}

// ---------------------------------------------------------------------------------------------------------
// Support / resistance
// ---------------------------------------------------------------------------------------------------------
// OI walls are the Part 5 walls (local OI peaks holding >= 60 % of the biggest OI on their side of spot) of the SELECTED
// expiry. They are used only from a LIVE / FRESH chain and only with a valid price; otherwise they are excluded and the
// reason is reported.
export function collectOiWalls({ chain, price }) {
  const off = (reason, text) => ({ included: false, reason, text, walls: [], expiry: chain && chain.expiry ? chain.expiry : null, snapshot: false });
  if (!chain || !Array.isArray(chain.rows) || !chain.rows.length) return off('NO_CHAIN', 'OI walls excluded: option chain not received.');
  if (!price || price.value === null) return off('NO_PRICE', 'OI walls excluded: no valid current price.');
  const fr = chain.fresh;
  if (!isUsable(fr)) return off('CHAIN_' + (fr ? fr.status : 'UNAVAILABLE'), `OI walls excluded: option chain is ${fr ? fr.status : 'UNAVAILABLE'}.`);
  const r = analyzeOi({ rows: chain.rows, expiry: chain.expiry, chainExpiry: chain.chainExpiry, spot: price.value });
  if (!r.ok) return off(r.reason, `OI walls excluded: ${r.text}.`);
  const snapshot = fr.reason === 'SNAPSHOT_MARKET_NOT_OPEN';
  const walls = [
    ...r.callWalls.map((w) => ({ side: 'CALL', strike: w.strike, oi: w.oi, delta: w.delta })),
    ...r.putWalls.map((w) => ({ side: 'PUT', strike: w.strike, oi: w.oi, delta: w.delta })),
  ];
  return { included: true, reason: null, text: walls.length ? null : 'No significant OI wall found.', walls, expiry: r.expiry, snapshot };
}

export function buildLevels({ price, ohlc, vwap, or, oi }) {
  const raw = [];
  const add = (p, kind, label, source, extra) => { if (pos(p)) raw.push({ price: p, kind, label, source, ...(extra || null) }); };
  add(ohlc.high.value, 'DAY_HIGH', 'Day high', ohlc.high.source);
  add(ohlc.low.value, 'DAY_LOW', 'Day low', ohlc.low.source);
  if (or && or.status === 'COMPLETE') { add(or.high, 'OR_HIGH', 'OR high', SRC.OR); add(or.low, 'OR_LOW', 'OR low', SRC.OR); }
  if (vwap && vwap.value !== null) add(vwap.value, 'VWAP', vwap.method === 'VOLUME' ? 'VWAP' : 'Session avg (proxy)', vwap.source);
  for (const w of (oi && oi.walls) || []) {
    add(w.strike, w.side === 'CALL' ? 'CALL_OI_WALL' : 'PUT_OI_WALL', `${w.side} OI wall`,
      `Option chain OI, expiry ${fmtDMY(oi.expiry)}${oi.snapshot ? ', market-closed snapshot' : ''}, OI ${fmtInt(w.oi)}`, { oi: w.oi });
  }
  raw.sort((a, b) => a.price - b.price);
  const groups = [];
  for (const r of raw) {                                           // identical prices (e.g. day high == OR high) become ONE level with several sources
    const g = groups[groups.length - 1];
    if (g && Math.abs(r.price - g.price) < LEVEL_MERGE_TOL) g.parts.push(r); else groups.push({ price: r.price, parts: [r] });
  }
  const p = price && price.value !== null ? price.value : null;
  const levels = groups.map((g) => ({
    price: g.price, parts: g.parts, label: g.parts.map((x) => x.label).join(' + '), sources: [...new Set(g.parts.map((x) => x.source))],
    side: p === null ? null : Math.abs(g.price - p) < LEVEL_MERGE_TOL ? 'AT_PRICE' : g.price > p ? 'RESISTANCE' : 'SUPPORT',
    distance: p === null ? null : Math.abs(g.price - p), distancePct: p === null ? null : (Math.abs(g.price - p) / p) * 100,
  }));
  const near = (a, b) => a.distance - b.distance || a.price - b.price;
  const resistances = levels.filter((l) => l.side === 'RESISTANCE').sort(near);
  const supports = levels.filter((l) => l.side === 'SUPPORT').sort(near);
  return {
    classified: p !== null, all: levels, resistances, supports, atPrice: levels.filter((l) => l.side === 'AT_PRICE'),
    nearestResistance: resistances[0] || null, nearestSupport: supports[0] || null,
    oi: { included: !!(oi && oi.included), reason: oi ? oi.reason : 'NO_CHAIN', text: oi ? oi.text : 'OI walls excluded: option chain not received.', expiry: oi ? oi.expiry : null, snapshot: !!(oi && oi.snapshot) },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------------------------------------
// analyzeNifty({ quote, quoteFresh, candles, candlesFresh, marketState, now, chain })
//   quote / quoteFresh   feed instrument + computeFreshness() result
//   candles              the 1-minute candles of the engine (any session: the right one is selected here)
//   candlesFresh         computeCandleFreshness() result (live-market recency of the candle set)
//   marketState          MS.* from market_info
//   now                  exchange-aligned clock (serverNow)
//   chain                { rows, expiry, chainExpiry, fresh } or null
export function analyzeNifty({ quote, quoteFresh, candles, candlesFresh, marketState, now, chain } = {}) {
  const session = resolveSession({ quote, candles, now, marketState });
  const issues = [];
  const price = currentPrice({ quote, quoteFresh, session });
  if (price.value === null) issues.push(`Current price unavailable: ${reasonText(price.reason)}.`);

  const cs = session.candles;
  if (session.otherSessionCandles > 0) issues.push(`${session.otherSessionCandles} candle${session.otherSessionCandles === 1 ? '' : 's'} from another session ignored.`);
  // Live market: candle-derived numbers that depend on recency need a LIVE / FRESH candle set. The opening range is immutable
  // once it is complete, so it is judged on the candles themselves.
  const candlesOk = cs.length > 0 && (!session.live || isUsable(candlesFresh));
  if (cs.length && !candlesOk) issues.push(`Candles are ${candlesFresh ? candlesFresh.status : 'UNAVAILABLE'}: VWAP, momentum and candle-based day range are withheld.`);
  if (!cs.length) issues.push('No candles for this session.');

  const ohlc = computeOhlc({ quote, session, price, cs, candlesOk });
  const vwapCs = candlesOk ? cs.filter((c) => { const o = sessionMs(session.date, OPEN_MIN); return o !== null && c.t >= o; }) : [];
  const vwap = candlesOk ? computeVwap(vwapCs) : { ...computeVwap([]), reason: cs.length ? 'CANDLES_NOT_USABLE' : 'NO_CANDLES', note: 'VWAP withheld: no usable candles.' };
  const vwapPos = priceVsVwap(price.value, vwap.value);
  const or = computeOpeningRange({ cs, date: session.date, now, price });
  const momentum = candlesOk ? computeMomentum({ cs, date: session.date, now, live: session.live })
    : { frames: MOMENTUM_TFS.map((tf) => ({ tf, label: `${tf}m`, available: false, reason: 'CANDLES_NOT_USABLE' })), alignment: 'UNAVAILABLE', available: 0, up: 0, down: 0, flat: 0, method: null };
  const oi = collectOiWalls({ chain, price });
  const levels = buildLevels({ price, ohlc, vwap, or, oi });
  if (ohlc.stale && ohlc.high.value !== null) issues.push('Day range may be behind: no live tick right now.');

  return { ok: !!session.date && (price.value !== null || cs.length > 0 || ohlc.high.value !== null), session, price, ohlc, vwap: { ...vwap, ...vwapPos }, openingRange: or, levels, momentum, issues };
}
