import type { Posts } from '../shorts/posts';
import type { ShortItem } from '../shorts/store';
import type { WrittenText } from '../shorts/write';
import type { MetricsFile, PostMetrics } from './analyze';
import type { SavedRead } from './prompt';

/**
 * "Download for Claude" on Socials -> Analysis: every saved number in one JSON file he attaches in a chat, so the
 * discussion happens there (no API cost here). Nothing trimmed, nothing computed that the platforms did not give:
 * a number YouTube or Instagram did not send stays out (never 0). Pure: the route loads the inputs.
 */

const istTime = (ms?: number) => (ms ? `${new Date(ms + 19_800_000).toISOString().slice(0, 16).replace('T', ' ')} IST` : undefined);
const istDate = (ms: number) => new Date(ms + 19_800_000).toISOString().slice(0, 10);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export const ABOUT = [
  'tradereye Socials export: every Short (YouTube) / Reel (Instagram) tradereye made and published, with all numbers saved by the daily 07:00 IST pull.',
  'Times are IST. Numbers a platform did not give are left out, never 0.',
  'posts[].daily: one entry per day the pull ran. YouTube views/likes/comments are near live (Data API); youtube.stats are YouTube Analytics totals since publishing, 2-3 days behind (avgSec = average seconds watched, avgPct = average % of the video watched, engagedViews = views past the first seconds).',
  'Instagram numbers are lifetime totals, up to 48 h behind (skipPct = % who swiped away in the first seconds, avgWatchSec = average watch time).',
  'posts[].youtube.traffic: views by YouTube traffic source since publishing (SHORTS = the Shorts feed, SUBSCRIBER = subscriber surfaces, YT_SEARCH, YT_CHANNEL, EXT_URL, NO_LINK_OTHER...).',
  'posts[].youtube.retention: [% of the video elapsed, share of viewers still watching (1 = all who started; above 1 = rewatching), how that compares with similar-length videos (0-1, 0.5 = typical)].',
  'shorts[]: every short made, published or not, with its posting state and any error (a video stuck private or failed shows here).',
  'account: daily follower / subscriber counts. reads: the earlier in-app Claude reads, newest first.',
];

function postOut(p: PostMetrics, text: WrittenText | { error: string } | undefined) {
  const words = text && 'youtube' in text ? text : undefined;
  return {
    id: p.id,
    label: p.facts.label, kind: p.facts.kind, outcome: p.facts.outcome, resultR: p.facts.resultR, tell: p.facts.tell,
    text: words ? {
      youtubeTitle: words.youtube.title, youtubeDescription: words.youtube.description, youtubeTags: words.youtube.tags,
      instagramCaption: words.instagram.caption, notes: words.notes,
    } : { youtubeTitle: p.facts.title, instagramFirstLine: p.facts.captionHook },
    youtube: p.youtube && {
      url: p.youtube.url, videoId: p.youtube.videoId, published: istTime(p.youtube.at),
      durationSec: [...p.points].reverse().find((x) => x.youtube?.durationSec !== undefined)?.youtube?.durationSec,
      privacy: [...p.points].reverse().find((x) => x.youtube)?.youtube?.privacy,
      traffic: p.youtube.traffic,
      retention: p.youtube.retention?.map(([x, w, rel]) => [Math.round(x * 100), r3(w), rel === null ? null : r3(rel)]),
    },
    instagram: p.instagram && { url: p.instagram.url, published: istTime(p.instagram.at) },
    daily: p.points.map((pt) => ({
      date: istDate(pt.at),
      youtube: pt.youtube && { views: pt.youtube.views, likes: pt.youtube.likes, comments: pt.youtube.comments, stats: pt.youtube.stats },
      instagram: pt.instagram,
    })),
  };
}

export function buildExport(o: {
  file: MetricsFile; posts: Posts; items: ShortItem[]; texts: Record<string, WrittenText | { error: string } | undefined>; reads: SavedRead[]; now: number;
}) {
  const metrics = Object.values(o.file.posts)
    .sort((a, b) => Math.max(b.youtube?.at ?? 0, b.instagram?.at ?? 0) - Math.max(a.youtube?.at ?? 0, a.instagram?.at ?? 0));
  const plan = (id: string, k: 'youtube' | 'instagram') => {
    const x = o.posts[id]?.[k];
    return x && { at: istTime(x.at), state: x.state, url: x.url, error: x.error };
  };
  return {
    about: ABOUT,
    exportedAt: istTime(o.now),
    lastPull: o.file.lastRun && { ...o.file.lastRun, at: istTime(o.file.lastRun.at) },
    account: o.file.account.map((a) => ({ date: istDate(a.at), youtubeSubs: a.youtubeSubs, youtubeViews: a.youtubeViews, igFollowers: a.igFollowers })),
    posts: metrics.map((p) => postOut(p, o.texts[p.id])),
    shorts: o.items.map((it) => ({ id: it.id, label: it.label, kind: it.kind, made: istTime(it.createdAt), youtube: plan(it.id, 'youtube'), instagram: plan(it.id, 'instagram') })),
    reads: o.reads.map((r) => ({ ...r, at: istTime(r.at) })),
  };
}
