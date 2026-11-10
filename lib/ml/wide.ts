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

/* ---- the verdict, by a rule fixed before the run ------------------------------------------------------------ */

export const WIDE_RULE = { netR: 0.04, t: 2, n: 150 };
export const WIDE_ORDER = ['w10m', 'w7m', 'w5m', 'w3m', 'wAll'];
export const WIDE_CONTROL = 'nF';
/** fewer training draws than this on either side and the comparison says nothing */
export const WIDE_MIN_DRAWS = 3;

interface Dev { n: number; netR: number; t: number; sumR: number }
export interface WideShard { universe: 'narrow' | 'wide'; shard: string; strategies: { id: string; name: string; dev: Dev }[] }
export interface WideDraw { shard: string; netR: number }
export interface WideVerdict {
  outcome: 'better' | 'not-better' | 'incomplete';
  message: string;
  rule: typeof WIDE_RULE;
  pick: { id: string; name: string; netR: number; t: number; n: number; sumR: number } | null;
  control: { id: string; name: string; netR: number; t: number; n: number; sumR: number } | null;
  narrowDraws: WideDraw[]; wideDraws: WideDraw[]; wideMean: number | null;
  checks: { floor: boolean; beatsNoise: boolean; moreTotalR: boolean; placeboClean: boolean };
}

const draws = (shards: WideShard[], universe: WideShard['universe'], id: string | undefined): WideDraw[] =>
  shards.filter((s) => s.universe === universe).flatMap((s) => {
    const st = s.strategies.find((x) => x.id === id);
    return st && st.dev.n ? [{ shard: s.shard, netR: st.dev.netR }] : [];
  });

/**
 * Decide months only, real fills on both sides. The wide universe wins only if ALL of these hold:
 *  1. a version clears iteration 11's own bar (the highest liquidity floor with +0.04R a trade, t 2+, 150+ trades);
 *  2. its average over the training draws beats the BEST draw of the ₹250-340 control, so it is more than training luck;
 *  3. it makes more R in total (the point is more money, not a nicer average on fewer trades);
 *  4. the placebo shows no edge.
 */
export function wideVerdict(shards: WideShard[]): WideVerdict {
  const main = (u: WideShard['universe']) => shards.find((s) => s.universe === u && s.shard === 'main');
  const wide = main('wide'), narrow = main('narrow');
  const brief = (x: { id: string; name: string; dev: Dev } | undefined) => (x ? { id: x.id, name: x.name, netR: x.dev.netR, t: x.dev.t, n: x.dev.n, sumR: x.dev.sumR } : null);
  const passes = (d: Dev) => d.n >= WIDE_RULE.n && d.netR >= WIDE_RULE.netR && d.t >= WIDE_RULE.t;
  const pick = WIDE_ORDER.map((id) => wide?.strategies.find((x) => x.id === id)).find((x) => x && passes(x.dev));
  const control = narrow?.strategies.find((x) => x.id === WIDE_CONTROL);
  const placebo = wide?.strategies.find((x) => x.id === 'placebo');
  const narrowDraws = draws(shards, 'narrow', WIDE_CONTROL);
  // with no version clearing the bar, the broadest one is still shown against the control
  const wideDraws = draws(shards, 'wide', pick?.id ?? 'wAll');
  const wideMean = wideDraws.length ? Math.round((wideDraws.reduce((a, d) => a + d.netR, 0) / wideDraws.length) * 1000) / 1000 : null;
  const checks = {
    floor: !!pick,
    beatsNoise: wideMean !== null && narrowDraws.length > 0 && wideMean > Math.max(...narrowDraws.map((d) => d.netR)),
    moreTotalR: !!pick && !!control && pick.dev.sumR > control.dev.sumR,
    placeboClean: !!placebo && !(placebo.dev.n >= 100 && placebo.dev.t >= 2 && placebo.dev.netR > 0),
  };
  const base = { rule: WIDE_RULE, pick: brief(pick), control: brief(control), narrowDraws, wideDraws, wideMean, checks };
  if (!wide || !narrow || !control || !placebo || narrowDraws.length < WIDE_MIN_DRAWS || wideDraws.length < WIDE_MIN_DRAWS) {
    return { ...base, outcome: 'incomplete', message: `Not enough finished training jobs to compare (₹250–340: ${narrowDraws.length} draws, wide: ${wideDraws.length}; ${WIDE_MIN_DRAWS} each needed). See the GitHub run.` };
  }
  if (!checks.placeboClean) return { ...base, outcome: 'not-better', message: 'The placebo shows an edge: something leaks. Do not trust this run.' };
  if (!checks.floor) return { ...base, outcome: 'not-better', message: 'No wide version clears the bar at real fills. The wider universe does not help.' };
  if (!checks.beatsNoise) return { ...base, outcome: 'not-better', message: `${pick!.name} does not beat ₹250–340 by more than training luck. The wider universe does not help.` };
  if (!checks.moreTotalR) return { ...base, outcome: 'not-better', message: `${pick!.name} has the better average but makes less in total than ₹250–340.` };
  return { ...base, outcome: 'better', message: `${pick!.name} beats ₹250–340 by more than training luck and makes more in total.` };
}
