import { NextResponse } from 'next/server';
import { ownerRequired } from '@/lib/auth/owner';
import { listShorts, posterKey, signedGet, statusOf, videoKey } from '@/lib/shorts/store';

export const dynamic = 'force-dynamic';

/** GET -> every short made, newest first, with its render status and (when done) private links to the video and poster. */
export async function GET(req: Request) {
  const denied = ownerRequired(req);
  if (denied) return denied;
  try {
    const items = await listShorts();
    const out = await Promise.all(items.slice(0, 30).map(async (it) => {
      const status = await statusOf(it.id);
      const done = status.state === 'done';
      return { ...it, status, video: done ? await signedGet(videoKey(it.id)) : undefined, poster: done ? await signedGet(posterKey(it.id)) : undefined };
    }));
    return NextResponse.json({ shorts: out });
  } catch (e) {
    return NextResponse.json({ error: 'FAILED', message: (e as Error).message }, { status: 500 });
  }
}
