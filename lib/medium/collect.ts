import { getJson, putJson, type Store } from '../setups/store';
import { parseRss, type FeedItem } from './rss';

/**
 * The Medium trend radar's collector. Woken every few hours by EventBridge Scheduler (Lambda
 * tradereye-medium-collector -> POST /api/medium/collect). It reads Medium's public RSS feeds for the trading tags and
 * a few publications, and remembers every story it sees. Nothing here calls Claude, so it costs nothing to run.
 *
 * Kept in S3 (same bucket as everything else):
 *   medium/posts.json.gz   every story seen in the last 90 days: title, author, link, publish time, its own tags,
 *                          which feeds showed it, when it was first seen
 *   medium/runs.json       the last 200 runs: per feed, how many stories it showed, how many were new, or the error
 *
 * Medium's feeds only show the ~10 newest stories each. When every story in a feed is new on a run, stories may have been
 * missed between runs: that feed is marked `full` on the run, the sign to run more often.
 */

export const POSTS_KEY = 'medium/posts.json.gz';
export const RUNS_KEY = 'medium/runs.json';
export const KEEP_DAYS = 90;
export const KEEP_RUNS = 200;
const DAY = 86_400_000;

export interface FeedSource { kind: 'tag' | 'publication'; slug: string }

/**
 * What the radar watches. Edit freely: a slug Medium does not know shows up in medium/runs.json as an error or as 0
 * stories, so a wrong one is easy to spot. Trading first; a couple of tech tags because the "building tradereye" posts
 * can ride those too.
 */
export const FEEDS: FeedSource[] = [
  { kind: 'tag', slug: 'trading' },
  { kind: 'tag', slug: 'day-trading' },
  { kind: 'tag', slug: 'stock-market' },
  { kind: 'tag', slug: 'stocks' },
  { kind: 'tag', slug: 'investing' },
  { kind: 'tag', slug: 'algorithmic-trading' },
  { kind: 'tag', slug: 'technical-analysis' },
  { kind: 'tag', slug: 'quantitative-finance' },
  { kind: 'tag', slug: 'options-trading' },
  { kind: 'tag', slug: 'trading-strategy' },
  { kind: 'tag', slug: 'personal-finance' },
  { kind: 'tag', slug: 'indian-stock-market' },
  { kind: 'tag', slug: 'ai-trading' },
  { kind: 'tag', slug: 'python' },
];

export const feedName = (f: FeedSource) => (f.kind === 'tag' ? `tag/${f.slug}` : f.slug);
export const feedUrl = (f: FeedSource) => `https://medium.com/feed/${feedName(f)}`;

export interface StoredPost {
  title: string;
  url: string;
  author: string;
  publishedAt: number;
  tags: string[];
  /** feed names that showed it ("tag/day-trading", ...) */
  seenIn: string[];
  firstSeen: number;
}
export interface PostIndex { v: 1; posts: Record<string, StoredPost> }

export interface FeedResult { feed: string; items?: number; fresh?: number; full?: boolean; error?: string }
export interface Run { at: number; feeds: FeedResult[]; newPosts: number; totalPosts: number }
export interface RunLog { v: 1; runs: Run[] }

export const emptyIndex = (): PostIndex => ({ v: 1, posts: {} });

/** Add one feed's stories to the index. Returns how many were new to it. Never changes what a story was first seen as. */
export function merge(index: PostIndex, feed: string, items: FeedItem[], now: number): number {
  let fresh = 0;
  for (const it of items) {
    const p = index.posts[it.id];
    if (!p) {
      index.posts[it.id] = { title: it.title, url: it.url, author: it.author, publishedAt: it.publishedAt, tags: it.tags, seenIn: [feed], firstSeen: now };
      fresh++;
    } else {
      if (!p.seenIn.includes(feed)) p.seenIn.push(feed);
      for (const t of it.tags) if (!p.tags.includes(t)) p.tags.push(t);
    }
  }
  return fresh;
}

/** The time a story counts at: its publish time, or when it was first seen if the feed gave none. */
export const storyTime = (p: StoredPost) => p.publishedAt || p.firstSeen;

/** Drop stories older than KEEP_DAYS (by publish time, else first seen). */
export function prune(index: PostIndex, now: number): number {
  let dropped = 0;
  for (const [id, p] of Object.entries(index.posts)) {
    if (now - storyTime(p) > KEEP_DAYS * DAY) { delete index.posts[id]; dropped++; }
  }
  return dropped;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

async function readFeed(f: FeedSource, fetchImpl: Fetch): Promise<FeedItem[]> {
  const res = await fetchImpl(feedUrl(f), {
    headers: { accept: 'application/rss+xml, application/xml, text/xml', 'user-agent': 'tradereye-trend-radar/1.0 (RSS reader)' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!/<rss[\s>]/i.test(text)) throw new Error('not an RSS feed');
  return parseRss(text);
}

/** One collector run: read every feed (all at once), add their stories, prune, save the index and the run log. */
export async function collect(store: Store, opts: { fetchImpl?: Fetch; feeds?: FeedSource[]; now?: number } = {}): Promise<Run> {
  const now = opts.now ?? Date.now();
  const feeds = opts.feeds ?? FEEDS;
  const fetchImpl: Fetch = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const [index, log, reads] = await Promise.all([
    getJson<PostIndex>(store, POSTS_KEY).then((x) => (x?.v === 1 && x.posts ? x : emptyIndex())),
    getJson<RunLog>(store, RUNS_KEY).then((x) => (x?.v === 1 && Array.isArray(x.runs) ? x : { v: 1 as const, runs: [] })),
    Promise.allSettled(feeds.map((f) => readFeed(f, fetchImpl))),
  ]);
  const hadAny = Object.keys(index.posts).length > 0;
  const results: FeedResult[] = [];
  let newPosts = 0;
  feeds.forEach((f, i) => {
    const name = feedName(f);
    const r = reads[i];
    if (r.status === 'rejected') { results.push({ feed: name, error: String((r.reason as Error)?.message ?? r.reason).slice(0, 120) }); return; }
    const fresh = merge(index, name, r.value, now);
    newPosts += fresh;
    // every story new on a later run = the feed moved past what we last saw, so some may be missing
    results.push({ feed: name, items: r.value.length, fresh, full: hadAny && r.value.length > 0 && fresh === r.value.length });
  });
  prune(index, now);
  const run: Run = { at: now, feeds: results, newPosts, totalPosts: Object.keys(index.posts).length };
  log.runs = [run, ...log.runs].slice(0, KEEP_RUNS);
  await putJson(store, POSTS_KEY, index);
  await putJson(store, RUNS_KEY, log);
  return run;
}

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
