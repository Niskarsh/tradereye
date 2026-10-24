import { NextResponse } from 'next/server';
import { ownerRequired } from '@/lib/auth/owner';
import { loadPosts, stepInstagram, updatePlan } from '@/lib/shorts/publish';
import { statusOf, validId } from '@/lib/shorts/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 90;

/** POST { id } -> publishes the Reel on Instagram right now (also the retry for a failed one). Waits up to a minute for Meta. */
export async function POST(req: Request) {
  const denied = ownerRequired(req);
  if (denied) return denied;
  const { id } = await req.json().catch(() => ({})) as { id?: string };
  if (!id || !validId(id)) return NextResponse.json({ error: 'BAD_REQUEST', message: 'Unknown short.' }, { status: 400 });
  if ((await statusOf(id)).state !== 'done') return NextResponse.json({ error: 'BAD_REQUEST', message: 'The video is not ready yet.' }, { status: 400 });
  const old = (await loadPosts())[id]?.instagram;
  if (old?.state === 'live') return NextResponse.json({ error: 'BAD_REQUEST', message: 'Already on Instagram.' }, { status: 400 });
  const now = Date.now();
  // keep a fresh processed video if there is one; otherwise it is made now
  const start = { ...(old ?? {}), at: now, state: old?.state === 'processing' ? 'processing' as const : 'scheduled' as const, updatedAt: now, attempts: 0, error: undefined };
  const after = await stepInstagram(id, start, now, 60_000);
  const plan = await updatePlan(id, (p) => ({ ...p, instagram: after }));
  return NextResponse.json({ plan });
}
