import test from 'node:test';
import assert from 'node:assert/strict';
import { stabilize, initialStab, STAB } from '../src/stabilize.js';
import { detectAlerts } from '../src/alerts.js';
import { optionKeys, overlayChain } from '../src/feed/optlive.js';

const mk = (signal, extra = {}) => ({ live: true, signal, confidence: 'HIGH', probabilities: { CALL: 80, PUT: 5, WAIT: 15 },
  ui: { signal, confidence: 'HIGH', blockers: [] }, recommended: null, notes: [], ...extra });

test('a fresh CALL is held back as WAIT until confirmMs, then shown with MEDIUM until highMs, then HIGH', () => {
  let st = initialStab(); const t0 = 1e9;
  let z = stabilize(st, mk('CALL'), t0); st = z.st;
  assert.equal(z.a.signal, 'WAIT'); assert.equal(z.a.pending, 'CALL'); assert.equal(z.a.recommended, null);
  z = stabilize(st, mk('CALL'), t0 + STAB.confirmMs - 1000); st = z.st; assert.equal(z.a.signal, 'WAIT');
  z = stabilize(st, mk('CALL'), t0 + STAB.confirmMs + 1000); st = z.st;
  assert.equal(z.a.signal, 'CALL'); assert.equal(z.a.confidence, 'MEDIUM'); assert.equal(z.a.ui.confidence, 'MEDIUM');
  z = stabilize(st, mk('CALL'), t0 + STAB.highMs + 1000);
  assert.equal(z.a.signal, 'CALL'); assert.equal(z.a.confidence, 'HIGH');
});

test('a flicker (CALL, WAIT, CALL) restarts the clock', () => {
  let st = initialStab(); const t0 = 5e9;
  st = stabilize(st, mk('CALL'), t0).st;
  st = stabilize(st, mk('WAIT'), t0 + 60000).st;
  const z = stabilize(st, mk('CALL'), t0 + 100000);
  assert.equal(z.a.signal, 'WAIT');
});

test('CALL straight to PUT restarts the clock (no instant reversal)', () => {
  let st = initialStab(); const t0 = 7e9;
  st = stabilize(st, mk('CALL'), t0).st;
  st = stabilize(st, mk('CALL'), t0 + 120000).st;
  const z = stabilize(st, mk('PUT'), t0 + 125000);
  assert.equal(z.a.signal, 'WAIT'); assert.equal(z.a.pending, 'PUT');
});

test('theta above 25% of premium caps confidence at MEDIUM and adds a note', () => {
  let st = initialStab(); const t0 = 9e9; const rec = { ltp: 109.8, theta: -40.2 };
  st = stabilize(st, mk('CALL', { recommended: rec }), t0).st;
  const z = stabilize(st, mk('CALL', { recommended: rec }), t0 + STAB.highMs + 1000);
  assert.equal(z.a.confidence, 'MEDIUM'); assert.match(z.a.notes[0], /Theta is 37%/);
});

test('fail-safe and non-live analyses pass through untouched', () => {
  const f = mk('WAIT', { ui: { failSafe: true } });
  assert.equal(stabilize(initialStab(), f, 1).a, f);
  const n = mk('CALL', { live: false });
  assert.equal(stabilize(initialStab(), n, 1).a, n);
});

test('wall break needs a buffer: a 1.6 pt poke does not alert, a 12 pt break does', () => {
  const lv = { majorR: { strike: 22600 }, majorS: { strike: 22400 } };
  const A = (spot) => ({ live: true, signal: 'WAIT', spot, levels: lv });
  assert.equal(detectAlerts(A(22598), A(22601.6)).some((e) => e.type === 'resistBreak'), false);
  assert.equal(detectAlerts(A(22598), A(22612)).some((e) => e.type === 'resistBreak'), true);
  assert.equal(detectAlerts(A(22402), A(22398.4)).some((e) => e.type === 'supportBreak'), false);
  assert.equal(detectAlerts(A(22402), A(22388)).some((e) => e.type === 'supportBreak'), true);
});

test('overlayChain marks ticked sides with liveAt / quoteAt (bid/ask are older than the price)', () => {
  const rows = [{ strike: 22600, call: { key: 'k1', ltp: 100, oi: 5, vol: 5, bid: 99.5, ask: 99.6 }, put: null }];
  const out = overlayChain(rows, { k1: { ltp: 109.8, oi: 6, vol: 7, receivedAt: 2000 } }, 1000);
  assert.equal(out[0].call.ltp, 109.8); assert.equal(out[0].call.liveAt, 2000); assert.equal(out[0].call.quoteAt, 1000);
  assert.equal(out[0].call.bid, 99.5);
});

import { tipFor, ALERT_TYPES } from '../src/alerts.js';
test('every alert type has a plain-language tip, and tips never tell you to place an order', () => {
  for (const t of ALERT_TYPES) { const x = tipFor(t.id, { tech: { priceVsVwap: 'ABOVE' }, oi: { bigMove: { side: 'PUT', pct: 20 } } }); assert.ok(x.length > 20, t.id); assert.doesNotMatch(x, /\b(buy now|sell now|place)\b/i); }
  assert.ok(tipFor('priceLevel')); assert.ok(tipFor('vixLevel'));
});
test('direction-specific tips follow the event', () => {
  assert.match(tipFor('oiChange', { oi: { bigMove: { side: 'PUT', pct: 20 } } }), /floor/);
  assert.match(tipFor('oiChange', { oi: { bigMove: { side: 'CALL', pct: 20 } } }), /ceiling/);
  assert.match(tipFor('oiChange', { oi: { bigMove: { side: 'CALL', pct: -20 } } }), /closed/);
  assert.match(tipFor('vwapCross', { tech: { priceVsVwap: 'BELOW' } }), /below/);
});
