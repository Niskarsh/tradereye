import { NextResponse } from 'next/server';
import { errorResponse, ownerGuard } from '@/lib/live/guard';
import { loadArticle, loadSettings, saveArticle } from '@/lib/medium/articles';
import { suggestPublications } from '@/lib/medium/article';
import { writeDraft } from '@/lib/medium/write';
import { mediumStore } from '@/lib/medium/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 150;

/** POST { id } -> ONE Claude call (only when he presses the button): his answers arranged into the article + publish kit. */
export async function POST(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const { id } = await req.json().catch(() => ({})) as { id?: string };
    const [a, s] = await Promise.all([loadArticle(mediumStore, id ?? ''), loadSettings(mediumStore)]);
    if (!a) return NextResponse.json({ error: 'NOT_FOUND', message: 'No such article.' }, { status: 404 });
    const answered = a.answers.filter((x) => x.trim().split(/\s+/).length >= 15).length;
    if (answered < 3) return NextResponse.json({ error: 'BAD_REQUEST', message: 'Answer at least 3 questions (a few sentences each) first: the article is made of your answers.' }, { status: 400 });
    const r = await writeDraft(a, { writingStyle: s.writingStyle, signOff: s.signOff });
    const publication = a.kit?.publication ?? suggestPublications(a.format, s.publications)[0]?.name;
    return NextResponse.json({ article: await saveArticle(mediumStore, { ...a, draft: r.draft, kit: { ...r.kit, publication }, costInr: Math.round((a.costInr + r.costInr) * 100) / 100 }), costInr: r.costInr });
  } catch (e) { return errorResponse(e); }
}
