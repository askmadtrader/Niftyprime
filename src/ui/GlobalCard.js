import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { C, num } from '../theme';
import { store } from '../controller';
import { useStore } from '../store';
import { Card, Note, tone } from './primitives';
import { GLOBAL_ITEMS } from '../global';
import { f2, signed, fmtTime, fmtHM, fmtDMY } from '../util';
import { computeGlobalFreshness } from '../feed/freshness';

export default function GlobalCard() {
  const g = useStore(store, (s) => s.global);
  const at = useStore(store, (s) => s.globalAt);
  const err = useStore(store, (s) => s.globalErr);
  const groups = ['India', 'Macro', 'US', 'Asia'];
  return (
    <Card title="Global context" right={at ? `fetched ${fmtTime(at)}` : ''}>
      {groups.map((gr) => (
        <View key={gr} style={{ marginBottom: 8 }}>
          <Text style={s.gh}>{gr === 'India' ? 'INDIA' : gr === 'Macro' ? 'MACRO' : gr === 'US' ? 'US MARKETS (previous close if shut)' : 'ASIAN MARKETS'}</Text>
          {GLOBAL_ITEMS.filter((i) => i.group === gr).map((it) => {
            const d = g && g[it.id];
            const gf = d ? computeGlobalFreshness({ item: d, now: Date.now() }) : null;
            return (
              <View key={it.id} style={s.row}>
                <Text style={s.name}>{it.label}</Text>
                {!it.sym ? <Text style={s.na}>DATA UNAVAILABLE</Text>
                  : !g ? <Text style={s.na}>loading...</Text>
                  : d && !d.error ? (
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={[s.val, num, gf && gf.status === 'STALE' ? { color: C.muted } : null]}>{f2(d.price)}</Text>
                      <Text style={[s.chg, num, { color: tone(d.chg) }]}>{signed(d.chg)}  ({signed(d.pct)}%)</Text>
                      <Text style={s.na}>{gf && gf.marketTs ? `${gf.status === 'STALE' ? 'LAST CLOSE ' : ''}${fmtDMY(gf.tradingDate)} ${fmtHM(gf.marketTs)} IST` : 'timestamp invalid'}</Text>
                    </View>
                  ) : <Text style={s.na}>DATA UNAVAILABLE</Text>}
              </View>
            );
          })}
        </View>
      ))}
      {err ? <Note color={C.red}>{err}</Note> : null}
      <Note>GIFT NIFTY has no reliable free data feed, so it is not shown rather than guessed. Other values come from Yahoo Finance (unofficial, may lag or be delayed) and are used as context only, with a small weight in the signal.</Note>
    </Card>
  );
}

const s = StyleSheet.create({
  gh: { color: C.muted, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 2 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  name: { color: C.text, fontSize: 14 },
  val: { color: C.text, fontSize: 14, fontWeight: '700' },
  chg: { fontSize: 13, fontWeight: '700' },
  na: { color: C.muted, fontSize: 12 },
});
