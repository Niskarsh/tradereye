import { NextResponse } from 'next/server';
import { lookupSecurityId } from '@/lib/dhan';
import { errorResponse, ownerGuard } from '@/lib/live/guard';
import { getChunk, putChunk } from '@/lib/book/s3';
import { getSheetsClient } from '@/lib/sheetsApi';
import { dayIsOver } from '@/lib/candles/store';
import { liveStore } from '@/lib/algoLive/store';
import { meVsAlgo } from '@/lib/algoLive/meVsAlgo';
import { istDateKey } from '@/lib/live/time';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** GET -> every Algo Live trade: what it proposed, what he did, what the untouched bracket did (read only) */
export async function GET(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const now = Date.now();
    return NextResponse.json(await meVsAlgo(liveStore, getSheetsClient(), istDateKey(now),
      { store: { get: getChunk, put: putChunk }, dhan: g.dhan, lookupSecurityId: (s) => lookupSecurityId(s) }, (d) => dayIsOver(d, now)));
  } catch (e) {
    return errorResponse(e);
  }
}
