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
    'Iteration 12 found F (short, 09:35-10:55, first 2 a day) much better on ₹250-1000 than on ₹250-340: +0.12R a trade, t 4.7, 24 of 29 months green, exam passed. But every liquidity floor halved it: the edge sits partly in thinner stocks. The question now is the one that matters for the goal of ₹1 lakh a month: does it hold at the size that goal needs?',
    'The size: at ~+0.15R a trade and ~30 trades a month, ₹1 lakh a month is ~₹22,000 of risk a trade, a position of about ₹10 lakh. Each trade is priced at that size: big-position charges (cheaper per R) and the market impact of a ₹10 lakh order in that stock, by the square-root rule desks use (1.25 x the square root of the order over the stock\'s daily turnover, in R: ~0.09R in a ₹20 crore a day stock, ~0.04R at ₹100 crore, ~0.02R at ₹340 crore). Thin stocks are not cut out, they just cost what they would cost.',
    'Same model (trained once); only the cost of each trade changes, and the bar to trade is set again on those costs, as it would be live. Versions: ₹300 risk (as iteration 12), ₹10 lakh positions (the test), ₹20 lakh (room to grow past the target). The ₹250-340 control is priced the same way.',
    'ETFs left out (MONQ50, MON100, NIFTYBEES and the like were being picked: they are funds, and the US-tracking ones move on their premium in the Indian morning).',
    'At most 2 trades a day and 2 a side for every version, checked on every trade after the run (the job fails if any day has more).',
    'Rule fixed before this run, decide months only, at ₹10 lakh positions: +0.04R a trade, t of at least 2.0 and 150 trades; its average over 5 training draws beats the best draw of the ₹250-340 control at the same size; more R in total; profitable on the exam months; the placebo shows no edge. All five, or it is not a candidate for Algo Live. The page also shows what it makes a month at ₹10 lakh positions against the ₹1 lakh goal.',
]

# Your target: ₹1 lakh a month. At about +0.15R a trade (iteration 12 at big-position charges) and ~30 trades a month that
# is ~₹22,000 of risk a trade: with a stop near 2.2% of the price, a position of about ₹10 lakh. Each version below is
# priced at that size: big-position charges (Dhan's ₹20 cap no longer matters) and the market impact of the order.
TARGET_POS = {'T10': 1_000_000, 'T20': 2_000_000}
# Square-root impact (the rule desks use): each side costs ~0.5 x daily volatility x sqrt(order / daily turnover), daily
# volatility ~ the usual daily range / 1.6. On a stop of half that range, entry + exit come to 1.25 x sqrt(order / turnover)
# in R, whatever the stock's volatility: ₹10 lakh in a ₹20 crore a day stock ~0.09R, in a ₹100 crore one ~0.04R.
IMPACT_K = 1.25
REF_PRICE = 340  # lib/ml/grid.ts WIDE_REF_PRICE: avgVol is shares scaled to a ₹340 stock above it

NARROW = [
    {**ml._REAL, 'id': 'nF', 'name': '₹250–340 (control), ₹300 risk', 'desc': 'F as live on the stocks Algo Live trades today, real fills at ₹300 risk.'},
    {**ml._REAL, 'id': 'nT10', 'S': 'nbSx_t10', 'name': '₹250–340 (control), ₹10 lakh positions', 'bands': True, 'desc': 'The same at the ₹1 lakh a month size: big-position charges and the market impact of a ₹10 lakh order.'},
]
WIDE = [
    {**ml._REAL, 'id': 'wAll', 'name': '₹250–1000, ₹300 risk', 'bands': True, 'desc': 'Iteration 12\'s best again (ETFs out): F as live on every stock ₹250-1000 above the liquidity floor, real fills at ₹300 risk.'},
    {**ml._REAL, 'id': 'wT10', 'S': 'nbSx_t10', 'name': '₹250–1000, ₹10 lakh positions (the test)', 'bands': True, 'desc': 'At the ₹1 lakh a month size: big-position charges and the market impact of a ₹10 lakh order in each stock.'},
    {**ml._REAL, 'id': 'wT20', 'S': 'nbSx_t20', 'name': '₹250–1000, ₹20 lakh positions', 'bands': True, 'desc': 'Room to grow past ₹1 lakh a month: the same with ₹20 lakh orders.'},
    {**ml._REAL, 'id': 'placebo', 'name': 'Placebo (shuffled outcomes)', 'yS': 'nbS_shuf', 'desc': 'Learned from outcomes shuffled among stocks of the same month and minute. Traded on the real outcomes: it must show no edge.'},
]
# the liquidity measure here is shares scaled to a ₹340 stock (lib/ml/grid.ts wideVol), so these are rupees a day
BANDS = [(0, '₹17–100 cr'), (3e6, '₹100–170 cr'), (5e6, '₹170–240 cr'), (7e6, '₹240–340 cr'), (10e6, '₹340 cr+')]

_load = ml.load


def turnover_rs(df):
    """average daily turnover in rupees: avgVol is shares below ₹340 and shares x price / 340 above it"""
    return df['avgVol'].astype(float).values * np.minimum(df['priceRs'].astype(float).values, REF_PRICE)


def impact_r(df, position):
    """entry + exit market impact of a `position` rupee order, in R (see IMPACT_K)"""
    v = turnover_rs(df)
    ok = np.isfinite(v) & (v > 0)
    fallback = float(np.median(v[ok])) if ok.any() else 1e9  # a row without its turnover: the typical one
    return IMPACT_K * np.sqrt(position / np.where(ok, v, fallback))


def add_stress(df):
    """each target size: real fills, the charges of a big position (nbS3 - nbS: the same old fills at ~₹3 lakh and at ₹300
    risk differ only in charges, which are a flat share of the trade above ~₹67k), and the market impact of the order"""
    big = df['nbSx'].values + (df['nbS3'].values - df['nbS'].values)
    for key, pos in TARGET_POS.items():
        df[f'nbSx_{key.lower()}'] = big - impact_r(df, pos)
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
    ml.LOCKED = 'wT10' if wide else 'nT10'
    ml.VOL_ORDER = ['wT10'] if wide else ['nT10']
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
