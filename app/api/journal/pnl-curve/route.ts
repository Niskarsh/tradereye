import { NextResponse } from 'next/server';
import { lookupSecurityId } from '@/lib/dhan';
import { errorResponse, ownerGuard } from '@/lib/live/guard';
import { getChunk, putChunk } from '@/lib/book/s3';
import { NeedsDhanError, dayIsOver } from '@/lib/candles/store';
import type { PnlFill, PnlPosition } from '@/lib/pnlCurve/curve';
import { loadCurve, positionsFromTradeBook } from '@/lib/pnlCurve/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SYMBOL = /^[A-Z0-9&-]{1,30}$/;

function clean(raw: unknown): PnlPosition[] | undefined {
  if (!Array.isArray(raw) || raw.length > 40) return undefined;
  const out: PnlPosition[] = [];
  for (const p of raw as PnlPosition[]) {
    if (!p || !SYMBOL.test(String(p.symbol)) || !Array.isArray(p.fills) || !p.fills.length || p.fills.length > 500) return undefined;
    const fills: PnlFill[] = p.fills.map((f) => ({ t: Number(f.t), side: f.side === 'SELL' ? 'SELL' : 'BUY', qty: Number(f.qty), price: Number(f.price) }));
    if (fills.some((f) => !Number.isFinite(f.t) || !(f.qty > 0) || !(f.price > 0))) return undefined;
    out.push({ ...p, fills, charges: Math.max(0, Number(p.charges) || 0), securityId: /^\d{1,10}$/.test(String(p.securityId ?? '')) ? String(p.securityId) : undefined });
  }
  return out;
}

/**
 * POST { date, positions } -> the day's P&L curve (gross and net, overall and per position). Saved curves and saved
 * candles need only the Google sign-in; anything not saved comes from Dhan once. Answers NEEDS_DHAN when it needs a
 * Dhan login, so the journal can offer the login or the upload instead.
 */
export async function POST(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const b = await req.json().catch(() => ({})) as { date?: string; positions?: unknown };
    const date = String(b.date ?? '');
    let positions = clean(b.positions);
    if (!DATE.test(date) || !positions) return NextResponse.json({ error: 'BAD_REQUEST', message: 'Missing date or fills.' }, { status: 400 });
    const today = new Date(Date.now() + 19800_000).toISOString().slice(0, 10);
    if (date === today && !dayIsOver(date, Date.now()) && g.dhan) {
      // a failed read of the trade book only loses the running position: what the journal has is still drawn
      const book = await g.dhan.tradeBook().catch(() => []);
      const live = positionsFromTradeBook(date, book, positions);
      if (live.length) positions = live;
    }
    if (!positions.length) return NextResponse.json({ error: 'NO_TRADES', message: 'No trades on this day.' }, { status: 404 });
    const r = await loadCurve({ store: { get: getChunk, put: putChunk }, dhan: g.dhan, lookupSecurityId: (s) => lookupSecurityId(s) }, date, positions);
    return NextResponse.json({ ...r, positions });
  } catch (e) {
    if (e instanceof NeedsDhanError) return NextResponse.json({ error: 'NEEDS_DHAN', message: e.message }, { status: 409 });
    return errorResponse(e);
  }
}
