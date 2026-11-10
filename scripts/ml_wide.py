"""
Algo Lab iteration 16 (the wide-universe workflow): iteration 15's pick (₹10 lakh, ₹100 crore+ a day, 3 a day, market gate)
held as a block but loses half its edge to costs at ₹10 lakh. Does sizing each trade by the stock's own liquidity make more a
month, and does standing aside after 3 losing months cost money (so Algo Live could trade months like November 2026)?

    python scripts/ml_wide.py <dir> <narrow | wide> <main | seed2 | ...>     writes <dir>/wide-<universe>-<shard>.json

'wide' is the fixed ₹10 lakh references, the liquidity-sized versions (a set share of the stock's daily turnover, ₹1-25 lakh),
their "never stand aside" twins and the placebo, with the training draws; 'narrow' the ₹250-340 control. Each process trains
one model (same label, same seeds), so a version costs only its own picking. Iterations 12-15 are kept as they ran under their
git tags (algo-iter-<n>-*).
"""
import json
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
import ml_walkforward as ml  # noqa: E402

ITERATION = 16
MAX_CAP = 4  # the most trades a day any version may take (2 and 2 a side for Algo Live today): checked after the run

CHANGES = [
    'Iteration 15: the ₹10 lakh block with the market gate held (5 of 6 cells good on the decide months, 4 of 6 profitable on the exam); the pick, ₹100 crore+ a day, 3 a day, gated, made +0.09R (t 3.5, about ₹55,000 a month; draws +0.04 to +0.09R). ₹100 crore+ was the best floor at every size, 3 a day beat 4, ₹50 crore failed the exam everywhere. But costs eat about half the edge at ₹10 lakh (+0.17R before costs), 2026 was about flat after costs, the same version moved by about ±0.03R between runs, and the pick stood aside in October and November 2026.',
    'Liquidity sizing: each trade is a set share of the stock\'s own daily turnover (0.05%, 0.1%, 0.2% or 0.3%), at least ₹1 lakh and at most ₹25 lakh. Market impact is then the same in R for every stock (1.25 x the square root of the share), and a liquid stock simply takes a bigger order. Every version reports its rupees a trade and a month from its own positions, not a flat size.',
    'Never stand aside: each month the bar is the one that did best on the 3 months before; if even that lost, the version stands aside. A "_ns" twin trades that best bar anyway. If the decide months it would have stood aside made money, standing aside costs us, and Algo Live could trade months like November.',
    'The versions: ₹100 and ₹170 crore a day, 3 a day, with and without the gate, at each share; the fixed ₹10 lakh ₹100 crore 3 a day references (iteration 15\'s pick and its ungated twin); "_ns" twins of every ₹100 crore version; the placebo at the reference\'s settings. The ₹5-15 lakh ladder and 4 a day are dropped.',
    'Rule fixed before this run, decide months: a liquidity-sized version at ₹100 crore+ wins if it is solid (+0.05R a trade, t 2+, 150+ trades, 50+ stocks a day, exam profitable), at least 2 of its 3 neighbours (the next share up and down, and ₹170 crore at the same share, same gate) are profitable on the decide months and the exam, its draw average beats the ₹250-340 control\'s best draw, it makes more rupees a month than iteration 15\'s pick in this run with its exam months also positive in rupees, and the placebo is clean. Of those, the most rupees a month wins; if none does, iteration 15\'s pick stays the pick. Standing aside is dropped for the pick only if its "_ns" twin made money on the decide months the pick stood aside, and its exam is profitable too.',
]

TARGET_POS = {'T10': 1_000_000}  # the fixed ₹10 lakh references (iteration 15's pick)
# Square-root impact (the rule desks use): each side costs ~0.5 x daily volatility x sqrt(order / daily turnover), daily
# volatility ~ the usual daily range / 1.6. On a stop of half that range, entry + exit come to 1.25 x sqrt(order / turnover)
# in R, whatever the stock's volatility: ₹10 lakh in a ₹20 crore a day stock ~0.09R, in a ₹100 crore one ~0.04R.
IMPACT_K = 1.25
REF_PRICE = 340  # lib/ml/grid.ts WIDE_REF_PRICE: avgVol is shares scaled to a ₹340 stock above it
FLOORS_CR = [100, 170]  # iteration 15's best floor and its neighbour (₹50 crore failed the exam at every size)
CAP = 3                 # 3 a day beat 4 at every size in iteration 15
MIN_POOL = 50
GATE_DAYS, GATE_MIN, GATE_Q = 250, 60, 2 / 3  # the market gate: top third of the last 250 days, 60 days of history at least
# liquidity sizing: a position is this share of the stock's daily turnover, between POS_MIN and POS_MAX rupees
SHARES_BP = [5, 10, 20, 30]  # basis points of daily turnover: 0.05%, 0.1%, 0.2%, 0.3%
POS_MIN, POS_MAX = 100_000, 2_500_000
LEVERAGE = 5  # intraday margin, for the capital a day's positions need
REF = 'w10_f100_c3_g'  # iteration 15's pick
PLACEBO_AT = {'size': 10, 'floor': 100, 'cap': 3, 'gate': True}


def sid(size, floor, cap, gate=False):
    """w10_f100_c3: ₹10 lakh positions, ₹100 crore a day floor, 3 trades a day; _g = with the market gate"""
    return f'w{size}_f{floor}_c{cap}' + ('_g' if gate else '')


def lid(bp, floor, gate=False, ns=False):
    """l10_f100_c3_g: each position 0.10% of the stock's daily turnover (₹1-25 lakh), ₹100 crore a day floor, 3 a day, the
    market gate; _ns = never stands aside"""
    return f'l{bp}_f{floor}_c{CAP}' + ('_g' if gate else '') + ('_ns' if ns else '')


def gate_desc(gate):
    return ' Stands aside on days the market\'s 20-day move is in the top third of its last 250 days.' if gate else ''


NS_DESC = ' Never stands aside: in a month where even the best bar of the 3 months before lost, it trades that bar anyway.'


def fixed(floor, gate=False, ns=False):
    i = sid(10, floor, CAP, gate) + ('_ns' if ns else '')
    return {**ml._REAL, 'id': i, 'S': 'nbSx_t10', 'cap': CAP, 'minTurnover': floor * 1e7, 'gate': gate, 'ns': ns, 'posFixed': 1_000_000,
            'name': f'₹10 lakh · ₹{floor} cr+ a day · {CAP} a day' + (' · market gate' if gate else '') + (' · never stands aside' if ns else ''),
            'desc': f'F on ₹250-1000 stocks trading at least ₹{floor} crore a day, up to {CAP} trades a day, priced at ₹10 lakh positions.' + gate_desc(gate) + (NS_DESC if ns else '')}


def liquid(bp, floor, gate=False, ns=False):
    return {**ml._REAL, 'id': lid(bp, floor, gate, ns), 'S': f'nbSx_l{bp}', 'cap': CAP, 'minTurnover': floor * 1e7, 'gate': gate, 'ns': ns, 'posShare': bp / 10_000,
            'name': f'{bp / 100:.2f}% of turnover · ₹{floor} cr+ a day · {CAP} a day' + (' · market gate' if gate else '') + (' · never stands aside' if ns else ''),
            'desc': f'F on ₹250-1000 stocks trading at least ₹{floor} crore a day, up to {CAP} a day; each position is {bp / 100:.2f}% of the stock\'s daily turnover, ₹1-25 lakh, priced with the charges and market impact of that order.' + gate_desc(gate) + (NS_DESC if ns else '')}


NARROW = [
    {**ml._REAL, 'id': 'nF', 'name': '₹250–340 (control), ₹300 risk', 'desc': 'F as live on the stocks Algo Live trades today, real fills at ₹300 risk.'},
    {**ml._REAL, 'id': 'nT10', 'S': 'nbSx_t10', 'name': '₹250–340 (control), ₹10 lakh positions', 'desc': 'The same at the ₹1 lakh a month size: big-position charges and the market impact of a ₹10 lakh order.'},
]
WIDE = [
    fixed(100), fixed(100, gate=True),
    *[liquid(bp, f, g) for g in (False, True) for f in FLOORS_CR for bp in SHARES_BP],
    fixed(100, ns=True), fixed(100, gate=True, ns=True),
    *[liquid(bp, 100, g, ns=True) for g in (False, True) for bp in SHARES_BP],
    {**ml._REAL, 'id': 'placebo', 'yS': 'nbS_shuf', 'S': f"nbSx_t{PLACEBO_AT['size']}", 'cap': PLACEBO_AT['cap'], 'minTurnover': PLACEBO_AT['floor'] * 1e7,
     'gate': PLACEBO_AT['gate'], 'posFixed': PLACEBO_AT['size'] * 100_000,
     'name': f"Placebo, ₹{PLACEBO_AT['size']} lakh · ₹{PLACEBO_AT['floor']} cr+ · {PLACEBO_AT['cap']} a day · market gate (shuffled outcomes)",
     'desc': 'Learned from outcomes shuffled among stocks of the same month and minute, priced and limited like iteration 15\'s pick. Traded on the real outcomes: it must show no edge.'},
]
UNIVERSES = {'narrow': NARROW, 'wide': WIDE}
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
    for bp in SHARES_BP:
        df[f'nbSx_l{bp}'] = big - impact_r(df, position_rs(df, bp / 10_000))
    return df


def position_rs(df, share):
    """the liquidity-sized position: `share` of the stock's daily turnover, between POS_MIN and POS_MAX (a row without its
    turnover: the typical one)"""
    v = turnover_rs(df)
    ok = np.isfinite(v) & (v > 0)
    fallback = float(np.median(v[ok])) if ok.any() else 1e9
    return np.clip(share * np.where(ok, v, fallback), POS_MIN, POS_MAX)


_allowed = ml.allowed
_choose_bar = ml.choose_bar


def choose_bar(vpart, vl, vs, st):
    """ml_walkforward's bar; a '_ns' version never stands aside: it trades the best bar of the months before even if it lost"""
    thr, total = _choose_bar(vpart, vl, vs, st)
    if st.get('ns') and thr is not None and not total > 0:
        return thr, 1e-9
    return thr, total




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
    ml.MAX_PER_DAY = CAP
    ml.MAX_PER_SIDE = CAP
    ml.allowed = allowed
    ml.choose_bar = choose_bar
    ml.SHARD = shard
    ml.SEED_OFF = 0 if shard == 'main' else int(shard.replace('seed', '') or 0)
    ml.STRATEGIES = strategies if shard == 'main' else [s for s in strategies if s['id'] != 'placebo']
    ml.LOCKED = {'narrow': 'nT10', 'wide': REF}[universe]
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


def diagnostics(res, df, symbols=None):
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
    rupees(res, df, symbols)
    return res


def rupees(res, df, symbols=None):
    """each version's rupees from its own positions (fixed ₹10 lakh, or its share of the stock's turnover), its risk a trade =
    position x stop (half the usual daily range); per decide and exam month, the capital the busiest day needed, and for a
    '_ns' twin what the months its base stood aside made"""
    ef = (res.get('examFrom') or ml.EXAM_FROM)[:7]
    first = df[df['slot'].values == df['slot'].min()]
    name = (lambda c: symbols[int(c)]) if symbols else (lambda c: c)  # trades carry the symbol, the dataset its index
    look = {(d_, name(s_)): (v, a) for d_, s_, v, a in zip(first['day'].values, first['sym'].values, turnover_rs(first), first['adrPct'].values)}
    fallback_v = float(np.nanmedian(turnover_rs(first))) if len(first) else 1e9
    conf = {st['id']: st for u in UNIVERSES.values() for st in u}
    by_id = {s['id']: s for s in res['strategies']}
    for s in res['strategies']:
        st = conf.get(s['id'], {})
        cols = s.get('tradeCols', ['day', 'sym', 'time', 'side', 'pred', 'net'])
        i_day, i_sym, i_net = cols.index('day'), cols.index('sym'), cols.index('net')
        mon = [m for m in s.get('months', []) if m.get('month')]
        n_dec = sum(1 for m in mon if ml.DECIDE_FROM[:7] <= m['month'][:7] < ef) or 1
        n_ex = sum(1 for m in mon if ef <= m['month'][:7] < getattr(ml, 'SHADOW_FROM', '9999')) or 1
        dec_rs = ex_rs = 0.0
        pos_sum, n_pos, risk_sum = 0.0, 0, 0.0
        day_pos = {}
        rs_by_trade = []
        for t in s['trades']:
            if t[i_net] is None:
                rs_by_trade.append(0.0)
                continue
            v, adr = look.get((t[i_day], t[i_sym]), (fallback_v, np.nan))
            v = v if np.isfinite(v) and v > 0 else fallback_v
            if st.get('posShare'):
                pos = float(np.clip(st['posShare'] * v, POS_MIN, POS_MAX))
            else:
                pos = float(st.get('posFixed') or 0)
            stop = (adr / 2) if np.isfinite(adr) and adr > 0 else 2.3
            risk = pos * stop / 100
            r = float(t[i_net]) * risk
            rs_by_trade.append(r)
            m = t[i_day][:7]
            if m < ef:
                dec_rs += r
                pos_sum += pos
                risk_sum += risk
                n_pos += 1
                day_pos[t[i_day]] = day_pos.get(t[i_day], 0.0) + pos
            elif m < getattr(ml, 'SHADOW_FROM', '9999'):
                ex_rs += r
        s['inr'] = {
            'perMonth': round(dec_rs / n_dec), 'examPerMonth': round(ex_rs / n_ex),
            'avgPosition': round(pos_sum / n_pos) if n_pos else None, 'avgRisk': round(risk_sum / n_pos) if n_pos else None,
            'capital': round(max(day_pos.values(), default=0) / LEVERAGE),
        }
        s['_rs'] = rs_by_trade
    for s in res['strategies']:
        if not s['id'].endswith('_ns') or s['id'][:-3] not in by_id:
            continue
        base = by_id[s['id'][:-3]]
        aside = {m['month'][:7] for m in base.get('months', []) if m.get('note')}
        cols = s.get('tradeCols', ['day', 'sym', 'time', 'side', 'pred', 'net'])
        i_day, i_net = cols.index('day'), cols.index('net')
        out = {}
        for part, keep in (('decide', lambda m: m < ef), ('exam', lambda m: ef <= m < getattr(ml, 'SHADOW_FROM', '9999'))):
            xs = [(float(t[i_net]), r) for t, r in zip(s['trades'], s['_rs']) if t[i_net] is not None and t[i_day][:7] in aside and keep(t[i_day][:7])]
            out[part] = {'months': len({m for m in aside if keep(m)}), 'n': len(xs), 'sumR': round(sum(x for x, _ in xs), 2), 'rupees': round(sum(r for _, r in xs))}
        s['nsCheck'] = {'base': base['id'], **out}
    for s in res['strategies']:
        s.pop('_rs', None)


def main(d, universe, shard):
    if universe not in UNIVERSES:
        raise SystemExit(f'unknown universe {universe}')
    configure(universe, shard)
    ml.main(d)
    made = os.path.join(d, 'ml.json' if shard == 'main' else f'ml-{shard}.json')
    res = json.load(open(made))
    check_cap(res)
    head, df = ml.load(d)
    diagnostics(res, df, head.get('symbols'))
    if universe == 'narrow':  # the stocks it actually had, not the whole dataset's list
        res['stocks'] = int(df['sym'].nunique())
    else:
        res['pools'] = pools(df)
    json.dump(res, open(os.path.join(d, f'wide-{universe}-{shard}.json'), 'w'))
    os.remove(made)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else 'main')
