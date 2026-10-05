import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { C, num } from '../theme';
import { store } from '../controller';
import { useStore } from '../store';
import { Card, Bar, Note } from './primitives';
import { f2, compact, fmtTime } from '../util';
import { describeValue } from '../feed/stamp';

export default function SignalCard() {
  const a = useStore(store, (s) => s.analysis);
  const conn = useStore(store, (s) => s.conn);
  const feed = useStore(store, (s) => s.feed);
  const nf = useStore(store, (s) => s.niftyFresh);
  const sNow = useStore(store, (s) => s.sNow);
  const ms = useStore(store, (s) => s.market.state);
  if (!a || !a.ui) {
    return <Card title="Signal"><Text style={s.wait}>LOADING</Text><Note>Waiting for the first complete data set from Upstox...</Note></Card>;
  }
  const u = a.ui;   // fields of the probability signal engine (src/signal.js) via src/signalBridge.js
  const color = a.signal === 'CALL' ? C.green : a.signal === 'PUT' ? C.red : C.amber;
  const top = (a.signal === 'PUT' ? u.positive : a.signal === 'CALL' ? u.positive : []).slice(0, 4);
  const against = (a.signal === 'WAIT' ? [] : u.negative).slice(0, 2);
  const rec = a.recommended;
  const failed = u.gateFailed || [];
  return (
    <>
      <Card title="Signal" right={describeValue(nf, sNow, ms).asOf.replace('Data as of ', 'as of ')} style={{ borderColor: color }}>
        <Text style={[s.sig, { color }]}>{a.signal}</Text>
        <Text style={[s.conf, num, a.signal === 'WAIT' ? { color: C.muted } : null]}>Confidence: {u.confidence}</Text>
        {a.waitReason && (u.gateOk || !failed.length) ? <Text style={[s.reason, { color: u.gateOk ? C.amber : C.red }]}>{a.waitReason}</Text> : null}
        <Text style={[s.reason, { color: u.gateOk ? C.green : C.red, marginTop: 4 }]}>Data gate: {u.gateOk ? 'PASSED (all checks)' : failed.length ? `FAILED (${failed.length} check${failed.length === 1 ? '' : 's'})` : 'NOT PASSED (see reason above)'}</Text>
        {failed.map((g, i) => <Text key={i} style={[s.reason, { color: C.red, marginTop: 2 }]}>{'\u2022'} {g.label}: {g.details.join('; ')}</Text>)}
        {a.gate && a.gate.warningTexts && a.gate.warningTexts.length ? a.gate.warningTexts.map((w, i) => <Text key={i} style={[s.reason, { color: C.amber, marginTop: 2 }]}>{w}</Text>) : null}
        <View style={{ marginTop: 12 }}>
          <Row label="CALL" v={u.callProbability} color={C.green} />
          <Row label="PUT" v={u.putProbability} color={C.red} />
          <Row label="WAIT" v={u.waitProbability} color={C.amber} />
          <Note>{u.disclaimer}</Note>
        </View>
        {top.length || against.length ? (
          <View style={{ marginTop: 10 }}>
            {top.length ? <Text style={s.hd}>{a.signal === 'PUT' ? 'Bearish factors' : 'Bullish factors'}</Text> : null}
            {top.map((r, i) => <Text key={i} style={s.li}>{'\u2022'} {r.text}</Text>)}
            {against.length ? <Text style={[s.hd, { marginTop: 8 }]}>Against</Text> : null}
            {against.map((r, i) => <Text key={i} style={[s.li, { color: C.muted }]}>{'\u2022'} {r.text}</Text>)}
          </View>
        ) : null}
        {feed.conn !== 'LIVE' && feed.connMsg ? <Note color={C.red}>{feed.connMsg}</Note> : null}
        {conn === 'DISCONNECTED' || conn === 'ERROR' || conn === 'RATE' ? <Note color={C.red}>{store.get().connMsg}</Note> : null}
      </Card>
      {rec ? (
        <Card title={`Recommended ${rec.side}`} style={{ borderColor: color }}>
          <Text style={[s.recMain, num, { color }]}>NIFTY {rec.strike} {rec.side === 'CALL' ? 'CE' : 'PE'}  @ {f2(rec.ltp)}</Text>
          <View style={s.grid}>
            <Cell k="IV" v={f2(rec.iv, 1)} /><Cell k="Delta" v={f2(rec.delta)} /><Cell k="Theta" v={f2(rec.theta, 1)} />
            <Cell k="Gamma" v={f2(rec.gamma, 4)} /><Cell k="OI" v={compact(rec.oi)} /><Cell k="Volume" v={compact(rec.vol)} />
            <Cell k="Bid" v={f2(rec.bid)} /><Cell k="Ask" v={f2(rec.ask)} /><Cell k="Spread" v={f2(rec.spreadPct) + '%'} />
          </View>
          <Note>{rec.reason}</Note>
        </Card>
      ) : null}
      {a.signal !== 'WAIT' && !rec && a.notes && a.notes.length ? <Card><Note color={C.amber}>{a.notes.join(' ')}</Note></Card> : null}
    </>
  );
}

const Row = ({ label, v, color }) => (
  <View style={s.rowBar}>
    <Text style={s.rl}>{label}</Text>
    <Bar pct={v} color={color} />
    <Text style={[s.rv, num]}>{Math.round(v)}%</Text>
  </View>
);
const Cell = ({ k, v }) => (
  <View style={s.cell}><Text style={s.ck}>{k}</Text><Text style={[s.cv, num]}>{v}</Text></View>
);

const s = StyleSheet.create({
  sig: { fontSize: 52, fontWeight: '900', letterSpacing: 2 },
  wait: { color: C.amber, fontSize: 40, fontWeight: '900' },
  conf: { color: C.text, fontSize: 20, fontWeight: '700', marginTop: 2 },
  small: { color: C.muted, fontSize: 11, fontWeight: '400' },
  reason: { fontSize: 13, marginTop: 8, lineHeight: 18 },
  rowBar: { flexDirection: 'row', alignItems: 'center', marginVertical: 3 },
  rl: { color: C.muted, width: 64, fontSize: 13 },
  rv: { color: C.text, width: 44, textAlign: 'right', fontSize: 13, fontWeight: '700' },
  hd: { color: C.muted, fontSize: 11, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4 },
  li: { color: C.text, fontSize: 14, lineHeight: 20, marginBottom: 2 },
  recMain: { fontSize: 22, fontWeight: '800', marginBottom: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: '33.33%', paddingVertical: 5 },
  ck: { color: C.muted, fontSize: 11 },
  cv: { color: C.text, fontSize: 16, fontWeight: '700' },
});
