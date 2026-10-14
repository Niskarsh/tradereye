import { NextResponse } from 'next/server';
import { getSheetsClient } from '@/lib/sheetsApi';
import { errorResponse, guard } from '@/lib/live/guard';
import { planOutcomes, runOutcomes } from '@/lib/copilot/outcomes';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Fills "what happened next" for co-pilot checks older than 30 minutes, a few per call. Body: { run?: boolean }. */
export async function POST(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.res;
  try {
    const b = await req.json().catch(() => ({}));
    const sheets = getSheetsClient();
    const items = await planOutcomes(sheets, Date.now());
    if (!b?.run || !items.length) return NextResponse.json({ pending: items.length, done: 0, skipped: 0 });
    const r = await runOutcomes({ dhan: g.dhan, sheets }, items.slice(0, 8));
    return NextResponse.json({ pending: Math.max(0, items.length - r.done - r.skipped), ...r });
  } catch (e) {
    return errorResponse(e);
  }
}
