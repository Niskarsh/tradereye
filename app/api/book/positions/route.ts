import { NextResponse } from 'next/server';
import { errorResponse, guard } from '@/lib/live/guard';
import { openPositions } from '@/lib/book/positions';

export const dynamic = 'force-dynamic';

/** Open positions with their stops and targets, for the Order Book chart. Read-only. */
export async function GET(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.res;
  try {
    const [trades, orders, supers] = await Promise.all([g.dhan.trades(), g.dhan.orders(), g.dhan.superOrders().catch(() => [])]);
    return NextResponse.json({ positions: openPositions(trades, orders, supers) });
  } catch (e) { return errorResponse(e); }
}
