import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { C, num } from '../theme';
import { store } from '../controller';
import { useStore } from '../store';
import { Card, Note } from './primitives';

const LABEL = { vwap: 'VWAP / session average', openingRange: 'Opening range', momentum: 'Momentum', trend: 'Trend (EMA 9 / 21)', structure: 'Price structure', oiWalls: 'OI walls', oiFlow: 'OI flow (\u0394OI)', pcrNear: 'Near-ATM PCR', pcrTotal: 'Total PCR', ivPrice: 'IV vs price', vix: 'India VIX', global: 'Global cues' };

export default function ExplainCard() {
  const a = useStore(store, (s) => s.analysis);
  const u = a && a.ui;
  const fs = u && u.factors ? u.factors.filter((f) => f.available) : [];
  const side = (v) => (v > 0.05 ? 'bull' : v < -0.05 ? 'bear' : 'neutral');
  return (
    <Card title="Signal explanation">
      {!u ? (
        <Text style={s.t}>No live analysis yet.</Text>
      ) : !u.directionalScored ? (
        <Text style={s.t}>No signal because: {u.blockers.length ? u.blockers.join(' ') : 'the data-quality gate did not pass.'}</Text>
      ) : (
        <>
          <Text style={s.t}>
            Each factor below is measured from live data, then weighted. Internal model scores: CALL {u.callProbability}%, PUT {u.putProbability}%, WAIT {u.waitProbability}%. {a.signal === 'WAIT' ? `Result is WAIT: ${u.blockers.join(' ')}` : `Result is ${a.signal} with ${u.confidence} confidence.`}
          </Text>
          <View style={{ height: 8 }} />
          {fs.map((f) => (
            <View key={f.id} style={s.row}>
              <Text style={[s.dot, { color: side(f.score) === 'bull' ? C.green : side(f.score) === 'bear' ? C.red : C.muted }]}>{side(f.score) === 'bull' ? '\u25B2' : side(f.score) === 'bear' ? '\u25BC' : '\u25CF'}</Text>
              <View style={{ flex: 1 }}>
                <Text style={s.name}>{LABEL[f.id] || f.id} <Text style={s.w}>weight {f.weight}{side(f.score) !== 'neutral' ? `, strength ${Math.round(Math.abs(f.score) * 100)}%` : ''}</Text></Text>
                <Text style={s.desc}>{f.text}</Text>
              </View>
            </View>
          ))}
          {u.missing.length ? <Text style={[s.desc, { marginTop: 6 }]}>Not available: {u.missing.map((m) => LABEL[m.id] || m.id).join(', ')}</Text> : null}
        </>
      )}
      <Note>{(u && u.disclaimer) || 'Internal model score / estimated probability; not a statistical guarantee.'} Options can lose their full premium quickly. The decision and the risk are yours; the app never places orders.</Note>
    </Card>
  );
}

const s = StyleSheet.create({
  t: { color: C.text, fontSize: 14, lineHeight: 20 },
  row: { flexDirection: 'row', paddingVertical: 5 },
  dot: { width: 22, fontSize: 14, marginTop: 1 },
  name: { color: C.text, fontSize: 14, fontWeight: '700' },
  w: { color: C.muted, fontSize: 11, fontWeight: '400' },
  desc: { color: C.muted, fontSize: 13, lineHeight: 18 },
});
