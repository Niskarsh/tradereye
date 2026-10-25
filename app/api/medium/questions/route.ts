import { NextResponse } from 'next/server';
import { errorResponse, ownerGuard } from '@/lib/live/guard';
import { loadArticle, saveArticle } from '@/lib/medium/articles';
import { askQuestions } from '@/lib/medium/write';
import { mediumStore } from '@/lib/medium/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 90;

/** POST { id } -> ONE Claude call (only when he presses the button): 4-5 questions about the article's data. */
export async function POST(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const { id } = await req.json().catch(() => ({})) as { id?: string };
    const a = await loadArticle(mediumStore, id ?? '');
    if (!a) return NextResponse.json({ error: 'NOT_FOUND', message: 'No such article.' }, { status: 404 });
    const r = await askQuestions(a);
    // a new set of questions keeps answers he already typed only for the same question
    const answers = r.questions.map((q) => { const i = a.questions.indexOf(q); return i >= 0 ? a.answers[i] ?? '' : ''; });
    return NextResponse.json({ article: await saveArticle(mediumStore, { ...a, questions: r.questions, answers, costInr: Math.round((a.costInr + r.costInr) * 100) / 100 }), costInr: r.costInr });
  } catch (e) { return errorResponse(e); }
}
