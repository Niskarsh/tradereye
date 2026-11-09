import test from 'node:test';
import assert from 'node:assert/strict';
import { protectLevels, tradePlan } from '../lib/algoLive/levels';
import { roundTripCharges } from '../lib/setups/costs';

test('the moved stop pays charges and the usual slippage; 90% is measured toward the target', () => {
  const o = { price: 267.3, avgPrice: 267.26, target: 257.45, qty: 27 };
  const l = protectLevels(o, 1_000_000); // a thin stock: stops slip 0.20%
  assert.equal(l.at90, 258.4);
  assert.ok(l.moveStop < 267.26);
  const fill = l.moveStop + 0.002 * 267.26;
  assert.ok(27 * (267.26 - fill) - roundTripCharges(27, 267.26, fill, -1) >= 0, 'not red after charges');
});

test('a more liquid stock needs less room', () => {
  const o = { price: 300, target: 296, qty: 100 };
  assert.ok(protectLevels(o, 20_000_000).moveStop > protectLevels(o, 1_000_000).moveStop);
});

test('risk and reward before and after charges, both directions', () => {
  const short = tradePlan({ dir: -1, entry: 327.05, qty: 40, stop: 334.55, target: 318 });
  assert.equal(short.risk, 300);
  assert.equal(short.riskNet, Math.round((300 + roundTripCharges(40, 327.05, 334.55, -1)) * 100) / 100);
  assert.equal(short.reward, 362);
  assert.equal(short.rewardNet, Math.round((362 - roundTripCharges(40, 327.05, 318, -1)) * 100) / 100);
  assert.ok(short.riskNet! > short.risk! && short.rewardNet! < short.reward!);
  assert.equal(short.at90, 318.9);
  const long = tradePlan({ dir: 1, entry: 300, qty: 100, stop: 295, target: 310 });
  assert.deepEqual([long.risk, long.reward, long.rr], [500, 1000, 2]);
  assert.equal(long.at90, 309);
  assert.ok(long.moveStop > 300);
  const fill = long.moveStop - 0.002 * 300;
  assert.ok(100 * (fill - 300) - roundTripCharges(100, 300, fill, 1) >= 0, 'not red after charges');
});

test('for a short it gives the same no-loss stop as the Algo Live levels; missing or wrong-side prices give blanks', () => {
  const o = { price: 267.3, avgPrice: 267.26, target: 257.45, qty: 27 };
  assert.equal(tradePlan({ dir: -1, entry: 267.26, qty: 27, target: 257.45, avgVol: 1_000_000 }).moveStop, protectLevels(o, 1_000_000).moveStop);
  const none = tradePlan({ dir: -1, entry: 100, qty: 10 });
  assert.equal(none.risk, undefined); assert.equal(none.reward, undefined); assert.equal(none.at90, undefined);
  const wrong = tradePlan({ dir: -1, entry: 100, qty: 10, stop: 90, target: 110 });
  assert.equal(wrong.risk, undefined); assert.equal(wrong.reward, undefined);
});
