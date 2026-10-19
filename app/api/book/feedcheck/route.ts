import { NextResponse } from 'next/server';
import { getSheetsClient } from '@/lib/sheetsApi';
import { ownerGuard } from '@/lib/live/guard';
import { istDateKey, istTime } from '@/lib/live/time';
import { ClaudeError, plainClaude } from '@/lib/copilot/claude';
import { appendChat, chatsToday } from '@/lib/copilot/store';
import { settings } from '@/lib/copilot/settings';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * The rules Claude works under for "Check feed". The point: nothing goes to Dhan as "missing" unless Dhan's own
 * documentation promises it. Facts were computed in code from the raw packets; Claude only interprets them.
 */
const SYSTEM = `You audit the market data one stock received from Dhan's DhanHQ v2 WebSocket APIs, for a trader who may forward your findings to Dhan support. Being wrong about what Dhan promises would embarrass him, so stay strictly within the documentation below and the numbers given.

WHAT DHAN DOCUMENTS (DhanHQ v2, Live Market Feed and Full Market Depth):
- 20-level depth (wss://depth-api-feed.dhan.co/twentydepth, RequestCode 23): data is "streamed real-time via websockets". Bid (code 41) and ask (code 51) arrive as SEPARATE packets of 20 entries each (price, quantity, number of orders); several packets can be stacked in one message. Up to 50 instruments per connection. Only NSE equity and derivatives. Header bytes 9-12 are a sequence number "to be ignored".
- NOT documented for depth: how often updates are sent, whether they are sent only on change, any throttling or sampling. So you may NOT say depth updates are "too few" as a violation; you may say they look sparse for an actively traded stock and that this is a question for Dhan.
- Live Market Feed (wss://api-feed.dhan.co, RequestCode 17 = Quote): quote packets (code 4) carry LTP, LTQ, LTT (last trade time), ATP, cumulative day volume, total buy / sell quantity, open, close, high, low. Real-time streaming; update frequency not documented. Day volume is CUMULATIVE, so a jump between two quotes means trades were combined into one update, not that data was lost.
- Server pings every 10 s; a client that does not answer for 40 s is disconnected. A disconnect is announced with a code-50 packet and a reason code (805 = more than 5 connections, the oldest is dropped; 806 data plan not active; 807 token expired; 808 invalid client id; 809 authentication failed). A close with code 1006 has no packet and no reason.

WHAT YOU GET: facts the app computed in code from the raw packets of one stock, a 10-second timeline, and the app's connection events. You do not see the raw bytes.

HOW TO ANSWER (plain text, no tables, under 220 words):
1. One line: is data missing, and from which feed (order book / trades), or does the feed look fine?
2. Findings, each tagged:
   [CONTRADICTS DOCS] only for things the docs above promise and the data shows otherwise (e.g. subscribed but zero packets while the stock trades; trades printed well outside a book that keeps arriving; a disconnect).
   [ASK DHAN] behaviour the docs do not cover but that looks wrong for a live stock (e.g. very sparse depth, identical duplicate packets, long gaps).
   [OUR SIDE] anything pointing at the app or connection (not subscribed, the app restarting connections, both feeds silent together).
   Each finding: the times (IST) and the numbers that prove it.
3. If nothing is wrong, say so plainly. Never call something missing that the API does not provide. Never guess numbers that are not given.`;

/** POST { symbol, report } (report = reportForClaude text). One Claude call per click, logged in the chat tab. */
export async function POST(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return NextResponse.json({ error: 'NO_API_KEY', message: 'ANTHROPIC_API_KEY is not set in Vercel.' }, { status: 503 });
  const b = await req.json().catch(() => ({}));
  const symbol = String(b?.symbol ?? '').trim().toUpperCase();
  const report = String(b?.report ?? '').slice(0, 20_000);
  if (!/^[A-Z0-9&-]{1,30}$/.test(symbol) || !report) return NextResponse.json({ error: 'BAD_REQUEST', message: 'Missing symbol or report.' }, { status: 400 });
  const s = settings();
  const sheets = getSheetsClient();
  const date = istDateKey(Date.now());
  if (await chatsToday(sheets, date) >= s.chatLimit) return NextResponse.json({ error: 'DAILY_LIMIT', message: `Daily limit of ${s.chatLimit} questions reached.` }, { status: 429 });
  try {
    const r = await plainClaude(SYSTEM, report, { apiKey, model: s.model, usdInr: s.usdInr });
    await appendChat(sheets, date, { Date: date, Time: istTime(Date.now()), CreatedAt: Date.now(), CheckId: 'FEED-CHECK', Symbol: symbol, Mode: 'FEED', DataTime: istTime(Date.now()), Question: 'Check feed (last 5 min)', Answer: r.text.slice(0, 4000), Model: r.model, InTokens: r.inTokens, OutTokens: r.outTokens, CostInr: r.costInr, LatencyMs: r.latencyMs, Error: '' }).catch(() => {});
    return NextResponse.json({ text: r.text, costInr: r.costInr });
  } catch (e) {
    if (e instanceof ClaudeError) return NextResponse.json({ error: 'CLAUDE_ERROR', message: e.message }, { status: e.status >= 400 && e.status < 600 ? e.status : 502 });
    return NextResponse.json({ error: 'ERROR', message: (e as Error).message }, { status: 500 });
  }
}
