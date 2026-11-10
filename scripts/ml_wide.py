"""
Algo Lab iteration 14 (the wide-universe workflow): which liquidity floor and how many trades a day make ₹250-1000 pay at
the size of the ₹1-1.5 lakh a month goal?

    python scripts/ml_wide.py <dir> <narrow | wide | wide5> <main | seed2 | ...>     writes <dir>/wide-<universe>-<shard>.json

'wide' is the ₹10 lakh grid (turnover floors x 2/3/4 a day, size-aware picking, placebo), 'wide5' the same at ₹5 lakh,
'narrow' the ₹250-340 control. All of them share one model per process (same label, same seeds), so a version costs only
its own picking. Iterations 12 and 13 are kept as they ran under their git tags (algo-iter-12-*, algo-iter-13-*).

It runs ml_walkforward.py's own pipeline, unchanged, with this iteration's settings put in from here. ml_walkforward.py
itself is not edited: the normal backtest Re-run and the monthly Algo Live model (scripts/ml_live.py) read it and stay as
they are.

No strategy id here is 'fCap2': the pages that follow the live strategy look for that id and must never find this run.
"""
import json
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
import ml_walkforward as ml  # noqa: E402

ITERATION = 14
MAX_CAP = 4  # the most trades a day any version may take (2 and 2 a side for Algo Live today): checked after the run

CHANGES = [
    'Iteration 13: ₹250-1000 beats ₹250-340 at every size, but at ₹10 lakh positions it fell to +0.04R (t 1.5, exam failed): before costs it makes +0.17R, and the market impact of a ₹10 lakh order eats most of it, because the model picks thin, volatile stocks (about ₹15-25 crore a day). Liquidity floors looked bad in iteration 12 only because they were priced at ₹300 risk, where liquid stocks save almost nothing. At size it is the other way round.',
    'So this iteration prices every version at ₹10 lakh positions (about ₹22,000 risk a trade, the ₹1 lakh a month size) and tests liquidity floors on daily turnover in rupees: ₹17 crore (where we are), 50, 100, 170, 250, 340, 500, 750 and 1,000 crore a day. Floors, not narrow brackets: the model still picks the best setup among everything liquid enough. Each floor also reports how many stocks clear it on a typical day; a floor with fewer than 50 stocks is too small to judge.',
    'Every floor at 2, 3 and 4 trades a day (never more than 4), because a bigger order costs more impact than two smaller ones for the same money at work. The bar to trade still decides; the cap is only a ceiling. A day at 4 trades can lose about twice what a day at 2 can: use a daily loss limit live.',
    'Plus size-aware picking: each candidate\'s score is cut by the known market impact of a ₹10 lakh order in that stock before ranking and before the bar, so a liquid stock with a slightly weaker setup beats a thin one. And everything again at ₹5 lakh positions (about ₹11,000 risk a trade), the realistic next step up from ₹300.',
    'Same model for every version (trained once); only which stocks may be taken, how many a day, and the cost at size change. ETFs stay out.',
    'Rule fixed before this run, decide months, ₹10 lakh positions: a version must make +0.05R a trade, t of at least 2.0 and 150 trades, with at least 50 stocks clearing its floor on a typical day, and be profitable on the exam months; at least 2 of its neighbours (the next floor up and down at the same cap, the next cap at the same floor) must be profitable too, so one lucky cell does not count. Of those, the one making the most R a month wins, if its average over 5 training draws beats the best draw of the ₹250-340 control at the same size and the placebo shows no edge.',
]

TARGET_POS = {'T10': 1_000_000, 'T5': 500_000}
# Square-root impact (the rule desks use): each side costs ~0.5 x daily volatility x sqrt(order / daily turnover), daily
# volatility ~ the usual daily range / 1.6. On a stop of half that range, entry + exit come to 1.25 x sqrt(order / turnover)
# in R, whatever the stock's volatility: ₹10 lakh in a ₹20 crore a day stock ~0.09R, in a ₹100 crore one ~0.04R.
IMPACT_K = 1.25
REF_PRICE = 340  # lib/ml/grid.ts WIDE_REF_PRICE: avgVol is shares scaled to a ₹340 stock above it
FLOORS_CR = [17, 50, 100, 170, 250, 340, 500, 750, 1000]  # daily turnover floors, ₹ crore
CAPS = [2, 3, 4]
MIN_POOL = 50


def sid(size, floor, cap):
    """w10_f100_c3: ₹10 lakh positions, ₹100 crore a day floor, 3 trades a day; floor 'aware' = size-aware picking"""
    return f'w{size}_{"aware" if floor == "aware" else f"f{floor}"}_c{cap}'


def grid(size):
    pos = TARGET_POS[f'T{size}']
    out = []
    for cap in CAPS:
        for f in FLOORS_CR:
            out.append({**ml._REAL, 'id': sid(size, f, cap), 'S': f'nbSx_t{size}', 'cap': cap, 'minTurnover': f * 1e7,
                        'name': f'₹{size} lakh · ₹{f:,} cr+ a day · {cap} a day',
                        'desc': f'F on ₹250-1000 stocks trading at least ₹{f:,} crore a day, up to {cap} trades a day, priced at ₹{size} lakh positions (big-position charges and market impact).'})
        out.append({**ml._REAL, 'id': sid(size, 'aware', cap), 'S': f'nbSx_t{size}', 'cap': cap, 'aware': pos,
                    'name': f'₹{size} lakh · size-aware · {cap} a day',
                    'desc': f'Every stock, but each candidate\'s score is cut by the market impact of a ₹{size} lakh order in it before ranking and before the bar. Up to {cap} trades a day.'})
    return out


NARROW = [
    {**ml._REAL, 'id': 'nF', 'name': '₹250–340 (control), ₹300 risk', 'desc': 'F as live on the stocks Algo Live trades today, real fills at ₹300 risk.'},
    {**ml._REAL, 'id': 'nT10', 'S': 'nbSx_t10', 'name': '₹250–340 (control), ₹10 lakh positions', 'desc': 'The same at the ₹1 lakh a month size: big-position charges and the market impact of a ₹10 lakh order.'},
]
WIDE = [
    {**ml._REAL, 'id': 'wAll', 'name': '₹250–1000, ₹300 risk (iteration 13)', 'desc': 'Iteration 13\'s ₹300 risk version, for reference.'},
    *grid(10),
    {**ml._REAL, 'id': 'placebo', 'name': 'Placebo (shuffled outcomes)', 'yS': 'nbS_shuf', 'desc': 'Learned from outcomes shuffled among stocks of the same month and minute. Traded on the real outcomes: it must show no edge.'},
]
WIDE5 = grid(5)
UNIVERSES = {'narrow': NARROW, 'wide': WIDE, 'wide5': WIDE5}
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


_allowed = ml.allowed


def allowed(part, pl, ps, st):
    """ml_walkforward's limits, then this iteration's: a turnover floor in rupees, and size-aware scores"""
    pl, ps = _allowed(part, pl, ps, st)
    if st.get('minTurnover'):
        thin = ~(turnover_rs(part) >= st['minTurnover'])
        pl[thin] = -np.inf
        ps[thin] = -np.inf
    if st.get('aware'):
        cost = impact_r(part, st['aware'])
        pl = pl - cost
        ps = ps - cost
    return pl, ps


def configure(universe, shard):
    """puts this iteration's settings into ml_walkforward for this process only"""
    strategies = UNIVERSES[universe]
    ml.ITERATION = ITERATION
    ml.CHANGES = CHANGES
    ml.BANDS = BANDS
    ml.MAX_PER_DAY = MAX_CAP
    ml.MAX_PER_SIDE = MAX_CAP
    ml.allowed = allowed
    ml.SHARD = shard
    ml.SEED_OFF = 0 if shard == 'main' else int(shard.replace('seed', '') or 0)
    ml.STRATEGIES = strategies if shard == 'main' else [s for s in strategies if s['id'] != 'placebo']
    ml.LOCKED = {'narrow': 'nT10', 'wide': sid(10, 17, 2), 'wide5': sid(5, 17, 2)}[universe]
    ml.VOL_ORDER = [ml.LOCKED]
    ml.UNTOUCHED = [s['id'] for s in strategies if s['id'] != 'placebo']
    ml._UNTOUCHED_MODELS.clear()
    ml._LOOKUP.clear()

    def load(d):
        head, df = _load(d)
        if universe == 'narrow':
            df = df[df['inNarrow'].values == 1].reset_index(drop=True)
        return head, add_stress(df)
    ml.load = load


def cap_of(st_id):
    return int(st_id.rsplit('_c', 1)[1]) if '_c' in st_id else 2


def check_cap(res):
    """every strategy's out-of-sample trades: never more than its own cap a day (else the job fails, nothing is filed)"""
    for s in res['strategies']:
        cap = min(cap_of(s['id']), MAX_CAP)
        per_day = {}
        for t in s['trades']:
            per_day[t[0]] = per_day.get(t[0], 0) + 1
        worst = max(per_day.values(), default=0)
        if worst > cap:
            raise SystemExit(f"{s['id']}: {worst} trades on one day, more than {cap}")


def pools(df):
    """for each floor, how many stocks clear it on a typical day (median over days, at 09:35)"""
    first = df[df['slot'].values == df['slot'].min()]
    v = turnover_rs(first)
    out = {}
    for f in FLOORS_CR:
        out[str(f)] = int(np.median(pd.Series(v >= f * 1e7).groupby(first['day'].values).sum().values)) if len(first) else 0
    return out


def main(d, universe, shard):
    if universe not in UNIVERSES:
        raise SystemExit(f'unknown universe {universe}')
    configure(universe, shard)
    ml.main(d)
    made = os.path.join(d, 'ml.json' if shard == 'main' else f'ml-{shard}.json')
    res = json.load(open(made))
    check_cap(res)
    _, df = ml.load(d)
    if universe == 'narrow':  # the stocks it actually had, not the whole dataset's list
        res['stocks'] = int(df['sym'].nunique())
    else:
        res['pools'] = pools(df)
    json.dump(res, open(os.path.join(d, f'wide-{universe}-{shard}.json'), 'w'))
    os.remove(made)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else 'main')
