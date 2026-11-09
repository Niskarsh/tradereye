import { NextResponse } from 'next/server';
import { errorResponse, guard } from '@/lib/live/guard';
import { openPositions } from '@/lib/book/positions';
import { LiveStore } from '@/lib/live/store';
import { getSheetsClient } from '@/lib/sheetsApi';

export const dynamic = 'force-dynamic';

/** Open positions with their stops and targets, for the Order Book chart. Never writes; ?history=1 also reads the saved order log. */
export async function GET(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.res;
  try {
    const history = new URL(req.url).searchParams.has('history');
    const [trades, orders, supers, known] = await Promise.all([
      g.dhan.trades(), g.dhan.orders(), g.dhan.superOrders().catch(() => []),
      history ? new LiveStore(getSheetsClient()).loadOrders().then((r) => r.known).catch(() => undefined) : Promise.resolve(undefined),
    ]);
    return NextResponse.json({ positions: openPositions(trades, orders, supers, known), history: !!known });
  } catch (e) { return errorResponse(e); }
}
