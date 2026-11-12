import { NextResponse } from 'next/server';
import { ownerRequired } from '@/lib/auth/owner';
import { getChunk, putChunk } from '@/lib/book/s3';

export const dynamic = 'force-dynamic';

/**
 * The Charts page's saved things, in S3 so they follow you between laptop and phone:
 *   charts/layout.json             the layout (how many charts, dividers, each chart's interval / type / indicators)
 *   charts/drawings/<SYMBOL>.json  the drawings on one symbol (shared by every interval, like TradingView)
 * The app's AWS user can read and write anywhere in the bucket but cannot list charts/, so S3 answers AccessDenied (not
 * NoSuchKey) for a file that does not exist yet: that is "nothing saved".
 */

const MAX = 1_000_000;
const keyOf = (what: string, symbol: string | null): string | null => {
  if (what === 'layout') return 'charts/layout.json';
  if (what === 'drawings' && symbol && /^[A-Z0-9&-]{1,30}$/.test(symbol)) return `charts/drawings/${symbol.replace(/&/g, '_')}.json`;
  return null;
};

async function read(key: string): Promise<unknown> {
  try {
    const b = await getChunk(key);
    return b ? JSON.parse(new TextDecoder().decode(b)) : null;
  } catch (e) {
    if ((e as { name?: string }).name === 'AccessDenied') return null;
    throw e;
  }
}

export async function GET(req: Request) {
  const denied = ownerRequired(req);
  if (denied) return denied;
  const u = new URL(req.url);
  const key = keyOf(u.searchParams.get('what') ?? '', (u.searchParams.get('symbol') ?? '').toUpperCase() || null);
  if (!key) return NextResponse.json({ error: 'BAD_REQUEST', message: 'Unknown item.' }, { status: 400 });
  try { return NextResponse.json({ data: await read(key) }); }
  catch (e) { return NextResponse.json({ error: 'S3_ERROR', message: (e as Error).message }, { status: 502 }); }
}

export async function PUT(req: Request) {
  const denied = ownerRequired(req);
  if (denied) return denied;
  const b = await req.json().catch(() => null) as { what?: string; symbol?: string; data?: unknown } | null;
  const key = keyOf(b?.what ?? '', (b?.symbol ?? '').toUpperCase() || null);
  if (!key || b?.data === undefined) return NextResponse.json({ error: 'BAD_REQUEST', message: 'Unknown item.' }, { status: 400 });
  const text = JSON.stringify(b.data);
  if (text.length > MAX) return NextResponse.json({ error: 'TOO_BIG', message: 'Too much to save at once.' }, { status: 413 });
  try {
    // putChunk labels everything gzip; this is plain JSON, read back by this route only
    await putChunk(key, new TextEncoder().encode(text));
    return NextResponse.json({ ok: true });
  } catch (e) { return NextResponse.json({ error: 'S3_ERROR', message: (e as Error).message }, { status: 502 }); }
}
