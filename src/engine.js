import { istMinutes, clamp, compact, f2, signed } from './util';

// Factor weights (sum = 103). Each factor splits its weight into bull / bear / neutral parts.
export const W = { vwapPos: 12, vwapSlope: 5, orPos: 12, structure: 10, momentum: 10, dayChg: 5, srProx: 8, oiFlow: 14, pcr: 8, iv: 4, vix: 4, global: 5, consol: 6 };
const W_TOTAL = Object.values(W).reduce((a, b) => a + b, 0);
export const SENS = { LOW: 0.20, MED: 0.14, HIGH: 0.09 };

const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const sum = (arr, fn) => arr.reduce((a, r) => { const v = fn(r); return a + (typeof v === 'number' && isFinite(v) ? v : 0); }, 0);

export function ema(vals, n) {
  if (vals.length < n) return null;
  const k = 2 / (n + 1);
  let e = vals.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < vals.length; i++) e = vals[i] * k + e * (1 - k);
  return e;
}

export function vwapSeries(cs) {
  const hasVol = cs.some((c) => c.v > 0);
  let pv = 0, vv = 0; const series = [];
  for (const c of cs) {
    const tp = (c.h + c.l + c.c) / 3; const w = hasVol ? c.v : 1;
    pv += tp * w; vv += w; series.push(vv > 0 ? pv / vv : tp);
  }
  return { series, volumeBased: hasVol };
}

export function aggregate(cs, mins) {
  const ms = mins * 60000; const out = []; let cur = null;
  for (const c of cs) {
    const b = Math.floor(c.t / ms) * ms;
    if (!cur || cur.t !== b) { if (cur) out.push(cur); cur = { t: b, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v }; }
    else { cur.h = Math.max(cur.h, c.h); cur.l = Math.min(cur.l, c.l); cur.c = c.c; cur.v += c.v; }
  }
  if (cur) out.push(cur);
  return out;
}

function pivots(cs, k = 2) {
  const hi = [], lo = [];
  for (let i = k; i < cs.length - k; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= k; j++) {
      if (!(cs[i].h > cs[i - j].h && cs[i].h >= cs[i + j].h)) isH = false;
      if (!(cs[i].l < cs[i - j].l && cs[i].l <= cs[i + j].l)) isL = false;
    }
    if (isH) hi.push(cs[i].h);
    if (isL) lo.push(cs[i].l);
  }
  return { hi, lo };
}

function computeTech(cs, spot) {
  if (!cs.length) return null;
  const closes = cs.map((c) => c.c);
  const last = spot != null ? spot : closes[closes.length - 1];
  const { series, volumeBased } = vwapSeries(cs);
  const vwap = series[series.length - 1];
  const back = series[Math.max(0, series.length - 16)];
  const slopePct = back ? ((vwap - back) / back) * 100 : 0;
  const vwapDir = slopePct > 0.01 ? 'RISING' : slopePct < -0.01 ? 'FALLING' : 'FLAT';
  const dist = ((last - vwap) / vwap) * 100;
  const priceVsVwap = Math.abs(dist) < 0.02 ? 'AT' : dist > 0 ? 'ABOVE' : 'BELOW';
  const orC = cs.filter((c) => { const m = istMinutes(c.t); return m >= 555 && m < 570; });
  const orFormed = orC.length > 0 && cs.some((c) => istMinutes(c.t) >= 570);
  const orHigh = orC.length ? Math.max(...orC.map((c) => c.h)) : null;
  const orLow = orC.length ? Math.min(...orC.map((c) => c.l)) : null;
  let orState = 'FORMING';
  if (orFormed) orState = last > orHigh ? 'ABOVE' : last < orLow ? 'BELOW' : 'INSIDE';
  const dayHigh = Math.max(...cs.map((c) => c.h));
  const dayLow = Math.min(...cs.map((c) => c.l));
  const pv = pivots(aggregate(cs, 5), 2);
  let structure = null;
  if (pv.hi.length >= 2 && pv.lo.length >= 2) {
    const hh = pv.hi[pv.hi.length - 1] > pv.hi[pv.hi.length - 2];
    const hl = pv.lo[pv.lo.length - 1] > pv.lo[pv.lo.length - 2];
    structure = { hh, hl, lh: !hh, ll: !hl };
  }
  const e9 = ema(closes, 9), e21 = ema(closes, 21);
  const ref = closes[Math.max(0, closes.length - 16)];
  const roc15 = ref ? ((last - ref) / ref) * 100 : null;
  const ref5 = closes[Math.max(0, closes.length - 6)];
  const roc5 = ref5 ? ((last - ref5) / ref5) * 100 : null;
  const s30 = cs.slice(-30);
  const rng30 = s30.length >= 20 ? ((Math.max(...s30.map((c) => c.h)) - Math.min(...s30.map((c) => c.l))) / last) * 100 : null;
  const consolidating = rng30 !== null && rng30 < 0.15;
  let trend = 'SIDEWAYS';
  if (structure && structure.hh && structure.hl) trend = 'UPTREND (HH + HL)';
  else if (structure && structure.lh && structure.ll) trend = 'DOWNTREND (LH + LL)';
  else if (e9 !== null && e21 !== null && Math.abs(e9 - e21) / last * 100 > 0.02) trend = e9 > e21 ? 'MILD UP' : 'MILD DOWN';
  let momentum = 'FLAT';
  if (e9 !== null && e21 !== null && roc15 !== null) {
    if (e9 > e21 && roc15 > 0) momentum = 'POSITIVE'; else if (e9 < e21 && roc15 < 0) momentum = 'NEGATIVE'; else momentum = 'MIXED';
  }
  let reversal = null;
  if (roc15 !== null && roc5 !== null && Math.abs(roc15) >= 0.1 && Math.abs(roc5) >= 0.06 && sgn(roc15) !== sgn(roc5)) {
    reversal = roc15 > 0 ? 'Possible reversal: rally fading' : 'Possible reversal: selloff fading';
  }
  const breakout = cs.length > 30 && last >= dayHigh ? 'NEW DAY HIGH' : cs.length > 30 && last <= dayLow ? 'NEW DAY LOW' : null;
  const step = Math.max(1, Math.ceil(closes.length / 80));
  const spark = closes.filter((_, i) => i % step === 0 || i === closes.length - 1);
  return { vwap, vwapVolumeBased: volumeBased, vwapDir, slopePct, dist, priceVsVwap, orHigh, orLow, orFormed, orState, dayHigh, dayLow,
    structure, e9, e21, roc15, roc5, rng30, consolidating, trend, momentum, reversal, breakout, spark, lastClose: closes[closes.length - 1] };
}

function computeChain(rows, spot, nView) {
  const valid = rows.filter((r) => r.strike != null);
  if (valid.length < 5 || spot == null) return null;
  let ai = 0, best = Infinity;
  valid.forEach((r, i) => { const d = Math.abs(r.strike - spot); if (d < best) { best = d; ai = i; } });
  const atm = valid[ai];
  const steps = []; for (let i = 1; i < valid.length; i++) steps.push(valid[i].strike - valid[i - 1].strike);
  steps.sort((a, b) => a - b);
  const step = steps.length ? steps[Math.floor(steps.length / 2)] : 50;
  const view = valid.slice(Math.max(0, ai - nView), Math.min(valid.length - 1, ai + nView) + 1);
  const win = valid.slice(Math.max(0, ai - 5), Math.min(valid.length - 1, ai + 5) + 1);
  const wall = valid.slice(Math.max(0, ai - 10), Math.min(valid.length - 1, ai + 10) + 1);
  const argmax = (arr, fn) => { let b = null, bv = 0; arr.forEach((r) => { const v = fn(r); if (typeof v === 'number' && v > bv) { bv = v; b = r; } }); return b; };
  const callOiTot = sum(valid, (r) => r.call.oi), putOiTot = sum(valid, (r) => r.put.oi);
  const wCall = sum(win, (r) => r.call.oi), wPut = sum(win, (r) => r.put.oi);
  const callChg = sum(win, (r) => (r.call.oi != null && r.call.prevOi != null ? r.call.oi - r.call.prevOi : 0));
  const putChg = sum(win, (r) => (r.put.oi != null && r.put.prevOi != null ? r.put.oi - r.put.prevOi : 0));
  const ivs = [atm.call.iv, atm.put.iv].filter((v) => v != null && v > 0);
  const atmIv = ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null;
  const maxCall = argmax(wall, (r) => r.call.oi), maxPut = argmax(wall, (r) => r.put.oi);
  const R = argmax(wall.filter((r) => r.strike >= spot), (r) => r.call.oi);
  const S = argmax(wall.filter((r) => r.strike <= spot), (r) => r.put.oi);
  const topN = (arr, fn, n) => arr.filter((r) => (fn(r) || 0) > 0).sort((a, b) => fn(b) - fn(a)).slice(0, n);
  const oiMap = {}; win.forEach((r) => { oiMap[r.strike] = [r.call.oi || 0, r.put.oi || 0]; });
  return {
    atm, atmIdx: ai, valid, view, win, wall, step, callOiTot, putOiTot, wCall, wPut, callChg, putChg,
    pcrTotal: callOiTot > 0 ? putOiTot / callOiTot : null, pcrRel: wCall > 0 ? wPut / wCall : null,
    atmIv, ivSkew: atm.call.iv > 0 && atm.put.iv > 0 ? atm.call.iv - atm.put.iv : null,
    maxCall: maxCall ? maxCall.strike : null, maxPut: maxPut ? maxPut.strike : null,
    maxCallOi: maxCall ? maxCall.call.oi : null, maxPutOi: maxPut ? maxPut.put.oi : null,
    R: R ? { strike: R.strike, oi: R.call.oi } : null, S: S ? { strike: S.strike, oi: S.put.oi } : null,
    topCalls: topN(wall.filter((r) => r.strike > spot), (r) => r.call.oi, 2).map((r) => ({ strike: r.strike, oi: r.call.oi })),
    topPuts: topN(wall.filter((r) => r.strike < spot), (r) => r.put.oi, 2).map((r) => ({ strike: r.strike, oi: r.put.oi })),
    volWin: sum(win, (r) => r.call.vol) + sum(win, (r) => r.put.vol), oiMap,
  };
}

function pastSnap(history, now, minAge) {
  for (let i = history.length - 1; i >= 0; i--) if (now - history[i].t >= minAge) return history[i];
  return null;
}

function recommend(sideName, ch, spot, atmIv) {
  const key = sideName === 'CALL' ? 'call' : 'put';
  const cands = [];
  for (let i = Math.max(0, ch.atmIdx - 3); i <= Math.min(ch.valid.length - 1, ch.atmIdx + 3); i++) {
    const r = ch.valid[i]; const o = r[key];
    if (!(o.ltp > 0 && o.bid > 0 && o.ask > 0 && o.ask >= o.bid && o.oi > 0 && o.vol > 0 && o.delta != null && o.iv > 0)) continue;
    if (Math.abs(o.delta) < 0.25 || Math.abs(o.delta) > 0.85) continue;
    cands.push({ r, o, idx: i, dist: Math.abs(i - ch.atmIdx) });
  }
  if (!cands.length) return null;
  const maxVol = Math.max(...cands.map((c) => c.o.vol)), maxOi = Math.max(...cands.map((c) => c.o.oi));
  const maxGam = Math.max(...cands.map((c) => c.o.gamma || 0), 1e-9);
  cands.forEach((c) => {
    const o = c.o;
    const spreadPct = ((o.ask - o.bid) / ((o.ask + o.bid) / 2)) * 100;
    const liq = 0.5 * Math.min(1, Math.log10(o.vol + 1) / Math.log10(maxVol + 1)) + 0.5 * Math.min(1, Math.log10(o.oi + 1) / Math.log10(maxOi + 1));
    const spr = 1 - Math.min(1, spreadPct / 5);
    const dlt = 1 - Math.min(1, Math.abs(Math.abs(o.delta) - 0.5) / 0.25);
    const thetaPct = o.theta != null ? (Math.abs(o.theta) / o.ltp) * 100 : 20;
    const th = 1 - Math.min(1, thetaPct / 20);
    const gm = (o.gamma || 0) / maxGam;
    const ratio = atmIv ? o.iv / atmIv : 1;
    const ivS = ratio > 1 ? 1 - clamp((ratio - 1) / 0.3, 0, 1) : 1;
    const dis = 1 - c.dist / 4;
    c.spreadPct = spreadPct; c.thetaPct = thetaPct;
    c.score = 0.22 * liq + 0.2 * spr + 0.2 * dlt + 0.12 * th + 0.08 * gm + 0.08 * ivS + 0.1 * dis;
  });
  cands.sort((a, b) => b.score - a.score);
  const b = cands[0]; const o = b.o;
  const moneyness = b.dist === 0 ? 'ATM' : (sideName === 'CALL' ? b.r.strike < spot : b.r.strike > spot) ? `ITM (${b.dist} step)` : `OTM (${b.dist} step)`;
  return {
    side: sideName, strike: b.r.strike, key: o.key, ltp: o.ltp, iv: o.iv, delta: o.delta, theta: o.theta, gamma: o.gamma, vega: o.vega,
    oi: o.oi, vol: o.vol, bid: o.bid, ask: o.ask, spreadPct: b.spreadPct, moneyness, score: b.score,
    reason: `${moneyness}, delta ${f2(o.delta)} (balanced between cost and responsiveness), spread ${f2(b.spreadPct)}%, OI ${compact(o.oi)}, volume ${compact(o.vol)}, theta ${f2(o.theta, 1)}/day = ${f2(b.thetaPct, 1)}% of premium, IV ${f2(o.iv, 1)}${atmIv ? ` vs ATM ${f2(atmIv, 1)}` : ''}. Within 3 strikes of ATM; no deep OTM.`,
  };
}

function mk(id, label, w, side, strength, text) {
  return { id, label, w, side, strength: side === 'neutral' ? 0 : clamp(strength, 0, 1), text };
}

export function analyze(inp) {
  const { now, sNow, gate, session, quote, vix, candles, chain, chainAt, chainFresh, global, history, settings, expiry } = inp;
  const out = {
    ts: now, live: false, signal: 'WAIT', confidence: null, lead: null, leadConf: null, bull: 0, bear: 0, neutral: 100, coverage: 0,
    factors: [], bullReasons: [], bearReasons: [], neutralReasons: [], waitReason: null, issues: [], tech: null, oi: null,
    levels: { supports: [], resistances: [], majorS: null, majorR: null }, view: [], atm: null, recommended: null, spot: null,
    maxCall: null, maxPut: null, snapshot: null, notes: [], gate: gate || null, session: session || null,
  };
  const spot = quote && quote.ltp != null ? quote.ltp : null;
  out.spot = spot;
  // `candles` were already restricted to a single session by selectCandles(): today's candles while the market is
  // live, otherwise the latest session (labelled PREVIOUS SESSION in `session`). Never mixed.
  const cs = Array.isArray(candles) ? candles : [];
  const tech = computeTech(cs, spot);
  out.tech = tech;
  const ch = chain && chain.length && spot != null ? computeChain(chain, spot, settings.strikes) : null;
  const nowMin = istMinutes(sNow != null ? sNow : now); // exchange-aligned clock, not the raw device clock

  // ---- data quality gate (feed state, market status, NIFTY freshness, current-session data)
  if (!gate) out.issues.push('Data-quality gate not evaluated');
  else if (!gate.ok) gate.reasons.forEach((r) => out.issues.push(r));
  const gateOk = !!gate && gate.ok;
  if (gateOk) {
    if (!cs.length) out.issues.push('Intraday candles unavailable');
    else if (cs.length < 15) out.issues.push('Too few candles today');
  }
  if (!ch) out.issues.push('Option chain unavailable');
  else {
    // same freshness rule the UI shows (age, link state, and "received before the market opened"); legacy age check as fallback
    if (chainFresh ? (chainFresh.status === 'STALE' || chainFresh.status === 'DISCONNECTED') : now - chainAt > 60000) out.issues.push('Option chain is stale');
    const withData = ch.win.filter((r) => r.call.ltp > 0 && r.put.ltp > 0).length;
    if (withData < 6) out.issues.push('Option chain has no live prices');
  }

  // ---- structural outputs (shown even when signal is withheld; they describe last available data)
  if (ch) {
    out.atm = ch.atm.strike; out.view = ch.view; out.maxCall = ch.maxCall; out.maxPut = ch.maxPut;
    const atmRow = ch.atm;
    const sinceOpt = (cur, prevV) => (prevV ? ((cur - prevV) / prevV) * 100 : null);
    const p5 = pastSnap(history, now, 300000) || (history.length && now - history[0].t >= 120000 ? history[0] : null);
    const pcrDelta = p5 && p5.pcr != null && ch.pcrRel != null ? ch.pcrRel - p5.pcr : null;
    const ivChgPct = p5 && p5.iv && ch.atmIv ? sinceOpt(ch.atmIv, p5.iv) : null;
    let bigMove = null;
    if (p5 && p5.oiMap) {
      Object.keys(ch.oiMap).forEach((k) => {
        const old = p5.oiMap[k]; if (!old) return;
        [0, 1].forEach((s) => {
          const cur = ch.oiMap[k][s], o = old[s];
          if (o >= 100000 && cur >= 0) {
            const pct = ((cur - o) / o) * 100; const d = cur - o;
            if (Math.abs(pct) >= 10 && Math.abs(d) >= 50000 && (!bigMove || Math.abs(pct) > Math.abs(bigMove.pct))) bigMove = { strike: Number(k), side: s === 0 ? 'CALL' : 'PUT', pct, delta: d };
          }
        });
      });
    }
    let volRatio = null;
    const s1 = pastSnap(history, now, 55000);
    const s10 = history.find((h) => now - h.t <= 720000);
    if (s1 && s10 && s1.t > s10.t + 120000) {
      const r1 = (ch.volWin - s1.vol) / ((now - s1.t) / 60000);
      const rA = (s1.vol - s10.vol) / ((s1.t - s10.t) / 60000);
      if (rA > 0 && r1 >= 0) volRatio = r1 / rA;
    }
    const thr = 0.01 * (ch.wCall + ch.wPut);
    const cls = (v) => (Math.abs(v) < thr ? 'flat' : v > 0 ? 'build' : 'unwind');
    const callState = cls(ch.callChg), putState = cls(ch.putChg);
    out.oi = {
      pcrTotal: ch.pcrTotal, pcrRel: ch.pcrRel, pcrDelta, atmIv: ch.atmIv, ivSkew: ch.ivSkew, ivChgPct,
      ivState: ivChgPct == null ? null : ivChgPct > 3 ? 'EXPANDING' : ivChgPct < -3 ? 'CONTRACTING' : 'STABLE',
      callChg: ch.callChg, putChg: ch.putChg, callState, putState, maxCall: ch.maxCall, maxPut: ch.maxPut,
      maxCallOi: ch.maxCallOi, maxPutOi: ch.maxPutOi, volWin: ch.volWin, callVol: sum(ch.win, (r) => r.call.vol), putVol: sum(ch.win, (r) => r.put.vol),
      bigMove, volRatio, relation: null,
      atmGreeks: { cd: atmRow.call.delta, pd: atmRow.put.delta, ct: atmRow.call.theta, pt: atmRow.put.theta, g: atmRow.call.gamma, v: atmRow.call.vega },
    };
    const dayPct = quote && quote.pct != null ? quote.pct : null;
    if (dayPct != null) {
      if (dayPct > 0 && putState === 'build') out.oi.relation = 'Price up with PUT OI buildup: PUT writers defending support (bullish).';
      else if (dayPct > 0 && callState === 'unwind') out.oi.relation = 'Price up with CALL unwinding: short covering (bullish).';
      else if (dayPct > 0 && callState === 'build') out.oi.relation = 'Price up but CALL OI building: resistance supply (caution).';
      else if (dayPct < 0 && callState === 'build') out.oi.relation = 'Price down with CALL OI buildup: CALL writers capping rallies (bearish).';
      else if (dayPct < 0 && putState === 'unwind') out.oi.relation = 'Price down with PUT unwinding: long unwinding (bearish).';
      else if (dayPct < 0 && putState === 'build') out.oi.relation = 'Price down but PUT OI building: dip buying / support forming (caution).';
    }
    out.snapshot = { t: now, pcr: ch.pcrRel, iv: ch.atmIv, vol: ch.volWin, oiMap: ch.oiMap, spot };
    // S/R levels (OI walls added below with price-based levels)
    out.levels.majorR = ch.R; out.levels.majorS = ch.S;
  }
  if (tech && spot != null) {
    const add = (label, price) => { if (price == null) return; (price > spot ? out.levels.resistances : out.levels.supports).push({ label, price }); };
    add('VWAP*', tech.vwap); add('Day high', tech.dayHigh); add('Day low', tech.dayLow);
    if (tech.orFormed) { add('OR high', tech.orHigh); add('OR low', tech.orLow); }
    if (quote && quote.prev != null) add('Prev close', quote.prev);
  }
  if (ch && spot != null) {
    ch.topCalls.forEach((c) => out.levels.resistances.push({ label: 'CALL OI wall', price: c.strike, oi: c.oi }));
    ch.topPuts.forEach((c) => out.levels.supports.push({ label: 'PUT OI wall', price: c.strike, oi: c.oi }));
  }
  out.levels.resistances = out.levels.resistances.filter((l) => l.price > (spot || 0)).sort((a, b) => a.price - b.price).slice(0, 6);
  out.levels.supports = out.levels.supports.filter((l) => l.price < (spot || 1e12)).sort((a, b) => b.price - a.price).slice(0, 6);

  // ---- signal withheld unless everything is live
  if (out.issues.length) { out.waitReason = gateOk ? out.issues.join(' | ') : gate.reason; return out; }
  out.live = true;
  if (nowMin < 570) { out.waitReason = 'Opening range is still forming (until 09:30 IST). No signal yet.'; out.live = true; return finish(out, null); }
  if (nowMin >= 915) { out.waitReason = 'After 15:15 IST: liquidity thins and theta dominates. No fresh signals.'; return finish(out, null); }

  // ---- factors
  const F = [];
  const t = tech, o = out.oi;
  // 1 VWAP position
  F.push(t.priceVsVwap === 'AT' ? mk('vwapPos', 'Price vs VWAP*', W.vwapPos, 'neutral', 0, 'NIFTY is sitting on VWAP*')
    : mk('vwapPos', 'Price vs VWAP*', W.vwapPos, t.dist > 0 ? 'bull' : 'bear', Math.abs(t.dist) / 0.25, `NIFTY ${t.dist > 0 ? 'above' : 'below'} VWAP* (${signed(t.dist)}%)`));
  // 2 VWAP slope
  F.push(t.vwapDir === 'FLAT' ? mk('vwapSlope', 'VWAP* direction', W.vwapSlope, 'neutral', 0, 'VWAP* is flat')
    : mk('vwapSlope', 'VWAP* direction', W.vwapSlope, t.vwapDir === 'RISING' ? 'bull' : 'bear', Math.abs(t.slopePct) / 0.1, `VWAP* ${t.vwapDir.toLowerCase()} (${signed(t.slopePct)}% over 15 min)`));
  // 3 opening range
  if (t.orFormed) {
    const rng = Math.max(1, t.orHigh - t.orLow);
    if (t.orState === 'ABOVE') F.push(mk('orPos', 'Opening range', W.orPos, 'bull', 0.6 + 0.4 * Math.min(1, (spot - t.orHigh) / rng), `Opening-range breakout above ${f2(t.orHigh, 1)}`));
    else if (t.orState === 'BELOW') F.push(mk('orPos', 'Opening range', W.orPos, 'bear', 0.6 + 0.4 * Math.min(1, (t.orLow - spot) / rng), `Opening-range breakdown below ${f2(t.orLow, 1)}`));
    else F.push(mk('orPos', 'Opening range', W.orPos, 'neutral', 0, `Inside opening range ${f2(t.orLow, 1)} - ${f2(t.orHigh, 1)}`));
  }
  // 4 structure
  if (t.structure) {
    const s = t.structure;
    if (s.hh && s.hl) F.push(mk('structure', 'Price structure', W.structure, 'bull', 1, 'Higher highs and higher lows (5-min)'));
    else if (s.lh && s.ll) F.push(mk('structure', 'Price structure', W.structure, 'bear', 1, 'Lower highs and lower lows (5-min)'));
    else F.push(mk('structure', 'Price structure', W.structure, 'neutral', 0, s.hh ? 'Expanding range: higher highs but lower lows (5-min)' : 'Contracting range: lower highs but higher lows (5-min)'));
  }
  // 5 momentum
  if (t.e9 !== null && t.roc15 !== null) {
    if (t.momentum === 'POSITIVE') F.push(mk('momentum', 'Momentum', W.momentum, 'bull', 0.5 + 0.5 * Math.min(1, Math.abs(t.roc15) / 0.2), `Positive momentum (EMA9 > EMA21, ${signed(t.roc15)}% in 15 min)`));
    else if (t.momentum === 'NEGATIVE') F.push(mk('momentum', 'Momentum', W.momentum, 'bear', 0.5 + 0.5 * Math.min(1, Math.abs(t.roc15) / 0.2), `Negative momentum (EMA9 < EMA21, ${signed(t.roc15)}% in 15 min)`));
    else F.push(mk('momentum', 'Momentum', W.momentum, 'neutral', 0, 'Momentum indicators disagree'));
  }
  // 6 day change
  if (quote.pct != null) F.push(Math.abs(quote.pct) < 0.1 ? mk('dayChg', 'Day change', W.dayChg, 'neutral', 0, `Flat vs previous close (${signed(quote.pct)}%)`)
    : mk('dayChg', 'Day change', W.dayChg, quote.pct > 0 ? 'bull' : 'bear', Math.abs(quote.pct) / 0.8, `NIFTY ${quote.pct > 0 ? 'up' : 'down'} ${signed(quote.pct)}% vs previous close`));
  // 7 support / resistance
  if (ch) {
    const aboveAll = ch.maxCall != null && spot > ch.maxCall, belowAll = ch.maxPut != null && spot < ch.maxPut;
    const dR = ch.R ? ((ch.R.strike - spot) / spot) * 100 : null, dS = ch.S ? ((spot - ch.S.strike) / spot) * 100 : null;
    if (aboveAll) F.push(mk('srProx', 'Support / resistance', W.srProx, 'bull', 0.8, `Spot above the highest CALL OI wall (${ch.maxCall}): resistance broken`));
    else if (belowAll) F.push(mk('srProx', 'Support / resistance', W.srProx, 'bear', 0.8, `Spot below the highest PUT OI wall (${ch.maxPut}): support broken`));
    else if (dR != null && dR < 0.25 && (dS == null || dR < dS)) F.push(mk('srProx', 'Support / resistance', W.srProx, 'bear', 1 - dR / 0.25 + 0.2, `Resistance nearby: CALL OI wall ${ch.R.strike} (${f2(dR)}% away)`));
    else if (dS != null && dS < 0.25 && (dR == null || dS < dR)) F.push(mk('srProx', 'Support / resistance', W.srProx, 'bull', 1 - dS / 0.25 + 0.2, `Support nearby: PUT OI wall ${ch.S.strike} (${f2(dS)}% away)`));
    else F.push(mk('srProx', 'Support / resistance', W.srProx, 'neutral', 0, 'Room on both sides to the nearest OI walls'));
  }
  // 8 OI flow
  if (o) {
    const tot = Math.abs(o.putChg) + Math.abs(o.callChg);
    if (tot > 0) {
      const net = (o.putChg - o.callChg) / tot;
      const bits = [];
      bits.push(`PUT OI ${o.putState === 'build' ? 'buildup' : o.putState === 'unwind' ? 'unwinding' : 'flat'} (${signed(o.putChg / 1e5, 2)}L)`);
      bits.push(`CALL OI ${o.callState === 'build' ? 'buildup' : o.callState === 'unwind' ? 'unwinding' : 'flat'} (${signed(o.callChg / 1e5, 2)}L)`);
      F.push(Math.abs(net) < 0.15 ? mk('oiFlow', 'OI change (ATM +/-5)', W.oiFlow, 'neutral', 0, bits.join(', ') + ': balanced')
        : mk('oiFlow', 'OI change (ATM +/-5)', W.oiFlow, net > 0 ? 'bull' : 'bear', Math.abs(net), bits.join(', ')));
    }
  }
  // 9 PCR
  if (o && o.pcrRel != null) {
    let side = 'neutral', st = 0, txt = `Relevant-strike PCR ${f2(o.pcrRel)} (neutral)`;
    if (o.pcrRel > 1.2) { side = 'bull'; st = Math.min(1, (o.pcrRel - 1) / 0.5); txt = `Relevant-strike PCR ${f2(o.pcrRel)} (PUT heavy)`; }
    else if (o.pcrRel < 0.8) { side = 'bear'; st = Math.min(1, (1 - o.pcrRel) / 0.5); txt = `Relevant-strike PCR ${f2(o.pcrRel)} (CALL heavy)`; }
    if (o.pcrDelta != null && Math.abs(o.pcrDelta) >= 0.05) {
      const ts = o.pcrDelta > 0 ? 'bull' : 'bear';
      if (side === 'neutral') { side = ts; st = 0.4; } else if (side === ts) st = Math.min(1, st + 0.2); else st = Math.max(0.1, st - 0.2);
      txt += `, ${o.pcrDelta > 0 ? 'rising' : 'falling'} (${signed(o.pcrDelta)})`;
    }
    F.push(mk('pcr', 'PCR', W.pcr, side, st, txt));
  }
  // 10 IV skew
  if (o && o.ivSkew != null) {
    if (o.ivSkew < -1.5) F.push(mk('iv', 'IV skew', W.iv, 'bear', 0.5, `PUT IV above CALL IV at ATM (${f2(o.ivSkew, 1)}): hedging demand`));
    else if (o.ivSkew > 1.5) F.push(mk('iv', 'IV skew', W.iv, 'bull', 0.5, `CALL IV above PUT IV at ATM (+${f2(o.ivSkew, 1)}): upside demand`));
    else F.push(mk('iv', 'IV skew', W.iv, 'neutral', 0, `ATM IV ${f2(o.atmIv, 1)}${o.ivState ? ', ' + o.ivState.toLowerCase() : ''}; no clear skew`));
  }
  // 11 VIX
  if (vix && vix.pct != null) {
    if (vix.pct <= -1.5) F.push(mk('vix', 'India VIX', W.vix, 'bull', Math.abs(vix.pct) / 5, `India VIX falling (${signed(vix.pct)}%)`));
    else if (vix.pct >= 1.5) F.push(mk('vix', 'India VIX', W.vix, 'bear', Math.abs(vix.pct) / 5, `India VIX rising (${signed(vix.pct)}%)`));
    else F.push(mk('vix', 'India VIX', W.vix, 'neutral', 0, `India VIX steady (${signed(vix.pct)}%)`));
  }
  // 12 global context (context only, low weight)
  if (global) {
    const g = (id) => (global[id] && global[id].pct != null ? global[id].pct : null);
    const us = [g('dji'), g('spx'), g('ixic')].filter((x) => x != null), asia = [g('n225'), g('hsi'), g('ssec'), g('kospi')].filter((x) => x != null);
    const parts = [];
    if (us.length) parts.push(us.reduce((a, b) => a + b, 0) / us.length / 1.0);
    if (asia.length) parts.push(asia.reduce((a, b) => a + b, 0) / asia.length / 1.0);
    if (g('dxy') != null) parts.push(-g('dxy') / 0.5);
    if (g('crude') != null) parts.push(-g('crude') / 2);
    if (parts.length >= 2) {
      const gs = clamp(parts.reduce((a, b) => a + b, 0) / parts.length, -1, 1);
      F.push(Math.abs(gs) < 0.15 ? mk('global', 'Global context', W.global, 'neutral', 0, 'Global cues mixed / flat (context only)')
        : mk('global', 'Global context', W.global, gs > 0 ? 'bull' : 'bear', Math.abs(gs), `Global cues ${gs > 0 ? 'supportive' : 'negative'} (US/Asia/DXY/crude; context only)`));
    }
  }
  // 13 consolidation
  if (t.consolidating) F.push(mk('consol', 'Consolidation', W.consol, 'neutral', 0, `Tight range (${f2(t.rng30)}% over 30 min): consolidation`));

  return finish(out, F, { tech: t, oi: o, vix, quote, nowMin });
}

function finish(out, F, ctx) {
  if (!F) return out;
  let bull = 0, bear = 0, neu = 0, avail = 0;
  F.forEach((f) => {
    avail += f.w;
    if (f.side === 'bull') { bull += f.w * f.strength; neu += f.w * (1 - f.strength); }
    else if (f.side === 'bear') { bear += f.w * f.strength; neu += f.w * (1 - f.strength); }
    else neu += f.w;
    f.bullPart = f.side === 'bull' ? f.w * f.strength : 0; f.bearPart = f.side === 'bear' ? f.w * f.strength : 0;
  });
  out.factors = F;
  out.coverage = avail / W_TOTAL;
  out.bull = avail ? (bull / avail) * 100 : 0; out.bear = avail ? (bear / avail) * 100 : 0; out.neutral = avail ? (neu / avail) * 100 : 100;
  const decisive = bull + bear;
  const agreement = decisive > 0 ? Math.max(bull, bear) / decisive : 0.5;
  const decisiveFrac = avail ? decisive / avail : 0;
  let conf = 50 + (agreement * 100 - 50) * Math.min(1, decisiveFrac / 0.6);
  const pen = [];
  if (ctx.oi && ctx.oi.ivChgPct != null && Math.abs(ctx.oi.ivChgPct) >= 8) { conf -= 5; pen.push('IV moving sharply'); }
  if (ctx.tech.consolidating) { conf -= 5; pen.push('consolidation'); }
  if (ctx.vix && ctx.vix.ltp != null && ctx.vix.ltp > 22) { conf -= 4; pen.push('high VIX'); }
  conf = clamp(Math.round(conf), 0, 95);
  const lead = bull >= bear ? 'CALL' : 'PUT';
  const margin = avail ? Math.abs(bull - bear) / avail : 0;
  out.lead = lead; out.leadConf = conf; out.penalties = pen;
  const thr = (out.thr = (ctx.settingsThr != null ? ctx.settingsThr : 60));
  out.margin = margin; out.agreement = agreement;
  out.F = F;
  F.forEach((f) => {
    const line = f.text;
    if (f.side === 'bull') out.bullReasons.push({ text: line, w: f.w * f.strength });
    else if (f.side === 'bear') out.bearReasons.push({ text: line, w: f.w * f.strength });
    else out.neutralReasons.push({ text: line, w: f.w });
  });
  ['bullReasons', 'bearReasons', 'neutralReasons'].forEach((k) => out[k].sort((a, b) => b.w - a.w));
  return out;
}

// Apply the user's settings-dependent decision rule, then pick the contract.
export function decide(out, settings, vix) {
  if (!out.live || !out.F) return out;
  const margin = SENS[settings.sens] != null ? SENS[settings.sens] : SENS.MED;
  const thr = settings.confThr;
  out.thr = thr;
  let sig = 'WAIT';
  if (out.coverage < 0.5) out.waitReason = 'Not enough independent factors available to judge (coverage below 50%).';
  else if (out.leadConf < thr) out.waitReason = `Leading side ${out.lead} has ${out.leadConf}% confidence, below your ${thr}% threshold.`;
  else if (out.margin < margin) out.waitReason = `Evidence is mixed: bullish and bearish scores are too close (needs a ${(margin * 100).toFixed(0)}% edge).`;
  else sig = out.lead;
  out.signal = sig;
  out.confidence = sig === 'WAIT' ? null : out.leadConf;
  if (sig !== 'WAIT' && out.view.length) {
    const ch = { valid: out.view, atmIdx: out.view.findIndex((r) => r.strike === out.atm) };
    if (ch.atmIdx >= 0) {
      out.recommended = recommend(sig, ch, out.spot, out.oi && out.oi.atmIv);
      if (!out.recommended) out.notes.push('No contract passed the liquidity / spread / delta filters near ATM. Do not force a trade.');
    }
  }
  return out;
}
