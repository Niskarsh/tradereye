import { NextResponse } from 'next/server';
import { ownerRequired } from '@/lib/auth/owner';
import { listKeys } from '@/lib/book/s3';
import { liveStore } from '@/lib/algoLive/store';
import { algoView } from '@/lib/chart/algo';
import { istNow } from '@/lib/algoLive/engine';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * GET ?symbol=HDFIRE&date=2026-11-12&slot=20 -> Algo Live's view of that stock that day (lib/chart/algo.ts).
 * Read only, S3 only (no Dhan request): safe to call while Algo Live is trading.
 */
export async function GET(req: Request) {
  const denied = ownerRequired(req);
  if (denied) return denied;
  const u = new URL(req.url);
  const symbol = (u.searchParams.get('symbol') ?? '').trim().toUpperCase();
  const date = u.searchParams.get('date') || istNow().date;
  const slotRaw = u.searchParams.get('slot');
  const slot = slotRaw !== null && /^\d{1,3}$/.test(slotRaw) ? Number(slotRaw) : undefined;
  if (!/^[A-Z0-9&-]{1,30}$/.test(symbol) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: 'BAD_REQUEST', message: 'Need a symbol and a date.' }, { status: 400 });
  try {
    return NextResponse.json(await algoView({ store: liveStore, listKeys }, date, symbol, slot));
  } catch (e) {
    return NextResponse.json({ error: 'SERVER_ERROR', message: (e as Error).message }, { status: 500 });
  }
}
