"""
Proves the Algo Lab pipeline before it is trusted on real data:
  1. pure noise: it must NOT report an edge (out of sample R after costs near or below zero);
  2. a planted edge (longs after a long lower wick on a busy stock win more): it must find it out of sample.
Run: python3 tests/py/test_ml_walkforward.py
"""
import json, os, sys, tempfile
import numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'scripts'))
import ml_walkforward as ml  # noqa: E402

FEATS = ['minute', 'retOpenPct', 'retOpenAdr', 'gapPct', 'prevDayRet', 'ret10Atr', 'ret30Atr', 'ret60Atr', 'distVwapAtr', 'distHiAtr', 'distLoAtr',
         'rangeAdr', 'posInRange', 'minSinceHi', 'minSinceLo', 'testsHi', 'testsLo', 'tBody', 'tUpWick', 'tLoWick', 'tRangeAtr', 'tVol', 'volTrend',
         'climax3', 'rvolSame', 'rvolDay', 'openBusy', 'atrPct', 'adrPct', 'nFirst5', 'nDay', 'nRecent30', 'nRecent10', 'nPosInRange', 'rsDay', 'rs30',
         'ema10Atr', 'ema5Atr', 'ema1dAtr', 'pdhAtr', 'pdlAtr', 'vaHiAtr', 'vaLoAtr', 'pocAtr', 'upCandles', 'downCandles', 'priceRs']


def make(d, planted, seed):
    rng = np.random.default_rng(seed)
    days = []
    import datetime
    t = datetime.date(2024, 1, 1)
    while len(days) < int(os.environ.get('DAYS', '480')):
        if t.weekday() < 5:
            days.append(t.isoformat())
        t += datetime.timedelta(days=1)
    syms, slots = 40, list(range(20, 331, 10))
    n = len(days) * syms * len(slots)
    X = rng.normal(size=(n, len(FEATS))).astype(np.float32)
    X[:, FEATS.index('minute')] = np.tile(np.array(slots, dtype=np.float32), len(days) * syms)
    X[:, FEATS.index('tLoWick')] = rng.uniform(0, 1, n)
    # a bracket trade: stop 1R, target 1.5R; base win rate 38% -> about -0.05R before costs, -0.2R after
    p_win = np.full(n, 0.38)
    if planted:
        edge = (X[:, FEATS.index('tLoWick')] > 0.7) & (X[:, FEATS.index('rvolSame')] > 0.8)
        p_win = np.where(edge, 0.62, p_win)
    winL = rng.uniform(size=n) < p_win
    winS = rng.uniform(size=n) < 0.38
    rL = np.where(winL, 1.5, -1.0).astype(np.float32)
    rS = np.where(winS, 1.5, -1.0).astype(np.float32)
    netL, netS = rL - 0.15, rS - 0.15
    sym = np.repeat(np.tile(np.arange(syms), len(days)), len(slots))
    date = np.repeat(np.arange(len(days)), syms * len(slots))
    slot = X[:, 0]
    rows = np.column_stack([sym, date, slot, X, netL, netS, rL, rS]).astype(np.float32)
    rows.tofile(os.path.join(d, 'grid.bin'))
    cols = ['sym', 'date', 'slot'] + FEATS + ['netL', 'netS', 'rL', 'rS']
    json.dump({'v': 1, 'runId': 'test', 'from': days[0], 'to': days[-1], 'mid': days[240], 'riskInr': 300, 'cols': cols,
               'labels': ['netL', 'netS', 'rL', 'rS'], 'features': [{'k': f, 'l': f} for f in FEATS], 'width': len(cols), 'rows': n,
               'symbols': [f'S{i}' for i in range(syms)], 'dates': days, 'stopAtr': 1, 'targetAtr': 1.5}, open(os.path.join(d, 'grid.json'), 'w'))


def run(planted, seed):
    d = tempfile.mkdtemp()
    make(d, planted, seed)
    ml.main(d)
    return json.load(open(os.path.join(d, 'ml.json')))


noise = run(False, 1)
o = noise['overall']
print('NOISE   ', o)
assert o['netR'] <= 0.05 or o['n'] < 100, f'noise must not look like an edge: {o}'

edge = run(True, 2)
o = edge['overall']
print('PLANTED ', o, edge['bySide']['long'])
assert o['n'] >= 500, 'the planted edge must be traded'
assert o['netR'] > 0.25 and o['t'] > 4, f'the planted edge must be found out of sample: {o}'
assert o['monthsGreen'] >= 0.8 * o['monthsTraded'], 'and month after month'
top = [x['f'] for x in edge['importance'][:6]]
assert 'tLoWick' in top and 'rvolSame' in top, f'the model must lean on the planted facts: {top}'
liked = {(x['side'], x['f']): x['z'] for x in edge['liked']}
assert liked.get(('long', 'tLoWick'), 0) > 0.5, 'taken longs have long lower wicks'
print('OK: no edge found in noise; the planted edge found out of sample, month after month')
