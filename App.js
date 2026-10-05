import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, Pressable, AppState, ActivityIndicator, StyleSheet } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Linking from 'expo-linking';
import { useKeepAwake } from 'expo-keep-awake';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { C } from './src/theme';
import { store, init, start, stop, setToken, dismissBanner } from './src/controller';
import { useStore } from './src/store';
import TopBar from './src/ui/TopBar';
import SignalCard from './src/ui/SignalCard';
import MarketCard from './src/ui/MarketCard';
import NiftyAnalyticsCard from './src/ui/NiftyAnalyticsCard';
import ChainTable from './src/ui/ChainTable';
import OiAnalysisCard from './src/ui/OiAnalysisCard';
import PcrIvCard from './src/ui/PcrIvCard';
import GlobalCard from './src/ui/GlobalCard';
import ChartScreen from './src/ui/ChartScreen';
import AlertsScreen from './src/ui/AlertsScreen';
import SettingsScreen from './src/ui/SettingsScreen';
import LoginScreen from './src/ui/LoginScreen';
import Dashboard from './src/ui/Dashboard';

const TABS = [['dash', 'Dashboard'], ['chart', 'Chart'], ['alerts', 'Alerts'], ['settings', 'Settings']];

function ChartTab() {
  const locked = useStore(store, (x) => x.scrollLocked);
  return (
    <ScrollView scrollEnabled={!locked} nestedScrollEnabled contentContainerStyle={{ padding: 12, paddingBottom: 24 }} showsVerticalScrollIndicator={false}>
      <ChartScreen embedded />
    </ScrollView>
  );
}

function Main() {
  useKeepAwake();
  const ins = useSafeAreaInsets();
  const [tab, setTab] = useState('dash');
  const banner = useStore(store, (s) => s.banner);
  const count = useStore(store, (s) => s.alerts.length);
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <TopBar />
      {banner ? (
        <Pressable onPress={dismissBanner} style={s.banner}>
          <Text style={s.bt}>{'\u26A0'} {banner.msg}</Text>
          {banner.tip ? <Text style={s.bs}>{banner.tip}</Text> : null}
        </Pressable>
      ) : null}
      <View style={{ flex: 1 }}>
        {tab === 'dash' ? <Dashboard /> : tab === 'chart' ? <ChartTab /> : tab === 'alerts' ? <AlertsScreen /> : <SettingsScreen />}
      </View>
      <View style={[s.tabs, { paddingBottom: Math.max(ins.bottom, 10) + 10 }]}>
        {TABS.map(([k, l]) => (
          <Pressable key={k} style={s.tab} onPress={() => setTab(k)} hitSlop={{ top: 6, bottom: 6 }}>
            <Text style={[s.tl, tab === k ? { color: C.green } : null]}>{l}{k === 'alerts' && count ? ` (${count})` : ''}</Text>
            <View style={[s.ind, tab === k ? { backgroundColor: C.green } : null]} />
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function Root() {
  const ready = useStore(store, (s) => s.ready);
  const token = useStore(store, (s) => s.token);

  useEffect(() => {
    let alive = true;
    const grab = (url) => {
      const m = url && url.match(/token=([^&]+)/);
      if (m) setToken(decodeURIComponent(m[1]));
    };
    init().then(() => { if (alive) start(); });
    Linking.getInitialURL().then(grab).catch(() => {});
    const sub = Linking.addEventListener('url', (e) => grab(e.url));
    const app = AppState.addEventListener('change', (st) => { if (st === 'active') start(); else stop(); });
    return () => { alive = false; sub.remove(); app.remove(); stop(); };
  }, []);

  if (!ready) return <View style={s.center}><ActivityIndicator color={C.green} /></View>;
  return token ? <Main /> : <LoginScreen />;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Root />
    </SafeAreaProvider>
  );
}

const s = StyleSheet.create({
  center: { flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center' },
  banner: { backgroundColor: C.amber, paddingHorizontal: 14, paddingVertical: 10 },
  bt: { color: '#000', fontWeight: '800', fontSize: 14 },
  bs: { color: '#000', fontSize: 13, marginTop: 3 },
  tabs: { flexDirection: 'row', backgroundColor: '#0e141b', borderTopWidth: 1, borderColor: C.border },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 14, minHeight: 60 },
  tl: { color: C.muted, fontSize: 16, fontWeight: '800' },
  ind: { height: 4, width: 36, borderRadius: 2, marginTop: 8, backgroundColor: 'transparent' },
});
