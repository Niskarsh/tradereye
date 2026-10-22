"""
Algo Live, the model: trains the model that trades THIS month, exactly as the walk-forward trained the model for each
month it tested (scripts/ml_walkforward.py), and exports it for the live engine (lib/algoLive/model.ts).

    python scripts/ml_live.py <dir> [YYYY-MM]      reads <dir>/grid.bin + grid.json, writes <dir>/live-model.json

The strategy is the one iteration 10 picked: F (short, stop ½ the usual daily range, target ½ of it, out by 15:15),
entries 09:35-10:55, first come first served, at most 2 a day.
  * the models (5, averaged) learn from the TRAIN_MONTHS months before the 3 validation months, the bar to trade is the
    one that made the most on those 3 months with the cap of 2 a day (stand aside if none made money);
  * the trees are written out as plain arrays, with the exact facts (and their order) each model reads;
  * a parity sample: real rows and the ensemble's sklearn predictions, so the live engine can prove it scores the same.
"""
import datetime
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import ml_walkforward as ml  # noqa: E402

STRATEGY = 'fCap2'
PARITY_ROWS = 400


def export_tree(nodes):
    return {
        'value': [float(x) for x in nodes['value']],
        'feature': [int(x) for x in nodes['feature_idx']],
        'threshold': [float(x) for x in nodes['num_threshold']],
        'missingLeft': [int(x) for x in nodes['missing_go_to_left']],
        'left': [int(x) for x in nodes['left']],
        'right': [int(x) for x in nodes['right']],
        'leaf': [int(x) for x in nodes['is_leaf']],
    }


def export_model(m):
    if getattr(m, 'is_categorical_', None) is not None and np.any(m.is_categorical_):
        raise SystemExit('categorical features are not supported by the live engine')
    trees = []
    for preds in m._predictors:
        if len(preds) != 1:
            raise SystemExit('expected one tree per iteration (regression)')
        trees.append(export_tree(preds[0].nodes))
    return {'baseline': float(np.ravel(m._baseline_prediction)[0]), 'trees': trees}


def walk(tree, x):
    """the same walk as lib/algoLive/model.ts (and sklearn): NaN follows missingLeft, else x <= threshold goes left"""
    i = 0
    while not tree['leaf'][i]:
        v = x[tree['feature'][i]]
        if np.isnan(v):
            i = tree['left'][i] if tree['missingLeft'][i] else tree['right'][i]
        else:
            i = tree['left'][i] if v <= tree['threshold'][i] else tree['right'][i]
    return tree['value'][i]


def predict_exported(models, x):
    return float(np.mean([m['baseline'] + sum(walk(t, x) for t in m['trees']) for m in models]))


def main(d, month=None):
    head, df = ml.load(d)
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
    st = next(s for s in ml.STRATEGIES if s['id'] == STRATEGY)
    cols = np.array([i for i, f in enumerate(feats) if f not in ml.MARKET])
    y = df[st['S']].clip(-3, 3).values.astype(np.float32)
    ml.log('live model for', month, 'train', months[max(0, ti - ml.VAL_MONTHS - ml.TRAIN_MONTHS)], '-', months[ti - ml.VAL_MONTHS - 1],
           'bar on', months[ti - ml.VAL_MONTHS], '-', months[ti - 1], 'rows', int(fitm.sum()))
    ens = ml.fit(X, y, fitm, ti + 500, cols)  # the seed the walk-forward used for this month (side_model(st['S'], ti + 500))
    vpart = df.loc[val]
    vs = ens.predict(X[val])
    vl = np.full(len(vs), -np.inf)
    vl, vs = ml.allowed(vpart, vl, vs, st)
    thr, best_sum = ml.choose_bar(vpart, vl, vs, st)
    ok = thr is not None and best_sum > 0
    vtr = ml.pick_dir(vpart, vl, vs, thr, st) if ok else None
    ml.log('bar', thr, 'made', best_sum, 'on', 0 if vtr is None else len(vtr), 'validation trades', 'TRADE' if ok else 'STAND ASIDE')

    models = [export_model(m) for m in ens.models]
    # parity: rows from the latest month in the data (or the validation months), their facts and sklearn's prediction
    pool = np.flatnonzero(mi == ti) if (mi == ti).any() else np.flatnonzero(val)
    pick = np.random.default_rng(1).choice(pool, min(PARITY_ROWS, len(pool)), replace=False)
    sk = ens.predict(X[pick])
    worst = 0.0
    for j, r in enumerate(pick):
        worst = max(worst, abs(predict_exported(models, X[r, cols].astype(np.float64)) - float(sk[j])))
    ml.log('parity: exported trees vs sklearn, worst difference', worst)
    if worst > 1e-4:
        raise SystemExit('the exported trees do not reproduce sklearn')
    out = {
        'v': 1, 'strategy': STRATEGY, 'month': month, 'createdAt': int(datetime.datetime.now().timestamp() * 1000),
        'code': os.environ.get('GITHUB_SHA'), 'runId': head.get('runId'), 'dataTo': head.get('to'),
        'train': [months[max(0, ti - ml.VAL_MONTHS - ml.TRAIN_MONTHS)], months[ti - ml.VAL_MONTHS - 1]],
        'val': [months[ti - ml.VAL_MONTHS], months[ti - 1]],
        'features': [feats[i] for i in cols],  # the order each model reads
        'ranked': ml.RANKED,
        'threshold': None if not ok else float(thr), 'standAside': not ok,
        'valTrades': 0 if vtr is None else int(len(vtr)), 'valR': None if vtr is None else round(float(vtr['net'].mean()), 4),
        'valDays': int(vpart['day'].nunique()),
        'rules': {'firstSlot': st['firstSlot'], 'lastSlot': st['lastSlot'], 'cap': st['cap'], 'stopAdr': 0.5, 'targetAdr': st['targetAdr'], 'exitSlot': 360, 'riskInr': ml.RISK},
        'models': models,
        'parity': {'rows': [[None if not np.isfinite(v) else float(v) for v in X[r, cols]] for r in pick[:60]],
                   'pred': [float(p) for p in sk[:60]], 'days': [str(df['day'].values[r]) for r in pick[:60]],
                   'syms': [head['symbols'][int(df['sym'].values[r])] for r in pick[:60]], 'slots': [int(df['slot'].values[r]) for r in pick[:60]],
                   'worst': worst},
    }
    with open(os.path.join(d, 'live-model.json'), 'w') as f:
        json.dump(out, f)
    ml.log('written', os.path.join(d, 'live-model.json'), 'trees', sum(len(m['trees']) for m in models))


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'ml-data', sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None)
