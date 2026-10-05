// Price + VIX level alerts (analysis only - never places orders).
// A rule fires once when the value CROSSES its level between two consecutive LIVE/FRESH readings.
// Stale / missing / previous-session values never fire and never become "previous" readings.
export const LEVEL_RULES = [
  { id: 'priceAbove', label: 'NIFTY rises above', src: 'price', dir: 'up', step: 50 },
  { id: 'priceBelow', label: 'NIFTY falls below', src: 'price', dir: 'down', step: 50 },
  { id: 'vixAbove', label: 'India VIX rises above', src: 'vix', dir: 'up', step: 0.5 },
  { id: 'vixBelow', label: 'India VIX falls below', src: 'vix', dir: 'down', step: 0.5 },
];
export const DEFAULT_LEVELS = { priceAbove: null, priceBelow: null, vixAbove: null, vixBelow: null };

const ok = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

// prev / cur: { price, vix } (null when not live-usable). levels: DEFAULT_LEVELS shape.
// Returns [{ id, type, msg }]; the caller disarms each fired rule (one-shot).
export function detectLevelAlerts(prev, cur, levels) {
  const out = [];
  if (!prev || !cur || !levels) return out;
  for (const r of LEVEL_RULES) {
    const lvl = levels[r.id];
    const a = prev[r.src], b = cur[r.src];
    if (!ok(lvl) || !ok(a) || !ok(b)) continue;
    const hit = r.dir === 'up' ? a <= lvl && b > lvl : a >= lvl && b < lvl;
    if (!hit) continue;
    const name = r.src === 'price' ? 'NIFTY' : 'India VIX';
    out.push({ id: r.id, type: r.src === 'price' ? 'priceLevel' : 'vixLevel', msg: `${name} ${r.dir === 'up' ? 'rose above' : 'fell below'} ${lvl} (now ${b.toFixed(2)})` });
  }
  return out;
}
