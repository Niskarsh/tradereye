import { getJson, putJson } from '../setups/store';
import { liveInstagram, liveYouTube } from '../social/connections';
import { canAnalyse } from '../social/youtube';
import { loadPosts } from '../shorts/publish';
import { youtubeState } from '../shorts/posts';
import { listShorts, specKey, store, textKey } from '../shorts/store';
import type { ShortSpec } from '../shorts/spec';
import type { WrittenText } from '../shorts/write';
import { addPoint, emptyFile, type MetricsFile, type Point, type PostMetrics } from './analyze';
import { factsOf, isLive, toFollow } from './follow';
import { instagramAccount, instagramStats, youtubeAccount, youtubeLive, youtubeRetention, youtubeStats, type YtLive } from './fetch';

/**
 * The pull: for every Short / Reel tradereye published, read today's numbers and add them to one S3 file,
 *   social/analysis/metrics.json
 * Run daily by EventBridge (07:00 IST, through /api/social/tick) and by Refresh on the page. No Claude here: pulling costs nothing.
 */

export const METRICS_KEY = 'social/analysis/metrics.json';
/** Stop starting new posts after this, so the Lambda (110 s) always gets an answer; the rest go first next time. */
const BUDGET_MS = 85_000;
const AT_ONCE = 4;

export const loadMetrics = async (): Promise<MetricsFile> => (await getJson<MetricsFile>(store, METRICS_KEY)) ?? emptyFile();

const istDate = (ms: number) => new Date(ms + 19_800_000).toISOString().slice(0, 10);

export async function pullMetrics(source: 'timer' | 'manual', now = Date.now()): Promise<MetricsFile & { pulled: number; failed: number }> {
  const t0 = Date.now();
  const [posts, items, file] = await Promise.all([loadPosts(), listShorts(), loadMetrics()]);
  const byId = new Map(items.map((x) => [x.id, x]));
  const ids = toFollow(posts, file, now);
  const problems: string[] = [];
  const note = (what: string) => { if (!problems.includes(what) && problems.length < 8) problems.push(what); };

  let yt: { token: string; analytics: boolean } | undefined;
  try { const y = await liveYouTube(); yt = { token: y.accessToken, analytics: canAnalyse(y.conn.scope) }; }
  catch (e) { note(`YouTube: ${(e as Error).message}`); }
  let igToken: string | undefined;
  try {
    const { conn } = await liveInstagram(now);
    igToken = conn?.accessToken;
    if (!conn) note('Instagram is not connected.');
  } catch (e) { note(`Instagram: ${(e as Error).message}`); }

  let counts: Record<string, YtLive> = {};
  const videoIds = ids.map((id) => posts[id].youtube?.videoId).filter((x): x is string => !!x);
  if (yt && videoIds.length) {
    try { counts = await youtubeLive(yt.token, videoIds); }
    catch (e) { note((e as Error).message); }
  }

  let pulled = 0, failed = 0;
  const one = async (id: string) => {
    const plan = posts[id], old = file.posts[id];
    const [spec, text] = await Promise.all([getJson<ShortSpec>(store, specKey(id)), getJson<WrittenText | { error: string }>(store, textKey(id))]);
    const rec: PostMetrics = { id, facts: factsOf(byId.get(id), spec, text, old?.facts), points: old?.points ?? [], youtube: old?.youtube, instagram: old?.instagram };
    const point: Point = { at: now };
    let bad = false;
    const y = plan.youtube, g = plan.instagram;
    if (yt && y?.videoId && isLive(y, y.videoId, true, now)) {
      const c = counts[y.videoId];
      if (c && c.privacy === 'public') {
        const yp: NonNullable<Point['youtube']> = { ...c };
        const retention = old?.youtube?.retention;
        rec.youtube = { videoId: y.videoId, at: y.at, url: y.url, retention };
        if (yt.analytics) {
          const start = istDate(y.at), end = istDate(now);
          try {
            const [stats, curve] = await Promise.all([youtubeStats(yt.token, y.videoId, start, end), youtubeRetention(yt.token, y.videoId, start, end)]);
            yp.stats = stats;
            if (curve.length) rec.youtube.retention = curve;
          } catch (e) { bad = true; note((e as Error).message); }
        }
        point.youtube = yp;
      }
    }
    if (igToken && g?.mediaId && isLive(g, g.mediaId, false, now)) {
      try {
        point.instagram = await instagramStats(igToken, g.mediaId);
        rec.instagram = { mediaId: g.mediaId, at: g.at, url: g.url };
      } catch (e) { bad = true; note((e as Error).message); }
    }
    if (point.youtube || point.instagram) { rec.points = addPoint(rec.points, point); pulled++; }
    if (bad) failed++;
    file.posts[id] = rec;
  };

  for (let i = 0; i < ids.length; i += AT_ONCE) {
    if (Date.now() - t0 > BUDGET_MS) { note(`Out of time: ${ids.length - i} posts wait for the next pull.`); break; }
    await Promise.all(ids.slice(i, i + AT_ONCE).map((id) => one(id).catch((e) => { failed++; note((e as Error).message); })));
  }

  const acc = await Promise.all([
    yt ? youtubeAccount(yt.token).catch((e) => { note((e as Error).message); return {}; }) : {},
    igToken ? instagramAccount(igToken).catch((e) => { note((e as Error).message); return {}; }) : {},
  ]);
  const account = { at: now, ...acc[0], ...acc[1] };
  if (Object.keys(account).length > 1) file.account = addPoint(file.account, account);
  file.updatedAt = now;
  file.lastRun = { at: now, source, pulled, failed, problems, youtubeAnalytics: !!yt?.analytics };
  await putJson(store, METRICS_KEY, file);
  return { ...file, pulled, failed };
}
