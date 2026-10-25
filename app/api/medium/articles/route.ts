import { NextResponse } from 'next/server';
import { errorResponse, ownerGuard } from '@/lib/live/guard';
import { loadIndex, newArticleId, saveArticle } from '@/lib/medium/articles';
import { loadMaterial, type PeriodInput } from '@/lib/medium/source';
import { FORMAT_OF } from '@/lib/medium/material';
import { mediumStore } from '@/lib/medium/store';
import type { Article } from '@/lib/medium/article';

export const dynamic = 'force-dynamic';
export const maxDuration = 90;

/** GET -> every article's head (drafts and published), newest first. */
export async function GET(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try { return NextResponse.json({ articles: (await loadIndex(mediumStore)).filter((h) => !h.deleted) }); } catch (e) { return errorResponse(e); }
}

/** POST { format, week | month | fromIteration, toIteration } -> a new article with that period's real data. No Claude call. */
export async function POST(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const b = await req.json().catch(() => ({})) as PeriodInput & { format?: string };
    const format = FORMAT_OF(b.format ?? '');
    if (!format) return NextResponse.json({ error: 'BAD_REQUEST', message: 'Pick a format.' }, { status: 400 });
    const date = /^\d{4}-\d{2}-\d{2}$/, month = /^\d{4}-\d{2}$/;
    if ((format === 'weekly' || format === 'vs-algo') && !date.test(b.week ?? '')) return NextResponse.json({ error: 'BAD_REQUEST', message: 'Pick a week.' }, { status: 400 });
    if (format === 'monthly' && !month.test(b.month ?? '')) return NextResponse.json({ error: 'BAD_REQUEST', message: 'Pick a month.' }, { status: 400 });
    let material;
    try {
      material = await loadMaterial(format, { week: b.week, month: b.month, fromIteration: Number(b.fromIteration) || undefined, toIteration: Number(b.toIteration) || undefined });
    } catch (e) {
      if (e instanceof Error && /^No |not a finished/.test(e.message)) return NextResponse.json({ error: 'NO_DATA', message: e.message }, { status: 404 });
      throw e;
    }
    const now = Date.now();
    const a: Article = { v: 1, id: newArticleId(now), format, createdAt: now, updatedAt: now, material, shared: [], questions: [], answers: [], draft: '', costInr: 0 };
    return NextResponse.json({ article: await saveArticle(mediumStore, a) });
  } catch (e) { return errorResponse(e); }
}
