import { NextResponse } from 'next/server';
import { ownerGuard } from '@/lib/live/guard';
import { istNow, loadState, note, saveState } from '@/lib/algoLive/engine';
import { liveStore } from '@/lib/algoLive/store';

export const dynamic = 'force-dynamic';

/** { veto: symbol, on: boolean } or { armed: boolean } */
export async function POST(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  const b = (await req.json().catch(() => ({}))) as { veto?: string; on?: boolean; armed?: boolean };
  const s = await loadState(liveStore, istNow().date);
  if (typeof b.veto === 'string' && b.veto) {
    const v = new Set(s.vetoes);
    if (b.on) v.add(b.veto); else v.delete(b.veto);
    s.vetoes = [...v].sort();
    note(s, `${b.on ? 'vetoed' : 'un-vetoed'} ${b.veto}`);
  }
  if (typeof b.armed === 'boolean') { s.armed = b.armed; note(s, b.armed ? 'ARMED: picks are sent to Dhan' : 'disarmed: picks are only shown'); }
  await saveState(liveStore, s);
  return NextResponse.json({ vetoes: s.vetoes, armed: s.armed });
}
