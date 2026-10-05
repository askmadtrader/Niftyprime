import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import {
  toContract, parseContracts, isExpired, validExpiries, nearestExpiry, pickExpiry,
  expiryKind, describeExpiry, pairContracts, pairsForExpiry, EXPIRY_CUTOFF_MIN,
} from '../src/contracts';
import { fetchContracts, NIFTY_KEY } from '../src/api';
// IST wall clock -> epoch ms (local copy: helpers.mjs pulls in protobufjs, which this test does not need)
const ist = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s) - 5.5 * 3600 * 1000;

// Raw row exactly as Upstox documents it (https://upstox.com/developer/api-documentation/get-option-contracts/)
let n = 1000;
const raw = (expiry, strike, type, over = {}) => ({
  name: 'NIFTY', segment: 'NSE_FO', exchange: 'NSE', expiry,
  instrument_key: `NSE_FO|${n++}`, exchange_token: String(n),
  trading_symbol: `NIFTY ${strike} ${type} ${expiry}`, tick_size: 5, lot_size: 75, instrument_type: type,
  freeze_quantity: 1800, underlying_key: NIFTY_KEY, underlying_type: 'INDEX', underlying_symbol: 'NIFTY',
  strike_price: strike, minimum_lot: 75, weekly: true, ...over,
});
const con = (expiry, strike, type, over) => toContract(raw(expiry, strike, type, over), NIFTY_KEY);

// All dates below are test fixtures built relative to a fixed "now", not app data.
const NOW = ist(2030, 3, 5, 11, 0); // Tuesday 11:00 IST
const D = (offsetDays) => { const t = new Date(Date.UTC(2030, 2, 5 + offsetDays)); return t.toISOString().slice(0, 10); };

test('contract model maps every Upstox field and derives weekly/monthly only from the flag', () => {
  const c = toContract(raw('2030-03-07', 24500, 'CE', { tick_size: 0.05, lot_size: 75 }), NIFTY_KEY);
  assert.deepEqual(
    { ...c, instrumentKey: undefined },
    { instrumentKey: undefined, tradingSymbol: 'NIFTY 24500 CE 2030-03-07', expiry: '2030-03-07', strike: 24500, type: 'CE', lotSize: 75, tickSize: 0.05, weekly: true, kind: 'WEEKLY' },
  );
  assert.match(c.instrumentKey, /^NSE_FO\|/);
  assert.equal(toContract(raw('2030-03-28', 24500, 'PE', { weekly: false }), NIFTY_KEY).kind, 'MONTHLY');
  const unknown = toContract(raw('2030-03-28', 24500, 'PE', { weekly: undefined }), NIFTY_KEY);
  assert.equal(unknown.weekly, null); assert.equal(unknown.kind, null);
});

test('rows that are not usable contracts are dropped, never repaired or invented', () => {
  const bad = [
    null, 'x', {}, raw('2030-03-07', 24500, 'XX'), raw('2030-03-07', 0, 'CE'), raw('2030-03-07', 24500, 'CE', { lot_size: 0 }),
    raw('2030-03-07', 24500, 'CE', { tick_size: null }), raw('2030-02-31', 24500, 'CE'), raw('07-03-2030', 24500, 'CE'),
    raw('2030-03-07', 24500, 'CE', { instrument_key: '' }), raw('2030-03-07', 24500, 'CE', { underlying_key: 'NSE_INDEX|Nifty Next 50' }),
  ];
  const good = raw('2030-03-07', 24500, 'CE');
  const r = parseContracts([...bad, good, { ...good }], NIFTY_KEY); // duplicate instrument_key counted once
  assert.equal(r.contracts.length, 1);
  assert.equal(r.rejected, bad.length);
  assert.deepEqual(parseContracts(undefined, NIFTY_KEY), { contracts: [], rejected: 0 });
  assert.deepEqual(parseContracts({ not: 'an array' }, NIFTY_KEY), { contracts: [], rejected: 0 });
});

test('expiry sorting: chronological, distinct, independent of input order', () => {
  const rows = [D(30), D(2), D(9), D(2), D(16), D(9)].map((e, i) => raw(e, 24000 + i * 50, i % 2 ? 'PE' : 'CE'));
  const { contracts } = parseContracts(rows, NIFTY_KEY);
  assert.deepEqual(validExpiries(contracts, NOW), [D(2), D(9), D(16), D(30)]);
  assert.deepEqual(validExpiries([...contracts].reverse(), NOW), [D(2), D(9), D(16), D(30)]);
  // string order must equal date order across a month/year boundary
  const x = ['2031-01-02', '2030-12-26', '2030-03-07', '2030-11-28'].map((e) => con(e, 24000, 'CE'));
  assert.deepEqual(validExpiries(x, NOW), ['2030-03-07', '2030-11-28', '2030-12-26', '2031-01-02']);
});

test('expired expiries are removed; the expiry day itself is valid until 15:30 IST', () => {
  const cs = [D(-7), D(-1), D(0), D(7)].map((e) => con(e, 24000, 'CE'));
  assert.deepEqual(validExpiries(cs, NOW), [D(0), D(7)]);           // 11:00 on D(0): still trading
  assert.equal(EXPIRY_CUTOFF_MIN, 15 * 60 + 30);
  assert.equal(isExpired(D(0), ist(2030, 3, 5, 15, 29, 59)), false);
  assert.equal(isExpired(D(0), ist(2030, 3, 5, 15, 30, 0)), true);
  assert.deepEqual(validExpiries(cs, ist(2030, 3, 5, 15, 30)), [D(7)]);
  assert.deepEqual(validExpiries(cs, ist(2030, 3, 5, 23, 59)), [D(7)]);
  assert.equal(isExpired('garbage', NOW), true);
  assert.equal(isExpired(null, NOW), true);
  assert.deepEqual(validExpiries([con(D(-3), 24000, 'CE')], NOW), []); // everything expired -> nothing, not a made-up date
  assert.deepEqual(validExpiries(undefined, NOW), []);
});

test('nearest valid future expiry is the default; expiry rolls to the next one after expiry', () => {
  const list = [D(16), D(-4), D(2), D(9)];
  assert.equal(nearestExpiry(list, NOW), D(2));
  assert.equal(nearestExpiry([D(-4), D(-1)], NOW), null);
  assert.equal(nearestExpiry([], NOW), null);
  // default when nothing is selected, or the saved selection has expired / is no longer listed
  assert.equal(pickExpiry(null, list, NOW), D(2));
  assert.equal(pickExpiry(D(-4), list, NOW), D(2));
  assert.equal(pickExpiry('2099-01-01', list, NOW), D(2));
  // a valid user choice is kept
  assert.equal(pickExpiry(D(9), list, NOW), D(9));
  // expiry day, before and after the 15:30 IST cutoff
  const before = ist(2030, 3, 7, 10, 0), after = ist(2030, 3, 7, 15, 30);
  assert.equal(pickExpiry(D(2), list, before), D(2));
  assert.equal(pickExpiry(D(2), list, after), D(9));
  // the morning after the next expiry (D(9)) has passed
  assert.equal(pickExpiry(D(9), list, ist(2030, 3, 15, 9, 15)), D(16));
  assert.equal(pickExpiry(D(16), [D(16)], ist(2030, 3, 22, 9, 15)), null);
});

test('expiry display is DD-MMM-YYYY with days remaining', () => {
  assert.deepEqual(describeExpiry('2030-03-07', NOW), { expiry: '2030-03-07', date: '07-MAR-2030', days: 2, text: '07-MAR-2030  \u00b7  2 days remaining' });
  assert.equal(describeExpiry('2030-03-06', NOW).text, '06-MAR-2030  \u00b7  1 day remaining');
  assert.equal(describeExpiry('2030-03-05', NOW).text, '05-MAR-2030  \u00b7  expires TODAY');
  assert.equal(describeExpiry('2030-12-26', NOW).date, '26-DEC-2030');
  assert.equal(describeExpiry('not-a-date', NOW), null);
});

test('weekly / monthly label per expiry only when all its contracts agree', () => {
  const cs = [con('2030-03-07', 24000, 'CE'), con('2030-03-07', 24000, 'PE'), con('2030-03-28', 24000, 'CE', { weekly: false }), con('2030-04-04', 24000, 'CE', { weekly: undefined }), con('2030-04-11', 24000, 'CE'), con('2030-04-11', 24050, 'CE', { weekly: false })];
  assert.equal(expiryKind(cs, '2030-03-07'), 'WEEKLY');
  assert.equal(expiryKind(cs, '2030-03-28'), 'MONTHLY');
  assert.equal(expiryKind(cs, '2030-04-04'), null); // Upstox did not say
  assert.equal(expiryKind(cs, '2030-04-11'), null); // conflicting flags: not guessed
  assert.equal(expiryKind(cs, '2031-01-01'), null);
});

test('CE/PE pairing: same expiry AND same strike', () => {
  const ce1 = con('2030-03-07', 24500, 'CE'), pe1 = con('2030-03-07', 24500, 'PE');
  const ce2 = con('2030-03-14', 24500, 'CE'), pe2 = con('2030-03-14', 24500, 'PE');
  const ce3 = con('2030-03-07', 24550, 'CE'), pe3 = con('2030-03-07', 24550, 'PE');
  const pairs = pairContracts([pe2, ce3, pe1, ce2, pe3, ce1]);
  assert.equal(pairs.length, 3);
  assert.deepEqual(pairs.map((p) => [p.expiry, p.strike]), [['2030-03-07', 24500], ['2030-03-07', 24550], ['2030-03-14', 24500]]);
  assert.ok(pairs.every((p) => p.complete));
  const p = pairs[0];
  assert.equal(p.ce, ce1); assert.equal(p.pe, pe1);
  assert.equal(p.ce.expiry, p.pe.expiry); assert.equal(p.ce.strike, p.pe.strike);
  assert.equal(pairs[2].ce, ce2); assert.equal(pairs[2].pe, pe2); // same strike, other expiry: never crossed
  assert.notEqual(pairs[0].ce.instrumentKey, pairs[2].ce.instrumentKey);
});

test('CE/PE pairing never fabricates a missing leg', () => {
  const ce = con('2030-03-07', 24500, 'CE'), peOther = con('2030-03-14', 24500, 'PE'), pe = con('2030-03-07', 24600, 'PE');
  const pairs = pairContracts([ce, peOther, pe]);
  assert.equal(pairs.length, 3);
  assert.ok(pairs.every((p) => !p.complete && (p.ce === null) !== (p.pe === null)));
  assert.deepEqual(pairsForExpiry([ce, peOther, pe], '2030-03-07'), []);                 // complete-only by default
  assert.equal(pairsForExpiry([ce, peOther, pe], '2030-03-07', true).length, 2);
  assert.deepEqual(pairContracts([]), []);
  assert.deepEqual(pairContracts(undefined), []);
  const full = [ce, con('2030-03-07', 24500, 'PE'), pe];
  assert.deepEqual(pairsForExpiry(full, '2030-03-07').map((p) => p.strike), [24500]);
});

test('fetchContracts calls the Upstox option-contract endpoint and returns only what Upstox sent', async () => {
  const SECRET = 'TOKEN-XYZ';
  const calls = [];
  const body = { status: 'success', data: [raw('2030-03-07', 24500, 'CE'), raw('2030-03-07', 24500, 'PE'), raw('2030-03-07', 24500, 'ZZ')] };
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return { status: 200, ok: true, json: async () => body }; };
  const r = await fetchContracts(SECRET);
  assert.equal(calls[0].url, 'https://api.upstox.com/v2/option/contract?instrument_key=NSE_INDEX%7CNifty%2050');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer ' + SECRET);
  assert.ok(!calls[0].url.includes(SECRET));
  assert.equal(r.contracts.length, 2); assert.equal(r.rejected, 1);
  body.data = [];
  assert.deepEqual((await fetchContracts(SECRET)).contracts, []); // empty stays empty
});

test('no hardcoded expiry dates anywhere in the app source', () => {
  const walk = (dir) => readdirSync(new URL(dir, import.meta.url), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}${e.name}/`) : [`${dir}${e.name}`]));
  const files = walk('../src/').filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 10);
  for (const f of files) {
    const t = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.ok(!/\b(19|20)\d{2}-\d{2}-\d{2}\b/.test(t), `hardcoded date in ${f}`);
    assert.ok(!/\b\d{1,2}[ -](JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[ -](20)?\d{2}\b/i.test(t.replace(/e\.g\. [^\n]*/g, '')), `hardcoded date in ${f}`);
  }
});
