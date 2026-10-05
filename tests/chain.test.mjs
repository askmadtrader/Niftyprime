import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import {
  parseSide, parseChain, verifyAgainstContracts, shouldAcceptChain, validSpot, clampStrikes, strikeStep, findAtm,
  buildChainView, chainStatus, CHAIN_STATUS, sideCells, MAX_STRIKES, DEFAULT_STRIKES,
} from '../src/chain';
import { fetchChain, NIFTY_KEY } from '../src/api';
import { computeChainFreshness } from '../src/feed/freshness';
import { MS } from '../src/feed/marketStatus';

const EXP = '2030-03-07', OTHER = '2030-03-14';
let k = 5000;
// Row shaped exactly like the Upstox Put/Call Option Chain response (https://upstox.com/developer/api-documentation/get-pc-option-chain/)
const md = (o = {}) => ({ ltp: 100.5, volume: 12000, oi: 450000, close_price: 99, bid_price: 100.4, bid_qty: 150, ask_price: 100.6, ask_qty: 225, prev_oi: 400000, ...o });
const row = (strike, over = {}, callMd, putMd) => ({
  expiry: EXP, pcr: 1.1, strike_price: strike, underlying_key: NIFTY_KEY, underlying_spot_price: 24512.35,
  call_options: { instrument_key: `NSE_FO|${k++}`, market_data: md(callMd), option_greeks: { vega: 1, theta: -2, gamma: 0.001, delta: 0.5, iv: 12.5, pop: 40 } },
  put_options: { instrument_key: `NSE_FO|${k++}`, market_data: md(putMd), option_greeks: { vega: 1, theta: -2, gamma: 0.001, delta: -0.5, iv: 13.5, pop: 40 } },
  ...over,
});
const strikes = (from, to, step = 50) => { const a = []; for (let s = from; s <= to; s += step) a.push(s); return a; };
const parsed = (list, expiry = EXP) => parseChain(list, expiry, NIFTY_KEY).rows;

test('a chain side keeps LTP, OI, volume AND bid, ask, bid/ask quantity, previous OI and instrument key', () => {
  const s = parseSide({ instrument_key: 'NSE_FO|777', market_data: md() });
  assert.deepEqual(
    { ltp: s.ltp, oi: s.oi, vol: s.vol, bid: s.bid, ask: s.ask, bidQty: s.bidQty, askQty: s.askQty, prevOi: s.prevOi, key: s.key, instrumentKey: s.instrumentKey },
    { ltp: 100.5, oi: 450000, vol: 12000, bid: 100.4, ask: 100.6, bidQty: 150, askQty: 225, prevOi: 400000, key: 'NSE_FO|777', instrumentKey: 'NSE_FO|777' },
  );
});

test('missing values stay null: never 0, never copied from another field', () => {
  const empty = parseSide(undefined);
  Object.entries(empty).forEach(([f, v]) => assert.equal(v, null, `${f} must be null`));
  const partial = parseSide({ instrument_key: 'NSE_FO|1', market_data: { ltp: 50 } });
  assert.equal(partial.ltp, 50);
  ['oi', 'vol', 'prevOi', 'bid', 'ask', 'bidQty', 'askQty'].forEach((f) => assert.equal(partial[f], null, f));
  const junk = parseSide({ market_data: { ltp: '', volume: null, oi: undefined, bid_price: 'abc', ask_price: NaN, bid_qty: -5, prev_oi: -1 } });
  ['ltp', 'vol', 'oi', 'bid', 'ask', 'bidQty', 'prevOi'].forEach((f) => assert.equal(junk[f], null, f));
  assert.equal(parseSide({ market_data: { ltp: 0 } }).ltp, null);           // a price of 0 is "no price"
  const real0 = parseSide({ market_data: { volume: 0, oi: 0 } });          // but a real 0 volume / OI is real
  assert.equal(real0.vol, 0); assert.equal(real0.oi, 0);
  // a row with no put_options at all: the put side is all null, the call side is untouched
  const r = parsed([{ ...row(24500), put_options: undefined }])[0];
  assert.equal(r.put.ltp, null); assert.equal(r.put.oi, null); assert.equal(r.put.key, null); assert.equal(r.call.ltp, 100.5);
});

test('cells: null renders "--", a real zero renders "0", nothing is filled in', () => {
  assert.deepEqual(sideCells(parseSide(undefined)), { ltp: '--', oi: '--', vol: '--' });
  assert.deepEqual(sideCells(parseSide({ market_data: { ltp: 12.3, oi: 0, volume: 0 } })), { ltp: '12.30', oi: '0', vol: '0' });
  assert.deepEqual(sideCells(parseSide({ market_data: md({ oi: 5636475, volume: 22315725 }) })), { ltp: '100.50', oi: '56.36L', vol: '2.23Cr' });
  assert.deepEqual(sideCells(null), { ltp: '--', oi: '--', vol: '--' });
});

test('one chain = one expiry: rows of another expiry, wrong underlying, bad strikes and duplicates are dropped', () => {
  const data = [
    row(24550), row(24500), row(24450),
    row(24600, { expiry: OTHER }), row(24650, { expiry: '2030-03-28' }),
    row(24700, { underlying_key: 'NSE_INDEX|Nifty Bank' }), row(0), row(-50), { ...row(24800), strike_price: null }, null, 'x',
    row(24500), // duplicate strike
    row(24400, { expiry: undefined }), // Upstox sent no expiry on the row: it belongs to the requested one
  ];
  const r = parseChain(data, EXP, NIFTY_KEY);
  assert.deepEqual(r.rows.map((x) => x.strike), [24400, 24450, 24500, 24550]);   // sorted ascending
  assert.ok(r.rows.every((x) => x.expiry === EXP));
  assert.equal(r.otherExpiry, 2); assert.equal(r.duplicates, 1); assert.equal(r.rejected, 6);
  assert.deepEqual(parseChain(undefined, EXP, NIFTY_KEY).rows, []);
  assert.deepEqual(parseChain({ x: 1 }, EXP, NIFTY_KEY).rows, []);
  assert.deepEqual(parseChain([row(24500)], 'garbage', NIFTY_KEY).rows, []);       // unusable requested expiry => nothing
});

test('instrument keys are cross-checked against the real contract list (Part 3)', () => {
  const rows = parsed([row(24500), row(24550), row(24600)]);
  const mk = (r, side, type, over = {}) => ({ instrumentKey: r[side].key, expiry: EXP, strike: r.strike, type, ...over });
  const contracts = [
    mk(rows[0], 'call', 'CE'), mk(rows[0], 'put', 'PE'),
    mk(rows[1], 'call', 'CE', { expiry: OTHER }),     // call key of 24550 is really another expiry's contract
    mk(rows[2], 'put', 'PE', { strike: 99999 }),      // put key of 24600 is really another strike
  ];
  const v = verifyAgainstContracts(rows, contracts, EXP);
  assert.deepEqual(v.rows.map((r) => r.strike), [24500]);
  assert.equal(v.mismatched, 2);
  // a CE key sitting in the put slot is a mismatch too
  const swapped = parsed([row(24500)]);
  assert.equal(verifyAgainstContracts(swapped, [{ instrumentKey: swapped[0].put.key, expiry: EXP, strike: 24500, type: 'CE' }], EXP).rows.length, 0);
  // unknown keys cannot be verified and are kept; no contract list verifies nothing
  assert.equal(verifyAgainstContracts(rows, [], EXP).rows.length, 3);
  assert.equal(verifyAgainstContracts(rows, [{ instrumentKey: 'NSE_FO|0', expiry: OTHER, strike: 1, type: 'CE' }], EXP).rows.length, 3);
});

test('a chain response is only accepted for the expiry that is still selected', () => {
  assert.equal(shouldAcceptChain(EXP, EXP), true);
  assert.equal(shouldAcceptChain(EXP, OTHER), false);   // user switched while the request was in flight
  assert.equal(shouldAcceptChain(EXP, null), false);
  assert.equal(shouldAcceptChain(null, null), false);
});

test('ATM = strike nearest to the latest valid NIFTY price (ties go to the lower strike)', () => {
  const rows = parsed(strikes(24000, 25000).map((s) => row(s)));
  const at = (spot) => { const i = findAtm(rows, spot); return i < 0 ? null : rows[i].strike; };
  assert.equal(at(24512.35), 24500);
  assert.equal(at(24526), 24550);
  assert.equal(at(24525), 24500);       // exact tie
  assert.equal(at(24500), 24500);
  assert.equal(at(24000), 24000);
  assert.equal(at(25020), 25000);       // within one step beyond the edge: still ATM of the edge row
  assert.equal(at(25100), null);        // chain does not cover the market: no ATM
  assert.equal(at(23000), null);
  assert.equal(at(null), null); assert.equal(at(NaN), null); assert.equal(at(0), null); assert.equal(at(-5), null);
  assert.equal(findAtm([], 24500), -1);
  assert.equal(strikeStep(rows), 50); assert.equal(strikeStep(rows.slice(0, 1)), null);
});

test('ATM uses only a valid NIFTY price from the live feed, never the chain snapshot spot', () => {
  const ok = { ltp: 24512.35, tsValid: true };
  assert.equal(validSpot(ok, { session: 'CURRENT' }), 24512.35);
  assert.equal(validSpot(ok, { session: 'PREVIOUS' }), 24512.35);      // stale is still the latest valid price (badge says so)
  assert.equal(validSpot({ ...ok, tsValid: false }, null), null);
  assert.equal(validSpot({ ...ok, ltp: 0 }, null), null);
  assert.equal(validSpot({ ...ok, ltp: NaN }, null), null);
  assert.equal(validSpot(ok, { session: 'FUTURE' }), null);
  assert.equal(validSpot(ok, { session: 'INVALID' }), null);
  assert.equal(validSpot(null, null), null);
  // the row's own underlying_spot_price is retained but ATM ignores it
  const rows = parsed(strikes(24000, 25000).map((s) => row(s, { underlying_spot_price: 24012 })));
  assert.equal(rows[0].spot, 24012);
  assert.equal(buildChainView(rows, validSpot(ok, null), 5).atmStrike, 24500);
  assert.equal(buildChainView(rows, validSpot(null, null), 5).atmStrike, null);
});

test('configurable strikes around ATM; the window clips at the chain edge and never pads', () => {
  const rows = parsed(strikes(24000, 25000).map((s) => row(s)));                // 21 strikes, ATM 24500 = index 10
  const v5 = buildChainView(rows, 24500, 5);
  assert.deepEqual(v5.rows.map((r) => r.strike), strikes(24250, 24750));
  assert.equal(v5.rows.length, 11); assert.equal(v5.atmStrike, 24500); assert.equal(v5.rows[v5.atmIndex].strike, 24500);
  assert.equal(buildChainView(rows, 24500, 3).rows.length, 7);
  assert.equal(buildChainView(rows, 24500, 10).rows.length, 21);
  const edge = buildChainView(rows, 24050, 5);                                  // only 1 strike below ATM exists
  assert.deepEqual(edge.rows.map((r) => r.strike), strikes(24000, 24300));
  assert.equal(edge.clippedBelow, true); assert.equal(edge.clippedAbove, false); assert.equal(edge.rows[edge.atmIndex].strike, 24050);
  assert.equal(buildChainView(rows, 24500, 5).clippedBelow, false);
  // reasons when there is nothing to show
  assert.equal(buildChainView([], 24500, 5).reason, 'NO_CHAIN');
  assert.equal(buildChainView(rows, null, 5).reason, 'NO_SPOT');
  assert.equal(buildChainView(rows, 30000, 5).reason, 'SPOT_OUTSIDE_CHAIN');
  assert.equal(buildChainView(rows, 30000, 5).rows.length, 0);
  // setting is clamped
  assert.equal(clampStrikes(0), 1); assert.equal(clampStrikes(-3), 1); assert.equal(clampStrikes(999), MAX_STRIKES);
  assert.equal(clampStrikes(7.4), 7); assert.equal(clampStrikes('x'), DEFAULT_STRIKES); assert.equal(clampStrikes(undefined), DEFAULT_STRIKES);
  // the ATM flag is exactly one row and every row in the view has the same expiry
  assert.ok(v5.rows.every((r) => r.expiry === EXP));
});

test('status: LIVE | STALE | PREVIOUS SESSION | UNAVAILABLE', () => {
  const NOW = 1900000000000, rows = parsed([row(24500)]);
  const fr = (ageMs, { req = MS.OPEN, ms = MS.OPEN, link = 'OK', chain = rows } = {}) =>
    computeChainFreshness({ chain, receivedAt: NOW - ageMs, requestedMarketState: req, link, marketState: ms, now: NOW });
  const st = (fresh, over = {}) => chainStatus({ rows, chainExpiry: EXP, expiry: EXP, fresh, ...over });

  assert.equal(st(fr(3000)).status, CHAIN_STATUS.LIVE);
  assert.equal(st(fr(40000)).status, CHAIN_STATUS.LIVE);                       // 20-60 s is still a current poll
  assert.equal(st(fr(90000)).status, CHAIN_STATUS.STALE);                      // not refreshed
  assert.equal(st(fr(3000, { req: MS.PRE_OPEN })).status, CHAIN_STATUS.STALE); // fetched before the open
  assert.equal(st(fr(3000, { req: MS.PRE_OPEN })).reason, 'RECEIVED_BEFORE_MARKET_OPEN');
  assert.equal(st(fr(3000, { link: 'DISCONNECTED' })).status, CHAIN_STATUS.STALE);
  assert.equal(st(fr(3000, { ms: MS.CLOSED })).status, CHAIN_STATUS.PREVIOUS);
  assert.equal(st(fr(3000, { ms: MS.PRE_OPEN })).status, CHAIN_STATUS.PREVIOUS);
  // unavailable: nothing yet, empty, never received, or a chain that is not for the selected expiry
  assert.equal(st(fr(0, { chain: null })).status, CHAIN_STATUS.UNAVAILABLE);
  assert.equal(st(null).status, CHAIN_STATUS.UNAVAILABLE);
  assert.equal(chainStatus({ rows: [], chainExpiry: EXP, expiry: EXP, fresh: fr(1000) }).status, CHAIN_STATUS.UNAVAILABLE);
  assert.equal(chainStatus({ rows: null, chainExpiry: null, expiry: EXP, fresh: null }).status, CHAIN_STATUS.UNAVAILABLE);
  const mismatch = st(fr(1000), { chainExpiry: OTHER });
  assert.equal(mismatch.status, CHAIN_STATUS.UNAVAILABLE); assert.equal(mismatch.reason, 'EXPIRY_MISMATCH');
  assert.equal(st(fr(1000), { expiry: null }).status, CHAIN_STATUS.UNAVAILABLE);
  assert.deepEqual(Object.values(CHAIN_STATUS).sort(), ['LIVE', 'PREVIOUS SESSION', 'STALE', 'UNAVAILABLE']);
});

test('fetchChain asks Upstox for the selected expiry on NSE_INDEX|Nifty 50 and returns only that expiry', async () => {
  const SECRET = 'TOKEN-ABC', calls = [];
  const body = { status: 'success', data: [row(24500), row(24550), row(24600, { expiry: OTHER })] };
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return { status: 200, ok: true, json: async () => body }; };
  const r = await fetchChain(SECRET, EXP);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.upstox.com/v2/option/chain?instrument_key=NSE_INDEX%7CNifty%2050&expiry_date=2030-03-07');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer ' + SECRET);
  assert.ok(!calls[0].url.includes(SECRET));
  assert.deepEqual(r.rows.map((x) => x.strike), [24500, 24550]);
  assert.equal(r.otherExpiry, 1);
  body.data = [];
  assert.deepEqual((await fetchChain(SECRET, EXP)).rows, []);                  // empty stays empty
});

test('no second WebSocket: only the Part 1 feed client opens a socket; chain code uses REST only', () => {
  const walk = (dir) => readdirSync(new URL(dir, import.meta.url), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}${e.name}/`) : [`${dir}${e.name}`]));
  const files = walk('../src/').filter((f) => f.endsWith('.js'));
  const withSocket = files.filter((f) => /new\s+(this\.WS|WebSocket)\b|WebSocketImpl/.test(readFileSync(new URL(f, import.meta.url), 'utf8')));
  assert.deepEqual(withSocket, ['../src/feed/client.js']);
  for (const f of ['../src/chain.js', '../src/ui/ChainTable.js', '../src/api.js']) {
    assert.ok(!/WebSocket|FeedClient/.test(readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\/\/[^\n]*/g, '')), `${f} must not touch sockets`);
  }
  // exactly one FeedClient is constructed by the app, in the controller
  const ctl = readFileSync(new URL('../src/controller.js', import.meta.url), 'utf8');
  assert.equal((ctl.match(/new FeedClient\(/g) || []).length, 1);
});

test('display code never zero-fills a missing value', () => {
  for (const f of ['../src/chain.js', '../src/ui/ChainTable.js']) {
    const t = readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\/\/[^\n]*/g, '');
    assert.ok(!/(\|\||\?\?)\s*0\b/.test(t), `${f} contains a "|| 0" / "?? 0" fallback`);
  }
});
