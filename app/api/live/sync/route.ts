import { NextResponse } from 'next/server';
import { getSheetsClient } from '@/lib/sheetsApi';
import { runSync } from '@/lib/live/sync';
import { errorResponse, guard } from '@/lib/live/guard';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** One reconciliation pass: Dhan orders + trades + positions -> sheet. Safe to call as often as you like. */
export async function POST(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.res;
  try {
    const body = await req.json().catch(() => ({}));
    const result = await runSync({ dhan: g.dhan, sheets: getSheetsClient() }, { includeRecent: !!body?.includeRecent });
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
