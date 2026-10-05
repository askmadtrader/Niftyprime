import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { C, num } from '../theme';
import { store } from '../controller';
import { useStore } from '../store';
import { Card, KV, Note, Pill } from './primitives';
import { describeExpiry } from '../contracts';
import { validSpot, chainStatus, buildChainView, clampStrikes, CHAIN_STATUS } from '../chain';
import { analyzeOi, fmtInt, fmtDelta } from '../oi';

// Open-interest analysis for the SELECTED expiry only. Every number is the real Upstox oi / prev_oi; "--" = not sent.
const dcol = (v) => (v === null || v === undefined ? C.muted : v > 0 ? C.amber : v < 0 ? C.blue : C.muted);
const at = (h) => (h ? `${h.strike}  \u00b7  ${fmtInt(h.oi)}` : '--');
const atd = (h) => (h ? `${h.strike}  \u00b7  ${fmtDelta(h.delta)}` : '--');

function Wall({ w, color, label }) {
  if (!w) return <KV k={label} v="none found" />;
  return (
    <View style={{ marginBottom: 4 }}>
      <KV k={label} v={`${w.strike}  \u00b7  ${fmtInt(w.oi)}`} color={color} bold />
      <Text style={s.sub}>
        {Math.round(w.distance)} pts away {'\u00b7'} {Math.round(w.pctOfMax)}% of side max {'\u00b7'} prev {fmtInt(w.prevOi)} {'\u00b7'} change {fmtDelta(w.delta)}
      </Text>
    </View>
  );
}

export default function OiAnalysisCard() {
  const expiry = useStore(store, (x) => x.expiry);
  const chain = useStore(store, (x) => x.chain);
  const chainExpiry = useStore(store, (x) => x.chainExpiry);
  const cfr = useStore(store, (x) => x.chainFresh);
  const nifty = useStore(store, (x) => x.nifty);
  const nf = useStore(store, (x) => x.niftyFresh);
  const sNow = useStore(store, (x) => x.sNow);
  const strikes = useStore(store, (x) => x.settings.strikes);

  const spot = validSpot(nifty, nf);
  const r = useMemo(() => analyzeOi({ rows: chain, expiry, chainExpiry, spot }), [chain, expiry, chainExpiry, spot]);
  const st = chainStatus({ rows: chain, chainExpiry, expiry, fresh: cfr });
  const info = expiry ? describeExpiry(expiry, sNow) : null;
  const view = useMemo(() => (r.ok ? buildChainView(r.rows.map((x) => ({ strike: x.strike })), spot, strikes) : null), [r, spot, strikes]);
  const byStrike = useMemo(() => (r.ok ? new Map(r.rows.map((x) => [x.strike, x])) : null), [r]);
  const wallSet = useMemo(() => (r.ok ? new Set([...r.callWalls.map((w) => 'c' + w.strike), ...r.putWalls.map((w) => 'p' + w.strike)]) : new Set()), [r]);

  if (!r.ok) {
    return (
      <Card title="Open interest analysis" right={info ? info.date : '--'}>
        <Text style={s.none}>DATA UNAVAILABLE: {r.text}</Text>
      </Card>
    );
  }
  const q = r.quality;
  const missing = q.callMissingOi + q.putMissingOi, noPrev = q.callMissingPrev + q.putMissingPrev;
  const rows = view ? view.rows.map((x) => byStrike.get(x.strike)).filter(Boolean) : [];
  return (
    <Card title="Open interest analysis" right={info ? info.date : '--'}>
      <View style={s.statusRow}>
        <Pill text={st.status} color={st.status === CHAIN_STATUS.LIVE ? 'green' : st.status === CHAIN_STATUS.PREVIOUS ? 'blue' : 'amber'} solid />
        <Text style={s.statusTxt} numberOfLines={2}>{st.text}</Text>
      </View>
      <KV k="Highest CALL OI" v={at(r.highestCall)} color={C.red} bold />
      <KV k="Highest PUT OI" v={at(r.highestPut)} color={C.green} bold />
      <KV k="Largest CALL OI change (buildup)" v={atd(r.largestCallDelta)} color={C.red} />
      <KV k="Largest PUT OI change (buildup)" v={atd(r.largestPutDelta)} color={C.green} />
      <KV k="Largest CALL unwinding" v={atd(r.largestCallUnwind)} />
      <KV k="Largest PUT unwinding" v={atd(r.largestPutUnwind)} />

      <Text style={s.h}>OI WALLS (selected expiry)</Text>
      {r.wallsAvailable ? (
        <View>
          <Wall w={r.resistance} color={C.red} label="CALL resistance" />
          <Wall w={r.support} color={C.green} label="PUT support" />
          {r.callWalls.length > 1 ? <Note>Other CALL walls: {r.callWalls.slice(1).map((w) => `${w.strike} (${fmtInt(w.oi)})`).join(', ')}</Note> : null}
          {r.putWalls.length > 1 ? <Note>Other PUT walls: {r.putWalls.slice(1).map((w) => `${w.strike} (${fmtInt(w.oi)})`).join(', ')}</Note> : null}
        </View>
      ) : <Text style={s.none}>OI WALLS UNAVAILABLE: waiting for a valid NIFTY price from the live feed.</Text>}

      {rows.length ? (
        <View style={{ marginTop: 8 }}>
          <View style={s.row}>
            {['CALL OI', 'CALL chg', 'STRIKE', 'PUT chg', 'PUT OI'].map((h) => <View key={h} style={s.cell}><Text style={s.hc}>{h}</Text></View>)}
          </View>
          {rows.map((x) => (
            <View key={x.strike} style={[s.row, x.strike === view.atmStrike ? s.atm : null]}>
              <View style={s.cell}><Text style={[s.ct, num, wallSet.has('c' + x.strike) ? { color: C.red, fontWeight: '800' } : null]} numberOfLines={1}>{fmtInt(x.call.oi)}</Text></View>
              <View style={s.cell}><Text style={[s.ct, num, { color: dcol(x.call.delta) }]} numberOfLines={1}>{fmtDelta(x.call.delta)}</Text></View>
              <View style={[s.cell, s.strike]}><Text style={[s.st, num]}>{x.strike}</Text></View>
              <View style={s.cell}><Text style={[s.ct, num, { color: dcol(x.put.delta) }]} numberOfLines={1}>{fmtDelta(x.put.delta)}</Text></View>
              <View style={s.cell}><Text style={[s.ct, num, wallSet.has('p' + x.strike) ? { color: C.green, fontWeight: '800' } : null]} numberOfLines={1}>{fmtInt(x.put.oi)}</Text></View>
            </View>
          ))}
        </View>
      ) : null}

      <Note>Totals (all {q.strikes} strikes): CALL OI {fmtInt(r.totals.callOi)} ({fmtDelta(r.totals.callDelta)}), PUT OI {fmtInt(r.totals.putOi)} ({fmtDelta(r.totals.putDelta)}).</Note>
      {missing > 0 ? <Note color={C.amber}>{missing} option{missing === 1 ? '' : 's'} have no valid OI and are left out of the highest-OI and wall search.</Note> : null}
      {noPrev > 0 ? <Note color={C.amber}>{noPrev} option{noPrev === 1 ? '' : 's'} have no previous OI, so their change shows "--".</Note> : null}
      <Note>Change = OI now - previous OI (Upstox prev_oi, the previous trading day). Highest OI and changes cover every strike Upstox returned for this expiry. A wall is a local OI peak with at least 60% of the biggest OI on its side of NIFTY (CALL at/above, PUT at/below).</Note>
    </Card>
  );
}

const s = StyleSheet.create({
  none: { color: C.red, fontSize: 14, lineHeight: 20 },
  h: { color: C.muted, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginTop: 10, marginBottom: 4 },
  sub: { color: C.muted, fontSize: 11, marginTop: -2 },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  statusTxt: { color: C.text, fontSize: 12, marginLeft: 8, flexShrink: 1 },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderColor: C.border },
  atm: { backgroundColor: C.amberBg },
  cell: { flex: 1, height: 34, alignItems: 'center', justifyContent: 'center' },
  strike: { backgroundColor: C.card2 },
  hc: { color: C.muted, fontSize: 9, fontWeight: '800' },
  ct: { color: C.text, fontSize: 11 },
  st: { color: C.text, fontSize: 13, fontWeight: '800' },
});
