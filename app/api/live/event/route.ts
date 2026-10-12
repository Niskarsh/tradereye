import { NextResponse } from 'next/server';
import { getSheetsClient } from '@/lib/sheetsApi';
import { ingestSnaps } from '@/lib/live/sync';
import { snapsFromPayload } from '@/lib/live/orders';
import { errorResponse, guard } from '@/lib/live/guard';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** Receives order updates the browser got from Dhan's order WebSocket and records any change (stop moved, target added ...). */
export async function POST(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.res;
  try {
    const body = await req.json();
    const items: unknown[] = Array.isArray(body?.messages) ? body.messages.slice(0, 50) : [];
    const snaps = items.flatMap((m) => snapsFromPayload(m));
    if (!snaps.length) return NextResponse.json({ events: 0 });
    const { events } = await ingestSnaps({ sheets: getSheetsClient() }, snaps, 'WS');
    return NextResponse.json({ events: events.length });
  } catch (e) {
    return errorResponse(e);
  }
}
