import { NextResponse } from 'next/server';
import { getSheetsClient } from '@/lib/sheetsApi';
import { errorResponse, guard } from '@/lib/live/guard';
import { chatClaude, ClaudeError, type ChatTurn } from '@/lib/copilot/claude';
import { appendChat, chatsToday, readChecks, recall } from '@/lib/copilot/store';
import { settings } from '@/lib/copilot/settings';
import { istTime } from '@/lib/live/time';

export const dynamic = 'force-dynamic';
export const maxDuration = 40;

const MAX_TURNS = 24;

/**
 * Chat with Claude about the stock / trade on screen. Body: { checkId, date, turns: [{role, content}], lastRead? }.
 * The facts come from the check (the latest one the app fetched: tap "Latest Dhan data" in the chat for a new one).
 */
export async function POST(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.res;
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return NextResponse.json({ error: 'NO_API_KEY', message: 'ANTHROPIC_API_KEY is not set in Vercel.' }, { status: 503 });
  try {
    const b = await req.json().catch(() => ({}));
    const checkId = String(b?.checkId ?? ''), date = String(b?.date ?? '');
    const turns: ChatTurn[] = (Array.isArray(b?.turns) ? b.turns : [])
      .filter((t: ChatTurn) => (t?.role === 'user' || t?.role === 'assistant') && typeof t.content === 'string' && t.content.trim())
      .map((t: ChatTurn) => ({ role: t.role, content: t.content.slice(0, 4000) }))
      .slice(-MAX_TURNS);
    while (turns.length && turns[0].role !== 'user') turns.shift();
    if (!checkId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !turns.length || turns.at(-1)!.role !== 'user') {
      return NextResponse.json({ error: 'BAD_REQUEST', message: 'Type a question first.' }, { status: 400 });
    }
    const s = settings();
    const sheets = getSheetsClient();
    if (await chatsToday(sheets, date) >= s.chatLimit) {
      return NextResponse.json({ error: 'DAILY_LIMIT', message: `Daily limit of ${s.chatLimit} chat questions reached.` }, { status: 429 });
    }
    let payload = recall(checkId)?.payload;
    let o: Record<string, string> | undefined;
    if (!payload) {
      const { rows } = await readChecks(sheets, date);
      o = rows.find((r) => r.o.CheckId === checkId)?.o;
      payload = o?.PayloadJson;
    }
    const cached = recall(checkId)?.row;
    const symbol = String(cached?.Symbol ?? o?.Symbol ?? ''), mode = String(cached?.Mode ?? o?.Mode ?? '');
    const dataTime = String(cached?.Time ?? o?.Time ?? '');
    if (!payload) return NextResponse.json({ error: 'NO_PAYLOAD', message: 'Tap "Latest Dhan data" to load the stock again.' }, { status: 409 });

    const nowIst = { time: istTime(Date.now()) };
    const lastRead = typeof b?.lastRead === 'string' && b.lastRead.trim() ? `\n\nEARLIER ONE-BUTTON READ (on this or older data)\n${b.lastRead.slice(0, 1500)}` : '';
    const book = typeof b?.book === 'string' && b.book.trim() ? `\n\n${b.book.slice(0, 4000)}\n(order book as of ${nowIst.time} IST, live from his screen)` : '';
    const context = `DATA fetched at ${dataTime} IST (time now ${nowIst.time} IST)\n${payload}${lastRead}${book}`;
    const question = turns.at(-1)!.content;
    try {
      const r = await chatClaude(context, turns, { apiKey, model: s.model, usdInr: s.usdInr, thinking: s.thinking });
      await appendChat(sheets, date, {
        Date: date, Time: nowIst.time, CreatedAt: Date.now(), CheckId: checkId, Symbol: symbol, Mode: mode, DataTime: dataTime,
        Question: question.slice(0, 2000), Answer: r.text.slice(0, 4000), Model: r.model, InTokens: r.inTokens, OutTokens: r.outTokens,
        CostInr: r.costInr, LatencyMs: r.latencyMs, Error: '',
      }).catch(() => {});
      return NextResponse.json({ ...r, dataTime });
    } catch (e) {
      const msg = (e as Error).message;
      await appendChat(sheets, date, { Date: date, Time: nowIst.time, CreatedAt: Date.now(), CheckId: checkId, Symbol: symbol, Mode: mode, DataTime: dataTime, Question: question.slice(0, 2000), Error: msg.slice(0, 300) }).catch(() => {});
      if (e instanceof ClaudeError) return NextResponse.json({ error: 'CLAUDE_ERROR', message: msg }, { status: e.status >= 400 && e.status < 600 ? e.status : 502 });
      throw e;
    }
  } catch (e) {
    return errorResponse(e);
  }
}
