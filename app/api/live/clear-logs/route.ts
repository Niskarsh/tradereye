import { NextResponse } from 'next/server';
import { getSheetsClient } from '@/lib/sheetsApi';
import { clearLogs } from '@/lib/live/repair';
import { errorResponse, guard } from '@/lib/live/guard';

export const dynamic = 'force-dynamic';

/** Empties order-state, order-events and live-trades. Monthly trade sheets are not touched. */
export async function POST(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.res;
  try {
    return NextResponse.json({ cleared: await clearLogs(getSheetsClient()) });
  } catch (e) {
    return errorResponse(e);
  }
}
