import { tradeMarks } from '../book/marks';
import { resultOf, scoreR, mysteryCutoff, type ShortTrade, type WeekScore } from '../shorts/trades';
import { stopFor } from '../shorts/spec';
import type { LedgerEntry } from '../ml/ledger';
import type { EarlyNote } from './early';
import type { ArticleTrade, Candle, Format, ImageSpec, Material, TradeChart } from './article';

/**
 * Turns real data into an article's Material (pure: the loading is in lib/medium/source.ts). `facts` is the only
 * thing Claude ever sees, so what is left out here cannot leak through Claude:
 *  - no journal context columns (setup names, RVOL, VWAP distance, ...): they describe how he picks trades
 *  - Algo Lab: process and results only (iteration, date, trades, net R, t, months green, dev / exam). Never feature
 *    importance, what the model "liked", thresholds, setup parameters, or strategy names (they spell out stops and
 *    targets): strategies become letters. "What changed" lines are added only when he ticks them (factsFor).
 *  - tickers of trades under 92 days old are replaced by "Stock A", "Stock B", ... everywhere
 */

type T = ShortTrade & { orderRisk?: number; side?: 'me' | 'algo' };
const r1 = (n: number) => Math.round(n * 10) / 10;
const sgn = (n: number, d = 1) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(d)}`;
const inr = (n: number) => `${n >= 0 ? '+' : '−'}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const dayLabel = (d: string) => `${Number(d.slice(8, 10))} ${MON[Number(d.slice(5, 7)) - 1].slice(0, 3)} ${d.slice(0, 4)}`;
export const monthLabel = (m: string) => `${MON[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

/** Ticker for old trades, "Stock A" / "Stock B" (same stock, same letter) for recent ones. */
export function labeller(trades: T[], now: number) {
  const cutoff = mysteryCutoff(now);
  const letters = new Map<string, string>();
  for (const t of trades) if (t.date > cutoff && !letters.has(t.symbol)) letters.set(t.symbol, `Stock ${String.fromCharCode(65 + (letters.size % 26))}`);
  return {
    label: (t: T) => (t.date <= cutoff ? t.symbol : letters.get(t.symbol)!),
    show: (t: T) => t.date <= cutoff,
    hidden: [...letters.keys()],
  };
}

const rOf = (t: T) => (t.netR !== undefined ? t.netR : scoreR(t));

export function articleTrade(t: T, label: string, show: boolean): ArticleTrade {
  const res = resultOf(t);
  const r = rOf(t);
  return {
    id: t.id, date: t.date, label, showTicker: show, dir: t.dir, side: t.side, entryTime: t.entryTime.slice(0, 5), exitTime: t.exitTime.slice(0, 5),
    holdMin: t.holdMin, result: r !== undefined ? `${sgn(r)}R` : `${sgn(res.value, 2)}%`, netR: r, net: t.net, exitType: t.exitType,
    comment: t.comment,
  };
}

/** One trade's line for Claude: the facts, and his own journal note when he wrote one. */
export const tradeFact = (a: ArticleTrade) =>
  `${a.label}${a.side ? ` (${a.side === 'me' ? 'his trade' : 'the algo\'s trade'})` : ''}: ${a.dir} on ${a.date}, in ${a.entryTime}, out ${a.exitTime} (${a.holdMin} min), ` +
  `result ${a.result} (${inr(a.net)} after charges), exit ${a.exitType}${a.comment ? `. His journal note: "${a.comment}"` : ''}`;

function summary(ts: T[]) {
  const wins = ts.filter((t) => t.net > 0).length;
  const rs = ts.map(rOf).filter((x): x is number => x !== undefined);
  const net = ts.reduce((a, t) => a + t.net, 0);
  return { n: ts.length, wins, losses: ts.length - wins, hit: ts.length ? Math.round((wins / ts.length) * 100) : 0, r: r1(rs.reduce((a, x) => a + x, 0)), rCounted: rs.length, net, avgR: rs.length ? Math.round((rs.reduce((a, x) => a + x, 0) / rs.length) * 100) / 100 : 0 };
}
const summaryLine = (what: string, s: ReturnType<typeof summary>) =>
  `${what}: ${s.n} trades, ${s.wins} wins, ${s.losses} losses (hit rate ${s.hit}%), net ${sgn(s.r)}R over the ${s.rCounted} trades with risk logged, ${inr(s.net)} after charges, average ${sgn(s.avgR, 2)}R a trade.`;

/** Cumulative curve: R when every trade has R, otherwise ₹. */
function equity(ts: T[], label: (t: T) => string): ImageSpec['data'] {
  const allR = ts.length > 0 && ts.every((t) => rOf(t) !== undefined);
  let run = 0;
  const points = [{ label: 'start', value: 0 }, ...ts.map((t) => { run += allR ? rOf(t)! : t.net; return { label: label(t), value: allR ? r1(run) : Math.round(run) }; })];
  return { kind: 'equity', unit: allR ? 'R' : '₹', points };
}

/** The trade's chart from its day's 1-minute candles: 5-minute candles from 09:15 to 30 minutes after the exit. */
export function tradeChart(t: T, minute: { t: number[]; o: number[]; h: number[]; l: number[]; c: number[] }, label: string): TradeChart | undefined {
  const IST = 19800;
  const sec = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 3600 + m * 60; };
  const dayStart = Date.parse(`${t.date}T00:00:00Z`) / 1000 - IST;
  const until = dayStart + sec(t.exitTime.slice(0, 5)) + 30 * 60;
  const bars: Candle[] = [];
  for (let i = 0; i < minute.t.length; i++) {
    if (minute.t[i] < dayStart + sec('09:15') || minute.t[i] > until) continue;
    const slot = minute.t[i] - ((minute.t[i] - (dayStart + sec('09:15'))) % 300);
    const b = bars[bars.length - 1];
    if (b && b.t === slot) { b.h = Math.max(b.h, minute.h[i]); b.l = Math.min(b.l, minute.l[i]); b.c = minute.c[i]; }
    else bars.push({ t: slot, o: minute.o[i], h: minute.h[i], l: minute.l[i], c: minute.c[i] });
  }
  if (bars.length < 3) return undefined;
  const inSide = t.dir === 'LONG' ? 'BUY' : 'SELL', outSide = t.dir === 'LONG' ? 'SELL' : 'BUY';
  const marks = tradeMarks(t.date, t.dir, t.fills.map((f) => ({ time: f.time, side: f.kind === 'in' ? inSide : outSide, qty: f.qty, price: f.price })))
    .map((m) => ({ t: Math.floor(m.t / 1000), price: m.price, role: m.role }));
  const r = rOf(t), res = resultOf(t);
  return { label, date: t.date, dir: t.dir, candles: bars, marks, stop: stopFor(t) ?? undefined, result: r !== undefined ? `${sgn(r)}R` : `${sgn(res.value, 2)}%` };
}

const biggest = (ts: T[], f: (t: T) => number) => [...ts].sort((a, b) => f(b) - f(a))[0];
type Minute = { t: number[]; o: number[]; h: number[]; l: number[]; c: number[] };

function tradeImage(id: string, t: T | undefined, charts: Map<string, Minute>, label: (t: T) => string, show: (t: T) => boolean, why: string): ImageSpec | undefined {
  if (!t) return undefined;
  const m = charts.get(t.id);
  const chart = m && tradeChart(t, m, label(t));
  if (!chart) return undefined;
  return { id, title: `${why}: ${label(t)}, ${dayLabel(t.date)}`, caption: `${label(t)}${show(t) ? '' : ' (name hidden: under 3 months old)'}, ${t.dir.toLowerCase()}, 5-minute candles. ${chart.result}.`, data: { kind: 'trade', chart } };
}

const banner = (): ImageSpec => ({ id: 'banner', title: 'Feature image (top of the article)', caption: '', data: { kind: 'banner' } });

/** Weekly log / monthly review: the period's journal trades. `charts` holds the 1-minute candles of trades to draw. */
export function tradesMaterial(format: 'weekly' | 'monthly', period: Material['period'], trades: T[], prev: T[] | undefined, charts: Map<string, Minute>, now: number): Material {
  const { label, show, hidden } = labeller(trades, now);
  const items = trades.map((t) => articleTrade(t, label(t), show(t)));
  const s = summary(trades);
  const facts = [summaryLine(format === 'weekly' ? `Week ${period.label}` : `${period.label}`, s)];
  if (prev && prev.length) facts.push(summaryLine('The period before', summary(prev)));
  const exits = new Map<string, number>(); trades.forEach((t) => exits.set(t.exitType, (exits.get(t.exitType) ?? 0) + 1));
  if (trades.length) facts.push(`Exits: ${[...exits].map(([k, v]) => `${v} ${k}`).join(', ')}.`);
  facts.push(...items.map(tradeFact));
  const best = biggest(trades, (t) => rOf(t) ?? t.net), worst = biggest(trades, (t) => -(rOf(t) ?? t.net));
  const images = [banner(), {
    id: 'equity', title: format === 'weekly' ? 'The week, trade by trade' : 'The month, trade by trade',
    caption: 'Running total after charges, every trade in order (real journal data).', data: equity(trades, (t) => `${t.date.slice(5)} ${label(t)}`),
  } as ImageSpec,
  tradeImage('best', best, charts, label, show, 'Best trade'),
  worst && worst.id !== best?.id && worst.net < 0 ? tradeImage('worst', worst, charts, label, show, 'Worst trade') : undefined,
  ].filter((x): x is ImageSpec => !!x);
  return { format, period, facts, trades: items, images, hiddenTickers: hidden, oldPrices: trades.length > 0 && trades.every(show) };
}

/** Me vs Algo: the week's score comes only from the frozen season ledger (what viewers already saw never changes). */
export function vsMaterial(period: Material['period'], week: WeekScore, season: { me: number; algo: number }, weeks: WeekScore[], me: T[], algo: T[], charts: Map<string, Minute>, now: number): Material {
  const all: T[] = [...me.map((t) => ({ ...t, side: 'me' as const })), ...algo.map((t) => ({ ...t, side: 'algo' as const }))].sort((a, b) => (a.date + a.entryTime < b.date + b.entryTime ? -1 : 1));
  const { label, show, hidden } = labeller(all, now);
  const items = all.map((t) => articleTrade(t, label(t), show(t)));
  const won = { me: 'He won the week.', algo: 'The algo won the week.', tie: 'Dead even.', none: 'Neither side traded.' }[week.winner];
  const facts = [
    `Me vs Algo, week of ${period.label} (frozen score): him ${sgn(week.me.r)}R from ${week.me.n} trades, the algo ${sgn(week.algo.r)}R from ${week.algo.n} trades. ${won}`,
    `Season so far (weeks won, frozen): him ${season.me}, the algo ${season.algo}.`,
    'The algo is his own model (Algo Live), trading real money on his account; it only takes short trades.',
    ...items.map(tradeFact),
  ];
  const images = [banner(), {
    id: 'scoreboard', title: 'Me vs Algo scoreboard', caption: `Frozen weekly results in R, after charges. Season: me ${season.me}, algo ${season.algo}.`,
    data: { kind: 'scoreboard', weeks: weeks.map((w) => ({ week: w.week, me: w.me.r, algo: w.algo.r, winner: w.winner })), season },
  } as ImageSpec,
  tradeImage('me', biggest(me, (t) => Math.abs(rOf(t) ?? 0)), charts, label, show, 'My biggest trade'),
  tradeImage('algo', biggest(algo, (t) => Math.abs(rOf(t) ?? 0)), charts, label, show, 'The algo\'s biggest trade'),
  ].filter((x): x is ImageSpec => !!x);
  return { format: 'vs-algo', period, facts, trades: items, images, hiddenTickers: hidden, oldPrices: all.length > 0 && all.every(show) };
}

/** A strategy's public name: a letter (its own id when that already is one), never its descriptive name. */
export function strategyLetter(id: string, order: string[]): string {
  if (/^[A-Z][0-9]?$/.test(id)) return id;
  const i = order.indexOf(id);
  return `Strategy ${String.fromCharCode(65 + ((i < 0 ? order.length : i) % 26))}`;
}

/** R a trade, 2 decimals ("+0.05R"): Algo Lab results are per trade, so one decimal would hide them. */
const rt = (n: number) => `${sgn(n, 2)}R a trade`;

/**
 * Building tradereye: Algo Lab iterations, process and results only. `entries` are iterations with results files (the
 * kept ledger from 5 on, or an older run still in the run index); `notes` cover iterations 1-4 when no results file
 * is left (lib/medium/early.ts). One iteration picked = one part of the series: earlier iterations are given as a
 * one-line recap each, so the story can say where it came from.
 */
export function buildingMaterial(period: Material['period'], entries: LedgerEntry[], notes: EarlyNote[] = [], earlier: { iteration: number; line: string; bar?: { label: string; value: number; note?: string } }[] = []): Material {
  const its = [...entries].sort((a, b) => a.iteration - b.iteration);
  const order = [...new Set(its.flatMap((e) => e.lines.map((l) => l.id)))];
  const from = Number(period.from), to = Number(period.to);
  const facts = [
    'Algo Lab: a machine-learning model for NSE intraday trades that he builds iteration by iteration, on top of his own trade journal app (tradereye). ' +
    'Each iteration trains on earlier months, decides on later ones ("decide months"), and only confirms on "exam" months it never trained on. ' +
    'R = profit in units of the risk taken; results are per trade, after charges unless said.',
    from === to
      ? `Series: one article per iteration. This is part ${from} of the series (iteration ${from}).${from > 1 ? ` Earlier parts covered iterations 1–${from - 1}.` : ' It is the first part.'}`
      : `This article covers iterations ${from}–${to}.`,
    'What this article may NOT reveal (his edge): which features or inputs the model uses, any thresholds, stops, targets or rules of the strategy. Talk about process, results, failures and lessons only.',
    ...earlier.map((e) => `Before this (iteration ${e.iteration}, recap only): ${e.line}`),
  ];
  type Row = { iteration: number; fact: string; bar?: { label: string; value: number; note?: string }; changes: string[] };
  const rows: Row[] = notes.map((n) => ({
    iteration: n.iteration, fact: `Iteration ${n.iteration} (${n.when}): ${n.facts}`,
    bar: { label: `#${n.iteration}`, value: n.bar.value, note: n.bar.note }, changes: n.changes,
  }));
  for (const e of its) {
    const best = e.lines.find((l) => l.id === e.best) ?? [...e.lines].sort((a, b) => b.netR - a.netR)[0];
    const lines = e.lines.map((l) => `${strategyLetter(l.id, order)} ${l.n} trades, ${rt(l.netR)} overall, t ${l.t.toFixed(1)}, ${l.monthsGreen}/${l.monthsTraded} months green` +
      `${l.dev !== null ? `, decide months ${rt(l.dev)}` : ''}${l.exam !== null ? `, exam months ${rt(l.exam)}${l.exam < 0 ? ' (FAILED the exam)' : ''}` : ''}`);
    rows.push({
      iteration: e.iteration, fact: `Iteration ${e.iteration} (${dayLabel(new Date(e.createdAt).toISOString().slice(0, 10))}): ${lines.join('; ')}.`,
      bar: best ? { label: `#${e.iteration}`, value: Math.round((best.exam ?? best.netR) * 100) / 100, note: best.exam !== null ? 'exam' : 'overall' } : undefined,
      changes: e.changes,
    });
  }
  rows.sort((a, b) => a.iteration - b.iteration);
  facts.push(...rows.map((r) => r.fact));
  const changes = rows.flatMap((r) => r.changes.map((text) => ({ iteration: r.iteration, text: text.slice(0, 400) })));
  const bars = [...earlier.map((e) => e.bar).filter((b): b is NonNullable<typeof b> => !!b), ...rows.map((r) => r.bar).filter((b): b is NonNullable<typeof b> => !!b)];
  const images = [banner(), {
    id: 'iterations', title: from === to ? `Iteration ${from} against the ones before` : 'Every iteration\'s result',
    caption: 'R a trade of each iteration\'s best strategy, on exam months it never trained on where it had them (otherwise overall). Red = lost.',
    data: { kind: 'iterations', bars },
  } as ImageSpec];
  return { format: 'building', period, facts, trades: [], images, hiddenTickers: [], changes, oldPrices: false };
}

/** One-line recap of an iteration (results only), for the parts after it in the series. */
export function recapOf(e: LedgerEntry | EarlyNote): { iteration: number; line: string; bar: { label: string; value: number; note?: string } } {
  if ('facts' in e) return { iteration: e.iteration, line: e.facts, bar: { label: `#${e.iteration}`, value: e.bar.value, note: e.bar.note } };
  const best = e.lines.find((l) => l.id === e.best) ?? [...e.lines].sort((a, b) => b.netR - a.netR)[0];
  const v = best ? Math.round((best.exam ?? best.netR) * 100) / 100 : 0;
  return {
    iteration: e.iteration,
    line: best ? `best strategy ${best.n} trades, ${rt(best.netR)} overall${best.exam !== null ? `, exam ${rt(best.exam)}${best.exam < 0 ? ' (failed)' : ''}` : ''}.` : 'no results.',
    bar: { label: `#${e.iteration}`, value: v, note: best?.exam !== null ? 'exam' : 'overall' },
  };
}

/** The facts Claude gets for an article: the material's, plus the "what changed" lines he ticked as safe. */
export function factsFor(m: Material, shared: number[]): string[] {
  const ok = (m.changes ?? []).filter((_, i) => shared.includes(i));
  return [...m.facts, ...ok.map((c) => `Iteration ${c.iteration}, what changed (he cleared this to share): ${c.text}`)];
}

export const FORMAT_OF = (f: string): Format | undefined => (['weekly', 'vs-algo', 'building', 'monthly'] as const).find((x) => x === f);
