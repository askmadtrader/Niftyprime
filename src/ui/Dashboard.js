import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, Pressable, BackHandler, StyleSheet } from 'react-native';
import { C, num } from '../theme';
import { store, refreshNow, setDashSection } from '../controller';
import { useStore } from '../store';
import { describeValue } from '../feed/stamp';
import { describeExpiry } from '../contracts';
import { chainStatus, validSpot, buildChainView } from '../chain';
import { pcrOf } from '../pcriv';
import { f2, signed, fmtTime } from '../util';
import SignalCard from './SignalCard';
import NiftyAnalyticsCard from './NiftyAnalyticsCard';
import ChainTable from './ChainTable';
import OiAnalysisCard from './OiAnalysisCard';
import PcrIvCard from './PcrIvCard';
import ChartScreen from './ChartScreen';
import GlobalCard from './GlobalCard';

const STATUS_COLOR = { LIVE: C.green, FRESH: C.green, STALE: C.amber, 'PREVIOUS SESSION': C.blue, DISCONNECTED: C.red, UNAVAILABLE: C.red, LOADING: C.muted };
const colorOf = (s) => STATUS_COLOR[s] || C.muted;

// One summary hook per section: { text, status, at }. Every status is the section's own freshness, never a guess.
function useSignalSummary() {
  const a = useStore(store, (s) => s.analysis);
  const nf = useStore(store, (s) => s.niftyFresh);
  const sNow = useStore(store, (s) => s.sNow);
  const ms = useStore(store, (s) => s.market.state);
  if (!a || !a.ui) return { text: 'Waiting for data...', status: 'LOADING', at: '' };
  const d = describeValue(nf, sNow, ms);
  return { text: `${a.signal}  \u00b7  ${a.ui.confidence} confidence${a.ui.gateOk ? '' : '  \u00b7  data gate not passed'}`, status: a.ui.gateOk ? d.status : 'STALE', at: d.asOf.replace('Data as of ', '') , big: a.signal };
}
function useLevelsSummary() {
  const nifty = useStore(store, (s) => s.nifty);
  const nf = useStore(store, (s) => s.niftyFresh);
  const sNow = useStore(store, (s) => s.sNow);
  const ms = useStore(store, (s) => s.market.state);
  const d = describeValue(nf, sNow, ms);
  return { text: nifty ? `NIFTY ${f2(nifty.ltp)}  \u00b7  ${d.badge}` : 'NIFTY: DATA UNAVAILABLE', status: nf ? nf.status : 'UNAVAILABLE', at: d.asOf.replace('Data as of ', '') };
}
function useChainBase() {
  const chain = useStore(store, (s) => s.chain);
  const chainExpiry = useStore(store, (s) => s.chainExpiry);
  const expiry = useStore(store, (s) => s.expiry);
  const cfr = useStore(store, (s) => s.chainFresh);
  const chainAt = useStore(store, (s) => s.chainAt);
  const nifty = useStore(store, (s) => s.nifty);
  const nf = useStore(store, (s) => s.niftyFresh);
  const sNow = useStore(store, (s) => s.sNow);
  const st = chainStatus({ rows: chain, chainExpiry, expiry, fresh: cfr });
  return { st, chain, expiry, chainAt, spot: validSpot(nifty, nf), sNow, ok: st.status !== 'UNAVAILABLE' };
}
function useChainSummary() {
  const b = useChainBase();
  const exp = b.expiry ? describeExpiry(b.expiry, b.sNow).date : 'no expiry';
  const view = b.ok ? buildChainView(b.chain, b.spot, 1) : null;
  return { text: `Expiry ${exp}  \u00b7  ATM ${view && view.atmStrike ? view.atmStrike : '--'}`, status: b.st.status, at: b.chainAt ? fmtTime(b.chainAt) + ' IST' : '' };
}
function useOiSummary() {
  const b = useChainBase();
  const a = useStore(store, (s) => s.analysis);
  const l = a && a.levels;
  const txt = l && (l.majorS || l.majorR) ? `Support ${l.majorS ? l.majorS.strike : '--'}  \u00b7  Resistance ${l.majorR ? l.majorR.strike : '--'}` : 'OI walls, buildup, unwinding';
  return { text: txt, status: b.st.status, at: b.chainAt ? fmtTime(b.chainAt) + ' IST' : '' };
}
function usePcrSummary() {
  const b = useChainBase();
  let v = null; if (b.ok) { try { v = pcrOf(b.chain).value; } catch (e) { v = null; } }
  return { text: `Total PCR ${v === null ? '--' : v.toFixed(2)}  \u00b7  IV and Greeks`, status: b.st.status, at: b.chainAt ? fmtTime(b.chainAt) + ' IST' : '' };
}
function useChartSummary() {
  const chart = useStore(store, (s) => s.chart);
  const nf = useStore(store, (s) => s.niftyFresh);
  const last = chart.candles.length ? chart.candles[chart.candles.length - 1] : null;
  return { text: last ? `${chart.tf}m candles  \u00b7  last ${f2(last.c)}` : `${chart.tf}m candles`, status: chart.candles.length ? (nf ? nf.status : 'LOADING') : 'LOADING', at: chart.at ? fmtTime(chart.at) + ' IST' : '' };
}
function useGlobalSummary() {
  const fut = useStore(store, (s) => s.fut);
  const ff = useStore(store, (s) => s.futFresh);
  const at = useStore(store, (s) => s.globalAt);
  const gift = useStore(store, (s) => s.settings.gift);
  const bits = [];
  bits.push(fut ? `NIFTY Fut ${f2(fut.ltp)}${fut.pct != null ? ' (' + signed(fut.pct) + '%)' : ''}` : 'NIFTY Fut --');
  bits.push(gift ? `GIFT ${f2(gift.price, 2)} (manual)` : 'GIFT: not entered');
  return { text: bits.join('  \u00b7  '), status: ff ? ff.status : 'UNAVAILABLE', at: at ? fmtTime(at) + ' IST' : '' };
}

const SECTIONS = [
  { id: 'signal', title: 'Signal', icon: '\u25C9', hook: useSignalSummary, Body: SignalCard, refresh: 'signal' },
  { id: 'levels', title: 'NIFTY levels & momentum', icon: '\u2261', hook: useLevelsSummary, Body: NiftyAnalyticsCard, refresh: 'signal' },
  { id: 'chain', title: 'Option chain', icon: '\u25A6', hook: useChainSummary, Body: ChainTable, refresh: 'chain' },
  { id: 'oi', title: 'Open interest', icon: '\u2593', hook: useOiSummary, Body: OiAnalysisCard, refresh: 'chain' },
  { id: 'pcr', title: 'PCR, IV & Greeks', icon: '\u03B4', hook: usePcrSummary, Body: PcrIvCard, refresh: 'chain' },
  { id: 'chart', title: 'Chart', icon: '\u2197', hook: useChartSummary, Body: ChartBody, refresh: 'chart' },
  { id: 'global', title: 'Futures, GIFT & global', icon: '\u2641', hook: useGlobalSummary, Body: GlobalCard, refresh: 'global' },
];
function ChartBody() { return <ChartScreen embedded />; }

function RefreshBtn({ kind }) {
  const [busy, setBusy] = useState(false);
  const go = () => { refreshNow(kind); setBusy(true); setTimeout(() => setBusy(false), 1500); };
  return (
    <Pressable onPress={go} hitSlop={10} style={[s.rf, busy ? { opacity: 0.5 } : null]} accessibilityLabel="Refresh this section">
      <Text style={s.rfT}>{busy ? '\u2026' : '\u21BB'}</Text>
    </Pressable>
  );
}

function Tile({ sec }) {
  const sum = sec.hook();
  const sig = sec.id === 'signal' && sum.big;
  const bigColor = sig === 'CALL' ? C.green : sig === 'PUT' ? C.red : C.amber;
  return (
    <Pressable onPress={() => setDashSection(sec.id)} style={({ pressed }) => [s.tile, pressed ? { opacity: 0.75 } : null]}>
      <View style={s.tileTop}>
        <Text style={s.icon}>{sec.icon}</Text>
        <Text style={s.title}>{sec.title}</Text>
        <View style={[s.badge, { borderColor: colorOf(sum.status) }]}><Text style={[s.badgeT, { color: colorOf(sum.status) }]}>{sum.status}</Text></View>
        <RefreshBtn kind={sec.refresh} />
      </View>
      <Text style={[s.sum, num, sig ? { color: bigColor, fontWeight: '800' } : null]} numberOfLines={2}>{sum.text}</Text>
      <View style={s.tileBot}>
        <Text style={s.at}>{sum.at ? `as of ${sum.at}` : 'no data yet'}</Text>
        <Text style={s.open}>Open {'\u203A'}</Text>
      </View>
    </Pressable>
  );
}

export default function Dashboard() {
  const open = useStore(store, (x) => x.dashOpen);
  const locked = useStore(store, (x) => x.scrollLocked);
  const sec = SECTIONS.find((x) => x.id === open) || null;

  useEffect(() => {
    if (!sec) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { setDashSection(null); return true; });
    return () => sub.remove();
  }, [sec]);

  if (!sec) {
    return (
      <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 24 }} showsVerticalScrollIndicator={false}>
        <Text style={s.hint}>Tap a section to open it. Tap {'\u21BB'} to refresh just that section.</Text>
        {SECTIONS.map((x) => <Tile key={x.id} sec={x} />)}
      </ScrollView>
    );
  }
  const Body = sec.Body;
  return (
    <View style={{ flex: 1 }}>
      <View style={s.bar}>
        <Pressable onPress={() => setDashSection(null)} hitSlop={10} style={s.back}><Text style={s.backT}>{'\u2039'} Back</Text></Pressable>
        <Text style={s.barTitle} numberOfLines={1}>{sec.title}</Text>
        <RefreshBtn kind={sec.refresh} />
      </View>
      <ScrollView scrollEnabled={!locked} nestedScrollEnabled contentContainerStyle={{ padding: 12, paddingBottom: 24 }} showsVerticalScrollIndicator={false}>
        <Body />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  hint: { color: C.muted, fontSize: 12, marginBottom: 10 },
  tile: { backgroundColor: C.card, borderRadius: 14, borderWidth: 1, borderColor: C.border, padding: 14, marginBottom: 10 },
  tileTop: { flexDirection: 'row', alignItems: 'center' },
  icon: { color: C.blue, fontSize: 18, width: 26 },
  title: { color: C.text, fontSize: 16, fontWeight: '800', flex: 1 },
  badge: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2, marginRight: 8 },
  badgeT: { fontSize: 10, fontWeight: '800', letterSpacing: 0.4 },
  rf: { width: 40, height: 40, borderRadius: 10, backgroundColor: C.card2, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  rfT: { color: C.text, fontSize: 20, fontWeight: '700' },
  sum: { color: C.text, fontSize: 15, marginTop: 8 },
  tileBot: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  at: { color: C.muted, fontSize: 11 },
  open: { color: C.green, fontSize: 12, fontWeight: '800' },
  bar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderColor: C.border, backgroundColor: C.bg },
  back: { paddingRight: 12, height: 40, justifyContent: 'center' },
  backT: { color: C.green, fontSize: 16, fontWeight: '800' },
  barTitle: { color: C.text, fontSize: 16, fontWeight: '800', flex: 1 },
});
