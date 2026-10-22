import { NextResponse } from 'next/server';
import { errorResponse, guard } from '@/lib/live/guard';
import { istNow, loadState, note, reconcile, saveState } from '@/lib/algoLive/engine';
import { scaler, ScalerError } from '@/lib/algoLive/scaler';
import { liveStore } from '@/lib/algoLive/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 90;

/** { action: 'ping' | 'status' | 'squareoff' }: trading-scaler's view of Dhan, or close every bot position now */
export async function POST(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.res;
  const { action } = (await req.json().catch(() => ({}))) as { action?: string };
  try {
    if (action === 'ping') return NextResponse.json(await scaler.ping(g.token));
    if (action === 'status' || action === 'squareoff') {
      const s = await loadState(liveStore, istNow().date);
      let done: { done: string[]; errors: string[] } | undefined;
      if (action === 'squareoff') { done = await scaler.squareOff(g.token); note(s, `square-off: ${done.done.join(', ') || 'nothing open'}${done.errors.length ? ` · errors: ${done.errors.join('; ')}` : ''}`); }
      const st = await scaler.status(g.token);
      reconcile(s, st);
      await saveState(liveStore, s);
      return NextResponse.json({ status: st, orders: s.orders, squareOff: done });
    }
    return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400 });
  } catch (e) {
    if (e instanceof ScalerError) return NextResponse.json({ error: 'SCALER', message: e.message }, { status: 502 });
    return errorResponse(e);
  }
}
