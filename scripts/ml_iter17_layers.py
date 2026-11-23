"""
Algo Lab iteration 17, step 3: learning from losses (B), the break-even versions, the rule fixed before the run, and one
result file for the page.

    python scripts/ml_iter17_layers.py <dir>       reads <dir>/i17-<arm>-<shard>.json, grid.*, paths.*, i17-data.json
                                                  writes <dir>/i17.json

B sits on top of an entry arm's trades (A -> B, C -> B+C, D -> B+D, C+D -> B+C+D). Everything it learns comes from that arm's
own out-of-sample trades in earlier months, month by month, so its numbers are out of sample too:
  * loss sorting: fast stop (stopped within 30 min), turned near target (reached 70%+ of the way, then stopped), drift (open
    and losing at 15:15), shock (a 3+ ATR candle against the trade); shocks are left out of everything B learns;
  * a veto model (the trade's facts at entry and the entry model's prediction -> its result) skips a trade expected to lose,
    below a cut-off picked on the 2 months before;
  * an early-exit model (after the 1st, 2nd, 3rd 10-min candle: how far against / for, the close vs entry, that candle's
    volume, range and Nifty) predicts what holding on makes over closing now; below a cut-off it closes at market;
  * four lessons (the veto, the exit after candle 1, 2, 3) act in a month only if, on the earlier months, they pass all four
    checks: 20+ stocks and none over 10% of the cases, the same direction in 70%+ of quarters, still positive with each
    stock left out, and more net R after counting the winners they cut.
Break-even after costs at 80% / 90% of the way to the target is applied to every version from the trades' own 1-minute paths.
"""
import json
import os
import re
import sys

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

sys.path.insert(0, os.path.dirname(__file__))
import ml_walkforward as ml  # noqa: E402
from ml_iter17 import ARMS, ITERATION, CHANGES  # noqa: E402

COMBOS = {'A': 'A', 'B': 'A', 'C': 'C', 'D': 'D', 'BC': 'C', 'BD': 'D', 'CD': 'CD', 'BCD': 'CD'}  # version -> its entry arm
WITH_B = {'B', 'BC', 'BD', 'BCD'}
PARTS = {'BC': ['B', 'C'], 'BD': ['B', 'D'], 'CD': ['C', 'D'], 'BCD': ['B', 'C', 'D', 'BC', 'BD', 'CD']}
NAMES = {'A': 'A. Control (iteration 10)', 'B': 'B. Learning from losses', 'C': 'C. Chart structures', 'D': 'D. Results days + sector',
         'BC': 'B+C', 'BD': 'B+D', 'CD': 'C+D', 'BCD': 'B+C+D'}
VARIANTS = [('', 'net0', 0, 'no stop move'), ('_be80', 'net80', 80, 'break-even after costs at 80%'), ('_be90', 'net90', 90, 'break-even after costs at 90%')]
RULE = {'beat': 0.03, 't': 2.0, 'draws': 4}
LESSON_RULE = {'stocks': 20, 'maxShare': 0.10, 'quarters': 0.70, 'minQuarters': 3}
LESSONS = ['veto', 'exit1', 'exit2', 'exit3']
VAL = 2          # months the cut-offs are picked on
MIN_TRAIN = 150  # trades a B model needs before it may act
POSITION = 1_000_000  # ₹10 lakh
IMPACT_K, REF_PRICE = 1.25, 340  # scripts/ml_wide.py: square-root market impact
PATH_FACTS = ['mae', 'mfe', 'cl', 'vol', 'nif', 'rng']


def log(*a):
    ml.log(*a)


def slot_of(t):
    h, m = t.split(':')
    return int(h) * 60 + int(m) - 555


def small_model(seed):
    return HistGradientBoostingRegressor(max_iter=80, learning_rate=0.05, max_leaf_nodes=8, min_samples_leaf=40,
                                         l2_regularization=2.0, early_stopping=False, random_state=seed)


# ---- data -------------------------------------------------------------------------------------------------------------

def load_rows(d):
    """F's moments: grid facts + labels needed here, and the path record, keyed by (day, symbol, slot)"""
    head = json.load(open(os.path.join(d, 'grid.json')))
    ph = json.load(open(os.path.join(d, 'paths.json')))
    cols, w = head['cols'], head['width']
    paths = np.fromfile(os.path.join(d, 'paths.bin'), dtype=np.float32).reshape(-1, ph['width'])
    rows = paths[:, 0].astype(np.int64)
    raw = np.memmap(os.path.join(d, 'grid.bin'), dtype=np.float32, mode='r').reshape(-1, w)
    feats = [f['k'] for f in head['features']]
    extra = [c for c in cols if c in set(sum((a['facts'] for a in ARMS.values()), [])) or c == 'resDay']
    take = ['sym', 'date', 'slot'] + feats + ['nbS', 'nbS3', 'nbSx', 'avgVol'] + extra
    g = pd.DataFrame({c: np.asarray(raw[rows, cols.index(c)]) for c in take})
    for i, c in enumerate(ph['cols'][1:], start=1):
        g[c] = paths[:, i]
    g['day'] = np.array(head['dates'])[g['date'].astype(int).values]
    g['symbol'] = np.array(head['symbols'])[g['sym'].astype(int).values]
    g['slot'] = g['slot'].astype(int)
    # ₹10 lakh: the charges of a big position (nbS3 - nbS) and the square-root market impact of a ₹10 lakh order
    turn = g['avgVol'].astype(float).values * np.minimum(g['priceRs'].astype(float).values, REF_PRICE)
    ok = np.isfinite(turn) & (turn > 0)
    turn = np.where(ok, turn, float(np.median(turn[ok])) if ok.any() else 1e9)
    g['sizeShift'] = (g['nbS3'] - g['nbS']).values - IMPACT_K * np.sqrt(POSITION / turn)
    return head, g.set_index(['day', 'symbol', 'slot']), feats


def trades_of(st):
    """an ml_walkforward strategy's (or untouched result's) trades as a frame"""
    cols = st.get('tradeCols') or ['day', 'sym', 'time', 'side', 'pred', 'net', 'gross', 'p1', 'p3']
    t = pd.DataFrame(st.get('trades') or [], columns=cols)
    if not len(t):
        return t.assign(slot=pd.Series(dtype=int), month=pd.Series(dtype=str))
    t['slot'] = t['time'].map(slot_of)
    t['month'] = t['day'].str.slice(0, 7)
    return t.rename(columns={'sym': 'symbol'})


def attach(t, rows):
    """each trade with its moment's facts and path; checks the path's no-move result is the trade's own result"""
    if not len(t):
        return t
    j = t.join(rows, on=['day', 'symbol', 'slot'], rsuffix='_row')
    miss = j['net0'].isna() & j['net'].notna()
    if miss.any():
        raise SystemExit(f'{int(miss.sum())} trades have no path record')
    bad = (np.abs(j['net0'].astype(float) - j['net'].astype(float)) > 0.002) & j['net'].notna()
    if bad.mean() > 0.001:
        raise SystemExit(f'path results do not match the trades ({int(bad.sum())} of {len(j)})')
    j['loss'] = np.select([j['shock'] == 1, j['net0'] >= 0, j['kind'] == 0, (j['kind'] == -1) & (j['mins'] <= 30), (j['kind'] == -1) & (j['mfeFrac'] >= 0.7)],
                          ['shock', 'win', 'drift', 'fast', 'nearTarget'], 'stopped')
    return j


# ---- B: veto and early exit, month by month ---------------------------------------------------------------------------

def veto_X(t, feats):
    return np.column_stack([t['pred'].astype(float).values] + [t[f].astype(float).values for f in feats]).astype(np.float32)


def exit_X(t, j):
    cols = [t['pred'].astype(float).values, np.full(len(t), j, float)] + [t[f'{p}{j}'].astype(float).values for p in PATH_FACTS]
    return np.column_stack(cols).astype(np.float32)


def exit_samples(t, var):
    """(features, hold-minus-exit) for every step a trade was still open at"""
    Xs, ys = [], []
    for j in (1, 2, 3):
        o = t[f'o{j}_{var}'].values == 1
        if o.any():
            Xs.append(exit_X(t[o], j))
            ys.append((t.loc[o, f'net{var}'].astype(float) - t.loc[o, f'x{j}'].astype(float)).clip(-3, 3).values)
    if not Xs:
        return np.zeros((0, 2 + len(PATH_FACTS)), np.float32), np.zeros(0)
    return np.vstack(Xs), np.concatenate(ys)


def fit(X, y, seed):
    if len(y) < MIN_TRAIN:
        return None
    return small_model(seed).fit(X, y)


def apply_exit(t, var, model, thr, steps=(1, 2, 3)):
    """result per trade with the early exit (only at `steps`), and the step it left at (0 = held)"""
    out = t[f'net{var}'].astype(float).values.copy()
    at = np.zeros(len(t), int)
    if model is None or thr is None or not len(t):
        return out, at
    done = np.zeros(len(t), bool)
    for j in (1, 2, 3):
        o = (t[f'o{j}_{var}'].values == 1) & ~done
        if j not in steps or not o.any():
            continue
        p = model.predict(exit_X(t[o], j))
        go = np.flatnonzero(o)[p < thr]
        out[go] = t[f'x{j}'].astype(float).values[go]
        at[go] = j
        done[go] = True
    return out, at


def pick_cut(cands, score):
    """the cut-off that made the most on the bar months; no cut-off wins ties"""
    best, best_v = None, score(None)
    for c in cands:
        v = score(c)
        if v > best_v + 1e-9:
            best, best_v = c, v
    return best


def b_month(train, val, test, feats, var, seed):
    """B's models for one test month: trained on `train`, cut-offs picked on `val`. Returns per-trade lesson effects on test."""
    tr = train[train['loss'] != 'shock']
    res = {'vetoed': np.zeros(len(test), bool), 'exitAt': np.zeros(len(test), int), 'exitR': test[f'net{var}'].astype(float).values.copy()}
    if len(tr) < MIN_TRAIN or not len(test):
        return res
    vm = fit(veto_X(tr, feats), tr[f'net{var}'].astype(float).clip(-3, 3).values, seed)
    Xe, ye = exit_samples(tr, var)
    em = fit(Xe, ye, seed + 1)
    if vm is not None and len(val) >= 20:
        vp = vm.predict(veto_X(val, feats))
        vnet = val[f'net{var}'].astype(float).values
        cut = pick_cut([float(q) for q in np.quantile(vp, [0.1, 0.2, 0.3])], lambda c: vnet.sum() if c is None else vnet[vp >= c].sum())
        if cut is not None:
            res['vetoed'] = vm.predict(veto_X(test, feats)) < cut
    if em is not None and len(val) >= 20:
        thr = pick_cut([0.0, -0.1, -0.2, -0.3], lambda c: apply_exit(val, var, em, c)[0].sum() if c is not None else val[f'net{var}'].astype(float).sum())
        if thr is not None:
            res['exitR'], res['exitAt'] = apply_exit(test, var, em, thr)
            res['thr'] = thr
            res['em'] = em
    return res


def lesson_effects(test, var, b):
    """each lesson on its own: what it changes on each trade (R with it - R without)"""
    base = test[f'net{var}'].astype(float).values
    eff = {'veto': np.where(b['vetoed'], -base, 0.0)}
    for j in (1, 2, 3):
        e = np.zeros(len(test))
        if 'em' in b:
            r, at = apply_exit(test, var, b['em'], b['thr'], steps=(j,))
            e = r - base
        eff[f'exit{j}'] = e
    return eff


def check_lesson(eff, syms, months):
    """the four checks on a lesson's past effects (only the trades it changed count)"""
    hit = eff != 0
    n = int(hit.sum())
    out = {'cases': n, 'stocks': 0, 'maxShare': None, 'quarters': None, 'looMin': None, 'total': round(float(eff.sum()), 2), 'pass': False}
    if n == 0:
        return out
    s = pd.Series(syms[hit])
    counts = s.value_counts()
    out['stocks'] = int(len(counts))
    out['maxShare'] = round(float(counts.iloc[0] / n), 3)
    q = pd.Series(eff[hit]).groupby(pd.Series(months[hit]).map(lambda m: f'{m[:4]}Q{(int(m[5:7]) - 1) // 3 + 1}').values).sum()
    out['quarters'] = [int((q > 0).sum()), int(len(q))]
    by = pd.Series(eff[hit]).groupby(s.values).sum()
    out['looMin'] = round(float(eff.sum() - by.max()), 2) if len(by) else None
    out['pass'] = bool(out['stocks'] >= LESSON_RULE['stocks'] and out['maxShare'] <= LESSON_RULE['maxShare']
                       and len(q) >= LESSON_RULE['minQuarters'] and (q > 0).mean() >= LESSON_RULE['quarters']
                       and out['looMin'] is not None and out['looMin'] > 0 and eff.sum() > 0)
    return out


def run_b(t, feats, var, seed, months_all):
    """B on one arm's out-of-sample trades, month by month. Returns the trades with B's result, and the lesson log."""
    t = t.sort_values(['day', 'slot']).reset_index(drop=True)
    r = t[f'net{var}'].astype(float).values.copy()
    keep = np.ones(len(t), bool)
    eff_all = {k: np.zeros(len(t)) for k in LESSONS}
    seen = np.zeros(len(t), bool)  # months whose lesson effects are known (the past, for the checks)
    active_log = []
    mi = {m: i for i, m in enumerate(months_all)}
    tm = t['month'].map(mi).values
    syms, mons = t['symbol'].values, t['month'].values
    for i, m in enumerate(months_all):
        test = tm == i
        if not test.any():
            continue
        train = t[tm < i - VAL]
        val = t[(tm >= i - VAL) & (tm < i)]
        b = b_month(train, val, t[test], feats, var, seed + i)
        eff = lesson_effects(t[test], var, b)
        checks = {k: check_lesson(eff_all[k][seen], syms[seen], mons[seen]) for k in LESSONS}
        act = [k for k in LESSONS if checks[k]['pass']]
        idx = np.flatnonzero(test)
        if 'veto' in act:
            keep[idx[b['vetoed']]] = False
        steps = tuple(int(k[-1]) for k in act if k.startswith('exit'))
        if steps and 'em' in b:
            rr_, _ = apply_exit(t[test], var, b['em'], b['thr'], steps=steps)
            r[idx] = rr_
        for k in LESSONS:
            eff_all[k][idx] = eff[k]
        seen |= test
        active_log.append({'month': m, 'active': act})
    out = t.assign(bnet=r, bkeep=keep)
    final = {k: check_lesson(eff_all[k], syms, mons) for k in LESSONS}
    return out, active_log, final


def run_b_untouched(dev, held, feats, var, seed, exam_from):
    """B for the untouched months: models from the decide months before the exam (the walk-forward recipe, mirrored)"""
    pre = dev[dev['month'] < exam_from]
    ms = sorted(pre['month'].unique())
    if not len(held) or len(ms) <= VAL:
        return held.assign(bnet=held[f'net{var}'].astype(float).values if len(held) else [], bkeep=True), []
    train, val = pre[pre['month'] < ms[-VAL]], pre[pre['month'] >= ms[-VAL]]
    b = b_month(train, val, held, feats, var, seed)
    # lessons that passed on the decide months (their walk-forward effects)
    _, _, final = run_b(pre, feats, var, seed, ms)
    act = [k for k in LESSONS if final[k]['pass']]
    keep = ~b['vetoed'] if 'veto' in act else np.ones(len(held), bool)
    steps = tuple(int(k[-1]) for k in act if k.startswith('exit'))
    r = apply_exit(held, var, b['em'], b['thr'], steps=steps)[0] if steps and 'em' in b else held[f'net{var}'].astype(float).values
    return held.assign(bnet=r, bkeep=keep), act


# ---- statistics in the walk-forward's own shape -----------------------------------------------------------------------

def restat(base, t, r, months_meta, exam_from, shadow_from, sid, name, desc, gross_shift):
    """a version's results in the shape ml_walkforward writes, from its trades `t` and their results `r`"""
    t = t.assign(net=r, gross=r + gross_shift).sort_values(['day', 'slot'])
    mo = []
    for m in months_meta:
        x = t[t['month'] == m['month']]
        s = ml.stats(x['net'], x['gross'])
        s.update({k: m.get(k) for k in ('month', 'thr', 'note', 'ic', 'exam', 'shadow', 'baseL', 'baseS', 'train', 'val')})
        mo.append(s)
    dev_t = t[t['month'] < exam_from]
    exam_t = t[(t['month'] >= exam_from) & (t['month'] < shadow_from)]
    sh_t = t[t['month'] >= shadow_from]
    overall = ml.period_stats(t, mo)
    eq = np.concatenate([[0], t['net'].astype(float).cumsum().values])
    overall['maxDrawdownR'] = round(float((np.maximum.accumulate(eq) - eq).max()), 2)
    overall['inrPerMonth'] = round(overall['inr'] / max(1, len(mo)))
    dev = ml.period_stats(dev_t, [m for m in mo if not m['exam'] and not m['shadow']])
    exam = ml.period_stats(exam_t, [m for m in mo if m['exam']])
    exam['pass'] = None if exam['n'] < 30 else bool(exam['netR'] > 0)
    shadow = ml.period_stats(sh_t, [m for m in mo if m['shadow']])
    shadow['from'] = shadow_from
    daily = None
    if len(dev_t):
        tday = dev_t.groupby('day')['net'].agg(['sum', 'size'])
        wk = pd.to_datetime(dev_t['day']).dt.strftime('%G-W%V')
        tweek = dev_t.groupby(wk.values)['net'].sum()
        daily = {**(base.get('daily') or {}), 'daysWithTrades': int(len(tday)), 'perTradedDay': round(float(tday['size'].mean()), 2),
                 'maxPerDay': int(tday['size'].max()), 'at0935': round(float((dev_t['slot'] == 20).mean()), 3),
                 'greenDays': round(float((tday['sum'] > 0).mean()), 3), 'worstDayR': round(float(tday['sum'].min()), 2),
                 'bestDayR': round(float(tday['sum'].max()), 2), 'worstWeekR': round(float(tweek.min()), 2), 'greenWeeks': round(float((tweek > 0).mean()), 3)}
    by_hour = []
    if len(dev_t):
        h = (555 + dev_t['slot'].astype(int)) // 60
        for hour in sorted(h.unique()):
            s = ml.stats(dev_t.loc[h == hour, 'net'], dev_t.loc[h == hour, 'gross'])
            s['hour'] = f'{int(hour):02d}:00'
            by_hour.append(s)
    money = None
    if len(dev_t) and dev['monthsTotal']:
        codes = pd.factorize(dev_t['symbol'])[0].astype(np.int32)
        mt = dev_t.assign(sym=codes)
        money = ml.money_of(mt, dev, [], mt[['day', 'sym', 'slot', 'adrPct']], {})
    recent = t.tail(40)
    return {
        **{k: base[k] for k in ('kind', 'baseline', 'targetAdr', 'ic', 'importance', 'liked') if k in base},
        'id': sid, 'name': name, 'desc': desc, 'overall': overall, 'dev': dev, 'exam': exam, 'shadow': shadow, 'money': money,
        'costs': None, 'daily': daily, 'months': mo, 'oldFills': None, 'bands': None,
        'bySide': {'long': ml.stats([]), 'short': ml.stats(dev_t['net'], dev_t['gross'])}, 'byHour': by_hour,
        'recent': [{'day': x.day, 'sym': x.symbol, 'time': x.time, 'side': 'SHORT', 'pred': round(float(x.pred), 3), 'net': round(float(x.net), 2)} for x in recent.itertuples()],
        'tradeCols': ['day', 'sym', 'time', 'side', 'pred', 'net', 'gross', 'p1', 'p3'],
        'trades': [[x.day, x.symbol, x.time, -1, round(float(x.pred), 3), ml.r2(x.net), ml.r2(x.gross), None, None] for x in t.itertuples()],
    }


def held_stats(t, r, months):
    t = t.assign(net=r)
    ms = []
    for m in months:
        x = t[t['month'] == m]
        s = ml.stats(x['net'])
        s['month'] = m
        ms.append(s)
    return ml.period_stats(t.assign(gross=r), ms), ms


# ---- the run ----------------------------------------------------------------------------------------------------------

def main(d):
    shards = {}
    for f in sorted(os.listdir(d)):
        m = re.match(r'^i17-(A|C|D|CD|Cp)-(main|seed\d+)\.json$', f)
        if m:
            shards[(m.group(1), m.group(2))] = json.load(open(os.path.join(d, f)))
    if ('A', 'main') not in shards:
        raise SystemExit('the control (A, main draw) is missing')
    head, rows, feats = load_rows(d)
    main_a = shards[('A', 'main')]
    exam_from, shadow_from = main_a['examFrom'], main_a.get('shadowFrom', ml.SHADOW_FROM)
    draws = sorted({s for (_, s) in shards}, key=lambda s: (s != 'main', s))
    notes = json.load(open(os.path.join(d, 'i17-data.json'))) if os.path.exists(os.path.join(d, 'i17-data.json')) else {}

    def strat(arm, shard, sid=None):
        r = shards.get((arm, shard))
        return next((s for s in r['strategies'] if s['id'] == (sid or arm)), None) if r else None

    def untouched(arm, sid=None):
        r = shards.get((arm, 'main'))
        return next((u for u in (r or {}).get('untouched') or [] if u['id'] == (sid or arm)), None)

    table, strategies, lessons, losses, per_draw = [], [], {}, {}, {}
    for ver, arm in COMBOS.items():
        base_main = strat(arm, 'main')
        if base_main is None:
            continue
        arm_feats = feats + ARMS[arm]['facts']
        months_meta = base_main['months']
        months_all = [m['month'] for m in months_meta]
        held_months = (untouched(arm) or {}).get('months') or []
        held_months = [m['month'] for m in held_months]
        for suf, col, be, be_name in VARIANTS:
            sid = f'{ver}{suf}'
            var = str(be or 0)
            draw_dev = {}
            for shard in draws:
                st = strat(arm, shard)
                if st is None:
                    continue
                t = attach(trades_of(st), rows)
                if ver in WITH_B:
                    bt, act_log, final = run_b(t, arm_feats, var, 17 + draws.index(shard) * 101, months_all)
                    t, r = bt[bt['bkeep']], bt.loc[bt['bkeep'], 'bnet'].values
                    if shard == 'main':
                        lessons[sid] = {'final': final, 'active': act_log}
                else:
                    r = t[col].astype(float).values
                dev_mask = (t['month'] < exam_from).values
                dev_r = r[dev_mask]
                by_m = pd.Series(dev_r).groupby(t.loc[dev_mask, 'month'].values).sum()
                draw_dev[shard] = {'n': int(len(dev_r)), 'netR': round(float(dev_r.mean()), 3) if len(dev_r) else 0, 't': ml.stats(dev_r)['t'],
                                   'green': [int((by_m > 0).sum()), int(len(by_m))],
                                   'sizeR': round(float((dev_r + t.loc[dev_mask, 'sizeShift'].astype(float).values).mean()), 3) if len(dev_r) else 0}
                if shard == 'main':
                    gross_shift = (t['gross'].astype(float) - t['net'].astype(float)).fillna(0).values
                    s = restat(base_main, t, r, months_meta, exam_from, shadow_from, sid, NAMES[ver] + (f' · {be_name}' if be else ''),
                               f'{base_main["desc"]}{" + learning from losses (B)" if ver in WITH_B else ""}; {be_name}.', gross_shift)
                    size = t.assign(r=r + t['sizeShift'].astype(float).values)
                    sd = size[size['month'] < exam_from]['r']
                    s['atSize'] = {'position': POSITION, 'dev': ml.stats(sd), 'exam': ml.stats(size[(size['month'] >= exam_from) & (size['month'] < shadow_from)]['r'])}
                    if suf == '' and ver in ('A', 'B', 'C', 'BC', 'D', 'BD', 'CD', 'BCD'):
                        lt = t.assign(r=r)
                        losses[sid] = {k: int(v) for k, v in lt[lt['month'] < exam_from]['loss'].value_counts().items()}
                    strategies.append(s)
            # the untouched months (main draw): the entry arm's own untouched trades, B mirrored
            u = untouched(arm)
            un = None
            if u and u.get('trades'):
                ht = attach(trades_of(u), rows)
                if ver in WITH_B:
                    dev_all = attach(trades_of(base_main), rows)
                    hb, act = run_b_untouched(dev_all, ht, arm_feats, var, 4242, exam_from)
                    o, ms = held_stats(hb[hb['bkeep']], hb.loc[hb['bkeep'], 'bnet'].values, held_months)
                    un = {**o, 'lessons': act}
                else:
                    o, ms = held_stats(ht, ht[col].astype(float).values, held_months)
                    un = o
                un['months'] = ms
            per_draw[sid] = draw_dev
            s = next(x for x in strategies if x['id'] == sid)
            table.append({'id': sid, 'version': ver, 'be': be, 'name': s['name'], 'dev': s['dev'], 'exam': s['exam'], 'shadow': s['shadow'],
                          'untouched': un, 'draws': draw_dev, 'atSize': s['atSize']})
            log(sid, 'dev', s['dev']['netR'], 't', s['dev']['t'], 'n', s['dev']['n'], 'exam', s['exam']['netR'], 'untouched', (un or {}).get('netR'),
                'draws', [v['netR'] for v in draw_dev.values()])

    # the placebos: C from random lines, and the shuffled outcomes
    cp = strat('Cp', 'main')
    cp_row = None
    if cp is not None:
        cp_row = {'id': 'Cp', 'name': cp['name'], 'dev': cp['dev'], 'exam': cp['exam'],
                  'draws': {sh: {'netR': strat('Cp', sh)['dev']['netR']} for sh in draws if strat('Cp', sh)}}
        strategies.append({**cp, 'trades': cp.get('trades')})
    pb = strat('A', 'main', 'placebo')
    old = strat('A', 'main', 'A_old')
    for x in (old, pb):
        if x is not None:
            strategies.append(x)

    verdict = rule(table, cp_row, pb)
    best = verdict['pick'] or 'A'
    result = {
        **{k: main_a[k] for k in ('v', 'runId', 'createdAt', 'code', 'period', 'examFrom', 'rows', 'stocks', 'days', 'setup', 'baselineTight',
                                  'decideFrom', 'shadowFrom', 'factLabels') if k in main_a},
        'iteration': ITERATION, 'changes': CHANGES, 'best': best, 'locked': 'A', 'overall': next(s for s in strategies if s['id'] == best)['overall'],
        'untouched': [], 'volChoice': None, 'strategies': strategies,
        'noise': noise_of(per_draw.get('A', {})),
        'iter17': {'table': table, 'placeboC': cp_row, 'placebo': {'dev': pb['dev'], 'ic': pb['ic']} if pb else None,
                   'oldFills': {'dev': old['dev'], 'exam': old['exam']} if old else None,
                   'lessons': lessons, 'lessonRule': LESSON_RULE, 'losses': losses, 'rule': RULE, 'verdict': verdict, 'data': notes,
                   'structureFacts': structure_share(strategies)},
    }
    json.dump(result, open(os.path.join(d, 'i17.json'), 'w'))
    log('verdict', verdict['message'])


def noise_of(draws):
    ds = [{'draw': k, 'n': v['n'], 'netR': v['netR'], 't': v['t'], 'devNetR': v['netR'], 'devT': v['t'], 'devGreen': v['green']} for k, v in draws.items()]
    if len(ds) < 2:
        return None
    dv = [x['devNetR'] for x in ds]
    return {'strategy': 'A', 'draws': ds, 'devMin': min(dv), 'devMax': max(dv), 'devMean': round(sum(dv) / len(dv), 3)}


def structure_share(strategies):
    """how much of the C models' split gain went to the new facts (main draw, decide months)"""
    out = {}
    for s in strategies:
        if s['id'] in ('C', 'CD', 'D', 'Cp'):
            imp = s.get('importance') or []
            new = [x for x in imp if x['f'] in set(sum((a['facts'] for a in ARMS.values()), []))]
            out[s['id']] = {'inTop15': [{'f': x['f'], 'label': x['label'], 'share': x['share']} for x in new]}
    return out


def rule(table, cp_row, pb):
    """the rule fixed before the run (see CHANGES)"""
    by = {r['id']: r for r in table}
    a = by.get('A')
    if a is None:
        return {'pick': None, 'outcome': 'incomplete', 'message': 'The control did not run.', 'versions': [], 'breakEven': []}
    a_draws = a['draws']
    placebo_clean = pb is None or not (pb['dev']['n'] >= 100 and pb['dev']['netR'] > 0.02 and pb['dev']['t'] >= 2)
    # C against its random-lines twin (a twin that took fewer than 30 trades found nothing: it counts as the control)
    cp_ref = None if cp_row is None else (cp_row['dev']['netR'] if cp_row['dev']['n'] >= 30 else a['dev']['netR'])
    cp_gap = None if cp_ref is None or 'C' not in by else round(by['C']['dev']['netR'] - cp_ref, 3)
    versions = []
    for ver in ['B', 'C', 'D', 'BC', 'BD', 'CD', 'BCD']:
        r = by.get(ver)
        if r is None:
            continue
        dv, ad = r['dev'], a['dev']
        beats = [k for k, v in r['draws'].items() if k in a_draws and v['netR'] > a_draws[k]['netR']]
        un_ok = r['untouched'] is not None and a['untouched'] is not None and r['untouched']['netR'] >= a['untouched']['netR']
        checks = [
            {'label': f'beats A by +{RULE["beat"]}R a trade on the decide months', 'ok': dv['netR'] - ad['netR'] >= RULE['beat'] - 1e-9},
            {'label': f't {RULE["t"]}+ on the decide months', 'ok': dv['t'] >= RULE['t']},
            {'label': 'passes the exam', 'ok': bool(r['exam'].get('pass'))},
            {'label': 'not worse than A on the untouched months', 'ok': bool(un_ok)},
            {'label': f'beats A in {RULE["draws"]} of {len(r["draws"])} training draws', 'ok': len(beats) >= RULE['draws']},
            {'label': 'beats A at ₹10 lakh positions', 'ok': r['atSize']['dev']['netR'] > a['atSize']['dev']['netR']},
        ]
        if ver in PARTS:
            parts = [by[p] for p in PARTS[ver] if p in by]
            best_part = max(parts, key=lambda x: x['dev']['netR']) if parts else None
            checks.append({'label': f'beats its best single part ({best_part["version"] if best_part else "–"})', 'ok': best_part is None or dv['netR'] > best_part['dev']['netR']})
        if 'C' in ver:
            checks.append({'label': f'C beats its random-lines twin by +{RULE["beat"]}R', 'ok': cp_gap is not None and cp_gap >= RULE['beat'] - 1e-9})
        checks.append({'label': 'the shuffled placebo shows no edge', 'ok': placebo_clean})
        versions.append({'id': ver, 'name': r['name'], 'gain': round(dv['netR'] - ad['netR'], 3), 'checks': checks, 'pass': all(c['ok'] for c in checks)})
    be = []
    for ver in COMBOS:
        for suf in ('_be80', '_be90'):
            r, b0 = by.get(ver + suf), by.get(ver)
            if r is None or b0 is None:
                continue
            ok_dev = r['dev']['netR'] > b0['dev']['netR']
            ok_exam = r['exam']['n'] > 0 and r['exam']['netR'] > b0['exam']['netR']
            ok_un = r['untouched'] is not None and b0['untouched'] is not None and r['untouched']['netR'] > b0['untouched']['netR']
            be.append({'id': ver + suf, 'version': ver, 'at': int(suf[3:]), 'dev': round(r['dev']['netR'] - b0['dev']['netR'], 3),
                       'exam': round(r['exam']['netR'] - b0['exam']['netR'], 3), 'untouched': round(r['untouched']['netR'] - b0['untouched']['netR'], 3) if ok_un or (r['untouched'] and b0['untouched']) else None,
                       'pass': bool(ok_dev and ok_exam and ok_un)})
    passed = [v for v in versions if v['pass']]
    pick = max(passed, key=lambda v: by[v['id']]['dev']['netR']) if passed else None
    be_pass = [x for x in be if x['pass'] and (pick is None or x['version'] == pick['id'])]
    if pick:
        msg = f'{pick["name"]} passes the rule: {pick["gain"]:+.3f}R a trade over the control on the decide months.'
    else:
        near = max(versions, key=lambda v: sum(c['ok'] for c in v['checks'])) if versions else None
        msg = 'No version passes the rule: iteration 10 stays as it is.' + (f' Closest: {near["name"]} ({sum(c["ok"] for c in near["checks"])} of {len(near["checks"])} checks).' if near else '')
    be_any = [x for x in be if x['pass']]
    msg += f' Break-even: {", ".join(f"{x["version"]} at {x["at"]}%" for x in be_any)} beats no move on every period.' if be_any else ' Break-even at 80% / 90% beats no move nowhere on every period.'
    return {'pick': pick['id'] if pick else None, 'outcome': 'better' if pick else 'not-better', 'message': msg, 'versions': versions,
            'breakEven': be, 'breakEvenPick': be_pass[0]['id'] if be_pass else None, 'placeboClean': placebo_clean, 'placeboCGap': cp_gap}


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'ml-data')
