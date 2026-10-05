import { Vibration } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { createStore } from './store';
import { fetchCandles, fetchChartCandles, fetchChartIntraday, fetchChain, fetchContracts, fetchNiftyFutures, authorizeFeed, NIFTY_KEY, VIX_KEY, ApiError } from './api';
import { validExpiries, pickExpiry, pairsForExpiry } from './contracts';
import { verifyAgainstContracts, shouldAcceptChain, validSpot } from './chain';
import { makeSample, pushSample } from './pcriv';
import { FeedClient } from './feed/client';
import { initialFeedState, applyFeedResponse, serverNow, WATCH_KEYS } from './feed/feedState';
import { computeFreshness, computeCandleFreshness, computeChainFreshness, THRESHOLDS, isUsable, usableForLive, FRESH } from './feed/freshness';
import { evaluateGate } from './feed/gate';
import { selectCandles, describeSeries, SESSION } from './feed/session';
import { MS, MARKET_STATE_LABEL } from './feed/marketStatus';
import { flog } from './feed/logger';
import { deriveStatus } from './feed/status';
import { fetchGlobal } from './global';
import { pickNiftyFuture, expiryEndMs } from './futures';
import { optionKeys, readOptionTicks, overlayChain } from './feed/optlive';
import { analyze, decide } from './engine';
import { evaluateSignal, mergeSignalIntoAnalysis, failSafeSignal, withdrawIfStale } from './signalBridge';
import { detectAlerts, DEFAULT_ALERTS } from './alerts';
import { detectLevelAlerts, DEFAULT_LEVELS } from './levelAlerts';
import { istDate } from './util';
import { mergeCandles, TF_CONFIG } from './chartmath';

const DEFAULT_SETTINGS = { strikes: 10, refreshSec: 5, sens: 'MED', confThr: 60, vibrate: true, alerts: DEFAULT_ALERTS, levels: DEFAULT_LEVELS, expiry: null, gift: null };

export const store = createStore({
  ready: false, token: null,
  conn: 'CONNECTING', connMsg: '', lastOk: 0, now: Date.now(),
  // ---- live market-data foundation (Upstox V3 WebSocket). `market` is the exchange state from market_info.
  feed: { conn: 'DISCONNECTED', connMsg: '', attempt: 0 },
  market: { state: MS.UNKNOWN, index: MS.UNKNOWN, fno: MS.UNKNOWN, eq: MS.UNKNOWN, source: null }, marketInfoAt: 0,
  scrollLocked: false, dashOpen: null, fut: null, futFresh: null, futInfo: null, futErr: '', nifty: null, vix: null, quoteAt: 0, niftyFresh: null, vixFresh: null, candlesFresh: null, chainFresh: null, sNow: Date.now(), clockSynced: false,
  candles: [], candlesInfo: { kind: SESSION.INVALID, date: null, lastT: 0, count: 0, label: 'NO DATA', usable: false }, candlesAt: 0,
  contracts: [], contractsAt: 0, contractsErr: '', pairs: [], expiries: [], expiry: null, chain: null, chainExpiry: null, chainInfo: null, chainAt: 0, chainMarketState: MS.UNKNOWN, chainErr: '', pcrIvHistory: [],
  global: null, globalAt: 0, globalErr: '',
  analysis: null, alerts: [], banner: null,
  chart: { tf: 1, candles: [], at: 0, session: null, err: '', loading: false, partial: false, gen: 0 },
  settings: DEFAULT_SETTINGS,
});

let optKeySet = new Set(), optTicks = {};
let futKey = null, futDay = '', futTryAt = 0;
let running = false, timer = null, cycle = 0, backoff = 0, history = [], prevAnalysis = null, globalBusy = false, expDay = '', lastPairsFrom = null;
const cooldown = {};
let bannerTimer = null;


// ---------------------------------------------------------------------------------------------------------
// Live market data: Upstox Market Data Feed V3 (WebSocket + Protobuf). NIFTY, India VIX and market status come
// from here and nowhere else. Nothing is cached across app launches, so an old value can never look live.
// ---------------------------------------------------------------------------------------------------------
let feedClient = null, feedState = initialFeedState(), publishTimer = null;

// REST link state for candles / option chain: 'DISCONNECTED' after a network failure or auth loss, else 'OK'.
function restLink() { const c = store.get().conn; return c === 'DISCONNECTED' || c === 'AUTH' ? 'DISCONNECTED' : 'OK'; }

function publishFeed() {
  publishTimer = null;
  const now = Date.now();
  const conn = feedClient ? feedClient.state : 'DISCONNECTED';
  const sNow = serverNow(feedState, now);
  const nifty = feedState.instruments[NIFTY_KEY] || null;
  const vix = feedState.instruments[VIX_KEY] || null;
  const ms = feedState.market.state;
  const fut = futKey ? feedState.instruments[futKey] || null : null;
  store.set({
    fut, futFresh: fut ? computeFreshness({ inst: fut, conn, marketState: ms, now, serverNow: sNow, th: THRESHOLDS.nifty }) : null,
    now, sNow, clockSynced: feedState.clockSynced, market: feedState.market, marketInfoAt: feedState.marketInfoAt,
    nifty, vix, quoteAt: nifty ? nifty.receivedAt : 0,
    niftyFresh: computeFreshness({ inst: nifty, conn, marketState: ms, now, serverNow: sNow, th: THRESHOLDS.nifty }),
    vixFresh: computeFreshness({ inst: vix, conn, marketState: ms, now, serverNow: sNow, th: THRESHOLDS.vix }),
    candlesFresh: computeCandleFreshness({ info: store.get().candlesInfo, receivedAt: store.get().candlesAt, link: restLink(), marketState: ms, now, serverNow: sNow, tfMin: 1 }),
    chainFresh: computeChainFreshness({ chain: store.get().chain, receivedAt: store.get().chainAt, requestedMarketState: store.get().chainMarketState, link: restLink(), marketState: ms, now }),
    feed: { conn, connMsg: feedClient ? feedClient.detail : '', attempt: feedClient ? feedClient.attempt : 0 },
  });
  // Live option ticks (price / OI / volume) over the REST chain between REST refreshes.
  { const c0 = store.get(); if (c0.chain && c0.chainExpiry === c0.expiry && ms === MS.OPEN) { const c1 = overlayChain(c0.chain, optTicks, c0.chainAt); if (c1 !== c0.chain) store.set({ chain: c1 }); } }
  // A direction shown from the last cycle is withdrawn as soon as its data stops being current (feed drop, stale quote / candles / chain).
  const cur = store.get().analysis, kept = withdrawIfStale(cur, store.get());
  if (kept !== cur) store.set({ analysis: kept });
}
// Coalesce bursts of ticks into at most ~5 UI updates per second.
function schedulePublish() { if (!publishTimer) publishTimer = setTimeout(publishFeed, 200); }

function handleAuthFailure(message) {
  SecureStore.deleteItemAsync('nv_token').catch(() => {});
  stopFeed();
  store.set({ token: null, conn: 'AUTH', connMsg: message || 'Session expired or invalid. Login again.', analysis: null });
}

function startFeed() {
  const token = store.get().token;
  if (!token || feedClient) return;
  feedClient = new FeedClient({
    authorize: () => authorizeFeed(store.get().token),
    keys: futKey ? [...WATCH_KEYS, futKey] : WATCH_KEYS, primaryKey: NIFTY_KEY,
    isMarketOpen: () => feedState.market.state === MS.OPEN,
    onState: (st) => {
      if (st.conn === 'CONNECTED') { // new socket: drop anything received on the previous one
        const { clockOffset, clockSynced } = feedState;
        feedState = { ...initialFeedState(), clockOffset, clockSynced }; optTicks = {};
      }
      if (st.conn === 'RECONNECTING' || st.conn === 'DISCONNECTED' || st.conn === 'ERROR') flog('Feed state', { conn: st.conn, attempt: st.attempt });
      publishFeed();
    },
    onFeed: (resp, at, err) => {
      // (futures key, when known, is passed below)
      if (!resp) { feedState = { ...feedState, decodeErrors: feedState.decodeErrors + 1 }; return; }
      const before = feedState.market.state;
      feedState = applyFeedResponse(feedState, resp, at, futKey ? [futKey] : []);
      optTicks = readOptionTicks(optTicks, resp, at, optKeySet);
      if (feedState.market.state !== before) flog('Market state changed', { from: before, to: feedState.market.state });
      schedulePublish();
    },
    onAuthError: (e) => handleAuthFailure(e && e.message),
  });
  feedClient.start();
}

function stopFeed() {
  if (publishTimer) { clearTimeout(publishTimer); publishTimer = null; }
  if (feedClient) { feedClient.stop(); feedClient = null; }
  feedState = initialFeedState();
  store.set({ nifty: null, vix: null, fut: null, futFresh: null, futInfo: null, quoteAt: 0, niftyFresh: null, vixFresh: null, candlesFresh: null, chainFresh: null, market: feedState.market, feed: { conn: 'DISCONNECTED', connMsg: '', attempt: 0 } });
}

export async function init() {
  try {
    const [t, s] = await Promise.all([SecureStore.getItemAsync('nv_token'), SecureStore.getItemAsync('nv_settings')]);
    let settings = DEFAULT_SETTINGS;
    if (s) { try { const p = JSON.parse(s); settings = { ...DEFAULT_SETTINGS, ...p, alerts: { ...DEFAULT_ALERTS, ...(p.alerts || {}) }, levels: { ...DEFAULT_LEVELS, ...(p.levels || {}) } }; } catch (e) { /* keep defaults */ } }
    store.set({ token: t || null, settings, expiry: settings.expiry, ready: true });
  } catch (e) { store.set({ ready: true }); }
}

export function setToken(t) {
  if (!t) return;
  SecureStore.setItemAsync('nv_token', t).catch(() => {});
  history = []; prevAnalysis = null; prevLevels = null; optKeySet = new Set(); optTicks = {}; futKey = null; futDay = ''; futTryAt = 0;
  stopFeed();
  store.set({ pcrIvHistory: [] });
  store.set({ token: t, conn: 'CONNECTING', connMsg: '' });
  if (running) { startFeed(); schedule(0); }
}

export function logout() {
  SecureStore.deleteItemAsync('nv_token').catch(() => {});
  stopFeed();
  store.set({ token: null, conn: 'AUTH', connMsg: 'Logged out', analysis: null });
}

export function updateSettings(patch) {
  const s = { ...store.get().settings, ...patch };
  store.set({ settings: s });
  SecureStore.setItemAsync('nv_settings', JSON.stringify(s)).catch(() => {});
}

export function setExpiry(e) {
  const st = store.get();
  if (!st.expiries.includes(e) || e === st.expiry) return; // only a real, still-valid Upstox expiry can be selected
  store.set({ expiry: e, pairs: pairsForExpiry(st.contracts, e), chain: null, chainExpiry: null, chainInfo: null, chainAt: 0, pcrIvHistory: [] });
  updateSettings({ expiry: e });
  history = [];
  if (running) schedule(0);
}

export function start() { if (running) return; running = true; startFeed(); schedule(0); }
export function stop() { running = false; if (timer) clearTimeout(timer); timer = null; stopFeed(); }
function schedule(ms) { if (timer) clearTimeout(timer); if (!running) return; timer = setTimeout(tick, ms); }

let prevLevels = null;
function pushAlert(type, msg, now) {
  const s = store.get();
  if (s.settings.alerts[type] === false) return;
  const cd = type.endsWith('Level') ? 0 : type.endsWith('Signal') || type.startsWith('waitTo') ? 30000 : 300000;
  if (cooldown[type] && now - cooldown[type] < cd) return;
  cooldown[type] = now;
  const item = { id: now + type, type, msg, t: now };
  store.set({ alerts: [item, ...s.alerts].slice(0, 100), banner: item });
  if (s.settings.vibrate) { try { Vibration.vibrate([0, 250, 120, 250]); } catch (e) { /* ignore */ } }
  if (bannerTimer) clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => store.set({ banner: null }), 7000);
}

export function clearAlerts() { store.set({ alerts: [], banner: null }); }
export function dismissBanner() { store.set({ banner: null }); }

async function refreshGlobal() {
  if (globalBusy) return; globalBusy = true;
  try {
    const g = await fetchGlobal();
    const ok = Object.values(g).some((x) => x && !x.error);
    store.set({ global: g, globalAt: Date.now(), globalErr: ok ? '' : 'Global data source unreachable' });
  } catch (e) { store.set({ globalErr: 'Global data source unreachable' }); }
  finally { globalBusy = false; }
}

let lastManual = 0;
// Manual refresh for one dashboard section. Throttled so repeated taps cannot hit Upstox's rate limit.
export function refreshNow(kind) {
  const n = Date.now();
  if (n - lastManual < 1500) return;
  lastManual = n;
  if (kind === 'chart') { loadChart(store.get().chart.tf, { full: true }); return; }
  if (kind === 'global') { futTryAt = 0; refreshGlobal(); schedule(0); return; }
  schedule(0); // signal / levels / chain / OI / PCR: run a full cycle now
}
export function setDashSection(id) { store.set({ dashOpen: id }); }
export function setGift(price) {
  const v = Number(price);
  if (!Number.isFinite(v) || v < 1000 || v > 100000) return false;
  updateSettings({ gift: { price: v, at: Date.now() } });
  return true;
}
export function clearGift() { updateSettings({ gift: null }); }

async function tick() {
  if (!running) return;
  const s0 = store.get();
  if (!s0.token) { schedule(1500); return; }
  if (!feedClient) startFeed();
  const token = s0.token; const now = Date.now();
  publishFeed(); // refresh freshness/ages every cycle even if no tick arrived
  const refreshMs = s0.settings.refreshSec * 1000;
  let delay = refreshMs; const errs = [];
  cycle += 1;
  try {
    // ---- NIFTY option contracts (Upstox /v2/option/contract): fetched once per IST day, expiries derived from them.
    const today = istDate(store.get().sNow);
    let contracts = s0.contracts;
    if (!contracts.length || expDay !== today) {
      try {
        const r = await fetchContracts(token);
        if (!r.contracts.length) throw new ApiError('DATA', 'No NIFTY option contracts returned');
        contracts = r.contracts; expDay = today;
        store.set({ contracts, contractsAt: Date.now(), contractsErr: '' });
      } catch (e) { errs.push(e); store.set({ contractsErr: (e && e.message) || 'Option contract error' }); }
    }
    // NIFTY futures contract: looked up once a day (and again once the held contract has expired), then streamed on the same feed.
    const fNow = store.get().sNow || Date.now();
    const fi = store.get().futInfo;
    const heldOk = !!fi && expiryEndMs(fi.expiry) > fNow && futDay === today;
    if (!heldOk && Date.now() - futTryAt > 60000) { // on failure retry at most once a minute
      futTryAt = Date.now();
      try {
        const f = pickNiftyFuture(await fetchNiftyFutures(token), fNow);
        if (!f) throw new ApiError('DATA', 'No NIFTY futures contract returned');
        futKey = f.key; futDay = today;
        store.set({ futInfo: f, futErr: '' });
        if (feedClient) feedClient.addKeys([f.key]);
      } catch (e) { errs.push(e); futKey = null; store.set({ futInfo: null, futErr: (e && e.message) || 'Futures lookup error' }); }
    }
    // Recomputed every cycle from the exchange-aligned clock, so an expiry drops out at 15:30 IST on its day
    // and the selection rolls to the nearest valid future expiry without any refetch or restart.
    const cNow = store.get().sNow || Date.now();
    const expiries = validExpiries(contracts, cNow);
    if (!expiries.length) expDay = ''; // nothing valid left in the cached list: refetch next cycle
    const prevExpiry = store.get().expiry;
    const expiry = pickExpiry(prevExpiry, expiries, cNow);
    const cur = store.get();
    const expChanged = expiry !== prevExpiry;
    const expList = cur.expiries.length === expiries.length && cur.expiries.every((e, i) => e === expiries[i]) ? cur.expiries : expiries;
    const pairs = expChanged || contracts !== lastPairsFrom ? pairsForExpiry(contracts, expiry) : cur.pairs;
    lastPairsFrom = contracts;
    store.set({ expiries: expList, expiry, pairs, ...(expChanged ? { chain: null, chainExpiry: null, chainInfo: null, chainAt: 0, pcrIvHistory: [] } : null) });
    if (expChanged) history = [];
    const chainReqState = store.get().market.state; // phase when the chain request is issued (a chain asked for before the open is not live data)
    const wantCandles = true;
    const [ch, cd] = await Promise.allSettled([
      expiry ? fetchChain(token, expiry) : Promise.resolve(null),
      wantCandles ? fetchCandles(token, NIFTY_KEY, 1) : Promise.resolve(null),
    ]);
    const patch = {};
    if (ch.status === 'fulfilled') {
      if (ch.value) {
        // The user may have picked another expiry (or the expiry may have rolled) while this request was in flight:
        // a chain for an expiry that is no longer selected is discarded, never shown and never mixed in.
        if (shouldAcceptChain(expiry, store.get().expiry)) {
          const v = verifyAgainstContracts(ch.value.rows, store.get().contracts, expiry);
          const dropped = ch.value.rejected + ch.value.otherExpiry + ch.value.duplicates + v.mismatched;
          patch.chain = v.rows; patch.chainExpiry = expiry; patch.chainAt = Date.now(); patch.chainMarketState = chainReqState;
          patch.chainInfo = { total: v.rows.length, dropped, otherExpiry: ch.value.otherExpiry, mismatched: v.mismatched };
          patch.chainErr = v.rows.length ? '' : 'Option chain returned no strikes';
          { const ks = optionKeys(v.rows, validSpot(store.get().nifty, store.get().niftyFresh), store.get().settings.strikes + 2);
            if (ks.length && feedClient) { optKeySet = new Set(ks); feedClient.addKeys(ks); } }
        }
      }
    } else { errs.push(ch.reason); patch.chainErr = (ch.reason && ch.reason.message) || 'Option chain error'; }
    if (cd.status === 'fulfilled') {
      if (cd.value) { patch.candles = cd.value.candles; patch.candlesAt = Date.now(); }
    } else errs.push(cd.reason);
    store.set(patch);
    // Rolling PCR / IV history (Part 6): one sample per NEW chain of the selected expiry, and only for a chain that was requested
    // while the market was open (a pre-open or after-close snapshot does not move, so it must not look like "no change").
    if (patch.chain && patch.chainAt && chainReqState === MS.OPEN) {
      const c = store.get();
      const sample = makeSample({ rows: patch.chain, expiry, spot: validSpot(c.nifty, c.niftyFresh), at: patch.chainAt });
      if (sample) store.set({ pcrIvHistory: pushSample(c.pcrIvHistory, sample) });
    }
    if (!store.get().globalAt || now - store.get().globalAt > 30000) refreshGlobal();

    // ---- analysis on a consistent snapshot: feed state + exchange-aligned clock + single-session candles
    publishFeed();
    const s = store.get();
    const nowD = Date.now(); const sNow = s.sNow; const ms = s.market.state;
    const sel = selectCandles(s.candles, sNow, ms);
    store.set({ candlesInfo: sel.info });
    publishFeed(); // candle freshness depends on candlesInfo
    const s2 = store.get();
    const gate = evaluateGate({ conn: s.feed.conn, market: s.market, nifty: s.nifty, niftyFresh: s.niftyFresh, serverNow: sNow, candles: sel.info, candlesFresh: s2.candlesFresh, vixFresh: s.vixFresh });
    const vixUse = usableForLive(s.vixFresh, ms) ? s.vix : null; // only a LIVE/FRESH VIX from the CURRENT session is a live factor
    let a = analyze({ now: nowD, sNow, gate, session: sel.info, quote: s.nifty, vix: vixUse, candles: sel.candles, chain: s.chainExpiry === s.expiry ? s.chain : null, chainAt: s.chainAt, chainFresh: s2.chainFresh, global: s.global, history, settings: s.settings, expiry: s.expiry });
    a = decide(a, s.settings, vixUse);
    // Part 10B: the visible signal, probabilities, confidence, reasons and gate status come from the probability signal engine (src/signal.js).
    // The legacy decision above is overridden; the bridge re-validates the result and falls back to a WAIT on any problem. Analysis only.
    a = mergeSignalIntoAnalysis(a, evaluateSignal(s2));
    if (a.snapshot && (!history.length || nowD - history[history.length - 1].t >= 15000)) {
      history.push(a.snapshot);
      history = history.filter((h) => nowD - h.t <= 40 * 60000);
    }
    detectAlerts(prevAnalysis, a).forEach((e) => pushAlert(e.type, e.msg, nowD));
    prevAnalysis = a.live ? a : null;
    // Price / VIX level alerts: only from LIVE/FRESH current-session readings.
    const curLvl = { price: usableForLive(s.niftyFresh, ms) && s.nifty ? s.nifty.ltp : null, vix: vixUse ? vixUse.ltp : null };
    detectLevelAlerts(prevLevels, curLvl, s.settings.levels).forEach((e) => {
      pushAlert(e.type, e.msg, nowD); // one-shot: disarm the rule that fired
      updateSettings({ levels: { ...store.get().settings.levels, [e.id]: null } });
    });
    prevLevels = curLvl;
    store.set({ analysis: a });
  } catch (e) {
    errs.push(e);
    // The analysis cycle itself failed: never leave the previous cycle's CALL / PUT on screen.
    const cur = store.get().analysis;
    if (cur && cur.signal !== 'WAIT') store.set({ analysis: mergeSignalIntoAnalysis(cur, failSafeSignal('analysis cycle failed', 'Data not refreshed')) });
  }

  // ---- REST connection state (option chain / candles / expiries). Live quotes are tracked in `feed`.
  const auth = errs.find((e) => e && e.kind === 'AUTH');
  const rate = errs.find((e) => e && e.kind === 'RATE');
  const net = errs.filter((e) => e && e.kind === 'NETWORK');
  const other = errs.find((e) => e && e.kind !== 'NETWORK' && e.kind !== 'AUTH' && e.kind !== 'RATE');
  if (auth) {
    handleAuthFailure(auth.message);
    delay = 2000;
  } else if (net.length) {
    backoff = Math.min(30000, (backoff || refreshMs) * 2);
    delay = backoff;
    store.set({ conn: 'DISCONNECTED', connMsg: net[0].message + ` Retrying in ${Math.round(delay / 1000)}s.` });
  } else if (rate) {
    delay = 20000; store.set({ conn: 'RATE', connMsg: rate.message });
  } else if (other) {
    backoff = 0; store.set({ conn: 'ERROR', connMsg: other.message || 'Unexpected error' });
  } else {
    backoff = 0; store.set({ conn: 'CONNECTED', connMsg: '', lastOk: Date.now() });
  }
  schedule(delay);
}

// ---------------------------------------------------------------------------------------------------------
// Chart (Part 8). Own candle set, separate from the signal engine's candles: browsing history can never change a
// CALL / PUT / WAIT decision. Full load = intraday + history; the 15 s refresh only re-fetches today's candles and
// merges them in by timestamp, so the user's scroll position and zoom survive.
// ---------------------------------------------------------------------------------------------------------
let chartSeq = 0;

export function setChartTf(tf) {
  if (!TF_CONFIG[tf]) return;
  const c = store.get().chart;
  if (c.tf === tf && (c.candles.length || c.loading)) return;
  chartSeq += 1;
  store.set({ chart: { tf, candles: [], at: 0, session: null, err: '', loading: true, partial: false, gen: c.gen + 1 } });
  loadChart(tf, { full: true });
}

export async function loadChart(tf, opts = {}) {
  const s = store.get();
  if (!s.token || !TF_CONFIG[tf]) return;
  const have = s.chart.tf === tf && s.chart.candles.length > 0;
  const full = !!opts.full || !have;
  if (!full) { // incremental refresh: skip when the market is closed and the last candle was already complete when we last fetched
    const last = s.chart.candles[s.chart.candles.length - 1];
    if (s.market.state !== MS.OPEN && s.chart.at > last.t + tf * 60000 + 30000) return;
  }
  const seq = full ? ++chartSeq : chartSeq;
  if (full) store.set({ chart: { ...(s.chart.tf === tf ? s.chart : { tf, candles: [], at: 0, session: null, err: '', partial: false, gen: s.chart.gen + 1 }), tf, loading: !have, err: '' } });
  try {
    let candles, partial = store.get().chart.partial, errs = [];
    if (full) {
      const r = await fetchChartCandles(s.token, NIFTY_KEY, tf);
      candles = r.candles; partial = r.partial; errs = r.errors;
    } else {
      candles = mergeCandles(store.get().chart.candles, await fetchChartIntraday(s.token, NIFTY_KEY, tf));
    }
    const cur = store.get();
    if (seq !== chartSeq || cur.chart.tf !== tf) return; // user switched timeframe while this request was in flight: discard
    const session = describeSeries(candles, cur.sNow, cur.market.state);
    const err = !candles.length ? 'No candles available for this timeframe' : partial ? 'Part of the history could not be loaded' : '';
    store.set({ chart: { ...cur.chart, tf, candles, at: Date.now(), session, err, loading: false, partial } });
  } catch (e) {
    const cur = store.get();
    if (seq !== chartSeq || cur.chart.tf !== tf) return;
    store.set({ chart: { ...cur.chart, tf, loading: false, err: (e && e.message) || 'Chart data error' } });
    if (e && e.kind === 'AUTH') handleAuthFailure(e.message);
  }
}

export { deriveStatus, MARKET_STATE_LABEL };

