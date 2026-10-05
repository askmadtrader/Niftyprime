import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { C, num } from '../theme';
import { store } from '../controller';
import { useStore } from '../store';
import { Card, KV, Note, Pill } from './primitives';
import { describeExpiry } from '../contracts';
import { validSpot, chainStatus, CHAIN_STATUS } from '../chain';
import { fmtInt } from '../oi';
import { analyzePcrIv, HIST, NEAR_STRIKES, fixed, signedFixed, fmtGreek, historyText } from '../pcriv';

// PCR, IV and Greeks for the SELECTED expiry only. "--" = Upstox did not send it. A change over time shows
// COLLECTING HISTORY until ~5 minutes of real samples exist: it is never shown as 0.00 or FLAT before that.
const TREND_COLOR = { RISING: C.green, FALLING: C.red, FLAT: C.muted };

function Change({ k, c, kind }) {
  const note = historyText(c);
  if (note) return <KV k={k} v={note} color={c && c.status === HIST.COLLECTING ? C.amber : C.muted} />;
  if (kind === 'pcr') return <KV k={k} v={`${signedFixed(c.abs)}  ${c.trend}`} color={TREND_COLOR[c.trend]} />;
  return <KV k={k} v={`${signedFixed(c.abs)} pts${c.pct === null ? '' : ` (${signedFixed(c.pct, 1)}%)`}  ${c.state}`} color={c.state === 'EXPANDING' ? C.amber : c.state === 'CONTRACTING' ? C.blue : C.muted} />;
}

const GREEKS = [['delta', 'Delta'], ['gamma', 'Gamma'], ['theta', 'Theta'], ['vega', 'Vega'], ['iv', 'IV (%)'], ['pop', 'POP (%)']];

export default function PcrIvCard() {
  const expiry = useStore(store, (x) => x.expiry);
  const chain = useStore(store, (x) => x.chain);
  const chainExpiry = useStore(store, (x) => x.chainExpiry);
  const chainAt = useStore(store, (x) => x.chainAt);
  const cfr = useStore(store, (x) => x.chainFresh);
  const history = useStore(store, (x) => x.pcrIvHistory);
  const nifty = useStore(store, (x) => x.nifty);
  const nf = useStore(store, (x) => x.niftyFresh);
  const sNow = useStore(store, (x) => x.sNow);

  const spot = validSpot(nifty, nf);
  const r = useMemo(() => analyzePcrIv({ rows: chain, expiry, chainExpiry, spot, history, at: chainAt }), [chain, expiry, chainExpiry, spot, history, chainAt]);
  const st = chainStatus({ rows: chain, chainExpiry, expiry, fresh: cfr });
  const info = expiry ? describeExpiry(expiry, sNow) : null;

  if (!r.ok) {
    return (
      <Card title="PCR, IV and Greeks" right={info ? info.date : '--'}>
        <Text style={s.none}>DATA UNAVAILABLE: {r.text}</Text>
      </Card>
    );
  }
  const { pcr, iv, greeks: g } = r;
  const tot = pcr.total, near = pcr.near;
  return (
    <Card title="PCR, IV and Greeks" right={info ? info.date : '--'}>
      <View style={s.statusRow}>
        <Pill text={st.status} color={st.status === CHAIN_STATUS.LIVE ? 'green' : st.status === CHAIN_STATUS.PREVIOUS ? 'blue' : 'amber'} solid />
        <Text style={s.statusTxt} numberOfLines={2}>{st.text}</Text>
      </View>

      <Text style={s.h}>PCR (PUT OI / CALL OI)</Text>
      <KV k="Total PCR (all strikes)" v={fixed(tot.value)} bold />
      <Text style={s.sub}>PUT {fmtInt(tot.putOi)} / CALL {fmtInt(tot.callOi)} {'\u00b7'} {tot.strikes} of {tot.rows} strikes with both OI</Text>
      <KV k={`Near-ATM PCR (ATM \u00b1${NEAR_STRIKES})`} v={fixed(near.value)} bold />
      <Text style={s.sub}>
        {near.reason ? (near.reason === 'NO_SPOT' ? 'Waiting for a valid NIFTY price' : 'NIFTY price is outside the returned strikes')
          : `Strikes ${near.range} (ATM ${near.atmStrike}) ${'\u00b7'} PUT ${fmtInt(near.putOi)} / CALL ${fmtInt(near.callOi)} ${'\u00b7'} ${near.strikes} strikes`}
      </Text>
      <Change k="Total PCR change (~5 min)" c={pcr.totalChange} kind="pcr" />
      <Change k="Near-ATM PCR change (~5 min)" c={pcr.nearChange} kind="pcr" />

      <Text style={s.h}>IV AT THE MONEY</Text>
      {iv.reason ? <Text style={s.none}>ATM UNAVAILABLE: {iv.reason === 'NO_SPOT' ? 'waiting for a valid NIFTY price from the live feed.' : 'the NIFTY price is outside the strikes Upstox returned.'}</Text> : null}
      <KV k="ATM strike" v={iv.atmStrike === null ? '--' : String(iv.atmStrike)} />
      <KV k="ATM CALL IV" v={fixed(iv.callIv)} />
      <KV k="ATM PUT IV" v={fixed(iv.putIv)} />
      <KV k="ATM IV (mean of CALL and PUT)" v={fixed(iv.atmIv)} bold />
      <KV k="CALL IV - PUT IV" v={signedFixed(iv.skew)} />
      <Change k="ATM IV change (~5 min)" c={iv.change} kind="iv" />

      <Text style={s.h}>GREEKS (ATM {g.strike === null ? '--' : g.strike})</Text>
      <View style={s.row}>
        <View style={[s.cell, { flex: 1.2 }]} /><View style={s.cell}><Text style={[s.hc, { color: C.green }]}>CALL</Text></View><View style={s.cell}><Text style={[s.hc, { color: C.red }]}>PUT</Text></View>
      </View>
      {GREEKS.map(([key, label]) => (
        <View key={key} style={s.row}>
          <View style={[s.cell, { flex: 1.2, alignItems: 'flex-start' }]}><Text style={s.lbl}>{label}</Text></View>
          <View style={s.cell}><Text style={[s.ct, num]}>{fmtGreek(key, g.call[key])}</Text></View>
          <View style={s.cell}><Text style={[s.ct, num]}>{fmtGreek(key, g.put[key])}</Text></View>
        </View>
      ))}

      <Note>Everything above is for the selected expiry only. PCR counts only strikes where both CALL and PUT OI exist. Near-ATM = the {NEAR_STRIKES} strikes each side of ATM. ATM IV needs both the CALL and PUT IV. IV change compares the same ATM strike with ~5 minutes ago (needs live market-hours samples). Greeks, IV and POP are Upstox's own values; "--" means Upstox did not send it.</Note>
    </Card>
  );
}

const s = StyleSheet.create({
  none: { color: C.red, fontSize: 14, lineHeight: 20, marginBottom: 4 },
  h: { color: C.muted, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginTop: 10, marginBottom: 4 },
  sub: { color: C.muted, fontSize: 11, marginTop: -2, marginBottom: 4 },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 2 },
  statusTxt: { color: C.text, fontSize: 12, marginLeft: 8, flexShrink: 1 },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderColor: C.border },
  cell: { flex: 1, height: 32, alignItems: 'center', justifyContent: 'center' },
  hc: { fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  lbl: { color: C.muted, fontSize: 12 },
  ct: { color: C.text, fontSize: 13 },
});
