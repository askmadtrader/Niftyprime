// Reusable data-quality gate. Returns { ok:false, signal:'WAIT', reason, reasons } whenever live CALL/PUT
// signals must be withheld. The signal engine (PART 3) will call this same function.
import { MS } from './marketStatus';
import { FRESH } from './freshness';
import { SESSION, classifyTs } from './session';

export const GATE = {
  FEED_DOWN: 'FEED_DOWN', FEED_RECONNECTING: 'FEED_RECONNECTING', FEED_NOT_READY: 'FEED_NOT_READY',
  MARKET_CLOSED: 'MARKET_CLOSED', PRE_OPEN: 'PRE_OPEN', CLOSING_AUCTION: 'CLOSING_AUCTION', MARKET_UNKNOWN: 'MARKET_UNKNOWN', FNO_NOT_OPEN: 'FNO_NOT_OPEN',
  NIFTY_MISSING: 'NIFTY_MISSING', TS_INVALID: 'TS_INVALID', NIFTY_STALE: 'NIFTY_STALE', NIFTY_NOT_CURRENT: 'NIFTY_NOT_CURRENT',
  SESSION_UNAVAILABLE: 'SESSION_UNAVAILABLE', CANDLES_STALE: 'CANDLES_STALE',
};
// Non-blocking warnings: India VIX is an optional signal factor, so a missing/stale VIX never opens or closes the gate,
// but it is reported (and the engine drops it from the factors) instead of being silently used.
export const WARN = { VIX_MISSING: 'VIX_MISSING', VIX_STALE: 'VIX_STALE', VIX_NOT_CURRENT: 'VIX_NOT_CURRENT', VIX_DISCONNECTED: 'VIX_DISCONNECTED' };
const WARN_TEXT = {
  VIX_MISSING: 'India VIX unavailable — not used in the signal',
  VIX_STALE: 'India VIX is stale — not used in the signal',
  VIX_NOT_CURRENT: 'India VIX value is from a previous session — not used in the signal',
  VIX_DISCONNECTED: 'India VIX feed disconnected — not used in the signal',
};
const TEXT = {
  FEED_DOWN: 'Live feed disconnected — no live signal',
  FEED_RECONNECTING: 'Live feed reconnecting — live data temporarily unavailable',
  FEED_NOT_READY: 'Waiting for the first live data from Upstox',
  MARKET_CLOSED: 'Market closed — no live signal',
  PRE_OPEN: 'Pre-open session — no live signal until the market opens',
  CLOSING_AUCTION: 'Closing auction session — no live signal',
  MARKET_UNKNOWN: 'Market status not received from Upstox yet',
  FNO_NOT_OPEN: 'NSE F&O segment is not open — no live signal',
  NIFTY_MISSING: 'NIFTY data unavailable',
  TS_INVALID: 'NIFTY timestamp invalid — data rejected',
  NIFTY_STALE: 'NIFTY data is stale',
  NIFTY_NOT_CURRENT: 'NIFTY last trade is not from the current session',
  SESSION_UNAVAILABLE: 'Current-session candles unavailable',
  CANDLES_STALE: 'Current-session candles are stale',
};
export const CANDLE_STALE_MS = 150000;

// in: { conn, market:{state,fno}, nifty, niftyFresh, serverNow, candles:{kind,lastT} | null, candlesFresh?, vixFresh?, requireCandles }
export function evaluateGate(inp) {
  const codes = [];
  const add = (c) => { if (!codes.includes(c)) codes.push(c); };
  const { conn, market, nifty, niftyFresh, serverNow: sNow, candles } = inp;

  // 1. transport
  if (conn === 'RECONNECTING') add(GATE.FEED_RECONNECTING);
  else if (conn === 'DISCONNECTED' || conn === 'ERROR') add(GATE.FEED_DOWN);
  else if (conn !== 'LIVE') add(GATE.FEED_NOT_READY);

  // 2. market phase (from Upstox market_info, not from the device clock)
  const st = market ? market.state : MS.UNKNOWN;
  if (st === MS.CLOSED) add(GATE.MARKET_CLOSED);
  else if (st === MS.PRE_OPEN) add(GATE.PRE_OPEN);
  else if (st === MS.CAS) add(GATE.CLOSING_AUCTION);
  else if (st === MS.UNKNOWN) add(GATE.MARKET_UNKNOWN);
  else if (market.fno !== MS.OPEN && market.fno !== MS.UNKNOWN) add(GATE.FNO_NOT_OPEN);

  // 3. NIFTY quality
  if (!nifty) add(GATE.NIFTY_MISSING);
  else {
    if (!nifty.tsValid) add(GATE.TS_INVALID);
    else if (classifyTs(nifty.ltt, sNow).kind !== SESSION.CURRENT) add(classifyTs(nifty.ltt, sNow).kind === SESSION.PREVIOUS ? GATE.NIFTY_NOT_CURRENT : GATE.TS_INVALID);
    if (!niftyFresh || niftyFresh.status === FRESH.UNAVAILABLE) add(GATE.NIFTY_MISSING);
    else if (niftyFresh.status === FRESH.STALE) add(GATE.NIFTY_STALE);
    else if (niftyFresh.status === FRESH.DISCONNECTED && !codes.includes(GATE.FEED_DOWN) && !codes.includes(GATE.FEED_RECONNECTING)) add(GATE.FEED_DOWN);
  }

  // 4. current-session candles (only meaningful while the market is live)
  if (inp.requireCandles !== false && st === MS.OPEN) {
    if (!candles || candles.kind !== SESSION.CURRENT) add(GATE.SESSION_UNAVAILABLE);
    else if (inp.candlesFresh) {   // same freshness rules the UI shows (tick age, refresh age, session)
      if (inp.candlesFresh.status === FRESH.STALE || inp.candlesFresh.status === FRESH.DISCONNECTED || inp.candlesFresh.status === FRESH.UNAVAILABLE) add(GATE.CANDLES_STALE);
    } else if (sNow - candles.lastT > CANDLE_STALE_MS) add(GATE.CANDLES_STALE);
  }

  // 5. India VIX (warning only)
  const warnings = [];
  if (st === MS.OPEN && inp.vixFresh !== undefined) {
    const v = inp.vixFresh;
    if (!v || v.status === FRESH.UNAVAILABLE) warnings.push(WARN.VIX_MISSING);
    else if (v.status === FRESH.DISCONNECTED) warnings.push(WARN.VIX_DISCONNECTED);
    else if (v.status === FRESH.STALE) warnings.push(v.reason === 'PREVIOUS_SESSION' ? WARN.VIX_NOT_CURRENT : WARN.VIX_STALE);
  }

  const ok = codes.length === 0;
  return { ok, signal: 'WAIT', codes, reason: ok ? null : TEXT[codes[0]], reasons: codes.map((c) => TEXT[c]), warnings, warningTexts: warnings.map((w) => WARN_TEXT[w]) };
}
