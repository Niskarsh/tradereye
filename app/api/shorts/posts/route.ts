import { NextResponse } from 'next/server';
import { ownerRequired } from '@/lib/auth/owner';
import { liveYouTube } from '@/lib/social/connections';
import { videoChecks, type VideoCheck } from '@/lib/social/youtube';
import { loadPosts } from '@/lib/shorts/publish';
import { listShorts, posterKey, signedGet, store, textKey } from '@/lib/shorts/store';
import { getJson } from '@/lib/setups/store';
import type { WrittenText } from '@/lib/shorts/write';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const WEEK_MS = 7 * 86_400_000;

/**
 * GET -> the Posting view: every short with a posting plan that is still waiting, needs attention, or went live in
 * the last 7 days. YouTube videos are checked with YouTube itself (live / still private / rejected / deleted).
 */
export async function GET(req: Request) {
  const denied = ownerRequired(req);
  if (denied) return denied;
  try {
    const now = Date.now();
    const [posts, items] = await Promise.all([loadPosts(), listShorts()]);
    const byId = new Map(items.map((x) => [x.id, x]));
    const ids = Object.keys(posts).filter((id) => {
      const plan = posts[id];
      const ats = [plan.youtube?.at, plan.instagram?.at].filter((x): x is number => !!x);
      return ats.some((a) => a > now - WEEK_MS) || plan.youtube?.state === 'failed' || plan.instagram?.state === 'failed';
    });
    let checks: Record<string, VideoCheck | null> = {};
    let checkError: string | undefined;
    const vids = ids.map((id) => posts[id].youtube?.videoId).filter((x): x is string => !!x);
    if (vids.length) {
      try { checks = await videoChecks((await liveYouTube()).accessToken, vids); }
      catch (e) { checkError = (e as Error).message; }
    }
    const rows = await Promise.all(ids.map(async (id) => {
      const vid = posts[id].youtube?.videoId;
      return {
        id, label: byId.get(id)?.label ?? id, kind: byId.get(id)?.kind, post: posts[id],
        poster: await signedGet(posterKey(id)).catch(() => undefined),
        text: await getJson<WrittenText | { error: string }>(store, textKey(id)),
        youtubeCheck: vid && vid in checks ? checks[vid] ?? { privacy: '', upload: '', problem: 'Not found on YouTube (deleted in Studio?)' } : undefined,
      };
    }));
    return NextResponse.json({ now, rows, checkError });
  } catch (e) {
    return NextResponse.json({ error: 'FAILED', message: (e as Error).message }, { status: 500 });
  }
}
