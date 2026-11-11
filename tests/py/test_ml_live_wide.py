"""
Algo Live's wide model (scripts/ml_live_wide.py) on the small made-up world of test_ml_walkforward.py:
  * its pinned rules (turnover, the ₹10 lakh label, the market gate, the floor) equal iteration 16's code, which ran the same
    strategy as its reference;
  * the month's model it trains sets the very bar the Algo Lab walk-forward set for that month (same data, same seeds);
  * the export carries what the live engine needs (rules, the gate's history and hot days) and is valid JSON.
Run: python3 tests/py/test_ml_live_wide.py
"""
import json
import os
import sys
import tempfile

import numpy as np
import pandas as pd

here = os.path.dirname(os.path.abspath(__file__))
scripts = os.path.join(here, '..', '..', 'scripts')
sys.path.insert(0, here)
sys.path.insert(0, scripts)
argv, sys.argv = sys.argv, ['x', 'none']
import test_ml_walkforward as base  # noqa: E402  (its settings shrink the world)
sys.argv = argv
import ml_walkforward as ml  # noqa: E402
import ml_live_wide as lw  # noqa: E402  (imported before ml_wide.configure patches ml_walkforward)
import ml_wide  # noqa: E402

ml.ENSEMBLE = 1
d = tempfile.mkdtemp()
base.make(d, True, 5)
head = json.load(open(os.path.join(d, 'grid.json')))
raw = np.fromfile(os.path.join(d, 'grid.bin'), dtype=np.float32).reshape(-1, head['width'])
sym = raw[:, 0].astype(int)
inside = (sym % 2 == 0).astype(np.float32)
raw[:, head['cols'].index('priceRs')] = np.where(inside == 1, 300.0, 600.0)
np.column_stack([raw, inside]).astype(np.float32).tofile(os.path.join(d, 'grid.bin'))
head['cols'] = head['cols'] + ['inNarrow']
head['width'] += 1
json.dump(head, open(os.path.join(d, 'grid.json'), 'w'))

# the pinned rules equal iteration 16's
t = pd.DataFrame({'nbSx': [0.5, 0.5, 0.5], 'nbS': [0.6, 0.6, 0.6], 'nbS3': [0.7, 0.7, 0.7], 'avgVol': [1e6, 1e6, np.nan], 'priceRs': [200.0, 680.0, 300.0]})
assert np.allclose(lw.add_label(t.copy())['nbSx_t10'], ml_wide.add_stress(t.copy())['nbSx_t10'])
assert np.allclose(lw.turnover_rs(t.fillna(0)), ml_wide.turnover_rs(t.fillna(0)))
mk = pd.Series(np.r_[np.zeros(59), [5.0], np.zeros(40), [0.0, 5.0, -1.0], np.random.default_rng(3).normal(size=300)], index=[f'd{i:03d}' for i in range(403)])
assert (lw.hot_days(mk) == ml_wide.hot_days(mk)).all()
ref = ml_wide.fixed(100, gate=True)
assert ref['id'] == lw.STRATEGY and ref['minTurnover'] == lw.MIN_TURNOVER and ref['cap'] == lw.CAP and ref['S'] == lw.STRAT['S']
assert ref.get('yS') == lw.STRAT['yS'] == 'nbS' and ref['firstSlot'] == lw.STRAT['firstSlot'] == 20 and ref['lastSlot'] == lw.STRAT['lastSlot'] == 100
assert (ml_wide.GATE_DAYS, ml_wide.GATE_MIN, ml_wide.GATE_Q) == (lw.GATE_DAYS, lw.GATE_MIN, lw.GATE_Q) and ml_wide.REF_PRICE == lw.REF_PRICE

# the live model for the last month of the data, then the walk-forward on the same data
head, df = ml.load(d)
months = sorted(m for m in df['month'].unique() if m >= ml.DECIDE_FROM)
month = months[-1]
lw.main(d, month)
m = json.load(open(os.path.join(d, 'live-model.json')))
assert m['strategy'] == 'w10_f100_c3_g' and m['iteration'] == 15 and m['universe'] == 'wide' and m['month'] == month
r = m['rules']
assert r['cap'] == 3 and r['minTurnoverRs'] == 1e9 and r['refPrice'] == 340 and r['positionInr'] == 1_000_000 and r['firstSlot'] == 20 and r['lastSlot'] == 100
g = m['gate']
assert g['days'] == 250 and g['min'] == 60 and abs(g['q'] - 2 / 3) < 1e-12 and len(g['history']) == min(lw.GATE_KEEP, df['day'].nunique())
mkt = lw.market_move(df)
hot = lw.hot_days(mkt)
assert g['hot'] == [x for x in mkt.index[-lw.GATE_KEEP:] if hot[x]], 'the exported hot days are the ones the model learned with'
assert all(abs(v - mkt[dd]) < 1e-5 for dd, v in g['history'] if v is not None)
assert 'MARKET' not in m['features'] and not set(ml.MARKET) & set(m['features']), 'no Nifty facts (noMarket)'

ml_wide.UNIVERSES['wide'] = [ref]  # only the reference: this is about its bar, not the whole iteration
ml_wide.main(d, 'wide', 'main')
res = json.load(open(os.path.join(d, 'wide-wide-main.json')))
mon = next(x for x in next(s for s in res['strategies'] if s['id'] == lw.STRATEGY)['months'] if x['month'] == month)
print('live', m['threshold'], m['standAside'], '| walk-forward', mon.get('thr'), mon.get('note'))
if m['standAside']:
    assert mon.get('n', 0) == 0 and mon.get('note'), mon
else:
    assert mon.get('thr') is not None and abs(mon['thr'] - m['threshold']) < 1e-4, (mon.get('thr'), m['threshold'])  # the ledger keeps 4 decimals
    assert mon['valN'] == m['valTrades'] and abs(mon['valR'] - m['valR']) < 1e-3, (mon['valN'], mon['valR'], m['valTrades'], m['valR'])
assert g['hot'], 'the made-up world has hot days, so the gate was really applied'
print('OK')
