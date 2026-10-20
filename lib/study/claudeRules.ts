import { FEATURES, FEATURE_KEYS, type Moment } from './mine';
import { condText, type ComboStudy, type Cond, type Outcomes, type Study } from './analyze';
import { evaluate, type MomentsFile } from './moments';

/**
 * Rules written by Claude from the study, then tested here on the saved entries.
 *
 * Claude only ever sees YEAR 1: the baseline, the fall ranges, every fact in its five groups and the study's own
 * rules, all year 1. It writes rules as exact conditions on the facts. Each rule is then tested on year 1, year 2 and
 * both years, exactly like the study's rules (first matching moment of each stock-day). Year 2 stays an honest test
 * because Claude never saw it. "Refine" shows Claude its earlier rules with their YEAR 1 results only.
 */

export type TabKey = 'LONG_VWAP' | 'LONG_OPEN' | 'SHORT_VWAP' | 'SHORT_OPEN';
export const TABS: TabKey[] = ['LONG_VWAP', 'LONG_OPEN', 'SHORT_VWAP', 'SHORT_OPEN'];
export const tabOf = (c: Pick<ComboStudy, 'dir' | 'target'>): TabKey => `${c.dir}_${c.target}` as TabKey;
export const tabLabel = (t: TabKey) => ({ LONG_VWAP: 'Long → VWAP', LONG_OPEN: 'Long → the open', SHORT_VWAP: 'Short → VWAP', SHORT_OPEN: 'Short → the open' })[t];

export interface ClaudeRule {
  tab: TabKey; name: string; why: string; conds: Cond[]; text: string;
  y1: Outcomes; y2: Outcomes; all: Outcomes;
  examples: { symbol: string; date: string; time: string; entry: number; stop: number; target: number; label: string; net: number }[];
}
export interface ClaudeBatch { id: string; at: number; model: string; costInr: number; refine: boolean; focus?: string; note: string; rules: ClaudeRule[]; dropped: string[] }

const LABEL = Object.fromEntries(FEATURES.map(([k, l]) => [k, l])) as Record<string, string>;
const p = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? '–' : `${Math.round(x * 100)}%`);
const r = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? '–' : `${x > 0 ? '+' : ''}${x.toFixed(2)}R`);
const n = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? '–' : Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(3));
const range = (lo: number | null, hi: number | null) => (lo == null || !Number.isFinite(lo) ? `< ${n(hi)}` : hi == null || !Number.isFinite(hi) ? `>= ${n(lo)}` : `${n(lo)} to < ${n(hi)}`);
const y1 = (o: Outcomes | undefined) => (!o || !o.n ? 'no trades' : `n ${o.n}, clean ${p(o.clean)}, messy ${p(o.messy)}, fail ${p(o.fail)}, R before charges ${r(o.grossR)}, R after charges ${r(o.netR)}${o.t != null ? `, t ${n(o.t)}` : ''}`);

export const RULES_SYSTEM = `You are a quant researcher deriving intraday reversal trading rules for Nik, an NSE trader (stocks ₹250-340, ₹300 risk per trade, broker Dhan).
The data are YEAR 1 of a two-year study of every possible reversal entry. Year 2 is held back on purpose: your rules will be tested on it afterwards, so only rules that capture something real will survive. Do not try to guess year 2.
What a trade is: at a 10-minute close the stock is down from its open (up, for shorts), still beyond VWAP and near its day low (high). Entry at that close (1 tick worse), stop just beyond the day low (high), target VWAP or the day's open. Clean = target before stop; messy = stop first, target later; fail = never reached by 15:00. R after charges is what counts (Dhan intraday charges + slippage included).
How to write rules:
- Each rule is for one tab (LONG_VWAP, LONG_OPEN, SHORT_VWAP, SHORT_OPEN) and is 1 to 5 conditions that must ALL be true at the same 10-minute close. Each condition: a fact key, ">=" or "<", and a number.
- Use the fact keys exactly as listed. Prefer thresholds near the group edges given (those are where the data changes).
- Build from facts whose groups show a clear, steady difference in R after charges (not one odd group). Combine facts that each help on their own and are not the same thing measured twice.
- Prefer rules that still give enough trades: aim for at least 150 year-1 trades per rule (the baseline counts tell you the scale); a rule with very few trades cannot be trusted.
- Cover the tabs where the data shows promise; skip a tab if nothing there helps (say so in the note).
- Give 6 to 15 rules. For each: a short name, and "why" in one or two plain sentences (what it looks like on the chart and which numbers made you pick it).
In "note", say in two or three plain sentences what you saw overall.`;

export const RULES_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['note', 'rules'],
  properties: {
    note: { type: 'string' },
    rules: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['tab', 'name', 'why', 'conds'],
        properties: {
          tab: { type: 'string', enum: TABS },
          name: { type: 'string' },
          why: { type: 'string' },
          conds: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['f', 'op', 'v'], properties: { f: { type: 'string', enum: FEATURE_KEYS }, op: { type: 'string', enum: ['>=', '<'] }, v: { type: 'number' } } },
          },
        },
      },
    },
  },
};

/** The message: year 1 only. */
export function buildRulesMessage(s: Study, opts: { previous?: ClaudeBatch; focus?: string } = {}): string {
  const out: string[] = [];
  out.push(`Year 1 = ${s.period.from} to ${s.period.mid}. Universe: NSE stocks ₹250-340 with 5 lakh+ shares of 10-day average volume. Rules in the study needed ${s.minTrades}+ year-1 trades.`);
  out.push('Fact keys (use these exactly):', ...FEATURES.map(([k, l]) => `- ${k}: ${l}`));
  for (const c of s.combos) {
    out.push('', `=== ${tabOf(c)} (${tabLabel(tabOf(c))}) — year 1 only ===`);
    out.push(`Baseline (every possible entry, first of each stock-day): ${y1(c.base.y1First)}`);
    out.push('Fall from the open to the low before the entry (× usual daily range), first of each stock-day:', ...c.drop.filter((d) => d.y1.n).map((d) => `  ${range(d.lo, d.hi)}: ${y1(d.y1)}`));
    out.push('Every fact in five equal groups (all possible entries, not just the first of the day):');
    for (const f of c.features) out.push(`* ${f.f}:`, ...f.bins.map((b) => `  ${range(b.lo, b.hi)}: ${y1(b.y1)}`));
    if (c.rules.length) out.push('Rules the study\'s own search found on year 1 (you may improve on them):', ...c.rules.map((x) => `  ${x.conds.map(fmtCond).join(' AND ')} → ${y1(x.y1)}`));
  }
  if (opts.previous?.rules.length) {
    out.push('', 'Your previous rules and their YEAR 1 results (year 2 is still hidden). Keep what worked, fix or drop what did not, try new ideas:');
    for (const x of opts.previous.rules) out.push(`  [${x.tab}] ${x.name}: ${x.conds.map(fmtCond).join(' AND ')} → ${y1(x.y1)}`);
  }
  if (opts.focus?.trim()) out.push('', `Nik asks you to focus on: ${opts.focus.trim()}`);
  out.push('', 'Write the rules.');
  return out.join('\n');
}
const fmtCond = (c: Cond) => `${c.f} ${c.op} ${n(c.v)}`;

/** Keep only well-formed rules; say what was dropped and why. */
export function cleanRules(raw: unknown): { rules: { tab: TabKey; name: string; why: string; conds: Cond[] }[]; dropped: string[] } {
  const list = Array.isArray((raw as { rules?: unknown })?.rules) ? (raw as { rules: unknown[] }).rules : [];
  const rules: { tab: TabKey; name: string; why: string; conds: Cond[] }[] = [], dropped: string[] = [];
  const seen = new Set<string>();
  for (const x of list.slice(0, 20) as Record<string, unknown>[]) {
    const name = String(x?.name ?? '').slice(0, 80) || 'Rule';
    const tab = String(x?.tab ?? '') as TabKey;
    if (!TABS.includes(tab)) { dropped.push(`${name}: unknown tab`); continue; }
    const conds = (Array.isArray(x?.conds) ? x.conds : []).map((c: Record<string, unknown>) => ({ f: String(c?.f ?? ''), op: c?.op === '<' ? '<' as const : '>=' as const, v: Number(c?.v) }))
      .filter((c: Cond) => FEATURE_KEYS.includes(c.f as never) && Number.isFinite(c.v));
    if (!conds.length || conds.length > 6) { dropped.push(`${name}: ${conds.length ? 'too many' : 'no usable'} conditions`); continue; }
    const key = `${tab}|${conds.map((c: Cond) => `${c.f}${c.op}${c.v}`).sort().join('&')}`;
    if (seen.has(key)) { dropped.push(`${name}: same as another rule`); continue; }
    seen.add(key);
    rules.push({ tab, name, why: String(x?.why ?? '').slice(0, 400), conds });
  }
  return { rules, dropped };
}

const hhmm = (slot: number) => { const m = 555 + slot; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

/** Test each rule on the saved entries: year 1, year 2 and both years, plus its latest year-2 trades. */
export function testRules(rules: { tab: TabKey; name: string; why: string; conds: Cond[] }[], files: Record<1 | -1, MomentsFile>, mid: string): ClaudeRule[] {
  return rules.map((x) => {
    const dir = x.tab.startsWith('LONG') ? 1 : -1, t = x.tab.endsWith('VWAP') ? 'v' : 'o';
    const e = evaluate(files[dir], x.conds, t, mid);
    const ex = e.y2Trades.sort((a: Moment, b: Moment) => (a.date === b.date ? a.slot - b.slot : a.date < b.date ? -1 : 1)).slice(-8).map((m) => ({
      symbol: m.symbol, date: m.date, time: hhmm(m.slot), entry: m.entry, stop: m.stop, target: t === 'v' ? m.vwap : m.open, label: m[t]!.label, net: m[t]!.net,
    }));
    return { ...x, text: x.conds.map((c) => condText(c)).join(' AND '), y1: e.y1, y2: e.y2, all: e.all, examples: ex };
  });
}

export { LABEL as FACT_LABEL };
