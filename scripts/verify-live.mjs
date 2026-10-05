// Live verification against the REAL Upstox Market Data Feed V3. Run it yourself with your daily token:
//   UPSTOX_TOKEN=<token> node --import ./tests/register.mjs scripts/verify-live.mjs [seconds]
// Uses the app's own FeedClient / decoder / reducer. The token is read from the environment and never printed.
import WebSocket from 'ws';
import { FeedClient } from '../src/feed/client';
import { initialFeedState, applyFeedResponse, NIFTY_KEY, VIX_KEY, WATCH_KEYS } from '../src/feed/feedState';
import { authorizeFeed } from '../src/api';
import { deriveMarketState } from '../src/feed/marketStatus';

const token = process.env.UPSTOX_TOKEN;
if (!token) { console.error('Set UPSTOX_TOKEN (today\'s Upstox access token) and re-run.'); process.exit(2); }
const seconds = Math.max(5, Number(process.argv[2]) || 30);

const ist = (ms) => new Date(ms + 5.5 * 3600e3).toISOString().replace('T', ' ').slice(0, 19) + ' IST';
let st = initialFeedState(); const states = []; let authErr = null;

const client = new FeedClient({
  WebSocketImpl: WebSocket, keys: WATCH_KEYS, primaryKey: NIFTY_KEY,
  authorize: () => authorizeFeed(token),
  isMarketOpen: () => st.market.state === 'NORMAL_OPEN',
  onState: (s) => { states.push(s.conn); console.log(`[state] ${s.conn}${s.connMsg ? ' - ' + s.connMsg : ''}`); },
  onFeed: (resp, at) => {
    if (!resp) return;
    st = applyFeedResponse(st, resp, at);
    for (const k of [NIFTY_KEY, VIX_KEY]) {
      const i = resp.feeds && resp.feeds[k] && st.instruments[k];
      if (i) console.log(`[tick] ${k.split('|')[1].padEnd(9)} ltp=${i.ltp} prevClose=${i.cp} ltt=${i.tsValid ? ist(i.ltt) : 'INVALID'} serverTs=${ist(resp.currentTs)}`);
    }
    if (resp.marketInfo) console.log('[market_info]', JSON.stringify(resp.marketInfo.segmentStatus));
  },
  onAuthError: (e) => { authErr = e; },
});

console.log(`Connecting to Upstox V3 feed for ${seconds}s (keys: ${WATCH_KEYS.join(', ')})...`);
client.start();
setTimeout(() => {
  client.stop();
  const n = st.instruments[NIFTY_KEY], v = st.instruments[VIX_KEY];
  const checks = [
    ['authorized (token accepted)', !authErr],
    ['reached LIVE', states.includes('LIVE')],
    ['NIFTY 50 price received', !!n],
    ['NIFTY exchange timestamp valid', !!(n && n.tsValid)],
    ['India VIX price received', !!v],
    ['India VIX exchange timestamp valid', !!(v && v.tsValid)],
    ['market_info received', st.marketInfo !== null],
    ['socket disposed on stop', client.ws === null && states[states.length - 1] === 'DISCONNECTED'],
  ];
  console.log('\nMarket state:', JSON.stringify(deriveMarketState(st.marketInfo)));
  if (authErr) console.log('Auth failed:', authErr.message);
  checks.forEach(([n2, ok]) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${n2}`));
  process.exit(checks.every((c) => c[1]) ? 0 : 1);
}, seconds * 1000);
