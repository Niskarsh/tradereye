import { ownerRequired } from '@/lib/auth/owner';
import { getJson } from '@/lib/setups/store';
import { loadPosts } from '@/lib/shorts/publish';
import { listShorts, store, textKey } from '@/lib/shorts/store';
import type { WrittenText } from '@/lib/shorts/write';
import { loadMetrics } from '@/lib/socialAnalysis/collect';
import { buildExport } from '@/lib/socialAnalysis/export';
import { loadReads } from '@/lib/socialAnalysis/read';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** GET -> every saved Socials number as one JSON file to attach in a Claude chat (read only; no YouTube, Instagram or Claude calls). */
export async function GET(req: Request) {
  const denied = ownerRequired(req);
  if (denied) return denied;
  try {
    const now = Date.now();
    const [file, posts, items, reads] = await Promise.all([loadMetrics(), loadPosts(), listShorts(), loadReads()]);
    const ids = Object.keys(file.posts);
    const texts = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await getJson<WrittenText | { error: string }>(store, textKey(id)).catch(() => undefined)] as const)));
    const body = JSON.stringify(buildExport({ file, posts, items, texts, reads, now }), null, 2);
    const name = `tradereye-socials-${new Date(now + 19_800_000).toISOString().slice(0, 10)}.json`;
    return new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' } });
  } catch (e) {
    return Response.json({ error: 'FAILED', message: (e as Error).message }, { status: 500 });
  }
}
