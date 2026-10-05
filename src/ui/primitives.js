import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { C, num } from '../theme';

export const col = (k) => ({ green: C.green, red: C.red, amber: C.amber, blue: C.blue, muted: C.muted }[k] || C.muted);
export const tone = (v) => (v > 0 ? C.green : v < 0 ? C.red : C.muted);

export function Card({ title, right, children, style }) {
  return (
    <View style={[s.card, style]}>
      {title ? (
        <View style={s.cardHead}>
          <Text style={s.cardTitle}>{title}</Text>
          {right ? <Text style={s.cardRight}>{right}</Text> : null}
        </View>
      ) : null}
      {children}
    </View>
  );
}

export function KV({ k, v, color, bold }) {
  return (
    <View style={s.kv}>
      <Text style={s.k}>{k}</Text>
      <Text style={[s.v, num, color ? { color } : null, bold ? { fontWeight: '700' } : null]}>{v}</Text>
    </View>
  );
}

export function Pill({ text, color, solid }) {
  const c = col(color);
  return (
    <View style={[s.pill, { borderColor: c }, solid ? { backgroundColor: c } : null]}>
      <Text style={[s.pillTxt, { color: solid ? '#000' : c }]}>{text}</Text>
    </View>
  );
}

export function Chip({ label, active, onPress }) {
  return (
    <Pressable onPress={onPress} style={[s.chip, active ? s.chipOn : null]} hitSlop={4}>
      <Text style={[s.chipTxt, active ? { color: '#000' } : null]}>{label}</Text>
    </Pressable>
  );
}

export function Btn({ label, onPress, color = C.green, style }) {
  return (
    <Pressable onPress={onPress} style={[s.btn, { backgroundColor: color }, style]}>
      <Text style={s.btnTxt}>{label}</Text>
    </Pressable>
  );
}

export function Bar({ pct, color }) {
  return (
    <View style={s.barBg}>
      <View style={[s.barFg, { width: `${Math.max(0, Math.min(100, pct))}%`, backgroundColor: color }]} />
    </View>
  );
}

export function Note({ children, color = C.muted }) {
  return <Text style={[s.note, { color }]}>{children}</Text>;
}

const s = StyleSheet.create({
  card: { backgroundColor: C.card, borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: C.border },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  cardTitle: { color: C.muted, fontSize: 12, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase' },
  cardRight: { color: C.muted, fontSize: 11 },
  kv: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  k: { color: C.muted, fontSize: 14 },
  v: { color: C.text, fontSize: 14, fontWeight: '600', flexShrink: 1, textAlign: 'right', marginLeft: 12 },
  pill: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3 },
  pillTxt: { fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
  chip: { borderWidth: 1, borderColor: C.border, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, marginRight: 8, backgroundColor: C.card2 },
  chipOn: { backgroundColor: C.green, borderColor: C.green },
  chipTxt: { color: C.text, fontSize: 13, fontWeight: '700' },
  btn: { borderRadius: 12, paddingVertical: 14, paddingHorizontal: 18, alignItems: 'center' },
  btnTxt: { color: '#000', fontSize: 16, fontWeight: '800' },
  barBg: { height: 8, backgroundColor: C.card2, borderRadius: 4, overflow: 'hidden', flex: 1 },
  barFg: { height: 8, borderRadius: 4 },
  note: { fontSize: 12, lineHeight: 17, marginTop: 6 },
});
