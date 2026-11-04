import { NextResponse } from 'next/server';
import { ownerRequired } from '@/lib/auth/owner';
import { writePost } from '@/lib/posts/caption';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** POST { facts } -> Claude's Instagram caption and YouTube post text. One call per press of the button. */
export async function POST(req: Request) {
  const denied = ownerRequired(req);
  if (denied) return denied;
  const b = await req.json().catch(() => ({})) as { facts?: unknown };
  if (!b.facts) return NextResponse.json({ error: 'BAD_REQUEST', message: 'No facts sent.' }, { status: 400 });
  try { return NextResponse.json(await writePost(b.facts)); }
  catch (e) { return NextResponse.json({ error: 'FAILED', message: (e as Error).message }, { status: 502 }); }
}
