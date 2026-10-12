import { NextResponse } from 'next/server';
import { getSheetsClient } from '@/lib/sheetsApi';
import { runBackfill } from '@/lib/live/backfill';
import { lookupSecurityId } from '@/lib/dhan';
import { errorResponse, guard } from '@/lib/live/guard';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Enriches a small batch (the page sends a few trades at a time and loops). */
export async function POST(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.res;
  try {
    const body = await req.json();
    const items = (Array.isArray(body?.items) ? body.items : [])
      .filter((i: { tab?: string; groupId?: string }) => i?.tab && i?.groupId).slice(0, 5);
    if (!items.length) return NextResponse.json({ results: [] });
    return NextResponse.json(await runBackfill({ dhan: g.dhan, sheets: getSheetsClient(), lookupSecurityId: (s) => lookupSecurityId(s) }, items));
  } catch (e) {
    return errorResponse(e);
  }
}
