import { NextResponse } from 'next/server';
import { ownerGuard } from '@/lib/live/guard';
import { counts, istNow, loadSettings, loadState, note, POSITION_MAX, POSITION_MIN, RISK_MAX, RISK_MIN, saveSettings, saveState } from '@/lib/algoLive/engine';
import { liveStore } from '@/lib/algoLive/store';

export const dynamic = 'force-dynamic';

/**
 * { veto: symbol, on: boolean }, { armed: boolean }, and kept from day to day: { riskInr } (narrow model), { positionInr }
 * (wide model, rupees of stock a trade) and { version: 'narrow' | 'wide' } (which model Algo Live trades). Switching the
 * model disarms the page and is refused once a trade was sent today; the day list must then be made again.
 */
export async function POST(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  const b = (await req.json().catch(() => ({}))) as { veto?: string; on?: boolean; armed?: boolean; riskInr?: number; positionInr?: number; version?: string };
  const s = await loadState(liveStore, istNow().date);
  let settings = await loadSettings(liveStore);
  if (b.riskInr !== undefined) {
    const r = Math.round(Number(b.riskInr));
    if (!(r >= RISK_MIN && r <= RISK_MAX)) return NextResponse.json({ error: 'BAD_RISK', message: `Risk must be ₹${RISK_MIN}–₹${RISK_MAX} a trade.` }, { status: 400 });
    settings = { ...settings, riskInr: r };
    await saveSettings(liveStore, settings);
    note(s, `risk set to ₹${r} a trade (from the next order)`);
  }
  if (b.positionInr !== undefined) {
    const p = Math.round(Number(b.positionInr));
    if (!(p >= POSITION_MIN && p <= POSITION_MAX)) return NextResponse.json({ error: 'BAD_POSITION', message: `Position must be ₹${POSITION_MIN.toLocaleString('en-IN')}–₹${POSITION_MAX.toLocaleString('en-IN')} a trade.` }, { status: 400 });
    settings = { ...settings, positionInr: p };
    await saveSettings(liveStore, settings);
    note(s, `wide model position set to ₹${p.toLocaleString('en-IN')} a trade (from the next order)`);
  }
  if (b.version !== undefined && b.version !== settings.version) {
    if (b.version !== 'narrow' && b.version !== 'wide') return NextResponse.json({ error: 'BAD_VERSION', message: 'version must be narrow or wide' }, { status: 400 });
    if (s.orders.some(counts)) return NextResponse.json({ error: 'TRADED', message: 'A trade was sent today: switch the model after today.' }, { status: 409 });
    settings = { ...settings, version: b.version };
    await saveSettings(liveStore, settings);
    s.armed = false;
    note(s, `switched to ${b.version === 'wide' ? 'iteration 15 (wide: ₹250-1000, ₹100 crore+ a day, 3 a day, market gate)' : 'iteration 10 (narrow: ₹250-340, 2 a day)'}; disarmed. Make the day list again.`);
  }
  if (typeof b.veto === 'string' && b.veto) {
    const v = new Set(s.vetoes);
    if (b.on) v.add(b.veto); else v.delete(b.veto);
    s.vetoes = [...v].sort();
    note(s, `${b.on ? 'vetoed' : 'un-vetoed'} ${b.veto}`);
  }
  if (typeof b.armed === 'boolean') { s.armed = b.armed; note(s, b.armed ? 'ARMED: picks are sent to Dhan' : 'disarmed: picks are only shown'); }
  await saveState(liveStore, s);
  return NextResponse.json({ vetoes: s.vetoes, armed: s.armed, riskInr: settings.riskInr, positionInr: settings.positionInr, version: settings.version });
}
