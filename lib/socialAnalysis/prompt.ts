import { findings, groupsOf, matureCount, MIN_PER_SIDE, viewsToJudge, type Group, type Row } from './analyze';

/** What Claude is told and what it answers for the Analysis read (pure); read.ts makes the call and keeps the reads. */

export interface NextTest { change: string; keep_same: string; posts: number; judge_by: string }
export interface Read { call: string; confidence: 'low' | 'medium' | 'high'; why: string[]; keep: string[]; stop: string[]; next_test: NextTest }
export interface SavedRead extends Read { at: number; model: string; costInr: number; mature: { youtube: number; instagram: number } }

export const READ_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['call', 'confidence', 'why', 'keep', 'stop', 'next_test'],
  properties: {
    call: { type: 'string' }, confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    why: { type: 'array', items: { type: 'string' } }, keep: { type: 'array', items: { type: 'string' } }, stop: { type: 'array', items: { type: 'string' } },
    next_test: {
      type: 'object', additionalProperties: false, required: ['change', 'keep_same', 'posts', 'judge_by'],
      properties: { change: { type: 'string' }, keep_same: { type: 'string' }, posts: { type: 'integer' }, judge_by: { type: 'string' } },
    },
  },
} as const;

export const SYSTEM = `You are the growth analyst for "Candles Before Cubicles": YouTube Shorts and Instagram Reels rendered by code from one
person's real NSE day trades. Goal: more subscribers and followers. You decide what the next batch of shorts should change.

What can actually be changed: the format (Mystery chart / Me vs Algo), the opening hook line, how long the hook holds before the chart
moves, the pacing, the share of winning and losing trades, the title and caption style, the "tell" text, the length, and the posting day and time.
What cannot change: the shorts are real trades only, never AI footage; losing trades stay in for honesty; no investment advice; the
Mystery ticker stays hidden until the reveal.

How to reason:
- Only numbers given here. Never invent one.
- Few posts means noise. One or two posts prove nothing: say so. A group below ${MIN_PER_SIDE} posts is a hint at most, and confidence is "low".
  "Comparisons the numbers support" lists only gaps the code found large enough. If it is empty, do not claim one format beats another.
- Retention is the strongest signal: "still watching at 3s" judges the hook, the steepest fall shows which beat loses people (match it
  to the seconds given and the format's structure). A value over 100% means rewatching. On Instagram a high skip rate means the first 3 seconds failed.
- subscribers per 1000 views on a single Short undercounts (YouTube credits only subscribes on that video's own page): compare it between posts, never read it as the true total.
- Views depend on what the platform chose to show, retention and shares on the video. Prefer the second kind when they disagree.
- Exactly one change in next_test, so the result can be read. keep_same names what must not change meanwhile. posts: 3 to 6.
  judge_by: one metric and the value to beat, taken from the numbers given.

Plain words, as to a trader who is not a marketer. call: one sentence, the decision. why, keep, stop: at most 3 short lines each (empty when
nothing qualifies). No hedging beyond the confidence field.`;

const f1 = (x: number | undefined, suffix = '') => (x === undefined ? 'n/a' : `${Math.round(x * 10) / 10}${suffix}`);
const pct = (x: number | undefined) => (x === undefined ? 'n/a' : `${Math.round(x * 100)}%`);

function groupLine(g: Group): string {
  const y = g.youtube, i = g.instagram;
  return `${g.label} | YouTube (${y.n} posts): views ${f1(y.views)}, avg watched ${f1(y.avgPct, '%')}, at 3s ${pct(y.at3s)}, subs per 1000 ${f1(y.subsPer1k)} | Instagram (${i.n} posts): views ${f1(i.views)}, avg watch ${f1(i.avgWatchSec, 's')}, skip ${f1(i.skipPct, '%')}, shares+saves per 1000 reached ${f1(i.sharesSavesPer1k)}`;
}

function rowLine(r: Row): string {
  const y = r.youtube, i = r.instagram, f = r.facts;
  const parts = [`${f.kind === 'mystery' ? 'Mystery' : 'Me vs Algo'} (${f.outcome}${f.resultR !== undefined ? `, ${f.resultR}R` : ''})`, `title: "${f.title ?? ''}"`];
  if (f.tell) parts.push(`tell: "${f.tell}"`);
  if (f.captionHook) parts.push(`caption opens: "${f.captionHook}"`);
  if (y) {
    const posted = new Date(y.at + 19_800_000).toISOString().slice(0, 16).replace('T', ' ');
    parts.push(`YouTube ${posted} IST${y.mature ? '' : ' (under 7 days old)'}: ${y.durationSec ?? '?'}s long, views ${f1(viewsToJudge(y))}, avg watched ${f1(y.avgPct, '%')}, at 3s ${pct(y.retention?.at3s)}, at end ${pct(y.retention?.atEnd)}, steepest fall at ${y.retention?.steepestAtSec ?? '?'}s, likes ${f1(y.likes)}, comments ${f1(y.comments)}, shares ${f1(y.shares)}, net subs ${f1(y.subs)}`);
  }
  if (i) parts.push(`Instagram${i.mature ? '' : ' (under 7 days old)'}: views ${f1(viewsToJudge(i))}, reach ${f1(i.reach)}, avg watch ${f1(i.avgWatchSec, 's')}, skip ${f1(i.skipPct, '%')}, likes ${f1(i.likes)}, comments ${f1(i.comments)}, shares ${f1(i.shares)}, saves ${f1(i.saved)}`);
  return parts.join('; ');
}

export function readMessage(rows: Row[], previous?: SavedRead): string {
  const groups = groupsOf(rows), found = findings(groups), m = matureCount(rows);
  return [
    `Posts at least 7 days old: YouTube ${m.youtube}, Instagram ${m.instagram}. Views are at day 7 where available; group figures are medians of those posts only.`,
    '', 'Groups:', ...groups.map(groupLine),
    '', 'Comparisons the numbers support:', ...(found.length ? found.map((x) => `${x.platform}: ${x.better} ahead on ${x.metric} by ${x.gapPct}% (${x.a} vs ${x.b})`) : ['none yet']),
    '', 'Each post:', ...rows.map(rowLine),
    ...(previous ? ['', `The last read (${new Date(previous.at).toISOString().slice(0, 10)}) said: ${previous.call} Test it set: ${previous.next_test.change}, judged by ${previous.next_test.judge_by}. If later posts answer it, say so.`] : []),
  ].join('\n');
}

export function toRead(j: Record<string, unknown>): Read {
  const lines = (x: unknown) => (Array.isArray(x) ? x.map(String).filter(Boolean).slice(0, 3) : []);
  const t = (j.next_test ?? {}) as Record<string, unknown>;
  const c = j.confidence;
  return {
    call: String(j.call ?? ''), confidence: c === 'high' || c === 'medium' ? c : 'low', why: lines(j.why), keep: lines(j.keep), stop: lines(j.stop),
    next_test: { change: String(t.change ?? ''), keep_same: String(t.keep_same ?? ''), posts: Number(t.posts) || 3, judge_by: String(t.judge_by ?? '') },
  };
}
