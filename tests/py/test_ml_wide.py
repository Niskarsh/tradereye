"""
Iteration 15 on a small made-up world (the world and the planted short edge of test_ml_walkforward.py):
  * the pipeline runs for both universes; 'narrow' sees only its own stock-days and ranks among them alone;
  * no strategy is called fCap2 (the pages that follow the live strategy look for that id);
  * ml_walkforward's own settings are what the normal Re-run and the Algo Live model use, in a fresh process.
Run: python3 tests/py/test_ml_wide.py
"""
import json
import os
import subprocess
import sys
import tempfile

import numpy as np

here = os.path.dirname(os.path.abspath(__file__))
scripts = os.path.join(here, '..', '..', 'scripts')
sys.path.insert(0, here)
sys.path.insert(0, scripts)
argv, sys.argv = sys.argv, ['x', 'none']
import test_ml_walkforward as base  # noqa: E402  (its settings shrink the world; 'none' skips its long runs)
sys.argv = argv
import ml_walkforward as ml  # noqa: E402
import ml_wide  # noqa: E402

ml.ENSEMBLE = 1  # this test is about the plumbing, not the size of the edge
d = tempfile.mkdtemp()
base.make(d, True, 3)
head = json.load(open(os.path.join(d, 'grid.json')))
raw = np.fromfile(os.path.join(d, 'grid.bin'), dtype=np.float32).reshape(-1, head['width'])
sym = raw[:, 0].astype(int)
inside = (sym % 2 == 0).astype(np.float32)  # every other stock is in ₹250-340
raw[:, head['cols'].index('priceRs')] = np.where(inside == 1, 300.0, 600.0)  # real prices (the made-up feature is noise)
np.column_stack([raw, inside]).astype(np.float32).tofile(os.path.join(d, 'grid.bin'))
head['cols'] = head['cols'] + ['inNarrow']
head['width'] += 1
json.dump(head, open(os.path.join(d, 'grid.json'), 'w'))

# priced at the target size: real fills + big-position charges (nbS3 - nbS) - impact 1.25 x sqrt(order / turnover)
import pandas as pd  # noqa: E402
t = ml_wide.add_stress(pd.DataFrame({'nbSx': [0.5, 0.5, 0.5], 'nbS': [0.6, 0.6, 0.6], 'nbS3': [0.7, 0.7, 0.7],
                                     'avgVol': [1e6, 1e6, np.nan], 'priceRs': [200.0, 680.0, 300.0]}))
# turnover: ₹200 x 1M = ₹20 cr; ₹680 with avgVol already scaled to ₹340: 1M x 340 = ₹34 cr; nan: the median (₹27 cr)
assert np.allclose(t['nbSx_t10'], [0.6 - 1.25 * np.sqrt(1e6 / 2e8), 0.6 - 1.25 * np.sqrt(1e6 / 3.4e8), 0.6 - 1.25 * np.sqrt(1e6 / 2.7e8)]), t['nbSx_t10'].tolist()
assert np.allclose(t['nbSx_t5'], [0.6 - 1.25 * np.sqrt(5e5 / 2e8), 0.6 - 1.25 * np.sqrt(5e5 / 3.4e8), 0.6 - 1.25 * np.sqrt(5e5 / 2.7e8)])
assert abs((0.6 - t['nbSx_t10'][0]) - 0.088) < 0.001, 'about 0.09R for ₹10 lakh in a ₹20 crore a day stock'
for k in (5, 8, 12, 15):
    assert np.allclose(t[f'nbSx_t{k}'][0], 0.6 - 1.25 * np.sqrt(k * 1e5 / 2e8)), k

# the cap check: each version's own cap (here 2), never more than 4
try:
    ml_wide.check_cap({'strategies': [{'id': 'w10_f100_c3_g', 'trades': [['2025-01-02', x] for x in 'ABCD']}]})
    raise AssertionError('4 trades a day passed a cap of 3')
except SystemExit as e:
    assert 'more than 3' in str(e)
ml_wide.check_cap({'strategies': [{'id': 'w10_f100_c4', 'trades': [['2025-01-02', x] for x in 'ABCD']}]})
assert ml_wide.cap_of('placebo') == 4 and ml_wide.cap_of('nF') == 2

# the market gate: top third of the last 250 days, only with 60 days of history, never using today in its own history
mk = pd.Series(np.r_[np.zeros(59), [5.0], np.zeros(40), [0.0, 5.0, -1.0]], index=[f'd{i:03d}' for i in range(103)])
hot = ml_wide.hot_days(mk)
assert not hot.iloc[59], 'only 59 days of history: gate off'
assert hot.iloc[101] and not hot.iloc[100] and not hot.iloc[102], hot.iloc[99:].tolist()

# a turnover floor shuts thin stocks out; the gate shuts hot days out, and only for the gated versions
ml_wide.configure('wide', 'main')
part = pd.DataFrame({'avgVol': [1e6, 1e7, 1e7], 'priceRs': [300.0, 300.0, 300.0], 'slot': [30, 30, 30], 'hot': [0, 0, 1]})
floor = next(s_ for s_ in ml_wide.WIDE if s_['id'] == 'w10_f100_c3')  # ₹100 cr: ₹30 cr out, ₹300 cr in
_, ps = ml.allowed(part, np.full(3, -np.inf), np.array([0.5, 0.5, 0.5]), floor)
assert ps[0] == -np.inf and ps[1] == 0.5 and ps[2] == 0.5, ps
gated = next(s_ for s_ in ml_wide.WIDE if s_['id'] == 'w10_f100_c3_g')
_, ps = ml.allowed(part, np.full(3, -np.inf), np.array([0.5, 0.5, 0.5]), gated)
assert ps[0] == -np.inf and ps[1] == 0.5 and ps[2] == -np.inf, ps
pl = next(s_ for s_ in ml_wide.WIDE if s_['id'] == 'placebo')
assert pl['S'] == 'nbSx_t10' and pl['cap'] == 4 and pl['minTurnover'] == 1e9, 'the placebo is priced and limited like the pick'

allowed_syms = {head['symbols'][i] for i in range(len(head['symbols'])) if i % 2 == 0}
want = {'narrow': ['nF', 'nT10'], 'wide': [s_['id'] for s_ in ml_wide.WIDE], 'ladder': [s_['id'] for s_ in ml_wide.LADDER_ST]}
assert len(want['wide']) == 6 + 6 + 1 and len(want['ladder']) == 4 * 6
assert all('fCap2' != x for v in want.values() for x in v)
for universe in ('narrow', 'wide', 'ladder'):
    ml_wide.main(d, universe, 'main')
    res = json.load(open(os.path.join(d, f'wide-{universe}-main.json')))
    assert res['iteration'] == 15 and [s['id'] for s in res['strategies']] == want[universe]
    assert res['setup']['maxPerDay'] == 4
    for s in res['strategies']:
        assert set(s['regime']) >= {'low', 'mid', 'high', 'cuts', 'examHotShare'} and s['badDays']['days'] >= s['badDays']['le2'] >= s['badDays']['le3'], s['id']
        assert sum(s['regime'][k]['n'] for k in ('low', 'mid', 'high')) <= s['dev']['n'], s['id']
        per = {}
        for tr in s['trades']:
            per[tr[0]] = per.get(tr[0], 0) + 1
        assert max(per.values(), default=0) <= ml_wide.cap_of(s['id']), s['id']
        if universe == 'narrow':
            assert {tr[1] for tr in s['trades']} <= allowed_syms, s['id']
    if universe == 'narrow':
        assert res['stocks'] == len(allowed_syms), (res['stocks'], len(allowed_syms))
    else:
        assert set(res['pools']) == {str(f) for f in ml_wide.FLOORS_CR} and res['pools']['50'] >= res['pools']['170'], res['pools']
    print(universe, [(s['id'], s['dev']['n'], s['dev']['netR']) for s in res['strategies']][:8], res.get('pools'))
dev = {s['id']: s['dev'] for s in json.load(open(os.path.join(d, 'wide-wide-main.json')))['strategies']}
assert dev['w10_f50_c4']['n'] >= dev['w10_f50_c3']['n'], 'a higher cap never takes fewer trades'
assert dev['w10_f100_c4']['n'] >= dev['w10_f100_c4_g']['n'], 'the gate only takes trades away'
ml_wide.main(d, 'wide', 'seed2')
assert 'placebo' not in [s['id'] for s in json.load(open(os.path.join(d, 'wide-wide-seed2.json')))['strategies']]

# a fresh process that imports only ml_walkforward has what the normal run has
out = subprocess.check_output([sys.executable, '-c', "import ml_walkforward as m; print(m.ITERATION, 'fCap2' in [s['id'] for s in m.STRATEGIES])"], cwd=scripts, text=True).strip()
assert out == '11 True', out
print('OK')
