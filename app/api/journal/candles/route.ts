import { NextResponse } from 'next/server';
import { lookupSecurityId } from '@/lib/dhan';
import { errorResponse, ownerGuard } from '@/lib/live/guard';
import { getChunk, putChunk } from '@/lib/book/s3';
import { NeedsDhanError, loadTradeCandles } from '@/lib/candles/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const PARTS = ['minute', 'nifty', 'daily'] as const;

/**
 * POST { symbol, date, securityId?, parts? } -> the candles behind one journal trade: about 4 weeks of 1-minute
 * candles, the week's Nifty 500, about 2 years of daily candles. Read from S3 when saved; anything missing comes from
 * Dhan once (Data API plan, when a Dhan token is sent) and is saved for next time. Without a token only saved candles
 * are used; if the trade's own day is not saved yet the answer is NEEDS_DHAN.
 */
export async function POST(req: Request) {
  // saved candles need only the Google sign-in; Dhan is used only for days not saved yet
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const b = await req.json().catch(() => ({}));
    const symbol = String(b?.symbol ?? '').trim().toUpperCase();
    const date = String(b?.date ?? '');
    const securityId = /^\d{1,10}$/.test(String(b?.securityId ?? '')) ? String(b.securityId) : undefined;
    const parts = Array.isArray(b?.parts) ? (b.parts as string[]).filter((p): p is typeof PARTS[number] => (PARTS as readonly string[]).includes(p)) : undefined;
    if (!/^[A-Z0-9&-]{1,30}$/.test(symbol) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: 'BAD_REQUEST', message: 'Missing symbol or date.' }, { status: 400 });
    }
    const out = await loadTradeCandles({
      store: { get: getChunk, put: putChunk },
      dhan: g.dhan,
      lookupSecurityId: (s) => lookupSecurityId(s),
    }, { symbol, date, securityId, parts: parts?.length ? parts : undefined });
    return NextResponse.json(out);
  } catch (e) {
    if (e instanceof NeedsDhanError) return NextResponse.json({ error: 'NEEDS_DHAN', message: e.message }, { status: 409 });
    if (e instanceof Error && /not in Dhan/.test(e.message)) return NextResponse.json({ error: 'NOT_FOUND', message: e.message }, { status: 404 });
    return errorResponse(e);
  }
}
