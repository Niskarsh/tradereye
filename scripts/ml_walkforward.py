"""
Algo Lab, step 2: walk-forward machine learning on the dataset written by the backtest job (lib/ml/grid.ts).

    python scripts/ml_walkforward.py <dir>        reads <dir>/grid.bin + grid.json, writes <dir>/ml.json

How it trades, the way an algo desk tests a model:
  * every 10-min close of every stock is a row: ~47 facts known at that moment, plus cross-sectional ranks (this stock
    against every other stock at the same minute), plus what a long and a short taken there made after charges and
    slippage (stop 1 ATR, target 1.5 ATR, out by 15:00);
  * walk-forward: for each month, models are trained only on the 12 months before it (gradient-boosted trees, one for
    longs, one for shorts), the bar to trade ("threshold") is picked on the 2 months just before the test month, and
    the month is then traded blind. Nothing from the test month or later is ever used;
  * the trade: at most one per stock per day (the first 10-min close where the predicted edge clears the bar, on the
    side with the bigger prediction), at most 10 a day (the strongest predictions);
  * every number reported is out of sample: months the model had not seen.
"""
import json
import math
import os
import sys
import time

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

TRAIN_MONTHS = 12
VAL_MONTHS = 2
MIN_TRAIN_MONTHS = 6
MAX_PER_DAY = 10
THRESHOLDS = [0.0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.75]
RANKED = ['retOpenPct', 'rvolSame', 'rsDay', 'rs30', 'distVwapAtr', 'ret30Atr', 'tVol', 'rangeAdr', 'atrPct']
RISK = 300.0


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def load(d):
    head = json.load(open(os.path.join(d, 'grid.json')))
    raw = np.fromfile(os.path.join(d, 'grid.bin'), dtype=np.float32)
    w = head['width']
    if raw.size % w:
        raise SystemExit('grid.bin is not a whole number of rows')
    df = pd.DataFrame(raw.reshape(-1, w), columns=head['cols'])
    df['sym'] = df['sym'].astype(np.int32)
    df['date'] = df['date'].astype(np.int32)
    df['slot'] = df['slot'].astype(np.int32)
    dates = np.array(head['dates'])
    df['day'] = dates[df['date'].values]
    df['month'] = df['day'].str.slice(0, 7)
    return head, df


def add_ranks(df):
    """this stock vs every other stock at the same minute (0 = lowest, 1 = highest), and how many stocks were there"""
    g = df.groupby(['date', 'slot'], sort=False)
    for c in RANKED:
        df[c + '_rk'] = g[c].rank(pct=True).astype(np.float32)
    df['nStocks'] = g['sym'].transform('size').astype(np.float32)
    return df


MAX_FIT_ROWS = 800_000


def sub(mask, seed):
    """at most MAX_FIT_ROWS training rows (a random sample), so a run stays within the job's time"""
    idx = np.flatnonzero(mask)
    if len(idx) > MAX_FIT_ROWS:
        idx = np.sort(np.random.default_rng(seed).choice(idx, MAX_FIT_ROWS, replace=False))
    return idx


def model():
    return HistGradientBoostingRegressor(max_iter=250, learning_rate=0.05, max_leaf_nodes=31, min_samples_leaf=400,
                                         l2_regularization=1.0, early_stopping=False, random_state=7)


def pick_trades(part, pl, ps, thr):
    """one trade per stock-day (the first close that clears the bar), at most MAX_PER_DAY a day (the strongest)"""
    best = np.maximum(pl, ps)
    side = np.where(pl >= ps, 1, -1)
    m = best > thr
    if not m.any():
        return pd.DataFrame(columns=['day', 'sym', 'slot', 'side', 'pred', 'net', 'r'])
    c = part.loc[m, ['day', 'sym', 'slot', 'netL', 'netS', 'rL', 'rS']].copy()
    c['pred'] = best[m]
    c['side'] = side[m]
    c = c.sort_values(['day', 'sym', 'slot']).drop_duplicates(['day', 'sym'], keep='first')
    c = c.sort_values(['day', 'pred'], ascending=[True, False]).groupby('day', sort=False).head(MAX_PER_DAY)
    c['net'] = np.where(c['side'] == 1, c['netL'], c['netS'])
    c['r'] = np.where(c['side'] == 1, c['rL'], c['rS'])
    return c[['day', 'sym', 'slot', 'side', 'pred', 'net', 'r']]


def stats(net):
    net = np.asarray(net, dtype=float)
    n = len(net)
    if n == 0:
        return {'n': 0, 'hit': 0, 'netR': 0, 'sumR': 0, 'inr': 0, 't': 0}
    mu = float(net.mean())
    sd = float(net.std(ddof=1)) if n > 1 else 0.0
    return {'n': n, 'hit': round(float((net > 0).mean()), 3), 'netR': round(mu, 3), 'sumR': round(float(net.sum()), 2),
            'inr': round(float(net.sum()) * RISK), 't': round(mu / (sd / math.sqrt(n)), 2) if sd > 0 and n > 1 else 0}


def main(d):
    head, df = load(d)
    log('rows', len(df), 'stocks', len(head['symbols']), 'days', len(head['dates']))
    df = add_ranks(df)
    feats = [f['k'] for f in head['features']] + [c + '_rk' for c in RANKED] + ['nStocks']
    # outliers (gaps, data errors) must not steer the model: learn on R clipped to [-3, 3]; trades are scored on the real R
    yl = df['netL'].clip(-3, 3).values
    ys = df['netS'].clip(-3, 3).values
    months = sorted(df['month'].unique())
    if len(months) < MIN_TRAIN_MONTHS + 1:
        raise SystemExit('not enough months for walk-forward')
    X = df[feats].values.astype(np.float32)
    month_idx = {m: i for i, m in enumerate(months)}
    mi = df['month'].map(month_idx).values

    out_months, all_trades, importance = [], [], np.zeros(len(feats))
    for ti in range(MIN_TRAIN_MONTHS, len(months)):
        t0 = time.time()
        lo = max(0, ti - TRAIN_MONTHS)
        fit = (mi >= lo) & (mi < ti - VAL_MONTHS)
        val = (mi >= ti - VAL_MONTHS) & (mi < ti)
        test = mi == ti
        if fit.sum() < 5000 or test.sum() == 0:
            continue
        # 1) pick the bar on the 2 months just before, with models that never saw them
        fi = sub(fit, ti)
        ml, ms = model().fit(X[fi], yl[fi]), model().fit(X[fi], ys[fi])
        vpart = df.loc[val]
        pl, ps = ml.predict(X[val]), ms.predict(X[val])
        best_thr, best_sum = None, -1e18
        for thr in THRESHOLDS:
            tr = pick_trades(vpart, pl, ps, thr)
            if len(tr) < 20 * VAL_MONTHS:
                continue
            s = tr['net'].sum()
            if s > best_sum:
                best_thr, best_sum = thr, s
        # 2) retrain on everything before the test month, trade the month blind
        full = (mi >= lo) & (mi < ti)
        fu = sub(full, ti + 1000)
        ml, ms = model().fit(X[fu], yl[fu]), model().fit(X[fu], ys[fu])
        tpart = df.loc[test]
        pl, ps = ml.predict(X[test]), ms.predict(X[test])
        if best_thr is None or best_sum <= 0:
            tr = pick_trades(tpart, pl, ps, 1e9)  # the bar was not worth trading on validation: stand aside
            note = 'stood aside (no profitable bar on the 2 months before)'
        else:
            tr = pick_trades(tpart, pl, ps, best_thr)
            note = ''
        tr = tr.assign(month=months[ti])
        all_trades.append(tr)
        s = stats(tr['net'])
        s.update({'month': months[ti], 'thr': best_thr, 'note': note,
                  'baseL': round(float(tpart['netL'].mean()), 3), 'baseS': round(float(tpart['netS'].mean()), 3)})
        out_months.append(s)
        # what the model leans on: each fact's share of the trees' total split gain (cheap, from the fitted trees)
        try:
            for m_ in (ml, ms):
                for pred in m_._predictors:
                    for tree in pred:
                        nodes = tree.nodes
                        split = nodes['is_leaf'] == 0
                        # weighted by how much each split improved the fit (its gain), not just how often a fact is used
                        np.add.at(importance, nodes['feature_idx'][split], np.maximum(nodes['gain'][split], 0))
        except Exception:  # private sklearn internals: never let this break the run
            pass
        log(months[ti], 'trades', s['n'], 'netR', s['netR'], 'thr', best_thr, f'{time.time() - t0:.0f}s')

    trades = pd.concat(all_trades) if all_trades else pd.DataFrame(columns=['day', 'sym', 'slot', 'side', 'pred', 'net', 'r', 'month'])
    overall = stats(trades['net'])
    overall['gross'] = round(float(trades['r'].mean()), 3) if len(trades) else 0
    traded_months = [m for m in out_months if m['n'] > 0]
    overall['monthsGreen'] = sum(1 for m in traded_months if m['sumR'] > 0)
    overall['monthsTraded'] = len(traded_months)
    overall['monthsTotal'] = len(out_months)
    eq = trades['net'].cumsum().values if len(trades) else np.array([0.0])
    overall['maxDrawdownR'] = round(float((np.maximum.accumulate(np.concatenate([[0], eq])) - np.concatenate([[0], eq])).max()), 2)
    overall['inrPerMonth'] = round(overall['inr'] / max(1, len(out_months)))

    # what the taken trades looked like vs every row (in standard deviations): the model's "style" in plain facts
    labels = {f['k']: f['l'] for f in head['features']}
    for c in RANKED:
        labels[c + '_rk'] = f"Rank vs other stocks: {labels.get(c, c)} (0 = lowest, 1 = highest)"
    labels['nStocks'] = 'How many stocks were in the universe at that minute'
    liked = []
    if len(trades):
        key = df.set_index(['day', 'sym', 'slot']).index
        tk = pd.MultiIndex.from_frame(trades[['day', 'sym', 'slot']])
        taken = df.loc[key.isin(tk)]
        for side, name in ((1, 'long'), (-1, 'short')):
            sel = trades[trades['side'] == side]
            if len(sel) < 30:
                continue
            tki = pd.MultiIndex.from_frame(sel[['day', 'sym', 'slot']])
            part = df.loc[key.isin(tki)]
            for f in feats:
                sd = float(df[f].std())
                if not sd or not np.isfinite(sd):
                    continue
                z = (float(part[f].mean()) - float(df[f].mean())) / sd
                if np.isfinite(z):
                    liked.append({'side': name, 'f': f, 'label': labels.get(f, f), 'z': round(z, 2),
                                  'taken': round(float(part[f].median()), 3), 'all': round(float(df[f].median()), 3)})
        del taken
    liked.sort(key=lambda x: -abs(x['z']))

    by_side = {name: stats(trades.loc[trades['side'] == s_, 'net']) for s_, name in ((1, 'long'), (-1, 'short'))}
    by_hour = []
    if len(trades):
        h = (555 + trades['slot']) // 60
        for hour in sorted(h.unique()):
            st = stats(trades.loc[h == hour, 'net'])
            st['hour'] = f'{int(hour):02d}:00'
            by_hour.append(st)
    imp = importance / importance.sum() if importance.sum() else importance
    top = sorted(({'f': f, 'label': labels.get(f, f), 'share': round(float(v), 4)} for f, v in zip(feats, imp)), key=lambda x: -x['share'])[:15]
    recent = trades.sort_values(['day', 'slot']).tail(40)
    syms = head['symbols']
    result = {
        'v': 1, 'runId': head['runId'], 'createdAt': int(time.time() * 1000), 'period': {'from': head['from'], 'to': head['to']},
        'rows': int(len(df)), 'stocks': len(syms), 'days': len(head['dates']),
        'setup': {'stopAtr': head['stopAtr'], 'targetAtr': head['targetAtr'], 'trainMonths': TRAIN_MONTHS, 'valMonths': VAL_MONTHS, 'maxPerDay': MAX_PER_DAY, 'riskInr': RISK},
        'baseline': {'long': round(float(df['netL'].mean()), 3), 'short': round(float(df['netS'].mean()), 3)},
        'overall': overall, 'bySide': by_side, 'byHour': by_hour, 'months': out_months, 'importance': top, 'liked': liked[:20],
        'recent': [{'day': r.day, 'sym': syms[int(r.sym)], 'time': f'{(555 + int(r.slot)) // 60:02d}:{(555 + int(r.slot)) % 60:02d}',
                    'side': 'LONG' if r.side == 1 else 'SHORT', 'pred': round(float(r.pred), 2), 'net': round(float(r.net), 2)} for r in recent.itertuples()],
    }
    json.dump(result, open(os.path.join(d, 'ml.json'), 'w'))
    log('overall', overall)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'ml-data')
