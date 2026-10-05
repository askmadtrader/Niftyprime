import React, { memo, useMemo } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
import { C, num } from '../theme';
import { store, setExpiry, updateSettings } from '../controller';
import { useStore } from '../store';
import { Card, Chip, Note, Pill } from './primitives';
import { f2, fmtTime } from '../util';
import { describeExpiry, expiryKind } from '../contracts';
import { validSpot, buildChainView, chainStatus, sideCells, clampStrikes, CHAIN_STATUS } from '../chain';

// Basic live option chain: CALL (LTP, OI, Vol) | STRIKE | PUT (LTP, OI, Vol). Every missing value is "--".
const STATUS_COLOR = { [CHAIN_STATUS.LIVE]: 'green', [CHAIN_STATUS.STALE]: 'amber', [CHAIN_STATUS.PREVIOUS]: 'blue', [CHAIN_STATUS.UNAVAILABLE]: 'red' };

const Cell = memo(function Cell({ text, bold, dim }) {
  return (
    <View style={s.cell}>
      <Text numberOfLines={1} style={[s.ct, num, bold ? s.bold : null, dim ? { color: C.muted } : null]}>{text}</Text>
    </View>
  );
});

const Row = memo(function Row({ r, isAtm, dim }) {
  const c = sideCells(r.call), p = sideCells(r.put);
  return (
    <View style={[s.row, isAtm ? s.atmRow : null]}>
      <Cell text={c.vol} dim={dim} /><Cell text={c.oi} dim={dim} /><Cell text={c.ltp} bold dim={dim} />
      <View style={[s.strike, isAtm ? s.atmStrike : null]}>
        <Text style={[s.st, num, isAtm ? { color: C.amber } : null]}>{r.strike}</Text>
        {isAtm ? <Text style={s.atmTag}>ATM</Text> : null}
      </View>
      <Cell text={p.ltp} bold dim={dim} /><Cell text={p.oi} dim={dim} /><Cell text={p.vol} dim={dim} />
    </View>
  );
});

function StrikesStepper({ value }) {
  return (
    <View style={s.step}>
      <Pressable style={s.sb} hitSlop={6} onPress={() => updateSettings({ strikes: clampStrikes(value - 1) })}><Text style={s.sbt}>-</Text></Pressable>
      <Text style={[s.sv, num]}>{'\u00b1'}{value}</Text>
      <Pressable style={s.sb} hitSlop={6} onPress={() => updateSettings({ strikes: clampStrikes(value + 1) })}><Text style={s.sbt}>+</Text></Pressable>
    </View>
  );
}

export default function ChainTable() {
  const exps = useStore(store, (x) => x.expiries);
  const expiry = useStore(store, (x) => x.expiry);
  const contracts = useStore(store, (x) => x.contracts);
  const chain = useStore(store, (x) => x.chain);
  const chainExpiry = useStore(store, (x) => x.chainExpiry);
  const chainInfo = useStore(store, (x) => x.chainInfo);
  const cfr = useStore(store, (x) => x.chainFresh);
  const err = useStore(store, (x) => x.chainErr);
  const nifty = useStore(store, (x) => x.nifty);
  const nf = useStore(store, (x) => x.niftyFresh);
  const sNow = useStore(store, (x) => x.sNow);
  const strikes = useStore(store, (x) => x.settings.strikes);

  const st = chainStatus({ rows: chain, chainExpiry, expiry, fresh: cfr });
  const showRows = st.status !== CHAIN_STATUS.UNAVAILABLE;
  const spot = validSpot(nifty, nf);
  const view = useMemo(() => (showRows ? buildChainView(chain, spot, strikes) : buildChainView([], null, strikes)), [showRows, chain, spot, strikes]);
  const info = expiry ? describeExpiry(expiry, sNow) : null;
  const kind = expiry ? expiryKind(contracts, expiry) : null;
  const dim = st.status !== CHAIN_STATUS.LIVE;

  const emptyMsg = !showRows ? `DATA UNAVAILABLE: ${err || st.text}`
    : view.reason === 'NO_SPOT' ? 'ATM UNAVAILABLE: waiting for a valid NIFTY price from the live feed.'
    : view.reason === 'SPOT_OUTSIDE_CHAIN' ? 'ATM UNAVAILABLE: the NIFTY price is outside the strikes Upstox returned.'
    : null;

  return (
    <Card title="Option chain (NIFTY)" right={view.atmStrike ? `ATM ${view.atmStrike}` : 'ATM --'}>
      {exps.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
          {exps.slice(0, 8).map((e) => <Chip key={e} label={describeExpiry(e, sNow).date} active={e === expiry} onPress={() => setExpiry(e)} />)}
        </ScrollView>
      ) : null}

      <View style={s.expBox}>
        <Text style={s.expLbl}>SELECTED EXPIRY</Text>
        <Text style={[s.expDate, num]}>{info ? info.date : 'NO EXPIRY LOADED'}</Text>
        {info ? <Text style={s.expSub}>{info.text.split('  \u00b7  ')[1]}{kind ? `  \u00b7  ${kind === 'WEEKLY' ? 'Weekly' : 'Monthly'}` : ''}</Text> : null}
      </View>

      <View style={s.statusRow}>
        <Pill text={st.status} color={STATUS_COLOR[st.status]} solid />
        <Text style={s.statusTxt} numberOfLines={2}>{st.text}</Text>
      </View>
      {showRows && cfr && cfr.receivedAt ? <Text style={s.meta}>Received {fmtTime(cfr.receivedAt)} IST {'\u00b7'} Upstox sends no exchange timestamp for the chain</Text> : null}
      <View style={s.spotRow}>
        <Text style={s.meta}>NIFTY {spot ? f2(spot) : '--'}{nf && spot ? ` (${nf.status})` : ''}</Text>
        <StrikesStepper value={clampStrikes(strikes)} />
      </View>

      {emptyMsg ? (
        <Text style={s.none}>{emptyMsg}</Text>
      ) : (
        <View>
          <View style={s.head}>
            <Text style={[s.hh, { color: C.green, flex: 3 }]}>CALL</Text>
            <Text style={[s.hh, { width: 70, color: C.text }]}>STRIKE</Text>
            <Text style={[s.hh, { color: C.red, flex: 3 }]}>PUT</Text>
          </View>
          <View style={s.row}>
            {['Vol', 'OI', 'LTP'].map((h) => <View key={'c' + h} style={s.cell}><Text style={s.hc}>{h}</Text></View>)}
            <View style={[s.strike, { backgroundColor: 'transparent' }]} />
            {['LTP', 'OI', 'Vol'].map((h) => <View key={'p' + h} style={s.cell}><Text style={s.hc}>{h}</Text></View>)}
          </View>
          {view.rows.map((r, i) => <Row key={r.expiry + r.strike} r={r} isAtm={i === view.atmIndex} dim={dim} />)}
          {view.clippedBelow || view.clippedAbove ? <Note>Upstox returned fewer than {view.n} strikes on the {view.clippedBelow && view.clippedAbove ? 'both sides' : view.clippedBelow ? 'lower side' : 'upper side'} of ATM. Nothing is filled in.</Note> : null}
        </View>
      )}
      {showRows && chainInfo && chainInfo.dropped > 0 ? <Note color={C.amber}>{chainInfo.dropped} row{chainInfo.dropped === 1 ? '' : 's'} from Upstox were dropped (not for this expiry, duplicate, or invalid).</Note> : null}
      <Note>Only the selected expiry is ever shown. "--" means Upstox did not send that value. OI and Vol are in K (thousand), L (lakh), Cr (crore).</Note>
    </Card>
  );
}

const s = StyleSheet.create({
  expBox: { borderWidth: 2, borderColor: C.amber, backgroundColor: C.amberBg, borderRadius: 12, paddingVertical: 8, paddingHorizontal: 12, marginBottom: 8, alignItems: 'center' },
  expLbl: { color: C.amber, fontSize: 10, fontWeight: '800', letterSpacing: 1.5 },
  expDate: { color: C.text, fontSize: 22, fontWeight: '800', marginTop: 2 },
  expSub: { color: C.text, fontSize: 13, marginTop: 2 },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  statusTxt: { color: C.text, fontSize: 12, marginLeft: 8, flexShrink: 1 },
  meta: { color: C.muted, fontSize: 11, marginBottom: 4 },
  spotRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  step: { flexDirection: 'row', alignItems: 'center' },
  sb: { width: 28, height: 28, borderRadius: 14, backgroundColor: C.card2, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  sbt: { color: C.text, fontSize: 16, fontWeight: '800' },
  sv: { color: C.text, fontSize: 13, fontWeight: '700', minWidth: 44, textAlign: 'center' },
  none: { color: C.red, fontSize: 14, lineHeight: 20 },
  head: { flexDirection: 'row', marginBottom: 2 },
  hh: { fontSize: 12, fontWeight: '800', letterSpacing: 1, textAlign: 'center' },
  hc: { color: C.muted, fontSize: 10, fontWeight: '800' },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderColor: C.border },
  atmRow: { backgroundColor: C.amberBg, borderTopWidth: 1, borderColor: C.amber },
  cell: { flex: 1, height: 38, alignItems: 'center', justifyContent: 'center' },
  ct: { color: C.text, fontSize: 12 },
  bold: { fontWeight: '800' },
  strike: { width: 70, height: 38, alignItems: 'center', justifyContent: 'center', backgroundColor: C.card2 },
  atmStrike: { backgroundColor: C.amberBg },
  st: { color: C.text, fontSize: 14, fontWeight: '800' },
  atmTag: { color: C.amber, fontSize: 9, fontWeight: '800' },
});
