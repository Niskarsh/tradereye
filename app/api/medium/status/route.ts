import { NextResponse } from 'next/server';
import { errorResponse, ownerGuard } from '@/lib/live/guard';
import { getJson } from '@/lib/setups/store';
import { POSTS_KEY, RUNS_KEY, trends, type PostIndex, type RunLog } from '@/lib/medium/collect';
import { mediumStore } from '@/lib/medium/store';

export const dynamic = 'force-dynamic';

/**
 * GET (signed in) -> is the Medium trend radar collecting? The last runs (per feed: stories shown, new, errors),
 * how many stories are stored, and the tag trends so far (not meaningful until about two weeks of history).
 */
export async function GET(req: Request) {
  const g = ownerGuard(req);
  if (!g.ok) return g.res;
  try {
    const [index, log] = await Promise.all([
      getJson<PostIndex>(mediumStore, POSTS_KEY),
      getJson<RunLog>(mediumStore, RUNS_KEY),
    ]);
    const runs = log?.runs ?? [];
    const firstRunAt = runs.length ? runs[runs.length - 1].at : undefined;
    return NextResponse.json({
      collecting: runs.length > 0,
      runs: runs.length,
      firstRunAt: firstRunAt ? new Date(firstRunAt).toISOString() : null,
      lastRun: runs[0] ? { ...runs[0], at: new Date(runs[0].at).toISOString() } : null,
      storedPosts: index ? Object.keys(index.posts).length : 0,
      trends: index ? trends(index, firstRunAt, Date.now()) : null,
    });
  } catch (e) { return errorResponse(e); }
}
