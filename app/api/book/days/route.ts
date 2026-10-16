import { NextResponse } from 'next/server';
import { getSheetsClient } from '@/lib/sheetsApi';
import { errorResponse, guard } from '@/lib/live/guard';
import { istDateKey } from '@/lib/live/time';
import { recordedDays } from '@/lib/book/sheet';

export const dynamic = 'force-dynamic';

/** GET ?symbol=TARIL -> { days: [{ date, from, to }] } recorded in this month or last (from the "<month>-book" index). */
export async function GET(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.res;
  const symbol = (new URL(req.url).searchParams.get('symbol') ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9&-]{1,30}$/.test(symbol)) return NextResponse.json({ days: [] });
  try { return NextResponse.json({ days: await recordedDays(getSheetsClient(), symbol, istDateKey(Date.now())) }); }
  catch (e) { return errorResponse(e); }
}
