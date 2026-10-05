// Presentation-neutral helpers that turn the three stamps (marketTs, receivedAt, tradingDate) into the text the UI
// shows. Pure functions, unit-tested. Nothing here invents a value: a missing stamp renders as "--".
import { SESSION, classifyTs, labelFor } from './session';
import { MS } from './marketStatus';
import { FRESH } from './freshness';
import { fmtTime, fmtDMY, istDate } from '../util';

// "Data as of HH:mm:ss IST" (exchange time of the value). Adds the date whenever the value is not from today,
// so yesterday's 15:29:59 can never read like a current time. No valid timestamp => explicit placeholder.
export function asOfText(marketTs, sNow) {
  const cls = classifyTs(marketTs, sNow);
  if (cls.kind === SESSION.INVALID) return 'Data as of --:--:-- IST (no valid timestamp)';
  if (cls.kind === SESSION.FUTURE) return `Data as of ${fmtTime(marketTs)} IST (INVALID: future timestamp)`;
  const t = `Data as of ${fmtTime(marketTs)} IST`;
  return cls.kind === SESSION.CURRENT ? t : `${t} \u00b7 ${fmtDMY(cls.date)}`;
}

// Compact session word for badges: TODAY / CURRENT SESSION | PREVIOUS SESSION | INVALID TIMESTAMP | NO DATA
export function sessionWord(kind) {
  if (kind === SESSION.CURRENT) return 'CURRENT SESSION';
  if (kind === SESSION.PREVIOUS) return 'PREVIOUS SESSION';
  if (kind === SESSION.FUTURE) return 'INVALID TIMESTAMP';
  return 'NO DATA';
}

// One-stop description of a value for the UI. `fresh` = result of computeFreshness / computeCandleFreshness / ...
export function describeValue(fresh, sNow, marketState) {
  if (!fresh || fresh.status === FRESH.UNAVAILABLE) {
    return { status: FRESH.UNAVAILABLE, session: SESSION.INVALID, badge: 'DATA UNAVAILABLE', label: 'DATA UNAVAILABLE', asOf: 'Data as of --:--:-- IST', tradingDate: null, marketTs: null, receivedAt: null, liveUse: false };
  }
  const kind = fresh.session || SESSION.INVALID;
  const date = fresh.tradingDate || null;
  return {
    status: fresh.status, session: kind, tradingDate: date, marketTs: fresh.marketTs, receivedAt: fresh.receivedAt,
    badge: sessionWord(kind),
    label: kind === SESSION.INVALID && fresh.marketTs == null && fresh.session === SESSION.INVALID && fresh.marketTsProvided === false
      ? 'EXCHANGE TIMESTAMP NOT PROVIDED' : labelFor(kind, date, marketState),
    asOf: fresh.marketTs != null ? asOfText(fresh.marketTs, sNow) : (fresh.marketTsProvided === false && fresh.receivedAt ? `Received ${fmtTime(fresh.receivedAt)} IST (no exchange timestamp)` : 'Data as of --:--:-- IST (no valid timestamp)'),
    liveUse: marketState === MS.OPEN && (fresh.status === FRESH.LIVE || fresh.status === FRESH.FRESH) && kind === SESSION.CURRENT,
  };
}

export const todayIst = (sNow) => istDate(sNow);
