import { NextResponse } from 'next/server';
import { getSheetsClient } from '@/lib/sheetsApi';
import { planBackfill } from '@/lib/live/backfill';
import { errorResponse, ownerGuard } from '@/lib/live/guard';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Lists the trades in your monthly sheets that still need market data. Read-only. */
export async function POST(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const body = await req.json().catch(() => ({}));
    return NextResponse.json(await planBackfill(getSheetsClient(), { redo: !!body?.redo }));
  } catch (e) {
    return errorResponse(e);
  }
}
