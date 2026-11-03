import test from 'node:test';
import assert from 'node:assert/strict';
import { protectLevels } from '../lib/algoLive/levels';
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
