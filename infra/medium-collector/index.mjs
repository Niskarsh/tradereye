// tradereye-medium-collector: the Medium trend radar's collector. EventBridge Scheduler runs it every 3 hours.
// It reads Medium's public RSS feeds itself and writes what it saw to S3; tradereye is not involved (it only reads the
// files, for the Medium page and GET /api/medium/status). Nothing here calls Claude.
//
// Runtime: Node.js 22.x (the AWS SDK is built in, no packages needed). Timeout: 1 minute.
// Environment variable: BUCKET = the S3 bucket tradereye uses.
// The function's role needs s3:GetObject and s3:PutObject on <bucket>/medium/*.
//
// S3 files (read by lib/medium/collect.ts in tradereye; keep the formats in step):
//   medium/posts.json.gz  every story seen in the last 90 days, gzipped JSON
//                         { v: 1, posts: { <id>: { title, url, author, publishedAt, tags, seenIn, firstSeen } } }
//   medium/runs.json      the last 200 runs { v: 1, runs: [{ at, feeds: [{ feed, items, fresh, full } | { feed, error }],
//                         newPosts, totalPosts }] }, newest first
//
// Medium's feeds hold only the ~10 newest stories each and no clap counts. A feed whose stories were all new on a run is
// marked `full`: stories may have been missed since the last run (run more often if that is common).
import { gzipSync, gunzipSync } from 'node:zlib';

export const POSTS_KEY = 'medium/posts.json.gz';
export const RUNS_KEY = 'medium/runs.json';
const KEEP_DAYS = 90;
const KEEP_RUNS = 200;
const DAY = 86_400_000;

// What the radar watches. Edit freely: a slug Medium does not know shows up in medium/runs.json as an error or 0 items.
export const FEEDS = [
  'tag/trading',
  'tag/day-trading',
  'tag/stock-market',
  'tag/stocks',
  'tag/investing',
  'tag/algorithmic-trading',
  'tag/technical-analysis',
  'tag/quantitative-finance',
  'tag/options-trading',
  'tag/trading-strategy',
  'tag/personal-finance',
  'tag/indian-stock-market',
  'tag/ai-trading',
  'tag/python',
];

// ---------- RSS ----------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
  .trim();
const first = (b, tag) => { const m = b.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i')); return m ? decode(m[1]) : ''; };
const all = (b, tag) => [...b.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi'))].map((m) => decode(m[1]));

export const tagSlug = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Medium story ids: the hex string at the end of the guid (medium.com/p/<id>) or of the link (...-<id>). */
export function storyId(guid, link) {
  const g = guid.match(/\/p\/([0-9a-f]{8,16})(?:[/?#]|$)/i)?.[1];
  if (g) return g.toLowerCase();
  return (link.split(/[?#]/)[0].match(/-([0-9a-f]{8,16})\/?$/i)?.[1] ?? '').toLowerCase();
}

/** Every story in a feed: { id, title, url, author, publishedAt, tags }. Items without a title or id are skipped. */
export function parseRss(xml) {
  const out = [];
  for (const m of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const b = m[1];
    const title = first(b, 'title').replace(/\s+/g, ' ');
    const link = first(b, 'link');
    const id = storyId(first(b, 'guid'), link);
    if (!title || !id) continue;
    const t = Date.parse(first(b, 'pubDate'));
    out.push({
      id, title, url: link.split('?')[0].split('#')[0], author: first(b, 'dc:creator'),
      publishedAt: Number.isFinite(t) ? t : 0, tags: [...new Set(all(b, 'category').map(tagSlug).filter(Boolean))],
    });
  }
  return out;
}

// ---------- the index ----------
/** Add one feed's stories. Returns how many were new. A story's first-seen time never changes. */
export function merge(index, feed, items, now) {
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

/** Drop stories older than 90 days (by publish time, else first seen). */
export function prune(index, now) {
  let dropped = 0;
  for (const [id, p] of Object.entries(index.posts)) {
    if (now - (p.publishedAt || p.firstSeen) > KEEP_DAYS * DAY) { delete index.posts[id]; dropped++; }
  }
  return dropped;
}

async function readFeed(feed, fetchImpl) {
  const res = await fetchImpl(`https://medium.com/feed/${feed}`, {
    headers: { accept: 'application/rss+xml, application/xml, text/xml', 'user-agent': 'tradereye-trend-radar/1.0 (RSS reader)' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!/<rss[\s>]/i.test(text)) throw new Error('not an RSS feed');
  return parseRss(text);
}

/**
 * One run. `files` is { get(key) -> Buffer | undefined, put(key, Buffer) } (S3 in the handler, memory in tests).
 * Reads every feed at once, adds their stories, prunes, saves the index and the run log, and returns the run.
 * @param {{ files: { get(key: string): Promise<Buffer | undefined>, put(key: string, body: Buffer, type?: string): Promise<void> },
 *   fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>, feeds?: string[], now?: number }} o
 */
export async function run({ files, fetchImpl = fetch, feeds = FEEDS, now = Date.now() }) {
  const [postsBuf, runsBuf, reads] = await Promise.all([
    files.get(POSTS_KEY), files.get(RUNS_KEY), Promise.allSettled(feeds.map((f) => readFeed(f, fetchImpl))),
  ]);
  let index = { v: 1, posts: {} };
  try { const x = postsBuf && JSON.parse(gunzipSync(postsBuf).toString('utf8')); if (x?.v === 1 && x.posts) index = x; } catch { /* start fresh */ }
  let log = { v: 1, runs: [] };
  try { const x = runsBuf && JSON.parse(runsBuf.toString('utf8')); if (x?.v === 1 && Array.isArray(x.runs)) log = x; } catch { /* start fresh */ }

  const hadAny = Object.keys(index.posts).length > 0;
  const results = [];
  let newPosts = 0;
  feeds.forEach((feed, i) => {
    const r = reads[i];
    if (r.status === 'rejected') { results.push({ feed, error: String(r.reason?.message ?? r.reason).slice(0, 120) }); return; }
    const fresh = merge(index, feed, r.value, now);
    newPosts += fresh;
    results.push({ feed, items: r.value.length, fresh, full: hadAny && r.value.length > 0 && fresh === r.value.length });
  });
  prune(index, now);
  const thisRun = { at: now, feeds: results, newPosts, totalPosts: Object.keys(index.posts).length };
  log.runs = [thisRun, ...log.runs].slice(0, KEEP_RUNS);
  await files.put(POSTS_KEY, gzipSync(JSON.stringify(index)), 'application/gzip');
  await files.put(RUNS_KEY, Buffer.from(JSON.stringify(log)), 'application/json');
  return thisRun;
}

// ---------- Lambda ----------
async function s3Files(bucket) {
  const { S3Client, GetObjectCommand, PutObjectCommand } = await import('@aws-sdk/client-s3'); // built into the Lambda runtime
  const s3 = new S3Client({});
  return {
    get: async (Key) => {
      try {
        const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key }));
        return r.Body ? Buffer.from(await r.Body.transformToByteArray()) : undefined;
      } catch (e) {
        if (e.name === 'NoSuchKey' || e.name === 'NotFound') return undefined;
        throw e;
      }
    },
    put: async (Key, Body, ContentType) => { await s3.send(new PutObjectCommand({ Bucket: bucket, Key, Body, ContentType })); },
  };
}

export const handler = async () => {
  const bucket = process.env.BUCKET;
  if (!bucket) throw new Error('Set the BUCKET environment variable');
  const r = await run({ files: await s3Files(bucket) });
  const failed = r.feeds.filter((f) => f.error);
  console.log(JSON.stringify({ newPosts: r.newPosts, totalPosts: r.totalPosts, failed: failed.map((f) => `${f.feed}: ${f.error}`), full: r.feeds.filter((f) => f.full).map((f) => f.feed) }));
  // every feed failing = something is wrong (Medium blocking AWS?): fail so it shows as an error in Lambda
  if (failed.length === r.feeds.length) throw new Error('every feed failed');
  return { newPosts: r.newPosts, totalPosts: r.totalPosts, failedFeeds: failed.length };
};
