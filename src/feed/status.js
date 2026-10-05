// UI status derivation (pure). Inputs come from the controller's store snapshot.
import { MS } from './marketStatus';
import { FRESH } from './freshness';

// Effective status shown in the UI: LIVE | PRE-OPEN | CLOSING AUCTION | MARKET CLOSED | STALE | DISCONNECTED (+ transitional states).
export function deriveStatus(s) {
  if (s.conn === 'AUTH') return { key: 'SESSION EXPIRED', color: 'red' };
  const fc = s.feed.conn;
  if (fc === 'RECONNECTING') return { key: 'RECONNECTING', color: 'amber', sub: 'Live data temporarily unavailable' };
  if (fc === 'DISCONNECTED' || fc === 'ERROR') return { key: 'DISCONNECTED', color: 'red', sub: s.feed.connMsg };
  if (fc !== 'LIVE') return { key: 'CONNECTING', color: 'blue' };
  const st = s.market.state;
  if (st === MS.PRE_OPEN) return { key: 'PRE-OPEN', color: 'blue' };
  if (st === MS.CAS) return { key: 'CLOSING AUCTION', color: 'amber' };
  if (st === MS.CLOSED) return { key: 'MARKET CLOSED', color: 'muted' };
  if (st === MS.UNKNOWN) return { key: 'STATUS UNKNOWN', color: 'amber', sub: 'Waiting for market status from Upstox' };
  const f = s.niftyFresh;
  if (!f || f.status === FRESH.UNAVAILABLE) return { key: 'DATA UNAVAILABLE', color: 'red' };
  if (f.status === FRESH.STALE) return { key: 'STALE', color: 'amber', sub: 'No recent NIFTY tick' };
  if (f.status === FRESH.DISCONNECTED) return { key: 'DISCONNECTED', color: 'red' };
  return { key: 'LIVE', color: 'green' };
}

