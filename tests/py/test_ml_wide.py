"""
Iteration 13 on a small made-up world (the world and the planted short edge of test_ml_walkforward.py):
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
np.column_stack([raw, inside]).astype(np.float32).tofile(os.path.join(d, 'grid.bin'))
head['cols'] = head['cols'] + ['inNarrow']
head['width'] += 1
json.dump(head, open(os.path.join(d, 'grid.json'), 'w'))

# the stress columns: an extra % of the price, in R of a stop at half the usual daily range
import pandas as pd  # noqa: E402
t = ml_wide.add_stress(pd.DataFrame({'nbSx': [0.5, 0.5, 0.5], 'adrPct': [4.0, 2.0, np.nan], 'avgVol': [1e6, 5e6, 5e6]}))
assert np.allclose(t['nbSx_s1'], [0.5 - 0.1 / 2, 0.5 - 0.1 / 1, 0.5 - 0.1 / 1.5]), t['nbSx_s1'].tolist()  # nan range: the median stop
assert np.allclose(t['nbSx_s2'], [0.5 - 0.2 / 2, 0.5 - 0.2 / 1, 0.5 - 0.2 / 1.5])
assert np.allclose(t['nbSx_thin'], [0.5 - 0.2 / 2, 0.5, 0.5]), 'only stocks under ₹100 crore a day'

# the 2-a-day check fails the job
try:
    ml_wide.check_cap({'strategies': [{'id': 'x', 'trades': [['2025-01-02', 'A'], ['2025-01-02', 'B'], ['2025-01-02', 'C']]}]})
    raise AssertionError('3 trades a day passed the check')
except SystemExit as e:
    assert 'more than 2' in str(e)

allowed_syms = {head['symbols'][i] for i in range(len(head['symbols'])) if i % 2 == 0}
for universe, ids in (('narrow', ['nF']), ('wide', ['wAll', 'wS1', 'wS2', 'wThin', 'placebo'])):
    ml_wide.main(d, universe, 'main')
    res = json.load(open(os.path.join(d, f'wide-{universe}-main.json')))
    assert res['iteration'] == 13 and [s['id'] for s in res['strategies']] == ids, [s['id'] for s in res['strategies']]
    assert res['setup']['maxPerDay'] == 2 and res['setup']['maxPerSide'] == 2
    for s in res['strategies']:
        per = {}
        for tr in s['trades']:
            per[tr[0]] = per.get(tr[0], 0) + 1
        assert max(per.values(), default=0) <= 2, s['id']
        if universe == 'narrow':
            assert {tr[1] for tr in s['trades']} <= allowed_syms, s['id']
    if universe == 'narrow':
        assert res['stocks'] == len(allowed_syms), (res['stocks'], len(allowed_syms))
    print(universe, [(s['id'], s['dev']['n'], s['dev']['netR']) for s in res['strategies']])
dev = {s['id']: s['dev'] for s in res['strategies']}
assert dev['wS2']['netR'] <= dev['wAll']['netR'] + 1e-9 or dev['wS2']['n'] < dev['wAll']['n'], 'worse fills cannot make it better on the same trades'
ml_wide.main(d, 'wide', 'seed2')
assert 'placebo' not in [s['id'] for s in json.load(open(os.path.join(d, 'wide-wide-seed2.json')))['strategies']]

# a fresh process that imports only ml_walkforward has what the normal run has
out = subprocess.check_output([sys.executable, '-c', "import ml_walkforward as m; print(m.ITERATION, 'fCap2' in [s['id'] for s in m.STRATEGIES])"], cwd=scripts, text=True).strip()
assert out == '11 True', out
print('OK')
