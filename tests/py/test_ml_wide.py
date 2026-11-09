"""
Iteration 12 on a small made-up world (the world and the planted short edge of test_ml_walkforward.py):
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

# the narrowOnly filter
ml_wide.configure('wide', 'main')
import pandas as pd  # noqa: E402
part = pd.DataFrame({'inNarrow': [1, 0, 1], 'slot': [30, 30, 30], 'avgVol': [1e7, 1e7, 1e7]})
st = next(s for s in ml_wide.WIDE if s['id'] == 'wIn340')
_, ps = ml.allowed(part, np.full(3, -np.inf), np.array([0.5, 0.5, 0.5]), st)
assert ps[1] == -np.inf and ps[0] == 0.5 and ps[2] == 0.5, ps

for universe, ids in (('narrow', ['nF']), ('wide', ['wAll', 'w3m', 'w5m', 'w7m', 'w10m', 'wIn340', 'placebo'])):
    ml_wide.main(d, universe, 'main')
    res = json.load(open(os.path.join(d, f'wide-{universe}-main.json')))
    assert res['iteration'] == 12 and [s['id'] for s in res['strategies']] == ids, [s['id'] for s in res['strategies']]
    allowed_syms = {head['symbols'][i] for i in range(len(head['symbols'])) if i % 2 == 0}
    for s in res['strategies']:
        if universe == 'narrow' or s['id'] == 'wIn340':
            assert {t[1] for t in s['trades']} <= allowed_syms, s['id']
    print(universe, [(s['id'], s['dev']['n'], s['dev']['netR']) for s in res['strategies']])
ml_wide.main(d, 'wide', 'seed2')
assert 'placebo' not in [s['id'] for s in json.load(open(os.path.join(d, 'wide-wide-seed2.json')))['strategies']]

# a fresh process that imports only ml_walkforward has what the normal run has
out = subprocess.check_output([sys.executable, '-c', "import ml_walkforward as m; print(m.ITERATION, 'fCap2' in [s['id'] for s in m.STRATEGIES])"], cwd=scripts, text=True).strip()
assert out == '11 True', out
print('OK')
