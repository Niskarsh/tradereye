"""
Algo Lab iteration 13 (the wide-universe workflow): is iteration 12's edge on ₹250-1000 still there when every fill is
worse than modelled?

    python scripts/ml_wide.py <dir> <narrow | wide> <main | seed2 | ...>     writes <dir>/wide-<universe>-<shard>.json

Iteration 12 (₹250-1000 against ₹250-340, liquidity floors) is kept as it ran under the git tag algo-iter-12-*.

It runs ml_walkforward.py's own pipeline, unchanged, with this iteration's settings put in from here. ml_walkforward.py
itself is not edited: the normal backtest Re-run and the monthly Algo Live model (scripts/ml_live.py) read it and stay as
they are.

Both universes use the dataset written by lib/ml/wideJob.ts (decisions 09:25-10:55 only, ETFs left out), so the
comparison is like for like. 'narrow' keeps only the stock-days inside ₹250-340 and computes the ranks among them alone.

No strategy id here is 'fCap2': the pages that follow the live strategy look for that id and must never find this run.
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import ml_walkforward as ml  # noqa: E402

ITERATION = 13
CAP = 2  # trades a day, as Algo Live: also enforced on every strategy's trades after the run (check_cap)

CHANGES = [
    'Iteration 12 found F (short, 09:35-10:55, first 2 a day) much better on ₹250-1000 than on ₹250-340: +0.12R a trade, t 4.7, 24 of 29 months green, exam passed. Its edge sat in the thinnest stocks (₹17-100 crore a day): every liquidity floor halved it. Thin stocks are where real fills are most likely worse than modelled, so this iteration asks one question: does the edge survive worse fills?',
    'Same strategy, same universe, same facts. The model is trained once; only the cost of each trade changes, and the bar to trade is set again on those costs (as it would be live).',
    'Worse fills, as a share of the price on every trade (on top of iteration 11\'s real fills: 1-3 ticks by liquidity, stops slipping 0.04-0.2% of the price): +0.1% (about twice a ₹500 stock\'s spread, the test), +0.2%, and +0.2% only on stocks under ₹100 crore a day. On a stop of half the usual daily range, 0.1% costs about 0.04R a trade.',
    'ETFs left out (MONQ50, MON100, NIFTYBEES and the like were being picked: they are funds, and the US-tracking ones move on their premium in the Indian morning).',
    'At most 2 trades a day and 2 a side for every version, checked on every trade after the run (the job fails if any day has more).',
    'Rule fixed before this run, decide months only: with +0.1% worse fills it still makes +0.04R a trade, t of at least 2.0 and 150 trades; its average over 5 training draws beats the best draw of the ₹250-340 control; it makes more R in total; it is profitable on the exam months; the placebo shows no edge. All five, or it is not a candidate for Algo Live.',
]

# extra cost of each version, % of the price on every trade (entry and exit together)
STRESS = {'wS1': 0.1, 'wS2': 0.2}
THIN_VOL = 3e6       # under ₹100 crore a day (avgVol here is shares scaled to a ₹340 stock, lib/ml/grid.ts wideVol)
THIN_STRESS = 0.2

NARROW = [
    {**ml._REAL, 'id': 'nF', 'name': '₹250–340 (control), real fills', 'desc': 'F as live on the stocks Algo Live trades today, with fills by liquidity.'},
]
WIDE = [
    {**ml._REAL, 'id': 'wAll', 'name': '₹250–1000, real fills', 'bands': True, 'desc': 'Iteration 12\'s best again (ETFs out): F as live on every stock ₹250-1000 above the liquidity floor, with fills by liquidity.'},
    {**ml._REAL, 'id': 'wS1', 'S': 'nbSx_s1', 'name': '₹250–1000, fills 0.1% worse (the test)', 'bands': True, 'desc': 'As above, every trade costs another 0.1% of the price.'},
    {**ml._REAL, 'id': 'wS2', 'S': 'nbSx_s2', 'name': '₹250–1000, fills 0.2% worse', 'bands': True, 'desc': 'As above, every trade costs another 0.2% of the price: where does it break?'},
    {**ml._REAL, 'id': 'wThin', 'S': 'nbSx_thin', 'name': '₹250–1000, thin stocks 0.2% worse', 'bands': True, 'desc': 'Only stocks under ₹100 crore a day cost another 0.2% of the price: is the edge just optimistic fills in thin stocks?'},
    {**ml._REAL, 'id': 'placebo', 'name': 'Placebo (shuffled outcomes)', 'yS': 'nbS_shuf', 'desc': 'Learned from outcomes shuffled among stocks of the same month and minute. Traded on the real outcomes: it must show no edge.'},
]
# the liquidity measure here is shares scaled to a ₹340 stock (lib/ml/grid.ts wideVol), so these are rupees a day
BANDS = [(0, '₹17–100 cr'), (3e6, '₹100–170 cr'), (5e6, '₹170–240 cr'), (7e6, '₹240–340 cr'), (10e6, '₹340 cr+')]

_load = ml.load


def stress_r(df, pct):
    """an extra cost of pct % of the price, in R: the stop is half the usual daily range (adrPct, % of the price)"""
    stop = 0.5 * df['adrPct'].astype(float).values
    ok = np.isfinite(stop) & (stop > 0)
    fallback = float(np.median(stop[ok])) if ok.any() else 1.0  # a row without its range: the typical one
    return pct / np.where(ok, stop, fallback)


def add_stress(df):
    for col, pct in STRESS.items():
        df[f'nbSx_{col[1:].lower()}'] = df['nbSx'].values - stress_r(df, pct)
    thin = df['avgVol'].values < THIN_VOL
    df['nbSx_thin'] = df['nbSx'].values - np.where(thin, stress_r(df, THIN_STRESS), 0.0)
    return df


def configure(universe, shard):
    """puts this iteration's settings into ml_walkforward for this process only"""
    wide = universe == 'wide'
    ml.ITERATION = ITERATION
    ml.CHANGES = CHANGES
    ml.BANDS = BANDS
    ml.MAX_PER_DAY = CAP
    ml.MAX_PER_SIDE = CAP
    ml.SHARD = shard
    ml.SEED_OFF = 0 if shard == 'main' else int(shard.replace('seed', '') or 0)
    strategies = WIDE if wide else NARROW
    ml.STRATEGIES = strategies if shard == 'main' else [s for s in strategies if s['id'] != 'placebo']
    ml.LOCKED = 'wS1' if wide else 'nF'
    ml.VOL_ORDER = ['wS1'] if wide else ['nF']
    ml.UNTOUCHED = [s['id'] for s in strategies if s['id'] != 'placebo']
    ml._UNTOUCHED_MODELS.clear()
    ml._LOOKUP.clear()

    def load(d):
        head, df = _load(d)
        if not wide:
            df = df[df['inNarrow'].values == 1].reset_index(drop=True)
        return head, add_stress(df)
    ml.load = load


def check_cap(res):
    """every strategy's out-of-sample trades: never more than CAP a day (else the job fails, nothing is filed)"""
    for s in res['strategies']:
        per_day = {}
        for t in s['trades']:
            per_day[t[0]] = per_day.get(t[0], 0) + 1
        worst = max(per_day.values(), default=0)
        if worst > CAP:
            raise SystemExit(f"{s['id']}: {worst} trades on one day, more than {CAP}")


def main(d, universe, shard):
    if universe not in ('narrow', 'wide'):
        raise SystemExit(f'unknown universe {universe}')
    configure(universe, shard)
    ml.main(d)
    made = os.path.join(d, 'ml.json' if shard == 'main' else f'ml-{shard}.json')
    res = json.load(open(made))
    check_cap(res)
    if universe == 'narrow':  # the stocks it actually had, not the whole dataset's list
        _, df = ml.load(d)
        res['stocks'] = int(df['sym'].nunique())
    json.dump(res, open(os.path.join(d, f'wide-{universe}-{shard}.json'), 'w'))
    os.remove(made)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else 'main')
