import { NextResponse } from 'next/server';
import { lookupSecurityId } from '@/lib/dhan';
import { guard } from '@/lib/live/guard';
import { symbolsFromImages } from '@/lib/book/ocr';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Body { images: [dataURL, ...] } -> { symbols (valid NSE equities), rejected (read but not on NSE) }. Uses Gemini, not Claude. */
export async function POST(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.res;
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) return NextResponse.json({ error: 'NO_GEMINI_KEY', message: 'Add GEMINI_API_KEY in Vercel (free from Google AI Studio), then redeploy.' }, { status: 503 });
  try {
    const b = await req.json().catch(() => ({}));
    const images: string[] = (Array.isArray(b?.images) ? b.images : []).filter((x: unknown) => typeof x === 'string').slice(0, 8);
    if (!images.length) return NextResponse.json({ error: 'NO_IMAGES', message: 'Paste at least one screenshot.' }, { status: 400 });
    const { symbols, model } = await symbolsFromImages(images, key);
    const valid: string[] = [], rejected: string[] = [];
    for (const s of symbols) ((await lookupSecurityId(s)) ? valid : rejected).push(s);
    return NextResponse.json({ symbols: valid, rejected, model });
  } catch (e) {
    return NextResponse.json({ error: 'OCR_FAILED', message: (e as Error).message }, { status: 502 });
  }
}
