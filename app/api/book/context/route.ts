import { NextResponse } from 'next/server';
import { getSheetsClient } from '@/lib/sheetsApi';
import { lookupSecurityId } from '@/lib/dhan';
import { errorResponse, guard } from '@/lib/live/guard';
import { dayContext } from '@/lib/book/context';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** POST { symbol, securityId? } -> the day's context for the day-extreme reversal alert (no Claude). */
export async function POST(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.res;
  try {
    const b = await req.json().catch(() => ({}));
    const symbol = String(b?.symbol ?? '').trim().toUpperCase();
    const securityId = /^\d{1,10}$/.test(String(b?.securityId ?? '')) ? String(b.securityId) : undefined;
    if (!/^[A-Z0-9&-]{1,30}$/.test(symbol)) return NextResponse.json({ error: 'BAD_REQUEST', message: 'Missing symbol.' }, { status: 400 });
    return NextResponse.json(await dayContext({ dhan: g.dhan, sheets: getSheetsClient(), lookupSecurityId: (x) => lookupSecurityId(x) }, symbol, securityId));
  } catch (e) {
    if (e instanceof Error && /not in Dhan/.test(e.message)) return NextResponse.json({ error: 'NOT_FOUND', message: e.message }, { status: 404 });
    return errorResponse(e);
  }
}
