// Market status derived from Upstox V3 market_info (NOT from the device clock).
//
// Wire values (MarketInfo):
//   segmentStatus[segment]          PRE_OPEN_START | PRE_OPEN_END | NORMAL_OPEN | NORMAL_CLOSE | CLOSING_START | CLOSING_END
//   casMarketStatus[segment].status CTS_CLOSE | CAS_LM_START | CAS_M_STOP | CAS_STOP      (closing auction session)
//   preOpenSessionStatus[seg].status PRE_OPEN_START | PRE_OPEN_M_END | PRE_OPEN_END
//
// App states: PRE_OPEN | NORMAL_OPEN | CLOSED | CLOSING_AUCTION | UNKNOWN
export const MS = { PRE_OPEN: 'PRE_OPEN', OPEN: 'NORMAL_OPEN', CLOSED: 'CLOSED', CAS: 'CLOSING_AUCTION', UNKNOWN: 'UNKNOWN' };

// Segments consulted, in priority order. NSE_INDEX drives NIFTY/VIX; NSE_FO drives the options; NSE_EQ carries CAS.
export const PRIMARY_SEGMENT = 'NSE_INDEX';
export const FNO_SEGMENT = 'NSE_FO';
export const EQ_SEGMENT = 'NSE_EQ';

const SEGMENT_MAP = {
  PRE_OPEN_START: MS.PRE_OPEN,
  PRE_OPEN_END: MS.PRE_OPEN, // pre-open order matching finished, normal session not started yet
  NORMAL_OPEN: MS.OPEN,
  NORMAL_CLOSE: MS.CLOSED,
  CLOSING_START: MS.CAS,
  CLOSING_END: MS.CLOSED,
};
// CTS_CLOSE = continuous trading closed, auction about to start; CAS_STOP = auction finished.
const CAS_ACTIVE = new Set(['CTS_CLOSE', 'CAS_LM_START', 'CAS_M_STOP']);
const PRE_OPEN_ACTIVE = new Set(['PRE_OPEN_START', 'PRE_OPEN_M_END', 'PRE_OPEN_END']);

export function segmentState(info, segment) {
  if (!info) return MS.UNKNOWN;
  const raw = info.segmentStatus && info.segmentStatus[segment];
  const cas = info.casMarketStatus && info.casMarketStatus[segment] && String(info.casMarketStatus[segment].status || '').toUpperCase();
  const pre = info.preOpenSessionStatus && info.preOpenSessionStatus[segment] && String(info.preOpenSessionStatus[segment].status || '').toUpperCase();
  let st = raw ? (SEGMENT_MAP[String(raw).toUpperCase()] || MS.UNKNOWN) : MS.UNKNOWN;
  // Detailed sessions refine (never contradict an explicit NORMAL_OPEN): auction in progress => CLOSING_AUCTION.
  if (cas && CAS_ACTIVE.has(cas) && st !== MS.OPEN) st = MS.CAS;
  if (st === MS.UNKNOWN && pre && PRE_OPEN_ACTIVE.has(pre) && pre !== 'PRE_OPEN_END') st = MS.PRE_OPEN;
  return st;
}

// Overall state: NSE_INDEX first (it carries NIFTY and VIX), then NSE_FO, then NSE_EQ.
// `fno` is reported separately because options can be in a different phase than the index.
export function deriveMarketState(info) {
  if (!info) return { state: MS.UNKNOWN, index: MS.UNKNOWN, fno: MS.UNKNOWN, eq: MS.UNKNOWN, source: null };
  const index = segmentState(info, PRIMARY_SEGMENT);
  const fno = segmentState(info, FNO_SEGMENT);
  const eq = segmentState(info, EQ_SEGMENT);
  let state = MS.UNKNOWN, source = null;
  for (const [s, seg] of [[index, PRIMARY_SEGMENT], [fno, FNO_SEGMENT], [eq, EQ_SEGMENT]]) {
    if (s !== MS.UNKNOWN) { state = s; source = seg; break; }
  }
  return { state, index, fno, eq, source };
}

export const MARKET_STATE_LABEL = {
  [MS.OPEN]: 'MARKET OPEN', [MS.PRE_OPEN]: 'PRE-OPEN', [MS.CAS]: 'CLOSING AUCTION', [MS.CLOSED]: 'MARKET CLOSED', [MS.UNKNOWN]: 'STATUS UNKNOWN',
};
