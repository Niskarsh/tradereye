import { NextResponse } from 'next/server';
import { ownerRequired } from '@/lib/auth/owner';
import { deleteShort, validId } from '@/lib/shorts/store';

export const dynamic = 'force-dynamic';

/** POST { id } -> removes a short (its video, poster, spec and status). */
export async function POST(req: Request) {
  const denied = ownerRequired(req);
  if (denied) return denied;
  const { id } = await req.json().catch(() => ({})) as { id?: string };
  if (!id || !validId(id)) return NextResponse.json({ error: 'BAD_REQUEST', message: 'Unknown short.' }, { status: 400 });
  await deleteShort(id);
  return NextResponse.json({ ok: true });
}
