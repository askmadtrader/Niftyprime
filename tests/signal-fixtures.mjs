// Deterministic test fixtures for the signal engine (test data only; the app never fabricates data).
import assert from 'node:assert/strict';
import { buildInstrument, NIFTY_KEY, VIX_KEY } from '../src/feed/feedState';
import { computeFreshness, computeCandleFreshness, computeChainFreshness, THRESHOLDS } from '../src/feed/freshness';
import { MS } from '../src/feed/marketStatus';
import { parseChain } from '../src/chain';
import { makeSample, pushSample } from '../src/pcriv';

// ---------------------------------------------------------------- fixtures (test data only; the app never fabricates data)
export const ist = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s) - 5.5 * 3600e3;
export const D = [2030, 3, 4];                       // Mon 04-Mar-2030
export const EXP = '2030-03-07';
export const at = (h, mi, s = 0) => ist(...D, h, mi, s);
export const cd = (t, o, h, l, c, v = 0) => ({ t, o, h, l, c, v });

// 1-minute candles from closes (open = previous close), starting 09:15
export function candlesFrom(closes, day = D) {
  return closes.map((c, i) => { const o = i ? closes[i - 1] : c; return cd(ist(...day, 9, 15 + i), o, Math.max(o, c) + 1, Math.min(o, c) - 1, c); });
}
// opening range chop (15 candles around `base`), then a steady move of `step` per minute for `n` minutes
export function path({ base = 24420, step = 2, n = 30, orSwing = 4 } = {}) {
  const closes = [];
  for (let i = 0; i < 15; i++) closes.push(base + (i % 2 ? orSwing : -orSwing) / 2);
  let p = closes[closes.length - 1];
  for (let i = 0; i < n; i++) { p += step; closes.push(p); }
  return closes;
}

export const NIFTY_PRICE = (closes) => closes[closes.length - 1];

// Option chain, shaped like the Upstox response and parsed by the REAL Part 4 parser.
export function rawChain({ spot, callBase = 300000, putBase = 340000, callPeak = [24700, 900000], putPeak = [24300, 900000], putGrowth = 0.12, callGrowth = -0.02,
  callQuote = {}, putQuote = {}, expiry = EXP, spotField = spot, theta = -8, strikes = null } = {}) {
  let key = 1000;
  const list = [];
  const atmS = Math.round(spot / 50) * 50;
  const ks = strikes || Array.from({ length: 21 }, (_, i) => 24000 + i * 50);
  for (const s of ks) {
    const cOi = s === callPeak[0] ? callPeak[1] : callBase, pOi = s === putPeak[0] ? putPeak[1] : putBase;
    const cDelta = Math.max(0.02, Math.min(0.98, 0.5 + (24500 - s) / 1200));
    const mk = (type, oi, growth, delta, q) => {
      const intrinsic = type === 'C' ? Math.max(0, spot - s) : Math.max(0, s - spot);
      const ltp = Math.max(5, intrinsic + Math.max(5, 150 - Math.abs(spot - s) * 0.4));
      const m = { ltp, volume: 250000, oi, prev_oi: Math.round(oi / (1 + growth)), bid_price: ltp - 0.1, ask_price: ltp + 0.1, bid_qty: 1500, ask_qty: 1500, ...q };
      return { instrument_key: `NSE_FO|${key++}`, market_data: m, option_greeks: { delta, iv: 12, theta, gamma: 0.001, vega: 8, pop: 50 } };
    };
    list.push({ expiry, strike_price: s, underlying_key: NIFTY_KEY, underlying_spot_price: spotField,
      call_options: mk('C', cOi, callGrowth, cDelta, s === atmS ? callQuote : {}), put_options: mk('P', pOi, putGrowth, cDelta - 1, s === atmS ? putQuote : {}) });
  }
  return list;
}

// One consistent scene built with the app's own freshness functions.
export function snapshot(o = {}) {
  const closes = o.closes || path();
  const candles = o.candles || candlesFrom(closes);
  const n = candles.length;
  const now = o.now !== undefined ? o.now : at(9, 15 + n, 20);
  const ltp = o.ltp !== undefined ? o.ltp : NIFTY_PRICE(closes);
  const market = o.market || MS.OPEN;
  const conn = o.conn || 'LIVE';
  const ltt = o.ltt !== undefined ? o.ltt : now - 2000;
  const quote = o.noQuote ? null : buildInstrument(NIFTY_KEY, { ltpc: { ltp, ltt, cp: 24300 }, ohlc: [] }, null, now - (o.quoteAge ?? 1000), now);
  const niftyFresh = computeFreshness({ inst: quote, conn, marketState: market, now, serverNow: now, th: THRESHOLDS.nifty });
  const info = { kind: 'CURRENT', date: '2030-03-04', lastT: candles.length ? candles[candles.length - 1].t : 0, count: candles.length };
  const candlesFresh = computeCandleFreshness({ info, receivedAt: now - 2000, link: conn === 'LIVE' ? 'OK' : 'DISCONNECTED', marketState: market, now, serverNow: now, tfMin: 1 });
  const expiry = o.expiry || EXP;
  const rows = o.rows || parseChain(rawChain({ spot: ltp, ...(o.chain || {}) }), expiry, NIFTY_KEY).rows;
  const chainReq = o.chainRequestedState || market;
  const chainAge = o.chainAge ?? 1000;
  const chainFresh = computeChainFreshness({ chain: rows, receivedAt: now - chainAge, requestedMarketState: chainReq, link: 'OK', marketState: market, now });
  const vixQuote = o.vix === null ? null : buildInstrument(VIX_KEY, { ltpc: { ltp: o.vixLtp ?? 14, ltt: now - 3000, cp: o.vixPrev ?? 14 }, ohlc: [] }, null, now - 1000, now);
  const vixFresh = computeFreshness({ inst: vixQuote, conn, marketState: market, now, serverNow: now, th: THRESHOLDS.vix });
  let hist = [];
  if (o.history) {
    const rowsThen = o.history.rows || rows;
    hist = pushSample(hist, makeSample({ rows: rowsThen, expiry, spot: o.history.spot ?? ltp, at: now - 5 * 60000 }));
  }
  return {
    now, conn, market: { state: market, fno: market }, nifty: quote, niftyFresh, candles, candlesFresh,
    chain: { rows, expiry, chainExpiry: o.chainExpiry || expiry, fresh: chainFresh, receivedAt: now - chainAge }, expiry, lotSize: 75,
    vix: vixQuote, vixFresh, global: o.global || null, pcrIvHistory: hist,
  };
}

export const BULL = () => snapshot();
export const BEAR = () => snapshot({
  closes: path({ base: 24600, step: -2 }), chain: { callBase: 340000, putBase: 300000, callPeak: [24700, 900000], putPeak: [24300, 900000], putGrowth: -0.02, callGrowth: 0.12 },
  vixLtp: 15, vixPrev: 14,
});
export const probsOk = (r) => {
  const p = r.probabilities;
  for (const k of ['CALL', 'PUT', 'WAIT']) assert.ok(Number.isInteger(p[k]) && p[k] >= 0 && p[k] <= 100, `${k} = ${p[k]}`);
  assert.equal(p.CALL + p.PUT + p.WAIT, 100);
  assert.equal(r.callProbability, p.CALL); assert.equal(r.putProbability, p.PUT); assert.equal(r.waitProbability, p.WAIT);
};

