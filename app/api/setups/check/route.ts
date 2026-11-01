import { NextResponse } from 'next/server';
import { errorResponse, ownerGuard } from '@/lib/live/guard';
import { getChunk, putChunk } from '@/lib/book/s3';
import { INDEX_KEY, RUN_ID, dataCheckKey, getJson, type DataCheck, type DataCheckMonth, type RunIndexItem } from '@/lib/setups/store';

export const dynamic = 'force-dynamic';

const store = { get: getChunk, put: putChunk };
const IST = 19800_000;
const monthOf = (ms: number) => new Date(ms + IST).toISOString().slice(0, 7);
const prevMonth = (m: string) => { const [y, mo] = m.split('-').map(Number); return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`; };
const monName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
/** a month counts as complete when this share of its screener stock-days were replayed */
const COVER_MIN = 0.97;
/** the months a model learns from and sets its bar on (30 + 3) */
const MODEL_MONTHS = 33;

interface Issue { month: string; text: string; recent: boolean }

/**
 * GET ?run=<id> -> the data check of that run (default: the latest): every month's completeness, what is new since the
 * run before, and a verdict for this month's Algo Live model. Runs made before the check existed get the verdict from
 * their dates alone.
 */
export async function GET(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const runs = (await getJson<RunIndexItem[]>(store, INDEX_KEY)) ?? [];
    const want = new URL(req.url).searchParams.get('run');
    const i = Math.max(0, want && RUN_ID.test(want) ? runs.findIndex((r) => r.runId === want) : 0);
    const run = runs[i], before = runs[i + 1];
    if (!run) return NextResponse.json({ check: null });
    const check = await getJson<DataCheck>(store, dataCheckKey(run.runId)).catch(() => undefined);
    const to = check?.to ?? run.period.to;

    // this month's model needs every trading day of last month
    const now = monthOf(Date.now()), last = prevMonth(now);
    const hasLast = to.slice(0, 7) > last || (to.slice(0, 7) === last && monthOf(run.createdAt) >= now);

    const months: (DataCheckMonth & { cover: number | null; ok: boolean })[] = (check?.months ?? []).map((m) => {
      const cover = m.planned ? m.done / m.planned : null;
      return { ...m, cover, ok: (cover === null || cover >= COVER_MIN) && m.niftyDays === m.sessions };
    });
    const recentFrom = months.length ? months[Math.max(0, months.length - MODEL_MONTHS)].month : '';
    const barFrom = months.length ? months[Math.max(0, months.length - 3)].month : '';
    const issues: Issue[] = months.filter((m) => !m.ok && m.month >= recentFrom).map((m) => ({
      month: m.month, recent: m.month >= barFrom,
      text: [
        m.cover !== null && m.cover < COVER_MIN ? `${m.planned - m.done} of ${m.planned} stock-days not replayed (${m.noCandles} without candles${m.noNifty ? `, ${m.noNifty} without Nifty 500` : ''})` : '',
        m.niftyDays < m.sessions ? `Nifty 500 1-minute candles missing on ${m.sessions - m.niftyDays} of ${m.sessions} days` : '',
      ].filter(Boolean).join('; '),
    }));

    let tone: 'good' | 'warn' | 'bad', verdict: string;
    if (!hasLast) { tone = 'bad'; verdict = `Data ends ${day(to)}: it does not have all of ${monName(last)}. Re-run after ${monName(last)} ends, then make ${monName(now)}'s model.`; }
    else if (issues.some((x) => x.recent)) { tone = 'bad'; verdict = `Gaps in the 3 months that set the bar: check before making ${monName(now)}'s model.`; }
    else if (issues.length) { tone = 'warn'; verdict = `Data through ${day(to)}: ready for ${monName(now)}'s model, with small gaps in older months (below).`; }
    else { tone = 'good'; verdict = check ? `Complete through ${day(to)}: ready for ${monName(now)}'s model.` : `Data through ${day(to)}: has all of ${monName(last)}, ready for ${monName(now)}'s model.`; }

    return NextResponse.json({
      check: {
        runId: run.runId, createdAt: run.createdAt, from: check?.from ?? run.period.from, to, detailed: !!check,
        before: before ? { runId: before.runId, createdAt: before.createdAt, to: before.period.to } : null,
        forMonth: now, tone, verdict, issues, months: months.slice(-MODEL_MONTHS).reverse(),
      },
    });
  } catch (e) { return errorResponse(e); }
}
