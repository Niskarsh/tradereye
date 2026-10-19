import { NextResponse } from 'next/server';
import { getSheetsClient } from '@/lib/sheetsApi';
import { errorResponse, ownerGuard } from '@/lib/live/guard';
import { upsertIndex, type IndexRow } from '@/lib/book/sheet';

export const dynamic = 'force-dynamic';

/** Body { rows: IndexRow[] }: one row per stock per day in "<month>-book", pointing to its S3 folder. */
export async function POST(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const b = await req.json().catch(() => ({}));
    const rows: IndexRow[] = (Array.isArray(b?.rows) ? b.rows : []).filter((r: IndexRow) =>
      /^\d{4}-\d{2}-\d{2}$/.test(r?.date) && /^[A-Z0-9&-]{1,30}$/.test(r?.symbol) && /^order-book\//.test(r?.folder));
    const sameDay = rows.filter((r) => r.date === rows[0]?.date).slice(0, 60);
    return NextResponse.json({ saved: await upsertIndex(getSheetsClient(), sameDay) });
  } catch (e) { return errorResponse(e); }
}
