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
export const WIDE_ITERATION = 16;
export const WIDE_QUESTION = 'Does sizing each trade by the stock\'s own liquidity make iteration 15\'s pick (₹100 crore+, 3 a day, market gate) pay more a month; and does standing aside after 3 losing months cost money?';

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
 * Iteration 15 (scripts/ml_wide.py): iteration 14's region judged as a BLOCK, at one size at a time: ₹50 / 100 / 170 crore a
 * day x 3 / 4 trades a day, at ₹5, 8, 10, 12 and 15 lakh positions, and the ₹10 lakh block again with the market gate. A
 * block holds only if it is good on the decide months AND mostly profitable on the exam months, so one cell that got lucky on
 * the exam (iteration 14's pick) cannot carry it.
 */
export const WIDE_RULE = { netR: 0.05, t: 2, n: 150, pool: 50, strongMin: 5, examMin: 4 };
export const WIDE_CONTROL = 'nT10';
/** the goal, and the size the draws are trained at */
export const MONTHLY_GOAL = 100_000, MONTHLY_GOAL_HIGH = 150_000, TARGET_POSITION = 1_000_000;
export const FLOORS_CR = [50, 100, 170];
export const CAPS = [3, 4];
export const SIZES_LAKH = [5, 8, 10, 12, 15];
/** fewer training draws than this on either side and the comparison says nothing */
export const WIDE_MIN_DRAWS = 3;

interface Dev { n: number; netR: number; t: number; sumR: number }
type Exam = { n?: number; netR?: number; t?: number; pass?: boolean | null } | null | undefined;
type Money = { tradesPerMonth?: number; stopPct?: number } | null;
/** (iteration 16) rupees from each version's own positions: decide and exam months, average position and risk, the busiest day's margin */
export interface Inr { perMonth: number; examPerMonth: number; avgPosition: number | null; avgRisk: number | null; capital: number }
/** (iteration 16) a '_ns' twin: what the months its base stood aside made, decide and exam */
export interface NsCheck { base: string; decide: { months: number; n: number; sumR: number; rupees: number }; exam: { months: number; n: number; sumR: number; rupees: number } }
export interface WideShard {
  universe: 'narrow' | 'wide' | 'wide5' | 'ladder'; shard: string; pools?: Record<string, number>;
  strategies: { id: string; name: string; dev: Dev; exam?: Exam; money?: Money; inr?: Inr | null; nsCheck?: NsCheck | null }[];
}
export interface WideDraw { shard: string; netR: number }
export interface WideCell {
  id: string; size: number; floor: number | 'aware'; cap: number;
  n: number; netR: number; t: number; rPerMonth: number; tradesPerMonth: number; exam: boolean; pool: number | null;
  /** clears the bar on its own (trades, R, t, pool, exam) */ solid: boolean;
  /** (iteration 14) solid and its neighbours are profitable too; (15) solid and in a block that holds */ candidate: boolean;
  /** (iteration 15) with the market gate */ gate?: boolean;
  /** (iteration 15) rupees a month at its own size: R a month x its risk a trade */ inrPerMonth?: number;
}
/** (iteration 15) one block: 6 cells at one size, gated or not */
export interface WideBlock { size: number; gate: boolean; cells: number; strong: number; examOk: number; holds: boolean; best: string | null; inrPerMonth: number | null }
export interface WideVerdict {
  outcome: 'better' | 'not-better' | 'incomplete';
  message: string;
  rule: typeof WIDE_RULE;
  pick: { id: string; name: string; netR: number; t: number; n: number; sumR: number } | null;
  control: { id: string; name: string; netR: number; t: number; n: number; sumR: number } | null;
  narrowDraws: WideDraw[]; wideDraws: WideDraw[]; wideMean: number | null;
  checks: { floor: boolean; beatsNoise: boolean; moreTotalR: boolean; placeboClean: boolean; examPass?: boolean };
  checkList?: { label: string; ok: boolean }[];
  goal?: { perMonth: number; positionForGoal: number | null; positionForHigh?: number | null; riskPerTrade?: number; tradesPerMonth: number; stopPct: number; position?: number } | null;
  /** (iteration 14 on) every cell */
  grid?: WideCell[];
  pools?: Record<string, number>;
  /** (iteration 15 on) every block */
  blocks?: WideBlock[];
  /** (iteration 16 on) every liquidity-sized version and the references */
  liquidity?: WideLiquid[];
  /** (iteration 16 on) whether the pick should stop standing aside, and why */
  standAside?: { twin: string; drop: boolean; decide: NsCheck['decide'] | null; examOk: boolean; message: string } | null;
}
/** (iteration 16) one version of the liquidity grid */
export interface WideLiquid {
  id: string; bp: number | null; floor: number; gate: boolean; n: number; netR: number; t: number; exam: boolean; pool: number | null;
  inrPerMonth: number; inrExamPerMonth: number; avgPosition: number | null; avgRisk: number | null; capital: number;
  drawMean: number | null; draws: number; solid: boolean; neighboursOk: number; winner: boolean;
}

/** rupees a month at a position size, and the position that makes `goal` a month (decide months, no compounding) */
export function goalMoney(netR: number, tradesPerMonth: number, stopPct: number, position = TARGET_POSITION, goal = MONTHLY_GOAL) {
  const perR = (pos: number) => (pos * stopPct) / 100;
  const perMonth = Math.round(netR * tradesPerMonth * perR(position));
  const positionForGoal = netR > 0 && tradesPerMonth > 0 && stopPct > 0 ? Math.round(goal / (netR * tradesPerMonth * stopPct / 100)) : null;
  return { perMonth, positionForGoal, tradesPerMonth, stopPct };
}

/** the exam months (from May 26) as Algo Lab marks them: profitable after costs */
export const examPasses = (e: Exam) => !!e && (e.pass !== undefined && e.pass !== null ? e.pass : (e.n ?? 0) >= 30 && (e.netR ?? 0) > 0);

const CELL_ID = /^w(\d+)_(?:f(\d+)|(aware))_c(\d)(_g)?$/;
const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);

/** the cells of one shard's strategies (any size) */
export function gridCells(strategies: WideShard['strategies'], pools: Record<string, number> | undefined): WideCell[] {
  return strategies.flatMap((s) => {
    const m = CELL_ID.exec(s.id);
    if (!m) return [];
    const floor = m[3] ? 'aware' as const : Number(m[2]), size = Number(m[1]);
    const tpm = s.money?.tradesPerMonth ?? 0, stop = s.money?.stopPct ?? 0;
    const pool = pools ? pools[String(floor === 'aware' ? 17 : floor)] ?? null : null;
    const exam = examPasses(s.exam);
    const solid = s.dev.n >= WIDE_RULE.n && s.dev.netR >= WIDE_RULE.netR && s.dev.t >= WIDE_RULE.t && exam && (pool ?? 0) >= WIDE_RULE.pool;
    const rPerMonth = Math.round(s.dev.netR * tpm * 100) / 100;
    return [{ id: s.id, size, floor, cap: Number(m[4]), n: s.dev.n, netR: s.dev.netR, t: s.dev.t, tradesPerMonth: tpm, rPerMonth, exam, pool, solid,
      candidate: false, gate: !!m[5], inrPerMonth: Math.round(s.dev.netR * tpm * size * 100_000 * stop / 100) }];
  });
}

/** each block's numbers by the rule; marks the cells of the blocks that hold */
export function blocksOf(cells: WideCell[]): WideBlock[] {
  const keys = [...new Set(cells.map((c) => `${c.size}|${c.gate ? 1 : 0}`))];
  return keys.map((k) => {
    const [size, g] = k.split('|').map(Number), gate = g === 1;
    const mine = cells.filter((c) => c.size === size && !!c.gate === gate);
    const strong = mine.filter((c) => c.n >= WIDE_RULE.n && c.netR >= WIDE_RULE.netR && c.t >= WIDE_RULE.t).length;
    const examOk = mine.filter((c) => c.exam).length;
    const holds = mine.length === FLOORS_CR.length * CAPS.length && strong >= WIDE_RULE.strongMin && examOk >= WIDE_RULE.examMin;
    const best = holds ? mine.filter((c) => c.solid).sort((a, b) => (b.inrPerMonth ?? 0) - (a.inrPerMonth ?? 0))[0] : undefined;
    if (holds) for (const c of mine) c.candidate = c.solid;
    return { size, gate, cells: mine.length, strong, examOk, holds, best: best?.id ?? null, inrPerMonth: best?.inrPerMonth ?? null };
  }).sort((a, b) => Number(a.gate) - Number(b.gate) || a.size - b.size);
}

/**
 * The pick: from the blocks that hold, the solid cell making the most rupees a month at its size. It wins only if the ₹10
 * lakh block it belongs to (gated or not) averages, over the training draws, more than the ₹250-340 control's best draw; it
 * makes more R a month than the control; and the placebo (at the pick's own settings) shows no edge.
 */
export function wideVerdict15(shards: WideShard[]): WideVerdict {
  const main = (u: WideShard['universe']) => shards.find((s) => s.universe === u && s.shard === 'main');
  const wide = main('wide'), narrow = main('narrow'), ladder = main('ladder');
  const brief = (x: { id: string; name: string; dev: Dev } | undefined) => (x ? { id: x.id, name: x.name, netR: x.dev.netR, t: x.dev.t, n: x.dev.n, sumR: x.dev.sumR } : null);
  const grid = [...(wide ? gridCells(wide.strategies, wide.pools) : []), ...(ladder ? gridCells(ladder.strategies, ladder.pools ?? wide?.pools) : [])];
  const blocks = blocksOf(grid);
  const control = narrow?.strategies.find((x) => x.id === WIDE_CONTROL);
  const placebo = wide?.strategies.find((x) => x.id === 'placebo');
  const ctrlTpm = control?.money?.tradesPerMonth ?? 0, ctrlRpm = control ? control.dev.netR * ctrlTpm : 0;
  const narrowDraws: WideDraw[] = shards.filter((s) => s.universe === 'narrow').flatMap((s) => {
    const st = s.strategies.find((x) => x.id === WIDE_CONTROL);
    return st && st.dev.n ? [{ shard: s.shard, netR: st.dev.netR }] : [];
  });
  const ctrlBest = narrowDraws.length ? Math.max(...narrowDraws.map((x) => x.netR)) : Infinity;
  /** the ₹10 lakh block's (gated or not) average R a trade in each training draw */
  const blockDraws = (gate: boolean): WideDraw[] => shards.filter((s) => s.universe === 'wide').flatMap((s) => {
    const xs = gridCells(s.strategies, s.pools).filter((c) => c.size === 10 && !!c.gate === gate && c.n > 0).map((c) => c.netR);
    return xs.length === FLOORS_CR.length * CAPS.length ? [{ shard: s.shard, netR: Math.round(mean(xs) * 1000) / 1000 }] : [];
  });
  const drawsG = blockDraws(true), drawsU = blockDraws(false);
  const drawsOf = (gate: boolean) => (gate ? drawsG : drawsU);
  const meanOf = (d: WideDraw[]) => (d.length ? Math.round(mean(d.map((x) => x.netR)) * 1000) / 1000 : null);
  const beats = (gate: boolean) => { const d = drawsOf(gate), mm = meanOf(d); return mm !== null && d.length >= WIDE_MIN_DRAWS && mm > ctrlBest; };
  const byRupees = (a: WideCell, b: WideCell) => (b.inrPerMonth ?? 0) - (a.inrPerMonth ?? 0);
  const held = blocks.filter((b) => b.holds && b.best).map((b) => grid.find((c) => c.id === b.best)).filter((c): c is WideCell => !!c).sort(byRupees);
  // the best cell that passes every check; if none does, the best of the blocks that hold (so the message says why)
  const best = held.find((c) => beats(!!c.gate) && c.rPerMonth > ctrlRpm) ?? held[0];
  const gate = !!best?.gate;
  const wideDraws = best ? drawsOf(gate) : [], wideMean = meanOf(wideDraws);
  const pickSt = best ? [...(wide?.strategies ?? []), ...(ladder?.strategies ?? [])].find((s) => s.id === best.id) : undefined;
  const checks = {
    floor: blocks.some((b) => b.holds),
    examPass: !!best?.exam,
    beatsNoise: !!best && beats(gate),
    moreTotalR: !!best && !!control && best.rPerMonth > ctrlRpm,
    placeboClean: !!placebo && !(placebo.dev.n >= 100 && placebo.dev.t >= 2 && placebo.dev.netR > 0),
  };
  const checkList = [
    { label: `a block (6 cells at one size) has ${WIDE_RULE.strongMin}+ cells at +${WIDE_RULE.netR}R a trade, t ${WIDE_RULE.t}+, ${WIDE_RULE.n}+ trades, and ${WIDE_RULE.examMin}+ cells profitable on the exam months`, ok: checks.floor },
    { label: `its best cell is solid on its own (${WIDE_RULE.pool}+ stocks a day, exam profitable)`, ok: !!best },
    { label: "the ₹10 lakh block's average over the training draws beats the ₹250–340 control's best draw", ok: checks.beatsNoise },
    { label: 'more R a month than the control', ok: checks.moreTotalR },
    { label: "the placebo (at the pick's settings) shows no edge", ok: checks.placeboClean },
  ];
  const m = pickSt?.money;
  const position = (best?.size ?? 10) * 100_000;
  const goal = best && m?.tradesPerMonth && m?.stopPct
    ? { ...goalMoney(best.netR, m.tradesPerMonth, m.stopPct, position), positionForHigh: goalMoney(best.netR, m.tradesPerMonth, m.stopPct, position, MONTHLY_GOAL_HIGH).positionForGoal, riskPerTrade: Math.round(position * m.stopPct / 100), position }
    : null;
  const base = { rule: WIDE_RULE, pick: brief(pickSt), control: brief(control), narrowDraws, wideDraws, wideMean, checks, checkList, goal, grid, pools: wide?.pools, blocks };
  const name = pickSt?.name ?? best?.id;
  if (!wide || !narrow || !control || !placebo || narrowDraws.length < WIDE_MIN_DRAWS) {
    return { ...base, outcome: 'incomplete', message: `Not enough finished jobs to judge (₹250–340 draws: ${narrowDraws.length}; ${WIDE_MIN_DRAWS} needed). See the GitHub run.` };
  }
  if (!checks.placeboClean) return { ...base, outcome: 'not-better', message: 'The placebo shows an edge: something leaks. Do not trust this run.' };
  if (!checks.floor) {
    const ten = blocks.find((b) => b.size === 10 && !b.gate);
    return { ...base, outcome: 'not-better', message: `No block holds: the region is not good on the decide months and the exam together${ten ? ` (₹10 lakh: ${ten.strong}/6 cells good on the decide months, ${ten.examOk}/6 profitable on the exam)` : ''}. Algo Live stays as it is.` };
  }
  if (!best) return { ...base, outcome: 'not-better', message: 'A block holds, but none of its cells is solid on its own (too few stocks a day, or its own exam lost). Algo Live stays as it is.' };
  if (wideDraws.length < WIDE_MIN_DRAWS) return { ...base, outcome: 'incomplete', message: `${name} looks best but too few training draws finished to check it (${wideDraws.length}).` };
  if (!checks.beatsNoise) return { ...base, outcome: 'not-better', message: `${name} is the best of the blocks that hold, but the block does not beat ₹250–340 by more than training luck.` };
  if (!checks.moreTotalR) return { ...base, outcome: 'not-better', message: `${name} makes less a month than ₹250–340.` };
  return { ...base, outcome: 'better', message: `${name} holds as a block on the decide months and the exam, beyond training luck: about ₹${(best.inrPerMonth ?? 0).toLocaleString('en-IN')} a month. A candidate for Algo Live, at a small size first.` };
}

/* ---- iteration 16: liquidity sizing and never standing aside ----------------------------------------------------- */

/** iteration 15's pick: the bar a liquidity-sized version must beat in rupees a month, in the same run */
export const LIQ_REF = 'w10_f100_c3_g';
export const LIQ_SHARES_BP = [5, 10, 20, 30];
const LIQ_ID = /^(?:l(\d+)|w10)_f(\d+)_c3(_g)?$/;

/** the liquidity grid of one shard: '_ns' twins and the placebo left out */
export function liquidCells(st: WideShard['strategies'], pools: Record<string, number> | undefined) {
  return st.flatMap((s) => {
    const m = LIQ_ID.exec(s.id);
    if (!m || !s.inr) return [];
    const floor = Number(m[2]), pool = pools ? pools[String(floor)] ?? null : null, exam = examPasses(s.exam);
    return [{ id: s.id, bp: m[1] ? Number(m[1]) : null, floor, gate: !!m[3], n: s.dev.n, netR: s.dev.netR, t: s.dev.t, exam, pool,
      inrPerMonth: s.inr.perMonth, inrExamPerMonth: s.inr.examPerMonth, avgPosition: s.inr.avgPosition, avgRisk: s.inr.avgRisk, capital: s.inr.capital,
      drawMean: null as number | null, draws: 0, solid: s.dev.n >= WIDE_RULE.n && s.dev.netR >= WIDE_RULE.netR && s.dev.t >= WIDE_RULE.t && exam && (pool ?? 0) >= WIDE_RULE.pool,
      neighboursOk: 0, winner: false }];
  });
}

/**
 * Iteration 16's rule, fixed before the run. A liquidity-sized version at ₹100 crore+ wins if it is solid on its own; at
 * least 2 of its 3 neighbours (the next share up and down, and ₹170 crore at the same share, same gate) are profitable on the
 * decide months and the exam; its draw average beats the ₹250-340 control's best draw; it makes more rupees a month than
 * iteration 15's pick in this run, and its exam months are positive in rupees too; and the placebo is clean. The most rupees
 * a month wins; with no winner, iteration 15's pick stays the pick. Standing aside is dropped for the pick only if its '_ns'
 * twin made money (in R) on the decide months the pick stood aside and the twin's exam is profitable.
 */
export function wideVerdict(shards: WideShard[]): WideVerdict {
  const main = (u: WideShard['universe']) => shards.find((s) => s.universe === u && s.shard === 'main');
  const wide = main('wide'), narrow = main('narrow');
  const brief = (x: { id: string; name: string; dev: Dev } | undefined) => (x ? { id: x.id, name: x.name, netR: x.dev.netR, t: x.dev.t, n: x.dev.n, sumR: x.dev.sumR } : null);
  const control = narrow?.strategies.find((x) => x.id === WIDE_CONTROL);
  const placebo = wide?.strategies.find((x) => x.id === 'placebo');
  const narrowDraws: WideDraw[] = shards.filter((s) => s.universe === 'narrow').flatMap((s) => {
    const st = s.strategies.find((x) => x.id === WIDE_CONTROL);
    return st && st.dev.n ? [{ shard: s.shard, netR: st.dev.netR }] : [];
  });
  const ctrlBest = narrowDraws.length ? Math.max(...narrowDraws.map((x) => x.netR)) : Infinity;
  const drawsOf = (id: string): WideDraw[] => shards.filter((s) => s.universe === 'wide').flatMap((s) => {
    const st = s.strategies.find((x) => x.id === id);
    return st && st.dev.n ? [{ shard: s.shard, netR: st.dev.netR }] : [];
  });
  const meanOf = (d: WideDraw[]) => (d.length ? Math.round(mean(d.map((x) => x.netR)) * 1000) / 1000 : null);
  const cells = wide ? liquidCells(wide.strategies, wide.pools) : [];
  for (const c of cells) { const d = drawsOf(c.id); c.drawMean = meanOf(d); c.draws = d.length; }
  const profitable = (c: { n: number; netR: number; exam: boolean } | undefined) => !!c && c.n > 0 && c.netR > 0 && c.exam;
  const at = (bp: number | undefined, floor: number, gate: boolean) => (bp === undefined ? undefined : cells.find((c) => c.bp === bp && c.floor === floor && c.gate === gate));
  const ref = cells.find((c) => c.id === LIQ_REF);
  const placeboClean = !!placebo && !(placebo.dev.n >= 100 && placebo.dev.t >= 2 && placebo.dev.netR > 0);
  for (const c of cells) {
    if (c.bp === null || c.floor !== 100) continue;
    const i = LIQ_SHARES_BP.indexOf(c.bp);
    c.neighboursOk = [at(LIQ_SHARES_BP[i - 1], 100, c.gate), at(LIQ_SHARES_BP[i + 1], 100, c.gate), at(c.bp, 170, c.gate)].filter(profitable).length;
    c.winner = c.solid && c.neighboursOk >= 2 && c.draws >= WIDE_MIN_DRAWS && (c.drawMean ?? -Infinity) > ctrlBest
      && !!ref && c.inrPerMonth > ref.inrPerMonth && c.inrExamPerMonth > 0 && placeboClean;
  }
  const best = cells.filter((c) => c.winner).sort((a, b) => b.inrPerMonth - a.inrPerMonth)[0];
  const refOk = !!ref && ref.solid && ref.draws >= WIDE_MIN_DRAWS && (ref.drawMean ?? -Infinity) > ctrlBest && placeboClean;
  const pickCell = best ?? (refOk ? ref : undefined);
  const pickSt = pickCell ? wide?.strategies.find((s) => s.id === pickCell.id) : undefined;
  // never standing aside
  const twin = pickCell ? wide?.strategies.find((s) => s.id === `${pickCell.id}_ns`) : undefined;
  const nsDecide = twin?.nsCheck?.decide ?? null, twinExam = examPasses(twin?.exam);
  const drop = !!nsDecide && nsDecide.n > 0 && nsDecide.sumR > 0 && twinExam;
  const standAside = pickCell && twin ? {
    twin: twin.id, drop, decide: nsDecide, examOk: twinExam,
    message: !nsDecide || !nsDecide.n
      ? `The pick never stood aside on the decide months, so there is nothing to judge: keep standing aside.`
      : drop
        ? `Trading the ${nsDecide.months} decide months the pick stood aside made ${nsDecide.sumR >= 0 ? '+' : ''}${nsDecide.sumR}R (${nsDecide.n} trades) and the twin's exam is profitable: drop the stand-aside, so Algo Live trades months like November.`
        : `Trading the ${nsDecide.months} decide months the pick stood aside made ${nsDecide.sumR >= 0 ? '+' : ''}${nsDecide.sumR}R (${nsDecide.n} trades)${twinExam ? '' : ' and the twin lost on the exam'}: keep standing aside.`,
  } : null;
  const position = pickCell?.avgPosition ?? 1_000_000;
  const goal = pickCell && pickCell.avgRisk ? {
    perMonth: pickCell.inrPerMonth, positionForGoal: pickCell.inrPerMonth > 0 ? Math.round(position * MONTHLY_GOAL / pickCell.inrPerMonth) : null,
    positionForHigh: pickCell.inrPerMonth > 0 ? Math.round(position * MONTHLY_GOAL_HIGH / pickCell.inrPerMonth) : null,
    riskPerTrade: pickCell.avgRisk, tradesPerMonth: pickSt?.money?.tradesPerMonth ?? 0, stopPct: pickSt?.money?.stopPct ?? 0, position,
  } : null;
  const checks = {
    floor: !!best, examPass: !!pickCell?.exam, beatsNoise: !!pickCell && (pickCell.drawMean ?? -Infinity) > ctrlBest,
    moreTotalR: !!best, placeboClean,
  };
  const checkList = [
    { label: `a liquidity-sized version at ₹100 crore+ is solid (+${WIDE_RULE.netR}R, t ${WIDE_RULE.t}+, ${WIDE_RULE.n}+ trades, ${WIDE_RULE.pool}+ stocks a day, exam profitable)`, ok: cells.some((c) => c.bp !== null && c.floor === 100 && c.solid) },
    { label: '2 of its 3 neighbours are profitable on the decide months and the exam', ok: cells.some((c) => c.bp !== null && c.solid && c.neighboursOk >= 2) },
    { label: "its draw average beats the ₹250–340 control's best draw", ok: cells.some((c) => c.bp !== null && c.solid && c.neighboursOk >= 2 && (c.drawMean ?? -Infinity) > ctrlBest) },
    { label: "more rupees a month than iteration 15's pick in this run, and positive on the exam in rupees", ok: !!best },
    { label: 'the placebo shows no edge', ok: placeboClean },
  ];
  const base = { rule: WIDE_RULE, pick: brief(pickSt), control: brief(control), narrowDraws, wideDraws: pickCell ? drawsOf(pickCell.id) : [], wideMean: pickCell?.drawMean ?? null,
    checks, checkList, goal, pools: wide?.pools, liquidity: cells, standAside };
  if (!wide || !narrow || !control || !placebo || narrowDraws.length < WIDE_MIN_DRAWS) {
    return { ...base, outcome: 'incomplete', message: `Not enough finished jobs to judge (₹250–340 draws: ${narrowDraws.length}; ${WIDE_MIN_DRAWS} needed). See the GitHub run.` };
  }
  if (!placeboClean) return { ...base, outcome: 'not-better', message: 'The placebo shows an edge: something leaks. Do not trust this run.' };
  const rs = (x: number) => `₹${Math.round(x).toLocaleString('en-IN')}`;
  const aside = standAside ? ` ${standAside.drop ? 'Drop' : 'Keep'} the stand-aside.` : '';
  if (best) return { ...base, outcome: 'better', message: `${pickSt?.name ?? best.id} beats iteration 15's pick: ${rs(best.inrPerMonth)} a month against ${rs(ref?.inrPerMonth ?? 0)}, with good neighbours, beyond training luck.${aside}` };
  if (refOk) return { ...base, outcome: 'not-better', message: `No liquidity-sized version beats iteration 15's pick (${rs(ref!.inrPerMonth)} a month in this run): it stays the pick.${aside}` };
  return { ...base, outcome: 'not-better', message: `Neither a liquidity-sized version nor iteration 15's pick holds in this run (training luck): do not move Algo Live on this run.` };
}

