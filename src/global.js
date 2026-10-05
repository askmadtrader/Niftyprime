// Global context from Yahoo Finance's public chart endpoint (unofficial, free). Upstox has no DXY/yields/crude/gold.
export const GLOBAL_ITEMS = [
  { id: 'gift', label: 'GIFT NIFTY', sym: null, group: 'India', note: 'No reliable free feed' },
  { id: 'dxy', label: 'DXY (Dollar Index)', sym: 'DX-Y.NYB', group: 'Macro' },
  { id: 'us10y', label: 'US 10Y Yield %', sym: '^TNX', group: 'Macro' },
  { id: 'crude', label: 'Crude Oil WTI', sym: 'CL=F', group: 'Macro' },
  { id: 'brent', label: 'Brent Crude', sym: 'BZ=F', group: 'Macro' },
  { id: 'gold', label: 'Gold', sym: 'GC=F', group: 'Macro' },
  { id: 'usdinr', label: 'USD/INR', sym: 'INR=X', group: 'Macro' },
  { id: 'dji', label: 'Dow Jones', sym: '^DJI', group: 'US' },
  { id: 'spx', label: 'S&P 500', sym: '^GSPC', group: 'US' },
  { id: 'ixic', label: 'Nasdaq', sym: '^IXIC', group: 'US' },
  { id: 'n225', label: 'Nikkei 225', sym: '^N225', group: 'Asia' },
  { id: 'hsi', label: 'Hang Seng', sym: '^HSI', group: 'Asia' },
  { id: 'ssec', label: 'Shanghai Comp.', sym: '000001.SS', group: 'Asia' },
  { id: 'kospi', label: 'KOSPI', sym: '^KS11', group: 'Asia' },
];

async function one(it) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 10000);
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(it.sym)}?interval=1d&range=5d`;
    const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' }, signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const res = j && j.chart && j.chart.result && j.chart.result[0];
    if (!res) throw new Error('no data');
    const meta = res.meta || {};
    const closes = ((res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close) || []).filter((x) => typeof x === 'number');
    const price = typeof meta.regularMarketPrice === 'number' ? meta.regularMarketPrice : closes[closes.length - 1];
    const prev = closes.length >= 2 ? closes[closes.length - 2] : (typeof meta.previousClose === 'number' ? meta.previousClose : null);
    if (typeof price !== 'number') throw new Error('no price');
    const chg = prev ? price - prev : null;
    return { id: it.id, price, prev, chg, pct: prev ? (chg / prev) * 100 : null, t: meta.regularMarketTime ? meta.regularMarketTime * 1000 : null, receivedAt: Date.now() };
  } finally { clearTimeout(to); }
}

export async function fetchGlobal() {
  const items = GLOBAL_ITEMS.filter((i) => i.sym);
  const res = await Promise.allSettled(items.map(one));
  const out = {};
  res.forEach((r, i) => { out[items[i].id] = r.status === 'fulfilled' ? r.value : { id: items[i].id, error: (r.reason && r.reason.message) || 'failed' }; });
  return out;
}
