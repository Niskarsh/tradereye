import { NextResponse } from 'next/server';
import { getSheetsClient } from '@/lib/sheetsApi';
import { repairFromLogs } from '@/lib/live/repair';
import { errorResponse, guard } from '@/lib/live/guard';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Fills blank stop / risk / target / exit-type cells of logged trades from the order-state log. */
export async function POST(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.res;
  try {
    return NextResponse.json(await repairFromLogs(getSheetsClient()));
  } catch (e) {
    return errorResponse(e);
  }
}
