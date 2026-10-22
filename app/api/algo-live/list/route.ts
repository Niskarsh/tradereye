import { NextResponse } from 'next/server';
import { errorResponse, guard } from '@/lib/live/guard';
import { candidates, istNow, loadState, note, recordList, saveState, screen } from '@/lib/algoLive/engine';
import { liveStore } from '@/lib/algoLive/store';
import { getJson, putJson } from '@/lib/setups/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type Cand = { symbol: string; securityId: string };

/**
 * The day list, in small steps the page drives (so no single call runs long):
 *   { phase: 'scan' }                 every NSE equity near the price range (one quote call per 1000 stocks)
 *   { phase: 'screen', from, n }      daily candles of candidates [from, from + n): those that pass the screener go on
 *                                     the list, and their history is saved for the day
 */
export async function POST(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.res;
  if (!g.clientId) return NextResponse.json({ error: 'TOKEN', message: 'The Dhan token has no client id in it.' }, { status: 400 });
  const { date } = istNow();
  const body = (await req.json().catch(() => ({}))) as { phase?: string; from?: number; n?: number };
  const key = `setups/live/${date}/candidates.json`;
  try {
    if (body.phase === 'scan') {
      const c = await candidates(g.dhan, g.clientId);
      await putJson(liveStore, key, c);
      const s = await loadState(liveStore, date);
      s.list = []; s.prepared = []; s.candidates = c.length; s.listAt = undefined;
      note(s, `day list: ${c.length} equities near ₹250-340, checking their daily candles`);
      await saveState(liveStore, s);
      return NextResponse.json({ candidates: c.length });
    }
    if (body.phase === 'screen') {
      const all = (await getJson<Cand[]>(liveStore, key)) ?? [];
      const from = Math.max(0, body.from ?? 0), n = Math.min(40, Math.max(1, body.n ?? 25));
      const part = all.slice(from, from + n);
      const r = await screen(g.dhan, liveStore, date, part);
      const s = await loadState(liveStore, date);
      const have = new Set(s.list.map((x) => x.symbol));
      for (const x of r.passed) if (!have.has(x.symbol)) s.list.push(x);
      s.list.sort((a, b) => a.symbol.localeCompare(b.symbol));
      s.prepared = s.list.map((x) => x.symbol);
      const done = from + part.length >= all.length;
      if (done) { s.listAt = Date.now(); note(s, `day list ready: ${s.list.length} stocks`); }
      if (r.failed.length) note(s, `could not read ${r.failed.length} candidates (${r.failed.slice(0, 8).join(', ')}${r.failed.length > 8 ? ', ...' : ''}): press Day list again to retry`);
      await saveState(liveStore, s);
      return NextResponse.json({ total: all.length, next: from + part.length, done, passed: r.passed.map((x) => x.symbol), failed: r.failed, list: s.list.length, record: recordList(s.list) });
    }
    return NextResponse.json({ error: 'BAD_REQUEST', message: 'phase must be scan or screen' }, { status: 400 });
  } catch (e) {
    return errorResponse(e);
  }
}
