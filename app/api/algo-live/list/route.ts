import { NextResponse } from 'next/server';
import { errorResponse, guard } from '@/lib/live/guard';
import { candidates, gateFor, istNow, loadModelOf, loadSettings, loadState, MARKET_MOVE_KEY, note, recordList, saveState, screen, universeOf } from '@/lib/algoLive/engine';
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
 * The list is made for the model the page is switched to (narrow ₹250-340, or wide ₹250-1000 without ETFs) and remembers it.
 * When the wide list is done, today's market gate is worked out from it.
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
      const { version } = await loadSettings(liveStore);
      const u = universeOf(version);
      const c = await candidates(g.dhan, g.clientId, undefined, u);
      await putJson(liveStore, key, c);
      const s = await loadState(liveStore, date);
      s.list = []; s.prepared = []; s.candidates = c.length; s.listAt = undefined; s.version = version; s.gate = undefined;
      note(s, `day list (${version === 'wide' ? 'iteration 15, wide' : 'iteration 10, narrow'}): ${c.length} equities near ₹${u.priceMin}-${u.priceMax}${u.wide ? ' (ETFs left out)' : ''}, checking their daily candles`);
      await saveState(liveStore, s);
      return NextResponse.json({ candidates: c.length });
    }
    if (body.phase === 'screen') {
      const all = (await getJson<Cand[]>(liveStore, key)) ?? [];
      const from = Math.max(0, body.from ?? 0), n = Math.min(40, Math.max(1, body.n ?? 25));
      const part = all.slice(from, from + n);
      const version = (await loadState(liveStore, date)).version ?? 'narrow';
      const r = await screen(g.dhan, liveStore, date, part, universeOf(version));
      const s = await loadState(liveStore, date);
      const have = new Set(s.list.map((x) => x.symbol));
      for (const x of r.passed) if (!have.has(x.symbol)) s.list.push(x);
      s.list.sort((a, b) => a.symbol.localeCompare(b.symbol));
      s.prepared = s.list.map((x) => x.symbol);
      const done = from + part.length >= all.length;
      if (done) {
        s.listAt = Date.now();
        note(s, `day list ready: ${s.list.length} stocks`);
        if (version === 'wide') {
          const model = await loadModelOf(liveStore, 'wide');
          if (model?.gate) {
            const saved = (await getJson<Record<string, number>>(liveStore, MARKET_MOVE_KEY)) ?? {};
            s.gate = gateFor(model, s.list, date, saved);
            if (s.gate?.move !== null && s.gate?.move !== undefined) { saved[date] = Math.round(s.gate.move * 1e6) / 1e6; await putJson(liveStore, MARKET_MOVE_KEY, saved); }
            note(s, s.gate?.move === null || !s.gate ? 'market gate: no 20-day moves on the list, so no trades today'
              : `market gate: the market's 20-day move is ${s.gate.move.toFixed(2)}% (${s.gate.stocks} stocks), the bar ${s.gate.bar === null ? 'unknown' : `${s.gate.bar.toFixed(2)}%`} (${s.gate.history} days): ${s.gate.hot ? 'HOT, no trades today' : 'not hot, trading as usual'}`);
          } else note(s, 'market gate: no wide model with a gate in S3, so no trades today: run "Algo Live model (wide)"');
        }
      }
      if (r.failed.length) note(s, `could not read ${r.failed.length} candidates (${r.failed.slice(0, 8).join(', ')}${r.failed.length > 8 ? ', ...' : ''}): press Day list again to retry`);
      await saveState(liveStore, s);
      return NextResponse.json({ total: all.length, next: from + part.length, done, passed: r.passed.map((x) => x.symbol), failed: r.failed, list: s.list.length, record: recordList(s.list) });
    }
    return NextResponse.json({ error: 'BAD_REQUEST', message: 'phase must be scan or screen' }, { status: 400 });
  } catch (e) {
    return errorResponse(e);
  }
}
