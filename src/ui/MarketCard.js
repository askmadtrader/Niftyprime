import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Polyline } from 'react-native-svg';
import { C } from '../theme';
import { store } from '../controller';
import { useStore } from '../store';
import { Card, KV, Note } from './primitives';
import { describeValue } from '../feed/stamp';
import { fmtDMY } from '../util';
import { f2, compact, fmtTime } from '../util';

function Spark({ data, color }) {
  if (!data || data.length < 2) return null;
  const w = 300, h = 54; const mn = Math.min(...data), mx = Math.max(...data), r = mx - mn || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - mn) / r) * (h - 4) - 2}`).join(' ');
  return (
    <Svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <Polyline points={pts} fill="none" stroke={color} strokeWidth="2" />
    </Svg>
  );
}

export default function MarketCard() {
  const q = useStore(store, (s) => s.nifty);
  const a = useStore(store, (s) => s.analysis);
  const nf = useStore(store, (s) => s.niftyFresh);
  const sNow = useStore(store, (s) => s.sNow);
  const ms = useStore(store, (s) => s.market.state);
  const t = a && a.tech;
  const d = describeValue(nf, sNow, ms);
  const up = q && q.change != null && q.change >= 0;
  return (
    <Card title="NIFTY market" right={a && a.session && a.session.date ? a.session.label : ''}>
      {!q ? <Text style={s.none}>DATA UNAVAILABLE</Text> : (
        <>
          <Spark data={t && t.spark} color={up ? C.green : C.red} />
          <View style={{ height: 8 }} />
          <KV k="Session" v={d.label} color={d.session === 'CURRENT' ? C.green : C.amber} />
          <KV k="Trading date" v={d.tradingDate ? fmtDMY(d.tradingDate) : 'unknown (timestamp invalid)'} />
          <KV k="Market time (exchange)" v={q.tsValid ? `${fmtTime(q.ltt)} IST` : 'invalid'} />
          <KV k="Received (device)" v={`${fmtTime(q.receivedAt)} IST`} />
          <KV k="Status" v={nf ? nf.status : '--'} color={nf && (nf.status === 'LIVE' || nf.status === 'FRESH') ? C.green : C.amber} />
          <Note color={C.text}>{d.asOf}</Note>
          {q.volume > 0 ? <KV k="Volume" v={compact(q.volume)} /> : null}
          {t ? (
            <>
              <KV k="Trend" v={t.trend} color={t.trend.includes('UP') ? C.green : t.trend.includes('DOWN') ? C.red : C.amber} />
              {t.breakout ? <KV k="Breakout" v={t.breakout} color={t.breakout.includes('HIGH') ? C.green : C.red} /> : null}
              {t.consolidating ? <KV k="State" v="CONSOLIDATING" color={C.amber} /> : null}
              {t.reversal ? <KV k="Reversal" v={t.reversal} color={C.amber} /> : null}
              <Note>Open / High / Low, previous close, VWAP (proxy), opening range, support / resistance and momentum are in the card below.</Note>
            </>
          ) : <Note>Waiting for intraday candles...</Note>}
        </>
      )}
    </Card>
  );
}

const s = StyleSheet.create({
  none: { color: C.muted, fontSize: 14 },
});
