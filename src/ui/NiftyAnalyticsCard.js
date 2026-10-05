import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { C, num } from '../theme';
import { store } from '../controller';
import { useStore } from '../store';
import { Card, KV, Note, Pill } from './primitives';
import { analyzeNifty, reasonText } from '../analytics';
import { fmtInt } from '../oi';
import { f2, signed, fmtHM, fmtDMY } from '../util';

// NIFTY intraday analytics (Part 9). Every number below is computed in src/analytics.js from real inputs; the small grey
// line under a value is its SOURCE. "--" = not available (never 0). No CALL / PUT signal is produced here.
const pts = (v) => (v === null || v === undefined ? '--' : f2(v, v % 1 ? 2 : 0));
const upDown = (v) => (v > 0 ? C.green : v < 0 ? C.red : C.muted);

function Row({ k, o, fmt = pts, color, bold }) {
  return (
    <View style={s.row}>
      <KV k={k} v={o && o.value !== null ? fmt(o.value) : '--'} color={color} bold={bold} />
      <Text style={s.src}>{o && o.source ? o.source : 'not available'}</Text>
    </View>
  );
}

function Level({ l, color }) {
  return (
    <View style={s.lvl}>
      <View style={s.lvlTop}>
        <Text style={[s.lvlPrice, num, { color }]}>{pts(l.price)}</Text>
        <Text style={s.lvlDist}>{l.distance !== null ? `${f2(l.distance, 0)} pts` : ''}</Text>
      </View>
      <Text style={s.lvlLabel}>{l.label}</Text>
      {l.sources.map((x, i) => <Text key={i} style={s.src}>{x}</Text>)}
    </View>
  );
}

const ORTONE = { COMPLETE: 'green', FORMING: 'amber', INCOMPLETE: 'amber', UNAVAILABLE: 'red' };
const STATE_COLOR = { BREAKOUT: C.green, BREAKDOWN: C.red, INSIDE: C.muted, POSITIVE: C.green, NEGATIVE: C.red, FLAT: C.muted };
const ALIGN = {
  ALIGNED_UP: ['ALIGNED UP', C.green], LEANING_UP: ['LEANING UP', C.green], ALIGNED_DOWN: ['ALIGNED DOWN', C.red], LEANING_DOWN: ['LEANING DOWN', C.red],
  MIXED: ['MIXED', C.amber], FLAT: ['FLAT', C.muted], UNAVAILABLE: ['UNAVAILABLE', C.muted],
};

export default function NiftyAnalyticsCard() {
  const quote = useStore(store, (x) => x.nifty);
  const quoteFresh = useStore(store, (x) => x.niftyFresh);
  const candles = useStore(store, (x) => x.candles);
  const candlesFresh = useStore(store, (x) => x.candlesFresh);
  const marketState = useStore(store, (x) => x.market.state);
  const now = useStore(store, (x) => x.sNow);
  const rows = useStore(store, (x) => x.chain);
  const chainExpiry = useStore(store, (x) => x.chainExpiry);
  const expiry = useStore(store, (x) => x.expiry);
  const chainFresh = useStore(store, (x) => x.chainFresh);

  const chain = useMemo(() => (rows && rows.length ? { rows, expiry, chainExpiry, fresh: chainFresh } : null), [rows, expiry, chainExpiry, chainFresh]);
  const a = useMemo(() => analyzeNifty({ quote, quoteFresh, candles, candlesFresh, marketState, now, chain }),
    [quote, quoteFresh, candles, candlesFresh, marketState, now, chain]);

  if (!a.ok) {
    return (
      <Card title="NIFTY intraday analytics" right={a.session.label}>
        <Text style={s.none}>DATA UNAVAILABLE: waiting for the live NIFTY feed and intraday candles.</Text>
        {a.issues.map((m, i) => <Note key={i} color={C.amber}>{m}</Note>)}
      </Card>
    );
  }
  const { price, ohlc, vwap, openingRange: or, levels, momentum } = a;
  const live = a.session.live;
  const [alignText, alignColor] = ALIGN[momentum.alignment] || ALIGN.UNAVAILABLE;

  return (
    <Card title="NIFTY intraday analytics" right={a.session.label}>
      {!live ? <Note color={C.amber}>{a.session.kind === 'PREVIOUS' ? `Showing the previous session (${fmtDMY(a.session.date)}), not live data.` : `Market is not open (${a.session.marketLabel.toLowerCase()}): showing the last session.`}</Note> : null}

      <Text style={s.h}>PRICE</Text>
      <View style={s.row}>
        <KV k="Current price" v={price.value !== null ? f2(price.value) : '--'} bold color={price.value !== null ? C.text : C.muted} />
        <Text style={s.src}>{price.value !== null ? `${price.source}${price.marketTs ? ` \u00b7 ${fmtHM(price.marketTs)} IST` : ''}` : `unavailable: ${reasonText(price.reason)}`}</Text>
      </View>
      <Row k="Open" o={ohlc.open} />
      <Row k="High" o={ohlc.high} />
      <Row k="Low" o={ohlc.low} />
      <Row k="Previous close" o={ohlc.prevClose} />
      <View style={s.row}>
        <KV k="Day range" v={ohlc.range.pts !== null ? `${pts(ohlc.range.pts)} pts` : '--'} />
        <Text style={s.src}>{ohlc.range.pts !== null ? `High - Low${ohlc.pricePosPct !== null ? ` \u00b7 price at ${f2(ohlc.pricePosPct, 0)}% of the range` : ''}` : 'needs both a day high and a day low'}</Text>
      </View>
      {ohlc.change ? <KV k="Change vs previous close" v={`${signed(ohlc.change.pts)} (${signed(ohlc.change.pct)}%)`} color={upDown(ohlc.change.pts)} /> : null}
      {ohlc.stale && ohlc.high.value !== null ? <Note color={C.amber}>No live tick right now: the day range may be behind.</Note> : null}

      <View style={s.sep} />
      <Text style={s.h}>{vwap.method === 'VOLUME' ? 'VWAP' : 'SESSION AVERAGE (VWAP PROXY)'}</Text>
      <KV k={vwap.method ? vwap.label : 'VWAP'} v={vwap.value !== null ? f2(vwap.value) : '--'} bold color={vwap.method === 'PROXY' ? C.amber : C.text} />
      {vwap.value !== null ? (
        <>
          <KV k="Price vs this level" v={vwap.position ? `${vwap.position}  (${signed(vwap.distPct)}%)` : '--'} color={vwap.position === 'ABOVE' ? C.green : vwap.position === 'BELOW' ? C.red : C.muted} />
          <Text style={s.src}>{vwap.source} {'\u00b7'} as of {fmtHM(vwap.asOf)} IST</Text>
          <Note color={vwap.method === 'PROXY' ? C.amber : C.muted}>{vwap.note}</Note>
        </>
      ) : <Note>Unavailable: {reasonText(vwap.reason)}.</Note>}

      <View style={s.sep} />
      <View style={s.head}>
        <Text style={s.h}>OPENING RANGE 09:15-09:30</Text>
        <Pill text={or.status} color={ORTONE[or.status] || 'muted'} solid />
      </View>
      <KV k={or.provisional ? 'OR high (provisional)' : 'OR high'} v={or.high !== null ? pts(or.high) : '--'} color={or.provisional ? C.muted : C.text} />
      <KV k={or.provisional ? 'OR low (provisional)' : 'OR low'} v={or.low !== null ? pts(or.low) : '--'} color={or.provisional ? C.muted : C.text} />
      <KV k="Candles in the window" v={`${or.candles} of ${or.expected}`} />
      {or.state ? (
        <>
          <KV k="Price vs opening range" v={or.state} color={STATE_COLOR[or.state]} bold />
          <Text style={s.src}>{or.state === 'INSIDE' ? `${f2(or.distance, 1)} pts from the nearer edge` : `${f2(or.distance, 1)} pts ${or.state === 'BREAKOUT' ? 'above the OR high' : 'below the OR low'}`}</Text>
        </>
      ) : <Note>No breakout call: {reasonText(or.reason)}.</Note>}
      <Text style={s.src}>{or.source}</Text>

      <View style={s.sep} />
      <Text style={s.h}>SUPPORT / RESISTANCE</Text>
      {levels.all.length === 0 ? <Note>No levels available yet.</Note> : levels.classified ? (
        <View style={{ flexDirection: 'row' }}>
          <View style={{ flex: 1 }}>
            <Text style={[s.lh, { color: C.red }]}>RESISTANCE</Text>
            {levels.resistances.length ? levels.resistances.map((l, i) => <Level key={'r' + i} l={l} color={C.red} />) : <Text style={s.none2}>--</Text>}
          </View>
          <View style={{ width: 12 }} />
          <View style={{ flex: 1 }}>
            <Text style={[s.lh, { color: C.green }]}>SUPPORT</Text>
            {levels.supports.length ? levels.supports.map((l, i) => <Level key={'s' + i} l={l} color={C.green} />) : <Text style={s.none2}>--</Text>}
          </View>
        </View>
      ) : (
        <View>
          <Note color={C.amber}>No valid current price: the levels are listed but not split into support / resistance.</Note>
          {levels.all.slice().reverse().map((l, i) => <Level key={i} l={l} color={C.text} />)}
        </View>
      )}
      {levels.atPrice.length ? <Note>At the current price: {levels.atPrice.map((l) => `${pts(l.price)} (${l.label})`).join(', ')}</Note> : null}
      <Note color={levels.oi.included ? C.muted : C.amber}>
        {levels.oi.included ? `OI walls: expiry ${fmtDMY(levels.oi.expiry)}${levels.oi.snapshot ? ', market-closed snapshot' : ''}${levels.oi.text ? '. ' + levels.oi.text : ''}` : levels.oi.text}
      </Note>

      <View style={s.sep} />
      <View style={s.head}>
        <Text style={s.h}>MOMENTUM (CONTEXT, NOT A SIGNAL)</Text>
        <Pill text={alignText} color={alignColor === C.green ? 'green' : alignColor === C.red ? 'red' : alignColor === C.amber ? 'amber' : 'muted'} solid />
      </View>
      {momentum.frames.map((f) => (
        <View key={f.label} style={s.mrow}>
          <Text style={s.mtf}>{f.label}</Text>
          {f.available ? (
            <>
              <Text style={[s.mroc, num, { color: STATE_COLOR[f.state] }]}>{signed(f.rocPct)}%</Text>
              <Text style={[s.mstate, { color: STATE_COLOR[f.state] }]}>{f.state}{f.fading ? ' \u00b7 fading' : ''}</Text>
            </>
          ) : (
            <Text style={s.mna}>-- {reasonText(f.reason)}{f.bars !== undefined ? ` (${f.bars} bar${f.bars === 1 ? '' : 's'})` : ''}</Text>
          )}
        </View>
      ))}
      <Note>{momentum.method || 'Momentum needs usable candles.'} Flat band = {'\u00b1'}0.03% x sqrt(window / 3 min). The forming candle is excluded. Not a trading signal.</Note>

      {a.issues.length ? (
        <>
          <View style={s.sep} />
          {a.issues.map((m, i) => <Note key={i} color={C.amber}>{m}</Note>)}
        </>
      ) : null}
    </Card>
  );
}

const s = StyleSheet.create({
  none: { color: C.red, fontSize: 14, lineHeight: 20 },
  none2: { color: C.muted, fontSize: 13 },
  h: { color: C.muted, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginTop: 2, marginBottom: 4 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 },
  sep: { height: 1, backgroundColor: C.border, marginVertical: 12 },
  row: { marginBottom: 2 },
  src: { color: C.muted, fontSize: 11, lineHeight: 15, marginTop: -2 },
  lh: { fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 4 },
  lvl: { marginBottom: 8 },
  lvlTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  lvlPrice: { fontSize: 16, fontWeight: '700' },
  lvlDist: { color: C.muted, fontSize: 11 },
  lvlLabel: { color: C.text, fontSize: 12, fontWeight: '600' },
  mrow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 5, borderBottomWidth: 1, borderColor: C.border },
  mtf: { color: C.text, fontSize: 14, fontWeight: '800', width: 44 },
  mroc: { fontSize: 14, fontWeight: '700', width: 84 },
  mstate: { fontSize: 12, fontWeight: '800', flexShrink: 1 },
  mna: { color: C.muted, fontSize: 12, flexShrink: 1 },
});
