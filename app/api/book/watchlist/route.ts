import { NextResponse } from 'next/server';
import { getSheetsClient } from '@/lib/sheetsApi';
import { lookupSecurityId } from '@/lib/dhan';
import { errorResponse, ownerGuard } from '@/lib/live/guard';
import { getWatchlist, setWatchlist, type WatchItem } from '@/lib/book/sheet';

export const dynamic = 'force-dynamic';

/** The order-book recording list (kept in the copilot-settings tab, so every device sees the same list). */
export async function GET(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try { return NextResponse.json({ list: await getWatchlist(getSheetsClient()) }); } catch (e) { return errorResponse(e); }
}

/** Body { symbols: string[] }: resolves each to its Dhan security id, saves the list, returns it and any unknown symbols. */
export async function POST(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const b = await req.json().catch(() => ({}));
    const symbols = [...new Set((Array.isArray(b?.symbols) ? b.symbols : []).map((s: unknown) => String(s).trim().toUpperCase()).filter((s: string) => /^[A-Z0-9&-]{1,30}$/.test(s)))] as string[];
    const list: WatchItem[] = [], unknown: string[] = [];
    for (const symbol of symbols.slice(0, 50)) {
      const securityId = await lookupSecurityId(symbol);
      if (securityId) list.push({ symbol, securityId }); else unknown.push(symbol);
    }
    await setWatchlist(getSheetsClient(), list);
    return NextResponse.json({ list, unknown, dropped: Math.max(0, symbols.length - 50) });
  } catch (e) { return errorResponse(e); }
}
