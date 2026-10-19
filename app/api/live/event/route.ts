import { NextResponse } from 'next/server';
import { getSheetsClient } from '@/lib/sheetsApi';
import { ingestSnaps } from '@/lib/live/sync';
import { snapsFromPayload } from '@/lib/live/orders';
import { errorResponse, ownerGuard } from '@/lib/live/guard';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** Receives order updates the browser got from Dhan's order WebSocket and records any change (stop moved, target added ...). */
export async function POST(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const body = await req.json();
    const items: unknown[] = Array.isArray(body?.messages) ? body.messages.slice(0, 50) : [];
    const snaps = items.flatMap((m) => snapsFromPayload(m));
    // field NAMES of the first frame (never the values): shown on the Live page so a feed format change is visible
    const sample = items[0] as { Data?: unknown } | undefined;
    const d = sample && typeof sample === 'object' && sample.Data && typeof sample.Data === 'object' ? sample.Data : sample;
    const frameKeys = d && typeof d === 'object' ? Object.keys(d as object).slice(0, 60) : [];
    if (!snaps.length) return NextResponse.json({ events: 0, frameKeys });
    const { events } = await ingestSnaps({ sheets: getSheetsClient() }, snaps, 'WS');
    return NextResponse.json({ events: events.length, frameKeys });
  } catch (e) {
    return errorResponse(e);
  }
}
