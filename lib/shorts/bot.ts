import type { Candles } from '../dhan';
import type { MeVsAlgoRow } from '../algoLive/meVsAlgo';
import { dateLabel } from './spec';

/**
 * "My bot's trade": a YouTube-only short built from one Algo Live trade. THE BOT narrates: its line opens the video, big on
 * screen and spoken in a voice that is plainly synthetic (open-source text-to-speech in the render job, with a robotic
 * effect), because the bot is the AI in this story; nothing pretends to be him. The chart moves at once (no freeze, no
 * countdown), the bot's entry / stop / target are labelled lines, and when he stepped in the video shows where, then what
 * the untouched bracket would have done. Sound design marks every beat (scripts/shorts/render.py). Every number comes from Me vs Algo (lib/algoLive/meVsAlgo.ts): the order, the journal and the day's candles.
 * Pure: the loaders live in source.ts.
 */

export interface BotPanel {
  tf: number;                                            // minutes per drawn candle (5)
  candles: [number, number, number, number, number][];  // 1-minute candles [unix sec, o, h, l, c]
  entryIdx: number; side: 'SHORT';
  entry: number; stop: number; target: number; qty: number;
}
export interface BotSpec {
  kind: 'bot'; symbol: string; dateLabel: string; panel: BotPanel;
  /** where he got out (journal), the result after charges, and how ("MANUAL", "STOP", "TARGET"...) */
  mine: { idx: number; price: number; inr: number; how: string };
  /** the bracket left alone (backtest fill rules); null when it would still be open or there are no candles after */
  plan: { idx: number; price: number; outcome: 'TARGET' | 'STOP' | '15:15'; inr: number } | null;
  /** he closed it himself before the bracket did */
  stepped: boolean;
  /** the bot's line, shown big on the opening frame (e.g. "He touched my trade. Cost him ₹520.") */
  line: string;
  /** the same line as the bot's voice reads it ("520 rupees"); empty = no voice */
  say: string;
}

/** A candidate row's key, also the short's `ref` (used tracking): date, stock and the order's time. */
export const botRef = (r: Pick<MeVsAlgoRow, 'date' | 'symbol' | 'time'>) => `${r.date}_${r.symbol}_${r.time.replace(':', '')}`;
export const parseBotRef = (ref: string) => {
  const m = /^(\d{4}-\d{2}-\d{2})_([A-Z0-9&_-]+)_(\d{2})(\d{2})$/.exec(ref);
  return m ? { date: m[1], symbol: m[2], time: `${m[3]}:${m[4]}` } : undefined;
};

/** Ready for a short: he is out (journal exit) and the result is known. */
export const botReady = (r: MeVsAlgoRow) => r.myExit !== null && r.myInr !== null && !!r.myTime;

const IST = 19800;
const OPEN = 9 * 3600 + 15 * 60;
const istSec = (t: number) => ((t + IST) % 86400 + 86400) % 86400;
const hm = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 3600 + m * 60; };
const r2 = (n: number) => Math.round(n * 100) / 100;
/** before the entry, at most this much of the day is shown (the hook runs over it fast) */
export const BOT_LEAD_MIN = 45;
const TF = 5;

/**
 * The window: from up to BOT_LEAD_MIN before the entry (on a 5-minute boundary, never before 09:15) to the 5-minute
 * candle after the later of his exit and the untouched exit. Indexes are minute indexes into `candles`.
 */
export function buildBotSpec(row: MeVsAlgoRow, day: Candles, line: string, voice = true): BotSpec {
  if (!botReady(row)) throw new Error('That trade is not closed in the journal yet.');
  const cs: [number, number, number, number, number][] = day.t.map((t, i) => [t, r2(day.o[i]), r2(day.h[i]), r2(day.l[i]), r2(day.c[i])]);
  if (!cs.length) throw new Error(`No candles saved for ${row.symbol} on ${row.date}.`);
  const at = (sec: number) => { let k = 0; for (let i = 0; i < cs.length; i++) if (istSec(cs[i][0]) <= sec) k = i; else break; return k; };
  const slot = (sec: number) => OPEN + Math.floor((sec - OPEN) / (TF * 60)) * TF * 60;
  const entrySec = hm(row.time), mySec = hm(row.myTime!);
  const planSec = row.planOutcome && row.planOutcome !== 'OPEN' && row.planTime ? hm(row.planTime) : undefined;
  const startSec = slot(Math.max(OPEN, entrySec - BOT_LEAD_MIN * 60));
  const endSec = slot(Math.max(mySec, planSec ?? mySec)) + 2 * TF * 60;
  const from = Math.max(0, cs.findIndex((k) => istSec(k[0]) >= startSec));
  let to = cs.length - 1;
  while (to > from && istSec(cs[to][0]) >= endSec) to--;
  const win = cs.slice(from, to + 1);
  const idx = (sec: number) => Math.max(0, Math.min(win.length - 1, at(sec) - from));
  const plan = planSec !== undefined && row.planExit !== null && row.planInr !== null
    ? { idx: idx(planSec), price: row.planExit, outcome: row.planOutcome as 'TARGET' | 'STOP' | '15:15', inr: row.planInr } : null;
  return {
    kind: 'bot', symbol: row.symbol, dateLabel: dateLabel(row.date), line: line.trim().slice(0, 80), say: voice ? spoken(line) : '',
    panel: { tf: TF, candles: win, entryIdx: idx(entrySec), side: 'SHORT', entry: row.entry, stop: row.stop, target: row.target, qty: row.qty },
    mine: { idx: idx(mySec), price: row.myExit!, inr: row.myInr!, how: row.myHow },
    plan, stepped: !!row.steppedIn && !!plan,
  };
}

const inr = (x: number) => `${x < 0 ? '−' : '+'}₹${Math.abs(Math.round(x)).toLocaleString('en-IN')}`;

/** The bot's line when Claude is off or fails: the bot speaking about him, the result in it, under ~8 words. */
export function fallbackLine(s: Pick<BotSpec, 'mine' | 'plan' | 'stepped'>): string {
  if (s.stepped && s.plan) {
    const diff = s.mine.inr - s.plan.inr;
    return diff < 0 ? `He touched my trade. Cost him ₹${Math.abs(Math.round(diff))}.` : `He stepped in. Saved ₹${Math.round(diff)}. Fine.`;
  }
  return s.mine.inr >= 0 ? `He left me alone. I made ₹${Math.round(s.mine.inr)}.` : `He let me trade. I lost ₹${Math.abs(Math.round(s.mine.inr))}.`;
}

/** The line as text-to-speech should read it: "₹1,520" -> "1520 rupees". */
export function spoken(line: string): string {
  return line.replace(/[−-]?₹\s?([\d,]+)/g, (_, n: string) => `${n.replace(/,/g, '')} rupees`).replace(/\s+/g, ' ').trim();
}

/** The facts Claude writes the voice line, its context and the YouTube text from (numbers after charges). */
export function botFacts(s: BotSpec, date: string): string {
  const p = s.panel;
  const t = (i: number) => new Date((p.candles[i][0] + IST) * 1000).toISOString().slice(11, 16);
  return [
    `Algo Live (his own trading bot) SHORTED ${s.symbol} on ${date} at ${t(p.entryIdx)}: entry ${p.entry}, stop ${p.stop}, target ${p.target}, ${p.qty} shares.`,
    `He got out at ${s.mine.price} at ${t(s.mine.idx)} (${s.mine.how}): ${inr(s.mine.inr)} after charges.`,
    s.plan ? `Left untouched, the bot's own bracket would have ended ${s.plan.outcome === 'TARGET' ? 'at its target' : s.plan.outcome === 'STOP' ? 'at its stop' : 'at the 15:15 close'} (${s.plan.price} at ${t(s.plan.idx)}): ${inr(s.plan.inr)} after charges (an estimate with the backtest's fill rules).`
      : 'What the untouched bracket would have done is not known (still open, or no candles after).',
    s.stepped && s.plan ? `He stepped in: ${s.mine.inr - s.plan.inr >= 0 ? 'that SAVED' : 'that COST'} him ${inr(Math.abs(s.mine.inr - s.plan.inr)).slice(1)} against leaving it alone.` : 'He did not step in: the bot\'s bracket closed it.',
  ].join('\n');
}
