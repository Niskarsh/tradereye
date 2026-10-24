import { NextResponse } from 'next/server';
import { ownerRequired } from '@/lib/auth/owner';
import { deleteShort, validId } from '@/lib/shorts/store';
import { blocksDelete } from '@/lib/shorts/posts';
import { dropWake, loadPosts, updatePlan } from '@/lib/shorts/publish';

export const dynamic = 'force-dynamic';

/** POST { id } -> removes a short (its video, poster, spec and status). */
export async function POST(req: Request) {
  const denied = ownerRequired(req);
  if (denied) return denied;
  const { id } = await req.json().catch(() => ({})) as { id?: string };
  if (!id || !validId(id)) return NextResponse.json({ error: 'BAD_REQUEST', message: 'Unknown short.' }, { status: 400 });
  const plan = (await loadPosts())[id];
  if (blocksDelete(plan)) return NextResponse.json({ error: 'BAD_REQUEST', message: 'It is scheduled: unschedule it first.' }, { status: 400 });
  await dropWake(plan?.instagram);
  await deleteShort(id);
  await updatePlan(id, () => ({}));  // its posting record (anything already public stays public)
  return NextResponse.json({ ok: true });
}
