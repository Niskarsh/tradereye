import type { ComboStudy, Outcomes, Study } from './analyze';

/**
 * "Explain this to me" on the Reversal Study page: what is sent to Claude, built on the server from the saved study,
 * so the page only says WHICH part to explain. Every message carries a short key to the terms, the tab's baseline
 * (what a rule has to beat) and the part asked about, as plain lines of numbers (no raw JSON).
 *
 * Parts:
 *  overview  all four tabs side by side: baseline, best rule, all rules together (year 2)
 *  tab       one tab: the moves, the baseline, every rule, the fall bands, the 8 facts that move R the most
 *  rules     one tab's rules in full (conditions, year 1 vs year 2, recent trades)
 *  rule      one rule with its recent year-2 trades
 *  drop      the fall-before-entry bands
 *  facts     the facts that move R the most (all five groups each)
 *  fact      one fact
 */

export type ExplainPart = 'overview' | 'tab' | 'rules' | 'rule' | 'drop' | 'facts' | 'fact' | 'insights';
export const EXPLAIN_PARTS: ExplainPart[] = ['overview', 'tab', 'rules', 'rule', 'drop', 'facts', 'fact', 'insights'];

export const EXPLAIN_SYSTEM = `You explain a trading backtest to Nik, an NSE intraday trader (stocks priced ₹250-340, risk ₹300 per trade, broker Dhan) who likes reversal trades.
Explain like he is five: short sentences, everyday words, one idea at a time. Use a tiny analogy only when it really helps.
Be honest and direct. If the numbers say something loses money, say it plainly. If a result is probably luck (good on year 1, bad on year 2, or few trades), say so. Never invent numbers; use only the ones given.
Always answer in this shape, in plain text with short headings:
1. What this is (one or two lines: what the table measures)
2. What the numbers say (the 3-5 numbers that matter, each turned into a plain sentence, e.g. "+0.10R means you made ₹30 per trade on average after charges at ₹300 risk")
3. What it means for you (does it make money on year 2 after charges or not, and why)
4. What to look at next (one or two concrete things on the page)
Keep it under 300 words unless he asks a question that needs more.`;

const TERMS = `Key to the terms:
- Possible entry: a 10-minute candle close where the stock was down from its open (up, for shorts), still on the far side of VWAP and within 1.5 ATR of its day low (high). Entry at that close.
- Stop: just beyond the day's low (high) so far. Target: VWAP (as it was at entry) or the day's open. Anything still open is closed at 15:00.
- Clean = reached the target before the stop. Messy = the stop was hit first, but price still reached the target later (a stop at the low would have lost; a wider stop could have won). Fail = never reached the target by 15:00. Failures are always counted.
- R = the money risked on the trade (₹300). +1R = +₹300. "R before costs" ignores Dhan's charges; "R after costs" takes them off. R after costs is what decides if it makes money.
- ATR = the stock's normal 10-minute candle size. "× daily range" = compared with the stock's usual day high-to-low range.
- Year 1 = the first half of the two years: the rules were FOUND here (so they always look good here). Year 2 = the second half: the search never saw it. Only year 2 shows if a rule is real.
- "First of each day": if a stock gives several possible entries in a day, only the first one counts as the trade.
- Year 1, year 2 and "both years" are each counted on their own: year 2 is the rule applied to all of year 2's days. Clean + messy + fail = 100%.
- Fills are cautious: entry 1 tick (₹0.05) worse than the close, stops exit 1 tick beyond the stop, targets fill only when traded through, stop and target in the same minute = stop. Charges = Dhan intraday (brokerage, STT, exchange, SEBI, IPFT, stamp, GST) at the ₹300 risk size.
- t = how sure the average is (R after costs ÷ its standard error). About 2 or more: unlikely to be luck. Under 1: could easily be luck. Many rules are shown, so a few greens on year 2 are expected by luck alone.
- Position = rupees in the trade at ₹300 risk (tight stops = big positions; intraday leverage is needed above his capital).`;

const p = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? '–' : `${Math.round(x * 100)}%`);
const r = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? '–' : `${x > 0 ? '+' : ''}${x.toFixed(2)}R`);
const n = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? '–' : Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2));
const range = (lo: number | null, hi: number | null) => (lo == null || !Number.isFinite(lo) ? `under ${n(hi)}` : hi == null || !Number.isFinite(hi) ? `${n(lo)} or more` : `${n(lo)} to ${n(hi)}`);

/** "Find insights": dig through everything, not just explain it */
export const INSIGHTS_SYSTEM = `You are a careful quant analyst reviewing a reversal backtest for Nik, an NSE intraday trader (stocks ₹250-340, risk ₹300 per trade, broker Dhan) who wants to add what really works to his trading.
You get every number of the study: four tabs (long/short × target VWAP/the day's open), each with the baseline, the rules (found on year 1, tested on year 2), the fall ranges and every fact split into five groups, for year 1 and year 2.
Your job is to find what he would miss, not to explain the headings. Work like this:
- Judge only on year 2 and on R after costs. Year 1 is where the rules were found, so it always looks good.
- Check how sure each result is: t about 2 or more and 100+ trades = probably real; t under 1 or few trades = could be luck. Remember many things are tested, so a few year-2 greens are expected by chance. Say which greens you trust and which you do not.
- Look for facts that point the same way in BOTH years and across several tabs (e.g. a volume or time-of-day effect that helps longs and shorts alike). Those are the strongest insights.
- Look for contradictions (good on year 1, bad on year 2; good for longs, bad for shorts) and say what they mean.
- Compare VWAP vs the open as targets, the stop at the low vs a 2 ATR stop, and messy vs clean shares.
- Note practical problems: tiny stops = huge positions (look at the median position), too few trades per month, charges eating the edge.
Then answer, in plain everyday words (explain like he is five, but do not skip the substance), with short headings:
1. The verdict (two or three lines: is there anything here that makes money on year 2 after charges, and how sure)
2. The insights (the 5-8 most important findings, each with the numbers behind it in plain words)
3. What looks like luck (things that look good but should not be trusted, and why)
4. What to do next (concrete: which conditions to combine and test, what to change in the study, what to try live on paper first)
Never invent numbers. Be direct; if nothing works, say so plainly.`;

export const tabName = (c: ComboStudy) => `${c.dir === 'LONG' ? 'Long' : 'Short'} → ${c.target === 'VWAP' ? 'VWAP' : 'the day\'s open'}`;

function out(o: Outcomes | undefined): string {
  if (!o) return '–';
  const extra = o.t !== undefined ? `, t ${n(o.t)}, median position ₹${(o.posMed ?? 0).toLocaleString('en-IN')}` : '';
  return `${o.n} trades, clean ${p(o.clean)}, messy ${p(o.messy)}, fail ${p(o.fail)}, made money after charges ${p(o.hit)}, R before costs ${r(o.grossR)}, R after costs ${r(o.netR)}, avg ${o.min} min${extra}`;
}
/** one compact line for the insights message (everything, so it must stay short) */
function short(o: Outcomes | undefined): string {
  if (!o || !o.n) return 'none';
  return `n${o.n} C${p(o.clean)} M${p(o.messy)} F${p(o.fail)} ${r(o.netR)}${o.t !== undefined ? ` t${n(o.t)}` : ''}`;
}
const perMonth = (o: Outcomes, months: number) => `about ${o.netR * 300 * o.n / months >= 0 ? '+' : '−'}₹${Math.abs(Math.round((o.netR * 300 * o.n) / months)).toLocaleString('en-IN')} a month if every trade was taken`;

function header(s: Study): { text: string; months2: number } {
  const months2 = Math.max(1, (Date.parse(s.period.to) - Date.parse(s.period.mid)) / (30.44 * 86400_000));
  return { months2, text: `Reversal study on NSE stocks priced ₹250-340 (10-day average volume 5 lakh+ shares), ${s.period.from} to ${s.period.to}. Year 1 = ${s.period.from} to ${s.period.mid}, year 2 = ${s.period.mid} to ${s.period.to} (${months2.toFixed(1)} months). ${s.moments.toLocaleString('en-IN')} possible entries in all. Rules needed at least ${s.minTrades} trades on year 1.` };
}

function baseline(c: ComboStudy): string {
  return `Baseline = taking every possible entry (first of each day), no rule:\n  Year 1: ${out(c.base.y1First)}\n  Year 2: ${out(c.base.y2First)}\n  Both years: ${out(c.base.allFirst)}`;
}
function moves(c: ComboStudy): string {
  const m = c.moves;
  return `The moves: ${m.stockDays} stock-days had at least one possible entry; ${m.withClean} of them (${p(m.withClean / Math.max(1, m.stockDays))}) had a clean reversal at some point. Before the first clean reversal of a day, stocks had typically fallen ${n(m.dropBeforeClean.p25)}-${n(m.dropBeforeClean.p75)}× their daily range (middle ${n(m.dropBeforeClean.p50)}×), i.e. ${n(m.dropPctBeforeClean.p25)}-${n(m.dropPctBeforeClean.p75)}% from the open.`;
}
function ruleLine(rr: ComboStudy['rules'][number], i: number, months2: number, examples = 0): string {
  const lines = [`Rule ${i + 1}: ${rr.text}`, `  Year 1 (where it was found): ${out(rr.y1)}`, `  Year 2 (never seen by the search): ${out(rr.y2)}; ${perMonth(rr.y2, months2)}`, `  Both years: ${out(rr.all)}`, `  Year 2 with a 2 ATR stop instead of the low: ${r(rr.y2.netWide)} per trade`];
  if (examples) lines.push(`  Latest year-2 trades: ${rr.examples.slice(-examples).map((e) => `${e.date} ${e.time} ${e.symbol} @${e.entry} stop ${e.stop} target ${e.target} → ${e.label === 'C' ? 'clean' : e.label === 'M' ? 'messy' : 'fail'} ${r(e.net)}`).join('; ')}`);
  return lines.join('\n');
}
function rules(c: ComboStudy, months2: number, examples = 0): string {
  if (!c.rules.length) return 'Rules: none had enough trades on year 1.';
  return [`Rules (found on year 1 one after another; each next rule searched on the days the earlier ones did not take):`,
    ...c.rules.map((x, i) => ruleLine(x, i, months2, examples)),
    `All rules together: year 1 ${out(c.together.y1)} | year 2 ${out(c.together.y2)}; ${perMonth(c.together.y2, months2)}`,
    c.common.length ? `Facts the rules share: ${c.common.map((x) => `${x.label} (in ${x.rules} rules)`).join('; ')}` : ''].filter(Boolean).join('\n');
}
function drop(c: ComboStudy): string {
  const rows = c.drop.filter((d) => d.y1.n || d.y2.n).map((d) => `  Fall ${range(d.lo, d.hi)}× daily range: year 1 ${out(d.y1)} | year 2 R after costs ${r(d.y2.netR)} on ${d.y2.n} trades`);
  const best = c.bestDrop ? `Best fall range on year 1: ${range(c.bestDrop.lo, c.bestDrop.hi)}× (${r(c.bestDrop.y1.netR)} on ${c.bestDrop.y1.n} trades); the same range on year 2: ${r(c.bestDrop.y2.netR)} on ${c.bestDrop.y2.n} trades.` : '';
  return [`How far it had fallen from the open before the entry (first of each day):`, ...rows, best].filter(Boolean).join('\n');
}
function fact(f: ComboStudy['features'][number]): string {
  return [`Fact: ${f.label} (split into five equal groups on year 1; difference in R between best and worst group on year 1: ${n(f.spread)}R). Every possible entry, not just the first of the day:`,
    ...f.bins.map((b) => `  ${range(b.lo, b.hi)}: year 1 ${out(b.y1)} | year 2 R after costs ${r(b.y2.netR)} on ${b.y2.n}`)].join('\n');
}

export function buildExplainMessage(s: Study, part: ExplainPart, combo = 0, item?: number | string, question?: string): string {
  const h = header(s);
  const c = s.combos[combo];
  const parts: string[] = [h.text, TERMS];
  let ask = '';
  switch (part) {
    case 'overview':
      parts.push('All four tabs:', ...s.combos.map((x) => {
        const best = [...x.rules].sort((a, b) => b.y2.netR - a.y2.netR)[0];
        return `${tabName(x)}\n  ${baseline(x).replace(/\n/g, '\n  ')}\n  Rules found: ${x.rules.length}. All rules together on year 2: ${out(x.together.y2)}; ${perMonth(x.together.y2, h.months2)}\n  Best rule on year 2: ${best ? `${best.text} → ${out(best.y2)}` : 'none'}`;
      }));
      ask = 'Explain the whole study: what the four tabs are, which (if any) makes money on year 2 after charges, and what that means for his reversal trading.';
      break;
    case 'tab':
      parts.push(`Tab: ${tabName(c)}`, moves(c), baseline(c), rules(c, h.months2), drop(c), 'The 8 facts that change R the most:', ...c.features.slice(0, 8).map(fact));
      ask = `Explain this tab (${tabName(c)}) from top to bottom: the moves, the baseline, the rules, the fall ranges and the facts. Is there anything here that makes money on year 2?`;
      break;
    case 'rules':
      parts.push(`Tab: ${tabName(c)}`, baseline(c), rules(c, h.months2, 4));
      ask = `Explain these rules: what each one means in trading words, which held up on year 2 and which did not, and whether all of them together make money.`;
      break;
    case 'rule': {
      const i = Number(item);
      const x = c.rules[i];
      if (!x) throw new Error('No such rule.');
      parts.push(`Tab: ${tabName(c)}`, baseline(c), ruleLine(x, i, h.months2, 8));
      ask = `Explain rule ${i + 1} in trading words (what the chart looks like when it fires), how it did on year 2 compared with the baseline, and whether it is worth trading.`;
      break;
    }
    case 'drop':
      parts.push(`Tab: ${tabName(c)}`, moves(c), baseline(c), drop(c));
      ask = 'Explain how far stocks fell before a reversal, and which fall range (if any) made money after charges on year 2.';
      break;
    case 'facts':
      parts.push(`Tab: ${tabName(c)}`, baseline(c), ...c.features.slice(0, 12).map(fact));
      ask = 'Explain what these facts show: which ones separate winners from failures, in which direction, and which of those still hold on year 2.';
      break;
    case 'insights': {
      const lines: string[] = [];
      for (const x of s.combos) {
        lines.push(`=== ${tabName(x)} ===`, moves(x), baseline(x), rules(x, h.months2, 3), drop(x));
        lines.push(`All ${x.features.length} facts (five groups each; format: value range | year 1 | year 2; n = trades, C/M/F = clean/messy/fail, then R after costs, t):`);
        for (const f of x.features) lines.push(`* ${f.label}:`, ...f.bins.map((b) => `  ${range(b.lo, b.hi)} | ${short(b.y1)} | ${short(b.y2)}`));
      }
      parts.push(...lines);
      ask = '';
      break;
    }
    case 'fact': {
      const f = c.features.find((x) => x.f === item);
      if (!f) throw new Error('No such fact.');
      parts.push(`Tab: ${tabName(c)}`, baseline(c), fact(f));
      ask = `Explain this one fact: what it measures on the chart, which values go with clean reversals and which with failures, and whether that still holds on year 2.`;
      break;
    }
  }
  if (part === 'insights') parts.push(question?.trim() ? `His question about the whole study: ${question.trim()}` : 'Task: go through ALL of it and give him the insights, as described.');
  else parts.push(question?.trim() ? `His question: ${question.trim()}\n(Answer it, using the shape above where it fits.)` : `Task: ${ask}`);
  return parts.join('\n\n');
}
