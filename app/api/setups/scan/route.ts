import { NextResponse } from 'next/server';
import { errorResponse, guard } from '@/lib/live/guard';
import { getChunk, putChunk } from '@/lib/book/s3';
import { lookupSecurityId } from '@/lib/dhan';
import { dailyFor, niftyFor } from '@/lib/copilot/service';
import { scan } from '@/lib/setups/live';
import { INDEX_KEY, getJson, summaryKey, type RunIndexItem } from '@/lib/setups/store';
import type { Summary } from '@/lib/setups/stats';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const store = { get: getChunk, put: putChunk };
let latest: { at: number; summary?: Summary } = { at: 0 };

/** the latest run's summary, re-read every 10 minutes (a new run shows up without a redeploy) */
async function latestSummary(): Promise<Summary | undefined> {
  if (Date.now() - latest.at < 10 * 60_000) return latest.summary;
  const runs = (await getJson<RunIndexItem[]>(store, INDEX_KEY)) ?? [];
  const summary = runs[0] ? await getJson<Summary>(store, summaryKey(runs[0].runId)) : undefined;
  latest = { at: Date.now(), summary };
  return summary;
}

/**
 * POST { symbols: [{ symbol, securityId? }] } (Dhan token in the header) -> setups that fired on those stocks in the
 * last 15 minutes, each with its backtest numbers and whether it clears the alert bar
 * (SETUPS_ALERT_MIN_HIT, default 0.6 = 60% hit rate).
 */
export async function POST(req: Request) {
  const g = guard(req);
  if (!g.ok) return g.res;
  try {
    const b = await req.json().catch(() => ({}));
    const list = (Array.isArray(b?.symbols) ? b.symbols : [])
      .map((x: { symbol?: unknown; securityId?: unknown }) => ({ symbol: String(x?.symbol ?? '').trim().toUpperCase(), securityId: /^\d{1,10}$/.test(String(x?.securityId ?? '')) ? String(x.securityId) : undefined }))
      .filter((x: { symbol: string }) => /^[A-Z0-9&-]{1,30}$/.test(x.symbol))
      .slice(0, 50);
    const summary = await latestSummary();
    const minHit = Number(process.env.SETUPS_ALERT_MIN_HIT ?? 0.6);
    const out = await scan({
      dhan: g.dhan, candleStore: store, lookupSecurityId: (s) => lookupSecurityId(s),
      daily: (id, date) => dailyFor(g.dhan, id, date), nifty: (date) => niftyFor(g.dhan, date),
    }, list, summary, { minHit: Number.isFinite(minHit) ? minHit : 0.6 });
    return NextResponse.json({ ...out, runId: summary?.runId ?? null, minHit });
  } catch (e) { return errorResponse(e); }
}
