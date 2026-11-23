"""
Algo Lab iteration 17, step 2: one entry arm, one training draw (the walk-forward of scripts/ml_walkforward.py, unchanged).

    python scripts/ml_iter17.py <dir> <A | C | D | CD | Cp> <main | seed2 | ...>     writes <dir>/i17-<arm>-<shard>.json

Every arm is iteration 10's strategy F as Algo Live trades it (short, 09:35-10:55, first 2 a day, stop and target 1/2 the
usual daily range, out by 15:15) on Algo Live's realistic fills, with iteration 10's models, facts and bar recipe. They differ
only in what the models may read and which moments may be traded:
  A   the control: iteration 10 as it is (plus, in the same process, the same trades at iteration 10's old fills)
  C   + the chart-structure facts (lib/ml/iter17.ts I17_STRUCTURE)
  D   + the sector facts, and no trade on a results day or the day after (when the results calendar was available)
  CD  + both
  Cp  + the structure facts drawn from randomly shifted lines (the placebo of C)
Learning from losses (B) and the break-even versions are layered on these trades afterwards (scripts/ml_iter17_layers.py).
ml_walkforward.py itself is not changed: the normal Re-run and the monthly Algo Live model run exactly as before.
"""
import json
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
import ml_walkforward as ml  # noqa: E402

ITERATION = 17
STRUCT = ['sweep', 'sweepAtr', 'sweepAgo', 'sweepPdh', 'fvgDistAtr', 'fvgSizeAtr', 'fvgIn', 'fvgCount', 'fvgTouch', 'lowerHigh',
          'bosDown', 'bosAgo', 'swingHiAtr', 'flipOpen', 'flipOr', 'flipDistAtr', 'supplyDistAtr', 'supplyBack']
PLACEBO = ['p_' + k for k in STRUCT]
SECTOR = ['secDay', 'sec30', 'stockVsSec', 'rs30Sec']
LABELS = {
    'sweep': 'Swept a high and closed back below it in the last 3 candles', 'sweepAtr': 'How far above the swept high the wick went (ATR)',
    'sweepAgo': 'Candles since the sweep', 'sweepPdh': 'The swept high was yesterday\'s high',
    'fvgDistAtr': 'Nearest unfilled bearish fair value gap above price: distance (ATR)', 'fvgSizeAtr': 'That gap\'s size (ATR)',
    'fvgIn': 'Price inside an unfilled bearish gap', 'fvgCount': 'Unfilled bearish gaps above price',
    'fvgTouch': 'First return into an unfilled bearish gap, closed below its top', 'lowerHigh': 'Last swing high lower than the one before',
    'bosDown': 'Last swing low closed below (break of structure)', 'bosAgo': 'Candles since that break', 'swingHiAtr': 'Last swing high vs price (ATR)',
    'flipOpen': 'Lost the open, retested it from below, rejected', 'flipOr': 'Lost the first 30 min low, retested it from below, rejected',
    'flipDistAtr': 'That flip level vs price (ATR)', 'supplyDistAtr': 'Base of the first sharp down candle vs price (ATR)',
    'supplyBack': 'First return to that base',
    'secDay': 'Sector index open → now (%)', 'sec30': 'Sector index last 30 min (%)', 'stockVsSec': 'Stock vs its sector since the open (%)',
    'rs30Sec': 'Stock vs its sector over the last 30 min (%)',
}
for k in STRUCT:
    LABELS['p_' + k] = 'Random lines: ' + LABELS[k]

ARMS = {
    'A': {'facts': [], 'res': False, 'name': 'A. Control: iteration 10 (F as live, real fills)'},
    'C': {'facts': STRUCT, 'res': False, 'name': 'C. + chart structures'},
    'D': {'facts': SECTOR, 'res': True, 'name': 'D. + results days and sector'},
    'CD': {'facts': STRUCT + SECTOR, 'res': True, 'name': 'C+D. + chart structures, results days and sector'},
    'Cp': {'facts': PLACEBO, 'res': False, 'name': 'C placebo: chart structures from random lines'},
}
DESC = {
    'A': 'Iteration 10 unchanged: short only, 09:35-10:55, first 2 a day, stop and target ½ the usual daily range, out by 15:15, on Algo Live\'s realistic fills. Every other version is judged against this one, in the same run.',
    'C': 'The control plus 18 chart-structure facts on the 10-min chart: sweep and reclaim, fair value gap, break of structure / change of character, flip zone, supply zone.',
    'D': 'The control plus the stock\'s sector (its NSE industry index: since the open, last 30 min, the stock against it), and no trade on a results day or the day after.',
    'CD': 'The control plus the chart-structure facts, the sector facts and the results-day skip.',
    'Cp': 'The chart-structure facts computed from lines shifted by a random amount (fixed per stock-day). If this helps as much as C, the structure facts are noise.',
}

CHANGES = [
    'Built on iteration 10, not on iterations 11-16: F as Algo Live trades it, with its models, facts and bar recipe unchanged, priced on Algo Live\'s realistic fills (iteration 11). The control (A) is that, in the same run, with the old fills alongside for continuity.',
    'B, learning from losses: each losing trade is sorted (fast stop within 30 min, turned near the target after reaching 70%+ of it, drift to 15:15, shock = a 3+ ATR candle against it; shocks never teach). A veto model trained only on the trades F took in earlier months skips trades it expects to lose; an early-exit model looks at the 1st, 2nd and 3rd 10-min candle after entry (how far against, volume, Nifty, the close vs entry) and closes at market when holding is expected to lose. A lesson acts only once it passes four checks on earlier months: 20+ stocks with none over 10%, the same direction in 70%+ of quarters, holds with each stock left out, raises net R after the winners it cuts.',
    'C, chart structures (the YouTuber\'s list, flipped to the short side): sweep and reclaim, fair value gap, break of structure / change of character, flip zone, supply zone, as new facts the model may combine. Level bounce and trend pullback were already covered, breakout and trend line left out. Random-lines check: the same facts from randomly shifted levels must not help as much.',
    'D, results days and sector: no trade on a company\'s results day or the day after (NSE\'s board-meeting calendar), and the stock against its sector index.',
    'Every combination: A, B, C, D, B+C, B+D, C+D, B+C+D; each with no stop move, and with the stop moved to break-even after costs at 80% and at 90% of the way to the target.',
    'Rule fixed before this run: a version passes only if it beats A by +0.03R a trade or more on the decide months with t 2+, passes the exam, is not worse than A on the untouched months, beats A in 4 of the 5 training draws and still beats A at ₹10 lakh positions; a combination must also beat its best single part, and C must beat its random-lines twin. Break-even at 80% / 90% passes only if it beats no move in the same version on the decide, exam and untouched months alike.',
]


def arm_strategies(arm, shard):
    a = ARMS[arm]
    st = [{**ml._REAL, 'id': arm, 'name': a['name'], 'desc': DESC[arm], 'resSkip': a['res']}]
    if arm == 'A':
        st.append({**ml._F2, 'id': 'A_old', 'name': 'A at iteration 10\'s old fills', 'desc': 'The control\'s own models and trades at the old fills (1 tick): iteration 10 as first reported.'})
        if shard == 'main':
            st.append({**ml._REAL, 'id': 'placebo', 'name': 'Placebo (shuffled outcomes)', 'yS': 'nbS_shuf',
                       'desc': 'F as live, its models trained on outcomes shuffled among the stocks of the same month and minute. Must show no edge.'})
    return st


def loader(arm):
    facts = ARMS[arm]['facts']

    def load(d):
        head = json.load(open(os.path.join(d, 'grid.json')))
        cols, w = head['cols'], head['width']
        base = [c for c in cols if c in ('sym', 'date', 'slot')] + [f['k'] for f in head['features']] + list(head['labels'])
        want = base + [c for c in facts if c not in base] + (['resDay'] if 'resDay' in cols else [])
        raw = np.memmap(os.path.join(d, 'grid.bin'), dtype=np.float32, mode='r')
        if raw.size % w:
            raise SystemExit('grid.bin is not a whole number of rows')
        raw = raw.reshape(-1, w)
        df = pd.DataFrame({c: np.asarray(raw[:, cols.index(c)]) for c in want})
        del raw
        df['sym'] = df['sym'].astype(np.int32)
        df['date'] = df['date'].astype(np.int32)
        df['slot'] = df['slot'].astype(np.int32)
        dates = np.array(head['dates'])
        df['day'] = dates[df['date'].values]
        df['month'] = df['day'].str.slice(0, 7)
        # the arm's extra facts become model facts (their plain names for the page)
        head = {**head, 'features': head['features'] + [{'k': f, 'l': LABELS.get(f, f)} for f in facts]}
        return head, df
    return load


_allowed = ml.allowed


def allowed(part, pl, ps, st):
    """iteration 10's limits, plus (D) no trade on a results day or the day after"""
    pl, ps = _allowed(part, pl, ps, st)
    if st.get('resSkip') and 'resDay' in part.columns:
        res = part['resDay'].values == 1
        pl, ps = pl.copy(), ps.copy()
        pl[res] = -np.inf
        ps[res] = -np.inf
    return pl, ps


def configure(arm, shard):
    if arm not in ARMS:
        raise SystemExit(f'unknown arm {arm}')
    ml.ITERATION = ITERATION
    ml.CHANGES = CHANGES
    ml.SHARD = shard
    ml.SEED_OFF = 0 if shard == 'main' else int(shard.replace('seed', '') or 0)
    ml.STRATEGIES = arm_strategies(arm, shard)
    ml.LOCKED = arm
    ml.VOL_ORDER = []
    ml.UNTOUCHED = [s['id'] for s in ml.STRATEGIES if s['id'] != 'placebo']
    ml.allowed = allowed
    ml.load = loader(arm)
    ml._UNTOUCHED_MODELS.clear()
    ml._LOOKUP.clear()


def main(d, arm, shard):
    configure(arm, shard)
    ml.main(d)
    made = os.path.join(d, 'ml.json' if shard == 'main' else f'ml-{shard}.json')
    res = json.load(open(made))
    res['arm'] = arm
    json.dump(res, open(os.path.join(d, f'i17-{arm}-{shard}.json'), 'w'))
    os.remove(made)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else 'main')
