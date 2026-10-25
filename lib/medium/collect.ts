/**
 * The Medium trend radar, tradereye's side: reading what the collector saved. The collector itself is the Lambda
 * tradereye-medium-collector (infra/medium-collector/index.mjs), run every 3 hours by EventBridge Scheduler; it reads
 * Medium's public RSS feeds and writes to S3 on its own, so collecting never depends on this app. Keep the formats
 * below in step with that file.
 *
 *   medium/posts.json.gz   every story seen in the last 90 days (gzipped JSON)
 *   medium/runs.json       the last 200 runs: per feed, stories shown, how many were new, or the error
 */

export const POSTS_KEY = 'medium/posts.json.gz';
export const RUNS_KEY = 'medium/runs.json';
const DAY = 86_400_000;

export interface StoredPost {
  title: string;
  url: string;
  author: string;
  /** publish time, ms since epoch (0 when the feed did not say) */
  publishedAt: number;
  /** the story's own tags, lower case slugs */
  tags: string[];
  /** feeds that showed it ("tag/day-trading", ...) */
  seenIn: string[];
  firstSeen: number;
}
export interface PostIndex { v: 1; posts: Record<string, StoredPost> }

/** `full`: every story in the feed was new on this run, so some may have been missed since the last run */
export interface FeedResult { feed: string; items?: number; fresh?: number; full?: boolean; error?: string }
export interface Run { at: number; feeds: FeedResult[]; newPosts: number; totalPosts: number }
export interface RunLog { v: 1; runs: Run[] }

/** The time a story counts at: its publish time, or when it was first seen if the feed gave none. */
export const storyTime = (p: StoredPost) => p.publishedAt || p.firstSeen;

export interface TagTrend {
  tag: string;
  /** stories with this tag published in the last 7 days */
  lastWeek: number;
  /** average per week over the 3 weeks before that (only weeks the collector was running) */
  before: number;
  /** lastWeek / before (null when there is no baseline yet) */
  surge: number | null;
}
export interface Trends { days: number; ready: boolean; tags: TagTrend[] }

/**
 * Which tags are being written about more than usual. Counts the tags on every story seen (not just the feed it came
 * from), so it shows what trading writers are attaching right now (e.g. "ai" rising inside trading). Needs about two
 * weeks of history before `surge` means anything; until then `ready` is false and only last week's counts are shown.
 */
export function trends(index: PostIndex, firstRunAt: number | undefined, now: number, minCount = 3): Trends {
  const days = firstRunAt ? Math.floor((now - firstRunAt) / DAY) : 0;
  const weekStart = now - 7 * DAY;
  const baseStart = Math.max(now - 28 * DAY, firstRunAt ?? now);
  const baseWeeks = Math.max(0, (weekStart - baseStart) / (7 * DAY));
  const last = new Map<string, number>(), base = new Map<string, number>();
  for (const p of Object.values(index.posts)) {
    const t = storyTime(p);
    const into = t >= weekStart && t <= now ? last : t >= baseStart && t < weekStart ? base : undefined;
    if (!into) continue;
    for (const tag of p.tags) into.set(tag, (into.get(tag) ?? 0) + 1);
  }
  const ready = baseWeeks >= 1;
  const tags: TagTrend[] = [...last.entries()]
    .filter(([, n]) => n >= minCount)
    .map(([tag, n]) => {
      const before = ready ? (base.get(tag) ?? 0) / baseWeeks : 0;
      return { tag, lastWeek: n, before: Math.round(before * 10) / 10, surge: ready ? Math.round((n / Math.max(before, 1)) * 100) / 100 : null };
    })
    .sort((a, b) => (b.surge ?? 0) - (a.surge ?? 0) || b.lastWeek - a.lastWeek);
  return { days, ready, tags };
}
