import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLevelAlerts } from '../src/levelAlerts.js';

const L = (o) => ({ priceAbove: null, priceBelow: null, vixAbove: null, vixBelow: null, ...o });
test('fires on upward price cross', () => {
  const r = detectLevelAlerts({ price: 24990, vix: 14 }, { price: 25010, vix: 14 }, L({ priceAbove: 25000 }));
  assert.equal(r.length, 1); assert.equal(r[0].id, 'priceAbove'); assert.equal(r[0].type, 'priceLevel');
});
test('fires on downward vix cross', () => {
  const r = detectLevelAlerts({ price: 1, vix: 15.2 }, { price: 1, vix: 14.9 }, L({ vixBelow: 15 }));
  assert.equal(r[0].type, 'vixLevel');
});
test('no fire without a cross, or when already beyond the level', () => {
  assert.equal(detectLevelAlerts({ price: 25010 }, { price: 25020 }, L({ priceAbove: 25000 })).length, 0);
});
test('stale/missing readings never fire', () => {
  assert.equal(detectLevelAlerts({ price: null }, { price: 25010 }, L({ priceAbove: 25000 })).length, 0);
  assert.equal(detectLevelAlerts({ price: 24990 }, { price: null }, L({ priceAbove: 25000 })).length, 0);
  assert.equal(detectLevelAlerts(null, { price: 1 }, L()).length, 0);
});
test('disarmed rules ignored', () => {
  assert.equal(detectLevelAlerts({ price: 24990 }, { price: 25010 }, L()).length, 0);
});
