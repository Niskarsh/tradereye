import { NextResponse } from 'next/server';
import { ownerRequired } from '@/lib/auth/owner';
import { istToday, loadState, publishPost, publishStory, validName } from '@/lib/posts/publish';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** GET -> what has gone out today. */
export async function GET(req: Request) {
  const denied = ownerRequired(req);
  if (denied) return denied;
  try { return NextResponse.json(await loadState(istToday())); }
  catch (e) { return NextResponse.json({ error: 'FAILED', message: (e as Error).message }, { status: 500 }); }
}

/** POST { kind: 'post', slides, caption, again? } or { kind: 'story', slide, again? } -> goes live on Instagram now. */
export async function POST(req: Request) {
  const denied = ownerRequired(req);
  if (denied) return denied;
  const b = await req.json().catch(() => ({})) as { kind?: string; date?: string; slides?: string[]; slide?: string; caption?: string; again?: boolean };
  const today = istToday();
  if (b.date !== today) return bad('Posts are for today only. Reload the page.');
  try {
    if (b.kind === 'story') {
      if (!validName(String(b.slide))) return bad('Bad image name.');
      return NextResponse.json(await publishStory(today, String(b.slide), b.again === true));
    }
    if (b.kind === 'post') {
      const slides = Array.isArray(b.slides) ? b.slides.map(String) : [];
      if (!slides.length || slides.length > 10 || !slides.every(validName)) return bad('A post has 1 to 10 images.');
      if (!String(b.caption ?? '').trim()) return bad('Write the caption first.');
      return NextResponse.json(await publishPost(today, slides, String(b.caption), b.again === true));
    }
    return bad('Unknown kind.');
  } catch (e) { return NextResponse.json({ error: 'FAILED', message: (e as Error).message }, { status: 502 }); }
}
const bad = (message: string) => NextResponse.json({ error: 'BAD_REQUEST', message }, { status: 400 });
