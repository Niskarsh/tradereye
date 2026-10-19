import { NextResponse } from 'next/server';
import { guard } from '@/lib/live/guard';
import { KEY_RE } from '@/lib/book/record';
import { getChunk, putChunk } from '@/lib/book/s3';
import { DIAG_RE } from '@/lib/book/probe';

export const dynamic = 'force-dynamic';

const MAX_BYTES = 4_000_000; // a 10-minute chunk is far smaller; Vercel caps bodies at 4.5 MB

/** GET ?key=order-book/2026/october/TARIL_2026-10-16/0915.gz -> the gzip bytes (404 when not recorded). */
export async function GET(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.res;
  const key = new URL(req.url).searchParams.get('key') ?? '';
  if (!KEY_RE.test(key) && !DIAG_RE.test(key)) return NextResponse.json({ error: 'BAD_KEY' }, { status: 400 });
  try {
    const bytes = await getChunk(key);
    if (!bytes) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    return new Response(bytes as BodyInit, { headers: { 'Content-Type': 'application/gzip', 'Cache-Control': 'no-store' } });
  } catch (e) {
    const name = (e as { name?: string }).name ?? '';
    // Without s3:ListBucket, S3 answers AccessDenied (not NoSuchKey) for a file that does not exist, e.g. a
    // 10-minute slot that was never recorded. The key can read (s3:GetObject), so treat it as "not recorded".
    if (name === 'AccessDenied') return NextResponse.json({ error: 'NOT_FOUND', note: 'missing (or not readable)' }, { status: 404 });
    return NextResponse.json({ error: 'S3_ERROR', message: (e as Error).message }, { status: 502 });
  }
}

/** POST ?key=... with the gzip bytes as the body: saves (or replaces) that 10-minute chunk. */
export async function POST(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.res;
  const key = new URL(req.url).searchParams.get('key') ?? '';
  if (!KEY_RE.test(key) && !DIAG_RE.test(key)) return NextResponse.json({ error: 'BAD_KEY' }, { status: 400 });
  try {
    const body = new Uint8Array(await req.arrayBuffer());
    if (!body.length || body.length > MAX_BYTES) return NextResponse.json({ error: 'BAD_SIZE' }, { status: 413 });
    await putChunk(key, body);
    return NextResponse.json({ ok: true, bytes: body.length });
  } catch (e) {
    const name = (e as { name?: string }).name ?? '';
    if (name === 'AccessDenied') return NextResponse.json({ error: 'S3_ACCESS_DENIED', message: 'The AWS key is not allowed to write under order-book/: allow s3:PutObject on order-book/*.' }, { status: 403 });
    return NextResponse.json({ error: 'S3_ERROR', message: (e as Error).message }, { status: 502 });
  }
}
