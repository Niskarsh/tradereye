"""
Iteration 17 on a small made-up world (test_ml_walkforward.py's world, with the iteration 17 columns and F's paths):
  * a short edge planted only in a chart-structure fact (sweep): C finds it, A cannot, the random-lines twin does not;
  * a planted early-exit lesson (a trade whose first candle closes 0.5R+ against it ends at the full stop, while closing
    at that candle costs only 0.4R): B learns it from earlier months only and it passes the four lesson checks;
  * the results-day skip keeps D off flagged days; break-even versions use their own path results;
  * the rule and the result file have the shape the page reads; ml_walkforward's own settings stay untouched.
Run: python3 tests/py/test_ml_iter17.py [unit | all]   (all = also the end-to-end run on the small world, ~20 min)
"""
import json
import os
import sys
import tempfile

import numpy as np

here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
sys.path.insert(0, os.path.join(here, '..', '..', 'scripts'))
argv, sys.argv = sys.argv, ['x', 'none']
import test_ml_walkforward as base  # noqa: E402  (its module-level checks run with 'none': only the picker check)
sys.argv = argv
import ml_walkforward as ml  # noqa: E402
import ml_iter17 as i17  # noqa: E402
import ml_iter17_layers as lay  # noqa: E402

COLS17 = i17.STRUCT + i17.PLACEBO + i17.SECTOR + ['resDay']
PATH = ['row', 'net0', 'net80', 'net90']
for j in (1, 2, 3):
    PATH += [f'o{j}_0', f'o{j}_80', f'o{j}_90', f'x{j}', f'mae{j}', f'mfe{j}', f'cl{j}', f'vol{j}', f'nif{j}', f'rng{j}']
PATH += ['kind', 'mins', 'mfeFrac', 'shock']


def make(d, seed=3):
    base.make(d, False, seed)
    head = json.load(open(os.path.join(d, 'grid.json')))
    w = head['width']
    raw = np.fromfile(os.path.join(d, 'grid.bin'), dtype=np.float32).reshape(-1, w)
    n = len(raw)
    rng = np.random.default_rng(seed)
    cols = head['cols']
    ex = rng.normal(size=(n, len(COLS17))).astype(np.float32)
    sweep = (rng.uniform(size=n) < 0.15).astype(np.float32)
    ex[:, COLS17.index('sweep')] = sweep
    ex[:, COLS17.index('p_sweep')] = (rng.uniform(size=n) < 0.15).astype(np.float32)
    res = (rng.uniform(size=n) < 0.05).astype(np.float32)
    ex[:, COLS17.index('resDay')] = res
    # the planted edge: shorts win far more after a sweep (every short label); on a results day they lose
    u = rng.uniform(size=n)
    win = np.where(sweep == 1, 0.78, 0.5)
    win = np.where(res == 1, 0.2, win)
    g = np.where(u < win, 1.0, -1.0).astype(np.float32)
    for lab, cost in (('nbS', 0.07), ('nbSx', 0.1)):
        raw[:, cols.index(lab)] = g - cost
    raw[:, cols.index('nbSg')] = g
    raw[:, cols.index('nbS1')] = g - 0.035
    raw[:, cols.index('nbS3')] = g - 0.02
    raw[:, cols.index('avgVol')] = np.maximum(raw[:, cols.index('avgVol')], 5e6)
    raw[:, cols.index('priceRs')] = 300
    full = np.concatenate([raw, ex], axis=1)
    full.tofile(os.path.join(d, 'grid.bin'))
    head['cols'] = cols + COLS17
    head['width'] = w + len(COLS17)
    json.dump(head, open(os.path.join(d, 'grid.json'), 'w'))
    # F's paths: net0 = nbSx; a trade whose first candle closes 0.5R+ against it is a loser that could have left at -0.4R
    slot = raw[:, cols.index('slot')]
    f = np.flatnonzero((slot >= 20) & (slot <= 100))
    m = len(f)
    net0 = full[f, cols.index('nbSx')].astype(float)
    cl1 = rng.normal(0, 0.4, m)
    bad = cl1 < -0.5
    net0 = np.where(bad, -1.15, net0)
    full[f, cols.index('nbSx')] = net0
    full.tofile(os.path.join(d, 'grid.bin'))
    P = {c: np.zeros(m) for c in PATH}
    P['row'] = f
    P['net0'] = net0
    P['net80'] = np.where(net0 > 0.5, net0, np.where(rng.uniform(size=m) < 0.2, 0.0, net0))
    P['net90'] = np.where(net0 > 0.5, net0, np.where(rng.uniform(size=m) < 0.1, 0.0, net0))
    for j in (1, 2, 3):
        for v in ('0', '80', '90'):
            P[f'o{j}_{v}'] = np.ones(m)
        P[f'x{j}'] = np.where(bad, -0.4, net0 - 0.05) if j == 1 else net0 - 0.05
        P[f'cl{j}'] = cl1 if j == 1 else rng.normal(size=m)
        for p in ('mae', 'mfe', 'vol', 'nif', 'rng'):
            P[f'{p}{j}'] = rng.normal(size=m)
    P['kind'] = np.where(net0 > 0, 1, -1)
    P['mins'] = rng.integers(10, 300, m)
    P['mfeFrac'] = rng.uniform(0, 1, m)
    P['shock'] = (rng.uniform(size=m) < 0.02).astype(float)
    np.column_stack([P[c] for c in PATH]).astype(np.float32).tofile(os.path.join(d, 'paths.bin'))
    json.dump({'v': 1, 'cols': PATH, 'width': len(PATH), 'rows': m}, open(os.path.join(d, 'paths.json'), 'w'))
    json.dump({'sectors': {'ok': True}, 'results': {'ok': True}}, open(os.path.join(d, 'i17-data.json'), 'w'))


def b_unit():
    """B on made-up trades: 40 stocks, 30 months; a first candle closing 0.5R+ against the trade means a full loss that
    could have been closed at -0.4R. B must learn it from earlier months only, and the lesson must pass its checks."""
    import pandas as pd
    rng = np.random.default_rng(7)
    rows = []
    months = [f'{2023 + (i // 12)}-{i % 12 + 1:02d}' for i in range(30)]
    for mi_, m in enumerate(months):
        for k in range(60):
            day = f'{m}-{1 + k % 28:02d}'
            rows.append((day, f'S{rng.integers(40)}', 20 + 10 * int(rng.integers(9)), m))
    t = pd.DataFrame(rows, columns=['day', 'symbol', 'slot', 'month'])
    n = len(t)
    t['pred'] = rng.normal(0.1, 0.05, n)
    cl1 = rng.normal(0, 0.4, n)
    net = np.where(rng.uniform(size=n) < 0.55, 0.9, -1.1)
    net = np.where(cl1 < -0.5, -1.15, net)
    for v in ('0', '80', '90'):
        t[f'net{v}'] = net
        for j in (1, 2, 3):
            t[f'o{j}_{v}'] = 1
    for j in (1, 2, 3):
        t[f'x{j}'] = np.where(cl1 < -0.5, -0.4, net - 0.05) if j == 1 else net - 0.05
        t[f'cl{j}'] = cl1 if j == 1 else rng.normal(size=n)
        for p in ('mae', 'mfe', 'vol', 'nif', 'rng'):
            t[f'{p}{j}'] = rng.normal(size=n)
    t['loss'] = np.where(net >= 0, 'win', 'stopped')
    bt, act, final = lay.run_b(t, [], '0', 17, months)
    kept = bt[bt['bkeep']]
    print('B unit', {k: v['pass'] for k, v in final.items()}, 'base', round(net.mean(), 3), 'B', round(kept['bnet'].mean(), 3))
    assert act[0]['active'] == [] and act[1]['active'] == [], 'no lesson acts before it has a record'
    assert final['exit1']['pass'], final['exit1']
    assert kept['bnet'].mean() > net.mean() + 0.03, 'B learns the planted exit'
    late = bt[(bt['month'] >= months[15]) & bt['bkeep']]
    assert late['bnet'].mean() - late['net0'].mean() > 0.05, 'and once it has a record it keeps most of the gain'
    # a lesson planted in one stock only must fail the spread check
    one = lay.check_lesson(np.where(t['symbol'] == 'S1', 0.3, 0.0), t['symbol'].values, t['month'].values)
    assert not one['pass'] and one['stocks'] == 1


b_unit()
print('OK: learning from losses')
if (sys.argv[1] if len(sys.argv) > 1 else 'unit') != 'all':
    sys.exit(0)


def settings():
    return {k: getattr(ml, k) for k in ('ITERATION', 'STRATEGIES', 'LOCKED', 'UNTOUCHED', 'VOL_ORDER', 'SHARD', 'SEED_OFF')}


before = settings()
load0, allowed0 = ml.load, ml.allowed
d = os.environ.get('I17_DIR')  # a folder from an earlier run: skip the model runs (re-checks the layers only)
if not d:
    d = tempfile.mkdtemp()
    make(d)
    for arm in ('A', 'C', 'D', 'CD', 'Cp'):
        i17.main(d, arm, 'main')
        ml.load, ml.allowed = load0, allowed0
    for arm in ('A',):
        for sh in ('seed2',):
            i17.main(d, arm, sh)
            ml.load, ml.allowed = load0, allowed0
    for k, v in before.items():
        setattr(ml, k, v)
print('folder', d)

a = json.load(open(os.path.join(d, 'i17-A-main.json')))
c = json.load(open(os.path.join(d, 'i17-C-main.json')))
dd = json.load(open(os.path.join(d, 'i17-D-main.json')))
ids = [s['id'] for s in a['strategies']]
assert ids == ['A', 'A_old', 'placebo'] and a['iteration'] == 17, ids
A, C = a['strategies'][0], c['strategies'][0]
print('A', A['dev'], '\nC', C['dev'])
assert C['dev']['netR'] > A['dev']['netR'] + 0.05, 'C finds the edge planted in the sweep fact'
assert any(x['f'] == 'sweep' for x in C['importance'][:5]), [x['f'] for x in C['importance'][:5]]
assert not any(x['f'] == 'sweep' for x in A['importance']), 'A never sees the structure facts'
assert all(t[2] <= '10:55' and t[2] >= '09:35' and t[3] == -1 for t in A['trades'])

# D never trades a flagged results day
head = json.load(open(os.path.join(d, 'grid.json')))
raw = np.fromfile(os.path.join(d, 'grid.bin'), dtype=np.float32).reshape(-1, head['width'])
key = {(head['dates'][int(r[1])], head['symbols'][int(r[0])], int(r[2])): r[head['cols'].index('resDay')] for r in raw[(raw[:, 2] >= 20) & (raw[:, 2] <= 100)]}
D = dd['strategies'][0]
flagged = sum(1 for t in A['trades'] if key[(t[0], t[1], lay.slot_of(t[2]))] == 1)
du = next(u for u in dd['untouched'] if u['id'] == 'D')
print('D', D['dev']['n'], 'trades; A took', flagged, 'on results days')
assert D['overall']['n'] + len(du['trades']) > 50, 'D trades'
assert all(key[(t[0], t[1], lay.slot_of(t[2]))] != 1 for t in D['trades'] + du['trades']), 'D skips results days'

lay.main(d)
r = json.load(open(os.path.join(d, 'i17.json')))
ids = [s['id'] for s in r['strategies']]
for v in ('A', 'B', 'C', 'D', 'BC', 'BD', 'CD', 'BCD'):
    for suf in ('', '_be80', '_be90'):
        assert v + suf in ids, v + suf
assert {'Cp', 'A_old', 'placebo'} <= set(ids)
by = {s['id']: s for s in r['strategies']}
it = r['iter17']
rows_ = {x['id']: x for x in it['table']}
print('B', rows_['B']['dev'], 'A', rows_['A']['dev'])
assert set(it['lessons']['B']['final']) == set(lay.LESSONS) and it['lessons']['B']['active'][0]['active'] == []
assert rows_['B']['untouched'] is not None and 'lessons' in rows_['B']['untouched']
# break-even versions: same trades, their own results
assert by['A_be80']['dev']['n'] == by['A']['dev']['n'] and by['A_be80']['dev']['netR'] != by['A']['dev']['netR']
assert len(rows_['A']['draws']) == 2 and len(rows_['B']['draws']) == 2 and len(rows_['C']['draws']) == 1
v = it['verdict']
print('verdict', v['message'])
vc = {x['id']: x for x in v['versions']}
assert any('random-lines' in c_['label'] for c_ in vc['C']['checks'])
assert any('best single part' in c_['label'] for c_ in vc['BCD']['checks'])
assert all('atSize' in rows_[k] for k in rows_)
assert r['best'] in ids and r['untouched'] == [] and r['iteration'] == 17
for s in r['strategies']:
    for k in ('overall', 'dev', 'exam', 'months', 'bySide', 'byHour', 'importance', 'liked', 'recent', 'ic', 'baseline'):
        assert k in s, (s['id'], k)
for k, v_ in before.items():
    assert getattr(ml, k) == v_, f'ml_walkforward.{k} changed'
print('OK: iteration 17')
