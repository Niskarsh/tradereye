import { NextResponse } from 'next/server';
import { errorResponse, ownerGuard } from '@/lib/live/guard';
import { NeedsDhanError } from '@/lib/candles/store';
import { DispatchError, dispatchWorkflow } from '@/lib/setups/github';
import { findTrade, season, seasonBeforeAfter, tradeDay } from '@/lib/shorts/source';
import { dateLabel, mysterySpec, vsPanel, vsSpec, type ShortSpec } from '@/lib/shorts/spec';
import { addShort, setStatus } from '@/lib/shorts/store';
import { mysteryEligible, MYSTERY_MIN_AGE_DAYS } from '@/lib/shorts/trades';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const RENDER_WORKFLOW = 'shorts-render.yml';
const newId = (kind: string) => `${kind}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 7)}`;

/**
 * POST { kind: 'mystery', tradeId, date, tell? }  or  { kind: 'vs', week, notes?: { me?, algo? } }
 * -> builds the short's spec from the journal / Algo Live / saved candles, saves it, and starts the render job on
 * GitHub Actions. A Dhan token (header) is used only when a trade day's candles are not saved yet.
 */
export async function POST(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const b = await req.json().catch(() => ({})) as { kind?: string; tradeId?: string; date?: string; tell?: string; week?: string; notes?: { me?: string; algo?: string } };
    let spec: ShortSpec, label: string;
    if (b.kind === 'mystery') {
      if (!b.tradeId || !/^\d{4}-\d{2}-\d{2}$/.test(b.date ?? '')) return bad('Pick a trade first.');
      const t = await findTrade(b.tradeId, b.date!);
      if (!t) return bad('That trade is no longer in the journal.');
      if (!mysteryEligible(t)) return bad(`Mystery charts show the ticker, so the trade must be over ${MYSTERY_MIN_AGE_DAYS} days old (SEBI's 3-month rule).`);
      spec = mysterySpec(newId('mystery'), t, await tradeDay(t, g.dhan), String(b.tell ?? ''));
      label = `Mystery: ${t.symbol} · ${dateLabel(t.date)}`;
    } else if (b.kind === 'vs') {
      const s = await season();
      const w = s.weeks.find((x) => x.week === b.week);
      if (!w) return bad('That week is not finished yet, or is before Algo Live started.');
      if (!w.meTrade && !w.algoTrade) return bad('Neither side has a scored trade that week.');
      const notes = b.notes ?? {};
      const [me, algo] = await Promise.all([
        w.meTrade ? tradeDay(w.meTrade, g.dhan).then((day) => vsPanel(w.meTrade!, day, String(notes.me ?? ''))) : undefined,
        w.algoTrade ? tradeDay(w.algoTrade, g.dhan).then((day) => vsPanel(w.algoTrade!, day, String(notes.algo ?? ''))) : undefined,
      ]);
      spec = vsSpec(newId('vs'), { week: { week: w.week, me: w.me, algo: w.algo, winner: w.winner }, ...seasonBeforeAfter(s.weeks, w.week), me, algo });
      label = `Me vs Algo · Week of ${dateLabel(w.week)}`;
    } else return bad('kind must be mystery or vs');

    const item = await addShort(spec, label);
    try { await dispatchWorkflow(RENDER_WORKFLOW, { short_id: spec.id }, 'the render job'); }
    catch (e) {
      const msg = e instanceof DispatchError ? e.message : (e as Error).message;
      await setStatus(spec.id, { state: 'failed', updatedAt: Date.now(), error: msg });
      return NextResponse.json({ error: 'DISPATCH_FAILED', message: msg, item }, { status: 502 });
    }
    return NextResponse.json({ item });
  } catch (e) {
    if (e instanceof NeedsDhanError) return NextResponse.json({ error: 'NEEDS_DHAN', message: 'That day\'s candles are not saved yet: log in on the Dhan login tab, then generate again.' }, { status: 409 });
    if (e instanceof Error && /No candles saved/.test(e.message)) return bad(e.message);
    return errorResponse(e);
  }
}

const bad = (message: string) => NextResponse.json({ error: 'BAD_REQUEST', message }, { status: 400 });
