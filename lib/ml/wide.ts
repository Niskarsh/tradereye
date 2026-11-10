import type { Candles } from '../dhan';
import { WIDE_REF_PRICE, wideVol } from './grid';

/**
 * Algo Lab iteration 12: the same strategy (F as Algo Live trades it) on a wider set of stocks. Research only: nothing
 * here is read by Algo Live, My Setups or the monthly model.
 *
 * Which stocks: previous close ₹250-1000 (₹0.05 is the NSE tick all through that range, so the fill code holds as it is)
 * and the same liquidity floor as now, measured in rupees. A stock inside ₹250-340 is treated exactly as before.
 */
/** the iteration the Run button starts (must equal ITERATION in scripts/ml_wide.py: tests/mlWide.test.ts checks), and what it tests */
export const WIDE_ITERATION = 14;
export const WIDE_QUESTION = 'Which liquidity floor (₹17–1,000 crore a day) and how many trades a day (2, 3 or 4) make ₹250–1000 pay at ₹10 lakh positions, the ₹1–1.5 lakh a month size?';

export const WIDE_PRICE_MIN = 250, WIDE_PRICE_MAX = 1000, WIDE_VOL_MIN = 500_000;

const IST = 19800_000;
const dateOf = (sec: number) => new Date(sec * 1000 + IST).toISOString().slice(0, 10);

export interface WideDay { date: string; narrow: boolean }

/** The days in [from, to] a stock is in the wide universe (by the previous close and 10 prior sessions, both known before
 * the open); `narrow` = it also passed the screener Algo Live uses. */
export function wideDays(daily: Candles, from: string, to: string): WideDay[] {
  const out: WideDay[] = [];
  for (let i = 10; i < daily.t.length; i++) {
    const date = dateOf(daily.t[i]);
    if (date < from || date > to) continue;
    const pc = daily.c[i - 1];
    if (!(pc >= WIDE_PRICE_MIN && pc <= WIDE_PRICE_MAX)) continue;
    let v = 0;
    for (let j = i - 10; j < i; j++) v += daily.v[j];
    if (wideVol(v / 10, pc) > WIDE_VOL_MIN) out.push({ date, narrow: pc <= WIDE_REF_PRICE });
  }
  return out;
}

/**
 * NSE equity holidays on weekdays (NSE's list; add next year's when NSE publishes it in December). On these days the run
 * goes at full speed all morning. A holiday missing from here is still caught by the job's own check from 09:20
 * (no Nifty 500 candles today), when the market-hours override is on.
 */
export const NSE_HOLIDAYS = new Set([
  '2026-01-15', '2026-01-26', '2026-03-03', '2026-03-26', '2026-03-31', '2026-04-03', '2026-04-14', '2026-05-01', '2026-05-28',
  '2026-06-26', '2026-09-14', '2026-10-02', '2026-10-20', '2026-11-10', '2026-11-24', '2026-12-25',
]);
export const istDate = (ms: number) => new Date(ms + IST).toISOString().slice(0, 10);
export const istMinute = (ms: number) => { const t = new Date(ms + IST); return t.getUTCHours() * 60 + t.getUTCMinutes(); };

/** The run would compete with Algo Live for Dhan's request limit (same account) in this window on a trading day. */
export function inLiveWindow(ms: number): boolean {
  const day = new Date(ms + IST).getUTCDay(), min = istMinute(ms);
  return day >= 1 && day <= 5 && min >= 8 * 60 + 40 && min < 11 * 60 + 15 && !NSE_HOLIDAYS.has(istDate(ms));
}

/* ---- ETFs are not stocks ------------------------------------------------------------------------------------- */

/** Funds Dhan lists as NSE equity that the results showed being traded (iteration 12); caught by name too, this is a backstop. */
const ETF_SYMBOLS = new Set(['MON100', 'MONQ50', 'MAFANG', 'MASPTOP50', 'MAHKTECH', 'NIFTYBEES', 'NIFTYIETF', 'NIFTYETF', 'NIFTYBETA', 'SBINIFTY50', 'SETFNIF50']);
const ETF_NAME = /\bETF\b|\bBEES\b|EXCHANGE TRADED|INDEX FUND|\bFOF\b/i;
const ETF_SYMBOL = /(BEES|ETF|IETF)$/i;

/**
 * NSE "equity" symbols in Dhan's instrument list that are really exchange-traded funds: by Dhan's instrument type, the
 * fund's name, the symbol, or the backstop list. Iteration 13 on leaves them out of the wide universe: an ETF that
 * tracks the US market (MONQ50, MON100) moves on its premium in the Indian morning, not on the facts the model reads.
 */
export function etfSymbols(csv: string): Set<string> {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  const out = new Set<string>(ETF_SYMBOLS);
  if (lines.length < 2) return out;
  const split = (line: string) => {
    const f: string[] = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ',') { f.push(cur); cur = ''; } else cur += ch;
    }
    f.push(cur); return f;
  };
  const head = split(lines[0]).map((h) => h.trim().replace(/^\uFEFF/, ''));
  const col = (...n: string[]) => n.map((x) => head.indexOf(x)).find((i) => i >= 0) ?? -1;
  const iExch = col('SEM_EXM_EXCH_ID', 'EXCH_ID'), iSeg = col('SEM_SEGMENT', 'SEGMENT'), iSym = col('SEM_TRADING_SYMBOL', 'UNDERLYING_SYMBOL', 'SYMBOL_NAME');
  const iType = col('SEM_EXCH_INSTRUMENT_TYPE', 'INSTRUMENT_TYPE'), iNames = [col('SM_SYMBOL_NAME', 'DISPLAY_NAME'), col('SEM_CUSTOM_SYMBOL')].filter((i) => i >= 0);
  for (const line of lines.slice(1)) {
    const f = split(line);
    if (iExch >= 0 && f[iExch] !== 'NSE') continue;
    if (iSeg >= 0 && f[iSeg] !== 'E') continue;
    const sym = (f[iSym] ?? '').trim().toUpperCase();
    if (!sym) continue;
    if ((iType >= 0 && /ETF/i.test(f[iType] ?? '')) || iNames.some((i) => ETF_NAME.test(f[i] ?? '')) || ETF_SYMBOL.test(sym)) out.add(sym);
  }
  return out;
}

/* ---- the verdict, by a rule fixed before the run ------------------------------------------------------------ */

/**
 * Iteration 14: every version priced at ₹10 lakh positions (also ₹5 lakh), across turnover floors x trades a day, plus
 * size-aware picking (scripts/ml_wide.py). The rule judges the pattern, not the best cell: a winner must be good on its
 * own AND have good neighbours, so one lucky cell among ~60 does not count.
 */
export const WIDE_RULE = { netR: 0.05, t: 2, n: 150, pool: 50 };
export const WIDE_CONTROL = 'nT10';
/** the goal, and the position size the test is priced at */
export const MONTHLY_GOAL = 100_000, MONTHLY_GOAL_HIGH = 150_000, TARGET_POSITION = 1_000_000;
export const FLOORS_CR = [17, 50, 100, 170, 250, 340, 500, 750, 1000];
export const CAPS = [2, 3, 4];
/** fewer training draws than this on either side and the comparison says nothing */
export const WIDE_MIN_DRAWS = 3;

interface Dev { n: number; netR: number; t: number; sumR: number }
type Exam = { n?: number; netR?: number; t?: number; pass?: boolean | null } | null | undefined;
type Money = { tradesPerMonth?: number; stopPct?: number } | null;
export interface WideShard {
  universe: 'narrow' | 'wide' | 'wide5'; shard: string; pools?: Record<string, number>;
  strategies: { id: string; name: string; dev: Dev; exam?: Exam; money?: Money }[];
}
export interface WideDraw { shard: string; netR: number }
export interface WideCell {
  id: string; size: number; floor: number | 'aware'; cap: number;
  n: number; netR: number; t: number; rPerMonth: number; tradesPerMonth: number; exam: boolean; pool: number | null;
  /** clears the bar on its own (trades, R, t, pool, exam) */ solid: boolean;
  /** solid and its neighbours are profitable too */ candidate: boolean;
}
export interface WideVerdict {
  outcome: 'better' | 'not-better' | 'incomplete';
  message: string;
  rule: typeof WIDE_RULE;
  pick: { id: string; name: string; netR: number; t: number; n: number; sumR: number } | null;
  control: { id: string; name: string; netR: number; t: number; n: number; sumR: number } | null;
  narrowDraws: WideDraw[]; wideDraws: WideDraw[]; wideMean: number | null;
  checks: { floor: boolean; beatsNoise: boolean; moreTotalR: boolean; placeboClean: boolean; examPass?: boolean };
  checkList?: { label: string; ok: boolean }[];
  goal?: { perMonth: number; positionForGoal: number | null; positionForHigh?: number | null; riskPerTrade?: number; tradesPerMonth: number; stopPct: number } | null;
  /** (iteration 14 on) every floor x cap cell, both sizes */
  grid?: WideCell[];
  pools?: Record<string, number>;
}

/** rupees a month at a position size, and the position that makes `goal` a month (decide months, no compounding) */
export function goalMoney(netR: number, tradesPerMonth: number, stopPct: number, position = TARGET_POSITION, goal = MONTHLY_GOAL) {
  const perR = (pos: number) => (pos * stopPct) / 100;
  const perMonth = Math.round(netR * tradesPerMonth * perR(position));
  const positionForGoal = netR > 0 && tradesPerMonth > 0 && stopPct > 0 ? Math.round(goal / (netR * tradesPerMonth * stopPct / 100)) : null;
  return { perMonth, positionForGoal, tradesPerMonth, stopPct };
}

const draws = (shards: WideShard[], universe: WideShard['universe'], id: string | undefined): WideDraw[] =>
  shards.filter((s) => s.universe === universe).flatMap((s) => {
    const st = s.strategies.find((x) => x.id === id);
    return st && st.dev.n ? [{ shard: s.shard, netR: st.dev.netR }] : [];
  });

/** the exam months (from May 26) as Algo Lab marks them: profitable after costs */
export const examPasses = (e: Exam) => !!e && (e.pass !== undefined && e.pass !== null ? e.pass : (e.n ?? 0) >= 30 && (e.netR ?? 0) > 0);

const CELL_ID = /^w(\d+)_(?:f(\d+)|(aware))_c(\d)$/;

/** the grid of one size from a main shard */
export function gridCells(strategies: WideShard['strategies'], pools: Record<string, number> | undefined): WideCell[] {
  const cells: WideCell[] = strategies.flatMap((s) => {
    const m = CELL_ID.exec(s.id);
    if (!m) return [];
    const floor = m[3] ? 'aware' as const : Number(m[2]);
    const tpm = s.money?.tradesPerMonth ?? 0;
    const pool = pools ? pools[String(floor === 'aware' ? FLOORS_CR[0] : floor)] ?? null : null;
    const exam = examPasses(s.exam);
    const solid = s.dev.n >= WIDE_RULE.n && s.dev.netR >= WIDE_RULE.netR && s.dev.t >= WIDE_RULE.t && exam && (pool ?? 0) >= WIDE_RULE.pool;
    return [{ id: s.id, size: Number(m[1]), floor, cap: Number(m[4]), n: s.dev.n, netR: s.dev.netR, t: s.dev.t, tradesPerMonth: tpm,
      rPerMonth: Math.round(s.dev.netR * tpm * 100) / 100, exam, pool, solid, candidate: false }];
  });
  const at = (size: number, floor: WideCell['floor'], cap: number) => cells.find((c) => c.size === size && c.floor === floor && c.cap === cap);
  for (const c of cells) {
    if (!c.solid) continue;
    const near: (WideCell | undefined)[] = [at(c.size, c.floor, c.cap - 1), at(c.size, c.floor, c.cap + 1)];
    if (c.floor !== 'aware') {
      const k = FLOORS_CR.indexOf(c.floor);
      near.push(at(c.size, FLOORS_CR[k - 1], c.cap), at(c.size, FLOORS_CR[k + 1], c.cap));
    }
    const have = near.filter((x): x is WideCell => !!x);
    const good = have.filter((x) => x.netR > 0 && x.n > 0).length;
    c.candidate = have.length > 0 && good >= Math.min(2, have.length);
  }
  return cells;
}

/**
 * Decide months, ₹10 lakh positions. The pick is the candidate (solid on its own, profitable neighbours) making the most R a
 * month; it wins only if its average over the training draws beats the ₹250-340 control's best draw and the placebo shows
 * no edge. ₹5 lakh cells are shown, not judged.
 */
export function wideVerdict(shards: WideShard[]): WideVerdict {
  const main = (u: WideShard['universe']) => shards.find((s) => s.universe === u && s.shard === 'main');
  const wide = main('wide'), narrow = main('narrow'), wide5 = main('wide5');
  const brief = (x: { id: string; name: string; dev: Dev } | undefined) => (x ? { id: x.id, name: x.name, netR: x.dev.netR, t: x.dev.t, n: x.dev.n, sumR: x.dev.sumR } : null);
  const grid = [...(wide ? gridCells(wide.strategies, wide.pools) : []), ...(wide5 ? gridCells(wide5.strategies, wide5.pools ?? wide?.pools) : [])];
  const tens = grid.filter((c) => c.size === 10);
  const best = tens.filter((c) => c.candidate).sort((a, b) => b.rPerMonth - a.rPerMonth)[0];
  const pickSt = best ? wide?.strategies.find((s) => s.id === best.id) : undefined;
  const control = narrow?.strategies.find((x) => x.id === WIDE_CONTROL);
  const placebo = wide?.strategies.find((x) => x.id === 'placebo');
  const narrowDraws = draws(shards, 'narrow', WIDE_CONTROL), wideDraws = best ? draws(shards, 'wide', best.id) : [];
  const wideMean = wideDraws.length ? Math.round((wideDraws.reduce((a, d) => a + d.netR, 0) / wideDraws.length) * 1000) / 1000 : null;
  const ctrlTpm = control?.money?.tradesPerMonth ?? 0;
  const checks = {
    floor: tens.some((c) => c.solid),
    examPass: !!best?.exam,
    beatsNoise: wideMean !== null && narrowDraws.length > 0 && wideMean > Math.max(...narrowDraws.map((x) => x.netR)),
    moreTotalR: !!best && !!control && best.rPerMonth > control.dev.netR * ctrlTpm,
    placeboClean: !!placebo && !(placebo.dev.n >= 100 && placebo.dev.t >= 2 && placebo.dev.netR > 0),
  };
  const checkList = [
    { label: `a version at ₹10 lakh makes +${WIDE_RULE.netR}R a trade, t ${WIDE_RULE.t}+, ${WIDE_RULE.n}+ trades, ${WIDE_RULE.pool}+ stocks a day, exam profitable`, ok: checks.floor },
    { label: 'its neighbours (next floor, next cap) are profitable too', ok: !!best },
    { label: "its average over the draws beats the ₹250–340 control's best draw at the same size", ok: checks.beatsNoise },
    { label: 'more R a month than the control', ok: checks.moreTotalR },
    { label: 'the placebo shows no edge', ok: checks.placeboClean },
  ];
  const m = pickSt?.money;
  const goal = best && m?.tradesPerMonth && m?.stopPct ? { ...goalMoney(best.netR, m.tradesPerMonth, m.stopPct), positionForHigh: goalMoney(best.netR, m.tradesPerMonth, m.stopPct, TARGET_POSITION, MONTHLY_GOAL_HIGH).positionForGoal, riskPerTrade: Math.round(TARGET_POSITION * m.stopPct / 100) } : null;
  const base = { rule: WIDE_RULE, pick: brief(pickSt), control: brief(control), narrowDraws, wideDraws, wideMean, checks, checkList, goal, grid, pools: wide?.pools };
  if (!wide || !narrow || !control || !placebo || narrowDraws.length < WIDE_MIN_DRAWS) {
    return { ...base, outcome: 'incomplete', message: `Not enough finished jobs to judge (₹250–340 draws: ${narrowDraws.length}; ${WIDE_MIN_DRAWS} needed). See the GitHub run.` };
  }
  if (!checks.placeboClean) return { ...base, outcome: 'not-better', message: 'The placebo shows an edge: something leaks. Do not trust this run.' };
  if (!checks.floor) return { ...base, outcome: 'not-better', message: 'No floor or cap holds at ₹10 lakh positions. Higher volume does not fix size for this strategy.' };
  if (!best) return { ...base, outcome: 'not-better', message: 'Only isolated cells hold at ₹10 lakh, with weak neighbours: likely luck. Do not move Algo Live.' };
  if (wideDraws.length < WIDE_MIN_DRAWS) return { ...base, outcome: 'incomplete', message: `${pickSt?.name ?? best.id} looks best but too few training draws finished to check it (${wideDraws.length}).` };
  if (!checks.beatsNoise) return { ...base, outcome: 'not-better', message: `${pickSt?.name ?? best.id} is the best pattern but does not beat ₹250–340 by more than training luck.` };
  if (!checks.moreTotalR) return { ...base, outcome: 'not-better', message: `${pickSt?.name ?? best.id} makes less a month than ₹250–340.` };
  return { ...base, outcome: 'better', message: `${pickSt?.name ?? best.id} holds at ₹10 lakh positions, with good neighbours, beyond training luck. A candidate for Algo Live.` };
}
