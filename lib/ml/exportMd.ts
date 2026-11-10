/**
 * One Algo Lab iteration as a Markdown file, for pasting into a chat with Claude: everything the Algo Lab page shows for
 * every version (not only the one open on screen). Built from the same JSON the page loads, so nothing new is fetched.
 * Layout: header, what changed, verdict (if any), the floor x cap grids (if any), ONE summary table of all versions
 * (one row each, ids in the first column), then a section per version (### id).
 */

/* The page's types are richer; only what is printed here is described, all optional, so an older iteration still exports. */
type Num = number | null | undefined;
interface S { n?: number; hit?: number; netR?: number; gross?: number; sumR?: number; inr?: number; t?: number }
interface P extends S { monthsGreen?: number; monthsTraded?: number; monthsTotal?: number; maxDrawdownR?: number; inrPerMonth?: number; pass?: boolean | null; from?: string }
interface Strat {
  id: string; name: string; desc?: string;
  baseline?: { long?: number; short?: number; longGross?: number; shortGross?: number };
  overall?: P; dev?: P; exam?: P; shadow?: P | null;
  ic?: { mean?: Num; positive?: number; months?: number };
  daily?: { tradingDays?: number; daysWithTrades?: number; perTradedDay?: number; maxPerDay?: number; at0935?: number; greenDays?: number; worstDayR?: number; bestDayR?: number; worstWeekR?: number; greenWeeks?: number } | null;
  money?: { stopPct?: number; position?: number; tradesPerMonth?: number; perTrade?: number; perMonth?: number; capital?: number; pct?: number; worstMonth?: number; bestMonth?: number; maxDrawdownR?: number } | null;
  costs?: { name: string; dev?: S; devMonths?: [number, number]; exam?: S }[] | null;
  bySide?: { long?: S; short?: S }; byHour?: (S & { hour: string })[];
  months?: (S & { month: string; ic?: Num; note?: string; exam?: boolean })[];
  importance?: { label: string; share: number }[];
  liked?: { side: string; label: string; z: number; taken: number; all: number }[];
  recent?: { day: string; sym: string; time: string; side: string; pred: number; net: number }[];
  bands?: (S & { band: string })[] | null;
}
interface Untouched { id: string; name?: string; from?: string; to?: string; overall?: P }
interface Noise { strategy: string; devMin: number; devMax: number; devMean: number; draws?: { draw: string; devNetR: number; devT: number }[] }
interface Cell { id: string; size: number; floor: number | 'aware'; cap: number; n: number; netR: number; t: number; rPerMonth: number; tradesPerMonth: number; exam: boolean; pool: number | null; solid: boolean; candidate: boolean }
export interface ExportMl {
  iteration: number; runId: string; code?: string | null; createdAt: number; changes?: string[];
  period?: { from: string; to: string }; examFrom?: string; rows?: number; stocks?: number; days?: number; narrowStocks?: number;
  setup?: { maxPerDay?: number; maxPerSide?: number; riskInr?: number; trainMonths?: number; valMonths?: number };
  best?: string; locked?: string; strategies: Strat[];
  untouched?: Untouched | Untouched[] | null; noiseAll?: Noise[]; shadowFrom?: string;
  wide?: {
    outcome: string; message: string; checkList?: { label: string; ok: boolean }[];
    pick?: { id: string; name: string } | null; control?: { id: string; name: string } | null;
    narrowDraws?: { shard: string; netR: number }[]; wideDraws?: { shard: string; netR: number }[]; wideMean?: number | null;
    goal?: { perMonth: number; positionForGoal: number | null; positionForHigh?: number | null; riskPerTrade?: number; tradesPerMonth: number } | null;
    grid?: Cell[]; pools?: Record<string, number>;
  };
}

/**
 * How many rows of each long list go into the file. Infinity = everything the page has (the default: every iteration's
 * results have been read in full so far). Lower one only if a file gets too big to attach.
 */
export const EXPORT_LIMITS = { recentTrades: Infinity, importance: Infinity, liked: Infinity };

const f = (x: Num, d = 2) => (x == null || !Number.isFinite(x) ? '–' : x.toFixed(d));
const r = (x: Num) => (x == null || !Number.isFinite(x) ? '–' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}R`);
const pct = (x: Num) => (x == null || !Number.isFinite(x) ? '–' : `${Math.round(x * 100)}%`);
const inr = (x: Num) => (x == null || !Number.isFinite(x) ? '–' : `₹${Math.round(x).toLocaleString('en-IN')}`);
const cell = (s: unknown) => String(s ?? '–').replace(/\|/g, '/').replace(/\n/g, ' ');
const table = (head: string[], rows: unknown[][]) =>
  [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((x) => `| ${x.map(cell).join(' | ')} |`)].join('\n');
const examText = (e: P | undefined) => (!e ? '–' : e.pass === true ? 'Pass' : e.pass === false ? 'Fail' : e.n ? `${r(e.netR)} (${e.n})` : '–');
const green = (p: P | undefined) => (p?.monthsTraded ? `${p.monthsGreen}/${p.monthsTraded}` : '–');

export function mlToMarkdown(ml: ExportMl): string {
  const out: string[] = [];
  const un = Array.isArray(ml.untouched) ? ml.untouched : ml.untouched ? [ml.untouched] : [];
  const noise = (id: string) => ml.noiseAll?.find((x) => x.strategy === id);
  const when = new Date(ml.createdAt).toISOString().slice(0, 16).replace('T', ' ');

  out.push(`# Algo Lab iteration ${ml.iteration} — run ${ml.runId}`);
  out.push([
    `- Run: ${when} UTC · code ${ml.code ?? '–'}${ml.locked ? ` · locked version: ${ml.locked}` : ''}${ml.best ? ` · page's pick: ${ml.best}` : ''}`,
    `- Data: ${ml.period ? `${ml.period.from} to ${ml.period.to}` : '–'} · ${ml.stocks ?? '–'} stocks${ml.narrowStocks ? ` (${ml.narrowStocks} in ₹250–340)` : ''} · ${ml.rows?.toLocaleString('en-IN') ?? '–'} moments · exam months from ${ml.examFrom ?? '–'}${ml.shadowFrom ? ` · shadow from ${ml.shadowFrom}` : ''}`,
    `- Setup: at most ${ml.setup?.maxPerDay ?? '–'} a day, ${ml.setup?.maxPerSide ?? '–'} a side (each version may cap lower) · ₹${ml.setup?.riskInr ?? 300} risk unless the version says a position size`,
    '- All numbers are decide months (before the exam months) after costs unless marked. R = one unit of risk.',
  ].join('\n'));
  if (ml.changes?.length) out.push('## What changed\n' + ml.changes.map((c) => `- ${c}`).join('\n'));

  const w = ml.wide;
  if (w) {
    const lines = [`## Verdict (rule fixed before the run)`, `**${w.outcome}**: ${w.message}`];
    if (w.checkList?.length) lines.push(w.checkList.map((c) => `- ${c.ok ? '✓' : '✗'} ${c.label}`).join('\n'));
    lines.push(`- Pick: ${w.pick ? `${w.pick.id} (${w.pick.name})` : 'none'} · control: ${w.control ? `${w.control.id} (${w.control.name})` : '–'}`);
    if (w.narrowDraws?.length) lines.push(`- Control draws: ${w.narrowDraws.map((d) => r(d.netR)).join(', ')}`);
    if (w.wideDraws?.length) lines.push(`- Pick draws: ${w.wideDraws.map((d) => r(d.netR)).join(', ')} (average ${r(w.wideMean)})`);
    if (w.goal) lines.push(`- Goal: ${inr(w.goal.perMonth)} a month at ₹10 lakh positions (~${inr(w.goal.riskPerTrade)} risk a trade, ${w.goal.tradesPerMonth} trades a month) · ₹1 lakh a month needs ~${w.goal.positionForGoal ? `₹${(w.goal.positionForGoal / 1e5).toFixed(1)} lakh` : '–'} positions, ₹1.5 lakh ~${w.goal.positionForHigh ? `₹${(w.goal.positionForHigh / 1e5).toFixed(1)} lakh` : '–'}`);
    if (w.pools) lines.push(`- Stocks clearing each turnover floor on a typical day: ${Object.entries(w.pools).map(([k, v]) => `₹${k} cr+: ${v}`).join(' · ')}`);
    out.push(lines.join('\n'));
  }

  if (w?.grid?.length) {
    const sizes = [...new Set(w.grid.map((c) => c.size))].sort((a, b) => b - a);
    for (const size of sizes) {
      const mine = w.grid.filter((c) => c.size === size);
      const caps = [...new Set(mine.map((c) => c.cap))].sort();
      const floors = [...new Set(mine.map((c) => c.floor))].sort((a, b) => (a === 'aware' ? 1 : b === 'aware' ? -1 : a - b));
      out.push(`## Grid at ₹${size} lakh positions\nEach cell: R a trade · t · trades · R a month · exam. S = solid on its own, C = candidate (solid with profitable neighbours), * = the pick.\n\n` + table(
        ['Turnover floor', 'Stocks a day', ...caps.map((c) => `${c} a day`)],
        floors.map((fl) => [fl === 'aware' ? 'size-aware (all)' : `₹${fl} cr+`, w.pools?.[String(fl === 'aware' ? 17 : fl)] ?? '–', ...caps.map((cap) => {
          const c = mine.find((x) => x.floor === fl && x.cap === cap);
          return c ? `${r(c.netR)} · t ${f(c.t, 1)} · ${c.n} · ${f(c.rPerMonth, 1)}R/mo · exam ${c.exam ? 'Pass' : 'Fail'}${c.candidate ? ' C' : c.solid ? ' S' : ''}${w.pick?.id === c.id ? ' *' : ''}` : '–';
        })]),
      ));
    }
  }

  out.push('## All versions\n' + table(
    ['id', 'Version', 'Trades', 'Trades/mo', 'R/trade', 'Before costs', 't', 'Months green', 'Exam', 'Untouched', 'Draws (min to max, avg)', 'Shadow', '₹/mo at ₹300', 'Worst day', 'Deepest losses', 'Signal'],
    ml.strategies.map((s) => {
      const u = un.find((x) => x.id === s.id), nz = noise(s.id);
      return [s.id, s.name, s.dev?.n, f(s.money?.tradesPerMonth, 1), r(s.dev?.netR), r(s.dev?.gross), f(s.dev?.t, 1), green(s.dev), examText(s.exam),
        u?.overall?.n ? `${r(u.overall.netR)} t ${f(u.overall.t, 1)} (${u.overall.n})` : '–',
        nz ? `${r(nz.devMin)} to ${r(nz.devMax)} (${r(nz.devMean)})` : '–',
        s.shadow?.n ? `${r(s.shadow.netR)} (${s.shadow.n})` : '–',
        inr(s.money?.perMonth), s.daily ? `${f(s.daily.worstDayR)}R` : '–', s.money?.maxDrawdownR != null ? `-${f(s.money.maxDrawdownR, 1)}R` : '–',
        s.ic?.mean != null ? `${f(s.ic.mean, 3)} (${s.ic.positive}/${s.ic.months})` : '–'];
    }),
  ));

  out.push('## Each version');
  for (const s of ml.strategies) {
    const sec = [`### ${s.id} — ${s.name}`];
    if (s.desc) sec.push(s.desc);
    sec.push([
      `- Decide months: ${s.dev?.n ?? 0} trades · ${r(s.dev?.netR)} a trade (${r(s.dev?.gross)} before costs) · t ${f(s.dev?.t, 1)} · hit ${pct(s.dev?.hit)} · total ${f(s.dev?.sumR, 1)}R · months green ${green(s.dev)} · exam ${examText(s.exam)}`,
      s.baseline ? `- Taking every moment blindly: ${r(s.baseline.long)} long / ${r(s.baseline.short)} short after costs (${r(s.baseline.longGross)} / ${r(s.baseline.shortGross)} before)` : '',
      s.money ? `- Money at ₹300 risk: stop ~${f(s.money.stopPct)}% · ${inr(s.money.perTrade)} a trade · ${f(s.money.tradesPerMonth, 1)} trades a month · ${inr(s.money.perMonth)} a month on ${inr(s.money.capital)} (${f(s.money.pct, 1)}%) · worst month ${inr(s.money.worstMonth)} · best ${inr(s.money.bestMonth)}` : '',
      s.daily ? `- Days: ${s.daily.daysWithTrades}/${s.daily.tradingDays} with a trade · ${f(s.daily.perTradedDay)} avg, ${s.daily.maxPerDay} max a day · fired at 09:35 ${pct(s.daily.at0935)} · green days ${pct(s.daily.greenDays)} · worst day ${f(s.daily.worstDayR)}R · best ${f(s.daily.bestDayR)}R · worst week ${f(s.daily.worstWeekR)}R · green weeks ${pct(s.daily.greenWeeks)}` : '',
      s.shadow?.n ? `- Shadow months: ${s.shadow.n} trades · ${r(s.shadow.netR)} · green ${green(s.shadow)}` : '',
    ].filter(Boolean).join('\n'));
    if (s.months?.length) sec.push('Month by month (traded blind)\n\n' + table(['Month', 'Trades', 'Hit', 'Before costs', 'R/trade', 'Total R', 'Signal', 'Note'],
      s.months.map((m) => [`${m.month}${m.exam ? ' (exam)' : ''}`, m.n, m.n ? pct(m.hit) : '–', m.n ? r(m.gross) : '–', m.n ? r(m.netR) : '–', m.n ? f(m.sumR, 1) : '–', f(m.ic, 3), m.note ?? ''])));
    if (s.costs?.length) sec.push('Same trades at other execution / sizes (old fills unless the name says otherwise)\n\n' + table(['Execution', 'Trades', 'R/trade', 't', 'Months green', 'Exam'],
      s.costs.map((c) => [c.name, c.dev?.n, r(c.dev?.netR), f(c.dev?.t, 1), c.devMonths ? `${c.devMonths[0]}/${c.devMonths[1]}` : '–', c.exam?.n ? r(c.exam.netR) : '–'])));
    const parts = [...(s.bySide ? (['long', 'short'] as const).map((k) => [k, s.bySide?.[k]] as const) : []), ...(s.byHour ?? []).map((h) => [`from ${h.hour}`, h] as const)];
    if (parts.length) sec.push('By side and time\n\n' + table(['', 'Trades', 'Before costs', 'After costs', 't'], parts.map(([k, v]) => [k, v?.n ?? 0, r(v?.gross), r(v?.netR), f(v?.t, 1)])));
    if (s.bands?.length) sec.push('By liquidity band\n\n' + table(['Band', 'Trades', 'R/trade', 't'], s.bands.map((b) => [b.band, b.n, r(b.netR), f(b.t, 1)])));
    if (s.importance?.length) sec.push('What the model leans on: ' + s.importance.slice(0, EXPORT_LIMITS.importance).map((x) => `${x.label} ${pct(x.share)}`).join(' · '));
    if (s.liked?.length) sec.push('Its trades vs all moments (z, its median, all median): ' + s.liked.slice(0, EXPORT_LIMITS.liked).map((x) => `${x.side} ${x.label} ${f(x.z)} (${x.taken} vs ${x.all})`).join(' · '));
    if (s.recent?.length) sec.push('Latest trades\n\n' + table(['Day', 'Time', 'Stock', 'Side', 'Predicted', 'Result'], s.recent.slice(0, EXPORT_LIMITS.recentTrades).map((t) => [t.day, t.time, t.sym, t.side, r(t.pred), r(t.net)])));
    out.push(sec.join('\n\n'));
  }
  return out.join('\n\n') + '\n';
}

export const exportFileName = (ml: Pick<ExportMl, 'iteration' | 'runId'>) => `algo-lab-iteration-${ml.iteration}-${ml.runId}.md`;
