import { NextResponse } from 'next/server';
import { errorResponse, ownerGuard } from '@/lib/live/guard';
import { getSheetsClient } from '@/lib/sheetsApi';
import { liveStore } from '@/lib/algoLive/store';
import { liveFills } from '@/lib/algoLive/fills';
import { istDateKey } from '@/lib/live/time';

export const dynamic = 'force-dynamic';

/** GET -> Algo Live's fills since it started, next to what the backtest assumed (read only; see lib/algoLive/fills.ts) */
export async function GET(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    return NextResponse.json(await liveFills(liveStore, getSheetsClient(), istDateKey(Date.now())));
  } catch (e) {
    return errorResponse(e);
  }
}
