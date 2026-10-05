import test from 'node:test';
import assert from 'node:assert/strict';
import { optionKeys, readOptionTicks, overlayChain } from '../src/feed/optlive.js';

const side = (key, ltp, oi, vol) => ({ key, ltp, oi, vol, iv: 12 });
const rows = [22350, 22400, 22450].map((s, i) => ({ strike: s, call: side('C' + s, 100 + i, 1000, 10), put: side('P' + s, 90 + i, 2000, 20) }));

test('optionKeys: ATM +/- n, CE and PE', () => {
  assert.deepEqual(optionKeys(rows, 22410, 0), ['C22400', 'P22400']);
  assert.equal(optionKeys(rows, 22410, 5).length, 6);
  assert.deepEqual(optionKeys(rows, null, 1), []);
});
test('ticks: only subscribed keys with a valid price are kept', () => {
  const ks = new Set(['C22400']);
  const m = readOptionTicks({}, { feeds: { C22400: { ltpc: { ltp: 105.5, ltt: 5 }, oi: 1200, vtt: 50 }, X: { ltpc: { ltp: 9 } } } }, 1000, ks);
  assert.deepEqual(Object.keys(m), ['C22400']); assert.equal(m.C22400.oi, 1200);
  assert.equal(readOptionTicks(m, { feeds: { C22400: { ltpc: { ltp: 0 } } } }, 2000, ks), m);
});
test('overlay: newer tick wins; older than chain snapshot ignored; unchanged rows keep identity', () => {
  const t = { C22400: { ltp: 111, oi: 1500, vol: 99, receivedAt: 2000 }, P22450: { ltp: 5, oi: 1, vol: 1, receivedAt: 500 } };
  const out = overlayChain(rows, t, 1000);
  assert.equal(out[1].call.ltp, 111); assert.equal(out[1].call.oi, 1500); assert.equal(out[1].call.iv, 12);
  assert.equal(out[2], rows[2]); assert.equal(out[0], rows[0]);
  assert.equal(overlayChain(rows, {}, 1000), rows);
});
