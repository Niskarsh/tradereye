import { NextResponse } from 'next/server';
import { guard } from '@/lib/live/guard';
import { listSlots } from '@/lib/book/s3';

export const dynamic = 'force-dynamic';

const FOLDER_RE = /^order-book\/\d{4}\/[a-z]+\/[A-Z0-9&-]{1,30}_\d{4}-\d{2}-\d{2}$/;

/** GET ?folder=order-book/2026/october/TARIL_2026-10-16 -> { slots: ["1405", "1415", ...] } (what was recorded). */
export async function GET(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.res;
  const folder = new URL(req.url).searchParams.get('folder') ?? '';
  if (!FOLDER_RE.test(folder)) return NextResponse.json({ error: 'BAD_FOLDER' }, { status: 400 });
  try {
    return NextResponse.json({ slots: await listSlots(folder) });
  } catch (e) {
    const name = (e as { name?: string }).name ?? '';
    return NextResponse.json({ error: name === 'AccessDenied' ? 'NO_LIST_PERMISSION' : 'S3_ERROR', message: (e as Error).message }, { status: name === 'AccessDenied' ? 403 : 502 });
  }
}
