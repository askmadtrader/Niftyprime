import test from 'node:test';
import assert from 'node:assert/strict';
import { pickNiftyFuture, expiryEndMs, basis } from '../src/futures.js';

const row = (o) => ({ segment: 'NSE_FO', instrument_type: 'FUT', underlying_key: 'NSE_INDEX|Nifty 50', instrument_key: 'NSE_FO|1', trading_symbol: 'NIFTY FUT 27 OCT 26', expiry: '2026-10-27', lot_size: 75, ...o });
const now = Date.parse('2026-10-05T04:00:00Z');

test('picks the nearest unexpired NIFTY future', () => {
  const f = pickNiftyFuture([row({ instrument_key: 'NSE_FO|2', expiry: '2026-11-24' }), row({})], now);
  assert.equal(f.key, 'NSE_FO|1'); assert.equal(f.lotSize, 75);
});
test('ignores expired, wrong underlying, options and malformed rows', () => {
  const rows = [row({ expiry: '2026-10-04' }), row({ underlying_key: 'NSE_INDEX|Nifty Bank' }), row({ instrument_type: 'CE' }), row({ expiry: 'bad' }), row({ instrument_key: 'BSE_FO|9' }), null];
  assert.equal(pickNiftyFuture(rows, now), null);
});
test('a future is valid until 15:30 IST on its expiry day', () => {
  assert.equal(pickNiftyFuture([row({})], expiryEndMs('2026-10-27') - 1).key, 'NSE_FO|1');
  assert.equal(pickNiftyFuture([row({})], expiryEndMs('2026-10-27') + 1), null);
});
test('basis needs two valid prices', () => {
  assert.equal(basis(null, 100), null); assert.equal(basis(100, 0), null);
  const b = basis(22450, 22400); assert.equal(b.pts, 50); assert.ok(Math.abs(b.pct - 0.2232) < 1e-3);
});
