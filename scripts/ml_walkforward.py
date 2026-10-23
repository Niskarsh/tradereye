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

ITERATION = 11
CHANGES = [
    'Next step on the same strategy, not a restart: F as Algo Live trades it (short, 09:35-10:55, first 2 a day) keeps its models, facts and bar recipe unchanged. Its trades are re-scored first, then the universe is refined by liquidity.',
    'Realistic fills by liquidity (10-day average volume): 5 lakh-3M shares 3 ticks worse on entry and on the 15:15 exit, the target must trade through by 3 ticks, stops slip 0.20% of price; 3-5M 2 ticks / 0.10%; 5-7M 1 tick / 0.06%; 7-10M 1 tick / 0.05%; 10M+ 1 tick / 0.04%. A stop hit inside a fast candle slips at least 10% of that 10-min candle\'s range. Dhan\'s charges as before.',
    'Five liquidity floors, each with the realistic fills: all (5 lakh+, the universe as now), 3M+, 5M+, 7M+, 10M+. Same models and predictions; only which stocks may be traded differs. Plus F as now (old fills) for comparison, and F\'s trades split by liquidity band.',
    'Rule fixed before this run: take the highest floor that keeps at least +0.04R a trade after realistic fills, t of at least 2.0 and 150 trades on the decide months; if none does, F is not trustworthy at real fills.',
    'Placebo kept (must show no edge); every floor gets the untouched months (a second look, not a clean test) and the five training draws.',
]
DECIDE_FROM = '2022-10'  # months before this are the untouched test: never in any walk-forward, diagnostic or decision
LOCKED = 'shortNear'     # the strategy locked for the noise check
SHADOW_FROM = '2026-11'  # months from here did not exist when iterations 1-9 were written: the forward test
# (iteration 11) liquidity floors, highest first, and the rule fixed before the run
VOL_ORDER = ['v10m', 'v7m', 'v5m', 'v3m', 'vAll']
VOL_RULE = {'netR': 0.04, 't': 2.0, 'n': 150}
BANDS = [(0, '5 lakh-3M'), (3e6, '3M-5M'), (5e6, '5M-7M'), (7e6, '7M-10M'), (10e6, '10M+')]
UNTOUCHED = ['shortNear', 'fCap2'] + VOL_ORDER  # tested on the untouched months
TOP_QUANTS = [0.99, 0.995, 0.997, 0.998, 0.999, 0.9993, 0.9995, 0.9997, 0.9998, 0.9999]
MARGIN = 5               # Dhan's intraday leverage
SHARD = 'main'           # 'main' (everything) or 'seed2' / 'seed3' (the locked strategy again, other random draws)
SEED_OFF = 0
TRAIN_MONTHS = 30
VAL_MONTHS = 3
EXAM_FROM = '2026-05'  # locked: the same exam months for every iteration
ENSEMBLE = 5
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
_F = {**_WIDE, 'only': -1, 'firstSlot': 20, 'targetAdr': 0.5, 'S': 'nbS', 'Sg': 'nbSg', 'S1': 'nbS1', 'S3': 'nbS3'}
_F2 = {**_F, 'lastSlot': 100, 'cap': 2}
_REAL = {**_F2, 'S': 'nbSx', 'yS': 'nbS'}  # traded on realistic fills; the model still learns F's own outcome (unchanged)
STRATEGIES = [
    {**_F, 'id': 'shortNear', 'name': 'F. Shorts, target ½ range (locked)',
     'desc': 'Short only, from 09:35: stop ½ of its usual daily range away, target ½ of it, out by 15:15. Locked after iteration 7.'},
    {**_F2, 'id': 'fCap2', 'name': 'F as live (old fills)',
     'desc': 'F to 10:55, first come first served, at most 2 trades a day: what Algo Live trades. Old fills (1 tick), for comparison.'},
    {**_REAL, 'id': 'vAll', 'name': 'F as live, real fills, all (5 lakh+)', 'bands': True,
     'desc': 'F as live, every stock in the universe as now (5 lakh+ shares a day), with fills by liquidity.'},
    {**_REAL, 'id': 'v3m', 'name': 'Real fills, 3M+', 'minVol': 3e6, 'desc': 'F as live, only stocks with 3M+ shares a day, fills by liquidity.'},
    {**_REAL, 'id': 'v5m', 'name': 'Real fills, 5M+', 'minVol': 5e6, 'desc': 'F as live, only stocks with 5M+ shares a day, fills by liquidity.'},
    {**_REAL, 'id': 'v7m', 'name': 'Real fills, 7M+', 'minVol': 7e6, 'desc': 'F as live, only stocks with 7M+ shares a day, fills by liquidity.'},
    {**_REAL, 'id': 'v10m', 'name': 'Real fills, 10M+', 'minVol': 1e7, 'desc': 'F as live, only stocks with 10M+ shares a day, fills by liquidity.'},
    {**_F2, 'id': 'placebo', 'name': 'Placebo (shuffled outcomes)', 'yS': 'nbS_shuf',
     'desc': 'F as live, but its models learned from outcomes shuffled among the stocks of the same month and minute (the facts carry no information). Traded on the real outcomes: it must show no edge.'},
]
COSTS = [('now', 'Market orders, ₹300 risk', 'net'),
         ('l1', 'Market orders, ~₹1 lakh position', 'p1'),
         ('l3', 'Market orders, ~₹3 lakh position', 'p3')]


def r2(x):
    x = float(x)
    return round(x, 3) if np.isfinite(x) else None


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
        idx = sub(mask, seed * 10 + e + 7919 * SEED_OFF)
        ok = idx[np.isfinite(y[idx])]
        ms.append(model(7 + e + 100 * SEED_OFF).fit(X[np.ix_(ok, cols)], y[ok]))
    return Ensemble(ms, cols)


EMPTY = ['day', 'sym', 'slot', 'side', 'pred', 'net', 'gross', 'p1', 'p3']


def allowed(part, pl, ps, st):
    """a strategy's limits: one side only, or decisions up to a time of day (not allowed = never picked)"""
    pl, ps = pl.copy(), ps.copy()
    if st.get('only') == -1:
        pl[:] = -np.inf
    if st.get('only') == 1:
        ps[:] = -np.inf
    if st.get('firstSlot'):
        early = part['slot'].values < st['firstSlot']
        pl[early] = -np.inf
        ps[early] = -np.inf
    if st.get('lastSlot'):
        late = part['slot'].values > st['lastSlot']
        pl[late] = -np.inf
        ps[late] = -np.inf
    if st.get('minVol') and 'avgVol' in part.columns:
        thin = ~(part['avgVol'].values >= st['minVol'])
        pl[thin] = -np.inf
        ps[thin] = -np.inf
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
    cap = st.get('cap') or MAX_PER_DAY
    c = c[c.groupby(['day', 'side'], sort=False).cumcount() < min(MAX_PER_SIDE, cap)]
    c = c[c.groupby('day', sort=False).cumcount() < min(MAX_PER_DAY, cap)]
    c['net'] = np.where(c['side'] == 1, c[st['L']], c[st['S']])
    c['gross'] = np.where(c['side'] == 1, c[st['Lg']], c[st['Sg']])
    c['p1'] = np.where(c['side'] == 1, c[st['L1']], c[st['S1']])
    c['p3'] = np.where(c['side'] == 1, c[st['L3']], c[st['S3']])
    return c[EMPTY]


def choose_bar(vpart, vl, vs, st):
    """the bar to trade, set on the validation months: the one that made the most there (at least 10 trades a month);
    a strict strategy ('perDay') only considers bars that let through at most that many trades a day on average"""
    vb = np.maximum(vl, vs)
    vb = vb[np.isfinite(vb)]
    qs = TOP_QUANTS if st.get('perDay') else QUANTS
    cands = sorted({float(q) for q in np.quantile(vb, qs) if q > 0}) if len(vb) else []
    days = max(1, vpart['day'].nunique())
    best_thr, best_sum = None, -1e18
    for thr in cands:
        tr = pick_dir(vpart, vl, vs, thr, st)
        if len(tr) < 10 * VAL_MONTHS:
            continue
        if st.get('perDay') and len(tr) / days > st['perDay']:
            continue
        if tr['net'].sum() > best_sum:
            best_thr, best_sum = thr, float(tr['net'].sum())
    return best_thr, best_sum


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
    months_all = sorted(df['month'].unique())
    held = [m for m in months_all if m < DECIDE_FROM]  # the untouched test: never in the walk-forward
    months = [m for m in months_all if m >= DECIDE_FROM]
    first_test = MIN_TRAIN_MONTHS + VAL_MONTHS
    if len(months) < first_test + 1:
        raise SystemExit('not enough months for walk-forward')
    exam_from = EXAM_FROM if EXAM_FROM in months[first_test:] else months[max(first_test, len(months) - EXAM_MONTHS)]
    all_cols = np.arange(len(feats))
    stock_cols = np.array([i for i, f in enumerate(feats) if f not in MARKET])
    mi = df['month'].map({m: i for i, m in enumerate(months)}).fillna(-1).astype(int).values  # -1 = untouched
    # learn on results clipped to [-3, 3] (gaps and data errors must not steer the model); trades are scored on the real result
    y = {c: df[c].clip(-3, 3).values.astype(np.float32) for c in ('wbL', 'wbS', 'ccL', 'ccS', 'nbS', 'fbS') if c in df.columns}

    res = {st['id']: {'trades': [], 'months': [], 'gain': np.zeros(len(feats)), 'ic': []} for st in STRATEGIES}
    y['excess'] = df['excess'].clip(-3, 3).values.astype(np.float32)
    if any(st_.get('yS') == 'nbS_shuf' for st_ in STRATEGIES):
        # placebo: each row learns the outcome of a random stock at the same month and minute (two random orders within
        # the same groups); the facts then carry no information about the outcome
        rng = np.random.default_rng(99)
        g1 = np.lexsort((rng.random(len(df)), df['slot'].values, mi))
        g2 = np.lexsort((rng.random(len(df)), df['slot'].values, mi))
        sh = np.empty(len(df), dtype=np.float32)
        sh[g1] = y['nbS'][g2]
        y['nbS_shuf'] = sh
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
                # strategies predicting the same result from the same facts share one model (they differ only in which trades
                # they may take); a shorts-only strategy needs no long model
                def side_model(lab, seed):
                    key = (lab, bool(st.get('noMarket')))
                    if key not in shared:
                        m_ = fit(X, y[lab], fitm, seed + (77 if lab.endswith('_shuf') else 0), cols)
                        shared[key] = (m_, m_.predict(X[val]), m_.predict(X[test]))
                    return shared[key]
                nv, nt = int(val.sum()), int(test.sum())
                if st.get('only') == -1:
                    ml, vl, tl = None, np.full(nv, -np.inf), np.full(nt, -np.inf)
                else:
                    ml, vl, tl = side_model(st['L'], ti)
                if st.get('only') == 1:
                    ms, vs, ts = None, np.full(nv, -np.inf), np.full(nt, -np.inf)
                else:
                    ms, vs, ts = side_model(st.get('yS', st['S']), ti + 500)
                vl, vs = allowed(vpart, vl, vs, st)
                tl_all, ts_all = tl, ts
                tl, ts = allowed(tpart, tl, ts, st)
                best_thr, best_sum = choose_bar(vpart, vl, vs, st)
                ok = best_thr is not None and best_sum > 0
                tr = pick_dir(tpart, tl, ts, best_thr if ok else 1e18, st)
                ics = [spearman(tl_all, tpart[st['L']].values) if ml else None, spearman(ts_all, tpart[st['S']].values) if ms else None]
                ics = [x for x in ics if x is not None]
                ic = float(np.mean(ics)) if ics else None
                if months[ti] < exam_from:  # what the model leans on: decide months only
                    add_gain(r['gain'], (ml.models if ml else []) + (ms.models if ms else []), cols)
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
                      'ic': None if ic is None else round(ic, 4), 'exam': exam_from <= months[ti] < SHADOW_FROM, 'shadow': months[ti] >= SHADOW_FROM,
                      'baseL': round(float(np.nanmean(tpart[st['L']])), 3), 'baseS': round(float(np.nanmean(tpart[st['S']])), 3)})
            r['months'].append(s)
            if ic is not None and months[ti] < exam_from:  # the signal headline: decide months only
                r['ic'].append(ic)
        log(months[ti], ' | '.join(f"{k}: {v['months'][-1]['n']} @ {v['months'][-1]['netR']}" for k, v in res.items() if v['months']),
            f'{time.time() - t0:.0f}s')

    labels = {f['k']: f['l'] for f in head['features']}
    for c in RANKED:
        labels[c + '_rk'] = f"Rank vs other stocks: {labels.get(c, c)} (0 = lowest, 1 = highest)"
    # every diagnostic compares against the decide months only (never the exam, never the untouched test)
    ref = df.loc[(mi >= 0) & (df['month'].values < exam_from)]
    mean_all = {f: float(ref[f].mean()) for f in feats}
    sd_all = {f: float(ref[f].std()) for f in feats}
    med_all = {f: float(ref[f].median()) for f in feats}
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
        exam_t = trades[(trades['month'] >= exam_from) & (trades['month'] < SHADOW_FROM)] if len(trades) else trades
        shadow_t = trades[trades['month'] >= SHADOW_FROM] if len(trades) else trades
        dev = period_stats(dev_t, [m for m in mo if not m['exam'] and not m['shadow']])
        exam = period_stats(exam_t, [m for m in mo if m['exam']])
        shadow = period_stats(shadow_t, [m for m in mo if m['shadow']])
        shadow['from'] = SHADOW_FROM
        exam['pass'] = None if exam['n'] < 30 else bool(exam['netR'] > 0)
        # the same trades executed three ways (a limit order that never filled = no trade)
        costs = []
        for cid, cname, col in COSTS:
            v = trades[np.isfinite(trades[col].astype(float))] if len(trades) else trades
            dv = v[v['month'] < exam_from] if len(v) else v
            ev = v[(v['month'] >= exam_from) & (v['month'] < SHADOW_FROM)] if len(v) else v
            def green(x):
                return [int(sum(1 for _, g_ in x.groupby('month') if g_[col].astype(float).sum() > 0)), int(x['month'].nunique())] if len(x) else [0, 0]
            costs.append({'id': cid, 'name': cname, 'fill': round(len(v) / len(trades), 3) if len(trades) else 0,
                          'overall': stats(v[col].astype(float)) if len(v) else stats([]), 'months': green(v),
                          'dev': stats(dv[col].astype(float)) if len(dv) else stats([]), 'devMonths': green(dv),
                          'exam': stats(ev[col].astype(float)) if len(ev) else stats([]), 'examMonths': green(ev)})
        # "your day": what trading it by hand would feel like (all tested months, after costs at ₹300 risk)
        daily = None
        if len(dev_t):  # decide months only
            tday = dev_t.groupby('day')['net'].agg(['sum', 'size'])
            wk = pd.to_datetime(dev_t['day']).dt.strftime('%G-W%V')
            tweek = dev_t.groupby(wk.values)['net'].sum()
            test_days = int(ref.loc[ref['month'].isin([m['month'] for m in mo if not m['exam'] and not m['shadow']]), 'day'].nunique())
            daily = {'tradingDays': test_days, 'daysWithTrades': int(len(tday)),
                     'perTradedDay': round(float(tday['size'].mean()), 2), 'maxPerDay': int(tday['size'].max()),
                     'at0935': round(float((dev_t['slot'].astype(int) == 20).mean()), 3),
                     'greenDays': round(float((tday['sum'] > 0).mean()), 3),
                     'worstDayR': round(float(tday['sum'].min()), 2), 'bestDayR': round(float(tday['sum'].max()), 2),
                     'worstWeekR': round(float(tweek.min()), 2), 'greenWeeks': round(float((tweek > 0).mean()), 3)}
        ics = np.array(r['ic'])
        ic = {'mean': round(float(ics.mean()), 4) if len(ics) else None, 'positive': int((ics > 0).sum()), 'months': int(len(ics))}

        liked = []
        if len(dev_t):  # decide months only
            for side, name in ((1, 'long'), (-1, 'short')):
                sel = dev_t[dev_t['side'] == side]
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
        # (iteration 11) the same trades at the old fills, and (for 'bands') where the result comes from
        old_fills = None
        if st['S'] == 'nbSx' and len(dev_t):
            o_ = dev_t.join(_lookup(df), on=['day', 'sym', 'slot'])['nbS'].astype(float)
            old_fills = stats(o_)
        bands = by_band(df, dev_t, st['S']) if st.get('bands') else None
        out.append({
            'id': st['id'], 'name': st['name'], 'kind': st['kind'], 'desc': st['desc'],
            'baseline': {'long': round(float(np.nanmean(ref[st['L']])), 3), 'short': round(float(np.nanmean(ref[st['S']])), 3),
                         'longGross': round(float(np.nanmean(ref[st['Lg']])), 3), 'shortGross': round(float(np.nanmean(ref[st['Sg']])), 3)},
            'targetAdr': st.get('targetAdr'),
            'overall': overall, 'dev': dev, 'exam': exam, 'shadow': shadow, 'money': money_of(dev_t, dev, costs, ref, st), 'ic': ic, 'costs': costs, 'daily': daily, 'bySide': by_side, 'byHour': by_hour, 'months': mo,
            'importance': top, 'liked': liked[:20], 'oldFills': old_fills, 'bands': bands, 'minVol': st.get('minVol'),
            'recent': [{'day': x.day, 'sym': syms[int(x.sym)], 'time': f'{(555 + int(x.slot)) // 60:02d}:{(555 + int(x.slot)) % 60:02d}',
                        'side': 'LONG' if x.side == 1 else 'SHORT', 'pred': round(float(x.pred), 3), 'net': round(float(x.net), 2)}
                       for x in recent.itertuples()],
            # every out-of-sample trade (kept with the iteration, so any later version can be compared trade by trade)
            'tradeCols': ['day', 'sym', 'time', 'side', 'pred', 'net', 'gross', 'p1', 'p3'],
            'trades': [[x.day, syms[int(x.sym)], f'{(555 + int(x.slot)) // 60:02d}:{(555 + int(x.slot)) % 60:02d}', int(x.side),
                        round(float(x.pred), 3), r2(x.net), r2(x.gross), r2(x.p1), r2(x.p3)] for x in trades.itertuples()],
        })
        log(st['id'], 'overall', overall, 'dev', dev['netR'], 'exam', exam['netR'], 'ic', ic)

    best = max(out, key=lambda s: s['dev']['netR'] if s['dev']['n'] >= 100 and s['id'] != 'placebo' else -9)
    untouched = [u for u in (untouched_test(df, X, y, mi, months, held, stock_cols, syms, sid) for sid in UNTOUCHED) if u] if SHARD == 'main' and held else []
    result = {
        'v': 2, 'iteration': ITERATION, 'changes': CHANGES, 'runId': head['runId'], 'createdAt': int(time.time() * 1000),
        'code': os.environ.get('GITHUB_SHA'),  # the exact code that made these results
        'period': {'from': head['from'], 'to': head['to']}, 'examFrom': exam_from,
        'rows': int(len(df)), 'stocks': len(syms), 'days': len(head['dates']),
        'setup': {'trainMonths': TRAIN_MONTHS, 'valMonths': VAL_MONTHS, 'examMonths': EXAM_MONTHS, 'maxPerDay': MAX_PER_DAY, 'maxPerSide': MAX_PER_SIDE,
                  'riskInr': RISK, 'wideStopAdr': head.get('wideStopAdr'), 'wideTargetAdr': head.get('wideTargetAdr'), 'closeStopAdr': head.get('closeStopAdr'),
                  'neutralTimes': [f'{(555 + s) // 60:02d}:{(555 + s) % 60:02d}' for s in NEUTRAL_SLOTS], 'neutralK': NEUTRAL_K},
        'baselineTight': {'long': round(float(np.nanmean(ref['netL'])), 3), 'short': round(float(np.nanmean(ref['netS'])), 3)},
        'best': best['id'], 'locked': LOCKED, 'overall': best['overall'], 'shard': SHARD, 'seedOffset': SEED_OFF,
        'decideFrom': DECIDE_FROM, 'shadowFrom': SHADOW_FROM, 'untouched': untouched, 'volChoice': vol_choice(out),
        'strategies': out,
    }
    json.dump(result, open(os.path.join(d, 'ml.json' if SHARD == 'main' else f'ml-{SHARD}.json'), 'w'))


def vol_choice(out):
    """the rule fixed before iteration 11: the highest liquidity floor that keeps VOL_RULE on the decide months"""
    by = {s_['id']: s_ for s_ in out}
    tried = []
    pick = None
    for sid in VOL_ORDER:
        s_ = by.get(sid)
        if not s_:
            continue
        d_ = s_['dev']
        ok = d_['n'] >= VOL_RULE['n'] and d_['netR'] >= VOL_RULE['netR'] and d_['t'] >= VOL_RULE['t']
        tried.append({'id': sid, 'name': s_['name'], 'netR': d_['netR'], 't': d_['t'], 'n': d_['n'],
                      'perMonth': (s_.get('money') or {}).get('tradesPerMonth'), 'ok': bool(ok)})
        if ok and pick is None:
            pick = s_
    if not tried:
        return None
    return {'id': pick['id'] if pick else None, 'name': pick['name'] if pick else None, 'rule': VOL_RULE, 'order': VOL_ORDER, 'tried': tried}


_LOOKUP = {}


def _lookup(df):
    """avgVol and the old-fill result of every row, by (day, sym, slot), built once"""
    if 'k' not in _LOOKUP:
        _LOOKUP['k'] = df.set_index(['day', 'sym', 'slot'])[['avgVol', 'nbS']]
    return _LOOKUP['k']


def by_band(df, trades, real_col):
    """a strategy's decide-month trades split by liquidity band, with the realistic and the old fills side by side"""
    if not len(trades) or 'avgVol' not in df.columns:
        return []
    j = trades.join(_lookup(df), on=['day', 'sym', 'slot'])
    out = []
    edges = [b[0] for b in BANDS] + [float('inf')]
    for i, (lo, name) in enumerate(BANDS):
        x = j[(j['avgVol'] >= lo) & (j['avgVol'] < edges[i + 1])]
        s_ = stats(x['net'].astype(float))
        s_['old'] = stats(x['nbS'].astype(float))['netR'] if len(x) else 0
        s_['band'] = name
        out.append(s_)
    return out


def money_of(dev_t, dev, costs, ref, st):
    """what the decide months mean in rupees: the position a ₹300 risk buys (the stop is ½ the usual daily range), its
    margin at 5×, the most trades open at once, and the capital that also survives the worst run of losses"""
    if not len(dev_t) or not dev['monthsTotal']:
        return None
    key = pd.MultiIndex.from_arrays([ref['day'].values, ref['sym'].values, ref['slot'].values])
    taken = ref.loc[key.isin(pd.MultiIndex.from_arrays([dev_t['day'].values, dev_t['sym'].values.astype(np.int32), dev_t['slot'].values.astype(np.int32)]))]
    stop_pct = float(taken['adrPct'].median()) * 0.5 if len(taken) else float('nan')
    if not np.isfinite(stop_pct) or stop_pct < 0.2:
        return None
    pos = RISK / (stop_pct / 100)
    eq = np.concatenate([[0], dev_t['net'].astype(float).cumsum().values])
    max_dd = float((np.maximum.accumulate(eq) - eq).max())
    per_day = int(dev_t.groupby('day').size().max())
    months_n = dev['monthsTotal']
    per_month = dev['inr'] / months_n
    capital = pos / MARGIN * per_day + max_dd * RISK
    by_m = dev_t.groupby('month')['net'].sum() * RISK
    sizes = []
    for cid, notional in (('l1', 100_000), ('l3', 300_000)):
        c = next((x for x in costs if x['id'] == cid), None)
        if c and c['dev']['n']:
            risk = notional * stop_pct / 100
            pm = c['dev']['netR'] * risk * dev['n'] / months_n
            cap = notional / MARGIN * per_day + max_dd * risk
            sizes.append({'position': notional, 'risk': round(risk), 'netR': c['dev']['netR'], 'perMonth': round(pm), 'capital': round(cap), 'pct': round(100 * pm / cap, 1)})
    return {'stopPct': round(stop_pct, 2), 'position': round(pos), 'margin': round(pos / MARGIN), 'maxPerDay': per_day, 'tradesPerMonth': round(dev['n'] / months_n, 1),
            'perTrade': round(dev['netR'] * RISK), 'perMonth': round(per_month), 'worstMonth': round(float(by_m.min())), 'bestMonth': round(float(by_m.max())),
            'maxDrawdownR': round(max_dd, 1), 'capital': round(capital), 'pct': round(100 * per_month / capital, 1), 'bigger': sizes}


_UNTOUCHED_MODELS = {}


def untouched_test(df, X, y, mi, months, held, cols, syms, sid):
    """The locked strategy, once, on months never used before. No earlier data exists, so its models learn from the
    TRAIN_MONTHS decide months right after the untouched months, and the bar is set on the VAL_MONTHS after those (the
    walk-forward recipe, mirrored). Every fact is still only what was known at that minute of that day."""
    st = next((s_ for s_ in STRATEGIES if s_['id'] == sid), None)
    if st is None or len(months) < TRAIN_MONTHS + VAL_MONTHS:
        return None
    fitm = (mi >= 0) & (mi < TRAIN_MONTHS)
    val = (mi >= TRAIN_MONTHS) & (mi < TRAIN_MONTHS + VAL_MONTHS)
    hold = mi == -1
    lab = st.get('yS', st['S'])
    if lab not in _UNTOUCHED_MODELS:  # versions that differ only in which trades they take share the model
        m_ = fit(X, y[lab], fitm, 4242, cols)
        _UNTOUCHED_MODELS[lab] = (m_.predict(X[val]), m_.predict(X[hold]))
    vpart, hpart = df.loc[val], df.loc[hold]
    vs, hs = _UNTOUCHED_MODELS[lab]
    vl, hl = np.full(len(vs), -np.inf), np.full(len(hs), -np.inf)
    vl, vs = allowed(vpart, vl, vs, st)
    hl_, hs_ = allowed(hpart, hl, hs, st)
    best_thr, best_sum = choose_bar(vpart, vl, vs, st)
    if best_thr is None:
        return {'id': st['id'], 'name': st['name'], 'months': held, 'note': 'no bar was profitable on the months used to set it', 'overall': stats([])}
    tr = pick_dir(hpart, hl_, hs_, best_thr, st)
    tr = tr.assign(month=tr['day'].str.slice(0, 7))
    mstats = []
    for m in held:
        x = tr[tr['month'] == m]
        s_ = stats(x['net'], x['gross'])
        s_['month'] = m
        mstats.append(s_)
    o = period_stats(tr, mstats)
    log('untouched', st['id'], o)
    return {'id': st['id'], 'name': st['name'], 'targetAdr': st.get('targetAdr'), 'from': held[0], 'to': held[-1], 'thr': round(best_thr, 4), 'overall': o, 'months': mstats,
            'trainMonths': [months[0], months[TRAIN_MONTHS - 1]], 'valMonths': [months[TRAIN_MONTHS], months[TRAIN_MONTHS + VAL_MONTHS - 1]],
            'tradeCols': ['day', 'sym', 'time', 'side', 'pred', 'net', 'gross', 'p1', 'p3'],
            'trades': [[x.day, syms[int(x.sym)], f'{(555 + int(x.slot)) // 60:02d}:{(555 + int(x.slot)) % 60:02d}', int(x.side),
                        round(float(x.pred), 3), r2(x.net), r2(x.gross), r2(x.p1), r2(x.p3)] for x in tr.itertuples()]}


if __name__ == '__main__':
    # python scripts/ml_walkforward.py <dir> [main | seed2 | seed3]
    SHARD = sys.argv[2] if len(sys.argv) > 2 else 'main'
    if SHARD != 'main':
        SEED_OFF = int(SHARD.replace('seed', '') or 0)
        STRATEGIES = [s_ for s_ in STRATEGIES if s_['id'] in (LOCKED, 'fCap2') or s_['id'] in VOL_ORDER]  # F and its versions (one shared model)
    main(sys.argv[1] if len(sys.argv) > 1 else 'ml-data')
