import React from 'react';
import { View, Text, Switch, ScrollView, Pressable, StyleSheet } from 'react-native';
import { C, num } from '../theme';
import { store, updateSettings, clearAlerts } from '../controller';
import { useStore } from '../store';
import { ALERT_TYPES, tipFor } from '../alerts';
import { Card, Btn, Note } from './primitives';
import { LEVEL_RULES } from '../levelAlerts';
import { fmtTime } from '../util';

export default function AlertsScreen() {
  const settings = useStore(store, (s) => s.settings);
  const log = useStore(store, (s) => s.alerts);
  const toggle = (id, v) => updateSettings({ alerts: { ...settings.alerts, [id]: v } });
  const nifty = useStore(store, (x) => x.nifty);
  const vix = useStore(store, (x) => x.vix);
  const levels = settings.levels || {};
  const setLevel = (id, v) => updateSettings({ levels: { ...levels, [id]: v } });
  const base = (r) => { const q = r.src === 'price' ? nifty : vix; return q && q.ltp ? q.ltp : null; };
  return (
    <ScrollView contentContainerStyle={{ padding: 12 }}>
      <Card title="Price & VIX alerts" right="NO TRADING">
        {LEVEL_RULES.map((r) => {
          const v = levels[r.id];
          const dec = r.src === 'vix' ? 2 : 0;
          const start = () => { const b = base(r); if (b != null) setLevel(r.id, Number((r.src === 'vix' ? Math.round(b * 2) / 2 : Math.round(b / 50) * 50).toFixed(dec))); };
          return (
            <View key={r.id} style={s.row}>
              <Text style={s.lbl}>{r.label}</Text>
              {v == null ? (
                <Pressable style={s.sb2} onPress={start} disabled={base(r) == null}><Text style={s.sbt2}>{base(r) == null ? 'No live price' : 'Set'}</Text></Pressable>
              ) : (
                <View style={s.step}>
                  <Pressable style={s.sb} onPress={() => setLevel(r.id, Math.max(r.step, Number((v - r.step).toFixed(2))))}><Text style={s.sbt}>-</Text></Pressable>
                  <Text style={[s.sv, num]}>{v}</Text>
                  <Pressable style={s.sb} onPress={() => setLevel(r.id, Number((v + r.step).toFixed(2)))}><Text style={s.sbt}>+</Text></Pressable>
                  <Pressable style={[s.sb, { marginLeft: 6 }]} onPress={() => setLevel(r.id, null)}><Text style={s.sbt}>x</Text></Pressable>
                </View>
              )}
            </View>
          );
        })}
        <Note>An alert fires once when a LIVE price crosses the level, then switches itself off. Stale, missing or previous-session values never trigger it. Informational only; no order is ever placed.</Note>
      </Card>
      <Card title="Alert preferences" right="NO TRADING">
        {ALERT_TYPES.map((a) => (
          <View key={a.id} style={s.row}>
            <Text style={s.lbl}>{a.label}</Text>
            <Switch value={!!settings.alerts[a.id]} onValueChange={(v) => toggle(a.id, v)} trackColor={{ true: C.green, false: C.border }} thumbColor="#fff" />
          </View>
        ))}
        <View style={[s.row, { marginTop: 6 }]}>
          <Text style={s.lbl}>Vibrate on alert</Text>
          <Switch value={!!settings.vibrate} onValueChange={(v) => updateSettings({ vibrate: v })} trackColor={{ true: C.green, false: C.border }} thumbColor="#fff" />
        </View>
        <Note>Signals and alerts are informational only. No order is ever placed. Alerts fire while the app is open on screen (it keeps the screen awake). Android does not allow reliable live market polling in the background, so no background notifications are sent.</Note>
      </Card>
      <Card title="Recent alerts" right={log.length ? `${log.length}` : ''}>
        {log.length === 0 ? <Text style={s.none}>No alerts yet.</Text> : log.map((l) => (
          <View key={l.id} style={s.log}>
            <Text style={[s.t, num]}>{fmtTime(l.t)}</Text>
            <Text style={s.m}>{l.msg}</Text>
            {(l.tip || tipFor(l.type)) ? <Text style={s.tip}>{'\u2192'} {l.tip || tipFor(l.type)}</Text> : null}
          </View>
        ))}
        {log.length ? <Btn label="Clear" color={C.card2} style={{ marginTop: 10 }} onPress={clearAlerts} /> : null}
      </Card>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 },
  lbl: { color: C.text, fontSize: 15, flex: 1 },
  step: { flexDirection: 'row', alignItems: 'center' },
  sb: { width: 36, height: 36, borderRadius: 10, backgroundColor: C.card2, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.border },
  sbt: { color: C.text, fontSize: 18, fontWeight: '700' },
  sv: { color: C.text, fontSize: 15, fontWeight: '800', minWidth: 62, textAlign: 'center' },
  sb2: { paddingHorizontal: 14, height: 36, borderRadius: 10, backgroundColor: C.card2, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.border },
  sbt2: { color: C.text, fontSize: 13, fontWeight: '700' },
  none: { color: C.muted, fontSize: 14 },
  log: { paddingVertical: 6, borderBottomWidth: 1, borderColor: C.border },
  t: { color: C.muted, fontSize: 11 },
  m: { color: C.text, fontSize: 14 },
  tip: { color: C.amber, fontSize: 13, marginTop: 3 },
});
