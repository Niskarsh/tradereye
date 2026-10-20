import { NextResponse } from 'next/server';
import { errorResponse, ownerGuard } from '@/lib/live/guard';
import { getChunk } from '@/lib/book/s3';
import { RUN_ID, signalsKey } from '@/lib/setups/store';
import { CASE_BY_ID, type CaseId } from '@/lib/setups/cases';

export const dynamic = 'force-dynamic';

/**
 * GET ?run=<id>&case=<M1..R8> -> every past trade of that case in that run, gzipped exactly as saved (the page
 * unzips it). Kept per case so one answer stays small.
 */
export async function GET(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const url = new URL(req.url);
    const run = url.searchParams.get('run') ?? '';
    const c = (url.searchParams.get('case') ?? '') as CaseId;
    if (!RUN_ID.test(run) || !CASE_BY_ID.has(c)) return NextResponse.json({ error: 'BAD_REQUEST', message: 'Missing run or case.' }, { status: 400 });
    const bytes = await getChunk(signalsKey(run, c));
    if (!bytes) return NextResponse.json({ error: 'NOT_FOUND', message: 'No signals saved for that run.' }, { status: 404 });
    return new NextResponse(new Blob([bytes as BlobPart]), { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, max-age=86400' } });
  } catch (e) { return errorResponse(e); }
}
