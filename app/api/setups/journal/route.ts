import { NextResponse } from 'next/server';
import { errorResponse, ownerGuard } from '@/lib/live/guard';
import { getSheetsClient } from '@/lib/sheetsApi';
import { myReport, scoreTrades } from '@/lib/setups/journal';
import { MONTHS } from '@/lib/live/time';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** GET -> his own trades from every monthly journal tab ("october-2026"), scored on the backtest's yardstick. */
export async function GET(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const sheets = getSheetsClient();
    const month = new RegExp(`^(${MONTHS.join('|')})-\\d{4}$`);
    const tabs = (await sheets.listTabs()).map((t) => t.title).filter((t) => month.test(t));
    const reads = tabs.length ? await sheets.readTails(tabs.map((title) => ({ title, tail: 5000 }))) : [];
    const trades = reads.flatMap((r) => scoreTrades(r.headers, r.rows));
    return NextResponse.json({ tabs, ...myReport(trades) });
  } catch (e) { return errorResponse(e); }
}
