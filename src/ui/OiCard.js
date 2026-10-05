import React from 'react';
import { Text } from 'react-native';
import { C } from '../theme';
import { store } from '../controller';
import { useStore } from '../store';
import { Card, KV, Note } from './primitives';
import { compact } from '../util';

export default function OiCard() {
  const a = useStore(store, (s) => s.analysis);
  const o = a && a.oi;
  if (!o) return <Card title="OI flow context"><Text style={{ color: C.muted }}>DATA UNAVAILABLE</Text></Card>;
  return (
    <Card title="OI flow context" right="ATM +/- 5 strikes">
      <KV k="Volume CALL / PUT" v={`${compact(o.callVol)} / ${compact(o.putVol)}`} />
      {o.relation ? <Note color={C.text}>{o.relation}</Note> : null}
      <Note>Highest OI, OI change and OI walls: see Open interest analysis. PCR, IV and Greeks: see PCR, IV and Greeks.</Note>
    </Card>
  );
}
