import { NextResponse } from 'next/server';
import { getSheetsClient } from '@/lib/sheetsApi';
import { lookupSecurityId } from '@/lib/dhan';
import { errorResponse, guard } from '@/lib/live/guard';
import { buildCheck } from '@/lib/copilot/service';
import { appendCheck, askedToday, readChecks, remember } from '@/lib/copilot/store';
import { settings } from '@/lib/copilot/settings';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Tap a symbol: fetch Dhan data, compute the facts (no Claude), save the check row, return the Facts card.
 * Body: { direction: 'LONG'|'SHORT', setup: 'MOMENTUM'|'REVERSAL', symbol, plannedStop?, manage? }
 */
export async function POST(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.res;
  try {
    const b = await req.json().catch(() => ({}));
    const direction = b?.direction === 'SHORT' ? 'SHORT' : 'LONG';
    const setup = b?.setup === 'REVERSAL' ? 'REVERSAL' : 'MOMENTUM';
    const symbol = String(b?.symbol ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9&\-]{1,30}$/.test(symbol)) return NextResponse.json({ error: 'BAD_SYMBOL', message: 'Type a valid NSE symbol.' }, { status: 400 });
    const stop = parseFloat(b?.plannedStop);
    const sheets = getSheetsClient();
    const r = await buildCheck(
      { dhan: g.dhan, sheets, clientId: g.clientId, lookupSecurityId: (s) => lookupSecurityId(s) },
      { direction, setup, symbol, plannedStop: Number.isFinite(stop) && stop > 0 ? stop : undefined, manage: b?.manage !== false },
    );
    await appendCheck(sheets, r.date, r.row);
    remember(r.checkId, r.row, r.payload);
    const { rows } = await readChecks(sheets, r.date).catch(() => ({ rows: [] as { o: Record<string, string> }[] }));
    const { payload, row, ...card } = r;
    void payload; void row;
    return NextResponse.json({ ...card, asksLeft: Math.max(0, settings().dailyLimit - askedToday(rows, r.date)) });
  } catch (e) {
    if (e instanceof Error && !('status' in e) && /not in Dhan|No price/.test(e.message)) return NextResponse.json({ error: 'NOT_FOUND', message: e.message }, { status: 404 });
    return errorResponse(e);
  }
}
