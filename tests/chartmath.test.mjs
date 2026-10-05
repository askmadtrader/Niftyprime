import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TF_CONFIG, TF_LIST, MIN_DRAW, RIGHT_PAD, validCandle, mergeCandles, vwapBySession, sessionStats,
  defaultView, clampView, panView, panByCandles, zoomView, visibleRange, buildGeometry, toPaths, axisLabel, chartStatus,
} from '../src/chartmath';

// IST wall clock -> epoch ms (test fixtures only; the app never fabricates candles)
const ist = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) - 5.5 * 3600e3;
const cd = (t, o, h, l, c, v = 0) => ({ t, o, h, l, c, v });
// n 1-minute candles starting 09:15 IST on the given day
function day(y, mo, d, n, base = 22000) {
  return Array.from({ length: n }, (_, i) => { const p = base + i; return cd(ist(y, mo, d, 9, 15 + i), p, p + 4, p - 3, p + 1); });
}

test('timeframes: 1m 5m 15m 30m and a native Upstox 1h (hours/1)', () => {
  assert.deepEqual(TF_LIST, [1, 5, 15, 30, 60]);
  assert.deepEqual([TF_CONFIG[1].unit, TF_CONFIG[1].interval], ['minutes', 1]);
  assert.deepEqual([TF_CONFIG[30].unit, TF_CONFIG[30].interval], ['minutes', 30]);
  assert.deepEqual([TF_CONFIG[60].unit, TF_CONFIG[60].interval, TF_CONFIG[60].label], ['hours', 1, '1h']);
  for (const t of TF_LIST) assert.ok(TF_CONFIG[t].chunkDays <= TF_CONFIG[t].lookbackDays);
});

test('validCandle drops inconsistent rows instead of repairing them', () => {
  assert.ok(validCandle(cd(1, 10, 12, 9, 11)));
  assert.ok(!validCandle(cd(1, 10, 9, 12, 11)));      // high < low
  assert.ok(!validCandle(cd(1, 10, 10, 9, 11)));      // close above high
  assert.ok(!validCandle(cd(NaN, 10, 12, 9, 11)));
  assert.ok(!validCandle(cd(1, 10, 12, 0, 11)));      // zero low = no price
  assert.ok(!validCandle(null));
});

test('mergeCandles: sorted, de-duplicated by timestamp, later list wins', () => {
  const a = [cd(3, 1, 2, 1, 2), cd(1, 1, 2, 1, 2)];
  const b = [cd(3, 5, 6, 4, 5), cd(2, 1, 2, 1, 2), cd(9, 9, 1, 9, 9)];
  const m = mergeCandles(a, b);
  assert.deepEqual(m.map((c) => c.t), [1, 2, 3]);
  assert.equal(m[2].o, 5);
  assert.deepEqual(mergeCandles(), []);
  assert.deepEqual(mergeCandles(null, undefined), []);
});

test('VWAP restarts every IST trading date and does not depend on how the history is paged', () => {
  const d1 = day(2026, 9, 30, 4, 100), d2 = day(2026, 10, 1, 4, 500);
  const all = [...d1, ...d2];
  const v = vwapBySession(all);
  assert.equal(v.length, 8);
  const tp = (c) => (c.h + c.l + c.c) / 3;
  assert.ok(Math.abs(v[4] - tp(d2[0])) < 1e-9, 'first candle of day 2 = its own typical price (no carry-over from day 1)');
  assert.ok(Math.abs(v[3] - (tp(d1[0]) + tp(d1[1]) + tp(d1[2]) + tp(d1[3])) / 4) < 1e-9);
  assert.deepEqual(vwapBySession(all).slice(4), vwapBySession(d2));
});

test('VWAP weights by volume when the candles carry volume', () => {
  const cs = [cd(ist(2026, 10, 1, 9, 15), 100, 100, 100, 100, 1), cd(ist(2026, 10, 1, 9, 16), 200, 200, 200, 200, 3)];
  assert.ok(Math.abs(vwapBySession(cs)[1] - 175) < 1e-9);
});

test('sessionStats covers the NEWEST session only', () => {
  const all = [...day(2026, 9, 30, 5, 100), ...day(2026, 10, 1, 3, 500)];
  const s = sessionStats(all);
  assert.equal(s.date, '2026-10-01'); assert.equal(s.count, 3); assert.equal(s.startIdx, 5);
  assert.equal(s.high, 506); assert.equal(s.low, 497); assert.equal(s.open, 500); assert.equal(s.last, 503);
  assert.equal(sessionStats([]), null);
});

test('viewport: defaults pin to the latest candle; count and edges are clamped', () => {
  const v = defaultView(500, 375);
  assert.equal(v.pinned, true); assert.equal(v.end, 500 + RIGHT_PAD); assert.equal(v.count, 120);
  assert.equal(defaultView(100, 25).count, 40);
  assert.equal(defaultView(20, 20).count, 20 + RIGHT_PAD);        // fewer candles than the default window: show them all, whole history visible
  const c = clampView({ count: 9999, end: -50, pinned: false }, 500);
  assert.equal(c.count, 300); assert.equal(c.end, 300);           // cannot pan before the first candle
  assert.equal(clampView({ count: 2, end: 10, pinned: false }, 500).count, 12);
});

test('pan: dragging right goes back in time, dragging left comes forward; stops at both ends', () => {
  const n = 500, plotW = 300;
  let v = defaultView(n, 100);                                    // count 102 -> 2.94 px / candle
  const back = panView(v, 100, plotW, n);
  assert.ok(back.end < v.end && back.pinned === false);
  assert.ok(Math.abs((v.end - back.end) - 100 / (plotW / v.count)) < 1e-9);
  const fwd = panView(back, -100, plotW, n);
  assert.ok(Math.abs(fwd.end - v.end) < 1e-9 && fwd.pinned);      // back at the newest candle => pinned again
  assert.equal(panView(v, 1e6, plotW, n).end, v.count);           // oldest edge
  assert.equal(panView(v, -1e6, plotW, n).end, n + RIGHT_PAD);    // newest edge
  assert.equal(panByCandles(v, -10, n).end, v.end - 10);
});

test('zoom keeps the candle under the focal point fixed', () => {
  const n = 800, v0 = clampView({ count: 100, end: 400, pinned: false }, n);
  for (const f of [0, 0.25, 0.5, 1]) {
    const v1 = zoomView(v0, 50, f, n);
    assert.equal(v1.count, 50);
    const idx0 = (v0.end - v0.count) + f * v0.count, idx1 = (v1.end - v1.count) + f * v1.count;
    assert.ok(Math.abs(idx0 - idx1) < 1e-9, `focal ${f}`);
  }
  assert.equal(zoomView(v0, 1, 0.5, n).count, 12);                // min zoom
  assert.equal(zoomView(v0, 1e6, 0.5, n).count, 300);             // max zoom
});

test('visibleRange maps the viewport to candle indices', () => {
  const r = visibleRange({ count: 10, end: 25.5, pinned: false }, 100);
  assert.deepEqual([r.i0, r.i1], [15, 26]);
  assert.deepEqual([visibleRange({ count: 10, end: 103, pinned: true }, 100).i0, visibleRange({ count: 10, end: 103, pinned: true }, 100).i1], [93, 100]);
});

test('IST labels: 09:15 IST, never UTC or device time', () => {
  const t = ist(2026, 10, 1, 9, 15);
  assert.equal(new Date(t).toISOString(), '2026-10-01T03:45:00.000Z');
  assert.equal(axisLabel(t, false), '09:15');
  assert.equal(axisLabel(t, true), '01 OCT 09:15');
  assert.equal(axisLabel(ist(2026, 10, 1, 15, 29), false), '15:29');
});

function geo(candles, view, extra = {}) {
  return buildGeometry({ candles, vwap: vwapBySession(candles), view, width: 360, height: 380, ...extra });
}

test('geometry: finite, inside the plot, prices map top=high bottom=low', () => {
  const cs = day(2026, 10, 1, 60);
  const g = geo(cs, defaultView(60, 60));
  assert.equal(g.candles.length, 60, 'all candles of a short series are visible');
  for (const c of g.candles) {
    for (const k of ['x', 'yH', 'yL', 'yTop', 'hBody']) assert.ok(Number.isFinite(c[k]), k);
    assert.ok(c.yH <= c.yTop + 1e-9 && c.yL >= c.yTop - 1e-9);
    assert.ok(c.x > g.padL && c.x < g.padL + g.pw);
    assert.ok(c.yH >= g.padT - 1 && c.yL <= g.padT + g.ph + 1);
  }
  assert.ok(g.candles[59].yH < g.candles[0].yH, 'rising series: later highs are higher on screen (smaller y)');
  assert.equal(g.ticks.length, 4); assert.equal(g.ticks[0].label, '09:15');
  assert.equal(g.multiDay, false); assert.equal(g.seps.length, 0);
  assert.ok(g.last && Math.abs(g.last.price - cs[59].c) < 1e-9);
  const p = toPaths(g); assert.ok(p.wickUp.startsWith('M') && p.bodyUp.endsWith('Z') && p.vwap.startsWith('M'));
  assert.ok(!/NaN|undefined|Infinity/.test(JSON.stringify(p)));
});

test('geometry: only the visible window is built; scrolled back hides the newest price tag', () => {
  const cs = [...day(2026, 9, 29, 60, 21000), ...day(2026, 9, 30, 60, 21500), ...day(2026, 10, 1, 60, 22000)];
  const newest = geo(cs, defaultView(180, 60));
  const older = geo(cs, panByCandles(defaultView(180, 60), -90, 180));
  assert.ok(newest.candles.length <= 63 && older.candles.length <= 63);
  assert.ok(newest.last !== null && older.last === null);
  assert.ok(older.mn < newest.mn, 'y-axis re-scales to the visible (older, lower) candles');
  assert.ok(older.candles.every((c) => c.i < 180 - 80));
});

test('geometry: session separators, per-day VWAP pieces, multi-day tick labels', () => {
  const cs = [...day(2026, 9, 30, 30, 21500), ...day(2026, 10, 1, 30, 22000)];
  const g = geo(cs, clampView({ count: 63, end: 63, pinned: true }, 60));
  assert.equal(g.seps.length, 1); assert.equal(g.seps[0].label, '01 OCT');
  assert.equal(g.vwap.length, 2, 'VWAP is two separate lines, not one line jumping across the day gap');
  assert.equal(g.multiDay, true); assert.match(g.ticks[0].label, /^30 SEP 09:15$/);
});

test('geometry: levels are drawn only over their own session and only inside the price range', () => {
  const cs = [...day(2026, 9, 30, 30, 21500), ...day(2026, 10, 1, 30, 22000)];
  const lv = [
    { price: 22010, label: 'Sess H', color: 'x', date: '2026-10-01' },
    { price: 21510, label: 'old', color: 'y', date: '2026-10-01' },   // inside range but on the other day's candles? same date filter
    { price: 99999, label: 'off', color: 'z', date: '2026-10-01' },   // far outside the window
    { price: 21505, label: 'prev', color: 'w', date: '2026-09-30' },
  ];
  const g = geo(cs, clampView({ count: 63, end: 63, pinned: true }, 60), { levels: lv });
  const by = Object.fromEntries(g.levels.map((l) => [l.label, l]));
  assert.ok(by['Sess H'] && by.prev && !by.off);
  assert.ok(by['Sess H'].x1 >= g.seps[0].x - 1, "today's level starts at today's first candle");
  assert.ok(by.prev.x2 <= g.seps[0].x + 1, "yesterday's level stops at the session boundary");
});

test('geometry: flat series and a single visible price do not divide by zero', () => {
  const cs = Array.from({ length: 5 }, (_, i) => cd(ist(2026, 10, 1, 9, 15 + i), 22000, 22000, 22000, 22000));
  const g = geo(cs, defaultView(5, 5));
  assert.ok(g.candles.every((c) => Number.isFinite(c.yH) && Number.isFinite(c.yL)));
  assert.ok(Number.isFinite(g.mn) && g.mx > g.mn);
});

const live = { status: 'LIVE' }, ok = { status: 'FRESH' };
const base = { n: 100, loading: false, err: '', link: 'OK', fresh: live, series: { date: '2026-10-01' }, marketOpen: true, tfLabel: '15m' };

test('status: loading, no data, insufficient candles', () => {
  assert.equal(chartStatus({ ...base, n: 0, loading: true }).kind, 'LOADING');
  const nd = chartStatus({ ...base, n: 0, err: 'Network error: timeout' });
  assert.equal(nd.kind, 'NO_DATA'); assert.match(nd.text, /timeout/); assert.equal(nd.draw, false);
  assert.equal(chartStatus({ ...base, n: 0 }).kind, 'NO_DATA');
  for (const n of [1, MIN_DRAW - 1]) { const r = chartStatus({ ...base, n }); assert.equal(r.kind, 'INSUFFICIENT'); assert.equal(r.draw, false); }
  assert.equal(chartStatus({ ...base, n: MIN_DRAW }).draw, true);
});

test('status: disconnected beats stale; stale is dimmed and says why', () => {
  const d = chartStatus({ ...base, link: 'DISCONNECTED', fresh: { status: 'DISCONNECTED' } });
  assert.equal(d.kind, 'DISCONNECTED'); assert.equal(d.dim, true); assert.equal(d.draw, true);
  const s = chartStatus({ ...base, fresh: { status: 'STALE', reason: 'NOT_REFRESHED' } });
  assert.equal(s.kind, 'STALE'); assert.match(s.text, /not refreshed/); assert.equal(s.dim, true);
  assert.match(chartStatus({ ...base, fresh: { status: 'STALE', reason: 'PREVIOUS_SESSION' } }).text, /not today/);
});

test('status: market closed names the session date; open + fresh is LIVE', () => {
  const c = chartStatus({ ...base, marketOpen: false, fresh: ok });
  assert.equal(c.kind, 'CLOSED'); assert.match(c.text, /01-OCT-2026/); assert.equal(c.draw, true); assert.ok(!c.dim);
  assert.equal(chartStatus(base).kind, 'LIVE');
});
