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

/** What a reader who has never traded needs to follow a trade article. Given to Claude as facts. */
export const TRADES_GLOSSARY = [
  'Plain-words glossary (explain these to the reader the first time they appear):',
  'Intraday trade = bought and sold (or sold and bought back) the same day, never held overnight.',
  'Long = a bet the price will rise. Short = a bet the price will fall (sell first, buy back later).',
  'Stop (stop-loss) = the price where he gets out automatically to cap the loss, set before the trade.',
  'R = how much a trade made or lost compared with what he risked on it (the loss if the stop is hit). +2R = made twice what he risked; −1R = lost what he risked.',
  'Charges = brokerage, exchange fees and taxes on every trade.',
  'Hit rate = the share of trades that made money.',
  '"Stock A", "Stock B" = real stocks whose names are hidden because the trade is less than 3 months old (Indian market rules on sharing recent price data).',
];

const EXIT: Record<string, string> = { TARGET: 'hit his profit target', STOP: 'stopped out (hit his stop-loss)', MANUAL: 'closed by hand', EOD: 'closed at the end of the day', TIME: 'closed on time' };
const exitPlain = (x: string) => EXIT[x] ?? (x === 'UNKNOWN' ? 'exit not recorded' : x.toLowerCase().replace(/_/g, ' '));

/** One trade's line for Claude: the facts, and his own journal note when he wrote one. */
export const tradeFact = (a: ArticleTrade) =>
  `${a.label}${a.side ? ` (${a.side === 'me' ? 'his trade' : 'the algo\'s trade'})` : ''}: ${a.dir} on ${a.date}, in ${a.entryTime}, out ${a.exitTime} (${a.holdMin} min), ` +
  `result ${a.result} (${inr(a.net)} after charges), ${exitPlain(a.exitType)}${a.comment ? `. His journal note: "${a.comment}"` : ''}`;

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
  const facts = [...TRADES_GLOSSARY, summaryLine(format === 'weekly' ? `Week ${period.label}` : `${period.label}`, s)];
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
    ...TRADES_GLOSSARY,
    `Me vs Algo, week of ${period.label} (frozen score): him ${sgn(week.me.r)}R from ${week.me.n} trades, the algo ${sgn(week.algo.r)}R from ${week.algo.n} trades. ${won}`,
    `Season so far (weeks won, frozen): him ${season.me}, the algo ${season.algo}.`,
    'The algo is his own computer model (Algo Live): it picks and places trades by itself with real money on his account, and only takes short trades. Each week, whoever made more R wins the week.',
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

/**
 * A version's public name, in plain words: never a letter or code ("Strategy A" means nothing to a reader) and never
 * its descriptive name (that spells out stops and targets). The one the iteration went forward with is "the version
 * it kept"; the others are numbered comparison versions.
 */
export function versionName(id: string, best: string | undefined, ids: string[]): string {
  if (ids.length === 1) return 'the model';
  if (id === best) return 'the version it kept';
  const others = ids.filter((x) => x !== best);
  return `comparison version ${others.indexOf(id) + 1}`;
}

/** R a trade, 2 decimals ("+0.05R"): Algo Lab results are per trade, so one decimal would hide them. */
const rt = (n: number) => `${sgn(n, 2)}R a trade`;
/** "+0.05R a trade (each trade made 5% of what it risked, on average)" */
const rtPlain = (n: number) => `${rt(n)} (on average each trade ${n >= 0 ? 'made' : 'lost'} ${Math.abs(Math.round(n * 100))}% of the amount it risked)`;

/** What a reader who has never traded needs to follow an Algo Lab article. Given to Claude as facts. */
export const ALGO_GLOSSARY = [
  'Plain-words glossary (explain these to the reader the first time they appear):',
  'Algo Lab = his own software that tests a trading idea on years of past price data, as if it had traded back then (no real money).',
  'Iteration = one round of: change something, re-test it on the past, look at the result, decide what to change next.',
  'R = how much a trade made or lost compared with what it risked. +1R = made as much as it risked; −1R = lost all of it. +0.05R a trade = each trade made 5% of what it risked, on average. Each test trade risks ₹300.',
  'Charges = brokerage, exchange fees and taxes paid on every trade; small per trade, but they add up.',
  'Exam months = the most recent months, locked away and never used to build or tune the model, used once at the end to check it still works on data it has never seen. Failing the exam = it lost money there.',
  'Decide months = the months the next steps are chosen from (the exam months are kept out of it).',
  't (confidence score) = how unlikely the result is to be luck; above about 2 = probably not luck, near 0 = could easily be luck.',
  'Signal = how well the model\'s predictions lined up with what really happened next; 0 = it knows nothing.',
  'Short trade = a bet that the price will fall.',
];

/**
 * Building tradereye: Algo Lab iterations, process and results only. `entries` are iterations with results files (the
 * kept ledger from 5 on, or an older run still in the run index); `notes` cover iterations 1-4 when no results file
 * is left (lib/medium/early.ts). One iteration picked = one part of the series: earlier iterations are given as a
 * one-line recap each, so the story can say where it came from.
 */
export function buildingMaterial(period: Material['period'], entries: LedgerEntry[], notes: EarlyNote[] = [], earlier: { iteration: number; line: string; bar?: { label: string; value: number; note?: string } }[] = []): Material {
  const its = [...entries].sort((a, b) => a.iteration - b.iteration);
  const from = Number(period.from), to = Number(period.to);
  const facts = [
    'Algo Lab: a machine-learning model that tries to pick good intraday trades (in and out the same day) on Indian stocks, which he builds iteration by iteration, ' +
    'inside his own trading app (tradereye). All results below are from testing on past data, per trade, after charges unless said.',
    ...ALGO_GLOSSARY,
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
    const ids = e.lines.map((l) => l.id);
    const lines = [...e.lines].sort((a, b) => (a.id === best?.id ? -1 : b.id === best?.id ? 1 : 0)).map((l) => {
      const name = versionName(l.id, best?.id, ids);
      return `${name[0].toUpperCase()}${name.slice(1)}: ${l.n} test trades, ${rtPlain(l.netR)}; made money in ${l.monthsGreen} of the ${l.monthsTraded} months it traded; confidence score t ${l.t.toFixed(1)}` +
        `${l.dev !== null ? `; decide months ${rt(l.dev)}` : ''}${l.exam !== null ? `; exam months ${rt(l.exam)}${l.exam < 0 ? ' (FAILED the exam: lost money on months it had never seen)' : ' (passed the exam)'}` : ''}`;
    });
    rows.push({
      iteration: e.iteration, fact: `Iteration ${e.iteration} (${dayLabel(new Date(e.createdAt).toISOString().slice(0, 10))}). ${lines.join('. ')}.`,
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
    caption: 'Average result per trade of the version each iteration kept, in R (+0.05R = each trade made 5% of what it risked). Exam months where it had them. Red = lost money.',
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
    line: best ? `the version it kept: ${best.n} test trades, ${rtPlain(best.netR)}${best.exam !== null ? `; exam months ${rt(best.exam)}${best.exam < 0 ? ' (failed the exam)' : ' (passed the exam)'}` : ''}.` : 'no results.',
    bar: { label: `#${e.iteration}`, value: v, note: best?.exam !== null ? 'exam' : 'overall' },
  };
}

/** The facts Claude gets for an article: the material's, plus the "what changed" lines he ticked as safe. */
export function factsFor(m: Material, shared: number[]): string[] {
  const ok = (m.changes ?? []).filter((_, i) => shared.includes(i));
  return [...m.facts, ...ok.map((c) => `Iteration ${c.iteration}, what changed (he cleared this to share): ${c.text}`)];
}

export const FORMAT_OF = (f: string): Format | undefined => (['weekly', 'vs-algo', 'building', 'monthly'] as const).find((x) => x === f);
