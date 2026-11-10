import type { Candles } from '../dhan';
import { WIDE_REF_PRICE, wideVol } from './grid';

/**
 * Algo Lab iteration 12: the same strategy (F as Algo Live trades it) on a wider set of stocks. Research only: nothing
 * here is read by Algo Live, My Setups or the monthly model.
 *
 * Which stocks: previous close ₹250-1000 (₹0.05 is the NSE tick all through that range, so the fill code holds as it is)
 * and the same liquidity floor as now, measured in rupees. A stock inside ₹250-340 is treated exactly as before.
 */
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
 * Iteration 13: is iteration 12's edge (₹250-1000, all) still there when every fill is worse than modelled? The test
 * version is 'wS1' (an extra 0.1% of the price on every trade, about twice what a ₹500 stock's spread costs).
 */
export const WIDE_RULE = { netR: 0.04, t: 2, n: 150 };
export const WIDE_PICK = 'wS1';
export const WIDE_BASE = 'wAll';
export const WIDE_CONTROL = 'nF';
/** fewer training draws than this on either side and the comparison says nothing */
export const WIDE_MIN_DRAWS = 3;

interface Dev { n: number; netR: number; t: number; sumR: number }
type Exam = { n?: number; netR?: number; t?: number; pass?: boolean | null } | null | undefined;
export interface WideShard { universe: 'narrow' | 'wide'; shard: string; strategies: { id: string; name: string; dev: Dev; exam?: Exam }[] }
export interface WideDraw { shard: string; netR: number }
export interface WideVerdict {
  outcome: 'better' | 'not-better' | 'incomplete';
  message: string;
  rule: typeof WIDE_RULE;
  pick: { id: string; name: string; netR: number; t: number; n: number; sumR: number } | null;
  control: { id: string; name: string; netR: number; t: number; n: number; sumR: number } | null;
  narrowDraws: WideDraw[]; wideDraws: WideDraw[]; wideMean: number | null;
  checks: { floor: boolean; beatsNoise: boolean; moreTotalR: boolean; placeboClean: boolean; examPass?: boolean };
  /** (iteration 13 on) the rule as shown on the page, check by check */
  checkList?: { label: string; ok: boolean }[];
}

const draws = (shards: WideShard[], universe: WideShard['universe'], id: string | undefined): WideDraw[] =>
  shards.filter((s) => s.universe === universe).flatMap((s) => {
    const st = s.strategies.find((x) => x.id === id);
    return st && st.dev.n ? [{ shard: s.shard, netR: st.dev.netR }] : [];
  });

/** the exam months (from May 26) as Algo Lab marks them: profitable after costs */
export const examPasses = (e: Exam) => !!e && (e.pass !== undefined && e.pass !== null ? e.pass : (e.n ?? 0) >= 30 && (e.netR ?? 0) > 0);

/**
 * Decide months only, at the worse fills. The wide universe counts as robust only if ALL of these hold:
 *  1. with an extra 0.1% a trade it still makes +0.04R a trade, t 2+, 150+ trades;
 *  2. its average over the training draws beats the BEST draw of the ₹250-340 control (more than training luck);
 *  3. it still makes more R in total than the control;
 *  4. it is profitable on the exam months too (iteration 12's ₹340 cr+ pick failed them);
 *  5. the placebo shows no edge.
 */
export function wideVerdict(shards: WideShard[]): WideVerdict {
  const main = (u: WideShard['universe']) => shards.find((s) => s.universe === u && s.shard === 'main');
  const wide = main('wide'), narrow = main('narrow');
  const brief = (x: { id: string; name: string; dev: Dev } | undefined) => (x ? { id: x.id, name: x.name, netR: x.dev.netR, t: x.dev.t, n: x.dev.n, sumR: x.dev.sumR } : null);
  const pick = wide?.strategies.find((x) => x.id === WIDE_PICK);
  const control = narrow?.strategies.find((x) => x.id === WIDE_CONTROL);
  const placebo = wide?.strategies.find((x) => x.id === 'placebo');
  const narrowDraws = draws(shards, 'narrow', WIDE_CONTROL), wideDraws = draws(shards, 'wide', WIDE_PICK);
  const wideMean = wideDraws.length ? Math.round((wideDraws.reduce((a, d) => a + d.netR, 0) / wideDraws.length) * 1000) / 1000 : null;
  const d = pick?.dev;
  const checks = {
    floor: !!d && d.n >= WIDE_RULE.n && d.netR >= WIDE_RULE.netR && d.t >= WIDE_RULE.t,
    beatsNoise: wideMean !== null && narrowDraws.length > 0 && wideMean > Math.max(...narrowDraws.map((x) => x.netR)),
    moreTotalR: !!d && !!control && d.sumR > control.dev.sumR,
    examPass: examPasses(pick?.exam),
    placeboClean: !!placebo && !(placebo.dev.n >= 100 && placebo.dev.t >= 2 && placebo.dev.netR > 0),
  };
  const checkList = [
    { label: `with 0.1% worse fills: +${WIDE_RULE.netR}R a trade, t ${WIDE_RULE.t}+, ${WIDE_RULE.n}+ trades`, ok: checks.floor },
    { label: "its average over the draws beats the ₹250–340 control's best draw", ok: checks.beatsNoise },
    { label: 'more R in total than the control', ok: checks.moreTotalR },
    { label: 'profitable on the exam months', ok: checks.examPass },
    { label: 'the placebo shows no edge', ok: checks.placeboClean },
  ];
  const base = { rule: WIDE_RULE, pick: brief(pick), control: brief(control), narrowDraws, wideDraws, wideMean, checks, checkList };
  if (!wide || !narrow || !pick || !control || !placebo || narrowDraws.length < WIDE_MIN_DRAWS || wideDraws.length < WIDE_MIN_DRAWS) {
    return { ...base, outcome: 'incomplete', message: `Not enough finished training jobs to compare (₹250–340: ${narrowDraws.length} draws, wide: ${wideDraws.length}; ${WIDE_MIN_DRAWS} each needed). See the GitHub run.` };
  }
  if (!checks.placeboClean) return { ...base, outcome: 'not-better', message: 'The placebo shows an edge: something leaks. Do not trust this run.' };
  const failed = checkList.filter((c) => !c.ok).map((c) => c.label);
  if (failed.length) return { ...base, outcome: 'not-better', message: `Not robust: the wide edge fails "${failed[0]}"${failed.length > 1 ? ` (and ${failed.length - 1} more)` : ''}. Do not move Algo Live to it.` };
  return { ...base, outcome: 'better', message: 'Robust: ₹250–1000 keeps its edge with 0.1% worse fills, beats ₹250–340 by more than training luck and passes the exam. A candidate for Algo Live.' };
}
