import { NextResponse } from 'next/server';
import { ownerRequired } from '@/lib/auth/owner';
import { loadConn } from '@/lib/social/store';
import { canAnalyse } from '@/lib/social/youtube';
import { posterKey, signedGet } from '@/lib/shorts/store';
import { findings, groupsOf, matureCount, toRow } from '@/lib/socialAnalysis/analyze';
import { loadMetrics } from '@/lib/socialAnalysis/collect';
import { loadReads } from '@/lib/socialAnalysis/read';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** GET -> everything the Analysis page shows, from what is already saved (no YouTube, Instagram or Claude calls). */
export async function GET(req: Request) {
  const denied = ownerRequired(req);
  if (denied) return denied;
  try {
    const now = Date.now();
    const [file, reads, conn] = await Promise.all([loadMetrics(), loadReads(), loadConn('youtube')]);
    const rows = await Promise.all(Object.values(file.posts).map(async (p) => ({ ...toRow(p, now), poster: await signedGet(posterKey(p.id)).catch(() => undefined) })));
    rows.sort((a, b) => Math.max(b.youtube?.at ?? 0, b.instagram?.at ?? 0) - Math.max(a.youtube?.at ?? 0, a.instagram?.at ?? 0));
    const groups = groupsOf(rows);
    return NextResponse.json({
      now, updatedAt: file.updatedAt, lastRun: file.lastRun, account: file.account.slice(-120), rows, groups, findings: findings(groups), mature: matureCount(rows), reads,
      youtubeNeedsReconnect: !!conn && !canAnalyse(conn.scope),
    });
  } catch (e) { return NextResponse.json({ error: 'FAILED', message: (e as Error).message }, { status: 500 }); }
}
