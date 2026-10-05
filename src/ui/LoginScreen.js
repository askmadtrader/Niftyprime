import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import * as Linking from 'expo-linking';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C } from '../theme';
import { store } from '../controller';
import { useStore } from '../store';
import { Btn, Note } from './primitives';

export const AUTH_URL = 'https://niftyview-auth.numbbet-nifty.workers.dev/login';

export default function LoginScreen() {
  const ins = useSafeAreaInsets();
  const msg = useStore(store, (s) => s.connMsg);
  const conn = useStore(store, (s) => s.conn);
  return (
    <View style={[s.root, { paddingTop: ins.top + 60 }]}>
      <Text style={s.title}>NiftyView</Text>
      <Text style={s.sub}>NIFTY options analysis terminal</Text>
      <View style={{ height: 40 }} />
      {conn === 'AUTH' && msg ? <Text style={s.err}>{msg}</Text> : null}
      <Btn label="Login to Upstox" onPress={() => Linking.openURL(AUTH_URL)} />
      <Note>After logging in, tap "Open NiftyView" on the confirmation page. You need to do this once every trading day because Upstox sessions expire daily.</Note>
      <Note>Analysis only. This app never places trades.</Note>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg, padding: 24 },
  title: { color: C.text, fontSize: 38, fontWeight: '900' },
  sub: { color: C.muted, fontSize: 15, marginTop: 4 },
  err: { color: C.red, fontSize: 14, marginBottom: 14 },
});
