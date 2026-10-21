"""
Algo Lab, step 2: walk-forward machine learning on the dataset written by the backtest job (lib/ml/grid.ts).

    python scripts/ml_walkforward.py <dir>        reads <dir>/grid.bin + grid.json, writes <dir>/ml.json

How it trades, the way an algo desk tests a model:
  * every 10-min close of every stock is a row: ~47 facts known at that moment, plus cross-sectional ranks (this stock
    against every other stock at the same minute), plus what each trade taken there made after charges and slippage;
  * walk-forward: for each month, models are trained only on the months before it (gradient-boosted trees), the bar to
    trade is picked on the 2 months just before the test month (with models that never saw them), and the month is
    then traded blind. Nothing from the test month or later is ever used;
  * every number reported is out of sample: months the model had not seen;
  * the last EXAM_MONTHS months are the locked exam: the next iteration is decided from the months before them.

Each iteration tests a few strategies side by side (see STRATEGIES and CHANGES).
"""
import json
import math
import os
import sys
import time

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

ITERATION = 5
CHANGES = [
    'Four strategies side by side, each testing one fix: A = iteration 4 unchanged (the control); B = shorts only (in this universe a blind long starts ~0.06R behind a blind short, before costs); C = decisions 09:35–10:55 only (the model leans on overnight facts, and iteration 4\'s edge was in the first hour); D = the market-neutral basket.',
    'Models learn from up to 30 months before each month (was 18): more market moods to learn from.',
    'The cost table now compares position sizes with market orders: ₹300 risk, ~₹1 lakh and ~₹3 lakh positions (Dhan\'s ₹20 brokerage cap). Limit orders at the close are gone: in iteration 4 the orders that never filled were the winners.',
    'The side and time-of-day breakdowns use the earlier months only, so the exam months never steer the next step.',
    'Exam months still locked from May 2026. Four variants raise the odds of a lucky one: the bar is t ≥ 2 on the earlier months and not red on the exam.',
]
TRAIN_MONTHS = 30
VAL_MONTHS = 3
EXAM_FROM = '2026-05'  # locked: the same exam months for every iteration
ENSEMBLE = 3
MARKET = ['nFirst5', 'nDay', 'nRecent30', 'nRecent10', 'nPosInRange']
MIN_TRAIN_MONTHS = 6
EXAM_MONTHS = 6
MAX_PER_DAY = 6
MAX_PER_SIDE = 4
QUANTS = [0.9, 0.95, 0.98, 0.99, 0.995]
NEUTRAL_SLOTS = [30, 90, 150]  # 09:45, 10:45, 11:45
NEUTRAL_K = 3
NEUTRAL_MIN = 20  # at least this many stocks at that minute to rank them
RANKED = ['retOpenPct', 'rvolSame', 'rsDay', 'rs30', 'distVwapAtr', 'ret30Atr', 'tVol', 'rangeAdr', 'atrPct', 'habitClose', 'ret5d']
RISK = 300.0
MIN_LEAF = 1500
MAX_FIT_ROWS = 400_000  # per ensemble member (each sees its own sample)

_WIDE = {'kind': 'dir', 'L': 'wbL', 'S': 'wbS', 'Lg': 'wbLg', 'Sg': 'wbSg', 'L1': 'wbL1', 'S1': 'wbS1', 'L3': 'wbL3', 'S3': 'wbS3', 'noMarket': True}
_WDESC = 'stop ½ of its usual daily range away, target ¾ of it, out by 15:15, picked from the stock\'s own facts and habits (no Nifty)'
STRATEGIES = [
    {**_WIDE, 'id': 'wideStock', 'name': 'A. Wide bracket (control)', 'desc': f'Long or short one stock: {_WDESC}. The same as iteration 4.'},
    {**_WIDE, 'id': 'wideShort', 'name': 'B. Wide bracket, shorts only', 'only': -1, 'desc': f'Short only: {_WDESC}.'},
    {**_WIDE, 'id': 'wideMorning', 'name': 'C. Wide bracket, 09:35–10:55 only', 'lastSlot': 100, 'desc': f'Long or short, decided between 09:35 and 10:55 only: {_WDESC}.'},
    {'id': 'neutralStock', 'name': 'D. Market-neutral basket', 'kind': 'neutral', 'L': 'ccL', 'S': 'ccS', 'Lg': 'ccLg', 'Sg': 'ccSg',
     'L1': 'ccL1', 'S1': 'ccS1', 'L3': 'ccL3', 'S3': 'ccS3', 'noMarket': True,
     'desc': 'At 09:45, 10:45 and 11:45: buy the 3 stocks the model rates best and short the 3 it rates worst, all held to 15:15 '
             '(safety stop ¾ of the usual daily range). The market\'s direction cancels out; only the ranking can make money.'},
]
COSTS = [('now', 'Market orders, ₹300 risk', 'net'),
         ('l1', 'Market orders, ~₹1 lakh position', 'p1'),
         ('l3', 'Market orders, ~₹3 lakh position', 'p3')]


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
    """this stock vs every other stock at the same minute (0 = lowest, 1 = highest)"""
    g = df.groupby(['date', 'slot'], sort=False)
    for c in RANKED:
        df[c + '_rk'] = g[c].rank(pct=True).astype(np.float32)
    # the market-neutral target: this stock's move to 15:15 minus the average move of every stock at that minute
    df['excess'] = (df['ccRet'] - g['ccRet'].transform('mean')).astype(np.float32)
    return df


def sub(mask, seed):
    """at most MAX_FIT_ROWS training rows (a random sample), so a run stays within the job's time"""
    idx = np.flatnonzero(mask)
    if len(idx) > MAX_FIT_ROWS:
        idx = np.sort(np.random.default_rng(seed).choice(idx, MAX_FIT_ROWS, replace=False))
    return idx


def model(seed=7):
    return HistGradientBoostingRegressor(max_iter=200, learning_rate=0.05, max_leaf_nodes=31, min_samples_leaf=MIN_LEAF,
                                         l2_regularization=1.0, early_stopping=False, random_state=seed)


class Ensemble:
    """ENSEMBLE models, each on its own random sample of the training months; predictions are averaged"""
    def __init__(self, models, cols):
        self.models, self.cols = models, cols

    def predict(self, X):
        Xs = X[:, self.cols]
        return np.mean([m.predict(Xs) for m in self.models], axis=0)


def fit(X, y, mask, seed, cols):
    ms = []
    for e in range(ENSEMBLE):
        idx = sub(mask, seed * 10 + e)
        ok = idx[np.isfinite(y[idx])]
        ms.append(model(7 + e).fit(X[np.ix_(ok, cols)], y[ok]))
    return Ensemble(ms, cols)


EMPTY = ['day', 'sym', 'slot', 'side', 'pred', 'net', 'gross', 'p1', 'p3']


def allowed(part, pl, ps, st):
    """a strategy's limits: one side only, or decisions up to a time of day (not allowed = never picked)"""
    pl, ps = pl.copy(), ps.copy()
    if st.get('only') == -1:
        pl[:] = -np.inf
    if st.get('only') == 1:
        ps[:] = -np.inf
    if st.get('lastSlot'):
        late = part['slot'].values > st['lastSlot']
        pl[late] = -np.inf
        ps[late] = -np.inf
    return pl, ps


def pick_dir(part, pl, ps, thr, st):
    """one trade per stock-day (the first close that clears the bar), at most MAX_PER_SIDE a side and MAX_PER_DAY a day,
    first come first served through the day (as live: a later, stronger moment cannot displace an earlier trade)"""
    best = np.maximum(pl, ps)
    side = np.where(pl >= ps, 1, -1)
    m = best > thr
    if not m.any():
        return pd.DataFrame(columns=EMPTY)
    c = part.loc[m, ['day', 'sym', 'slot', st['L'], st['S'], st['Lg'], st['Sg'], st['L1'], st['S1'], st['L3'], st['S3']]].copy()
    c['pred'] = best[m]
    c['side'] = side[m]
    c = c.sort_values(['day', 'sym', 'slot']).drop_duplicates(['day', 'sym'], keep='first')
    # time order; within the same minute the stronger prediction first
    c = c.sort_values(['day', 'slot', 'pred'], ascending=[True, True, False])
    c = c[c.groupby(['day', 'side'], sort=False).cumcount() < MAX_PER_SIDE]
    c = c[c.groupby('day', sort=False).cumcount() < MAX_PER_DAY]
    c['net'] = np.where(c['side'] == 1, c[st['L']], c[st['S']])
    c['gross'] = np.where(c['side'] == 1, c[st['Lg']], c[st['Sg']])
    c['p1'] = np.where(c['side'] == 1, c[st['L1']], c[st['S1']])
    c['p3'] = np.where(c['side'] == 1, c[st['L3']], c[st['S3']])
    return c[EMPTY]


def neutral_groups(part, pred):
    c = part[['day', 'sym', 'slot', 'ccL', 'ccS', 'ccLg', 'ccSg', 'ccL1', 'ccS1', 'ccL3', 'ccS3']].copy()
    c['pred'] = pred
    return c[c['slot'].isin(NEUTRAL_SLOTS)]


def spreads(c):
    """best-3 minus worst-3 prediction at every (day, slot): what the basket bar is chosen from"""
    out = []
    for _, h in c.groupby(['day', 'slot'], sort=False):
        if len(h) >= NEUTRAL_MIN:
            p = np.sort(h['pred'].values)
            out.append(p[-NEUTRAL_K:].mean() - p[:NEUTRAL_K].mean())
    return np.array(out)


def pick_neutral(c, thr):
    """at each basket time: long the NEUTRAL_K best, short the NEUTRAL_K worst (each stock once a day)"""
    rows = []
    for day, g in c.groupby('day', sort=True):
        used = set()
        for slot in NEUTRAL_SLOTS:
            h = g[g['slot'].values == slot]
            if used:
                h = h[~h['sym'].isin(used)]
            if len(h) < NEUTRAL_MIN:
                continue
            h = h.sort_values('pred')
            lo, hi = h.iloc[:NEUTRAL_K], h.iloc[-NEUTRAL_K:]
            if hi['pred'].mean() - lo['pred'].mean() <= thr:
                continue
            for r in hi.itertuples():
                rows.append((day, r.sym, slot, 1, r.pred, r.ccL, r.ccLg, r.ccL1, r.ccL3))
            for r in lo.itertuples():
                rows.append((day, r.sym, slot, -1, r.pred, r.ccS, r.ccSg, r.ccS1, r.ccS3))
            used.update(hi['sym'].tolist())
            used.update(lo['sym'].tolist())
    return pd.DataFrame(rows, columns=EMPTY)


def stats(net, gross=None):
    net = np.asarray(net, dtype=float)
    n = len(net)
    if n == 0:
        return {'n': 0, 'hit': 0, 'netR': 0, 'gross': 0, 'sumR': 0, 'inr': 0, 't': 0}
    mu = float(net.mean())
    sd = float(net.std(ddof=1)) if n > 1 else 0.0
    return {'n': n, 'hit': round(float((net > 0).mean()), 3), 'netR': round(mu, 3),
            'gross': round(float(np.mean(gross)), 3) if gross is not None and len(gross) else 0,
            'sumR': round(float(net.sum()), 2), 'inr': round(float(net.sum()) * RISK),
            't': round(mu / (sd / math.sqrt(n)), 2) if sd > 0 and n > 1 else 0}


def spearman(a, b):
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    ok = np.isfinite(a) & np.isfinite(b)
    if ok.sum() < 50:
        return None
    r = pd.Series(a[ok]).rank().corr(pd.Series(b[ok]).rank())
    return None if not np.isfinite(r) else float(r)


def add_gain(acc, models, cols):
    """what the model leans on: each fact's share of the trees' total split gain (from the fitted trees)"""
    try:
        for m_ in models:
            for pred in m_._predictors:
                for tree in pred:
                    nodes = tree.nodes
                    split = nodes['is_leaf'] == 0
                    np.add.at(acc, cols[nodes['feature_idx'][split]], np.maximum(nodes['gain'][split], 0))
    except Exception:  # private sklearn internals: never let this break the run
        pass


def period_stats(tr, months):
    s = stats(tr['net'], tr['gross'])
    s['monthsGreen'] = sum(1 for m in months if m['n'] > 0 and m['sumR'] > 0)
    s['monthsTraded'] = sum(1 for m in months if m['n'] > 0)
    s['monthsTotal'] = len(months)
    return s


def main(d):
    head, df = load(d)
    log('rows', len(df), 'stocks', len(head['symbols']), 'days', len(head['dates']))
    df = add_ranks(df)
    feats = [f['k'] for f in head['features']] + [c + '_rk' for c in RANKED]
    X = df[feats].values.astype(np.float32)
    months = sorted(df['month'].unique())
    first_test = MIN_TRAIN_MONTHS + VAL_MONTHS
    if len(months) < first_test + 1:
        raise SystemExit('not enough months for walk-forward')
    exam_from = EXAM_FROM if EXAM_FROM in months[first_test:] else months[max(first_test, len(months) - EXAM_MONTHS)]
    all_cols = np.arange(len(feats))
    stock_cols = np.array([i for i, f in enumerate(feats) if f not in MARKET])
    mi = df['month'].map({m: i for i, m in enumerate(months)}).values
    # learn on results clipped to [-3, 3] (gaps and data errors must not steer the model); trades are scored on the real result
    y = {c: df[c].clip(-3, 3).values.astype(np.float32) for c in ('wbL', 'wbS', 'ccL', 'ccS')}

    res = {st['id']: {'trades': [], 'months': [], 'gain': np.zeros(len(feats)), 'ic': []} for st in STRATEGIES}
    y['excess'] = df['excess'].clip(-3, 3).values.astype(np.float32)
    for ti in range(first_test, len(months)):
        t0 = time.time()
        fitm = (mi >= max(0, ti - VAL_MONTHS - TRAIN_MONTHS)) & (mi < ti - VAL_MONTHS)
        val = (mi >= ti - VAL_MONTHS) & (mi < ti)
        test = mi == ti
        if fitm.sum() < 5000 or test.sum() == 0:
            continue
        vpart, tpart = df.loc[val], df.loc[test]
        shared = {}
        for st in STRATEGIES:
            r = res[st['id']]
            if st['kind'] == 'dir':
                cols = stock_cols if st.get('noMarket') else all_cols
                # strategies with the same labels and facts share the same models (they differ only in which trades they may take)
                mkey = (st['L'], st['S'], bool(st.get('noMarket')))
                if mkey not in shared:
                    ml, ms = fit(X, y[st['L']], fitm, ti, cols), fit(X, y[st['S']], fitm, ti + 500, cols)
                    shared[mkey] = (ml, ms, ml.predict(X[val]), ms.predict(X[val]), ml.predict(X[test]), ms.predict(X[test]))
                ml, ms, vl, vs, tl, ts = shared[mkey]
                vl, vs = allowed(vpart, vl, vs, st)
                tl_all, ts_all = tl, ts
                tl, ts = allowed(tpart, tl, ts, st)
                vb = np.maximum(vl, vs)
                vb = vb[np.isfinite(vb)]
                cands = [float(q) for q in np.quantile(vb, QUANTS) if q > 0] if len(vb) else []
                best_thr, best_sum = None, -1e18
                for thr in cands:
                    tr = pick_dir(vpart, vl, vs, thr, st)
                    if len(tr) < 10 * VAL_MONTHS:
                        continue
                    if tr['net'].sum() > best_sum:
                        best_thr, best_sum = thr, float(tr['net'].sum())
                ok = best_thr is not None and best_sum > 0
                tr = pick_dir(tpart, tl, ts, best_thr if ok else 1e18, st)
                ics = [spearman(tl_all, tpart[st['L']].values), spearman(ts_all, tpart[st['S']].values)]
                ics = [x for x in ics if x is not None]
                ic = float(np.mean(ics)) if ics else None
                add_gain(r['gain'], ml.models + ms.models, cols)
            else:
                ncols = stock_cols if st.get('noMarket') else all_cols
                mn = fit(X, y['excess'], fitm, ti + 900, ncols)
                vc, tc = neutral_groups(vpart, mn.predict(X[val])), neutral_groups(tpart, mn.predict(X[test]))
                sp = spreads(vc)
                cands = [0.0] + ([float(q) for q in np.quantile(sp, [0.25, 0.5, 0.75])] if len(sp) else [])
                best_thr, best_sum = None, -1e18
                for thr in cands:
                    tr = pick_neutral(vc, thr)
                    if len(tr) < 10 * VAL_MONTHS:
                        continue
                    if tr['net'].sum() > best_sum:
                        best_thr, best_sum = thr, float(tr['net'].sum())
                ok = best_thr is not None and best_sum > 0
                tr = pick_neutral(tc, best_thr) if ok else pd.DataFrame(columns=EMPTY)
                ic = spearman(mn.predict(X[test]), tpart['excess'].values)
                add_gain(r['gain'], mn.models, ncols)
            tr = tr.assign(month=months[ti])
            r['trades'].append(tr)
            s = stats(tr['net'], tr['gross'])
            s.update({'month': months[ti], 'thr': None if best_thr is None else round(best_thr, 4),
                      'note': '' if ok else f'stood aside (not profitable on the {VAL_MONTHS} months before)',
                      'ic': None if ic is None else round(ic, 4), 'exam': months[ti] >= exam_from,
                      'baseL': round(float(np.nanmean(tpart[st['L']])), 3), 'baseS': round(float(np.nanmean(tpart[st['S']])), 3)})
            r['months'].append(s)
            if ic is not None:
                r['ic'].append(ic)
        log(months[ti], ' | '.join(f"{k}: {v['months'][-1]['n']} @ {v['months'][-1]['netR']}" for k, v in res.items() if v['months']),
            f'{time.time() - t0:.0f}s')

    labels = {f['k']: f['l'] for f in head['features']}
    for c in RANKED:
        labels[c + '_rk'] = f"Rank vs other stocks: {labels.get(c, c)} (0 = lowest, 1 = highest)"
    mean_all = {f: float(df[f].mean()) for f in feats}
    sd_all = {f: float(df[f].std()) for f in feats}
    med_all = {f: float(df[f].median()) for f in feats}
    key = pd.MultiIndex.from_arrays([df['day'].values, df['sym'].values, df['slot'].values])
    syms = head['symbols']

    out = []
    for st in STRATEGIES:
        r = res[st['id']]
        trades = pd.concat(r['trades']) if r['trades'] else pd.DataFrame(columns=EMPTY + ['month'])
        trades = trades.sort_values(['day', 'slot']) if len(trades) else trades
        mo = r['months']
        overall = period_stats(trades, mo)
        eq = trades['net'].astype(float).cumsum().values if len(trades) else np.array([0.0])
        overall['maxDrawdownR'] = round(float((np.maximum.accumulate(np.concatenate([[0], eq])) - np.concatenate([[0], eq])).max()), 2)
        overall['inrPerMonth'] = round(overall['inr'] / max(1, len(mo)))
        dev_t = trades[trades['month'] < exam_from] if len(trades) else trades
        exam_t = trades[trades['month'] >= exam_from] if len(trades) else trades
        dev = period_stats(dev_t, [m for m in mo if not m['exam']])
        exam = period_stats(exam_t, [m for m in mo if m['exam']])
        # the same trades executed three ways (a limit order that never filled = no trade)
        costs = []
        for cid, cname, col in COSTS:
            v = trades[np.isfinite(trades[col].astype(float))] if len(trades) else trades
            dv = v[v['month'] < exam_from] if len(v) else v
            ev = v[v['month'] >= exam_from] if len(v) else v
            def green(x):
                return [int(sum(1 for _, g_ in x.groupby('month') if g_[col].astype(float).sum() > 0)), int(x['month'].nunique())] if len(x) else [0, 0]
            costs.append({'id': cid, 'name': cname, 'fill': round(len(v) / len(trades), 3) if len(trades) else 0,
                          'overall': stats(v[col].astype(float)) if len(v) else stats([]), 'months': green(v),
                          'dev': stats(dv[col].astype(float)) if len(dv) else stats([]), 'devMonths': green(dv),
                          'exam': stats(ev[col].astype(float)) if len(ev) else stats([]), 'examMonths': green(ev)})
        ics = np.array(r['ic'])
        ic = {'mean': round(float(ics.mean()), 4) if len(ics) else None, 'positive': int((ics > 0).sum()), 'months': int(len(ics))}

        liked = []
        if len(trades):
            for side, name in ((1, 'long'), (-1, 'short')):
                sel = trades[trades['side'] == side]
                if len(sel) < 30:
                    continue
                part = df.loc[key.isin(pd.MultiIndex.from_arrays([sel['day'].values, sel['sym'].values.astype(np.int32), sel['slot'].values.astype(np.int32)]))]
                for f in feats:
                    sd = sd_all[f]
                    if not sd or not np.isfinite(sd):
                        continue
                    z = (float(part[f].mean()) - mean_all[f]) / sd
                    if np.isfinite(z):
                        liked.append({'side': name, 'f': f, 'label': labels.get(f, f), 'z': round(z, 2),
                                      'taken': round(float(part[f].median()), 3), 'all': round(med_all[f], 3)})
        liked.sort(key=lambda x: -abs(x['z']))

        # earlier months only: the exam months must never steer the next step
        by_side = {name: stats(dev_t.loc[dev_t['side'] == s_, 'net'], dev_t.loc[dev_t['side'] == s_, 'gross']) for s_, name in ((1, 'long'), (-1, 'short'))}
        by_hour = []
        if len(dev_t):
            h = (555 + dev_t['slot'].astype(int)) // 60
            for hour in sorted(h.unique()):
                s = stats(dev_t.loc[h == hour, 'net'], dev_t.loc[h == hour, 'gross'])
                s['hour'] = f'{int(hour):02d}:00'
                by_hour.append(s)
        g = r['gain']
        imp = g / g.sum() if g.sum() else g
        top = sorted(({'f': f, 'label': labels.get(f, f), 'share': round(float(v), 4)} for f, v in zip(feats, imp)), key=lambda x: -x['share'])[:15]
        recent = trades.tail(40)
        out.append({
            'id': st['id'], 'name': st['name'], 'kind': st['kind'], 'desc': st['desc'],
            'baseline': {'long': round(float(np.nanmean(df[st['L']])), 3), 'short': round(float(np.nanmean(df[st['S']])), 3),
                         'longGross': round(float(np.nanmean(df[st['Lg']])), 3), 'shortGross': round(float(np.nanmean(df[st['Sg']])), 3)},
            'overall': overall, 'dev': dev, 'exam': exam, 'ic': ic, 'costs': costs, 'bySide': by_side, 'byHour': by_hour, 'months': mo,
            'importance': top, 'liked': liked[:20],
            'recent': [{'day': x.day, 'sym': syms[int(x.sym)], 'time': f'{(555 + int(x.slot)) // 60:02d}:{(555 + int(x.slot)) % 60:02d}',
                        'side': 'LONG' if x.side == 1 else 'SHORT', 'pred': round(float(x.pred), 3), 'net': round(float(x.net), 2)}
                       for x in recent.itertuples()],
        })
        log(st['id'], 'overall', overall, 'dev', dev['netR'], 'exam', exam['netR'], 'ic', ic)

    best = max(out, key=lambda s: s['dev']['netR'] if s['dev']['n'] >= 100 else -9)
    result = {
        'v': 2, 'iteration': ITERATION, 'changes': CHANGES, 'runId': head['runId'], 'createdAt': int(time.time() * 1000),
        'period': {'from': head['from'], 'to': head['to']}, 'examFrom': exam_from,
        'rows': int(len(df)), 'stocks': len(syms), 'days': len(head['dates']),
        'setup': {'trainMonths': TRAIN_MONTHS, 'valMonths': VAL_MONTHS, 'examMonths': EXAM_MONTHS, 'maxPerDay': MAX_PER_DAY, 'maxPerSide': MAX_PER_SIDE,
                  'riskInr': RISK, 'wideStopAdr': head.get('wideStopAdr'), 'wideTargetAdr': head.get('wideTargetAdr'), 'closeStopAdr': head.get('closeStopAdr'),
                  'neutralTimes': [f'{(555 + s) // 60:02d}:{(555 + s) % 60:02d}' for s in NEUTRAL_SLOTS], 'neutralK': NEUTRAL_K},
        'baselineTight': {'long': round(float(np.nanmean(df['netL'])), 3), 'short': round(float(np.nanmean(df['netS'])), 3)},
        'best': best['id'], 'overall': best['overall'],
        'strategies': out,
    }
    json.dump(result, open(os.path.join(d, 'ml.json'), 'w'))


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'ml-data')
