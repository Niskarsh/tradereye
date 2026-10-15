import { NextResponse } from 'next/server';
import { colLetter, getSheetsClient } from '@/lib/sheetsApi';
import { DhanClient, clientIdFromToken, lookupSecurityId } from '@/lib/dhan';
import { errorResponse, tokenFrom } from '@/lib/live/guard';
import { MONTHLY_ALL } from '@/lib/live/schema';
import { istDateTime } from '@/lib/live/time';
import { ClaudeError, structuredClaude } from '@/lib/copilot/claude';
import { gatherReview, REVIEW_RULES, REVIEW_SCHEMA, reviewCells, toStoredReview } from '@/lib/copilot/review';
import { settings } from '@/lib/copilot/settings';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MONTH_TAB = /^(january|february|march|april|may|june|july|august|september|october|november|december)-\d{4}$/;
const q = (t: string) => `'${t.replace(/'/g, "''")}'`;

/**
 * "Review this trade" (journal): one Claude call per press, stored on the trade's first row so the journal shows it
 * from the sheet afterwards for free. Body: { sheetTitle, tradeGroupId }. The Dhan token is optional: with it the
 * review includes the candles, the market at entry and exit, and what price did after the exit.
 */
export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return NextResponse.json({ error: 'NO_API_KEY', message: 'ANTHROPIC_API_KEY is not set in Vercel.' }, { status: 503 });
  try {
    const b = await req.json().catch(() => ({}));
    const title = String(b?.sheetTitle ?? ''), groupId = String(b?.tradeGroupId ?? '').trim();
    if (!MONTH_TAB.test(title) || !groupId) return NextResponse.json({ error: 'BAD_REQUEST', message: 'Missing trade.' }, { status: 400 });

    const token = tokenFrom(req);
    let dhan: DhanClient | undefined;
    if (token) {
      const allowed = process.env.ALLOWED_DHAN_CLIENT_ID?.trim();
      if (allowed && clientIdFromToken(token) !== allowed) return NextResponse.json({ error: 'FORBIDDEN', message: 'This token belongs to a different Dhan account.' }, { status: 403 });
      dhan = new DhanClient({ token });
    }
    const sheets = getSheetsClient();
    await sheets.ensureTab(title, MONTHLY_ALL); // adds the review columns on older month tabs
    const input = await gatherReview({ sheets, dhan, lookupSecurityId: (s) => lookupSecurityId(s) }, title, groupId);

    const s = settings();
    try {
      const r = await structuredClaude(REVIEW_RULES, input.message, REVIEW_SCHEMA, { apiKey, model: s.model, usdInr: s.usdInr, thinking: s.thinking }, 1500);
      const review = toStoredReview(r.json, r.text, input.exitCall, { at: istDateTime(Date.now()), costInr: r.costInr, model: r.model });
      const cells = reviewCells(review);
      const { headers } = await sheets.ensureTab(title, MONTHLY_ALL);
      await sheets.updateRanges(Object.entries(cells).map(([k, v]) => ({ range: `${q(title)}!${colLetter(headers.indexOf(k))}${input.firstRowNumber}`, values: [[v]] })), true);
      return NextResponse.json({ review, notes: input.notes });
    } catch (e) {
      if (e instanceof ClaudeError) return NextResponse.json({ error: 'CLAUDE_ERROR', message: e.message }, { status: e.status >= 400 && e.status < 600 ? e.status : 502 });
      throw e;
    }
  } catch (e) {
    if (e instanceof Error && /Trade not found|no time/.test(e.message)) return NextResponse.json({ error: 'NOT_FOUND', message: e.message }, { status: 404 });
    return errorResponse(e);
  }
}
