"""
Algo Lab iteration 12, step 2: F as Algo Live trades it, on the ₹250-340 control and on the wider universe.

    python scripts/ml_wide.py <dir> <narrow | wide> <main | seed2 | ...>     writes <dir>/wide-<universe>-<shard>.json

It runs ml_walkforward.py's own pipeline, unchanged, with this iteration's settings put in from here. ml_walkforward.py
itself is not edited: the normal backtest Re-run and the monthly Algo Live model (scripts/ml_live.py) read it and stay as
they are.

Both universes use the dataset written by lib/ml/wideJob.ts (decisions 09:25-10:55 only, because the full day on this
many stocks does not fit in a GitHub machine), so the comparison is like for like. 'narrow' keeps only the stock-days
inside ₹250-340 and computes the ranks among them alone.

No strategy id here is 'fCap2': the pages that follow the live strategy look for that id and must never find this run.
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import ml_walkforward as ml  # noqa: E402

CHANGES = [
    'Same strategy, more stocks: F as Algo Live trades it (short, 09:35-10:55, first 2 a day), its facts and bar recipe unchanged. Only the stocks it may choose from change. Algo Live is not touched by this run.',
    'Universe: previous close ₹250-1000 (₹0.05 tick throughout) against the ₹250-340 control. A ₹300 risk buys about the same rupee position at any share price, so the price band is not a capital limit.',
    'The same liquidity floor in rupees (about ₹17 crore a day). Real fills scale up with price above ₹340, so a dearer stock is never helped by a tick being a smaller share of its price: a ₹680 stock slips twice the ticks. Inside ₹250-340 the fills are exactly iteration 11\'s.',
    'Both sides learn from the same moments: 09:25-10:55 only (the only closes F can trade), so this run\'s ₹250-340 control is not the same number as earlier iterations.',
    'Versions on the wide universe: all stocks, and liquidity floors of ₹100 / 170 / 240 / 340 crore a day; plus the wide model trading only ₹250-340 (does more data to learn from help on its own?). Placebo kept. Five training draws on each side.',
    'Rule fixed before this run, decide months only, real fills: the highest floor with +0.04R a trade, t of at least 2.0 and 150 trades; its average over the draws must beat the best draw of the control; it must make more R in total; the placebo must show no edge. Exam and untouched months are a second look only.',
]

NARROW = [
    {**ml._REAL, 'id': 'nF', 'name': '₹250–340 (control), real fills', 'desc': 'F as live on the stocks Algo Live trades today, with fills by liquidity.'},
]
WIDE = [
    {**ml._REAL, 'id': 'wAll', 'name': '₹250–1000, all', 'bands': True, 'desc': 'F as live on every stock ₹250-1000 above the liquidity floor, with fills by liquidity.'},
    {**ml._REAL, 'id': 'w3m', 'name': '₹250–1000, ₹100 cr+', 'minVol': 3e6, 'desc': 'As above, only stocks trading about ₹100 crore a day or more.'},
    {**ml._REAL, 'id': 'w5m', 'name': '₹250–1000, ₹170 cr+', 'minVol': 5e6, 'desc': 'As above, only stocks trading about ₹170 crore a day or more.'},
    {**ml._REAL, 'id': 'w7m', 'name': '₹250–1000, ₹240 cr+', 'minVol': 7e6, 'desc': 'As above, only stocks trading about ₹240 crore a day or more.'},
    {**ml._REAL, 'id': 'w10m', 'name': '₹250–1000, ₹340 cr+', 'minVol': 1e7, 'desc': 'As above, only stocks trading about ₹340 crore a day or more.'},
    {**ml._REAL, 'id': 'wIn340', 'name': 'Wide model, trades ₹250–340 only', 'narrowOnly': True, 'desc': 'Learns from every stock ₹250-1000 but may only trade ₹250-340: does more data to learn from help by itself?'},
    {**ml._REAL, 'id': 'placebo', 'name': 'Placebo (shuffled outcomes)', 'yS': 'nbS_shuf', 'desc': 'Learned from outcomes shuffled among stocks of the same month and minute. Traded on the real outcomes: it must show no edge.'},
]
WIDE_ORDER = ['w10m', 'w7m', 'w5m', 'w3m', 'wAll']
# the liquidity measure here is shares scaled to a ₹340 stock (lib/ml/grid.ts wideVol), so these are rupees a day
BANDS = [(0, '₹17–100 cr'), (3e6, '₹100–170 cr'), (5e6, '₹170–240 cr'), (7e6, '₹240–340 cr'), (10e6, '₹340 cr+')]

_allowed = ml.allowed
_load = ml.load


def allowed(part, pl, ps, st):
    pl, ps = _allowed(part, pl, ps, st)
    if st.get('narrowOnly'):
        out = part['inNarrow'].values != 1
        pl[out] = -np.inf
        ps[out] = -np.inf
    return pl, ps


def configure(universe, shard):
    """puts this iteration's settings into ml_walkforward for this process only"""
    wide = universe == 'wide'
    ml.ITERATION = 12
    ml.CHANGES = CHANGES
    ml.BANDS = BANDS
    ml.allowed = allowed
    ml.SHARD = shard
    ml.SEED_OFF = 0 if shard == 'main' else int(shard.replace('seed', '') or 0)
    strategies = WIDE if wide else NARROW
    ml.STRATEGIES = strategies if shard == 'main' else [s for s in strategies if s['id'] != 'placebo']
    ml.LOCKED = 'wAll' if wide else 'nF'
    ml.VOL_ORDER = WIDE_ORDER if wide else ['nF']
    ml.UNTOUCHED = [s['id'] for s in strategies if s['id'] != 'placebo']
    ml._UNTOUCHED_MODELS.clear()
    ml._LOOKUP.clear()

    def narrow_load(d):
        head, df = _load(d)
        return head, df[df['inNarrow'].values == 1].reset_index(drop=True)
    ml.load = _load if wide else narrow_load


def main(d, universe, shard):
    if universe not in ('narrow', 'wide'):
        raise SystemExit(f'unknown universe {universe}')
    configure(universe, shard)
    ml.main(d)
    made = os.path.join(d, 'ml.json' if shard == 'main' else f'ml-{shard}.json')
    os.replace(made, os.path.join(d, f'wide-{universe}-{shard}.json'))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else 'main')
