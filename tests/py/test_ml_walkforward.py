"""
Proves the Algo Lab pipeline before it is trusted on real data:
  1. pure noise: no strategy may report an edge (out of sample R after costs near or below zero), the model's predictions
     must not line up with outcomes, and the untouched test must not look like an edge either;
  2. a planted short edge (shorts after a long upper wick on a busy stock win more): the locked strategy must find it out
     of sample, month after month, leaning on the planted facts, and on the untouched months it never saw;
  3. the untouched months never enter the walk-forward; every diagnostic uses the decide months only.
Run: python3 tests/py/test_ml_walkforward.py [all | noise | planted]
"""
import datetime
import json
import os
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'scripts'))
import ml_walkforward as ml  # noqa: E402

# a small world: the first 3 months are the untouched test; shorter training windows so it fits in 380 days
ml.DECIDE_FROM = '2024-04'
ml.TRAIN_MONTHS = 8
ml.EXAM_MONTHS = 3  # the real exam (May 2026 on) is outside this small world: the last 3 months play it
ml.SHADOW_FROM = '2025-06'  # and the very last month plays a shadow month

FEATS = ['minute', 'retOpenPct', 'retOpenAdr', 'gapPct', 'prevDayRet', 'ret10Atr', 'ret30Atr', 'ret60Atr', 'distVwapAtr', 'distHiAtr', 'distLoAtr',
         'rangeAdr', 'posInRange', 'minSinceHi', 'minSinceLo', 'testsHi', 'testsLo', 'tBody', 'tUpWick', 'tLoWick', 'tRangeAtr', 'tVol', 'volTrend',
         'climax3', 'rvolSame', 'rvolDay', 'openBusy', 'atrPct', 'adrPct', 'nFirst5', 'nDay', 'nRecent30', 'nRecent10', 'nPosInRange', 'rsDay', 'rs30',
         'ema10Atr', 'ema5Atr', 'ema1dAtr', 'pdhAtr', 'pdlAtr', 'vaHiAtr', 'vaLoAtr', 'pocAtr', 'upCandles', 'downCandles', 'priceRs',
         'habitClose', 'habitCloseUp', 'habitNext30', 'habitTrend', 'ret5d', 'ret20d', 'hi20Adr', 'lo20Adr', 'prevCloseLoc', 'prevLast30', 'gapVsUsual']
LABELS = ['netL', 'netS', 'rL', 'rS', 'wbL', 'wbS', 'wbLg', 'wbSg', 'ccL', 'ccS', 'ccLg', 'ccSg', 'ccRet',
          'wbL1', 'wbS1', 'wbL3', 'wbS3', 'ccL1', 'ccS1', 'ccL3', 'ccS3',
          'nbS', 'nbSg', 'nbS1', 'nbS3', 'fbS', 'fbSg', 'fbS1', 'fbS3']


def make(d, planted, seed):
    rng = np.random.default_rng(seed)
    days = []
    t = datetime.date(2024, 1, 1)
    while len(days) < int(os.environ.get('DAYS', '380')):
        if t.weekday() < 5:
            days.append(t.isoformat())
        t += datetime.timedelta(days=1)
    syms, slots = 30, list(range(10, 331, 10))
    n = len(days) * syms * len(slots)
    X = rng.normal(size=(n, len(FEATS))).astype(np.float32)
    X[:, FEATS.index('minute')] = np.tile(np.array(slots, dtype=np.float32), len(days) * syms)
    X[:, FEATS.index('tLoWick')] = rng.uniform(0, 1, n)
    X[:, FEATS.index('tUpWick')] = rng.uniform(0, 1, n)
    X[:, FEATS.index('adrPct')] = rng.uniform(3, 5, n)  # a usual daily range of 3-5% of price, as in the real universe
    date = np.repeat(np.arange(len(days)), syms * len(slots))
    sym = np.repeat(np.tile(np.arange(syms), len(days)), len(slots))
    # the tight bracket (reference only): noise
    rL = np.where(rng.uniform(size=n) < 0.38, 1.5, -1.0)
    rS = np.where(rng.uniform(size=n) < 0.38, 1.5, -1.0)
    # the shorts (wide / near / far targets): base win rates give about break-even before costs; the planted edge
    # (a long upper wick on a busy stock) makes every short version win far more often
    edge = (X[:, FEATS.index('tUpWick')] > 0.7) & (X[:, FEATS.index('rvolSame')] > 0.8) if planted else np.zeros(n, bool)
    u = rng.uniform(size=n)
    wbLg = np.where(rng.uniform(size=n) < 0.38, 1.5, -1.0)
    wbSg = np.where(u < np.where(edge, 0.62, 0.38), 1.5, -1.0)
    # the ride to the close: a big market move shared by every stock that day, plus its own noise (%)
    market = rng.normal(0, 1.2, size=len(days))[date]
    ccRet = market + rng.normal(0, 1.0, size=n)
    stop_pct = 2.7
    ccLg, ccSg = ccRet / stop_pct, -ccRet / stop_pct
    lab = {'netL': rL - 0.3, 'netS': rS - 0.3, 'rL': rL, 'rS': rS, 'wbL': wbLg - 0.07, 'wbS': wbSg - 0.07, 'wbLg': wbLg, 'wbSg': wbSg,
           'ccL': ccLg - 0.05, 'ccS': ccSg - 0.05, 'ccLg': ccLg, 'ccSg': ccSg, 'ccRet': ccRet}
    # bigger positions: smaller charges in R
    for side in 'LS':
        for k in ('wb', 'cc'):
            lab[f'{k}{side}1'] = lab[f'{k}{side}g'] - (0.035 if k == 'wb' else 0.03)
            lab[f'{k}{side}3'] = lab[f'{k}{side}g'] - 0.02
    # the short with a nearer / farther target: its own coin flips (noise)
    for pre, win, gain in (('nb', 0.5, 1.0), ('fb', 0.33, 2.0)):
        g_ = np.where(u < np.where(edge, win + 0.25, win), gain, -1.0)
        lab[f'{pre}Sg'], lab[f'{pre}S'], lab[f'{pre}S1'], lab[f'{pre}S3'] = g_, g_ - 0.07, g_ - 0.035, g_ - 0.02
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


def check_picker():
    """first come, first served: a stronger moment later in the day never displaces an earlier trade"""
    import pandas as pd
    st = ml.STRATEGIES[0]
    n = ml.MAX_PER_DAY + 3
    part = pd.DataFrame({'day': ['2025-01-02'] * n, 'sym': list(range(n)), 'slot': [20 + 10 * i for i in range(n)]})
    for c in ('L', 'S', 'Lg', 'Sg', 'L1', 'S1', 'L3', 'S3'):
        part[st[c]] = 0.0
    pl = np.array([0.1 + 0.1 * i for i in range(n)])  # later = stronger
    ps = np.full(n, -1.0)
    tr = ml.pick_dir(part, pl, ps, 0.05, st)
    assert len(tr) == ml.MAX_PER_SIDE and sorted(tr['slot']) == [20 + 10 * i for i in range(ml.MAX_PER_SIDE)], tr


check_picker()
print('OK: the picker is first come, first served')
which = sys.argv[1] if len(sys.argv) > 1 else 'all'
if which in ('all', 'noise'):
  noise = run(False, 1)
  assert noise['v'] == 2 and noise['examFrom'] > noise['strategies'][0]['months'][0]['month']
  for s in noise['strategies']:
      o = s['overall']
      print('NOISE   ', s['id'], o, 'ic', s['ic'])
      assert o['netR'] <= 0.05 or o['n'] < 100, f'noise must not look like an edge: {s["id"]} {o}'
      assert s['ic']['mean'] is None or abs(s['ic']['mean']) < 0.03, f'noise predictions must not line up with outcomes: {s["ic"]}'
      assert o['n'] == s['dev']['n'] + s['exam']['n'] + s['shadow']['n'], 'decide + exam + shadow = all'
      assert all(m['month'] >= ml.DECIDE_FROM for m in s['months']), 'the untouched months never enter the walk-forward'
      assert all(t[0] >= ml.DECIDE_FROM for t in s['trades'])
  for ut in noise['untouched']:
      print('NOISE untouched', ut['id'], ut['overall'])
      assert ut['overall']['n'] < 100 or ut['overall']['netR'] <= 0.05, 'noise must not pass the untouched test'

if which in ('all', 'planted'):
  edge = run(True, 2)
  w = strat(edge, 'shortNear')
  o = w['overall']
  print('PLANTED F      ', o, 'ic', w['ic'])
  assert o['n'] >= 300, 'the planted edge must be traded'
  assert o['netR'] > 0.2 and o['t'] > 4, f'the planted edge must be found out of sample: {o}'
  assert o['monthsGreen'] >= 0.8 * o['monthsTraded'], 'and month after month'
  assert o['gross'] > o['netR'], 'before costs is better than after'
  top = [x['f'] for x in w['importance'][:6]]
  assert 'tUpWick' in top and 'rvolSame' in top, f'the model must lean on the planted facts: {top}'
  liked = {(x['side'], x['f']): x['z'] for x in w['liked']}
  assert liked.get(('short', 'tUpWick'), 0) > 0.5, 'taken shorts have long upper wicks'
  assert not any(x['f'] in ml.MARKET for x in w['importance'] if x['share'] > 0), 'the stock-only model never uses a Nifty fact'
  cv = {c['id']: c for c in w['costs']}
  assert all(v['fill'] == 1 for v in cv.values()) and cv['now']['overall']['netR'] == o['netR'], 'same trades, every size'
  assert cv['l3']['overall']['netR'] > cv['l1']['overall']['netR'] > cv['now']['overall']['netR'], 'bigger positions keep more'
  assert len(w['trades']) == o['n'] and abs(sum(t[5] for t in w['trades']) / o['n'] - o['netR']) < 0.002, 'the kept trades add up'
  for sid in ('wideShort', 'shortNear'):
      st_ = strat(edge, sid)
      assert all(t[3] == -1 for t in st_['trades']) and all(t[2] >= '09:35' for t in st_['trades']), f'{sid}: shorts from 09:35'
  assert {s_['id'] for s_ in edge['strategies']} == {'wideShort', 'shortNear'} and edge['locked'] == 'shortNear'
  assert edge['strategies'][1]['exam']['pass'] in (True, False, None)
  dl = w['daily']
  assert abs(dl['perTradedDay'] * dl['daysWithTrades'] - w['dev']['n']) < 1, 'your day = the decide months'
  assert [u['id'] for u in edge['untouched']] == ['shortNear', 'wideShort'], 'both locked strategies get their one shot'
  for ut in edge['untouched']:
      print('PLANTED untouched', ut['id'], ut['overall'], ut['from'], ut['to'])
      assert ut['to'] < ml.DECIDE_FROM and all(t[0] < ml.DECIDE_FROM for t in ut['trades'])
      assert ut['overall']['n'] >= 50 and ut['overall']['netR'] > 0.2, 'the planted edge is there in the untouched months too'
  sh = w['shadow']
  print('PLANTED shadow', sh)
  assert sh['n'] > 0 and sh['netR'] > 0.1 and all(m['shadow'] == (m['month'] >= ml.SHADOW_FROM) for m in w['months'])
  assert not any(m['exam'] and m['shadow'] for m in w['months']), 'a shadow month is never an exam month'
  assert w['dev']['n'] + w['exam']['n'] + sh['n'] == o['n'], 'decide + exam + shadow = all'
  mo = w['money']
  print('PLANTED money', mo)
  assert mo['position'] > 0 and mo['margin'] * 5 == mo['position'] or abs(mo['margin'] * 5 - mo['position']) <= 5
  assert mo['capital'] > mo['margin'] and mo['pct'] > 0 and len(mo['bigger']) == 2

print('OK:', which)
