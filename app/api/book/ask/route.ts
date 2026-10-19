import { NextResponse } from 'next/server';
import { getSheetsClient } from '@/lib/sheetsApi';
import { lookupSecurityId } from '@/lib/dhan';
import { errorResponse, ownerGuard, dhanTokenRequired } from '@/lib/live/guard';
import { istDateKey, istTime } from '@/lib/live/time';
import { buildCheck } from '@/lib/copilot/service';
import { chatClaude, ClaudeError } from '@/lib/copilot/claude';
import { appendChat, chatsToday } from '@/lib/copilot/store';
import { settings } from '@/lib/copilot/settings';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * "Ask" on a wall in the Order Book tab. Body { symbol, question, book, direction?, setup? }. Claude gets the same market facts the
 * co-pilot uses for that stock (10-min candles, Nifty, VWAP, levels; read both ways, he has not picked a side) plus
 * the live order-book summary from his screen. Short answer, logged in the monthly chat tab. Nothing is stored in
 * the checks tab.
 */
export async function POST(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return NextResponse.json({ error: 'NO_API_KEY', message: 'ANTHROPIC_API_KEY is not set in Vercel.' }, { status: 503 });
  try {
    const b = await req.json().catch(() => ({}));
    const symbol = String(b?.symbol ?? '').trim().toUpperCase();
    const question = String(b?.question ?? '').trim().slice(0, 1500);
    const book = String(b?.book ?? '').slice(0, 4000);
    const pastDay = typeof b?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.date) && b.date !== istDateKey(Date.now()) ? b.date : '';
    if (!/^[A-Z0-9&-]{1,30}$/.test(symbol) || !question) return NextResponse.json({ error: 'BAD_REQUEST', message: 'Missing symbol or question.' }, { status: 400 });
    const s = settings();
    const sheets = getSheetsClient();
    const date = istDateKey(Date.now());
    if (await chatsToday(sheets, date) >= s.chatLimit) return NextResponse.json({ error: 'DAILY_LIMIT', message: `Daily limit of ${s.chatLimit} questions reached.` }, { status: 429 });
    if (pastDay) {
      // studying a recorded day: only the book from that day (today's market facts would mislead)
      const context = `ORDER BOOK REVIEW of ${symbol} on ${pastDay} (a recorded day, not live). He is studying what happened; explain what the book shows and what it implied, without today's market data.\n${book || 'ORDER_BOOK not available.'}`;
      const r = await chatClaude(context, [{ role: 'user', content: question }], { apiKey, model: s.model, usdInr: s.usdInr, thinking: s.thinking });
      await appendChat(sheets, date, { Date: date, Time: istTime(Date.now()), CreatedAt: Date.now(), CheckId: `ORDER-BOOK ${pastDay}`, Symbol: symbol, Mode: 'REVIEW', DataTime: pastDay, Question: question, Answer: r.text.slice(0, 4000), Model: r.model, InTokens: r.inTokens, OutTokens: r.outTokens, CostInr: r.costInr, LatencyMs: r.latencyMs, Error: '' }).catch(() => {});
      return NextResponse.json({ text: r.text, costInr: r.costInr, latencyMs: r.latencyMs });
    }
    // today's question uses the live market facts: that part needs Dhan
    if (!g.dhan) return dhanTokenRequired("A question about today's book");
    // a reversal alert's "Should I take this?" names the trade; a plain wall question reads the stock both ways
    const dir = b?.direction === 'LONG' || b?.direction === 'SHORT' ? b.direction as 'LONG' | 'SHORT' : undefined;
    const setup = dir && (b?.setup === 'REVERSAL' || b?.setup === 'MOMENTUM') ? b.setup as 'REVERSAL' | 'MOMENTUM' : 'MOMENTUM';
    const check = await buildCheck({ dhan: g.dhan, sheets, clientId: g.clientId, lookupSecurityId: (x) => lookupSecurityId(x) }, { direction: dir ?? 'LONG', setup, symbol, manage: true });
    const context = [
      dir
        ? `ORDER BOOK ALERT about ${symbol}: he is considering a ${setup} ${dir} right now, from the alert below. Judge THAT trade: take / wait / skip, 2-3 reasons, and the one thing that would prove it wrong. If IN_TRADE is present he already holds it.`
        : `ORDER BOOK QUESTION about ${symbol}. He has NOT picked a direction or setup: the "LONG · MOMENTUM" in the header below is only a placeholder, read the stock both ways. If IN_TRADE is present he holds it, in that direction.`,
      `DATA fetched at ${check.time} IST`, check.payload,
      book ? `${book}\n(order book live from his screen as of ${istTime(Date.now())} IST)` : 'ORDER_BOOK not available.',
    ].join('\n');
    try {
      const r = await chatClaude(context, [{ role: 'user', content: question }], { apiKey, model: s.model, usdInr: s.usdInr, thinking: s.thinking });
      await appendChat(sheets, date, { Date: date, Time: istTime(Date.now()), CreatedAt: Date.now(), CheckId: 'ORDER-BOOK', Symbol: symbol, Mode: check.mode, DataTime: check.time, Question: question, Answer: r.text.slice(0, 4000), Model: r.model, InTokens: r.inTokens, OutTokens: r.outTokens, CostInr: r.costInr, LatencyMs: r.latencyMs, Error: '' }).catch(() => {});
      return NextResponse.json({ text: r.text, costInr: r.costInr, latencyMs: r.latencyMs });
    } catch (e) {
      if (e instanceof ClaudeError) return NextResponse.json({ error: 'CLAUDE_ERROR', message: e.message }, { status: e.status >= 400 && e.status < 600 ? e.status : 502 });
      throw e;
    }
  } catch (e) {
    if (e instanceof Error && /not in Dhan|No price/.test(e.message)) return NextResponse.json({ error: 'NOT_FOUND', message: e.message }, { status: 404 });
    return errorResponse(e);
  }
}
