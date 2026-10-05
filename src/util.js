const IST = 5.5 * 3600 * 1000;
export const pad = (n) => String(n).padStart(2, '0');
export function ist(ms = Date.now()) {
  const d = new Date(ms + IST);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), dow: d.getUTCDay() };
}
export function istDate(ms = Date.now()) { const t = ist(ms); return `${t.y}-${pad(t.mo)}-${pad(t.d)}`; }
export function istMinutes(ms) { const t = ist(ms); return t.h * 60 + t.mi; }
export function fmtTime(ms) { if (!ms) return '--:--:--'; const t = ist(ms); return `${pad(t.h)}:${pad(t.mi)}:${pad(t.s)}`; }
export function fmtHM(ms) { if (!ms) return '--:--'; const t = ist(ms); return `${pad(t.h)}:${pad(t.mi)}`; }
export function fmtDay(ms) { if (!ms) return '--'; const t = ist(ms); return `${pad(t.d)}-${pad(t.mo)}-${t.y}`; }
export function daysTo(dateStr, ms = Date.now()) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = ist(ms);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(t.y, t.mo - 1, t.d)) / 86400000);
}
export const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
export const f2 = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '--' : v.toFixed(d));
export function signed(v, d = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '--';
  return (v > 0 ? '+' : '') + v.toFixed(d);
}
export function compact(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '--';
  const a = Math.abs(v);
  if (a >= 1e7) return (v / 1e7).toFixed(2) + 'Cr';
  if (a >= 1e5) return (v / 1e5).toFixed(2) + 'L';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return String(Math.round(v));
}
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
// 'YYYY-MM-DD' or epoch ms -> 'DD-MMM-YYYY' (e.g. 01-OCT-2026)
export function fmtDMY(v) {
  if (v === null || v === undefined || v === '') return '--';
  const d = typeof v === 'number' ? istDate(v) : String(v);
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '--';
  return `${m[3]}-${MON[Number(m[2]) - 1] || '???'}-${m[1]}`;
}
