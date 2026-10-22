import { NextResponse } from 'next/server';
import { ownerGuard } from '@/lib/live/guard';
import { istNow, loadSettings, loadState, note, RISK_MAX, RISK_MIN, saveSettings, saveState } from '@/lib/algoLive/engine';
import { liveStore } from '@/lib/algoLive/store';

export const dynamic = 'force-dynamic';

/** { veto: symbol, on: boolean }, { armed: boolean } or { riskInr: number } (kept from day to day) */
export async function POST(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  const b = (await req.json().catch(() => ({}))) as { veto?: string; on?: boolean; armed?: boolean; riskInr?: number };
  const s = await loadState(liveStore, istNow().date);
  let settings = await loadSettings(liveStore);
  if (b.riskInr !== undefined) {
    const r = Math.round(Number(b.riskInr));
    if (!(r >= RISK_MIN && r <= RISK_MAX)) return NextResponse.json({ error: 'BAD_RISK', message: `Risk must be ₹${RISK_MIN}–₹${RISK_MAX} a trade.` }, { status: 400 });
    settings = { ...settings, riskInr: r };
    await saveSettings(liveStore, settings);
    note(s, `risk set to ₹${r} a trade (from the next order)`);
  }
  if (typeof b.veto === 'string' && b.veto) {
    const v = new Set(s.vetoes);
    if (b.on) v.add(b.veto); else v.delete(b.veto);
    s.vetoes = [...v].sort();
    note(s, `${b.on ? 'vetoed' : 'un-vetoed'} ${b.veto}`);
  }
  if (typeof b.armed === 'boolean') { s.armed = b.armed; note(s, b.armed ? 'ARMED: picks are sent to Dhan' : 'disarmed: picks are only shown'); }
  await saveState(liveStore, s);
  return NextResponse.json({ vetoes: s.vetoes, armed: s.armed, riskInr: settings.riskInr });
}
