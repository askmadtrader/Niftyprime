import React, { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native';
import { C, num } from '../theme';
import { store, setGift, clearGift } from '../controller';
import { useStore } from '../store';
import { Card, Note, tone } from './primitives';
import { GLOBAL_ITEMS } from '../global';
import { f2, signed, fmtTime, fmtHM, fmtDMY } from '../util';
import { computeGlobalFreshness } from '../feed/freshness';
import { describeValue } from '../feed/stamp';
import { basis } from '../futures';

const GIFT_STALE_MS = 30 * 60000;
function GiftRow() {
  const gift = useStore(store, (x) => x.settings.gift);
  const nifty = useStore(store, (x) => x.nifty);
  const [edit, setEdit] = useState(false);
  const [txt, setTxt] = useState('');
  const [err, setErr] = useState('');
  const save = () => { if (setGift(txt.replace(/,/g, ''))) { setEdit(false); setErr(''); setTxt(''); } else setErr('Enter a valid price, e.g. 22480.5'); };
  const age = gift ? Date.now() - gift.at : 0;
  const stale = gift && age > GIFT_STALE_MS;
  const ref = nifty && nifty.ltp ? nifty.ltp : null;
  const gap = gift && ref ? gift.price - ref : null;
  return (
    <View style={{ paddingVertical: 4 }}>
      <View style={s.row}>
        <View style={{ flex: 1 }}>
          <Text style={s.name}>GIFT NIFTY</Text>
          <Text style={s.na}>NSE IX: no feed in Upstox. Enter it from your broker app.</Text>
        </View>
        {gift ? (
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={[s.val, num, stale ? { color: C.muted } : null]}>{f2(gift.price)}</Text>
            {gap !== null ? <Text style={[s.chg, num, { color: tone(gap) }]}>{signed(gap)} vs NIFTY {f2(ref)}</Text> : null}
            <Text style={[s.na, stale ? { color: C.amber } : null]}>{`MANUAL \u00b7 ${stale ? 'STALE' : 'entered'} ${fmtTime(gift.at)} IST \u00b7 ${Math.round(age / 60000)} min ago`}</Text>
          </View>
        ) : <Text style={s.na}>NOT ENTERED</Text>}
      </View>
      {edit ? (
        <View style={s.editRow}>
          <TextInput value={txt} onChangeText={setTxt} keyboardType="decimal-pad" placeholder="GIFT NIFTY price" placeholderTextColor={C.muted} style={s.input} autoFocus />
          <Pressable onPress={save} style={s.btn}><Text style={s.btnT}>Save</Text></Pressable>
          <Pressable onPress={() => { setEdit(false); setErr(''); }} style={[s.btn, { backgroundColor: C.card2 }]}><Text style={s.btnT}>Cancel</Text></Pressable>
        </View>
      ) : (
        <View style={s.editRow}>
          <Pressable onPress={() => setEdit(true)} style={s.btn}><Text style={s.btnT}>{gift ? 'Update price' : 'Enter price'}</Text></Pressable>
          {gift ? <Pressable onPress={clearGift} style={[s.btn, { backgroundColor: C.card2 }]}><Text style={s.btnT}>Clear</Text></Pressable> : null}
        </View>
      )}
      {err ? <Text style={[s.na, { color: C.red }]}>{err}</Text> : null}
    </View>
  );
}

export default function GlobalCard() {
  const g = useStore(store, (s) => s.global);
  const at = useStore(store, (s) => s.globalAt);
  const err = useStore(store, (s) => s.globalErr);
  const fut = useStore(store, (s) => s.fut);
  const futFresh = useStore(store, (s) => s.futFresh);
  const futInfo = useStore(store, (s) => s.futInfo);
  const futErr = useStore(store, (s) => s.futErr);
  const nifty = useStore(store, (s) => s.nifty);
  const niftyFresh = useStore(store, (s) => s.niftyFresh);
  const sNow = useStore(store, (s) => s.sNow);
  const ms = useStore(store, (s) => s.market.state);
  const fd = describeValue(futFresh, sNow, ms);
  const bs = fut && nifty && niftyFresh && futFresh && futFresh.status === niftyFresh.status ? basis(fut.ltp, nifty.ltp) : null;
  const groups = ['India', 'USF', 'Macro', 'US', 'Asia'];
  return (
    <Card title="Global context" right={at ? `fetched ${fmtTime(at)}` : ''}>
      {groups.map((gr) => (
        <View key={gr} style={{ marginBottom: 8 }}>
          <Text style={s.gh}>{gr === 'India' ? 'INDIA' : gr === 'USF' ? 'US FUTURES (trade ~23h a day)' : gr === 'Macro' ? 'MACRO' : gr === 'US' ? 'US MARKETS (previous close if shut)' : 'ASIAN MARKETS'}</Text>
          {gr === 'India' ? (
            <View style={s.row}>
              <View style={{ flex: 1 }}>
                <Text style={s.name}>NIFTY Futures</Text>
                {futInfo ? <Text style={s.na}>{futInfo.tradingSymbol}</Text> : null}
              </View>
              {fut && futFresh && futFresh.status !== 'UNAVAILABLE' ? (
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={[s.val, num, futFresh.status === 'STALE' ? { color: C.muted } : null]}>{f2(fut.ltp)}</Text>
                  {fut.change != null ? <Text style={[s.chg, num, { color: tone(fut.change) }]}>{signed(fut.change)}  ({signed(fut.pct)}%)</Text> : null}
                  {bs ? <Text style={[s.na, num]}>Premium vs NIFTY {signed(bs.pts)} ({signed(bs.pct)}%)</Text> : null}
                  <Text style={s.na}>{`${fd.badge} \u00b7 ${fd.status} \u00b7 ${fd.asOf.replace('Data as of ', '')}`}</Text>
                </View>
              ) : <Text style={s.na}>{futErr ? 'DATA UNAVAILABLE' : 'loading...'}</Text>}
            </View>
          ) : null}
          {gr === 'India' ? <GiftRow /> : null}
          {GLOBAL_ITEMS.filter((i) => i.group === gr && i.id !== 'gift').map((it) => {
            const d = g && g[it.id];
            const gf = d ? computeGlobalFreshness({ item: d, now: Date.now() }) : null;
            return (
              <View key={it.id} style={s.row}>
                <Text style={s.name}>{it.label}</Text>
                {!it.sym ? <Text style={s.na}>DATA UNAVAILABLE (NSE IX, no feed)</Text>
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
      <Note>NIFTY Futures stream live from Upstox. GIFT NIFTY trades on NSE IX and has no free feed: the price here is the one YOU enter, labelled MANUAL with its time, and marked STALE after 30 minutes. Other values come from Yahoo Finance (unofficial, may lag or be delayed) and are used as context only, with a small weight in the signal.</Note>
    </Card>
  );
}

const s = StyleSheet.create({
  gh: { color: C.muted, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 2 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  name: { color: C.text, fontSize: 14 },
  val: { color: C.text, fontSize: 14, fontWeight: '700' },
  chg: { fontSize: 13, fontWeight: '700' },
  editRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  input: { flex: 1, height: 44, borderRadius: 10, backgroundColor: C.card2, borderWidth: 1, borderColor: C.border, color: C.text, paddingHorizontal: 12, fontSize: 16, marginRight: 8 },
  btn: { height: 44, paddingHorizontal: 14, borderRadius: 10, backgroundColor: C.green, alignItems: 'center', justifyContent: 'center', marginRight: 8 },
  btnT: { color: '#000', fontWeight: '800', fontSize: 14 },
  na: { color: C.muted, fontSize: 12 },
});
