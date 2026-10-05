import { fmtHM } from './util';

export const ALERT_TYPES = [
  { id: 'callSignal', label: 'CALL signal' },
  { id: 'putSignal', label: 'PUT signal' },
  { id: 'waitToCall', label: 'WAIT \u2192 CALL' },
  { id: 'waitToPut', label: 'WAIT \u2192 PUT' },
  { id: 'vwapCross', label: 'NIFTY crossing VWAP*' },
  { id: 'orBreakout', label: 'Opening-range breakout' },
  { id: 'orBreakdown', label: 'Opening-range breakdown' },
  { id: 'supportBreak', label: 'Major support break' },
  { id: 'resistBreak', label: 'Major resistance breakout' },
  { id: 'oiChange', label: 'Large OI change' },
  { id: 'volume', label: 'Unusual volume' },
  { id: 'ivSpike', label: 'IV spike' },
  { id: 'ivCollapse', label: 'IV collapse' },
];
export const DEFAULT_ALERTS = Object.fromEntries(ALERT_TYPES.map((a) => [a.id, true]));

// Confidence is the engine's HIGH / MEDIUM / LOW label; the number is its internal model score, not a guarantee.
const sigText = (a, side) => `${a.confidence} confidence, model score ${a.probabilities ? a.probabilities[side] : '--'}%`;

// Compare two consecutive live analyses and return the events that happened between them.
export function detectAlerts(prev, cur) {
  const ev = [];
  if (!prev || !cur || !prev.live || !cur.live) return ev;
  const add = (type, msg) => ev.push({ type, msg });
  if (prev.signal !== cur.signal) {
    if (cur.signal === 'CALL') { add('callSignal', `CALL signal (${sigText(cur, 'CALL')})`); if (prev.signal === 'WAIT') add('waitToCall', 'Signal changed WAIT \u2192 CALL'); }
    if (cur.signal === 'PUT') { add('putSignal', `PUT signal (${sigText(cur, 'PUT')})`); if (prev.signal === 'WAIT') add('waitToPut', 'Signal changed WAIT \u2192 PUT'); }
  }
  const pt = prev.tech, ct = cur.tech;
  if (pt && ct) {
    if ((pt.priceVsVwap === 'ABOVE' && ct.priceVsVwap === 'BELOW') || (pt.priceVsVwap === 'BELOW' && ct.priceVsVwap === 'ABOVE')) add('vwapCross', `NIFTY crossed ${ct.priceVsVwap === 'ABOVE' ? 'above' : 'below'} VWAP* (${ct.vwap.toFixed(1)})`);
    if (pt.orState !== 'ABOVE' && pt.orState !== 'FORMING' && ct.orState === 'ABOVE') add('orBreakout', `Opening-range breakout above ${ct.orHigh.toFixed(1)}`);
    if (pt.orState !== 'BELOW' && pt.orState !== 'FORMING' && ct.orState === 'BELOW') add('orBreakdown', `Opening-range breakdown below ${ct.orLow.toFixed(1)}`);
  }
  const ps = prev.levels && prev.levels.majorS, pr = prev.levels && prev.levels.majorR;
  if (ps && prev.spot != null && cur.spot != null && prev.spot >= ps.strike && cur.spot < ps.strike) add('supportBreak', `Major support ${ps.strike} (PUT OI wall) broke`);
  if (pr && prev.spot != null && cur.spot != null && prev.spot <= pr.strike && cur.spot > pr.strike) add('resistBreak', `Major resistance ${pr.strike} (CALL OI wall) broken`);
  const o = cur.oi;
  if (o) {
    if (o.bigMove) add('oiChange', `${o.bigMove.side} OI at ${o.bigMove.strike} ${o.bigMove.pct > 0 ? 'up' : 'down'} ${Math.abs(o.bigMove.pct).toFixed(0)}% in ~5 min`);
    if (o.volRatio != null && o.volRatio >= 3) add('volume', `Option volume running ${o.volRatio.toFixed(1)}x the recent average`);
    if (o.ivChgPct != null && o.ivChgPct >= 7) add('ivSpike', `ATM IV spiked ${o.ivChgPct.toFixed(1)}% in ~5 min`);
    if (o.ivChgPct != null && o.ivChgPct <= -7) add('ivCollapse', `ATM IV fell ${Math.abs(o.ivChgPct).toFixed(1)}% in ~5 min`);
  }
  return ev;
}

export function stamp(msg, now) { return `${fmtHM(now)}  ${msg}`; }
