// Pure chart logic (no React, no network): history merge, per-session VWAP, viewport pan/zoom, geometry, status.
// Everything here works on REAL candles handed in by the caller. Nothing is generated, interpolated or repaired.
import { istDate, ist, pad, fmtHM, fmtDMY } from './util';
import { vwapSeries } from './engine';

// Upstox V3 historical-candle limits per request (minutes 1-15: ~1 month, minutes 16-300 / hours: ~1 quarter) are why the
// history is fetched in chunks. 1h is the native Upstox `hours/1` candle, never a client-side 60-minute aggregate.
export const TF_CONFIG = {
  1: { tf: 1, label: '1m', unit: 'minutes', interval: 1, chunkDays: 28, lookbackDays: 28 },
  5: { tf: 5, label: '5m', unit: 'minutes', interval: 5, chunkDays: 28, lookbackDays: 56 },
  15: { tf: 15, label: '15m', unit: 'minutes', interval: 15, chunkDays: 28, lookbackDays: 84 },
  30: { tf: 30, label: '30m', unit: 'minutes', interval: 30, chunkDays: 85, lookbackDays: 85 },
  60: { tf: 60, label: '1h', unit: 'hours', interval: 1, chunkDays: 85, lookbackDays: 85 },
};
export const TF_LIST = [1, 5, 15, 30, 60];
export const MIN_DRAW = 3;      // fewer candles than this => "insufficient candles", no chart
export const MIN_VIS = 12;      // most zoomed-in
export const MAX_VIS = 300;     // most zoomed-out (keeps the SVG light on phones)
export const RIGHT_PAD = 3;     // empty candle slots right of the newest candle when pinned to the latest

const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const fin = (x) => typeof x === 'number' && Number.isFinite(x);

// A candle row is kept only if it is internally consistent. Bad rows are dropped, never repaired.
export function validCandle(c) {
  return !!c && fin(c.t) && fin(c.o) && fin(c.h) && fin(c.l) && fin(c.c)
    && c.h >= c.l && c.h >= Math.max(c.o, c.c) && c.l <= Math.min(c.o, c.c) && c.h > 0 && c.l > 0;
}

// Merge candle lists by timestamp (later lists win on a duplicate), sorted oldest -> newest.
export function mergeCandles(...lists) {
  const m = new Map();
  for (const l of lists) for (const c of (Array.isArray(l) ? l : [])) if (validCandle(c)) m.set(c.t, c);
  return [...m.values()].sort((a, b) => a.t - b.t);
}

// VWAP that restarts at every IST trading date. Computed over the WHOLE loaded history, then sliced for display,
// so panning never changes a value. With no volume (index candles) it is the running mean of typical price.
export function vwapBySession(candles) {
  const out = new Array(candles.length);
  let i = 0;
  while (i < candles.length) {
    const day = istDate(candles[i].t); let j = i;
    while (j < candles.length && istDate(candles[j].t) === day) j += 1;
    const { series } = vwapSeries(candles.slice(i, j));
    for (let k = i; k < j; k += 1) out[k] = series[k - i];
    i = j;
  }
  return out;
}

// High / low / open / last of the NEWEST session present in the loaded candles.
export function sessionStats(candles) {
  if (!candles.length) return null;
  const day = istDate(candles[candles.length - 1].t);
  let i = candles.length - 1;
  while (i > 0 && istDate(candles[i - 1].t) === day) i -= 1;
  const cs = candles.slice(i);
  return {
    date: day, count: cs.length, startIdx: i, open: cs[0].o,
    high: Math.max(...cs.map((c) => c.h)), low: Math.min(...cs.map((c) => c.l)),
    last: cs[cs.length - 1].c, lastT: cs[cs.length - 1].t, firstT: cs[0].t,
  };
}

// ---------------------------------------------------------------- viewport
// view = { count (candles visible), end (right edge, in candle index units, exclusive), pinned (follows newest candle) }
const clampN = (x, a, b) => Math.max(a, Math.min(b, x));
export function countBounds(n) { const hi = Math.max(1, Math.min(MAX_VIS, n + RIGHT_PAD)); return [Math.min(MIN_VIS, hi), hi]; }

export function defaultView(n, sessionCount = 0) {
  const [lo, hi] = countBounds(n);
  return clampView({ count: clampN((sessionCount || 0) + RIGHT_PAD, 40, 120), end: n + RIGHT_PAD, pinned: true }, n, lo, hi);
}

export function clampView(v, n) {
  const [lo, hi] = countBounds(n);
  const count = clampN(v && fin(v.count) ? v.count : hi, lo, hi);
  const maxEnd = n + RIGHT_PAD, minEnd = count; // never scroll past the oldest candle (window start >= 0)
  let end = v && v.pinned ? maxEnd : clampN(v && fin(v.end) ? v.end : maxEnd, minEnd, maxEnd);
  const pinned = end >= maxEnd - 0.5;
  if (pinned) end = maxEnd;
  return { count, end, pinned };
}

// Finger dragged dxPx to the right => earlier candles come into view.
export function panView(v, dxPx, plotW, n) {
  const cw = plotW / v.count;
  return clampView({ count: v.count, end: v.end - dxPx / cw, pinned: false }, n);
}
export function panByCandles(v, k, n) { return clampView({ count: v.count, end: v.end + k, pinned: false }, n); }

// Zoom to `newCount` visible candles keeping the candle under focalFrac (0 = left edge .. 1 = right edge) fixed.
export function zoomView(v, newCount, focalFrac, n) {
  const [lo, hi] = countBounds(n);
  const c2 = clampN(newCount, lo, hi);
  const f = clampN(fin(focalFrac) ? focalFrac : 1, 0, 1);
  const focalIdx = (v.end - v.count) + f * v.count;
  const start2 = focalIdx - f * c2;
  return clampView({ count: c2, end: start2 + c2, pinned: false }, n);
}

export function visibleRange(v, n) {
  const start = v.end - v.count;
  return { start, i0: Math.max(0, Math.floor(start)), i1: Math.min(n, Math.ceil(v.end)) };
}

// ---------------------------------------------------------------- geometry
export function axisLabel(t, multiDay) {
  if (!multiDay) return fmtHM(t);
  const d = ist(t);
  return `${pad(d.d)} ${MON[d.mo - 1]} ${pad(d.h)}:${pad(d.mi)}`;
}

// candles/vwap = FULL arrays. Returns screen coordinates for the visible window only.
export function buildGeometry({ candles, vwap, view, width, height, levels = [], pad: P = {} }) {
  const n = candles.length;
  const padL = P.l ?? 6, padR = P.r ?? 54, padT = P.t ?? 10, padB = P.b ?? 22;
  const pw = Math.max(1, width - padL - padR), ph = Math.max(1, height - padT - padB);
  const { start, i0, i1 } = visibleRange(view, n);
  const slice = candles.slice(i0, i1);
  if (!slice.length) return null;
  let mn = Math.min(...slice.map((c) => c.l)), mx = Math.max(...slice.map((c) => c.h));
  const rng = mx - mn || Math.max(1, mx * 0.001); mn -= rng * 0.06; mx += rng * 0.06;
  const y = (p) => padT + ((mx - p) / (mx - mn)) * ph;
  const cw = pw / view.count;
  const xi = (i) => padL + (i - start + 0.5) * cw;
  const bw = Math.max(1, cw * 0.66);

  const cs = slice.map((c, k) => {
    const i = i0 + k, top = y(Math.max(c.o, c.c)), bot = y(Math.min(c.o, c.c));
    return { i, t: c.t, x: xi(i), yH: y(c.h), yL: y(c.l), yTop: top, hBody: Math.max(1, bot - top), bw, up: c.c >= c.o };
  });
  const vw = []; // polyline pieces, a new piece at every session change (VWAP restarts each day)
  if (vwap && vwap.length === n) {
    let cur = null, day = null;
    for (let i = i0; i < i1; i += 1) {
      const d = istDate(candles[i].t);
      if (d !== day) { cur = []; vw.push(cur); day = d; }
      if (fin(vwap[i])) cur.push({ x: xi(i), y: y(vwap[i]) });
    }
  }
  const seps = []; // boundaries between trading dates inside the window
  for (let i = Math.max(1, i0); i < i1; i += 1) {
    if (istDate(candles[i].t) !== istDate(candles[i - 1].t)) seps.push({ x: xi(i) - cw / 2, label: `${pad(ist(candles[i].t).d)} ${MON[ist(candles[i].t).mo - 1]}` });
  }
  const multiDay = istDate(slice[0].t) !== istDate(slice[slice.length - 1].t);
  const nTicks = width < 360 ? 3 : 4, ticks = [];
  for (let k = 0; k < nTicks; k += 1) {
    const idx = clampN(Math.round(i0 + (slice.length - 1) * (nTicks === 1 ? 0 : k / (nTicks - 1))), i0, i1 - 1);
    const x = xi(idx);
    ticks.push({ x: clampN(x, padL + 22, padL + pw - 22), label: axisLabel(candles[idx].t, multiDay) });
  }
  const grid = [0, 1, 2, 3, 4].map((k) => { const p = mn + ((mx - mn) * k) / 4; return { y: y(p), label: p.toFixed(0) }; });
  const lastC = candles[n - 1];
  const lastVisible = i1 === n; // newest candle on screen?
  // Levels are session-bound: each one is drawn only over the candles of the date it belongs to.
  const lv = [];
  for (const l of levels) {
    if (!fin(l.price) || l.price <= mn || l.price >= mx) continue;
    let a = i0, b = i1 - 1;
    if (l.date) { a = -1; b = -1; for (let i = i0; i < i1; i += 1) if (istDate(candles[i].t) === l.date) { if (a < 0) a = i; b = i; } if (a < 0) continue; }
    lv.push({ y: y(l.price), x1: Math.max(padL, xi(a) - cw / 2), x2: Math.min(padL + pw, xi(b) + cw / 2), label: l.label, color: l.color });
  }
  return { padL, padR, padT, padB, pw, ph, cw, mn, mx, candles: cs, vwap: vw, seps, ticks, grid, levels: lv, i0, i1, multiDay,
    last: lastVisible ? { y: y(lastC.c), price: lastC.c, up: lastC.c >= lastC.o } : null };
}

// Structured geometry -> SVG path strings (few elements: fast on phones).
export function toPaths(g) {
  const w = { up: '', dn: '' }, b = { up: '', dn: '' };
  for (const c of g.candles) {
    const k = c.up ? 'up' : 'dn', x = c.x.toFixed(1);
    w[k] += `M${x} ${c.yH.toFixed(1)}L${x} ${c.yL.toFixed(1)}`;
    b[k] += `M${(c.x - c.bw / 2).toFixed(1)} ${c.yTop.toFixed(1)}h${c.bw.toFixed(1)}v${c.hBody.toFixed(1)}h${(-c.bw).toFixed(1)}Z`;
  }
  const vwap = g.vwap.filter((p) => p.length > 1).map((p) => p.map((q, i) => `${i ? 'L' : 'M'}${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join('')).join('');
  return { wickUp: w.up, wickDn: w.dn, bodyUp: b.up, bodyDn: b.dn, vwap };
}

// ---------------------------------------------------------------- status
// One decision for what the chart area says. Priority: loading > no data > insufficient > disconnected > stale > closed > live.
// `fresh` = computeCandleFreshness() result, `link` = 'OK' | 'DISCONNECTED' (REST), `series` = describeSeries() info.
export function chartStatus({ n, loading, err, link, fresh, series, marketOpen, tfLabel }) {
  if (!n) return loading ? { kind: 'LOADING', text: 'Loading candles...', tone: 'muted', draw: false }
    : { kind: 'NO_DATA', text: `NO CHART DATA${err ? ': ' + err : ' returned for ' + (tfLabel || 'this timeframe')}`, tone: 'red', draw: false };
  if (n < MIN_DRAW) return { kind: 'INSUFFICIENT', text: `Only ${n} candle${n === 1 ? '' : 's'} so far (need ${MIN_DRAW}). Chart appears as the session builds.`, tone: 'amber', draw: false };
  if (link === 'DISCONNECTED') return { kind: 'DISCONNECTED', text: 'DISCONNECTED: showing the last candles that were loaded. Not live.', tone: 'red', draw: true, dim: true };
  if (fresh && fresh.status === 'STALE') {
    const why = { NOT_REFRESHED: 'chart not refreshed recently', NO_RECENT_CANDLE: 'no recent candle', PREVIOUS_SESSION: "not today's candles", FUTURE_TIMESTAMP: 'candle timestamp is in the future', INVALID_TIMESTAMP: 'invalid candle timestamp' }[fresh.reason] || 'data is old';
    return { kind: 'STALE', text: `STALE: ${why}.`, tone: 'amber', draw: true, dim: true };
  }
  if (!marketOpen) return { kind: 'CLOSED', text: `MARKET CLOSED: showing the last available session${series && series.date ? ' ' + fmtDMY(series.date) : ''}.`, tone: 'amber', draw: true };
  return { kind: 'LIVE', text: 'LIVE SESSION', tone: 'green', draw: true };
}
