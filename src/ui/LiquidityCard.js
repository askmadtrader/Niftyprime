import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { C, num } from '../theme';
import { store } from '../controller';
import { useStore } from '../store';
import { Card, Note, Pill } from './primitives';
import { describeExpiry } from '../contracts';
import { validSpot, chainStatus, CHAIN_STATUS } from '../chain';
import { NEAR_STRIKES, fixed } from '../pcriv';
import { compact } from '../util';
import { rankContracts, lotSizeFromPairs, fmtSpreadPct, fmtLots, fmtScore } from '../liquidity';

// Which NIFTY option contracts near ATM are liquid enough to be considered later. This is NOT a CALL/PUT signal and nothing
// is traded: it only grades the quotes Upstox sent (GOOD / FAIR / POOR / UNAVAILABLE) and ranks the suitable ones.
const CLS_COLOR = { GOOD: 'green', FAIR: 'amber', POOR: 'red', UNAVAILABLE: 'muted' };
const CLS_TXT = { GOOD: C.green, FAIR: C.amber, POOR: C.red, UNAVAILABLE: C.muted };
const SHORT = { GOOD: 'GOOD', FAIR: 'FAIR', POOR: 'POOR', UNAVAILABLE: 'N/A' };
const TYPE_NAME = { CE: 'CALL option (CE)', PE: 'PUT option (PE)' };

function Best({ type, r }) {
  const list = r[type], b = r.best[type];
  if (!b) {
    const why = !r.selectable ? r.freshness.text : `No ${type} near ATM meets the liquidity, delta and freshness rules.`;
    return (<View style={s.block}><Text style={s.bt}>{TYPE_NAME[type]}</Text><Text style={s.none}>{why}</Text></View>);
  }
  const m = b.metrics;
  return (
    <View style={s.block}>
      <View style={s.line}>
        <Text style={s.bt}>{TYPE_NAME[type]} {'\u00b7'} {b.strike}{b.atm ? '  (ATM)' : ''}</Text>
        <Pill text={b.class} color={CLS_COLOR[b.class]} solid />
      </View>
      <Text style={s.sub}>Score {fmtScore(b.score)} {'\u00b7'} LTP {fixed(m.ltp)} {'\u00b7'} Bid/Ask {fixed(m.bid)}/{fixed(m.ask)} ({fmtSpreadPct(m.spreadPct)})</Text>
      <Text style={s.sub}>OI {compact(m.oi)} {'\u00b7'} Vol {compact(m.volume)} {'\u00b7'} Top qty {compact(m.bidQty)}/{compact(m.askQty)} ({fmtLots(m.depthLots)} lots) {'\u00b7'} Delta {fixed(m.delta, 3)}</Text>
      {list.slice(1, 3).map((c) => (
        <Text key={c.strike} style={[s.sub, { color: C.text }]}>#{c.rank}  {c.strike}  <Text style={{ color: CLS_TXT[c.class] }}>{c.class}</Text>  score {fmtScore(c.score)}  spread {fmtSpreadPct(c.metrics.spreadPct)}</Text>
      ))}
    </View>
  );
}

export default function LiquidityCard() {
  const expiry = useStore(store, (x) => x.expiry);
  const chain = useStore(store, (x) => x.chain);
  const chainExpiry = useStore(store, (x) => x.chainExpiry);
  const cfr = useStore(store, (x) => x.chainFresh);
  const pairs = useStore(store, (x) => x.pairs);
  const nifty = useStore(store, (x) => x.nifty);
  const nf = useStore(store, (x) => x.niftyFresh);
  const sNow = useStore(store, (x) => x.sNow);

  const spot = validSpot(nifty, nf);
  const lotSize = useMemo(() => lotSizeFromPairs(pairs), [pairs]);
  const r = useMemo(() => rankContracts({ rows: chain, expiry, chainExpiry, spot, fresh: cfr, lotSize, window: NEAR_STRIKES }), [chain, expiry, chainExpiry, spot, cfr, lotSize]);
  const st = chainStatus({ rows: chain, chainExpiry, expiry, fresh: cfr });
  const info = expiry ? describeExpiry(expiry, sNow) : null;

  if (!r.ok) {
    return (
      <Card title="Option liquidity" right={info ? info.date : '--'}>
        <Text style={s.none}>DATA UNAVAILABLE: {r.text}</Text>
      </Card>
    );
  }
  return (
    <Card title="Option liquidity" right={info ? info.date : '--'}>
      <View style={s.statusRow}>
        <Pill text={st.status} color={st.status === CHAIN_STATUS.LIVE ? 'green' : st.status === CHAIN_STATUS.PREVIOUS ? 'blue' : 'amber'} solid />
        <Text style={s.statusTxt} numberOfLines={2}>{st.text}</Text>
      </View>

      <Text style={s.h}>SUITABLE LIQUID CONTRACTS (NOT A SIGNAL)</Text>
      <Best type="CE" r={r} />
      <Best type="PE" r={r} />

      <Text style={s.h}>NEAR ATM {'\u00b1'}{r.window} (ATM {r.atmStrike})</Text>
      <View style={s.row}>
        <View style={s.cell}><Text style={[s.hc, { color: C.green }]}>CALL</Text></View>
        <View style={[s.cell, { flex: 0.8 }]}><Text style={s.hc}>STRIKE</Text></View>
        <View style={s.cell}><Text style={[s.hc, { color: C.red }]}>PUT</Text></View>
      </View>
      {r.rows.map((row) => (
        <View key={row.strike} style={[s.row, row.atm ? { backgroundColor: C.amberBg } : null]}>
          <View style={s.cell}><Text style={[s.ct, num, { color: CLS_TXT[row.call.class] }]}>{SHORT[row.call.class]}  {fmtSpreadPct(row.call.metrics.spreadPct)}</Text></View>
          <View style={[s.cell, { flex: 0.8 }]}><Text style={[s.ct, num, row.atm ? { fontWeight: '800' } : null]}>{row.strike}</Text></View>
          <View style={s.cell}><Text style={[s.ct, num, { color: CLS_TXT[row.put.class] }]}>{SHORT[row.put.class]}  {fmtSpreadPct(row.put.metrics.spreadPct)}</Text></View>
        </View>
      ))}
      {r.rows.length ? null : <Text style={s.none}>No strikes near ATM.</Text>}

      <Note>
        Grades what Upstox sent for the selected expiry: spread % (ask - bid over the mid price), top-of-book quantity in lots, OI, volume, delta and chain freshness.
        GOOD / FAIR / POOR; N/A = UNAVAILABLE (no LTP or no valid two-sided quote). A missing value is "--" and counts against the contract; it is never filled in.
        Upstox sends no per-contract timestamp, so freshness is that of the whole chain: a stale chain is never ranked.
        {r.lotSize === null ? ' Lot size unknown: depth is not judged in lots and no contract can be GOOD.' : ''}
        {' '}This is only a list of liquid contracts for later use. It is not a CALL / PUT signal and nothing is traded.
      </Note>
    </Card>
  );
}

const s = StyleSheet.create({
  none: { color: C.muted, fontSize: 13, lineHeight: 19, marginBottom: 4 },
  h: { color: C.muted, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginTop: 10, marginBottom: 4 },
  sub: { color: C.muted, fontSize: 11, lineHeight: 16 },
  block: { borderBottomWidth: 1, borderColor: C.border, paddingVertical: 6 },
  bt: { color: C.text, fontSize: 14, fontWeight: '700', flexShrink: 1 },
  line: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 2 },
  statusTxt: { color: C.text, fontSize: 12, marginLeft: 8, flexShrink: 1 },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderColor: C.border },
  cell: { flex: 1, height: 30, alignItems: 'center', justifyContent: 'center' },
  hc: { color: C.muted, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  ct: { color: C.text, fontSize: 12 },
});
