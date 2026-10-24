import { jsonClaude, type ClaudeOptions } from '../copilot/claude';
import type { PanelSpec } from './spec';
import type { ShortTrade, WeekScore } from './trades';

/**
 * Claude writes a short's words in ONE call, when Generate is pressed: the tell drawn into a mystery video (or the
 * two one-line reasons on a Me vs Algo video), plus the YouTube title / description / tags and the Instagram caption.
 * It is given only real facts (the trade, the candles before the entry, his journal comment and context columns) and
 * told not to invent anything. Whatever he typed himself is used instead of Claude's tell / reasons.
 * The mystery's ticker is kept out of every public text (it is the reveal), and that is enforced here too.
 */

export interface SocialText {
  tell?: string;                                   // mystery
  notes?: { me: string; algo: string };            // me vs algo
  youtube: { title: string; description: string; tags: string[] };
  instagram: { caption: string };
}
export interface WrittenText extends SocialText { model: string; costInr: number; at: number }

const SYSTEM = `You write the words for "Candles Before Cubicles": YouTube Shorts and Instagram Reels made from a software
developer's real NSE day trades (his own money, traded live before work). Your job: short, punchy, honest copy that
makes people stop scrolling, comment and follow.

Hard rules:
- Use only the facts given. Never invent prices, times, events, indicators or results that are not in the data.
- No investment advice: no buy/sell calls, no "you should", no promises of returns, no "guaranteed", no "easy money".
- Plain English, Indian retail-trader audience. At most 2 emoji in a caption, none in the title.
- Every description and caption carries one line: "Real trade, real money. Not investment advice."`;

const MYSTERY_CORE = `This is a MYSTERY CHART short: the video replays the chart up to his entry, freezes, asks viewers
"Long, short, or wait?", shows HIS call ("MY CALL: LONG"), plays the trade and finally reveals the stock.
The video shows ONLY the 10-minute candles listed below, so anything you point at must be visible on THOSE candles: e.g.
a higher low, a lower high, a long wick, a close back above or below a level, a tight base. Name the candle by its time
when that helps ("the 09:45 candle held above the 09:35 low"). Never use something only a 1-minute chart would show.
If his journal comment explains the trade, use it only where the 10-minute candles back it up.
- The stock's name and ticker are the reveal: never put them in title, description, tags or caption.
- youtube.tags: 8-15 lowercase tags (no #), general trading terms only.
- notes: leave both empty.`;

const MYSTERY_WIN = `OUTCOME: A WIN.
- tell (shown as "THE TELL"): one sentence, max 80 characters (two short lines on screen): the clue on the 10-minute
  candles BEFORE the entry that the trade was based on.
- youtube.title: max 70 characters, a curiosity hook built around the decision; do not give the answer away.
- youtube.description: 3-5 short lines: the hook, "Answer and the stock revealed at the end.", the not-advice line,
  then 4-6 hashtags on the last line (#shorts first).
- instagram.caption: max 600 characters: hook line, "Long, short or wait? Comment before the reveal 👇", the not-advice
  line, then 6-10 hashtags.`;

const MYSTERY_LOSS = `OUTCOME: A LOSS. Be honest and plain about it: no excuses, no spin, no "it was still a good trade" unless the
facts clearly show a valid setup that simply failed.
- tell (shown as "WHAT I MISSED"): one sentence, max 80 characters (two short lines on screen): the warning sign that
  was visible on the 10-minute candles BEFORE the entry and went against his call (e.g. "The 09:45 candle made a lower
  high: buyers were already fading"). If no such sign is visible on those candles, say so plainly instead of inventing
  one, e.g. "Nothing on the 10-min chart warned. The stop did its job."
- youtube.title: max 70 characters, honest that it is a losing trade, built around the decision (e.g. "I lost on this
  one. Would you have taken it?"); do not reveal the stock.
- youtube.description: 3-5 short lines: the hook, "The stock and what I missed, revealed at the end.", the not-advice
  line, then 4-6 hashtags on the last line (#shorts first).
- instagram.caption: max 600 characters: an honest hook about the loss, "What would you have done? Comment below 👇",
  the not-advice line, then 6-10 hashtags.`;

const VS_TASK = `This is a ME vs ALGO short: one week of his own trades against his trading bot's (Algo Live), each side's
biggest trade replayed, the week's totals in R, and the season score. Tickers are never shown.
- notes.me / notes.algo: max 40 characters each: why that side's trade was taken, from the facts (for the algo, describe
  it mechanically, e.g. "Short on a 10-min breakdown"). Empty string when that side had no trade.
- No stock names or tickers anywhere.
- youtube.title: max 70 characters, the rivalry and the result of the week (who won), no answer-spoiling numbers needed.
- youtube.description: 3-5 short lines: what this series is, this week's result, "New round every Monday.", the
  not-advice line, then 4-6 hashtags (#shorts first).
- youtube.tags: 8-15 lowercase tags (no #).
- instagram.caption: max 600 characters, ending with a question that invites comments, the not-advice line, 6-10 hashtags.
- tell: empty string.`;

export const TEXT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['tell', 'notes', 'youtube', 'instagram'],
  properties: {
    tell: { type: 'string' },
    notes: { type: 'object', additionalProperties: false, required: ['me', 'algo'], properties: { me: { type: 'string' }, algo: { type: 'string' } } },
    youtube: {
      type: 'object', additionalProperties: false, required: ['title', 'description', 'tags'],
      properties: { title: { type: 'string' }, description: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
    },
    instagram: { type: 'object', additionalProperties: false, required: ['caption'], properties: { caption: { type: 'string' } } },
  },
} as const;

const hhmm = (sec: number) => new Date((sec + 19800) * 1000).toISOString().slice(11, 16);

/** The panel's candles as text, grouped into its drawn timeframe: "09:40 o h l c", marking the entry and exit candles. */
export function candleLines(p: PanelSpec): string {
  const tfSec = p.tf * 60, open = 9 * 3600 + 15 * 60;
  const ist = (t: number) => ((t + 19800) % 86400 + 86400) % 86400;
  const slot = (i: number) => Math.floor((ist(p.candles[i][0]) - open) / tfSec);
  const out: string[] = [];
  for (let i = 0; i < p.candles.length;) {
    const s = slot(i); let j = i;
    let [t, o, h, l, c] = p.candles[i];
    while (j + 1 < p.candles.length && slot(j + 1) === s) { j++; h = Math.max(h, p.candles[j][2]); l = Math.min(l, p.candles[j][3]); c = p.candles[j][4]; }
    const tags = [p.entryIdx >= i && p.entryIdx <= j ? 'ENTRY' : '', p.exitIdx >= i && p.exitIdx <= j ? 'EXIT' : ''].filter(Boolean);
    out.push(`${hhmm(t)} ${o} ${h} ${l} ${c}${tags.length ? `  <- ${tags.join(' + ')}` : ''}`);
    i = j + 1;
  }
  return out.join('\n');
}

function tradeFacts(t: ShortTrade, p: PanelSpec, label: string): string {
  const r = p.result.unit === 'R' ? `${p.result.value}R after charges` : `${p.result.value}% price move (no logged risk)`;
  const lines = [
    `${label}: ${t.dir} ${t.symbol} on ${t.date}`,
    `entry ${t.entryTime} at ${t.avgEntry}, exit ${t.exitTime} at ${t.avgExit}, held ${t.holdMin} min, exit type ${t.exitType}`,
    `first stop ${t.stop ?? 'not logged'}, result ${r}`,
    `fills: ${t.fills.map((f) => `${f.kind === 'in' ? 'IN' : 'OUT'} ${f.qty}@${f.price} ${f.time}`).join(', ')}`,
  ];
  if (t.comment) lines.push(`his journal comment: "${t.comment}"`);
  if (t.context && Object.keys(t.context).length) lines.push(`journal context: ${Object.entries(t.context).map(([k, v]) => `${k}=${v}`).join('; ')}`);
  lines.push(`${p.tf}-minute candles (time open high low close):`, candleLines(p));
  return lines.join('\n');
}

/** A loss is any trade whose shown result is below zero (R after charges, or the % move). */
export const isLoss = (p: PanelSpec) => p.result.value < 0;

export function mysteryMessage(t: ShortTrade, p: PanelSpec): string {
  return `${MYSTERY_CORE}\n\n${isLoss(p) ? MYSTERY_LOSS : MYSTERY_WIN}\n\nTHE TRADE (the ticker below is for your understanding only; keep it out of every text)\n${tradeFacts(t, p, 'trade')}`;
}

export function vsMessage(p: { weekNo: number; weekLabel: string; week: WeekScore; after: { me: number; algo: number }; me?: { t: ShortTrade; p: PanelSpec }; algo?: { t: ShortTrade; p: PanelSpec } }): string {
  const side = (k: 'me' | 'algo') => `${k === 'me' ? 'HIS' : 'THE ALGO\'S'} WEEK: ${p.week[k].r}R over ${p.week[k].n} scored trades`;
  return [
    VS_TASK, '',
    `Week ${p.weekNo} of the season (${p.weekLabel}). Winner this week: ${p.week.winner}. Season after this week: me ${p.after.me} - ${p.after.algo} algo.`,
    side('me'), p.me ? tradeFacts(p.me.t, p.me.p, 'his trade of the week') : 'no trade of the week',
    '', side('algo'), p.algo ? tradeFacts(p.algo.t, p.algo.p, 'the algo\'s trade of the week') : 'no trade of the week',
  ].join('\n');
}

const clip = (s: unknown, n: number) => String(s ?? '').replace(/\s+\n/g, '\n').trim().slice(0, n);

/** Keeps the hidden ticker out of the public texts (the mystery's reveal), whatever the model wrote. */
export function scrubTicker(x: SocialText, ticker: string): SocialText {
  if (!ticker) return x;
  const pat = `#?(?<![A-Za-z0-9])${ticker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`;
  const all = new RegExp(pat, 'gi'), one = new RegExp(pat, 'i');
  const clean = (s: string) => s.replace(all, 'this stock').replace(/this stock this stock/gi, 'this stock');
  return {
    ...x,
    youtube: { title: clean(x.youtube.title), description: clean(x.youtube.description), tags: x.youtube.tags.filter((t) => !one.test(t)) },
    instagram: { caption: clean(x.instagram.caption) },
  };
}

/** The model's JSON -> SocialText, every field length-capped. */
export function toSocialText(j: Record<string, unknown>, kind: 'mystery' | 'vs'): SocialText {
  const yt = (j.youtube ?? {}) as Record<string, unknown>, ig = (j.instagram ?? {}) as Record<string, unknown>, n = (j.notes ?? {}) as Record<string, unknown>;
  const tags = Array.isArray(yt.tags) ? yt.tags.map((t) => clip(t, 40).replace(/^#/, '').toLowerCase()).filter(Boolean).slice(0, 15) : [];
  return {
    ...(kind === 'mystery' ? { tell: clip(j.tell, 90) } : { notes: { me: clip(n.me, 40), algo: clip(n.algo, 40) } }),
    youtube: { title: clip(yt.title, 100), description: clip(yt.description, 4500), tags },
    instagram: { caption: clip(ig.caption, 2000) },
  };
}

export function claudeOptions(): ClaudeOptions {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set in Vercel.');
  const usd = Number(process.env.COPILOT_USD_INR);
  return { apiKey, model: process.env.COPILOT_MODEL?.trim() || 'claude-sonnet-5-5', usdInr: Number.isFinite(usd) && usd > 0 ? usd : 88, timeoutMs: 40_000 };
}

export async function writeText(kind: 'mystery' | 'vs', message: string, hiddenTicker = '', o: ClaudeOptions = claudeOptions()): Promise<WrittenText> {
  const r = await jsonClaude(SYSTEM, message, TEXT_SCHEMA, o, 4000);
  if (!Object.keys(r.json).length) throw new Error(r.cutOff ? 'Claude\'s answer was cut short.' : 'Claude returned no usable text.');
  const text = scrubTicker(toSocialText(r.json, kind), hiddenTicker);
  return { ...text, model: r.model, costInr: r.costInr, at: Date.now() };
}
