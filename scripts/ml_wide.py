"""
Algo Lab iteration 15 (the wide-universe workflow): does iteration 14's region (₹50-170 crore a day, 3-4 trades a day) hold
as a block, at which position size does it make the most rupees, and do shorts fail when the market has run up?

    python scripts/ml_wide.py <dir> <narrow | wide | ladder> <main | seed2 | ...>     writes <dir>/wide-<universe>-<shard>.json

'wide' is the block at ₹10 lakh (₹50 / 100 / 170 crore a day x 3 / 4 a day), the same block with the market gate, and the
placebo at the pick's own settings; 'ladder' is the block at ₹5, 8, 12 and 15 lakh (main draw only); 'narrow' the ₹250-340
control. Each process trains one model (same label, same seeds), so a version costs only its own picking. Iterations 12-14
are kept as they ran under their git tags (algo-iter-<n>-*).

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

ITERATION = 15
MAX_CAP = 4  # the most trades a day any version may take (2 and 2 a side for Algo Live today): checked after the run

CHANGES = [
    'Iteration 14: ₹10 lakh positions, ₹100 crore+ a day, 4 a day passed its rule (+0.08R, t 4.2, 3.9R a month, about ₹90,000 a month; untouched 2022 +0.13R). But the exam was weak: only 4 of 27 cells were profitable on it, two of the pick\'s neighbours lost there (₹100 cr at 3 a day -7.6R, ₹170 cr at 4 a day -19R), July-September 2026 lost almost everywhere, and the pick stood aside in October and November. The neighbour rule was applied to the decide months, not to the exam.',
    'So this iteration stops searching cells and judges the region as a block: ₹50, 100 and 170 crore a day x 3 and 4 a day, the pick and its neighbours. Size-aware picking (+0.04R) and the far floors are dropped.',
    'Size ladder: the same block at ₹5, 8, 10, 12 and 15 lakh positions. A bigger order makes more rupees a trade but pays more market impact; the rule picks the size that makes the most rupees a month, which answers how close the ₹1-1.5 lakh goal is.',
    'Market gate: the market\'s 20-day move is the median 20-day move of every stock in the dataset at the first minute of the day (known before entries). The gated block stands aside on days when it is in the top third of its own last 250 trading days (at least 60 days of history; before that the gate is off). Fixed before the run, not tuned. Every version also reports its decide-month R by the third the day falls in, and how many exam days were in the top third.',
    'The placebo now runs at the pick\'s own settings (₹10 lakh, ₹100 crore+ a day, 4 a day) instead of ₹300 risk on all stocks.',
    'No daily loss stop is modelled: the dataset has no exit times, so a stop on the day\'s losses would use results not known yet. Each version reports how many decide days lost 2R or 3R or more instead.',
    'Rule fixed before this run, decide months: a block (6 cells at one size, gated or not) holds if at least 5 of its 6 cells make +0.05R a trade, t 2+ and 150+ trades, AND at least 4 of 6 are profitable on the exam months. The ₹10 lakh block\'s average over 5 training draws must beat the ₹250-340 control\'s best draw, and the placebo must show no edge. The pick: from the blocks that hold, the cell that is solid on its own (+0.05R, t 2+, 150+ trades, 50+ stocks a day, exam profitable) making the most rupees a month at its size, and more R a month than the control. Otherwise Algo Live stays as it is.',
]

TARGET_POS = {f'T{k}': k * 100_000 for k in (5, 8, 10, 12, 15)}  # ₹5, 8, 10, 12, 15 lakh positions
# Square-root impact (the rule desks use): each side costs ~0.5 x daily volatility x sqrt(order / daily turnover), daily
# volatility ~ the usual daily range / 1.6. On a stop of half that range, entry + exit come to 1.25 x sqrt(order / turnover)
# in R, whatever the stock's volatility: ₹10 lakh in a ₹20 crore a day stock ~0.09R, in a ₹100 crore one ~0.04R.
IMPACT_K = 1.25
REF_PRICE = 340  # lib/ml/grid.ts WIDE_REF_PRICE: avgVol is shares scaled to a ₹340 stock above it
FLOORS_CR = [50, 100, 170]  # the block: iteration 14's pick (₹100 cr, 4 a day) and its neighbours
CAPS = [3, 4]
LADDER = [5, 8, 12, 15]  # ₹10 lakh is in 'wide', with the training draws
MIN_POOL = 50
GATE_DAYS, GATE_MIN, GATE_Q = 250, 60, 2 / 3  # the market gate: top third of the last 250 days, 60 days of history at least
PLACEBO_AT = {'size': 10, 'floor': 100, 'cap': 4}


def sid(size, floor, cap, gate=False):
    """w10_f100_c3: ₹10 lakh positions, ₹100 crore a day floor, 3 trades a day; _g = with the market gate"""
    return f'w{size}_f{floor}_c{cap}' + ('_g' if gate else '')


def block(size, gate=False):
    out = []
    for cap in CAPS:
        for f in FLOORS_CR:
            out.append({**ml._REAL, 'id': sid(size, f, cap, gate), 'S': f'nbSx_t{size}', 'cap': cap, 'minTurnover': f * 1e7, 'gate': gate,
                        'name': f'₹{size} lakh · ₹{f:,} cr+ a day · {cap} a day' + (' · market gate' if gate else ''),
                        'desc': f'F on ₹250-1000 stocks trading at least ₹{f:,} crore a day, up to {cap} trades a day, priced at ₹{size} lakh positions (big-position charges and market impact).'
                                + (' Stands aside on days the market\'s 20-day move is in the top third of its last 250 days.' if gate else '')})
    return out


NARROW = [
    {**ml._REAL, 'id': 'nF', 'name': '₹250–340 (control), ₹300 risk', 'desc': 'F as live on the stocks Algo Live trades today, real fills at ₹300 risk.'},
    {**ml._REAL, 'id': 'nT10', 'S': 'nbSx_t10', 'name': '₹250–340 (control), ₹10 lakh positions', 'desc': 'The same at the ₹1 lakh a month size: big-position charges and the market impact of a ₹10 lakh order.'},
]
WIDE = [
    *block(10),
    *block(10, gate=True),
    {**ml._REAL, 'id': 'placebo', 'yS': 'nbS_shuf', 'S': f"nbSx_t{PLACEBO_AT['size']}", 'cap': PLACEBO_AT['cap'], 'minTurnover': PLACEBO_AT['floor'] * 1e7,
     'name': f"Placebo, ₹{PLACEBO_AT['size']} lakh · ₹{PLACEBO_AT['floor']} cr+ · {PLACEBO_AT['cap']} a day (shuffled outcomes)",
     'desc': 'Learned from outcomes shuffled among stocks of the same month and minute, priced and limited like the ₹10 lakh block. Traded on the real outcomes: it must show no edge.'},
]
LADDER_ST = [s_ for size in LADDER for s_ in block(size)]
UNIVERSES = {'narrow': NARROW, 'wide': WIDE, 'ladder': LADDER_ST}
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
    """ml_walkforward's limits, then this iteration's: a turnover floor in rupees, and the market gate"""
    pl, ps = _allowed(part, pl, ps, st)
    if st.get('minTurnover'):
        thin = ~(turnover_rs(part) >= st['minTurnover'])
        pl[thin] = -np.inf
        ps[thin] = -np.inf
    if st.get('gate') and 'hot' in part.columns:
        hot = part['hot'].values == 1
        pl[hot] = -np.inf
        ps[hot] = -np.inf
    return pl, ps


def market_move(df):
    """per day: the median 20-day move (%) of every stock in the dataset at the day's first minute (known before entries)"""
    first = df[df['slot'].values == df['slot'].min()]
    return first.groupby('day', sort=True)['ret20d'].median()


def hot_days(mkt):
    """the days the market's 20-day move is in the top third of its own last GATE_DAYS days (before today; GATE_MIN days of
    history at least, else not hot)"""
    v = mkt.values.astype(float)
    hot = np.zeros(len(v), dtype=bool)
    for i in range(len(v)):
        past = v[max(0, i - GATE_DAYS):i]
        past = past[np.isfinite(past)]
        if len(past) >= GATE_MIN and np.isfinite(v[i]):
            hot[i] = v[i] > np.quantile(past, GATE_Q)
    return pd.Series(hot, index=mkt.index)


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
    ml.LOCKED = {'narrow': 'nT10', 'wide': sid(10, 100, 4), 'ladder': sid(5, 100, 4)}[universe]
    ml.VOL_ORDER = [ml.LOCKED]
    ml.UNTOUCHED = [s['id'] for s in strategies if s['id'] != 'placebo']
    ml._UNTOUCHED_MODELS.clear()
    ml._LOOKUP.clear()

    def load(d):
        head, df = _load(d)
        hot = hot_days(market_move(df))  # on the whole dataset, so every universe sees the same market
        df['hot'] = df['day'].map(hot).fillna(False).astype(np.int8).values
        if universe == 'narrow':
            df = df[df['inNarrow'].values == 1].reset_index(drop=True)
        return head, add_stress(df)
    ml.load = load


def cap_of(st_id):
    import re
    m = re.search(r'_c(\d)', st_id)
    if m:
        return int(m.group(1))
    return PLACEBO_AT['cap'] if st_id == 'placebo' else 2


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


def diagnostics(res, df):
    """per version: decide-month R by the third of the market's 20-day move the day fell in, the share of exam days in the top
    third, and how many decide days lost 2R / 3R or more (what a daily loss limit would have faced)"""
    mkt = market_move(df)
    exam_from = res.get('examFrom') or ml.EXAM_FROM
    ef = exam_from[:7]
    mon = mkt.index.str.slice(0, 7)
    decide = mkt[(mon >= ml.DECIDE_FROM[:7]) & (mon < ef)]
    cuts = np.quantile(decide.dropna().values, [1 / 3, 2 / 3]) if decide.notna().sum() >= 3 else None
    hot = hot_days(mkt)
    exam_days = hot[(hot.index.str.slice(0, 7) >= ef) & (hot.index.str.slice(0, 7) < getattr(ml, 'SHADOW_FROM', '9999'))]
    names = ['low', 'mid', 'high']
    for s in res['strategies']:
        i_day, i_net = 0, s.get('tradeCols', ['day', 'sym', 'time', 'side', 'pred', 'net']).index('net')
        dec = [t for t in s['trades'] if t[i_day][:7] < ef and t[i_net] is not None]
        reg = {k: {'n': 0, 'sumR': 0.0} for k in names}
        if cuts is not None:
            for t in dec:
                v = mkt.get(t[i_day], np.nan)
                if not np.isfinite(v):
                    continue
                k = names[int(np.searchsorted(cuts, v, side='right'))]
                reg[k]['n'] += 1
                reg[k]['sumR'] += float(t[i_net])
        s['regime'] = {
            'cuts': None if cuts is None else [round(float(c), 2) for c in cuts],
            **{k: {'n': x['n'], 'netR': round(x['sumR'] / x['n'], 3) if x['n'] else None} for k, x in reg.items()},
            'examHotShare': round(float(exam_days.mean()), 3) if len(exam_days) else None,
        }
        days = {}
        for t in dec:
            days[t[i_day]] = days.get(t[i_day], 0.0) + float(t[i_net])
        vals = list(days.values())
        s['badDays'] = {'days': len(vals), 'le2': sum(v <= -2 for v in vals), 'le3': sum(v <= -3 for v in vals)}
    return res


def main(d, universe, shard):
    if universe not in UNIVERSES:
        raise SystemExit(f'unknown universe {universe}')
    configure(universe, shard)
    ml.main(d)
    made = os.path.join(d, 'ml.json' if shard == 'main' else f'ml-{shard}.json')
    res = json.load(open(made))
    check_cap(res)
    _, df = ml.load(d)
    diagnostics(res, df)
    if universe == 'narrow':  # the stocks it actually had, not the whole dataset's list
        res['stocks'] = int(df['sym'].nunique())
    else:
        res['pools'] = pools(df)
    json.dump(res, open(os.path.join(d, f'wide-{universe}-{shard}.json'), 'w'))
    os.remove(made)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else 'main')
