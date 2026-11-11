"""
Algo Live, the wide model: trains the model that trades THIS month for iteration 15's pick, exactly as the Algo Lab
walk-forward trained it for each month it tested (scripts/ml_wide.py on scripts/ml_walkforward.py), and exports it for the
live engine (lib/algoLive/model.ts). The narrow model (iteration 10, scripts/ml_live.py) is not touched by this script.

    python scripts/ml_live_wide.py <dir> [YYYY-MM]   reads <dir>/grid.bin + grid.json (the Algo Lab "grid-wide" dataset),
                                                     writes <dir>/live-model.json

The strategy is iteration 15's pick, w10_f100_c3_g:
  * F: short only, entries 09:35-10:55 on 10-minute closes, stop ½ the usual daily range, target ½ of it, out by 15:15;
  * ₹250-1000 stocks (the wide universe), only those trading at least ₹100 crore a day, at most 3 a day;
  * the market gate: no trades on a day the market's 20-day move (the median 20-day move of every stock in the universe at
    the first close) is in the top third of its last 250 days;
  * the models learn F's own outcome (nbS); the bar is the one that made the most on the 3 months before, priced at ₹10 lakh
    positions (big-position charges and the square-root market impact); if none made money, it stands aside.

Everything that defines the strategy is pinned HERE, not imported from scripts/ml_wide.py: a later Algo Lab iteration may
change that file, and that must never change what Algo Live trades. tests/py/test_ml_live_wide.py checks the pinned rules
against iteration 16's code, which ran this strategy as its reference.
"""
import datetime
import json
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
import ml_walkforward as ml  # noqa: E402
from ml_live import export_model, predict_exported, PARITY_ROWS  # noqa: E402

ITERATION = 15
STRATEGY = 'w10_f100_c3_g'
STRATEGY_NAME = '₹250–1000 stocks, ₹100 crore+ a day, 3 a day, market gate'
UNIVERSE = 'wide'

# ---- the strategy, pinned (iteration 15 / 16 values) --------------------------------------------------------------------
REF_PRICE = 340              # lib/ml/grid.ts WIDE_REF_PRICE: avgVol is shares scaled to a ₹340 stock above it
MIN_TURNOVER = 100 * 1e7     # ₹100 crore a day
CAP = 3
POSITION = 1_000_000         # the bar is chosen on ₹10 lakh positions
IMPACT_K = 1.25
GATE_DAYS, GATE_MIN, GATE_Q = 250, 60, 2 / 3
GATE_KEEP = 320              # market-move days exported, so the live engine can work out the gate until the next model
STRAT = {**ml._REAL, 'id': STRATEGY, 'S': 'nbSx_t10', 'cap': CAP, 'minTurnover': MIN_TURNOVER, 'gate': True}


def turnover_rs(df):
    """average daily turnover in rupees: avgVol is shares below ₹340 and shares x price / 340 above it"""
    return df['avgVol'].astype(float).values * np.minimum(df['priceRs'].astype(float).values, REF_PRICE)


def add_label(df):
    """F's outcome at ₹10 lakh positions: real fills, big-position charges (nbS3 - nbS) and the market impact of the order"""
    v = turnover_rs(df)
    ok = np.isfinite(v) & (v > 0)
    fallback = float(np.median(v[ok])) if ok.any() else 1e9
    impact = IMPACT_K * np.sqrt(POSITION / np.where(ok, v, fallback))
    df['nbSx_t10'] = df['nbSx'].values + (df['nbS3'].values - df['nbS'].values) - impact
    return df


def market_move(df):
    """per day: the median 20-day move (%) of every stock in the dataset at the day's first close"""
    first = df[df['slot'].values == df['slot'].min()]
    return first.groupby('day', sort=True)['ret20d'].median()


def hot_days(mkt):
    """the days the market's 20-day move is in the top third of its own last GATE_DAYS days (before today; GATE_MIN days of
    history at least, else not hot). lib/algoLive/gate.ts works it out the same way."""
    v = mkt.values.astype(float)
    hot = np.zeros(len(v), dtype=bool)
    for i in range(len(v)):
        past = v[max(0, i - GATE_DAYS):i]
        past = past[np.isfinite(past)]
        if len(past) >= GATE_MIN and np.isfinite(v[i]):
            hot[i] = v[i] > np.quantile(past, GATE_Q)
    return pd.Series(hot, index=mkt.index)


_allowed = ml.allowed


def allowed(part, pl, ps, st):
    """ml_walkforward's limits (shorts only, 09:35-10:55), then the turnover floor and the market gate"""
    pl, ps = _allowed(part, pl, ps, st)
    thin = ~(turnover_rs(part) >= MIN_TURNOVER)
    pl[thin] = -np.inf
    ps[thin] = -np.inf
    hot = part['hot'].values == 1
    pl[hot] = -np.inf
    ps[hot] = -np.inf
    return pl, ps


def main(d, month=None):
    ml.MAX_PER_DAY = CAP
    ml.MAX_PER_SIDE = CAP
    head, df = ml.load(d)
    mkt = market_move(df)
    hot = hot_days(mkt)
    df['hot'] = df['day'].map(hot).fillna(False).astype(np.int8).values
    df = add_label(df)
    df = ml.add_ranks(df)
    feats = [f['k'] for f in head['features']] + [c + '_rk' for c in ml.RANKED]
    X = df[feats].values.astype(np.float32)
    months = sorted(m for m in df['month'].unique() if m >= ml.DECIDE_FROM)
    month = month or datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=5, minutes=30))).strftime('%Y-%m')
    ti = months.index(month) if month in months else len(months)
    if month not in months and months and month < months[-1]:
        raise SystemExit(f'{month} is before the last month of the data ({months[-1]})')
    mi = df['month'].map({m: i for i, m in enumerate(months)}).fillna(-1).astype(int).values
    fitm = (mi >= max(0, ti - ml.VAL_MONTHS - ml.TRAIN_MONTHS)) & (mi < ti - ml.VAL_MONTHS)
    val = (mi >= ti - ml.VAL_MONTHS) & (mi < ti)
    st = STRAT
    cols = np.array([i for i, f in enumerate(feats) if f not in ml.MARKET])
    y = df[st['yS']].clip(-3, 3).values.astype(np.float32)
    ml.log('wide live model for', month, 'train', months[max(0, ti - ml.VAL_MONTHS - ml.TRAIN_MONTHS)], '-', months[ti - ml.VAL_MONTHS - 1],
           'bar on', months[ti - ml.VAL_MONTHS], '-', months[ti - 1], 'rows', int(fitm.sum()))
    ens = ml.fit(X, y, fitm, ti + 500, cols)  # the seed the walk-forward used for this month (side_model(st['yS'], ti + 500), main draw)
    vpart = df.loc[val]
    vs = ens.predict(X[val])
    vl = np.full(len(vs), -np.inf)
    vl, vs = allowed(vpart, vl, vs, st)
    thr, best_sum = ml.choose_bar(vpart, vl, vs, st)
    ok = thr is not None and best_sum > 0
    vtr = ml.pick_dir(vpart, vl, vs, thr, st) if ok else None
    ml.log('bar', thr, 'made', best_sum, 'on', 0 if vtr is None else len(vtr), 'validation trades', 'TRADE' if ok else 'STAND ASIDE')

    models = [export_model(m) for m in ens.models]
    gain = np.zeros(len(feats))
    ml.add_gain(gain, ens.models, cols)
    labels = {f['k']: f['l'] for f in head['features']}
    for c in ml.RANKED:
        labels[c + '_rk'] = f"Rank vs other stocks: {labels.get(c, c)} (0 = lowest, 1 = highest)"
    facts = [{'f': f, 'label': labels.get(f, f), 'share': sh} for f, sh in (ml.top_facts(gain, feats, 15) or [])]
    pool = np.flatnonzero(mi == ti) if (mi == ti).any() else np.flatnonzero(val)
    pick = np.random.default_rng(1).choice(pool, min(PARITY_ROWS, len(pool)), replace=False)
    sk = ens.predict(X[pick])
    worst = 0.0
    for j, r in enumerate(pick):
        worst = max(worst, abs(predict_exported(models, X[r, cols].astype(np.float64)) - float(sk[j])))
    ml.log('parity: exported trees vs sklearn, worst difference', worst)
    print(f'::notice title=Python parity::exported trees vs sklearn on {len(pick)} rows: worst {worst}; bar {thr} ({"trade" if ok else "stand aside"})', flush=True)
    if worst > 1e-4:
        raise SystemExit('the exported trees do not reproduce sklearn')
    keep = mkt.iloc[-GATE_KEEP:]
    out = {
        'v': 1, 'strategy': STRATEGY, 'iteration': ITERATION, 'strategyName': STRATEGY_NAME, 'universe': UNIVERSE, 'month': month,
        'createdAt': int(datetime.datetime.now().timestamp() * 1000),
        'code': os.environ.get('GITHUB_SHA'), 'runId': head.get('runId'), 'dataTo': head.get('to'),
        'train': [months[max(0, ti - ml.VAL_MONTHS - ml.TRAIN_MONTHS)], months[ti - ml.VAL_MONTHS - 1]],
        'val': [months[ti - ml.VAL_MONTHS], months[ti - 1]],
        'features': [feats[i] for i in cols],
        'ranked': ml.RANKED,
        'threshold': None if not ok else float(thr), 'standAside': not ok,
        'valTrades': 0 if vtr is None else int(len(vtr)), 'valR': None if vtr is None or not len(vtr) else round(float(vtr['net'].mean()), 4),
        'valDays': int(vpart['day'].nunique()),
        'facts': facts, 'shares': ml.all_shares(gain, feats), 'factLabels': labels,
        'rules': {'firstSlot': st['firstSlot'], 'lastSlot': st['lastSlot'], 'cap': CAP, 'stopAdr': 0.5, 'targetAdr': st['targetAdr'], 'exitSlot': 360, 'riskInr': ml.RISK,
                  'minTurnoverRs': MIN_TURNOVER, 'refPrice': REF_PRICE, 'positionInr': POSITION},
        # the market gate: its own history (day, median 20-day move %) and whether each of those days was hot, so the live
        # engine can prove it works the gate out the same way (scripts/ml-live-check.ts)
        'gate': {'days': GATE_DAYS, 'min': GATE_MIN, 'q': GATE_Q,
                 'history': [[str(dd), None if not np.isfinite(v) else round(float(v), 6)] for dd, v in keep.items()],
                 'hot': [str(dd) for dd in keep.index if bool(hot.get(dd, False))]},
        'models': models,
        'parity': {'rows': [[None if not np.isfinite(v) else float(v) for v in X[r, cols]] for r in pick[:60]],
                   'pred': [float(p) for p in sk[:60]], 'days': [str(df['day'].values[r]) for r in pick[:60]],
                   'syms': [head['symbols'][int(df['sym'].values[r])] for r in pick[:60]], 'slots': [int(df['slot'].values[r]) for r in pick[:60]],
                   'worst': worst},
    }
    with open(os.path.join(d, 'live-model.json'), 'w') as f:
        json.dump(out, f, allow_nan=False)
    ml.log('written', os.path.join(d, 'live-model.json'), 'trees', sum(len(m['trees']) for m in models), 'hot days kept', len(out['gate']['hot']))


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'ml-data', sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None)
