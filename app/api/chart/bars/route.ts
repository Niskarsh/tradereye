import { NextResponse } from 'next/server';
import { lookupSecurityId, type Candles } from '@/lib/dhan';
import { errorResponse, ownerGuard } from '@/lib/live/guard';
import { getChunk, putChunk } from '@/lib/book/s3';
import { joinCandles, minuteDays, NIFTY500, NIFTY_SYMBOL, weekdaysBack, type Counts, type Instrument } from '@/lib/candles/store';
import { algoQuietMs } from '@/lib/chart/quiet';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const DAY = 86400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * POST { symbol, kind: '1m' | '1d', from, to } -> { symbol, securityId, segment, c: Candles, partial?, retryInMs? }
 *
 * The Charts page's candles. 1-minute candles come from the same per-day S3 files the journal uses (a finished day is
 * fetched from Dhan once, ever); today always comes from Dhan. Daily candles always come from Dhan (one request).
 * In the two minutes after an Algo Live close the page gets only what is saved, with `retryInMs` (lib/chart/quiet.ts).
 * NIFTY500 is the Nifty 500 index.
 */
export async function POST(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const b = await req.json().catch(() => ({}));
    const symbol = String(b?.symbol ?? '').trim().toUpperCase();
    const kind = b?.kind === '1d' ? '1d' : '1m';
    const { from, to } = b ?? {};
    if (!/^[A-Z0-9&-]{1,30}$/.test(symbol) || !isDate(from) || !isDate(to) || from > to) {
      return NextResponse.json({ error: 'BAD_REQUEST', message: 'Need a symbol and a from / to date.' }, { status: 400 });
    }
    const span = daysBetween(from, to);
    if (kind === '1m' && span > 85) return NextResponse.json({ error: 'BAD_REQUEST', message: 'At most 85 days of 1-minute candles at a time.' }, { status: 400 });
    if (kind === '1d' && span > 3700) return NextResponse.json({ error: 'BAD_REQUEST', message: 'At most 10 years of daily candles at a time.' }, { status: 400 });

    const index = symbol === NIFTY_SYMBOL;
    let securityId = index ? NIFTY500.securityId : /^\d{1,10}$/.test(String(b?.securityId ?? '')) ? String(b.securityId) : undefined;
    const resolveId = async () => {
      securityId ??= await lookupSecurityId(symbol);
      if (!securityId) throw new Error(`${symbol} is not in Dhan's NSE equity list.`);
      return securityId;
    };
    const ins: Instrument = index ? { symbol, ...NIFTY500 } : { symbol, securityId, segment: 'NSE_EQ', instrument: 'EQUITY' };
    const quiet = algoQuietMs();
    const dhan = quiet ? undefined : g.dhan;

    if (kind === '1d') {
      if (!g.dhan) return NextResponse.json({ error: 'TOKEN_MISSING', message: 'Daily candles need the Dhan login.' }, { status: 401 });
      if (quiet) return NextResponse.json({ symbol, securityId, segment: ins.segment, c: { t: [], o: [], h: [], l: [], c: [], v: [] }, partial: true, retryInMs: quiet });
      const id = await resolveId();
      // Dhan's toDate is exclusive
      const c: Candles = await g.dhan.daily({ securityId: id, segment: ins.segment, instrument: ins.instrument, from, to: addDays(to, 1) });
      return NextResponse.json({ symbol, securityId: id, segment: ins.segment, c: joinCandles([c]) });
    }

    const n: Counts = { fromS3: 0, fromDhan: 0, saved: 0, dhanCalls: 0, s3Errors: 0, notSaved: 0 };
    const days = weekdaysBack(to, span);
    const r = await minuteDays({ store: { get: getChunk, put: putChunk }, dhan, lookupSecurityId: (s) => lookupSecurityId(s) }, ins, days, undefined, n, resolveId);
    securityId ??= r.securityId ?? (index ? NIFTY500.securityId : await lookupSecurityId(symbol));
    const partial = n.notSaved > 0;
    return NextResponse.json({
      symbol, securityId, segment: ins.segment, c: r.c,
      ...(partial ? { partial: true, retryInMs: quiet || undefined, needsDhan: !g.dhan } : {}),
    });
  } catch (e) {
    if (e instanceof Error && /not in Dhan/.test(e.message)) return NextResponse.json({ error: 'NOT_FOUND', message: e.message }, { status: 404 });
    return errorResponse(e);
  }
}
