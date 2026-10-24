import { NextResponse } from 'next/server';
import { ownerRequired } from '@/lib/auth/owner';
import { listShorts, posterKey, signedGet, statusOf, store, textKey, videoKey } from '@/lib/shorts/store';
import { getJson } from '@/lib/setups/store';
import type { WrittenText } from '@/lib/shorts/write';
import { loadPosts } from '@/lib/shorts/publish';

export const dynamic = 'force-dynamic';

/** GET -> every short made, newest first, with its render status, its words (title, caption...), its posting plan and, when done, private links to the video and poster. */
export async function GET(req: Request) {
  const denied = ownerRequired(req);
  if (denied) return denied;
  try {
    const [items, posts] = await Promise.all([listShorts(), loadPosts()]);
    const out = await Promise.all(items.slice(0, 30).map(async (it) => {
      const [status, text] = await Promise.all([statusOf(it.id), getJson<WrittenText | { error: string }>(store, textKey(it.id))]);
      const done = status.state === 'done';
      return { ...it, status, text, post: posts[it.id], video: done ? await signedGet(videoKey(it.id)) : undefined, poster: done ? await signedGet(posterKey(it.id)) : undefined };
    }));
    return NextResponse.json({ shorts: out, now: Date.now() });
  } catch (e) {
    return NextResponse.json({ error: 'FAILED', message: (e as Error).message }, { status: 500 });
  }
}
