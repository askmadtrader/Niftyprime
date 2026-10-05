import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, num } from '../theme';
import { store, deriveStatus } from '../controller';
import { describeValue } from '../feed/stamp';
import { MARKET_STATE_LABEL } from '../feed/marketStatus';
import { useStore } from '../store';
import { f2, signed, fmtTime, fmtHM, fmtDMY } from '../util';
import { Pill, tone } from './primitives';

// One line per value: exchange time + status. Shown for NIFTY and VIX alike.
function stamp(inst, fresh) {
  if (!inst) return 'no data';
  const t = inst.tsValid ? `${fmtTime(inst.ltt)} IST` : 'timestamp invalid';
  return `${t} \u00b7 ${fresh ? fresh.status : '--'}`;
}

export default function TopBar() {
  const ins = useSafeAreaInsets();
  const nifty = useStore(store, (s) => s.nifty);
  const vix = useStore(store, (s) => s.vix);
  const feed = useStore(store, (s) => s.feed);
  const conn = useStore(store, (s) => s.conn);
  const market = useStore(store, (s) => s.market);
  const nf = useStore(store, (s) => s.niftyFresh);
  const vf = useStore(store, (s) => s.vixFresh);
  const sNow = useStore(store, (s) => s.sNow);
  const info = useStore(store, (s) => s.candlesInfo);
  const lastOk = useStore(store, (s) => s.lastOk);
  const [, setTick] = useState(0);
  const [open, setOpen] = useState(false);
  useEffect(() => { const id = setInterval(() => setTick((x) => x + 1), 1000); return () => clearInterval(id); }, []);
  const st = deriveStatus({ conn, feed, market, niftyFresh: nf });
  const live = st.key === 'LIVE';
  const dim = (f) => (!f || f.status === 'STALE' || f.status === 'DISCONNECTED' || f.status === 'UNAVAILABLE');
  // Which session does each value belong to? Never imply "today" unless the value's own exchange timestamp says so.
  const nd = describeValue(nf, sNow, market.state);
  const vd = describeValue(vf, sNow, market.state);
  const prevSession = (d) => d.status !== 'UNAVAILABLE' && d.session !== 'CURRENT';
  return (
    <View style={[s.wrap, { paddingTop: ins.top + 6 }]}>
      <View style={s.row}>
        <View style={{ flex: 1 }}>
          <Text style={s.lbl}>NIFTY 50</Text>
          <Text style={[s.big, num, nifty && dim(nf) ? { color: C.muted } : null]}>{nifty ? f2(nifty.ltp) : 'DATA UNAVAILABLE'}</Text>
          {nifty && nifty.change != null ? <Text style={[s.chg, num, { color: tone(nifty.change) }]}>{signed(nifty.change)}  ({signed(nifty.pct)}%)</Text> : null}
          <Text style={[s.ts, num]}>{stamp(nifty, nf)}</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={s.lbl}>INDIA VIX</Text>
          <Text style={[s.mid, num, vix && dim(vf) ? { color: C.muted } : null]}>{vix ? f2(vix.ltp) : 'DATA UNAVAILABLE'}</Text>
          {vix && vix.change != null ? <Text style={[s.chg, num, { color: tone(-vix.change) }]}>{signed(vix.change)}  ({signed(vix.pct)}%)</Text> : null}
          <Text style={[s.ts, num]}>{stamp(vix, vf)}</Text>
        </View>
      </View>
      <View style={[s.row, { marginTop: 8, alignItems: 'center' }]}>
        <Pill text={st.key} color={st.color} solid />
        {(MARKET_STATE_LABEL[market.state] || market.state) !== st.key ? (
          <>
            <View style={{ width: 6 }} />
            <Pill text={MARKET_STATE_LABEL[market.state] || market.state} color={market.state === 'NORMAL_OPEN' ? 'green' : 'muted'} />
          </>
        ) : null}
        <View style={{ flex: 1 }} />
        <Text style={[s.ts, num]}>{nifty ? `Received ${fmtTime(nifty.receivedAt)}` : 'Received --'}</Text>
      </View>
      {st.sub ? <Text style={[s.ts, { marginTop: 3, color: C.amber }]}>{st.sub}</Text> : null}
      <Pressable onPress={() => setOpen(!open)} hitSlop={6}>
        <Text style={[s.ts, num, { marginTop: 3, color: C.text, fontWeight: '700' }]}>{nd.asOf}  {open ? '\u25B2' : '\u25BC details'}</Text>
      </Pressable>
      {open && nifty ? (
        <Text style={[s.ts, num, { marginTop: 3 }]}>
          NIFTY: <Text style={{ color: prevSession(nd) ? C.amber : C.green, fontWeight: '800' }}>{nd.badge}</Text>{nd.tradingDate ? ` \u00b7 ${fmtDMY(nd.tradingDate)}` : ''}{prevSession(nd) ? `  (${nd.label})` : ''}
        </Text>
      ) : null}
      {open && vix ? (
        <Text style={[s.ts, num]}>
          VIX: <Text style={{ color: prevSession(vd) ? C.amber : C.green, fontWeight: '800' }}>{vd.badge}</Text>{vd.tradingDate ? ` \u00b7 ${fmtDMY(vd.tradingDate)}` : ''}  {vd.status}
        </Text>
      ) : null}
      {open ? <Text style={[s.ts, num, { marginTop: 3 }]}>
        {info.lastT ? `Candles: ${info.label} (last ${fmtHM(info.lastT)})` : 'Candles: none'} | Last OK {lastOk ? fmtTime(lastOk) : '--'} IST
      </Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { backgroundColor: '#0e141b', paddingHorizontal: 14, paddingBottom: 10, borderBottomWidth: 1, borderColor: C.border },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  lbl: { color: C.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  big: { color: C.text, fontSize: 30, fontWeight: '800' },
  mid: { color: C.text, fontSize: 22, fontWeight: '800' },
  chg: { fontSize: 14, fontWeight: '700' },
  ts: { color: C.muted, fontSize: 11 },
});
