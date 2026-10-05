import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, PanResponder, useWindowDimensions, StyleSheet } from 'react-native';
import Svg, { Defs, ClipPath, G, Line, Path, Rect, Text as SText } from 'react-native-svg';
import { C, num } from '../theme';
import { store, loadChart, setChartTf } from '../controller';
import { useStore } from '../store';
import { Card, Chip, Note } from './primitives';
import { fmtHM, fmtTime, fmtDMY, istDate } from '../util';
import { describeSeries } from '../feed/session';
import { computeCandleFreshness, usableForLive } from '../feed/freshness';
import { describeValue } from '../feed/stamp';
import { validSpot } from '../chain';
import { MS } from '../feed/marketStatus';
import {
  TF_LIST, TF_CONFIG, vwapBySession, sessionStats, defaultView, clampView, panView, panByCandles, zoomView,
  buildGeometry, toPaths, chartStatus, visibleRange, axisLabel,
} from '../chartmath';

const PAD = { l: 6, r: 54, t: 10, b: 22 };
const TONE = { green: C.green, amber: C.amber, red: C.red, muted: C.muted };

function CandleChart({ g, paths, width, height, dim }) {
  const { padL, pw, ph, padT } = g;
  return (
    <Svg width={width} height={height} pointerEvents="none" style={dim ? { opacity: 0.55 } : null}>
      <Defs><ClipPath id="plot"><Rect x={padL} y={padT} width={pw} height={ph} /></ClipPath></Defs>
      {g.grid.map((l, i) => (
        <React.Fragment key={i}>
          <Line x1={padL} x2={padL + pw} y1={l.y} y2={l.y} stroke={C.border} strokeWidth="1" />
          <SText x={padL + pw + 4} y={l.y + 3} fill={C.muted} fontSize="10">{l.label}</SText>
        </React.Fragment>
      ))}
      {g.seps.map((sp, i) => (
        <React.Fragment key={i}>
          <Line x1={sp.x} x2={sp.x} y1={padT} y2={padT + ph} stroke={C.muted} strokeWidth="0.8" strokeDasharray="2,4" opacity="0.6" />
          {g.seps.length <= 8 ? <SText x={sp.x + 3} y={padT + 10} fill={C.muted} fontSize="9">{sp.label}</SText> : null}
        </React.Fragment>
      ))}
      <G clipPath="url(#plot)">
        {paths.wickUp ? <Path d={paths.wickUp} stroke={C.green} strokeWidth="1" fill="none" /> : null}
        {paths.wickDn ? <Path d={paths.wickDn} stroke={C.red} strokeWidth="1" fill="none" /> : null}
        {paths.bodyUp ? <Path d={paths.bodyUp} fill={C.green} /> : null}
        {paths.bodyDn ? <Path d={paths.bodyDn} fill={C.red} /> : null}
        {paths.vwap ? <Path d={paths.vwap} stroke={C.blue} strokeWidth="1.6" fill="none" /> : null}
        {g.levels.map((l, i) => (
          <React.Fragment key={i}>
            <Line x1={l.x1} x2={l.x2} y1={l.y} y2={l.y} stroke={l.color} strokeWidth="1" strokeDasharray="5,4" />
            <SText x={l.x1 + 3} y={l.y - 3} fill={l.color} fontSize="9" fontWeight="bold">{l.label}</SText>
          </React.Fragment>
        ))}
      </G>
      {g.last ? (
        <>
          <Line x1={padL} x2={padL + pw} y1={g.last.y} y2={g.last.y} stroke={C.text} strokeWidth="0.8" strokeDasharray="2,3" />
          <Rect x={padL + pw + 1} y={g.last.y - 8} width={52} height={16} fill={g.last.up ? C.green : C.red} />
          <SText x={padL + pw + 4} y={g.last.y + 4} fill="#000" fontSize="10" fontWeight="bold">{g.last.price.toFixed(1)}</SText>
        </>
      ) : null}
      {g.ticks.map((t, i) => <SText key={i} x={t.x} y={height - 6} fill={C.muted} fontSize="10" textAnchor="middle">{t.label}</SText>)}
    </Svg>
  );
}

function Stat({ k, v, sub, color }) {
  return (
    <View style={s.stat}>
      <Text style={s.sk}>{k}</Text>
      <Text style={[s.sv, num, color ? { color } : null]} numberOfLines={1}>{v}</Text>
      {sub ? <Text style={s.ss} numberOfLines={1}>{sub}</Text> : null}
    </View>
  );
}

function Ctl({ label, onPress, wide }) {
  return (
    <Pressable onPress={onPress} hitSlop={4} style={({ pressed }) => [s.ctl, wide ? s.ctlWide : null, pressed ? { opacity: 0.6 } : null]}>
      <Text style={s.ctlTxt}>{label}</Text>
    </Pressable>
  );
}

export default function ChartScreen({ embedded = false } = {}) {
  const { height: winH } = useWindowDimensions();
  const chart = useStore(store, (st) => st.chart);
  const a = useStore(store, (st) => st.analysis);
  const token = useStore(store, (st) => st.token);
  const sNow = useStore(store, (st) => st.sNow);
  const ms = useStore(store, (st) => st.market.state);
  const conn = useStore(store, (st) => st.conn);
  const feedConn = useStore(store, (st) => st.feed.conn);
  const nifty = useStore(store, (st) => st.nifty);
  const niftyFresh = useStore(store, (st) => st.niftyFresh);
  const tf = chart.tf, candles = chart.candles, n = candles.length;

  // ---- freshness / session: re-derived on every render from the exchange-aligned clock, never frozen at load time.
  const series = useMemo(() => describeSeries(candles, sNow, ms), [candles, sNow, ms]);
  const link = conn === 'DISCONNECTED' || conn === 'AUTH' ? 'DISCONNECTED' : 'OK';
  const cf = computeCandleFreshness({ info: series, receivedAt: chart.at, link, marketState: ms, now: Date.now(), serverNow: sNow, tfMin: tf });
  const cd = describeValue(cf, sNow, ms);
  const isCurrent = series.kind === 'CURRENT';
  const st = useMemo(() => chartStatus({ n, loading: chart.loading, err: chart.err, link, fresh: cf, series, marketOpen: ms === MS.OPEN, tfLabel: TF_CONFIG[tf].label }),
    [n, chart.loading, chart.err, link, cf.status, cf.reason, series.date, ms, tf]);

  useEffect(() => {
    if (!token) return undefined;
    loadChart(tf);                                   // full load the first time, incremental after that
    const id = setInterval(() => loadChart(tf), 15000);
    return () => clearInterval(id);
  }, [tf, token]);

  // ---- viewport (pan / zoom). Candle index units; see chartmath.js.
  const stats = useMemo(() => sessionStats(candles), [candles]);
  const [view, setViewState] = useState(null);
  const base = view && view.gen === chart.gen ? view : null;
  const eff = n >= 1 ? clampView(base || defaultView(n, stats ? stats.count : 0), n) : null;
  const viewRef = useRef(null), nRef = useRef(0), gRef = useRef({ last: null, pinch: null }).current;
  viewRef.current = eff; nRef.current = n;
  const setView = (v) => { viewRef.current = v; setViewState({ ...v, gen: store.get().chart.gen }); };

  const [w, setW] = useState(0);
  const wRef = useRef(0); wRef.current = w;
  const [locked, setLocked] = useState(false);
  const H = Math.round(Math.max(280, Math.min(460, winH * 0.46)));
  const plotW = () => Math.max(1, wRef.current - PAD.l - PAD.r);

  const responder = useMemo(() => {
    const wants = (e, g) => e.nativeEvent.touches.length >= 2 || (Math.abs(g.dx) > 5 && Math.abs(g.dx) > Math.abs(g.dy));
    const end = () => { gRef.last = null; gRef.pinch = null; setLocked(false); };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: wants,
      onMoveShouldSetPanResponderCapture: wants,       // beat the page ScrollView to horizontal drags and pinches
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => { gRef.last = null; gRef.pinch = null; setLocked(true); },
      onPanResponderMove: (e) => {
        const ts = e.nativeEvent.touches, v = viewRef.current, N = nRef.current;
        if (!ts || !ts.length || !v || N < 2) return;
        if (ts.length >= 2) {
          const d = Math.max(1, Math.hypot(ts[0].pageX - ts[1].pageX, ts[0].pageY - ts[1].pageY));
          if (!gRef.pinch) {
            const mid = ((ts[0].locationX || 0) + (ts[1].locationX || 0)) / 2;
            gRef.pinch = { d0: d, v0: v, f: Math.max(0, Math.min(1, (mid - PAD.l) / plotW())) };
            gRef.last = null; return;
          }
          const p = gRef.pinch;
          setView(zoomView(p.v0, p.v0.count * (p.d0 / d), p.f, N));   // fingers apart => fewer candles (zoom in)
        } else {
          gRef.pinch = null;
          const x = ts[0].pageX;
          if (gRef.last !== null) setView(panView(v, x - gRef.last, plotW(), N));  // drag right => older candles
          gRef.last = x;
        }
      },
      onPanResponderRelease: end,
      onPanResponderTerminate: end,
    });
  }, []);

  // ---- derived drawing data
  const vwap = useMemo(() => vwapBySession(candles), [candles]);
  const vwapIsVolume = useMemo(() => candles.some((c) => c.v > 0), [candles]);   // same rule vwapSeries() uses; index candles have no volume
  const levels = useMemo(() => {
    const L = []; const t = a && a.tech; if (!stats) return L;
    L.push({ price: stats.high, label: 'Sess H', color: C.amber, date: stats.date });
    L.push({ price: stats.low, label: 'Sess L', color: C.amber, date: stats.date });
    if (isCurrent && stats.date === istDate(sNow)) {   // analysis levels belong to today's session only
      if (t && t.orFormed) { L.push({ price: t.orHigh, label: 'OR-H', color: C.green, date: stats.date }); L.push({ price: t.orLow, label: 'OR-L', color: C.red, date: stats.date }); }
      if (a.levels && a.levels.majorR) L.push({ price: a.levels.majorR.strike, label: `R ${a.levels.majorR.strike}`, color: '#fb7185', date: stats.date });
      if (a.levels && a.levels.majorS) L.push({ price: a.levels.majorS.strike, label: `S ${a.levels.majorS.strike}`, color: '#4ade80', date: stats.date });
    }
    return L;
  }, [a, isCurrent, stats, sNow]);

  const drawable = st.draw && eff && w > 40;
  const geo = useMemo(() => (drawable ? buildGeometry({ candles, vwap, view: eff, width: w, height: H, levels, pad: PAD }) : null),
    [drawable, candles, vwap, eff && eff.count, eff && eff.end, w, H, levels]);
  const paths = useMemo(() => (geo ? toPaths(geo) : null), [geo]);

  // ---- price / time stats (real values only)
  const spot = ms === MS.OPEN && usableForLive(niftyFresh, ms) ? validSpot(nifty, niftyFresh) : null;
  const lastC = n ? candles[n - 1] : null;
  const price = spot !== null ? spot : lastC ? lastC.c : null;
  const priceSub = spot !== null ? `live ${fmtTime(nifty.ltt)}` : lastC ? `candle ${fmtHM(lastC.t)}${istDate(lastC.t) !== istDate(sNow) ? ' ' + fmtDMY(lastC.t).slice(0, 6) : ''}` : '';
  const fx = (x) => (x === null || x === undefined ? '--' : x.toFixed(2));
  const range = eff && n ? visibleRange(eff, n) : null;
  const first = range && candles[range.i0], lastV = range && candles[Math.max(range.i0, range.i1 - 1)];

  const move = (k) => { const v = viewRef.current; if (v) setView(panByCandles(v, k * v.count, n)); };
  const zoom = (f) => { const v = viewRef.current; if (v) setView(zoomView(v, v.count * f, 1, n)); };
  const latest = () => { const v = viewRef.current; if (v) setView(clampView({ count: v.count, end: n + 99, pinned: true }, n)); };

  return (
    <View style={embedded ? { marginBottom: 0 } : {}}><Card title="NIFTY chart" right={chart.at ? `loaded ${fmtTime(chart.at)} IST` : ''}>
        <View style={s.tfRow}>
          {TF_LIST.map((t) => <Chip key={t} label={TF_CONFIG[t].label} active={t === tf} onPress={() => setChartTf(t)} />)}
        </View>

        {n ? (
          <View style={s.stats}>
            <Stat k="PRICE" v={fx(price)} sub={priceSub} color={spot !== null ? C.green : C.text} />
            <Stat k="SESSION HIGH" v={fx(stats && stats.high)} sub={stats ? fmtDMY(stats.date).slice(0, 6) : ''} />
            <Stat k="SESSION LOW" v={fx(stats && stats.low)} sub={stats ? fmtDMY(stats.date).slice(0, 6) : ''} />
          </View>
        ) : null}

        <View style={[s.plot, { height: H }]} onLayout={(e) => setW(Math.floor(e.nativeEvent.layout.width))} {...responder.panHandlers}>
          {geo && paths ? <CandleChart g={geo} paths={paths} width={w} height={H} dim={st.dim} /> : (
            <View style={s.msgBox}><Text style={[s.msg, { color: TONE[st.tone] || C.muted }]}>{st.text}</Text></View>
          )}
        </View>

        {geo ? (
          <View style={s.ctls}>
            <Ctl label={'\u25C0 Older'} onPress={() => move(-0.6)} wide />
            <Ctl label={'Newer \u25B6'} onPress={() => move(0.6)} wide />
            <Ctl label={'\u2212'} onPress={() => zoom(1.4)} />
            <Ctl label="+" onPress={() => zoom(1 / 1.4)} />
            <Ctl label="Latest" onPress={latest} wide />
          </View>
        ) : null}

        {geo ? <Note>{`Showing ${axisLabel(first.t, true)} \u2192 ${axisLabel(lastV.t, true)} IST \u00b7 ${range.i1 - range.i0} of ${n} candles. Drag to go back / forward, pinch to zoom.`}</Note> : null}
        {st.kind !== 'LOADING' && st.kind !== 'NO_DATA' && st.kind !== 'INSUFFICIENT' ? <Note color={TONE[st.tone] || C.muted}>{st.text}</Note> : null}
        {n ? <Note color={C.text}>{cd.asOf.replace('Data as of', 'Data as of (last candle open)')}</Note> : null}
        {ms === MS.OPEN && feedConn !== 'CONNECTED' ? <Note color={C.amber}>Live price feed is {String(feedConn).toLowerCase()}: the price above is the last candle, not a live tick.</Note> : null}
        {chart.err && n ? <Note color={C.amber}>{chart.err}</Note> : null}

        <View style={s.legend}>
          <Text style={[s.lg, { color: C.blue }]}>{'\u2500'} {vwapIsVolume ? 'VWAP' : 'Session avg (VWAP proxy, no volume)'} (resets daily)</Text>
          <Text style={[s.lg, { color: C.amber }]}>{'\u2504'} Session H/L</Text>
          <Text style={[s.lg, { color: C.green }]}>{'\u2504'} OR high / S</Text>
          <Text style={[s.lg, { color: C.red }]}>{'\u2504'} OR low / R</Text>
        </View>
        <Note>Real Upstox candles (intraday + history), IST. Refreshes every 15 s while this screen is open. Browsing history never affects the live signal.</Note>
      </Card></View>
  );
}

const s = StyleSheet.create({
  tfRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 10 },
  stats: { flexDirection: 'row', marginBottom: 8 },
  stat: { flex: 1 },
  sk: { color: C.muted, fontSize: 10, fontWeight: '800', letterSpacing: 0.6 },
  sv: { color: C.text, fontSize: 17, fontWeight: '800', marginTop: 2 },
  ss: { color: C.muted, fontSize: 10, marginTop: 1 },
  plot: { width: '100%', backgroundColor: C.card2, borderRadius: 10, overflow: 'hidden', borderWidth: 1, borderColor: C.border },
  msgBox: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  msg: { fontSize: 14, textAlign: 'center', fontWeight: '700' },
  ctls: { flexDirection: 'row', marginTop: 10, justifyContent: 'space-between' },
  ctl: { minWidth: 44, height: 44, paddingHorizontal: 10, borderRadius: 10, backgroundColor: C.card2, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  ctlWide: { flex: 1, marginHorizontal: 3 },
  ctlTxt: { color: C.text, fontSize: 14, fontWeight: '800' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 8 },
  lg: { fontSize: 11, fontWeight: '700', marginRight: 12 },
});
