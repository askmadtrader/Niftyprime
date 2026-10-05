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

export const WALL_BUF_MIN = 8, WALL_BUF_PCT = 0.04;   // points / percent of the wall strike

// Confidence is the engine's HIGH / MEDIUM / LOW label; the number is its internal model score, not a guarantee.
const sigText = (a, side) => `${a.confidence} confidence, model score ${a.probabilities ? a.probabilities[side] : '--'}%`;

// Plain-language "what this means for you" line for every alert. Not technical, never an order: it says how to read the event.
export function tipFor(type, cur) {
  const above = cur && cur.tech && cur.tech.priceVsVwap === 'ABOVE';
  const mv = cur && cur.oi && cur.oi.bigMove;
  switch (type) {
    case 'callSignal': return 'Market looks set to go UP. Do not rush in. Wait a few minutes and see if it keeps rising.';
    case 'putSignal': return 'Market looks set to go DOWN. Do not rush in. Wait a few minutes and see if it keeps falling.';
    case 'waitToCall': return 'The mood changed from "wait" to "up". It still needs a few minutes to prove itself.';
    case 'waitToPut': return 'The mood changed from "wait" to "down". It still needs a few minutes to prove itself.';
    case 'vwapCross': return above ? 'Price moved above today\'s average price. Buyers are in charge. If it drops back below, the up view is off.' : 'Price moved below today\'s average price. Sellers are in charge. If it climbs back above, the down view is off.';
    case 'orBreakout': return 'Price went above the high of the first 15 minutes. An up move may be starting. If it falls back under that level, ignore it.';
    case 'orBreakdown': return 'Price went below the low of the first 15 minutes. A down move may be starting. If it climbs back above that level, ignore it.';
    case 'supportBreak': return 'A floor that was holding has cracked. More fall is likely. Avoid buying until price recovers above it.';
    case 'resistBreak': return 'A ceiling has been crossed. The up view is stronger only if price stays above it for a few minutes. If it drops back, it was a false move.';
    case 'oiChange':
      if (!mv) return 'Big change in option positions. Watch which way price moves before acting.';
      if (mv.pct < 0) return 'Positions at this level are being closed. This level is getting weaker.';
      return mv.side === 'PUT' ? 'Big players are betting the market will NOT fall below this level. It can act as a floor. Mildly positive.' : 'Big players are betting the market will NOT rise above this level. It can act as a ceiling. Mildly negative.';
    case 'volume': return 'Trading suddenly jumped. Something is happening. Do not act on this alone; see which way price goes.';
    case 'ivSpike': return 'Options are getting more expensive because traders are nervous. A big move may come. Buying now costs more.';
    case 'ivCollapse': return 'Options are getting cheaper because the market is calming. Big moves are less likely. Waiting costs less.';
    case 'priceLevel': case 'vixLevel': return 'Your own level was reached. Check the chart and follow your own plan.';
    default: return '';
  }
}

// Compare two consecutive live analyses and return the events that happened between them.
export function detectAlerts(prev, cur) {
  const ev = [];
  if (!prev || !cur || !prev.live || !cur.live) return ev;
  const add = (type, msg) => ev.push({ type, msg, tip: tipFor(type, cur) });
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
  const buf = (x) => Math.max(WALL_BUF_MIN, (x / 100) * WALL_BUF_PCT);   // a wall counts as broken only beyond a buffer, not by a 1-2 point wiggle
  if (ps && prev.spot != null && cur.spot != null) { const lv = ps.strike - buf(ps.strike); if (prev.spot >= lv && cur.spot < lv) add('supportBreak', `Major support ${ps.strike} (PUT OI wall) broke (${(ps.strike - cur.spot).toFixed(0)} pts below)`); }
  if (pr && prev.spot != null && cur.spot != null) { const lv = pr.strike + buf(pr.strike); if (prev.spot <= lv && cur.spot > lv) add('resistBreak', `Major resistance ${pr.strike} (CALL OI wall) broken (${(cur.spot - pr.strike).toFixed(0)} pts above)`); }
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
