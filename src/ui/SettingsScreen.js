import React from 'react';
import { View, Text, ScrollView, Pressable, Switch, StyleSheet } from 'react-native';
import { C, num } from '../theme';
import { store, updateSettings, setExpiry, logout } from '../controller';
import { useStore } from '../store';
import { Card, Chip, Btn, KV, Note } from './primitives';
import { fmtTime } from '../util';
import { describeExpiry } from '../contracts';
import { MARKET_STATE_LABEL } from '../feed/marketStatus';

const Stepper = ({ value, min, max, step = 1, suffix = '', onChange }) => (
  <View style={s.step}>
    <Pressable style={s.sb} onPress={() => onChange(Math.max(min, value - step))}><Text style={s.sbt}>-</Text></Pressable>
    <Text style={[s.sv, num]}>{value}{suffix}</Text>
    <Pressable style={s.sb} onPress={() => onChange(Math.min(max, value + step))}><Text style={s.sbt}>+</Text></Pressable>
  </View>
);

export default function SettingsScreen() {
  const st = useStore(store, (x) => x.settings);
  const exps = useStore(store, (x) => x.expiries);
  const expiry = useStore(store, (x) => x.expiry);
  const conn = useStore(store, (x) => x.conn);
  const lastOk = useStore(store, (x) => x.lastOk);
  const chainAt = useStore(store, (x) => x.chainAt);
  const feed = useStore(store, (x) => x.feed);
  const market = useStore(store, (x) => x.market);
  const nf = useStore(store, (x) => x.niftyFresh);
  const vf = useStore(store, (x) => x.vixFresh);
  const nifty = useStore(store, (x) => x.nifty);
  const vix = useStore(store, (x) => x.vix);
  const marketInfoAt = useStore(store, (x) => x.marketInfoAt);
  const globalAt = useStore(store, (x) => x.globalAt);
  return (
    <ScrollView contentContainerStyle={{ padding: 12 }}>
      <Card title="Expiry">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {exps.length ? exps.slice(0, 10).map((e) => <View key={e} style={{ marginBottom: 8 }}><Chip label={`${describeExpiry(e, store.get().sNow).date}  (${describeExpiry(e, store.get().sNow).days}d)`} active={e === expiry} onPress={() => setExpiry(e)} /></View>) : <Text style={s.mut}>No expiries loaded yet</Text>}
        </View>
        <Note>Expiries come from live Upstox NIFTY option contracts. The nearest valid expiry is selected automatically and rolls to the next one after expiry (15:30 IST).</Note>
      </Card>
      <Card title="Display and refresh">
        <View style={s.row}><Text style={s.lbl}>Strikes each side of ATM</Text><Stepper value={st.strikes} min={5} max={15} onChange={(v) => updateSettings({ strikes: v })} /></View>
        <View style={s.row}><Text style={s.lbl}>Refresh every</Text><Stepper value={st.refreshSec} min={5} max={30} step={5} suffix="s" onChange={(v) => updateSettings({ refreshSec: v })} /></View>
        <Note>5 s is the fastest setting to stay inside Upstox API rate limits.</Note>
      </Card>
      <Card title="Signal tuning">
        <Text style={s.lbl}>Sensitivity (edge needed between bullish and bearish)</Text>
        <View style={{ flexDirection: 'row', marginVertical: 8 }}>
          {[['LOW', 'Strict'], ['MED', 'Normal'], ['HIGH', 'Sensitive']].map(([k, l]) => <Chip key={k} label={l} active={st.sens === k} onPress={() => updateSettings({ sens: k })} />)}
        </View>
        <View style={s.row}><Text style={s.lbl}>Minimum confidence for CALL/PUT</Text><Stepper value={st.confThr} min={50} max={90} step={5} suffix="%" onChange={(v) => updateSettings({ confThr: v })} /></View>
        <Note>These two settings no longer change the CALL / PUT / WAIT signal: it comes from the probability signal engine with fixed, tested thresholds. They only affect the legacy contract suggestion.</Note>
      </Card>
      <Card title="Alert settings">
        <View style={s.row}><Text style={s.lbl}>Vibrate on alert</Text><Switch value={!!st.vibrate} onValueChange={(v) => updateSettings({ vibrate: v })} trackColor={{ true: C.green, false: C.border }} thumbColor="#fff" /></View>
        <View style={s.row}><Text style={s.lbl}>Signal alerts enabled</Text><Text style={[s.mut, num]}>{Object.values(st.alerts || {}).filter(Boolean).length}/{Object.keys(st.alerts || {}).length}</Text></View>
        <View style={s.row}><Text style={s.lbl}>Price / VIX levels armed</Text><Text style={[s.mut, num]}>{Object.values(st.levels || {}).filter((x) => x != null).length}</Text></View>
        <Note>Choose individual alerts on the Alerts tab. Alerts only work while the app is open. No trades are ever placed.</Note>
      </Card>
      <Card title="Connection & data status" right="LIVE / STALE / OFFLINE">
        <KV k="Live feed (WebSocket)" v={feed.conn} color={feed.conn === 'LIVE' ? C.green : C.amber} />
        <KV k="Market status" v={`${MARKET_STATE_LABEL[market.state] || market.state}${market.source ? ' (' + market.source + ')' : ''}`} />
        <KV k="Market status received" v={marketInfoAt ? fmtTime(marketInfoAt) : '--'} />
        <KV k="NIFTY last tick" v={nifty ? `${nifty.tsValid ? fmtTime(nifty.ltt) : 'invalid ts'} \u00b7 ${nf ? nf.status : '--'}` : 'UNAVAILABLE'} />
        <KV k="VIX last tick" v={vix ? `${vix.tsValid ? fmtTime(vix.ltt) : 'invalid ts'} \u00b7 ${vf ? vf.status : '--'}` : 'UNAVAILABLE'} />
        <KV k="REST connection" v={conn} />
        <KV k="Last successful update" v={lastOk ? fmtTime(lastOk) + ' IST' : '--'} />
        <KV k="Option chain" v={chainAt ? fmtTime(chainAt) : '--'} />
        <KV k="Global data" v={globalAt ? fmtTime(globalAt) : '--'} />
      </Card>
      <Card title="Debug (no secrets shown)">
        <KV k="App session" v={store.get().token ? 'Logged in' : 'Logged out'} />
        <KV k="Feed attempt" v={String(feed.attempt || 0)} />
        <KV k="Feed message" v={feed.connMsg || '--'} />
        <KV k="Selected expiry" v={expiry || '--'} />
        <KV k="Expiries loaded" v={String(exps.length)} />
      </Card>
      <Card title="Account & security">
        <Btn label="Logout from Upstox" color={C.red} onPress={logout} />
        <Note>Upstox sessions expire every day (around 03:30 IST). Log in once each morning. Your API key and secret are never stored in this app; they live only on your Cloudflare Worker. The session token is kept in Android's secure storage.</Note>
      </Card>
      <Card title="About">
        <Note>NiftyView is an analysis and decision-support tool. It never places orders. Signals are rule-based estimates from live data and can be wrong. Trading options involves substantial risk of loss.</Note>
      </Card>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 },
  lbl: { color: C.text, fontSize: 14, flex: 1, paddingRight: 8 },
  mut: { color: C.muted },
  step: { flexDirection: 'row', alignItems: 'center' },
  sb: { width: 40, height: 40, borderRadius: 10, backgroundColor: C.card2, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.border },
  sbt: { color: C.text, fontSize: 22, fontWeight: '700' },
  sv: { color: C.text, fontSize: 16, fontWeight: '800', minWidth: 54, textAlign: 'center' },
});
