// Live option ticks from the Market Data Feed (full mode) laid over the REST option chain.
// Only price (ltp), open interest and volume are taken from a tick: units are identical to the chain's. IV / Greeks / bid / ask stay
// as Upstox's REST chain sent them. A tick older than the chain snapshot is ignored. Nothing is invented: no tick => REST value.
const pos = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

// Keys of the CE+PE contracts for ATM +/- n strikes of the chain rows (rows sorted by strike).
export function optionKeys(rows, spot, n) {
  if (!Array.isArray(rows) || !rows.length || !pos(spot)) return [];
  let best = 0;
  rows.forEach((r, i) => { if (Math.abs(r.strike - spot) < Math.abs(rows[best].strike - spot)) best = i; });
  const out = [];
  for (let i = Math.max(0, best - n); i <= Math.min(rows.length - 1, best + n); i += 1) {
    const r = rows[i];
    if (r.call && r.call.key) out.push(r.call.key);
    if (r.put && r.put.key) out.push(r.put.key);
  }
  return out;
}

// resp: decoded FeedResponse. Returns a NEW map { key: { ltp, oi, vol, ltt, receivedAt } } (same object when nothing relevant).
export function readOptionTicks(map, resp, receivedAt, keySet) {
  if (!resp || !resp.feeds || !keySet || !keySet.size) return map;
  let next = null;
  for (const key of Object.keys(resp.feeds)) {
    if (!keySet.has(key)) continue;
    const f = resp.feeds[key];
    const l = f && f.ltpc;
    if (!l || !pos(l.ltp)) continue;
    if (!next) next = { ...map };
    const prev = map[key] || {};
    next[key] = { ltp: l.ltp, ltt: l.ltt || null, oi: pos(f.oi) ? f.oi : (prev.oi || null), vol: pos(f.vtt) ? f.vtt : (prev.vol || null), receivedAt };
  }
  return next || map;
}

const side = (s, t, chainAt) => {
  if (!s || !s.key) return s;
  const k = t[s.key];
  if (!k || k.receivedAt <= chainAt) return s;
  const ltp = k.ltp, oi = k.oi !== null && k.oi !== undefined ? k.oi : s.oi, vol = k.vol !== null && k.vol !== undefined ? k.vol : s.vol;
  return ltp === s.ltp && oi === s.oi && vol === s.vol ? s : { ...s, ltp, oi, vol };
};

// rows keep their identity when none of their ticks changed, so memoised rows do not re-render.
export function overlayChain(rows, ticks, chainAt) {
  if (!Array.isArray(rows) || !ticks) return rows;
  let changed = false;
  const out = rows.map((r) => {
    const call = side(r.call, ticks, chainAt), put = side(r.put, ticks, chainAt);
    if (call === r.call && put === r.put) return r;
    changed = true; return { ...r, call, put };
  });
  return changed ? out : rows;
}
