import { NextResponse } from 'next/server';
import { errorResponse, ownerGuard } from '@/lib/live/guard';
import { loadArticle, loadSettings, saveArticle } from '@/lib/medium/articles';
import { applyPatch, type Patch } from '@/lib/medium/article';
import { mediumStore } from '@/lib/medium/store';

export const dynamic = 'force-dynamic';

const notFound = () => NextResponse.json({ error: 'NOT_FOUND', message: 'No such article.' }, { status: 404 });

/** GET ?id= -> one article (decrypted). */
export async function GET(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const a = await loadArticle(mediumStore, new URL(req.url).searchParams.get('id') ?? '');
    return a ? NextResponse.json({ article: a }) : notFound();
  } catch (e) { return errorResponse(e); }
}

/** PUT { id, ...patch } -> saves his edits (cleaned by applyPatch: the disclaimer always goes back on). */
export async function PUT(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const { id, ...patch } = await req.json().catch(() => ({})) as Patch & { id?: string };
    const [a, s] = await Promise.all([loadArticle(mediumStore, id ?? ''), loadSettings(mediumStore)]);
    if (!a) return notFound();
    const r = applyPatch(a, patch, s.publications);
    if (r.error) return NextResponse.json({ error: 'BAD_REQUEST', message: r.error }, { status: 400 });
    return NextResponse.json({ article: await saveArticle(mediumStore, r.article) });
  } catch (e) { return errorResponse(e); }
}
