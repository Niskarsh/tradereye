"""
Proves the Algo Lab pipeline before it is trusted on real data:
  1. pure noise: no strategy may report an edge (out of sample R after costs near or below zero), and the model's
     predictions must not line up with outcomes (rank correlation near zero);
  2. a planted directional edge (longs after a long lower wick on a busy stock win more): the wide bracket must find it
     out of sample, month after month, leaning on the planted facts;
  3. a planted cross-sectional edge (stocks stronger than Nifty over the last 30 min keep outperforming the others, on
     top of a big market move shared by every stock that day): the market-neutral basket must find it.
Run: python3 tests/py/test_ml_walkforward.py
"""
import datetime
import json
import os
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'scripts'))
import ml_walkforward as ml  # noqa: E402

FEATS = ['minute', 'retOpenPct', 'retOpenAdr', 'gapPct', 'prevDayRet', 'ret10Atr', 'ret30Atr', 'ret60Atr', 'distVwapAtr', 'distHiAtr', 'distLoAtr',
         'rangeAdr', 'posInRange', 'minSinceHi', 'minSinceLo', 'testsHi', 'testsLo', 'tBody', 'tUpWick', 'tLoWick', 'tRangeAtr', 'tVol', 'volTrend',
         'climax3', 'rvolSame', 'rvolDay', 'openBusy', 'atrPct', 'adrPct', 'nFirst5', 'nDay', 'nRecent30', 'nRecent10', 'nPosInRange', 'rsDay', 'rs30',
         'ema10Atr', 'ema5Atr', 'ema1dAtr', 'pdhAtr', 'pdlAtr', 'vaHiAtr', 'vaLoAtr', 'pocAtr', 'upCandles', 'downCandles', 'priceRs',
         'habitClose', 'habitCloseUp', 'habitNext30', 'habitTrend', 'ret5d', 'ret20d', 'hi20Adr', 'lo20Adr', 'prevCloseLoc', 'prevLast30', 'gapVsUsual']
LABELS = ['netL', 'netS', 'rL', 'rS', 'wbL', 'wbS', 'wbLg', 'wbSg', 'ccL', 'ccS', 'ccLg', 'ccSg', 'ccRet']


def make(d, planted, seed):
    rng = np.random.default_rng(seed)
    days = []
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
    date = np.repeat(np.arange(len(days)), syms * len(slots))
    sym = np.repeat(np.tile(np.arange(syms), len(days)), len(slots))
    # the tight bracket (reference only): noise
    rL = np.where(rng.uniform(size=n) < 0.38, 1.5, -1.0)
    rS = np.where(rng.uniform(size=n) < 0.38, 1.5, -1.0)
    # the wide bracket: stop 1R, target 1.5R; base win rate 38%, charges 0.07R
    p_win = np.full(n, 0.38)
    if planted:
        edge = (X[:, FEATS.index('tLoWick')] > 0.7) & (X[:, FEATS.index('rvolSame')] > 0.8)
        p_win = np.where(edge, 0.62, p_win)
    wbLg = np.where(rng.uniform(size=n) < p_win, 1.5, -1.0)
    wbSg = np.where(rng.uniform(size=n) < 0.38, 1.5, -1.0)
    # the ride to the close: a big market move shared by every stock that day, plus its own noise (%)
    market = rng.normal(0, 1.2, size=len(days))[date]
    ccRet = market + rng.normal(0, 1.0, size=n)
    if planted:
        ccRet = ccRet + 0.6 * X[:, FEATS.index('rs30')]
    stop_pct = 2.7
    ccLg, ccSg = ccRet / stop_pct, -ccRet / stop_pct
    lab = {'netL': rL - 0.3, 'netS': rS - 0.3, 'rL': rL, 'rS': rS, 'wbL': wbLg - 0.07, 'wbS': wbSg - 0.07, 'wbLg': wbLg, 'wbSg': wbSg,
           'ccL': ccLg - 0.05, 'ccS': ccSg - 0.05, 'ccLg': ccLg, 'ccSg': ccSg, 'ccRet': ccRet}
    rows = np.column_stack([sym, date, X[:, 0], X] + [lab[k] for k in LABELS]).astype(np.float32)
    rows.tofile(os.path.join(d, 'grid.bin'))
    cols = ['sym', 'date', 'slot'] + FEATS + LABELS
    json.dump({'v': 2, 'runId': 'test', 'from': days[0], 'to': days[-1], 'mid': days[240], 'riskInr': 300, 'cols': cols,
               'labels': LABELS, 'features': [{'k': f, 'l': f} for f in FEATS], 'width': len(cols), 'rows': n,
               'symbols': [f'S{i}' for i in range(syms)], 'dates': days, 'stopAtr': 1, 'targetAtr': 1.5,
               'wideStopAdr': 0.5, 'wideTargetAdr': 0.75, 'closeStopAdr': 0.75}, open(os.path.join(d, 'grid.json'), 'w'))


def run(planted, seed):
    d = tempfile.mkdtemp()
    make(d, planted, seed)
    ml.main(d)
    return json.load(open(os.path.join(d, 'ml.json')))


def strat(res, sid):
    return next(s for s in res['strategies'] if s['id'] == sid)


noise = run(False, 1)
assert noise['v'] == 2 and noise['examFrom'] > noise['strategies'][0]['months'][0]['month']
for s in noise['strategies']:
    o = s['overall']
    print('NOISE   ', s['id'], o, 'ic', s['ic'])
    assert o['netR'] <= 0.05 or o['n'] < 100, f'noise must not look like an edge: {s["id"]} {o}'
    assert s['ic']['mean'] is None or abs(s['ic']['mean']) < 0.03, f'noise predictions must not line up with outcomes: {s["ic"]}'
    assert o['n'] == s['dev']['n'] + s['exam']['n'], 'dev + exam = all'
    assert all(not m['exam'] for m in s['months'] if m['month'] < noise['examFrom'])

edge = run(True, 2)
w = strat(edge, 'wide')
o = w['overall']
print('PLANTED wide   ', o, w['bySide']['long'], 'ic', w['ic'])
assert o['n'] >= 500, 'the planted edge must be traded'
assert o['netR'] > 0.25 and o['t'] > 4, f'the planted edge must be found out of sample: {o}'
assert o['monthsGreen'] >= 0.8 * o['monthsTraded'], 'and month after month'
assert o['gross'] > o['netR'], 'before costs is better than after'
top = [x['f'] for x in w['importance'][:6]]
assert 'tLoWick' in top and 'rvolSame' in top, f'the model must lean on the planted facts: {top}'
liked = {(x['side'], x['f']): x['z'] for x in w['liked']}
assert liked.get(('long', 'tLoWick'), 0) > 0.5, 'taken longs have long lower wicks'
assert all(m['n'] <= ml.MAX_PER_DAY * 23 for m in w['months']), 'never more than the daily cap'

ws = strat(edge, 'wideStock')
print('PLANTED wide, no Nifty', ws['overall'])
assert ws['overall']['netR'] > 0.25 and ws['overall']['t'] > 4, 'the planted edge is in the stock facts: found without the Nifty facts too'
assert not any(x['f'] in ml.MARKET for x in ws['importance'] if x['share'] > 0), 'the no-Nifty model never uses a Nifty fact'

nb = strat(edge, 'neutral')
o = nb['overall']
print('PLANTED neutral', o, nb['bySide'], 'ic', nb['ic'])
assert o['n'] >= 500 and o['netR'] > 0.2 and o['t'] > 4, f'the planted cross-sectional edge must be found: {o}'
assert nb['bySide']['long']['n'] == nb['bySide']['short']['n'], 'as many shorts as longs: market-neutral'
assert nb['ic']['mean'] > 0.1 and nb['ic']['positive'] == nb['ic']['months'], 'the ranking lines up with the outcome every month'
top = [x['f'] for x in nb['importance'][:4]]
assert 'rs30' in top or 'rs30_rk' in top, f'the basket must lean on the planted fact: {top}'
print('OK: no edge in noise; the planted edges found out of sample, month after month')
