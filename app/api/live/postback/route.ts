import { NextResponse } from 'next/server';
import { getSheetsClient } from '@/lib/sheetsApi';
import { ingestSnaps } from '@/lib/live/sync';
import { snapsFromPayload } from '@/lib/live/orders';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Optional Dhan Postback (webhook) target: https://<your-app>/api/live/postback?s=<POSTBACK_SECRET>
 * Dhan calls it on every order status change, so stop/target edits are captured even if the browser tab is closed.
 * Disabled unless POSTBACK_SECRET is set.
 */
export async function POST(req: Request) {
  const secret = process.env.POSTBACK_SECRET;
  if (!secret) return NextResponse.json({ error: 'POSTBACK_DISABLED' }, { status: 503 });
  if (new URL(req.url).searchParams.get('s') !== secret) return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
  try {
    const snaps = snapsFromPayload(await req.json());
    if (!snaps.length) return NextResponse.json({ ok: true, events: 0 });
    const { events } = await ingestSnaps({ sheets: getSheetsClient() }, snaps, 'POSTBACK');
    return NextResponse.json({ ok: true, events: events.length });
  } catch (e) {
    // Always answer 200-class for malformed bodies so Dhan does not keep retrying; real faults are 500.
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
